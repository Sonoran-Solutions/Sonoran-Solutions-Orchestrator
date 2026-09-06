#!/usr/bin/env node
// router/server.mjs — Sonoran control plane.
//
// Safety model (ORCH-050..083):
//   - bounded request body, mandatory HMAC (unless devMode), delivery dedupe;
//   - trusted-actor / label authorization gate;
//   - fixed worker executables dispatched with shell:false (no webhook strings);
//   - durable SQLite task/run/lease state;
//   - validated handoff envelope required before code-editing dispatch;
//   - one isolated git worktree + lease per task;
//   - timeout + concurrency limits and clean shutdown.
import http from 'node:http';
import crypto from 'node:crypto';
import { loadConfig } from './lib/config.mjs';
import { normalize, templateVars } from './lib/events.mjs';
import { parseEnvelope } from './lib/handoff.mjs';
import { authorize } from './lib/auth.mjs';
import * as state from './lib/state.mjs';
import { resolveProgram, interpolateArgs, runWorker } from './lib/workers.mjs';
import { ensureRepo, createWorktree, installPushGuard } from './lib/worktrees.mjs';

const cfg = loadConfig();
const PORT = cfg.port || 8090;
const db = state.openDb(cfg.stateDb || 'state.sqlite');

const secret = process.env[cfg.githubSecretEnv] || '';
const slackWebhook = process.env[cfg.slackWebhookEnv] || '';
let inFlight = 0;
let shuttingDown = false;

function log(line) {
  // Never log secrets. Anything we log here is metadata only.
  console.error(`[${new Date().toISOString()}] ${line}`);
}

function verifySignature(raw, header) {
  if (cfg.devMode && !header && !secret) return true; // local dev escape hatch only
  if (!secret) return false;
  if (!header) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function githubUrl(ctx) {
  if (ctx.prNumber) return `https://github.com/${ctx.repo}/pull/${ctx.prNumber}`;
  if (ctx.issueNumber) return `https://github.com/${ctx.repo}/issues/${ctx.issueNumber}`;
  return '';
}

function matchRule(rule, ctx) {
  const w = rule.when || {};
  if (w.events && !w.events.includes(ctx.event)) return false;
  if (w.actions && !w.actions.includes(ctx.action)) return false;
  if (w.repos && !new RegExp(w.repos, 'i').test(ctx.repo)) return false;
  if (w.refBranch && !new RegExp(w.refBranch).test(ctx.branch)) return false;
  if (w.labels && !w.labels.every((l) => (ctx.labels || []).includes(l))) return false;
  return true;
}

function sanitizeTaskId(repo, issueNumber, headSha) {
  const name = String(repo).split('/').pop().replace(/[^A-Za-z0-9._-]/g, '') || 'repo';
  const num = issueNumber != null ? issueNumber : (headSha || '').slice(0, 7);
  return `${name}-${num || Date.now()}`;
}

async function dispatch(rule, ctx) {
  const workerCfg = (cfg.workers || {})[rule.worker];
  if (!workerCfg) return { ok: false, reason: `unknown worker '${rule.worker}'` };

  const isCodeWorker = !!workerCfg.createsTask;

  // Code-editing dispatch requires a valid handoff envelope (ORCH-073..076).
  let envelope = null;
  if (isCodeWorker) {
    const parsed = parseEnvelope(ctx.bodyText);
    if (!parsed.ok) return { ok: false, reason: 'invalid handoff envelope', errors: parsed.errors };
    envelope = parsed.data;
  }

  // Durable task + run + lease + worktree for code workers.
  let taskId = null; let worktree = null; let runId = null;
  if (isCodeWorker) {
    taskId = sanitizeTaskId(ctx.repo, ctx.issueNumber, ctx.headSha);
    state.createTask(db, {
      id: taskId, repo: ctx.repo, issue: ctx.issueNumber != null ? String(ctx.issueNumber) : null,
      state: 'in_progress', owner: envelope.agent, branch: envelope.branch,
      baseSha: ctx.baseSha || ctx.headSha, risk: 'pilot',
    });
    runId = crypto.randomUUID();
    state.createRun(db, { id: runId, taskId, agent: rule.worker, attempt: 1, status: 'running' });

    const sourceRepo = ensureRepo(ctx.repo, cfg.reposRoot);
    worktree = createWorktree({
      sourceRepo, worktreeRoot: cfg.worktreeRoot, taskId, baseSha: ctx.baseSha || ctx.headSha,
    });
    installPushGuard(worktree, workerCfg.allowedPaths || []);
    state.createLease(db, { id: crypto.randomUUID(), taskId, worktree, baseSha: ctx.baseSha || ctx.headSha, owner: envelope.agent });
  }

  const vars = templateVars(ctx, {
    task: envelope?.task || ctx.title || ctx.issueNumber || ctx.branch,
    link: githubUrl(ctx),
    worktree: worktree || '',
    prompt: envelope
      ? `You are a Sonoran Solutions worker. Handoff envelope:\n` +
        `agent: ${envelope.agent} -> to: ${envelope.to}\nstate: ${envelope.state}\n` +
        `repo: ${envelope.repo}\nissue: ${envelope.issue}\nbranch: ${envelope.branch}\n` +
        `task: ${envelope.task}\nsummary: ${envelope.summary}\nacceptance: ${envelope.acceptance}\n` +
        `Work in the provided worktree, make the change, run the tests, and commit.`
      : '',
  });

  const program = resolveProgram(workerCfg.program, cfg.__routerDir);
  const args = interpolateArgs(workerCfg.args || [], vars);
  const env = { ...process.env, SONORAN_TASK_ID: taskId || '', SONORAN_WORKTREE: worktree || '' };

  const result = await runWorker(workerCfg, {
    program, args, cwd: worktree || cfg.__routerDir, env, timeoutMs: workerCfg.timeoutMs || cfg.defaultTimeoutMs,
  });

  if (runId) state.updateRun(db, runId, { status: result.ok ? 'success' : 'failed', result: (result.stderr || result.stdout || result.error || '').slice(0, 2000) });
  if (taskId && !result.ok) state.updateTaskState(db, taskId, 'blocked');

  return { ok: result.ok, taskId, runId, worktree, output: (result.stderr || result.stdout || '').slice(0, 500) };
}

async function handlePost(raw, headers) {
  let body;
  try { body = JSON.parse(raw || '{}'); } catch { return { status: 400, json: { error: 'invalid JSON body' } }; }

  const ctx = normalize(headers, body);
  if (ctx.event === '' && !cfg.devMode) return { status: 400, json: { error: 'missing X-GitHub-Event' } };

  if (!state.recordDelivery(db, { id: ctx.deliveryId, repo: ctx.repo, event: ctx.event, actor: ctx.actor })) {
    return { status: 200, json: { deduplicated: true } };
  }

  const rule = (cfg.rules || []).find((r) => matchRule(r, ctx));
  if (!rule) return { status: 200, json: { matched: false } };

  const auth = authorize(rule, ctx, cfg);
  if (!auth.ok) {
    log(`[router] authorization denied: rule=${rule.id} event=${ctx.event} actor=${ctx.actor} reason=${auth.reason}`);
    return { status: 403, json: { authorized: false, reason: auth.reason } };
  }

  if (inFlight >= (cfg.maxConcurrency || 2)) {
    return { status: 503, json: { error: 'concurrency limit reached' } };
  }

  inFlight++;
  try {
    const result = await dispatch(rule, ctx);
    log(`[router] rule=${rule.id} worker=${rule.worker} ok=${result.ok}${result.taskId ? ' task=' + result.taskId : ''}`);
    if (result.reason === 'invalid handoff envelope') {
      return { status: 422, json: { matched: true, authorized: true, ...result } };
    }
    return { status: 200, json: { matched: true, authorized: true, ...result } };
  } catch (e) {
    log(`[router] dispatch error: ${e.stack || e}`);
    return { status: 500, json: { error: 'dispatch failed' } };
  } finally {
    inFlight--;
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, port: PORT, devMode: cfg.devMode, secretConfigured: !!secret, inFlight }));
  }

  if (req.method !== 'POST') {
    res.writeHead(405); return res.end('method not allowed');
  }

  let raw = '';
  let tooLarge = false;
  req.on('data', (d) => {
    raw += d;
    if (raw.length > (cfg.bodyLimitBytes || 1048576)) { tooLarge = true; req.destroy(); }
  });

  req.on('end', async () => {
    if (tooLarge) { res.writeHead(413); return res.end('body too large'); }
    if (!verifySignature(raw, req.headers['x-hub-signature-256'])) {
      log('[router] signature verification FAILED');
      res.writeHead(401); return res.end('bad or missing signature');
    }
    try {
      const out = await handlePost(raw, req.headers);
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.json));
    } catch (e) {
      log(`[router] error: ${e.stack || e}`);
      res.writeHead(500); res.end(JSON.stringify({ error: 'internal error' }));
    }
  });
});

server.listen(PORT, () => log(`[router] listening on :${PORT} using ${cfg.__path}`));

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`[router] ${signal} received — shutting down`);
  server.close(() => {
    state.close(db);
    process.exit(0);
  });
  setTimeout(() => { state.close(db); process.exit(0); }, cfg.shutdownGraceMs || 8000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
