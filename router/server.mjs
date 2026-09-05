#!/usr/bin/env node
// router/server.mjs — a small, dependency-free webhook relay.
//
// Receives GitHub webhooks and dispatches them to configured "targets": either
// an HTTP endpoint (e.g. the Hermes trigger) or a shell command (e.g. `codex exec`
// or the DeepSeek Harness headless CLI). Optionally posts a summary to Slack.
//
// This is the "hub" piece. It never runs an agent itself; it only wakes the right
// one. Run with:  node server.mjs   (config in ./config.local.json, else ./config.example.json)
//
// Requires Node 18+ (for global fetch). No npm dependencies.

import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const candidates = [
    process.env.CONFIG_PATH,
    path.join(__dirname, 'config.local.json'),
    path.join(__dirname, 'config.example.json'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) return { ...JSON.parse(readFileSync(p, 'utf8')), __path: p };
  }
  console.error('[router] no config file found (need config.local.json)');
  process.exit(1);
}

const config = loadConfig();
const PORT = config.port || 8090;
const SECRET = config.githubSecret || process.env.GITHUB_WEBHOOK_SECRET || '';
const SLACK_WEBHOOK_URL = config.slackWebhook || process.env.SLACK_WEBHOOK_URL || '';

const logFile = config.dispatchLog ? path.join(__dirname, config.dispatchLog) : null;
function log(line) {
  const ts = new Date().toISOString();
  const entry = `[${ts}] ${line}\n`;
  console.error(entry.trimEnd());
  if (logFile) appendFileSync(logFile, entry, 'utf8');
}

function verifySignature(raw, signatureHeader) {
  if (!SECRET) return true; // no secret configured -> accept (only do this on a trusted network)
  if (!signatureHeader) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function matchRule(rule, ctx) {
  const w = rule.when || {};
  if (w.events && !w.events.includes(ctx.event)) return false;
  if (w.repos && !new RegExp(w.repos, 'i').test(ctx.repo)) return false;
  if (w.refBranch && !new RegExp(w.refBranch).test(ctx.branch)) return false;
  if (w.action && w.action !== ctx.action) return false;
  return true;
}

function interpolate(str, ctx) {
  if (typeof str !== 'string') return str;
  return str.replace(/\{\{(\w+)\}\}/g, (_, k) => (ctx[k] !== undefined ? ctx[k] : ''));
}

async function postSlack(text) {
  if (!SLACK_WEBHOOK_URL) {
    log('[router] SLACK_WEBHOOK_URL not set; skipping Slack post');
    return;
  }
  const payload = JSON.stringify({ text });
  const r = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  });
  log(`[router] slack post HTTP ${r.status}`);
}

function runExec(run, ctx) {
  return new Promise((resolve) => {
    const cmd = interpolate(run.command, ctx);
    const child = spawn(cmd, { cwd: run.cwd || ctx.cwd || process.cwd(), shell: true, env: { ...process.env, ...ctx } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ ok: code === 0, out: out.slice(-2000) }));
    child.on('error', (e) => resolve({ ok: false, out: String(e) }));
  });
}

async function dispatch(run, ctx) {
  log(`[router] dispatch: ${run.type || 'http'} ${run.url || run.command || ''} (event=${ctx.event} repo=${ctx.repo} branch=${ctx.branch})`);
  if (run.type === 'exec') return runExec(run, ctx);
  // default: HTTP
  const url = interpolate(run.url, ctx);
  const body = run.body ? interpolate(JSON.stringify(run.body), ctx) : undefined;
  const r = await fetch(url, { method: run.method || 'POST', headers: run.headers || { 'Content-Type': 'application/json' }, body });
  const text = await r.text().catch(() => '');
  return { ok: r.ok, out: text.slice(0, 2000) };
}

async function handleWebhook(req, raw) {
  if (!req.headers['x-hub-signature-256']) {
    // Not a signed GitHub delivery; still process payload if present (test path).
    log('[router] no GitHub signature header (event may be unsiged/test)');
  }
  const event = req.headers['x-github-event'] || 'push';
  let body;
  try { body = JSON.parse(raw || '{}'); } catch { body = {}; }

  const repo = body.repository?.full_name || body.organization?.login || 'unknown/repo';
  const branch = body.ref?.replace('refs/heads/', '') || body.pull_request?.head?.ref || '';
  const ctx = {
    event, repo, branch,
    action: body.action || '',
    head: body.after || body.head_commit?.id || body.pull_request?.head?.sha || '',
    sender: body.sender?.login || '',
    raw: raw || '',
    cwd: config.cwd || process.cwd(),
  };

  const rule = (config.targets || []).find((r) => matchRule(r, ctx));
  if (!rule) {
    log(`[router] no matching rule for ${event} ${repo} ${branch}`);
    return { status: 200, body: { matched: false } };
  }

  const result = await dispatch(rule.run, ctx);
  log(`[router] dispatch done ok=${result.ok} out=${(result.out || '').replace(/\s+/g, ' ').slice(0, 160)}`);

  if (rule.slack) {
    await postSlack(interpolate(rule.slack, { ...ctx, result: result.out || '' }));
  }
  return { status: 200, body: { matched: true, ok: result.ok } };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, port: PORT, secret: !!SECRET }));
  }

  if (req.method !== 'POST') {
    res.writeHead(405); return res.end('method not allowed');
  }

  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', async () => {
    const signature = req.headers['x-hub-signature-256'];
    if (!verifySignature(raw, signature)) {
      log('[router] signature verification FAILED');
      res.writeHead(401); return res.end('bad signature');
    }
    try {
      const out = await handleWebhook(req, raw);
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body));
    } catch (e) {
      log(`[router] error: ${e.stack || e}`);
      res.writeHead(500); res.end(JSON.stringify({ error: String(e) }));
    }
  });
});

server.listen(PORT, () => log(`[router] listening on :${PORT} using ${config.__path}`));
