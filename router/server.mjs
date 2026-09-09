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
import { join, resolve } from 'node:path';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { loadConfig } from './lib/config.mjs';
import { normalize, templateVars } from './lib/events.mjs';
import { parseEnvelope, validateEnvelopeContext, pathScopes, validateNewTaskState, validateExistingTaskState, canEnterInProgress } from './lib/handoff.mjs';
import { authorize } from './lib/auth.mjs';
import * as state from './lib/state.mjs';
import { resolveProgram, interpolateArgs, runWorker, buildWorkerEnv } from './lib/workers.mjs';
import { DEFAULT_MAX_REPAIR_ATTEMPTS, DEFAULT_REPAIR_BUILD_CMD, readRepairResult, classifyRepairResult, buildRepairRecord, attemptExceeded } from './lib/hermes.mjs';
import { ensureRepo, prepareWorktreeForRun, installPushGuard, removeWorktreePath, resolveBaseSha, resolveCommitSha } from './lib/worktrees.mjs';
import { makeTaskId } from './lib/task-id.mjs';
import { verifyRepairCandidate } from './lib/repair-verify.mjs';

const cfg = loadConfig();
const PORT = cfg.port || 8090;
const db = state.openDb(cfg.stateDb || 'state.sqlite');

const secret = process.env[cfg.githubSecretEnv] || '';
const slackWebhook = process.env[cfg.slackWebhookEnv] || '';
let inFlight = 0;
let shuttingDown = false;

// Per-task in-memory mutex. Two near-simultaneous deliveries for the SAME task must
// not both reserve an active execution; this serializes the reservation section
// (re-read state -> check live execution -> reconcile stale -> create lease/run)
// without holding the lock across the (possibly long) worker run. The persisted
// active lease + 'running' run become the durable ownership signal.
const taskLocks = new Map();
async function withTaskLock(taskId, fn) {
  const prev = taskLocks.get(taskId) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const held = prev.then(() => gate);
  taskLocks.set(taskId, held);
  await prev; // wait until the previous holder finishes its reservation
  try {
    return await fn();
  } finally {
    release();
    // Drop the entry (best-effort) if no one queued behind us.
    if (taskLocks.get(taskId) === held) taskLocks.delete(taskId);
  }
}

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


function refusal(reason, extra = {}) {
  return { ok: false, refusal: true, reason, ...extra };
}

async function dispatch(rule, ctx) {
  const workerCfg = (cfg.workers || {})[rule.worker];
  if (!workerCfg) return { ok: false, reason: `unknown worker '${rule.worker}'` };

  // A repair worker is inherently a code worker: it edits the task worktree, so
  // it must always go through the envelope + worktree + lease reservation path.
  const isCodeWorker = !!workerCfg.createsTask || !!workerCfg.repair;

  // Code-editing dispatch requires a valid handoff envelope (ORCH-073..076).
  let envelope = null;
  if (isCodeWorker) {
    const parsed = parseEnvelope(ctx.bodyText);
    if (!parsed.ok) return refusal('invalid handoff envelope', { errors: parsed.errors });
    envelope = parsed.data;
  }

  // Durable task + run + lease + worktree for code workers. Everything below FAILS
  // CLOSED and, for a given task, is serialized under a per-task lock so two near-
  // simultaneous deliveries cannot both reserve an active execution. Ordering:
  //   parse envelope -> authorization -> envelope/context cross-check ->
  //   resolve/fetch authoritative live base -> load existing task state ->
  //   validate envelope state vs persisted state -> CHECK ACTIVE EXECUTION ->
  //   (only if no live execution) reconcile stale lease/run -> validate legal
  //   retry/new lifecycle -> release stale/previous lease -> prepare CLEAN worktree
  //   -> install path/base guard -> create one active lease -> create one running
  //   run -> launch worker (outside the lock).
  let taskId = null; let worktree = null; let runId = null;
  let attempt = null; let repairAttempt = null; let leaseId = null; let baseSha = null;
  let startSha = null; let runStateDir = null; let runHome = null;
  let workerAllowedPaths = []; let taskAllowedPaths = [];
  if (isCodeWorker) {
    try { taskId = makeTaskId(ctx.repo, ctx.issueNumber, ctx.headSha); } catch (e) { return refusal(`invalid task id: ${e.message}`); }
    const baseRef = ctx.baseRef || cfg.defaultBaseRef || 'main';

    // Cross-check envelope repo/issue/branch/allowed_paths against the event/state.
    const cross = validateEnvelopeContext(envelope, ctx);
    if (!cross.ok) return refusal('envelope does not match event context', { errors: cross.errors });

    // Two independent path scopes: worker/repository baseline (REQUIRED maximum)
    // AND the optional task narrowing boundary. A task can never widen the worker
    // baseline; an omitted task scope means worker-baseline-only (not deny-all).
    ({ worker: workerAllowedPaths, task: taskAllowedPaths } = pathScopes(envelope, workerCfg.allowedPaths));
    if (workerAllowedPaths.length === 0) {
      return refusal('code worker has an empty allowedPaths baseline; refusing to launch');
    }

    const reservation = await withTaskLock(taskId, async () => {
      // Resolve + fetch the CURRENT authoritative remote state; a code task with no
      // resolvable live base (or a stale provided base) refuses to launch.
      let sourceRepo;
      try { sourceRepo = ensureRepo(ctx.repo, cfg.reposRoot, cfg.repoBase); }
      catch (e) { log(`[router] repo unavailable for ${ctx.repo}: ${e.message}`); return refusal('repo is not available'); }

      const contextBase = ctx.baseSha || '';
      const envelopeBase = envelope.base_sha || '';
      const baseRes = resolveBaseSha(sourceRepo, baseRef, { providedSha: contextBase || envelopeBase });
      if (!baseRes.ok) return refusal(baseRes.reason || 'no resolvable base SHA; refusing to launch a code task');
      const baseSha = baseRes.sha;
      if (envelopeBase) {
        const envFull = resolveCommitSha(sourceRepo, envelopeBase);
        if (!envFull) return refusal(`envelope base_sha '${envelopeBase}' is not a valid commit`);
        if (envFull !== baseSha) return refusal('envelope base_sha does not match the live remote base');
      }

      // Load existing task state, validate envelope state against it, and enforce the
      // single-live-execution invariant BEFORE any lease / worktree mutation.
      const existing = state.getTask(db, taskId);
      if (existing) {
        const stateOk = validateExistingTaskState(existing, envelope);
        if (!stateOk.ok) return refusal('envelope state does not match persisted task state', { errors: stateOk.errors });

        // Never clobber a live worker. An expired lease with a running process is
        // ambiguous: fail closed and require human recovery.
        const exec = state.activeExecutionState(db, taskId);
        if (exec.runningRun && exec.activeLease && state.isLeaseExpired(exec.activeLease)) {
          return refusal('execution state ambiguous: running run has expired lease; human recovery required');
        }
        if (exec.live) {
          return refusal('task already has an active execution');
        }
        // Stale recovery: reconcile an old 'running' run and any stale lease before
        // a controlled re-execution. Only reached when there is no LIVE execution.
        if (exec.runningRun) state.markRunAbandoned(db, exec.runningRun.id, 'stale run reconciled by a new dispatch');
        if (exec.activeLease) state.releaseLease(db, exec.activeLease.id);

        if (!canEnterInProgress(existing.state)) {
          return refusal(`illegal state transition '${existing.state}' -> 'in_progress'`);
        }
      } else {
        const ns = validateNewTaskState(envelope.state);
        if (!ns.ok) return refusal('invalid initial task state', { errors: ns.errors });
      }

      // Bounded repair worker (Hermes) gates (ORCH-098/099). A task that a prior
      // repair escalated/blocked, or one that has exhausted its attempt budget,
      // must never be auto-dispatched again — human intervention is required.
      if (workerCfg.repair) {
        const maxAttempts = Number(workerCfg.maxAttempts || DEFAULT_MAX_REPAIR_ATTEMPTS);
        if (existing && (existing.state === 'escalated' || existing.state === 'blocked')) {
          const reauthorized = ctx.action === 'labeled' && ctx.triggerLabel === 'repair:retry' && (cfg.allowlist || []).includes(ctx.actor) && envelope.state === existing.state;
          if (!reauthorized) return refusal(`task is '${existing.state}' — autonomous repair requires human re-authorization`);
        }
        // The repair budget counts REPAIR attempts only (ORCH-098). Unrelated
        // planning/implementation runs on the same task must not consume it.
        if (attemptExceeded(state.nextRepairAttempt(db, taskId), maxAttempts)) {
          state.updateTaskState(db, taskId, 'escalated');
          return refusal(`repair attempt limit reached (max ${maxAttempts}); task escalated to human`);
        }
      }

      // Reservation: no live execution remains, so it is now safe to release any
      // remaining active lease, upsert the task, and reserve a fresh execution.
      state.releaseActiveLeasesForTask(db, taskId);
      state.createTask(db, {
        id: taskId, repo: ctx.repo, issue: ctx.issueNumber != null ? String(ctx.issueNumber) : null,
        state: 'in_progress', owner: envelope.agent, branch: envelope.branch,
        baseSha, baseRef, risk: 'pilot',
      });
      if (existing) log(`[router] task ${taskId} already exists — deliberate retry/state transition`);

      // Prepare a CLEAN named worktree from authoritative Git state; install the
      // path/base guard; create exactly one active lease + one running run.
      try {
        const prepared = prepareWorktreeForRun({
          sourceRepo, worktreeRoot: cfg.worktreeRoot, taskId, baseSha, branch: envelope.branch,
        });
        const wt = prepared.path;
        installPushGuard(wt, { workerAllowedPaths, taskAllowedPaths, baseSha, baseRef });
        const attempt = state.nextAttempt(db, taskId);
        const repairAttemptN = workerCfg.repair ? state.nextRepairAttempt(db, taskId) : null;
        const rid = crypto.randomUUID();
        const lid = crypto.randomUUID();
        if (workerCfg.repair) {
          const stateRoot = resolve(cfg.runStateRoot || join(cfg.__routerDir, '.run-state'));
          runStateDir = join(stateRoot, rid);
          runHome = join('/home/dq/.hermes-sandbox/runs', rid, 'home');
          if (existsSync(runStateDir) || existsSync(runHome)) throw new Error('run state already exists');
          mkdirSync(runStateDir, { recursive: true, mode: 0o700 });
          mkdirSync(runHome, { recursive: true, mode: 0o700 });
        }
        state.createLease(db, {
          id: lid, taskId, worktree: wt, baseSha, owner: envelope.agent,
          sourceRepo, expiresAt: new Date(Date.now() + (cfg.leaseDurationMs || 86400000)).toISOString(),
        });
        state.createRun(db, { id: rid, taskId, agent: rule.worker, attempt, repairAttempt: repairAttemptN, status: 'running' });
        return { ok: true, worktree: wt, runId: rid, attempt, repairAttempt: repairAttemptN, leaseId: lid, baseSha, startSha: prepared.startSha, runStateDir, runHome };
      } catch (e) {
        log(`[router] worktree setup failed for ${taskId}: ${e.message}`);
        state.updateTaskState(db, taskId, 'blocked');
        return refusal('worktree setup failed', { detail: e.message });
      }
    });

    if (reservation.refusal) return reservation;
    worktree = reservation.worktree;
    runId = reservation.runId;
    attempt = reservation.attempt ?? null;
    repairAttempt = reservation.repairAttempt ?? null;
    leaseId = reservation.leaseId ?? null;
    baseSha = reservation.baseSha ?? null;
    startSha = reservation.startSha ?? null;
    runStateDir = reservation.runStateDir ?? null;
    runHome = reservation.runHome ?? null;
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

  // Bounded repair workers (Hermes) receive structured task/run/lease context as
  // explicit SONORAN_* metadata (never free-form env inheritance), plus a result
  // file path the worker writes its structured outcome to. ORCH-096/097.
  let repairResultFile = null;
  if (workerCfg.repair) {
    repairResultFile = runStateDir ? join(runStateDir, 'repair-result.json') : null;
    const maxAttempts = Number(workerCfg.maxAttempts || DEFAULT_MAX_REPAIR_ATTEMPTS);
    const repairMeta = {
      RUN_ID: runId,
      RUN_STATE_DIR: runStateDir,
      RUN_HOME: runHome,
      LEASE_ID: leaseId,
      REPO: ctx.repo,
      BRANCH: envelope?.branch || ctx.branch || '',
      BASE_SHA: baseSha,
      ATTEMPT: repairAttempt,
      MAX_ATTEMPTS: maxAttempts,
      ALLOWED_PATHS: workerAllowedPaths.join('\n'),
      TASK_PATHS: taskAllowedPaths.join('\n'),
      BUILD_CMD: workerCfg.buildCmd || DEFAULT_REPAIR_BUILD_CMD,
      RESULT_FILE: cfg.testFixtures === true && cfg.devMode === true && workerCfg.testFixture === true ? repairResultFile : "/run/sonoran/repair-result.json",
    };
    vars.meta = repairMeta;
  }

  const program = resolveProgram(workerCfg.program, cfg.__routerDir);
  const args = interpolateArgs(workerCfg.args || [], vars);
  // Never inherit every env var from the router process (ORCH-094): workers get
  // only an explicit allowlist (PATH/HOME by default) plus their task/worktree
  // and (for repair workers) the structured SONORAN_* metadata above.
  const env = buildWorkerEnv(workerCfg, { taskId, worktree, meta: vars.meta || {} });

  const result = await runWorker(workerCfg, {
    program, args, cwd: worktree || cfg.__routerDir, env, timeoutMs: workerCfg.timeoutMs || cfg.defaultTimeoutMs,
  });

  // Interpret results and persist durable evidence. Cleanup is a true finalizer:
  // this dispatch releases/removes only the run identity it reserved.
  let repairRead = null;
  let repairAction = null;
  let repairVerification = null;
  let outcomeOk = result.ok && !workerCfg.repair;
  try {
    if (workerCfg.repair) {
      repairRead = readRepairResult(repairResultFile, { expectedAttempt: repairAttempt });
      repairAction = classifyRepairResult(repairRead);
      if (repairAction.action === 'candidate_fix' && repairRead.ok && result.ok) {
        repairVerification = verifyRepairCandidate({ worktree, expectedBranch: envelope.branch, startSha, workerAllowedPaths, taskAllowedPaths, declaredFiles: repairRead.data.files_changed });
        if (!repairVerification.ok) repairAction = { action: 'invalid', reason: `post-run Git verification: ${repairVerification.reason}` };
      }
    }
    outcomeOk = result.ok && (!workerCfg.repair || (repairRead?.ok === true && repairAction?.action !== 'invalid'));
    if (runId) {
      let runStatus = 'failed';
      if (outcomeOk) {
        if (repairAction?.action === 'escalate') runStatus = 'escalated';
        else if (repairAction?.action === 'blocked') runStatus = 'blocked';
        else if (!workerCfg.repair || repairAction?.action === 'candidate_fix' || repairAction?.action === 'no_fix') runStatus = 'success';
      }
      const runResult = workerCfg.repair
        ? JSON.stringify(buildRepairRecord({ data: repairRead?.ok ? repairRead.data : null, action: repairAction?.action ?? null, error: repairRead?.ok ? (repairVerification?.ok === false ? repairVerification.reason : null) : repairRead.error, attempt: repairAttempt, exitCode: result.code, timedOut: result.timedOut, output: result.stderr || result.stdout || result.error || '' }))
        : (result.stderr || result.stdout || result.error || '').slice(0, 2000);
      state.updateRun(db, runId, { status: runStatus, result: runResult });
    }
    if (taskId) {
      if (workerCfg.repair) {
        if (repairAction?.action === 'escalate') state.updateTaskState(db, taskId, 'escalated');
        else if (repairAction?.action === 'blocked') state.updateTaskState(db, taskId, 'blocked');
        else if (!outcomeOk) state.updateTaskState(db, taskId, 'in_progress');
      } else if (!result.ok) state.updateTaskState(db, taskId, 'blocked');
    }
  } catch (e) {
    outcomeOk = false;
    const reason = String(e?.message || e).slice(0, 2000);
    repairAction = { action: 'invalid', reason: `finalization failure: ${reason}` };
    if (runId) {
      try {
        state.updateRun(db, runId, { status: 'failed', result: workerCfg.repair ? JSON.stringify(buildRepairRecord({ action: 'invalid', error: reason, attempt: repairAttempt, exitCode: result.code, timedOut: result.timedOut })) : reason });
      } catch (persistError) { log(`[router] failed to persist run ${runId}: ${persistError.message}`); }
    }
  } finally {
    if (leaseId) { try { state.releaseLease(db, leaseId); } catch (e) { log(`[router] failed to release lease ${leaseId}: ${e.message}`); } }
    if (runStateDir) { try { rmSync(runStateDir, { recursive: true, force: true }); } catch (e) { log(`[router] failed to remove run state ${runStateDir}: ${e.message}`); } }
    if (runHome) { try { rmSync(runHome, { recursive: true, force: true }); } catch (e) { log(`[router] failed to remove run home ${runHome}: ${e.message}`); } }
  }

  return { ok: outcomeOk, taskId, runId, worktree, attempt, repairAttempt, repairAction: repairAction?.action ?? null, output: (result.stderr || result.stdout || '').slice(0, 500) };
}

async function handlePost(raw, headers) {
  let body;
  try { body = JSON.parse(raw || '{}'); } catch { return { status: 400, json: { error: 'invalid JSON body' } }; }

  const ctx = normalize(headers, body);
  if (ctx.event === '' && !cfg.devMode) return { status: 400, json: { error: 'missing X-GitHub-Event' } };
  if (!ctx.deliveryId && !cfg.devMode) return { status: 400, json: { error: 'missing X-GitHub-Delivery' } };

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
      const running = state.getRunningRunForTask(db, lease.task_id);
      if (running) { log(`[router] lease ${lease.id} expired while run ${running.id} is still running; refusing reap`); continue; }
      // A stale lease must never remove a worktree that a newer active lease owns.
      if (state.activeLeaseOwnsWorktree(db, { sourceRepo: lease.source_repo, worktree: lease.worktree }, lease.id)) {
        state.releaseLease(db, lease.id);
        log(`[router] not reaping ${lease.id}: worktree still owned by an active lease`);
        continue;
      }
      removeWorktreePath(lease.source_repo, lease.worktree, cfg.worktreeRoot);
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
