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
import { parseEnvelope, legalTransition, validateEnvelopeContext, effectiveAllowedPaths } from './lib/handoff.mjs';
import { authorize } from './lib/auth.mjs';
import * as state from './lib/state.mjs';
import { resolveProgram, interpolateArgs, runWorker, buildWorkerEnv } from './lib/workers.mjs';
import { ensureRepo, createWorktree, installPushGuard, removeWorktreePath, resolveBaseSha } from './lib/worktrees.mjs';

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

function refusal(reason, extra = {}) {
  return { ok: false, refusal: true, reason, ...extra };
}

async function dispatch(rule, ctx) {
  const workerCfg = (cfg.workers || {})[rule.worker];
  if (!workerCfg) return { ok: false, reason: `unknown worker '${rule.worker}'` };

  const isCodeWorker = !!workerCfg.createsTask;

  // Code-editing dispatch requires a valid handoff envelope (ORCH-073..076).
  let envelope = null;
  if (isCodeWorker) {
    const parsed = parseEnvelope(ctx.bodyText);
    if (!parsed.ok) return refusal('invalid handoff envelope', { errors: parsed.errors });
    envelope = parsed.data;
  }

  // Durable task + run + lease + worktree for code workers. Everything below FAILS
  // CLOSED: if the base SHA can't be resolved/verified, the envelope disagrees with
  // the event, the transition is illegal, or the worktree can't be created, we do
  // NOT launch a worker and we do not silently detach the worktree.
  let taskId = null; let worktree = null; let runId = null;
  if (isCodeWorker) {
    taskId = sanitizeTaskId(ctx.repo, ctx.issueNumber, ctx.headSha);
    const baseRef = ctx.baseRef || cfg.defaultBaseRef || 'main';

    // Cross-check envelope repo/issue/branch/allowed_paths against the event/state.
    const cross = validateEnvelopeContext(envelope, ctx);
    if (!cross.ok) return refusal('envelope does not match event context', { errors: cross.errors });

    // Effective allowed paths use the TASK scope (envelope allowed_paths), not merely
    // the worker-global scope.
    const allowedPaths = effectiveAllowedPaths(envelope, workerCfg.allowedPaths);

    // Resolve + verify a nonempty base SHA BEFORE the worktree is created; a code
    // task with no resolvable base ref/SHA refuses to launch.
    let sourceRepo;
    try { sourceRepo = ensureRepo(ctx.repo, cfg.reposRoot, cfg.repoBase); }
    catch (e) { log(`[router] repo unavailable for ${ctx.repo}: ${e.message}`); return refusal('repo is not available'); }

    const contextBase = ctx.baseSha || '';
    const envelopeBase = envelope.base_sha || '';
    const baseSha = resolveBaseSha(sourceRepo, baseRef, { providedSha: contextBase || envelopeBase });
    if (!baseSha) return refusal('no resolvable base SHA; refusing to launch a code task');
    // The envelope's declared base_sha must agree with the resolved base.
    if (envelopeBase) {
      const envFull = resolveBaseSha(sourceRepo, baseRef, { providedSha: envelopeBase });
      if (!envFull || envFull !== baseSha) return refusal('envelope base_sha does not match the resolved base SHA');
    }

    // Re-delivery must be a legal state transition; done -> in_progress is rejected
    // unless an explicit reopen operation exists (none does yet).
    const existing = state.getTask(db, taskId);
    if (existing && !legalTransition(existing.state, 'in_progress')) {
      return refusal(`illegal state transition '${existing.state}' -> 'in_progress'`);
    }

    state.createTask(db, {
      id: taskId, repo: ctx.repo, issue: ctx.issueNumber != null ? String(ctx.issueNumber) : null,
      state: 'in_progress', owner: envelope.agent, branch: envelope.branch,
      baseSha, baseRef, risk: 'pilot',
    });
    if (existing) log(`[router] task ${taskId} already exists — deliberate retry/state transition`);

    try {
      worktree = createWorktree({
        sourceRepo, worktreeRoot: cfg.worktreeRoot, taskId, baseSha, branch: envelope.branch,
      });
      installPushGuard(worktree, { allowedPaths, baseSha, baseRef });
    } catch (e) {
      log(`[router] worktree setup failed for ${taskId}: ${e.message}`);
      state.updateTaskState(db, taskId, 'blocked');
      return refusal('worktree setup failed');
    }

    const attempt = state.nextAttempt(db, taskId);
    runId = crypto.randomUUID();
    state.createRun(db, { id: runId, taskId, agent: rule.worker, attempt, status: 'running' });

    // Exactly one active lease per task/worktree: release any previous one first.
    state.releaseActiveLeasesForTask(db, taskId);
    state.createLease(db, {
      id: crypto.randomUUID(), taskId, worktree, baseSha, owner: envelope.agent,
      sourceRepo, expiresAt: new Date(Date.now() + (cfg.leaseDurationMs || 86400000)).toISOString(),
    });
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
  // Never inherit every env var from the router process (ORCH-094): workers get
  // only an explicit allowlist (PATH/HOME by default) plus their task/worktree.
  const env = buildWorkerEnv(workerCfg, { taskId, worktree });

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
    log(`[router] rule=${rule.id} worker=${rule.worker} ok=${result.ok}${result.refusal ? ' refusal=' + result.reason : ''}${result.taskId ? ' task=' + result.taskId : ''}`);
    if (result.refusal) {
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

// Periodic stale-lease reaper (ORCH-083): remove expired worktrees + release leases.
function reapExpired() {
  let reaped = 0;
  for (const lease of state.listExpiredLeases(db, state.now())) {
    try {
      // A stale lease must never remove a worktree that a newer active lease owns.
      if (state.activeLeaseOwnsWorktree(db, { sourceRepo: lease.source_repo, worktree: lease.worktree }, lease.id)) {
        state.releaseLease(db, lease.id);
        log(`[router] not reaping ${lease.id}: worktree still owned by an active lease`);
        continue;
      }
      removeWorktreePath(lease.source_repo, lease.worktree);
      state.releaseLease(db, lease.id);
      log(`[router] reaped expired lease ${lease.id} (${lease.worktree})`);
      reaped++;
    } catch (e) {
      log(`[router] reap failed for ${lease.id}: ${e.message}`);
    }
  }
  if (reaped) log(`[router] reaped ${reaped} expired lease(s)`);
}
if (cfg.reapIntervalMs && cfg.reapIntervalMs > 0) {
  setInterval(reapExpired, cfg.reapIntervalMs).unref();
}

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
