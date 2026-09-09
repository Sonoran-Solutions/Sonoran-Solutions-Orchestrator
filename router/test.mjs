// router/test.mjs — Sonoran control-plane tests. Run: node test.mjs
import { parseEnvelope, legalTransition, validateEnvelopeContext, pathScopes, validBranchName, validateNewTaskState, validateExistingTaskState, canEnterInProgress } from './lib/handoff.mjs';
import { authorize } from './lib/auth.mjs';
import { normalize } from './lib/events.mjs';
import { interpolateArgs, runWorker, buildWorkerEnv } from './lib/workers.mjs';
import { DEFAULT_MAX_REPAIR_ATTEMPTS, DEFAULT_REPAIR_BUILD_CMD, REPAIR_STATUSES, MAX_REPAIR_RESULT_BYTES, MAX_REPAIR_ARRAY_ENTRIES, MAX_REPAIR_ARRAY_ENTRY_CHARS, MAX_REPAIR_TEXT_CHARS, isEscalationStatus, readRepairResult, classifyRepairResult, attemptExceeded } from './lib/hermes.mjs';
import * as state from './lib/state.mjs';
import { runGit, createWorktree, removeWorktree, installPushGuard, resolveGitDir, removeWorktreePath, safeBranchName, resolveBaseSha, resolveCommitSha, prepareWorktreeForRun, verifyCleanWorktree, PRIVATE_REPO_PUSH_URL } from './lib/worktrees.mjs';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathMatches, verifyRepairCandidate } from './lib/repair-verify.mjs';
import { makeTaskId, containedPath } from './lib/task-id.mjs';
import { validateConfig } from './lib/config.mjs';

const routerDir = dirname(fileURLToPath(import.meta.url));
let passed = 0; let failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertThrows(fn, pattern, msg) {
  let error = null;
  try { fn(); } catch (caught) { error = caught; }
  assert(error && pattern.test(String(error.message || error)), msg || 'expected matching exception');
}

// git util that throws on non-zero exit, for expected-success assertions.
function git(cwd, args) { return runGit(cwd, args); }
// Build an isolated source repo with a real origin remote pointing at a bare repo,
// so pre-push guards can query `git ls-remote origin` for the live base tip.
function makeRemoteRepo(dir) {
  const remoteDir = join(dir, 'remote.git');
  const src = join(dir, 'repo');
  spawnSync('git', ['init', '--bare', '--quiet', remoteDir], { cwd: dir }).status === 0 || assert(false, 'bare init');
  mkdirSync(src);
  git(src, ['init', '-q']);
  git(src, ['config', 'user.email', 't@t']);
  git(src, ['config', 'user.name', 't']);
  git(src, ['remote', 'add', 'origin', remoteDir]);
  writeFileSync(join(src, 'f.txt'), 'hello');
  git(src, ['add', 'f.txt']);
  git(src, ['commit', '-qm', 'init']);
  git(src, ['branch', '-M', 'main']);
  git(src, ['push', '-q', '-u', 'origin', 'main']);
  spawnSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: remoteDir }).status === 0 || assert(false, 'set bare HEAD');
  const baseSha = git(src, ['rev-parse', 'HEAD']).trim();
  return { remoteDir, src, baseSha };
}
const ZERO = '0000000000000000000000000000000000000000';

// Advance the remote's main branch from a separate clone, WITHOUT touching `src`.
// Returns the new base SHA.
function advanceRemoteMain(remoteDir, dir) {
  const peer = join(dir, 'peer-' + Date.now());
  spawnSync('git', ['clone', '-q', '-b', 'main', remoteDir, peer], { cwd: dir }).status === 0 || assert(false, 'peer clone');
  git(peer, ['config', 'user.email', 't@t']);
  git(peer, ['config', 'user.name', 't']);
  writeFileSync(join(peer, 'g-' + Date.now() + '.txt'), 'x');
  git(peer, ['add', '.']);
  git(peer, ['commit', '-qm', 'advance base']);
  git(peer, ['push', '-q', 'origin', 'main']);
  return git(peer, ['rev-parse', 'HEAD']).trim();
}

// ---------------------------------------------------------------- handoff
const ENVELOPE = `---\nschema_version: 1\nagent: codex\nto: antigravity\nrepo: Sonoran-Solutions/dualdex\nissue: "123"\nbranch: feat/123\nstate: planned\ntask: Add profile\nsummary: |\n  Do the thing\n  with more detail\nacceptance: |\n  test passes\nurgency: normal\nescalate_to: human\n---\nrest is prose`;
test('handoff: valid envelope parses', () => {
  const r = parseEnvelope(ENVELOPE);
  assert(r.ok, r.errors.join('; '));
  assert(r.data.schema_version === '1', 'schema_version');
  assert(r.data.task === 'Add profile', 'task');
  assert(r.data.summary.includes('more detail'), 'block scalar summary');
});
test('handoff: missing field fails', () => {
  const r = parseEnvelope('---\nschema_version: 1\nstate: planned\n---');
  assert(!r.ok, 'should fail');
  assert(r.errors.some((e) => e.includes('missing required field')), 'reports missing field');
});
test('handoff: unknown schema version fails', () => {
  const r = parseEnvelope('---\nschema_version: 2\nstate: planned\n---');
  assert(!r.ok && r.errors.some((e) => e.includes('unsupported schema_version')), 'reports schema');
});
test('handoff: prose outside fence is ignored (malicious text)', () => {
  const evil = '---\nschema_version: 1\nagent: x\nto: y\nrepo: r\nissue: "1"\nbranch: b\nstate: planned\ntask: t\nacceptance: a\n---\n`rm -rf /` and $(whoami)';
  const r = parseEnvelope(evil);
  assert(r.ok, 'envelope itself is valid');
  assert(!JSON.stringify(r.data).includes('rm -rf'), 'prose not parsed into fields');
});
test('handoff: parses real template (lists + block scalar + escalated state)', () => {
  const real = `---
schema_version: 1
task_id: ss-141
agent: hermes
to: codex
repo: sonoran-solutions/project
issue: "141"
branch: fix/141
base_sha: 8f2c91a44d8f
state: escalated
risk: normal
attempt: 5
max_attempts: 5
allowed_paths:
  - src/layout/**
  - tests/e2e.spec.js
required_checks:
  - build
  - e2e
task: Fix the Safari layout regression.
summary: |
  Five attempts were tried.
  All regressed.
acceptance: |
  Build passes.
escalate_to: human
---`;
  const r = parseEnvelope(real);
  assert(r.ok, r.errors.join('; '));
  assert(r.data.state === 'escalated', 'escalated state accepted');
  assert(Array.isArray(r.data.allowed_paths) && r.data.allowed_paths.includes('src/layout/**'), 'list parsed');
  assert(r.data.summary.includes('Five attempts'), 'block scalar parsed');
});

test('handoff: legal state transitions', () => {
  assert(legalTransition('planned', 'authorized'), 'planned->authorized');
  assert(legalTransition('review', 'in_progress'), 'review->in_progress (fix loop)');
  assert(!legalTransition('planned', 'in_progress'), 'planned->in_progress is not direct');
  assert(!legalTransition('done', 'in_progress'), 'done->in_progress illegal (no reopen yet)');
});

test('handoff: envelope is cross-checked against event context (repo/issue/branch/allowed_paths)', () => {
  const ctx = { repo: 'Sonoran-Solutions/dualdex', issueNumber: 25 };
  const okEnv = { repo: 'sonoran-solutions/dualdex', issue: '25', branch: 'feat/25', allowed_paths: ['app/src/**'] };
  assert(validateEnvelopeContext(okEnv, ctx).ok, 'valid envelope passes repo/issue/branch');
  // repo mismatch (case-insensitive compare should NOT reject for the valid one)
  let r = validateEnvelopeContext({ ...okEnv, repo: 'evil/repo' }, ctx);
  assert(!r.ok && r.errors.some((e) => e.includes('repo')), 'repo mismatch rejected');
  r = validateEnvelopeContext({ ...okEnv, issue: '99' }, ctx);
  assert(!r.ok && r.errors.some((e) => e.includes('issue')), 'issue mismatch rejected');
  r = validateEnvelopeContext({ ...okEnv, branch: 'a b' }, ctx);
  assert(!r.ok && r.errors.some((e) => e.includes('branch')), 'invalid branch rejected');
  r = validateEnvelopeContext({ ...okEnv, branch: '-rf' }, ctx);
  assert(!r.ok && r.errors.some((e) => e.includes('branch')), 'leading-dash branch rejected');
  r = validateEnvelopeContext({ ...okEnv, allowed_paths: ['a', 3] }, ctx);
  assert(!r.ok && r.errors.some((e) => e.includes('allowed_paths')), 'non-string allowed_path rejected');
});

test('handoff: path scopes keep worker baseline AND task scope independent (no widening)', () => {
  const workerScope = ['app/src/**', 'native/**'];
  // No task scope -> worker baseline alone.
  let s = pathScopes({}, workerScope);
  assert(JSON.stringify(s.worker) === JSON.stringify(workerScope) && JSON.stringify(s.task) === '[]', 'no task scope falls back to worker baseline');
  // Task scope present -> BOTH are returned independently (worker baseline is max; task narrows).
  s = pathScopes({ allowed_paths: ['tests/**'] }, workerScope);
  assert(JSON.stringify(s.worker) === JSON.stringify(workerScope), 'worker baseline preserved');
  assert(JSON.stringify(s.task) === JSON.stringify(['tests/**']), 'task scope returned separately');
  // A task '*' does NOT replace/override the worker baseline (widening is impossible).
  s = pathScopes({ allowed_paths: ['*'] }, workerScope);
  assert(JSON.stringify(s.worker) === JSON.stringify(workerScope), 'worker baseline still preserved when task says *');
  // Empty/null task scope -> no narrowing boundary.
  s = pathScopes({ allowed_paths: [] }, workerScope);
  assert(JSON.stringify(s.task) === '[]', 'empty task scope is no narrowing');
  assert(validBranchName('agent/task-1'), 'validBranchName accepts safe names');
  assert(!validBranchName('x;cat /etc/passwd'), 'validBranchName rejects shell metachars');
});

test('handoff: new-task lifecycle state is restricted; existing retries obey transitions', () => {
  // New task: only planned/authorized/assigned are acceptable starting states.
  assert(validateNewTaskState('planned').ok, 'planned accepted');
  assert(validateNewTaskState('authorized').ok, 'authorized accepted (trusted agent:ready signal)');
  assert(validateNewTaskState('assigned').ok, 'assigned accepted');
  for (const bad of ['in_progress', 'done', 'review', 'verification', 'blocked', 'escalated']) {
    assert(!validateNewTaskState(bad).ok, `${bad} rejected for a new task`);
  }
  // Existing task retries: in_progress re-run allowed, legal transitions allowed, done terminal.
  assert(canEnterInProgress('in_progress'), 'in_progress re-run allowed');
  assert(canEnterInProgress('blocked'), 'blocked -> in_progress allowed');
  assert(canEnterInProgress('review'), 'review -> in_progress allowed (fix loop)');
  assert(!canEnterInProgress('done'), 'done -> in_progress rejected (terminal)');
  assert(!canEnterInProgress('planned'), 'planned -> in_progress is not a direct legal transition');
});

test('handoff: existing task envelope state must agree with persisted state (fail closed)', () => {
  assert(validateExistingTaskState({ state: 'blocked' }, { state: 'blocked' }).ok, 'blocked+blocked agrees');
  assert(validateExistingTaskState({ state: 'review' }, { state: 'review' }).ok, 'review+review agrees');
  assert(validateExistingTaskState({ state: 'done' }, { state: 'done' }).ok, 'done+done agrees (transition still terminal via canEnterInProgress)');
  assert(validateExistingTaskState({ state: 'in_progress' }, { state: 'in_progress' }).ok, 'in_progress+in_progress agrees');
  // Mismatches fail closed rather than auto-reconciling.
  let r = validateExistingTaskState({ state: 'blocked' }, { state: 'done' });
  assert(!r.ok && r.errors.some((e) => e.includes('does not match persisted')), 'blocked+done mismatch refused');
  r = validateExistingTaskState({ state: 'review' }, { state: 'planned' });
  assert(!r.ok && r.errors.some((e) => e.includes('does not match persisted')), 'review+planned mismatch refused');
  assert(!validateExistingTaskState({ state: 'in_progress' }, { state: 'blocked' }).ok, 'in_progress+blocked mismatch refused');
  // done remains terminal.
  assert(!canEnterInProgress('done'), 'done stays terminal');
});

test('handoff: envelope branch must match PR head branch when the event carries one', () => {
  const prCtx = { repo: 'Sonoran-Solutions/dualdex', issueNumber: 7, branch: 'feat/real' };
  // PR branch match -> allowed.
  let r = validateEnvelopeContext({ repo: 'Sonoran-Solutions/dualdex', issue: '7', branch: 'feat/real' }, prCtx);
  assert(r.ok, 'PR branch match allowed');
  // PR branch mismatch -> refusal.
  r = validateEnvelopeContext({ repo: 'Sonoran-Solutions/dualdex', issue: '7', branch: 'feat/something-else' }, prCtx);
  assert(!r.ok && r.errors.some((e) => e.includes('does not match event branch')), 'PR branch mismatch refused');
  // Issue event (no event branch) -> branch syntax-only.
  const issueCtx = { repo: 'Sonoran-Solutions/dualdex', issueNumber: 25, branch: '' };
  r = validateEnvelopeContext({ repo: 'Sonoran-Solutions/dualdex', issue: '25', branch: 'feat/25' }, issueCtx);
  assert(r.ok, 'issue event with valid task branch allowed');
});

// ---------------------------------------------------------------- auth
test('auth: trusted actor allowed', () => {
  const ctx = { actor: 'alice', labels: [] };
  assert(authorize({ authorize: 'trusted' }, ctx, { allowlist: ['alice'] }).ok);
});
test('auth: untrusted actor denied', () => {
  const ctx = { actor: 'mallory', labels: [] };
  assert(!authorize({ authorize: 'trusted' }, ctx, { allowlist: ['alice'] }).ok);
});
test('auth: label gate requires label + trusted labeler', () => {
  const cfg = { allowlist: ['alice'], requireLabel: 'agent:ready' };
  assert(!authorize({ authorize: 'label' }, { actor: 'alice', labels: [] }, cfg).ok, 'missing label');
  assert(authorize({ authorize: 'label' }, { actor: 'alice', labels: ['agent:ready'] }, cfg).ok, 'label+trusted');
  assert(!authorize({ authorize: 'label' }, { actor: 'mallory', labels: ['agent:ready'] }, cfg).ok, 'untrusted labeler');
});

// ---------------------------------------------------------------- events
test('events: normalize pulls issue + label + sender', () => {
  const ctx = normalize(
    { 'x-github-delivery': 'd1', 'x-github-event': 'issues' },
    { action: 'labeled', sender: { login: 'alice' }, repository: { full_name: 'r/r' },
      issue: { number: 5, title: 'T', body: 'B', labels: [{ name: 'agent:ready' }] } });
  assert(ctx.deliveryId === 'd1' && ctx.issueNumber === 5 && ctx.labels.includes('agent:ready'));
});

// ---------------------------------------------------------------- state (SQLite)
test('state: deliveries dedupe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-state-'));
  const db = state.openDb(join(dir, 's.sqlite'));
  const d = { id: 'deliv-1', repo: 'r/r', event: 'issues', actor: 'alice' };
  assert(state.recordDelivery(db, d) === true, 'first is new');
  assert(state.recordDelivery(db, d) === false, 'second is duplicate');
  state.close(db); rmSync(dir, { recursive: true, force: true });
});
test('state: task/run/lease round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-state-'));
  const db = state.openDb(join(dir, 's.sqlite'));
  state.createTask(db, { id: 'dualdex-5', repo: 'Sonoran-Solutions/dualdex', issue: '5', state: 'in_progress', owner: 'codex' });
  state.createRun(db, { id: 'run-1', taskId: 'dualdex-5', agent: 'codex', attempt: 1 });
  state.createLease(db, { id: 'lease-1', taskId: 'dualdex-5', worktree: '/tmp/wt', baseSha: 'abc', owner: 'codex' });
  assert(state.getTask(db, 'dualdex-5').state === 'in_progress', 'task exists');
  assert(state.getActiveLeaseForTask(db, 'dualdex-5').worktree === '/tmp/wt', 'lease exists');
  state.updateRun(db, 'run-1', { status: 'success', result: 'ok' });
  state.updateTaskState(db, 'dualdex-5', 'done');
  assert(state.getTask(db, 'dualdex-5').state === 'done', 'task updated');
  state.close(db); rmSync(dir, { recursive: true, force: true });
});

test('state: task creation is idempotent on re-delivery (retry, not a 500)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-state-'));
  const db = state.openDb(join(dir, 's.sqlite'));
  const task = { id: 'dualdex-25', repo: 'Sonoran-Solutions/dualdex', issue: '25', state: 'in_progress', owner: 'codex', branch: 'feat/25', baseSha: 'abc', baseRef: 'main', risk: 'pilot' };
  const first = state.createTask(db, task);
  assert(first.state === 'in_progress', 'first create inserts');
  // New delivery, same task ID (label removed + re-added) -> deliberate transition, no throw
  const second = state.createTask(db, { id: 'dualdex-25', repo: 'Sonoran-Solutions/dualdex', issue: '25', state: 'in_progress', owner: 'hermes', branch: 'feat/25', baseSha: 'def', baseRef: 'main' });
  assert(second.id === 'dualdex-25', 'same id returned');
  assert(second.owner === 'hermes', 'owner transitioned on retry');
  assert(second.base_sha === 'def', 'base ref-sha transitioned on retry');
  assert(state.getTask(db, 'dualdex-25').repo === 'Sonoran-Solutions/dualdex', 'task still present');
  // attempts increment across runs
  state.createRun(db, { id: 'r1', taskId: 'dualdex-25', agent: 'codex', attempt: 1 });
  assert(state.nextAttempt(db, 'dualdex-25') === 2, 'next attempt after one run');
  state.createRun(db, { id: 'r2', taskId: 'dualdex-25', agent: 'hermes', attempt: state.nextAttempt(db, 'dualdex-25') });
  assert(state.nextAttempt(db, 'dualdex-25') === 3, 'next attempt after two runs');
  state.close(db); rmSync(dir, { recursive: true, force: true });
});

test('state: re-delivery releases old active leases, keeps exactly one active lease per task', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-lease-'));
  const db = state.openDb(join(dir, 's.sqlite'));
  state.createLease(db, { id: 'a', taskId: 'dualdex-25', worktree: '/wt', baseSha: 'abc', owner: 'codex', sourceRepo: '/src', expiresAt: '2099-01-01T00:00:00Z' });
  state.createLease(db, { id: 'b', taskId: 'dualdex-25', worktree: '/wt', baseSha: 'def', owner: 'hermes', sourceRepo: '/src', expiresAt: '2099-01-01T00:00:01Z' });
  assert(state.getActiveLeaseForTask(db, 'dualdex-25').id === 'b', 'newest active lease wins');
  state.releaseActiveLeasesForTask(db, 'dualdex-25');
  assert(state.getActiveLeaseForTask(db, 'dualdex-25') == null, 'no active lease remains for the task');
  // A fresh lease can now be created without an existing active one for the task.
  state.createLease(db, { id: 'c', taskId: 'dualdex-25', worktree: '/wt', baseSha: 'abc', owner: 'codex', sourceRepo: '/src', expiresAt: '2099-01-01T00:00:00Z' });
  assert(state.getActiveLeaseForTask(db, 'dualdex-25').id === 'c', 'one active lease only');
  state.close(db); rmSync(dir, { recursive: true, force: true });
});

test('state: a stale lease cannot reap a worktree owned by a newer active lease', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-own-'));
  const db = state.openDb(join(dir, 's.sqlite'));
  // Same worktree: one stale/expired lease and one active lease both reference it.
  state.createLease(db, { id: 'stale', taskId: 'dualdex-25', worktree: '/wt', baseSha: 'abc', owner: 'codex', sourceRepo: '/src', expiresAt: new Date(Date.now() - 5000).toISOString() });
  state.createLease(db, { id: 'active', taskId: 'dualdex-25', worktree: '/wt', baseSha: 'def', owner: 'hermes', sourceRepo: '/src', expiresAt: '2099-01-01T00:00:00Z' });
  const expires = state.listExpiredLeases(db, state.now());
  assert(expires.length === 1 && expires[0].id === 'stale', 'stale lease listed');
  assert(state.activeLeaseOwnsWorktree(db, { sourceRepo: '/src', worktree: '/wt' }, 'stale'), 'an active lease still owns /wt');
  state.close(db); rmSync(dir, { recursive: true, force: true });
});

test('state: activeExecutionState distinguishes a live execution from a stale one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-exec-'));
  const db = state.openDb(join(dir, 's.sqlite'));
  state.createTask(db, { id: 'dualdex-25', repo: 'r/r', issue: '25', state: 'in_progress' });

  // No run + no lease -> not live.
  let e = state.activeExecutionState(db, 'dualdex-25');
  assert(!e.live && !e.runningRun && !e.activeLease, 'no execution -> not live');

  // Running run + active UNEXPIRED lease -> live.
  state.createRun(db, { id: 'r1', taskId: 'dualdex-25', agent: 'codex', attempt: 1 });
  state.createLease(db, { id: 'l1', taskId: 'dualdex-25', worktree: '/wt', owner: 'codex', sourceRepo: '/src', expiresAt: new Date(Date.now() + 5000).toISOString() });
  e = state.activeExecutionState(db, 'dualdex-25');
  assert(e.live === true && e.runningRun.id === 'r1' && e.activeLease.id === 'l1', 'running + unexpired lease -> live');
  assert(!state.isLeaseExpired(e.activeLease), 'unexpired lease is not expired');

  // Running run + EXPIRED lease -> stale (recoverable), not live.
  state.createLease(db, { id: 'l2', taskId: 'dualdex-25', worktree: '/wt', owner: 'hermes', sourceRepo: '/src', expiresAt: new Date(Date.now() - 5000).toISOString() });
  state.releaseLease(db, 'l1');
  e = state.activeExecutionState(db, 'dualdex-25');
  assert(e.live === false && e.runningRun && e.activeLease.id === 'l2', 'running + expired lease -> stale');
  assert(state.isLeaseExpired(e.activeLease), 'expired lease detected');

  // Marking the stale run abandoned clears it from "running".
  state.markRunAbandoned(db, 'r1', 'reconciled');
  assert(state.getRunningRunForTask(db, 'dualdex-25') == null, 'abandoned run is no longer running');

  state.close(db); rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- worktrees
test('worktrees: create + remove an isolated task-private repository on a named branch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-wt-'));
  const { src, baseSha } = makeRemoteRepo(dir);
  const wtRoot = join(dir, 'worktrees');
  const wt = createWorktree({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 'task-1', baseSha, branch: 'feat/1' });
  assert(wt.endsWith('task-1'), 'checkout path');
  assert(existsSync(join(wt, '.git')) && resolveGitDir(wt) === join(wt, '.git'), 'task owns a standalone .git directory');
  assert(!existsSync(join(wt, '.git', 'objects', 'info', 'alternates')), 'task repository has no shared-object alternate');
  assert(!runGit(src, ['worktree', 'list']).includes('task-1'), 'source repository has no linked task worktree');
  assert(runGit(wt, ['rev-parse', 'HEAD']).trim() === baseSha, 'private checkout starts at approved SHA');
  assert(runGit(wt, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() === 'feat/1', 'named task branch created');
  assert(runGit(wt, ['config', '--local', 'user.email']).trim() === 'hermes@local', 'harmless local commit identity configured');
  assert(runGit(wt, ['remote', 'get-url', '--push', 'origin']).trim() === PRIVATE_REPO_PUSH_URL, 'remote publication disabled');
  removeWorktree({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 'task-1' });
  assert(!existsSync(wt), 'private checkout removed');
  rmSync(dir, { recursive: true, force: true });
});

test('worktrees: task-private origin never copies embedded source credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-wt-credentials-'));
  const src = join(dir, 'repo'); const wtRoot = join(dir, 'worktrees');
  mkdirSync(src); runGit(src, ['init', '-q']); runGit(src, ['config', 'user.email', 't@t']); runGit(src, ['config', 'user.name', 't']);
  writeFileSync(join(src, 'f.txt'), 'hello'); runGit(src, ['add', 'f.txt']); runGit(src, ['commit', '-qm', 'init']);
  runGit(src, ['remote', 'add', 'origin', 'https://owner:TOPSECRET@github.com/example/repo.git']);
  const baseSha = runGit(src, ['rev-parse', 'HEAD']).trim();
  const wt = createWorktree({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 'task-credentials', baseSha, branch: 'feat/credentials' });
  const config = readFileSync(join(wt, '.git', 'config'), 'utf8');
  assert(!config.includes('TOPSECRET') && !config.includes('owner@'), 'embedded source credentials stripped');
  assert(runGit(wt, ['remote', 'get-url', 'origin']).trim() === 'https://github.com/example/repo.git', 'credential-free fetch URL retained');
  assert(runGit(wt, ['remote', 'get-url', '--push', 'origin']).trim() === PRIVATE_REPO_PUSH_URL, 'push remains disabled');
  removeWorktree({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 'task-credentials' });
  rmSync(dir, { recursive: true, force: true });
});

test('worktrees: safeBranchName rejects injection / invalid branch names', () => {
  assert(safeBranchName('feat/123') === 'feat/123', 'normal branch ok');
  assert(safeBranchName('agent/task-1') === 'agent/task-1', 'agent branch ok');
  assert(safeBranchName('') === '', 'empty -> empty');
  assert(safeBranchName('-rf') === '', 'leading dash rejected');
  assert(safeBranchName('a b') === '', 'space rejected');
  assert(safeBranchName('a..b') === '', 'dotdot rejected');
  assert(safeBranchName('a;rm -rf /') === '', 'shell metachars rejected');
  assert(safeBranchName('/abs') === '', 'leading slash rejected');
});

test('worktrees: resolveBaseSha tracks the live remote base tip, not a stale local ref (ORCH-081)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-base-'));
  const { remoteDir, src, baseSha } = makeRemoteRepo(dir);
  assert(/^[0-9a-f]{40}$/.test(baseSha), 'base canary SHA is full length');

  // A. Fresh remote: main = ABC -> resolves live tip.
  let r = resolveBaseSha(src, 'main');
  assert(r.ok && r.sha === baseSha, `A. fresh remote resolves live tip (got ${JSON.stringify(r)})`);

  // C. Provided SHA equals the current remote tip -> allowed.
  r = resolveBaseSha(src, 'main', { providedSha: baseSha });
  assert(r.ok && r.sha === baseSha, 'C. provided SHA == live tip allowed');
  // Short provided SHA expands to full.
  r = resolveBaseSha(src, 'main', { providedSha: baseSha.slice(0, 7) });
  assert(r.ok && r.sha === baseSha, 'C. short provided SHA allowed');

  // B. STALE-CLONE: remote main advances to DEF but we do NOT touch the router clone.
  const newBase = advanceRemoteMain(remoteDir, dir);
  assert(newBase !== baseSha, 'remote main advanced');
  assert(runGit(src, ['rev-parse', 'refs/heads/main']).trim() === baseSha, 'local main still ABC (stale clone)');
  r = resolveBaseSha(src, 'main'); // MUST fetch and return the live DEF tip
  assert(r.ok && r.sha === newBase, `B. stale clone refreshes to live tip DEF (got ${JSON.stringify(r)})`);

  // D. Provided SHA exists but remote main has advanced -> stale refusal.
  r = resolveBaseSha(src, 'main', { providedSha: baseSha });
  assert(!r.ok && /stale/.test(r.reason), `D. provided SHA now stale (got ${JSON.stringify(r)})`);

  // E. Nonexistent SHA -> refusal.
  r = resolveBaseSha(src, 'main', { providedSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
  assert(!r.ok, 'E. nonexistent provided SHA refused');

  // F. Nonexistent base ref -> refusal.
  r = resolveBaseSha(src, 'no-such-branch');
  assert(!r.ok, 'F. nonexistent base ref refused');

  rmSync(dir, { recursive: true, force: true });
});

test('worktrees: resolveBaseSha fails closed when the remote cannot be refreshed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-baseref-'));
  const src = join(dir, 'repo'); mkdirSync(src);
  runGit(src, ['init', '-q']);
  runGit(src, ['config', 'user.email', 't@t']); runGit(src, ['config', 'user.name', 't']);
  writeFileSync(join(src, 'f.txt'), 'x'); runGit(src, ['add', 'f.txt']); runGit(src, ['commit', '-qm', 'i']);
  // Point origin at a nonexistent path so the fetch must fail.
  runGit(src, ['remote', 'add', 'origin', join(dir, 'does-not-exist.git')]);
  const r = resolveBaseSha(src, 'main');
  assert(!r.ok && /refresh remote/.test(r.reason), `fetch failure must fail closed (got ${JSON.stringify(r)})`);
  rmSync(dir, { recursive: true, force: true });
});

test('worktrees: resolveCommitSha expands a short SHA without network', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-commit-'));
  const { src, baseSha } = makeRemoteRepo(dir);
  assert(resolveCommitSha(src, baseSha) === baseSha, 'full SHA resolves');
  assert(resolveCommitSha(src, baseSha.slice(0, 7)) === baseSha, 'short SHA expands to full');
  assert(resolveCommitSha(src, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef') === null, 'nonexistent SHA -> null');
  rmSync(dir, { recursive: true, force: true });
});

test('worktrees: worktree branch setup fails closed, never silently detaches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-fail-'));
  const src = join(dir, 'repo'); const wtRoot = join(dir, 'worktrees');
  mkdirSync(src); runGit(src, ['init', '-q']); runGit(src, ['config', 'user.email', 't@t']); runGit(src, ['config', 'user.name', 't']);
  writeFileSync(join(src, 'f.txt'), 'hi'); runGit(src, ['add', 'f.txt']); runGit(src, ['commit', '-qm', 'init']);
  const sha = runGit(src, ['rev-parse', 'HEAD']).trim();
  // Pre-create the branch WITHOUT checking it out, so `-b` fails but attach succeeds.
  runGit(src, ['branch', 'feat/existing']);
  const wt = createWorktree({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 't1', baseSha: sha, branch: 'feat/existing' });
  assert(runGit(wt, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() === 'feat/existing', 'attaches to the existing named branch, not detached');
  assert(runGit(wt, ['rev-parse', 'HEAD']).trim() === sha, 'worktree HEAD is the base commit');
  removeWorktree({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 't1' });
  rmSync(dir, { recursive: true, force: true });
});

test('worktrees: push guard blocks base-branch movement + direct base push + scope (ORCH-081/082)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-guard-'));
  const { remoteDir, src, baseSha } = makeRemoteRepo(dir);
  const wtRoot = join(dir, 'worktrees');
  const wt = createWorktree({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 't1', baseSha, branch: 'feat/1' });
  installPushGuard(wt, { workerAllowedPaths: ['*'], taskAllowedPaths: [], baseSha, baseRef: 'main' });
  assert(readFileSync(join(resolveGitDir(wt), 'sonoran/base-sha'), 'utf8').trim() === baseSha, 'base-sha file written');
  assert(readFileSync(join(resolveGitDir(wt), 'sonoran/base-ref'), 'utf8').trim() === 'main', 'base-ref file written');

  const hook = join(resolveGitDir(wt), 'hooks', 'pre-push');
  const localSha = runGit(wt, ['rev-parse', 'HEAD']).trim();
  const assertStderr = (r, needle) => assert(String(r.stderr).includes(needle), `expected "${needle}" in ${JSON.stringify(String(r.stderr))}`);

  // 1. New feature branch push with the base UNCHANGED -> allowed
  let r = spawnSync('sh', [hook], { cwd: wt, input: `refs/heads/feat/1 ${localSha} refs/heads/feat/1 ${ZERO}\n` });
  assert(r.status === 0, 'new branch allowed when base unchanged');

  // 2. Pushing directly to the base branch -> blocked (worker must stay off base)
  r = spawnSync('sh', [hook], { cwd: wt, input: `refs/heads/main ${localSha} refs/heads/main ${baseSha}\n` });
  assert(r.status !== 0, 'direct push to base branch blocked');
  assertStderr(r, 'cannot push directly to the base branch');

  // 3. A file outside the worker baseline is blocked
  writeFileSync(join(wt, 'outside.txt'), 'x');
  runGit(wt, ['add', 'outside.txt']);
  runGit(wt, ['commit', '-qm', 'outside change']);
  const localSha2 = runGit(wt, ['rev-parse', 'HEAD']).trim();
  installPushGuard(wt, { workerAllowedPaths: ['app/src/**'], taskAllowedPaths: [], baseSha, baseRef: 'main' });
  r = spawnSync('sh', [hook], { cwd: wt, input: `refs/heads/feat/1 ${localSha2} refs/heads/feat/1 ${ZERO}\n` });
  assert(r.status !== 0, 'out-of-worker-baseline file blocked');
  assertStderr(r, "outside the worker/repository baseline allowed paths");

  // 4. Move main on the remote (simulating the base moving unexpectedly)
  const newBase = advanceRemoteMain(remoteDir, dir);
  assert(newBase !== baseSha, 'remote main advanced past recorded base');

  // 5. Now a NEW feature branch push is blocked because the base moved
  r = spawnSync('sh', [hook], { cwd: wt, input: `refs/heads/feat/2 ${localSha2} refs/heads/feat/2 ${ZERO}\n` });
  assert(r.status !== 0, 'new branch blocked after base moved');
  assertStderr(r, 'base branch moved unexpectedly');

  removeWorktree({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 't1' });
  rmSync(dir, { recursive: true, force: true });
});

test('worktrees: a task can narrow but NEVER widen the worker baseline; both scopes enforced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-scope-'));
  const { src, baseSha } = makeRemoteRepo(dir);
  const wtRoot = join(dir, 'worktrees');
  const assertStderr = (r, needle) => assert(String(r.stderr).includes(needle), `expected "${needle}" in ${JSON.stringify(String(r.stderr))}`);

  const commit = (wt, rel) => { const f = join(wt, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, 'x'); runGit(wt, ['add', rel]); runGit(wt, ['commit', '-qm', 'add ' + rel]); return runGit(wt, ['rev-parse', 'HEAD']).trim(); };
  const push = (hook, wt, branch, sha) => spawnSync('sh', [hook], { cwd: wt, input: `refs/heads/${branch} ${sha} refs/heads/${branch} ${ZERO}\n` });

  // Scenario 1: file matching worker AND task scope -> allowed
  let wt = createWorktree({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 's1', baseSha, branch: 'feat-narrow' });
  installPushGuard(wt, { workerAllowedPaths: ['app/src/**'], taskAllowedPaths: ['app/src/import/**'], baseSha, baseRef: 'main' });
  let hook = join(resolveGitDir(wt), 'hooks', 'pre-push');
  let sha = commit(wt, 'app/src/import/save.js');
  let r = push(hook, wt, 'feat-narrow', sha);
  assert(r.status === 0, 'file matching worker AND task scope allowed');
  removeWorktree({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 's1' });

  // Scenario 2: file matches worker baseline but NOT task scope -> blocked
  wt = createWorktree({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 's2', baseSha, branch: 'feat-taskblock' });
  installPushGuard(wt, { workerAllowedPaths: ['app/src/**'], taskAllowedPaths: ['app/src/import/**'], baseSha, baseRef: 'main' });
  hook = join(resolveGitDir(wt), 'hooks', 'pre-push');
  sha = commit(wt, 'app/src/other.js');
  r = push(hook, wt, 'feat-taskblock', sha);
  assert(r.status !== 0, 'file outside task scope blocked');
  assertStderr(r, "outside this task's allowed paths");
  removeWorktree({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 's2' });

  // Scenario 3: task '*' must NOT widen the worker baseline -> blocked
  wt = createWorktree({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 's3', baseSha, branch: 'feat-widen' });
  installPushGuard(wt, { workerAllowedPaths: ['app/src/**'], taskAllowedPaths: ['*'], baseSha, baseRef: 'main' });
  hook = join(resolveGitDir(wt), 'hooks', 'pre-push');
  sha = commit(wt, 'router/server.mjs');
  r = push(hook, wt, 'feat-widen', sha);
  assert(r.status !== 0, 'task * cannot widen the worker baseline');
  assertStderr(r, "outside the worker/repository baseline allowed paths");
  removeWorktree({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 's3' });

  rmSync(dir, { recursive: true, force: true });
});

test('worktrees: omitted task scope means worker-baseline-only, never deny-all; stale task scope removed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-optional-scope-'));
  const { src, baseSha } = makeRemoteRepo(dir);
  const wtRoot = join(dir, 'worktrees');
  const assertStderr = (r, needle) => assert(String(r.stderr).includes(needle), `expected "${needle}" in ${JSON.stringify(String(r.stderr))}`);
  const commit = (wt, rel) => { const f = join(wt, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, 'x'); runGit(wt, ['add', rel]); runGit(wt, ['commit', '-qm', 'add ' + rel]); return runGit(wt, ['rev-parse', 'HEAD']).trim(); };
  const push = (hook, wt, branch, sha) => spawnSync('sh', [hook], { cwd: wt, input: `refs/heads/${branch} ${sha} refs/heads/${branch} ${ZERO}\n` });

  // A. worker=['app/src/**'], task scope OMITTED -> app/src/foo.js allowed (not deny-all).
  let wt = createWorktree({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 'o1', baseSha, branch: 'feat-omitted' });
  installPushGuard(wt, { workerAllowedPaths: ['app/src/**'], taskAllowedPaths: [], baseSha, baseRef: 'main' });
  assert(!existsSync(join(resolveGitDir(wt), 'sonoran/task-allowed-paths')), 'no task-scope file is written when task scope is omitted');
  let hook = join(resolveGitDir(wt), 'hooks', 'pre-push');
  let sha = commit(wt, 'app/src/foo.js');
  let r = push(hook, wt, 'feat-omitted', sha);
  assert(r.status === 0, 'A. worker-allowed change with omitted task scope is allowed');
  removeWorktree({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 'o1' });

  // B. worker=['app/src/**'], task scope OMITTED -> native/foo.cpp blocked by worker baseline.
  wt = createWorktree({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 'o2', baseSha, branch: 'feat-workerblock' });
  installPushGuard(wt, { workerAllowedPaths: ['app/src/**'], taskAllowedPaths: [], baseSha, baseRef: 'main' });
  hook = join(resolveGitDir(wt), 'hooks', 'pre-push');
  sha = commit(wt, 'native/foo.cpp');
  r = push(hook, wt, 'feat-workerblock', sha);
  assert(r.status !== 0, 'B. file outside worker baseline blocked');
  assertStderr(r, "outside the worker/repository baseline allowed paths");
  removeWorktree({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 'o2' });

  // C. a stale task-scope restriction from a prior install is removed on a later
  //    no-task-scope install, so a worker-allowed change outside the old task scope
  //    is now allowed.
  wt = createWorktree({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 'o3', baseSha, branch: 'feat-stale' });
  installPushGuard(wt, { workerAllowedPaths: ['app/src/**'], taskAllowedPaths: ['app/src/import/**'], baseSha, baseRef: 'main' });
  assert(existsSync(join(resolveGitDir(wt), 'sonoran/task-allowed-paths')), 'task scope present on first install');
  installPushGuard(wt, { workerAllowedPaths: ['app/src/**'], taskAllowedPaths: [], baseSha, baseRef: 'main' });
  assert(!existsSync(join(resolveGitDir(wt), 'sonoran/task-allowed-paths')), 'stale task-scope file removed when task scope omitted');
  hook = join(resolveGitDir(wt), 'hooks', 'pre-push');
  sha = commit(wt, 'app/src/other.js'); // within worker baseline, outside the old app/src/import/**
  r = push(hook, wt, 'feat-stale', sha);
  assert(r.status === 0, 'C. worker-allowed change allowed after stale task restriction removed');
  removeWorktree({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 'o3' });

  // D. task narrowing still applies when a task scope is present.
  wt = createWorktree({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 'o4', baseSha, branch: 'feat-stillnarrow' });
  installPushGuard(wt, { workerAllowedPaths: ['app/src/**'], taskAllowedPaths: ['app/src/import/**'], baseSha, baseRef: 'main' });
  hook = join(resolveGitDir(wt), 'hooks', 'pre-push');
  sha = commit(wt, 'app/src/other.js');
  r = push(hook, wt, 'feat-stillnarrow', sha);
  assert(r.status !== 0, 'D. task scope still narrows when present');
  assertStderr(r, "outside this task's allowed paths");
  removeWorktree({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 'o4' });

  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- retry lifecycle (ORCH-140)
test('worktrees: retry never inherits a dirty prior worktree (fresh clean state)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-retry-dirty-'));
  const { src, baseSha } = makeRemoteRepo(dir);
  const wtRoot = join(dir, 'worktrees');

  // Attempt 1: clean named worktree at the base.
  const p1 = prepareWorktreeForRun({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 't1', baseSha, branch: 'feat/25' });
  assert(p1.branch === 'feat/25' && p1.startSha === baseSha, 'attempt 1 named branch at base');
  verifyCleanWorktree(p1.path, 'feat/25', baseSha); // clean, named, non-detached

  // Simulate a failed attempt: dirty a tracked file (no commit).
  writeFileSync(join(p1.path, 'f.txt'), 'DIRTY-ATTEMPT-1');

  // Retry: must not see the dirty modification.
  const p2 = prepareWorktreeForRun({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 't1', baseSha, branch: 'feat/25' });
  assert(existsSync(p2.path) && p2.path === join(wtRoot, 't1'), 'recreated worktree path exists');
  assert(readFileSync(join(p2.path, 'f.txt'), 'utf8') === 'hello', 'retry sees committed content, not the dirty modification');

  removeWorktree({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 't1' });
  rmSync(dir, { recursive: true, force: true });
});

test('worktrees: retry reconstructs a private checkout even if the worker deletes .git', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-retry-gitdir-'));
  const { src, baseSha } = makeRemoteRepo(dir);
  const wtRoot = join(dir, 'worktrees');
  const first = prepareWorktreeForRun({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 't1', baseSha, branch: 'feat/25' });
  rmSync(join(first.path, '.git'), { recursive: true, force: true });
  writeFileSync(join(first.path, 'dirt.txt'), 'dirt');
  const second = prepareWorktreeForRun({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 't1', baseSha, branch: 'feat/25' });
  assert(runGit(second.path, ['rev-parse', 'HEAD']).trim() === baseSha, 'approved HEAD reconstructed');
  assert(!existsSync(join(second.path, 'dirt.txt')) && existsSync(join(second.path, '.git')), 'damaged checkout fully replaced');
  removeWorktree({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 't1' });
  rmSync(dir, { recursive: true, force: true });
});

test('worktrees: retry discards a local-only commit from a prior run (no auto promotion)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-retry-local-'));
  const { src, baseSha } = makeRemoteRepo(dir);
  const wtRoot = join(dir, 'worktrees');

  // Attempt 1: create a local-only commit in the worktree but do NOT push.
  let p = prepareWorktreeForRun({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 't1', baseSha, branch: 'feat/25' });
  writeFileSync(join(p.path, 'local-only.txt'), 'x');
  runGit(p.path, ['add', 'local-only.txt']);
  runGit(p.path, ['commit', '-qm', 'local-only commit']);
  const localCommit = runGit(p.path, ['rev-parse', 'HEAD']).trim();
  assert(localCommit !== baseSha, 'local-only commit advanced the branch');

  // Retry: the local-only commit must NOT become authoritative.
  p = prepareWorktreeForRun({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 't1', baseSha, branch: 'feat/25' });
  assert(runGit(p.path, ['rev-parse', 'HEAD']).trim() === baseSha, 'retry branch reset to the verified base, not the local-only commit');
  assert(!existsSync(join(p.path, 'local-only.txt')), 'local-only file is gone from the recreated worktree');

  removeWorktree({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 't1' });
  rmSync(dir, { recursive: true, force: true });
});

test('worktrees: retry uses the advanced verified base, never a stale worktree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-retry-base-'));
  const { remoteDir, src, baseSha } = makeRemoteRepo(dir);
  const wtRoot = join(dir, 'worktrees');

  // Attempt 1 at base ABC.
  let p = prepareWorktreeForRun({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 't1', baseSha, branch: 'feat/25' });
  assert(runGit(p.path, ['rev-parse', 'HEAD']).trim() === baseSha, 'attempt 1 at ABC');

  // Remote main advances to DEF; the router now resolves base = DEF.
  const newBase = advanceRemoteMain(remoteDir, dir);
  const r = resolveBaseSha(src, 'main');
  assert(r.ok && r.sha === newBase, 'resolved base is DEF');

  // Retry with base = DEF must recreate the worktree at DEF, not reuse stale ABC state.
  p = prepareWorktreeForRun({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 't1', baseSha: newBase, branch: 'feat/25' });
  assert(runGit(p.path, ['rev-parse', 'HEAD']).trim() === newBase, 'retry worktree HEAD is the new verified base DEF, not stale ABC');

  removeWorktree({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 't1' });
  rmSync(dir, { recursive: true, force: true });
});

test('worktrees: incompatible remote task branch fails closed (no auto rebase)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-retry-remote-'));
  const { remoteDir, src, baseSha } = makeRemoteRepo(dir);
  const wtRoot = join(dir, 'worktrees');

  // Attempt 1 pushes the task branch to origin based on ABC.
  const p = prepareWorktreeForRun({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 't1', baseSha, branch: 'feat/25' });
  runGit(p.path, ['commit', '--allow-empty', '-qm', 'candidate']);
  // Publication is disabled in production checkouts; this test explicitly points
  // the push URL at its temporary fixture remote to create authoritative state.
  runGit(p.path, ['remote', 'set-url', '--push', 'origin', remoteDir]);
  runGit(p.path, ['push', '-q', '-u', 'origin', 'feat/25']);

  // Remote main advances to DEF; the task branch is based on ABC and is now stale.
  const newBase = advanceRemoteMain(remoteDir, dir);
  assert(newBase !== baseSha, 'remote main advanced');
  const refreshed = resolveBaseSha(src, 'main');
  assert(refreshed.ok && refreshed.sha === newBase, 'router source refreshed before checkout preparation');

  // Retry cannot safely reconcile: it must FAIL CLOSED rather than auto-rebase/merge.
  let threw = false;
  try {
    prepareWorktreeForRun({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 't1', baseSha: newBase, branch: 'feat/25' });
  } catch (e) {
    threw = true;
    assert(/not compatible with the current base/.test(String(e.message)), `fail-closed message (got ${e.message})`);
  }
  assert(threw, 'incompatible remote task branch refuses safe recreation');

  removeWorktree({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 't1' });
  rmSync(dir, { recursive: true, force: true });
});

test('state: expired lease list + removeWorktreePath + releaseLease (ORCH-083)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-reap-'));
  const db = state.openDb(join(dir, 's.sqlite'));
  const src = join(dir, 'repo'); const wtRoot = join(dir, 'worktrees');
  mkdirSync(src); runGit(src, ['init', '-q']); runGit(src, ['config', 'user.email', 't@t']); runGit(src, ['config', 'user.name', 't']);
  writeFileSync(join(src, 'f.txt'), 'hi'); runGit(src, ['add', 'f.txt']); runGit(src, ['commit', '-qm', 'init']);
  const sha = runGit(src, ['rev-parse', 'HEAD']).trim();
  const wt = createWorktree({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 't2', baseSha: sha });

  state.createLease(db, { id: 'lease-x', taskId: 't2', worktree: wt, baseSha: sha, owner: 'codex', sourceRepo: src, expiresAt: new Date(Date.now() - 1000).toISOString() });
  const expired = state.listExpiredLeases(db, state.now());
  assert(expired.length === 1 && expired[0].id === 'lease-x', 'expired lease listed');
  assert(expired[0].source_repo === src, 'lease records source repo');

  removeWorktreePath(src, wt, dirname(wt));
  assert(!runGit(src, ['worktree', 'list']).includes('t2'), 'expired worktree removed');

  state.releaseLease(db, 'lease-x');
  assert(state.listExpiredLeases(db, state.now()).length === 0, 'released lease no longer expired');

  state.close(db); rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- injection (ORCH-058..061)
test('workers: malicious strings stay literal argv (no shell)', async () => {
  const payload = 'x; touch /tmp/sonoran-pwned; echo hi';
  const result = await runWorker(null, {
    program: 'node', args: ['-e', 'console.log(process.argv.slice(1).join("|"))', payload],
    env: process.env, cwd: routerDir, timeoutMs: 5000,
  });
  assert(result.ok, 'worker ran');
  assert(result.stdout.includes(payload), 'malicious string passed as a literal arg, not executed');
  const { existsSync } = await import('node:fs');
  assert(!existsSync('/tmp/sonoran-pwned'), 'no side effect from shell injection');
});

// ---------------------------------------------------------------- env hygiene (ORCH-094/096)
test('workers: env is allowlist-filtered, never inherited from the router (ORCH-094)', () => {
  const env = {
    PATH: '/usr/bin', HOME: '/home/dq', LANG: 'C',
    GITHUB_WEBHOOK_SECRET: 'super-secret', SLACK_WEBHOOK_URL: 'https://hooks.slack.com/secret',
  };
  const out = buildWorkerEnv({ envAllowlist: ['PATH', 'HOME'] }, { taskId: 'dualdex-25', worktree: '/wt', env });
  assert(out.PATH === '/usr/bin' && out.HOME === '/home/dq', 'allowlisted vars passed');
  assert(out.SONORAN_TASK_ID === 'dualdex-25' && out.SONORAN_WORKTREE === '/wt', 'sonoran task/worktree injected');
  assert(!('GITHUB_WEBHOOK_SECRET' in out), 'webhook secret never inherited');
  assert(!('SLACK_WEBHOOK_URL' in out) && !('LANG' in out), 'unlisted/secret vars never inherited');
  // Default allowlist when a worker does not declare one: PATH + HOME only.
  const def = buildWorkerEnv({}, { taskId: 't', env });
  assert(def.PATH === '/usr/bin' && def.HOME === '/home/dq', 'default allowlist is PATH+HOME');
  assert(!('GITHUB_WEBHOOK_SECRET' in def) && !('SLACK_WEBHOOK_URL' in def), 'default excludes router secrets');
  // A worker may opt into a specific credential it genuinely needs (e.g. the notifier).
  const notifier = buildWorkerEnv({ envAllowlist: ['PATH', 'HOME', 'SLACK_WEBHOOK_URL'] }, { taskId: '', worktree: '', env });
  assert(notifier.SLACK_WEBHOOK_URL === 'https://hooks.slack.com/secret', 'explicit worker credential allowed');
  assert(!('GITHUB_WEBHOOK_SECRET' in notifier), 'webhook secret still never allowed');
});

// ---------------------------------------------------------------- hermes repair contract (ORCH-098/099)
test('hermes: readRepairResult validates a structured result and rejects malformed/missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-hermes-'));
  const okPath = join(dir, 'ok.json');
  writeFileSync(okPath, JSON.stringify({ status: 'candidate_fix', attempt: 1 }));
  assert(readRepairResult(okPath).ok === true, 'valid result parses');
  assert(readRepairResult(okPath).data.status === 'candidate_fix', 'status read back');

  const badStatus = join(dir, 'bad.json');
  writeFileSync(badStatus, JSON.stringify({ status: 'hacked' }));
  assert(readRepairResult(badStatus).ok === false, 'unknown status rejected');

  const notJson = join(dir, 'notjson.json');
  writeFileSync(notJson, 'not json');
  assert(readRepairResult(notJson).ok === false, 'malformed JSON rejected');

  assert(readRepairResult(join(dir, 'missing.json')).ok === false, 'missing file rejected');
  rmSync(dir, { recursive: true, force: true });
});

test('hermes: repair result byte and field limits accept near-limit evidence and reject excess', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-hermes-limits-'));
  const p = join(dir, 'result.json');

  const nearLimit = {
    status: 'no_fix', attempt: 1,
    commands_executed: Array.from({ length: 30 }, (_, i) => String(i).padStart(3, '0') + ':' + 'x'.repeat(MAX_REPAIR_ARRAY_ENTRY_CHARS - 4)),
  };
  const nearRaw = JSON.stringify(nearLimit);
  assert(Buffer.byteLength(nearRaw) > 60 * 1024 && Buffer.byteLength(nearRaw) <= MAX_REPAIR_RESULT_BYTES, 'fixture is valid and near byte ceiling');
  writeFileSync(p, nearRaw);
  assert(readRepairResult(p, { expectedAttempt: 1 }).ok === true, 'valid near-limit result accepted');

  writeFileSync(p, 'x'.repeat(MAX_REPAIR_RESULT_BYTES + 1));
  const oversized = readRepairResult(p, { expectedAttempt: 1 });
  assert(!oversized.ok && /byte limit/.test(oversized.error) && !/JSON/.test(oversized.error), 'oversized file rejected before parse');

  writeFileSync(p, JSON.stringify({ status: 'no_fix', attempt: 1, files_changed: Array(MAX_REPAIR_ARRAY_ENTRIES + 1).fill('f') }));
  assert(!readRepairResult(p, { expectedAttempt: 1 }).ok, 'oversized array rejected');
  writeFileSync(p, JSON.stringify({ status: 'no_fix', attempt: 1, files_changed: ['ok', 42] }));
  assert(!readRepairResult(p, { expectedAttempt: 1 }).ok, 'non-string array element rejected');
  writeFileSync(p, JSON.stringify({ status: 'no_fix', attempt: 1, commands_executed: ['x'.repeat(MAX_REPAIR_ARRAY_ENTRY_CHARS + 1)] }));
  assert(!readRepairResult(p, { expectedAttempt: 1 }).ok, 'oversized array string rejected');
  writeFileSync(p, JSON.stringify({ status: 'no_fix', attempt: 1, summary: 'x'.repeat(MAX_REPAIR_TEXT_CHARS + 1) }));
  assert(!readRepairResult(p, { expectedAttempt: 1 }).ok, 'oversized evidence string rejected');
  writeFileSync(p, JSON.stringify({ status: 'no_fix', attempt: 1, uncertainty: null }));
  assert(!readRepairResult(p, { expectedAttempt: 1 }).ok, 'non-string evidence field rejected');

  rmSync(dir, { recursive: true, force: true });
});

test('hermes: classifyRepairResult maps status -> control-plane action (escalation terminal)', () => {
  assert(classifyRepairResult({ ok: true, data: { status: 'escalate', escalation_reason: 'API behavior' } }).action === 'escalate', 'escalate');
  assert(classifyRepairResult({ ok: true, data: { status: 'blocked', escalation_reason: 'lease invalid' } }).action === 'blocked', 'blocked');
  assert(classifyRepairResult({ ok: true, data: { status: 'candidate_fix' } }).action === 'candidate_fix', 'candidate_fix');
  assert(classifyRepairResult({ ok: true, data: { status: 'no_fix' } }).action === 'no_fix', 'no_fix');
  assert(classifyRepairResult({ ok: false, error: 'no result file' }).action === 'invalid', 'invalid read -> invalid');
  assert(isEscalationStatus('escalate') && isEscalationStatus('blocked') && !isEscalationStatus('candidate_fix'), 'escalation status set');
  assert(REPAIR_STATUSES.length === 4 && REPAIR_STATUSES.includes('no_fix'), 'status vocabulary');
});

test('hermes: attempt boundary — 3 allowed, 4 refused (ORCH-098)', () => {
  assert(DEFAULT_MAX_REPAIR_ATTEMPTS === 3, 'default max attempts is 3');
  assert(attemptExceeded(1, 3) === false && attemptExceeded(3, 3) === false, 'attempts 1..3 allowed');
  assert(attemptExceeded(4, 3) === true, 'attempt 4 refused');
});

test('hermes: result attempt must match the router-owned repair attempt (blocker 4)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-hermes-att-'));
  const p = join(dir, 'r.json');
  writeFileSync(p, JSON.stringify({ status: 'no_fix', attempt: 1 }));
  assert(readRepairResult(p, { expectedAttempt: 1 }).ok === true, 'matching attempt accepted');
  assert(readRepairResult(p, { expectedAttempt: 2 }).ok === false, 'mismatched attempt rejected');
  writeFileSync(p, JSON.stringify({ status: 'no_fix' }));
  assert(readRepairResult(p, { expectedAttempt: 1 }).ok === false, 'missing attempt rejected');
  writeFileSync(p, JSON.stringify({ status: 'no_fix', attempt: 1, files_changed: 'not-an-array' }));
  assert(readRepairResult(p, { expectedAttempt: 1 }).ok === false, 'files_changed must be an array');
  writeFileSync(p, JSON.stringify({ status: 'no_fix', attempt: 1, commands_executed: 42 }));
  assert(readRepairResult(p, { expectedAttempt: 1 }).ok === false, 'commands_executed must be an array');
  rmSync(dir, { recursive: true, force: true });
});

test('state: repair attempts count only repair runs; evidence survives SQLite reopen (blocker 3/4)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-repair-state-'));
  const dbPath = join(dir, 's.sqlite');
  let db = state.openDb(dbPath);
  state.createTask(db, { id: 'dualdex-40', repo: 'r/r', issue: '40', state: 'in_progress' });
  // Two unrelated non-repair runs (planning + implementation).
  state.createRun(db, { id: 'r1', taskId: 'dualdex-40', agent: 'codex', attempt: 1, status: 'success' });
  state.createRun(db, { id: 'r2', taskId: 'dualdex-40', agent: 'antigravity', attempt: 2, status: 'success' });
  assert(state.nextAttempt(db, 'dualdex-40') === 3, 'global attempt counts all runs');
  assert(state.nextRepairAttempt(db, 'dualdex-40') === 1, 'repair attempt ignores non-repair runs');
  // One repair run with durable structured evidence.
  state.createRun(db, { id: 'r3', taskId: 'dualdex-40', agent: 'hermes', attempt: 3, repairAttempt: 1, status: 'running' });
  state.updateRun(db, 'r3', { status: 'failed', result: JSON.stringify({ kind: 'repair', status: 'no_fix', attempt: 1, root_cause: 'first hypothesis', commands_executed: ['./ci.sh test'], uncertainty: 'low' }) });
  assert(state.nextRepairAttempt(db, 'dualdex-40') === 2, 'one repair attempt consumed so far');
  // Close + reopen: count and evidence survive.
  state.close(db);
  db = state.openDb(dbPath);
  assert(state.nextRepairAttempt(db, 'dualdex-40') === 2, 'repair count survives reopen');
  const runs = state.repairRuns(db, 'dualdex-40');
  assert(runs.length === 1 && runs[0].repair_attempt === 1 && runs[0].agent === 'hermes', 'only the repair run listed');
  assert(JSON.parse(runs[0].result).root_cause === 'first hypothesis', 'durable structured evidence survives reopen');
  state.close(db); rmSync(dir, { recursive: true, force: true });
});

test('workers: repair env injects structured SONORAN_* metadata and never leaks secrets', () => {
  const env = {
    PATH: '/usr/bin', HOME: '/home/dq', LANG: 'C',
    GITHUB_WEBHOOK_SECRET: 'super-secret', SLACK_WEBHOOK_URL: 'https://hooks.slack.com/secret',
  };
  const meta = {
    RUN_ID: 'run-1', LEASE_ID: 'lease-1', REPO: 'Sonoran-Solutions/dualdex', BRANCH: 'fix/1',
    BASE_SHA: 'abc', ATTEMPT: '2', MAX_ATTEMPTS: '3', ALLOWED_PATHS: 'app/src/**\nnative/**',
    TASK_PATHS: 'app/src/import/**', BUILD_CMD: './ci.sh test', RESULT_FILE: '/wt/.sonoran-repair-result.json',
  };
  const out = buildWorkerEnv({ envAllowlist: ['PATH', 'HOME'] }, { taskId: 'dualdex-25', worktree: '/wt', env, meta });
  assert(out.SONORAN_TASK_ID === 'dualdex-25' && out.SONORAN_WORKTREE === '/wt', 'task/worktree injected');
  assert(out.SONORAN_RUN_ID === 'run-1' && out.SONORAN_LEASE_ID === 'lease-1', 'run/lease identifiers injected');
  assert(out.SONORAN_ATTEMPT === '2' && out.SONORAN_MAX_ATTEMPTS === '3', 'attempt state injected');
  assert(out.SONORAN_ALLOWED_PATHS === 'app/src/**\nnative/**' && out.SONORAN_TASK_PATHS === 'app/src/import/**', 'allowed/task paths injected');
  assert(out.SONORAN_BASE_SHA === 'abc' && out.SONORAN_BRANCH === 'fix/1' && out.SONORAN_BUILD_CMD === './ci.sh test', 'base/branch/build injected');
  assert(out.SONORAN_RESULT_FILE === '/wt/.sonoran-repair-result.json', 'result file path injected');
  assert(!('GITHUB_WEBHOOK_SECRET' in out) && !('SLACK_WEBHOOK_URL' in out) && !('LANG' in out), 'router secrets + unlisted vars never inherited');
});

test('config: fixture gates and lease lifetime fail closed at startup', () => {
  const worker = { createsTask: true, repair: true, timeoutMs: 20000, sandboxedTestFixture: true };
  assertThrows(
    () => validateConfig({ devMode: false, testFixtures: false, leaseDurationMs: 60000, workers: { hermes: worker } }),
    /test fixtures require devMode=true and testFixtures=true/,
    'production config rejects sandboxed fixture behavior',
  );
  assertThrows(
    () => validateConfig({ devMode: true, testFixtures: true, leaseDurationMs: 32000, workers: { hermes: worker } }),
    /leaseDurationMs must exceed worker timeout/,
    'lease must exceed worker timeout plus kill grace and safety margin',
  );
  validateConfig({ devMode: true, testFixtures: true, leaseDurationMs: 60000, workers: { hermes: worker } });
});

// ---------------------------------------------------------------- integration (HTTP)
async function httpRequest(port, { method = 'POST', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        let parsed = {};
        try { parsed = data ? JSON.parse(data) : {}; } catch { parsed = { raw: data }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
function sign(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

test('integration: full control-plane flow', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-int-'));
  const port = 8237;
  const SECRET = 'test-secret';
  const cfg = {
    port, devMode: false, bodyLimitBytes: 65536, defaultTimeoutMs: 20000, maxConcurrency: 2,
    githubSecretEnv: 'GITHUB_WEBHOOK_SECRET', slackWebhookEnv: 'SLACK_WEBHOOK_URL',
    stateDb: join(dir, 'state.sqlite'), reposRoot: join(dir, 'repos'), worktreeRoot: join(dir, 'worktrees'),
    defaultBaseRef: 'main',
    allowlist: ['trusted-user'], requireLabel: 'agent:ready',
    workers: {
      notify: { program: '../slack-notify/slack-notify.sh', args: ['pr-ready', '{{task}}', '--link', '{{link}}'], envAllowlist: ['PATH', 'HOME', 'DRY_RUN'] },
      codex: { program: 'node', args: ['-e', 'console.log("codex-ran")'], createsTask: true, allowedPaths: ['*'], envAllowlist: ['PATH', 'HOME'] },
    },
    rules: [
      { id: 'pr-opened-notify', when: { events: ['pull_request'], actions: ['opened'] }, worker: 'notify', authorize: 'trusted' },
      { id: 'codex-on-ready-label', when: { events: ['issues'], actions: ['labeled'] }, worker: 'codex', authorize: 'label' },
    ],
  };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg));
  const child = spawn('node', ['server.mjs'], {
    cwd: routerDir,
    env: { ...process.env, CONFIG_PATH: join(dir, 'config.json'), GITHUB_WEBHOOK_SECRET: SECRET, SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/REPLACE_WITH_REAL_TOKEN', DRY_RUN: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stderr.on('data', (d) => (logs += d));
  try {
    await waitFor(() => httpRequest(port, { method: 'GET', path: '/health' }).then((r) => r.status === 200), 4000);

    // health
    const health = await httpRequest(port, { method: 'GET', path: '/health' });
    assert(health.status === 200 && health.body.secretConfigured === true, 'health');

    // unsigned -> 401
    const unsigned = await httpRequest(port, { headers: { 'X-GitHub-Event': 'issues' }, body: '{}' });
    assert(unsigned.status === 401, 'unsigned rejected');

    // signed unknown event -> no match
    const unknownBody = JSON.stringify({ action: 'created', sender: { login: 'trusted-user' }, repository: { full_name: 'r/r' } });
    const unknown = await httpRequest(port, { headers: { 'X-GitHub-Event': 'fork', 'X-GitHub-Delivery': 'd-unknown', 'X-Hub-Signature-256': sign(SECRET, unknownBody) }, body: unknownBody });
    assert(unknown.status === 200 && unknown.body.matched === false, 'unknown event no match');

    // signed PR opened by untrusted actor -> 403
    const prUntrusted = JSON.stringify({ action: 'opened', sender: { login: 'mallory' }, repository: { full_name: 'r/r' }, pull_request: { number: 1, title: 'x', head: { ref: 'feat/1' } } });
    const r1 = await httpRequest(port, { headers: { 'X-GitHub-Event': 'pull_request', 'X-GitHub-Delivery': 'd-pr1', 'X-Hub-Signature-256': sign(SECRET, prUntrusted) }, body: prUntrusted });
    assert(r1.status === 403, 'untrusted actor rejected');

    // A valid HMAC does not waive the production delivery-ID requirement. This
    // rejection happens before recording/deduplication or worker dispatch.
    const beforeMissing = new DatabaseSync(join(dir, 'state.sqlite'), { readOnly: true });
    const deliveryCountBefore = beforeMissing.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n;
    beforeMissing.close();
    const missingDelivery = await httpRequest(port, { headers: { 'X-GitHub-Event': 'pull_request', 'X-Hub-Signature-256': sign(SECRET, prUntrusted) }, body: prUntrusted });
    assert(missingDelivery.status === 400 && missingDelivery.body.error === 'missing X-GitHub-Delivery', 'signed production request without delivery ID rejected');
    const afterMissing = new DatabaseSync(join(dir, 'state.sqlite'), { readOnly: true });
    const deliveryCountAfter = afterMissing.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n;
    afterMissing.close();
    assert(deliveryCountAfter === deliveryCountBefore, 'missing delivery ID caused no delivery record or dispatch');

    // signed PR opened by trusted actor -> notify dispatch (DRY_RUN)
    const prTrusted = JSON.stringify({ action: 'opened', sender: { login: 'trusted-user' }, repository: { full_name: 'Sonoran-Solutions/dualdex' }, pull_request: { number: 7, title: 'Add profile', head: { ref: 'feat/7' } } });
    const r2 = await httpRequest(port, { headers: { 'X-GitHub-Event': 'pull_request', 'X-GitHub-Delivery': 'd-pr2', 'X-Hub-Signature-256': sign(SECRET, prTrusted) }, body: prTrusted });
    assert(r2.status === 200 && r2.body.matched === true && r2.body.ok === true, `notify dispatched: ${JSON.stringify(r2.body)}`);

    // duplicate delivery -> deduplicated
    const r3 = await httpRequest(port, { headers: { 'X-GitHub-Event': 'pull_request', 'X-GitHub-Delivery': 'd-pr2', 'X-Hub-Signature-256': sign(SECRET, prTrusted) }, body: prTrusted });
    assert(r3.status === 200 && r3.body.deduplicated === true, 'duplicate deduped');

    // labeled + trusted + label, but NO valid envelope -> 422 (handoff gate)
    const labelBody = JSON.stringify({ action: 'labeled', sender: { login: 'trusted-user' }, repository: { full_name: 'r/r' }, label: { name: 'agent:ready' }, issue: { number: 9, title: 'T', body: 'no envelope here', labels: [{ name: 'agent:ready' }] } });
    const r4 = await httpRequest(port, { headers: { 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': 'd-label1', 'X-Hub-Signature-256': sign(SECRET, labelBody) }, body: labelBody });
    assert(r4.status === 422 && r4.body.reason === 'invalid handoff envelope', `envelope gate: ${JSON.stringify(r4.body)}`);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('close', r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('integration: missing delivery ID escape hatch exists only in explicit dev mode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-dev-delivery-'));
  const port = 8247;
  const cfg = {
    port, devMode: true, bodyLimitBytes: 65536, defaultTimeoutMs: 20000, maxConcurrency: 1,
    githubSecretEnv: 'GITHUB_WEBHOOK_SECRET', slackWebhookEnv: 'SLACK_WEBHOOK_URL',
    stateDb: join(dir, 'state.sqlite'), reposRoot: join(dir, 'repos'), worktreeRoot: join(dir, 'worktrees'),
    reapIntervalMs: 0, leaseDurationMs: 86400000,
    allowlist: ['trusted-user'], requireLabel: 'agent:ready',
    workers: { fixture: { program: 'node', args: ['-e', 'process.exit(0)'], envAllowlist: ['PATH', 'HOME'] } },
    rules: [{ id: 'dev-fixture', when: { events: ['issues'], actions: ['opened'] }, worker: 'fixture', authorize: 'trusted' }],
  };
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify(cfg));
  const child = spawn('node', ['server.mjs'], {
    cwd: routerDir,
    env: { ...process.env, CONFIG_PATH: configPath, GITHUB_WEBHOOK_SECRET: '', SLACK_WEBHOOK_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  try {
    await waitFor(() => httpRequest(port, { method: 'GET', path: '/health' }).then((r) => r.status === 200), 4000);
    const body = JSON.stringify({ action: 'opened', sender: { login: 'trusted-user' }, repository: { full_name: 'r/r' }, issue: { number: 1, title: 'dev', body: '' } });
    const response = await httpRequest(port, { headers: { 'X-GitHub-Event': 'issues' }, body });
    assert(response.status === 200 && response.body.ok === true, `explicit dev request without delivery ID processed: ${JSON.stringify(response.body)}`);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.on('close', resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('integration: valid issues:labeled code task honors lifecycle + resolves live base + creates clean named worktree (offline)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-int-code-'));
  const port = 8241;
  const SECRET = 'test-secret';
  const repoSlug = 'Sonoran-Solutions/dualdex';
  const remoteBase = join(dir, 'git-remote');
  const bareRepo = join(remoteBase, repoSlug) + '.git';
  // A temporary local bare repo stands in for GitHub, so the whole flow is offline.
  mkdirSync(dirname(bareRepo), { recursive: true });
  spawnSync('git', ['init', '--bare', '--quiet', bareRepo], { cwd: dir }).status === 0 || assert(false, 'bare repo init');
  const seed = join(dir, 'seed');
  mkdirSync(seed);
  runGit(seed, ['init', '-q']);
  runGit(seed, ['config', 'user.email', 't@t']);
  runGit(seed, ['config', 'user.name', 't']);
  runGit(seed, ['remote', 'add', 'origin', bareRepo]);
  writeFileSync(join(seed, 'f.txt'), 'hello');
  runGit(seed, ['add', 'f.txt']);
  runGit(seed, ['commit', '-qm', 'init']);
  runGit(seed, ['branch', '-M', 'main']);
  runGit(seed, ['push', '-q', '-u', 'origin', 'main']);
  spawnSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: bareRepo }).status === 0 || assert(false, 'set bare HEAD');
  const baseSha = runGit(seed, ['rev-parse', 'HEAD']).trim();
  assert(/^[0-9a-f]{40}$/.test(baseSha), 'seeded base SHA is full length');

  const cfg = {
    port, devMode: false, bodyLimitBytes: 65536, defaultTimeoutMs: 20000, maxConcurrency: 2,
    githubSecretEnv: 'GITHUB_WEBHOOK_SECRET', slackWebhookEnv: 'SLACK_WEBHOOK_URL',
    stateDb: join(dir, 'state.sqlite'), reposRoot: join(dir, 'repos'), worktreeRoot: join(dir, 'worktrees'),
    repoBase: remoteBase, defaultBaseRef: 'main', reapIntervalMs: 0, leaseDurationMs: 86400000,
    allowlist: ['trusted-user'], requireLabel: 'agent:ready',
    workers: {
      codex: { program: 'node', args: ['-e', 'console.log("codex-ran")'], createsTask: true, allowedPaths: ['app/src/**', 'native/**'], envAllowlist: ['PATH', 'HOME'] },
    },
    rules: [
      { id: 'codex-on-ready-label', when: { events: ['issues'], actions: ['labeled'] }, worker: 'codex', authorize: 'label' },
    ],
  };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg));
  const child = spawn('node', ['server.mjs'], {
    cwd: routerDir,
    env: { ...process.env, CONFIG_PATH: join(dir, 'config.json'), GITHUB_WEBHOOK_SECRET: SECRET, SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/REPLACE_WITH_REAL_TOKEN', DRY_RUN: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  try {
    await waitFor(() => httpRequest(port, { method: 'GET', path: '/health' }).then((r) => r.status === 200), 6000);

    // Correct lifecycle for a brand-new task: planned (preferred initial state).
    const envelope = `---
schema_version: 1
agent: hermes
to: codex
repo: sonoran-solutions/dualdex
issue: "25"
branch: feat/25
base_sha: ${baseSha}
state: planned
allowed_paths:
  - app/src/import/**
task: Fix the thing
acceptance: |
  test passes
---`;
    const issueBody = JSON.stringify({
      action: 'labeled',
      sender: { login: 'trusted-user' },
      repository: { full_name: repoSlug },
      label: { name: 'agent:ready' },
      issue: { number: 25, title: 'Fix the thing', body: envelope, labels: [{ name: 'agent:ready' }] },
    });
    const res = await httpRequest(port, { headers: { 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': 'd-code-1', 'X-Hub-Signature-256': sign(SECRET, issueBody) }, body: issueBody });
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.matched === true && res.body.ok === true, `code task dispatched: ${JSON.stringify(res.body)}`);
    assert(res.body.taskId === 'dualdex-25', `task id present: ${res.body.taskId}`);
    assert(res.body.worktree, 'worktree path returned');

    const wt = res.body.worktree;
    // Correct lifecycle accepted; clean named worktree at the verified base.
    const br = runGit(wt, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    assert(br === 'feat/25', `named task branch created (got ${br})`);
    assert(runGit(wt, ['rev-parse', 'HEAD']).trim() === baseSha, 'worktree HEAD is the verified base SHA');
    // The router writes .sonoran-* metadata into the worktree; those are expected.
    const status = runGit(wt, ['status', '--porcelain']).split('\n').filter((l) => l && !/\.sonoran-/.test(l)).join('\n');
    assert(status === '', 'worktree is clean at launch (ignoring router metadata files)');
    assert(readFileSync(join(resolveGitDir(wt), 'sonoran/base-sha'), 'utf8').trim() === baseSha, 'push guard records the verified base SHA');
    assert(readFileSync(join(resolveGitDir(wt), 'sonoran/base-ref'), 'utf8').trim() === 'main', 'push guard records the base ref');
    // Path policy: worker baseline AND task scope are both installed independently.
    assert(readFileSync(join(resolveGitDir(wt), 'sonoran/worker-allowed-paths'), 'utf8').trim() === 'app/src/**\nnative/**', 'worker baseline written');
    assert(readFileSync(join(resolveGitDir(wt), 'sonoran/task-allowed-paths'), 'utf8').trim() === 'app/src/import/**', 'task scope written');

    // Negative: a brand-new task (issue 26) declaring an illegal initial state is refused.
    const badEnvelope = `---
schema_version: 1
agent: hermes
to: codex
repo: sonoran-solutions/dualdex
issue: "26"
branch: feat/26
state: in_progress
task: Bad lifecycle
acceptance: |
  nope
---`;
    const badBody = JSON.stringify({
      action: 'labeled',
      sender: { login: 'trusted-user' },
      repository: { full_name: repoSlug },
      label: { name: 'agent:ready' },
      issue: { number: 26, title: 'Bad', body: badEnvelope, labels: [{ name: 'agent:ready' }] },
    });
    const bad = await httpRequest(port, { headers: { 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': 'd-code-2', 'X-Hub-Signature-256': sign(SECRET, badBody) }, body: badBody });
    assert(bad.status === 422 && bad.body.reason === 'invalid initial task state', `new-task lifecycle gate: ${JSON.stringify(bad.body)}`);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('close', r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('integration: PR context refuses an envelope whose branch does not match the PR head (offline)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-int-pr-'));
  const port = 8242;
  const SECRET = 'test-secret';
  const repoSlug = 'Sonoran-Solutions/dualdex';
  const remoteBase = join(dir, 'git-remote');
  const bareRepo = join(remoteBase, repoSlug) + '.git';
  mkdirSync(dirname(bareRepo), { recursive: true });
  spawnSync('git', ['init', '--bare', '--quiet', bareRepo], { cwd: dir }).status === 0 || assert(false, 'bare repo init');
  const seed = join(dir, 'seed');
  mkdirSync(seed);
  runGit(seed, ['init', '-q']);
  runGit(seed, ['config', 'user.email', 't@t']);
  runGit(seed, ['config', 'user.name', 't']);
  runGit(seed, ['remote', 'add', 'origin', bareRepo]);
  writeFileSync(join(seed, 'f.txt'), 'hello');
  runGit(seed, ['add', 'f.txt']);
  runGit(seed, ['commit', '-qm', 'init']);
  runGit(seed, ['branch', '-M', 'main']);
  runGit(seed, ['push', '-q', '-u', 'origin', 'main']);
  spawnSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: bareRepo }).status === 0 || assert(false, 'set bare HEAD');
  const baseSha = runGit(seed, ['rev-parse', 'HEAD']).trim();

  const cfg = {
    port, devMode: false, bodyLimitBytes: 65536, defaultTimeoutMs: 20000, maxConcurrency: 2,
    githubSecretEnv: 'GITHUB_WEBHOOK_SECRET', slackWebhookEnv: 'SLACK_WEBHOOK_URL',
    stateDb: join(dir, 'state.sqlite'), reposRoot: join(dir, 'repos'), worktreeRoot: join(dir, 'worktrees'),
    repoBase: remoteBase, defaultBaseRef: 'main', reapIntervalMs: 0, leaseDurationMs: 86400000,
    allowlist: ['trusted-user'], requireLabel: 'agent:ready',
    workers: {
      codex: { program: 'node', args: ['-e', 'console.log("codex-ran")'], createsTask: true, allowedPaths: ['app/src/**'], envAllowlist: ['PATH', 'HOME'] },
    },
    rules: [
      { id: 'codex-on-ready-label', when: { events: ['pull_request'], actions: ['labeled'] }, worker: 'codex', authorize: 'label' },
    ],
  };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg));
  const child = spawn('node', ['server.mjs'], {
    cwd: routerDir,
    env: { ...process.env, CONFIG_PATH: join(dir, 'config.json'), GITHUB_WEBHOOK_SECRET: SECRET, SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/REPLACE_WITH_REAL_TOKEN', DRY_RUN: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  try {
    await waitFor(() => httpRequest(port, { method: 'GET', path: '/health' }).then((r) => r.status === 200), 6000);

    // PR head ref = feat/real, but the envelope claims a different task branch.
    const envelope = `---
schema_version: 1
agent: hermes
to: codex
repo: sonoran-solutions/dualdex
issue: "7"
branch: feat/something-else
base_sha: ${baseSha}
state: planned
task: Fix
acceptance: |
  ok
---`;
    const body = JSON.stringify({
      action: 'labeled',
      sender: { login: 'trusted-user' },
      repository: { full_name: repoSlug },
      label: { name: 'agent:ready' },
      pull_request: { number: 7, title: 'Fix', body: envelope, labels: [{ name: 'agent:ready' }], head: { ref: 'feat/real', sha: baseSha }, base: { ref: 'main', sha: baseSha } },
    });
    const res = await httpRequest(port, { headers: { 'X-GitHub-Event': 'pull_request', 'X-GitHub-Delivery': 'd-pr-code', 'X-Hub-Signature-256': sign(SECRET, body) }, body });
    assert(res.status === 422 && res.body.reason === 'envelope does not match event context', `PR branch mismatch refused: ${JSON.stringify(res.body)}`);
    assert(JSON.stringify(res.body.errors).includes('does not match event branch'), 'errors mention branch mismatch');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('close', r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('integration: a second delivery during a LIVE execution is refused; the live worker is untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-concurrent-'));
  const port = 8243;
  const SECRET = 'test-secret';
  const repoSlug = 'Sonoran-Solutions/dualdex';
  const remoteBase = join(dir, 'git-remote');
  const bareRepo = join(remoteBase, repoSlug) + '.git';
  mkdirSync(dirname(bareRepo), { recursive: true });
  spawnSync('git', ['init', '--bare', '--quiet', bareRepo], { cwd: dir }).status === 0 || assert(false, 'bare init');
  const seed = join(dir, 'seed');
  mkdirSync(seed);
  runGit(seed, ['init', '-q']);
  runGit(seed, ['config', 'user.email', 't@t']);
  runGit(seed, ['config', 'user.name', 't']);
  runGit(seed, ['remote', 'add', 'origin', bareRepo]);
  writeFileSync(join(seed, 'f.txt'), 'hello');
  runGit(seed, ['add', 'f.txt']);
  runGit(seed, ['commit', '-qm', 'init']);
  runGit(seed, ['branch', '-M', 'main']);
  runGit(seed, ['push', '-q', '-u', 'origin', 'main']);
  spawnSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: bareRepo }).status === 0 || assert(false, 'set bare HEAD');
  const baseSha = runGit(seed, ['rev-parse', 'HEAD']).trim();

  const cfg = {
    port, devMode: true, testFixtures: true, bodyLimitBytes: 65536, defaultTimeoutMs: 20000, maxConcurrency: 4,
    githubSecretEnv: 'GITHUB_WEBHOOK_SECRET', slackWebhookEnv: 'SLACK_WEBHOOK_URL',
    stateDb: join(dir, 'state.sqlite'), reposRoot: join(dir, 'repos'), worktreeRoot: join(dir, 'worktrees'),
    repoBase: remoteBase, defaultBaseRef: 'main', reapIntervalMs: 0, leaseDurationMs: 86400000,
    allowlist: ['trusted-user'], requireLabel: 'agent:ready',
    workers: {
      // A worker that stays alive long enough for a second delivery to arrive.
      codex: { program: 'node', args: ['-e', 'setTimeout(()=>process.exit(0), 3000)'], createsTask: true, allowedPaths: ['app/src/**'], envAllowlist: ['PATH', 'HOME'] },
    },
    rules: [{ id: 'codex-on-ready-label', when: { events: ['issues'], actions: ['labeled'] }, worker: 'codex', authorize: 'label' }],
  };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg));
  const child = spawn('node', ['server.mjs'], { cwd: routerDir, env: { ...process.env, CONFIG_PATH: join(dir, 'config.json'), GITHUB_WEBHOOK_SECRET: SECRET, SLACK_WEBHOOK_URL: 'https://hooks.slack.com/x', DRY_RUN: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});
  const mkEnv = (state) => `---
schema_version: 1
agent: hermes
to: codex
repo: sonoran-solutions/dualdex
issue: "25"
branch: feat/25
base_sha: ${baseSha}
state: ${state}
task: Fix the thing
acceptance: |
  test passes
---`;
  const mkBody = (state, delivery) => JSON.stringify({
    action: 'labeled', sender: { login: 'trusted-user' }, repository: { full_name: repoSlug },
    label: { name: 'agent:ready' }, issue: { number: 25, title: 'Fix', body: mkEnv(state), labels: [{ name: 'agent:ready' }] },
  });
  try {
    await waitFor(() => httpRequest(port, { method: 'GET', path: '/health' }).then((r) => r.status === 200), 6000);

    // 1. First delivery starts a long-lived worker; issue the request WITHOUT awaiting.
    const firstBody = mkBody('planned', 'd-live-1');
    const firstReq = httpRequest(port, { headers: { 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': 'd-live-1', 'X-Hub-Signature-256': sign(SECRET, firstBody) }, body: firstBody });

    // 2. Wait until the first execution is in progress (router inFlight >= 1).
    await waitFor(() => httpRequest(port, { method: 'GET', path: '/health' }).then((r) => r.body.inFlight >= 1), 5000);

    // 3. A second delivery (different delivery id) while the worker is LIVE -> REFUSED.
    const secondBody = mkBody('in_progress', 'd-live-2');
    const second = await httpRequest(port, { headers: { 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': 'd-live-2', 'X-Hub-Signature-256': sign(SECRET, secondBody) }, body: secondBody });
    assert(second.status === 422 && second.body.refusal === true && /active execution/.test(second.body.reason), `second delivery refused: ${JSON.stringify(second.body)}`);

    // 4. The first worker continues and completes normally.
    const first = await firstReq;
    assert(first.status === 200 && first.body.ok === true, `first worker completed normally: ${JSON.stringify(first.body)}`);
    const firstWorktree = first.body.worktree;
    assert(firstWorktree, 'first response has a worktree');

    // 5. The live worker's worktree was NOT removed/reconstructed by the refused second.
    assert(existsSync(firstWorktree), 'live worker worktree still exists after refused second delivery');

    // 6. After the worker finishes (no live execution), a legal retry can proceed.
    const thirdBody = mkBody('in_progress', 'd-live-3');
    const third = await httpRequest(port, { headers: { 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': 'd-live-3', 'X-Hub-Signature-256': sign(SECRET, thirdBody) }, body: thirdBody });
    assert(third.status === 200 && third.body.ok === true, `legal retry after completion proceeded: ${JSON.stringify(third.body)}`);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('close', r));
    // DB assertions after the server is down: exactly the first + third runs exist
    // (the refused second delivery created none), and exactly one active lease.
    const rdb = new DatabaseSync(join(dir, 'state.sqlite'), { readOnly: true });
    const runs = rdb.prepare('SELECT * FROM runs WHERE task_id = ?').all('dualdex-25');
    const activeLeases = rdb.prepare("SELECT * FROM leases WHERE task_id = ? AND status = 'active'").all('dualdex-25');
    rdb.close();
    assert(runs.length === 2, `exactly 2 runs (first + retry); the refused second created none (got ${runs.length})`);
    assert(runs.some((r) => r.status === 'success'), 'completed run recorded as success');
    assert(activeLeases.length === 0, `completed runs release leases (got ${activeLeases.length})`);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- hermes repair integration (ORCH-096..099)
// Build a FAKE Hermes executable (a node script, no live model/API) that dumps its
// environment and writes a structured result file, so the plumbing is testable.
function writeFakeHermes(dir, { result = null, rawResult = null, echoAttempt = true, exitCode = 0 } = {}) {
  const resultLiteral = result === null ? 'null' : JSON.stringify(result);
  const rawResultLiteral = rawResult === null ? 'null' : JSON.stringify(rawResult);
  const fixture = `import { writeFileSync } from 'node:fs';
const env = process.env;
writeFileSync(${JSON.stringify(join(dir, 'env-dump.json'))}, JSON.stringify({
  worktree: env.SONORAN_WORKTREE || null,
  task: env.SONORAN_TASK_ID || null,
  run: env.SONORAN_RUN_ID || null,
  lease: env.SONORAN_LEASE_ID || null,
  repo: env.SONORAN_REPO || null,
  branch: env.SONORAN_BRANCH || null,
  baseSha: env.SONORAN_BASE_SHA || null,
  attempt: env.SONORAN_ATTEMPT || null,
  maxAttempts: env.SONORAN_MAX_ATTEMPTS || null,
  allowedPaths: env.SONORAN_ALLOWED_PATHS || null,
  taskPaths: env.SONORAN_TASK_PATHS || null,
  buildCmd: env.SONORAN_BUILD_CMD || null,
  resultFile: env.SONORAN_RESULT_FILE || null,
  hasWebhookSecret: ('GITHUB_WEBHOOK_SECRET' in env),
  hasSlack: ('SLACK_WEBHOOK_URL' in env),
}));
const rawResult = ${rawResultLiteral};
const r = ${resultLiteral};
if (rawResult !== null && env.SONORAN_RESULT_FILE) {
  writeFileSync(env.SONORAN_RESULT_FILE, rawResult);
} else if (r) {
  // Echo the router-owned repair attempt unless a negative test preserves a mismatch.
  if (${echoAttempt} && env.SONORAN_ATTEMPT) r.attempt = Number(env.SONORAN_ATTEMPT);
  if (env.SONORAN_RESULT_FILE) writeFileSync(env.SONORAN_RESULT_FILE, JSON.stringify(r));
}
process.exit(${exitCode});
`;
  const p = join(dir, 'hermes-fake.mjs');
  writeFileSync(p, fixture);
  return p;
}

async function startHermesRouter(dir, port, hermesWorker) {
  const repoSlug = 'Sonoran-Solutions/dualdex';
  const remoteBase = join(dir, 'git-remote');
  const bareRepo = join(remoteBase, repoSlug) + '.git';
  mkdirSync(dirname(bareRepo), { recursive: true });
  spawnSync('git', ['init', '--bare', '--quiet', bareRepo], { cwd: dir }).status === 0 || assert(false, 'bare init');
  const seed = join(dir, 'seed');
  mkdirSync(seed);
  runGit(seed, ['init', '-q']);
  runGit(seed, ['config', 'user.email', 't@t']);
  runGit(seed, ['config', 'user.name', 't']);
  runGit(seed, ['remote', 'add', 'origin', bareRepo]);
  writeFileSync(join(seed, 'f.txt'), 'hello');
  runGit(seed, ['add', 'f.txt']);
  runGit(seed, ['commit', '-qm', 'init']);
  runGit(seed, ['branch', '-M', 'main']);
  runGit(seed, ['push', '-q', '-u', 'origin', 'main']);
  spawnSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: bareRepo }).status === 0 || assert(false, 'bare HEAD');
  const baseSha = runGit(seed, ['rev-parse', 'HEAD']).trim();
  const cfg = {
    port, devMode: true, testFixtures: true, bodyLimitBytes: 65536, defaultTimeoutMs: 20000, maxConcurrency: 4,
    githubSecretEnv: 'GITHUB_WEBHOOK_SECRET', slackWebhookEnv: 'SLACK_WEBHOOK_URL',
    stateDb: join(dir, 'state.sqlite'), reposRoot: join(dir, 'repos'), worktreeRoot: join(dir, 'worktrees'),
    repoBase: remoteBase, defaultBaseRef: 'main', reapIntervalMs: 0, leaseDurationMs: 86400000,
    allowlist: ['trusted-user'], requireLabel: 'agent:ready',
    workers: { hermes: { ...hermesWorker, testFixture: true } },
    rules: [{ id: 'hermes-repair', when: { events: ['issues'], actions: ['labeled'] }, worker: 'hermes', authorize: 'label' }],
  };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg));
  const child = spawn('node', ['server.mjs'], { cwd: routerDir, env: { ...process.env, CONFIG_PATH: join(dir, 'config.json'), GITHUB_WEBHOOK_SECRET: 'test-secret', SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/SECRET', DRY_RUN: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});
  await waitFor(() => httpRequest(port, { method: 'GET', path: '/health' }).then((r) => r.status === 200), 6000);
  return { repoSlug, baseSha, child };
}

function hermesEnvelope(baseSha, state = 'planned') {
  return `---
schema_version: 1
agent: hermes
to: codex
repo: sonoran-solutions/dualdex
issue: "40"
branch: fix/40
base_sha: ${baseSha}
state: ${state}
allowed_paths:
  - app/src/import/**
task: Repair the build
acceptance: |
  ./ci.sh test passes
---`;
}
function hermesIssueBody(repoSlug, baseSha, state, delivery) {
  return JSON.stringify({
    action: 'labeled', sender: { login: 'trusted-user' }, repository: { full_name: repoSlug },
    label: { name: 'agent:ready' }, issue: { number: 40, title: 'Repair', body: hermesEnvelope(baseSha, state), labels: [{ name: 'agent:ready' }] },
  });
}

function hermesLabeledBody(repoSlug, baseSha, state, { actor = 'trusted-user', label = 'agent:ready' } = {}) {
  return JSON.stringify({
    action: 'labeled', sender: { login: actor }, repository: { full_name: repoSlug },
    label: { name: label },
    issue: {
      number: 40,
      title: 'Repair',
      body: hermesEnvelope(baseSha, state),
      labels: [{ name: 'agent:ready' }, ...(label === 'agent:ready' ? [] : [{ name: label }])],
    },
  });
}

test('integration: hermes repair receives the worktree + full structured context, never router secrets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-hermes-ctx-'));
  const port = 8251;
  const fixture = writeFakeHermes(dir, { result: { status: 'no_fix', attempt: 1 }, exitCode: 0 });
  const { repoSlug, baseSha, child } = await startHermesRouter(dir, port, { program: 'node', args: [fixture], repair: true, maxAttempts: 3, buildCmd: './ci.sh test', allowedPaths: ['app/src/**', 'native/**'], envAllowlist: ['PATH', 'HOME'] });
  try {
    const body = hermesIssueBody(repoSlug, baseSha, 'planned', 'd-hctx-1');
    const res = await httpRequest(port, { headers: { 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': 'd-hctx-1', 'X-Hub-Signature-256': sign('test-secret', body) }, body });
    assert(res.status === 200 && res.body.ok === true, `hermes dispatched: ${JSON.stringify(res.body)}`);
    assert(res.body.repairAction === 'no_fix', `structured result interpreted: ${JSON.stringify(res.body)}`);
    const dump = JSON.parse(readFileSync(join(dir, 'env-dump.json'), 'utf8'));
    assert(dump.worktree && dump.worktree !== join(dir, 'repos'), `worktree passed, not repo root (got ${dump.worktree})`);
    assert(dump.task === 'dualdex-40' && dump.run && dump.lease, 'task/run/lease identifiers present');
    assert(dump.allowedPaths === 'app/src/**\nnative/**', 'worker baseline paths included');
    assert(dump.taskPaths === 'app/src/import/**', 'task scope paths included');
    assert(dump.baseSha === baseSha && dump.branch === 'fix/40' && dump.buildCmd === './ci.sh test', 'base/branch/build passed');
    assert(dump.attempt === '1' && dump.maxAttempts === '3', 'attempt state passed');
    assert(dump.hasWebhookSecret === false && dump.hasSlack === false, 'router secrets excluded from worker env');
    assert(dump.resultFile && !dump.resultFile.includes('.sonoran-repair-result.json') && dump.resultFile.endsWith('/repair-result.json'), 'result file uses external run state');
  } finally {
    child.kill('SIGTERM'); await new Promise((r) => child.on('close', r)); rmSync(dir, { recursive: true, force: true });
  }
});

test('integration: hermes attempt limit allows 1..3 and refuses attempt 4 without launching', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-hermes-attempt-'));
  const port = 8252;
  const fixture = writeFakeHermes(dir, { result: { status: 'no_fix', attempt: 1 }, exitCode: 0 });
  const { repoSlug, baseSha, child } = await startHermesRouter(dir, port, { program: 'node', args: [fixture], repair: true, maxAttempts: 3, allowedPaths: ['app/src/**'], envAllowlist: ['PATH', 'HOME'] });
  try {
    for (let i = 1; i <= 3; i++) {
      const body = hermesIssueBody(repoSlug, baseSha, i === 1 ? 'planned' : 'in_progress', `d-hatt-${i}`);
      const res = await httpRequest(port, { headers: { 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': `d-hatt-${i}`, 'X-Hub-Signature-256': sign('test-secret', body) }, body });
      assert(res.status === 200 && res.body.ok === true, `attempt ${i} allowed: ${JSON.stringify(res.body)}`);
    }
    const body4 = hermesIssueBody(repoSlug, baseSha, 'in_progress', 'd-hatt-4');
    const res4 = await httpRequest(port, { headers: { 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': 'd-hatt-4', 'X-Hub-Signature-256': sign('test-secret', body4) }, body: body4 });
    assert(res4.status === 422 && res4.body.refusal === true && /attempt limit reached/.test(res4.body.reason), `attempt 4 refused: ${JSON.stringify(res4.body)}`);
    const retryBody = hermesLabeledBody(repoSlug, baseSha, 'escalated', { label: 'repair:retry' });
    const retry = await httpRequest(port, { headers: { 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': 'd-hatt-retry', 'X-Hub-Signature-256': sign('test-secret', retryBody) }, body: retryBody });
    assert(retry.status === 422 && retry.body.refusal === true && /attempt limit reached/.test(retry.body.reason), `trusted repair:retry cannot create attempt 4: ${JSON.stringify(retry.body)}`);
    const rdb = new DatabaseSync(join(dir, 'state.sqlite'), { readOnly: true });
    const runs = rdb.prepare('SELECT * FROM runs WHERE task_id = ?').all('dualdex-40');
    rdb.close();
    assert(runs.length === 3, `exactly 3 runs, no fourth launch (got ${runs.length})`);
  } finally {
    child.kill('SIGTERM'); await new Promise((r) => child.on('close', r)); rmSync(dir, { recursive: true, force: true });
  }
});

test('integration: hermes escalate result stops the autonomous repair loop (API/schema/security decisions)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-hermes-escalate-'));
  const port = 8253;
  const fixture = writeFakeHermes(dir, { result: { status: 'escalate', escalation_reason: 'requires public API behavior decision' }, exitCode: 0 });
  const { repoSlug, baseSha, child } = await startHermesRouter(dir, port, { program: 'node', args: [fixture], repair: true, maxAttempts: 3, allowedPaths: ['app/src/**'], envAllowlist: ['PATH', 'HOME'] });
  try {
    const body1 = hermesIssueBody(repoSlug, baseSha, 'planned', 'd-hesc-1');
    const res1 = await httpRequest(port, { headers: { 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': 'd-hesc-1', 'X-Hub-Signature-256': sign('test-secret', body1) }, body: body1 });
    assert(res1.status === 200 && res1.body.ok === true && res1.body.repairAction === 'escalate', `escalate run completes: ${JSON.stringify(res1.body)}`);
    // A subsequent automatic dispatch must be refused (escalation is terminal for the loop).
    const body2 = hermesIssueBody(repoSlug, baseSha, 'escalated', 'd-hesc-2');
    const res2 = await httpRequest(port, { headers: { 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': 'd-hesc-2', 'X-Hub-Signature-256': sign('test-secret', body2) }, body: body2 });
    assert(res2.status === 422 && res2.body.refusal === true && /escalated/.test(res2.body.reason), `escalation stops further repair: ${JSON.stringify(res2.body)}`);
    const rdb = new DatabaseSync(join(dir, 'state.sqlite'), { readOnly: true });
    const runs = rdb.prepare('SELECT * FROM runs WHERE task_id = ?').all('dualdex-40');
    const task = rdb.prepare('SELECT state FROM tasks WHERE id = ?').get('dualdex-40');
    rdb.close();
    assert(runs.length === 1, `only the escalate run exists (got ${runs.length})`);
    assert(task.state === 'escalated', `task state escalated (got ${task.state})`);
  } finally {
    child.kill('SIGTERM'); await new Promise((r) => child.on('close', r)); rmSync(dir, { recursive: true, force: true });
  }
});

test('integration: hermes blocked result (invalid worktree/lease) refuses further repair', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-hermes-blocked-'));
  const port = 8254;
  const fixture = writeFakeHermes(dir, { result: { status: 'blocked', escalation_reason: 'worktree base does not match lease' }, exitCode: 0 });
  const { repoSlug, baseSha, child } = await startHermesRouter(dir, port, { program: 'node', args: [fixture], repair: true, maxAttempts: 3, allowedPaths: ['app/src/**'], envAllowlist: ['PATH', 'HOME'] });
  try {
    const body1 = hermesIssueBody(repoSlug, baseSha, 'planned', 'd-hblk-1');
    const res1 = await httpRequest(port, { headers: { 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': 'd-hblk-1', 'X-Hub-Signature-256': sign('test-secret', body1) }, body: body1 });
    assert(res1.status === 200 && res1.body.repairAction === 'blocked', `blocked run completes: ${JSON.stringify(res1.body)}`);
    const body2 = hermesIssueBody(repoSlug, baseSha, 'blocked', 'd-hblk-2');
    const res2 = await httpRequest(port, { headers: { 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': 'd-hblk-2', 'X-Hub-Signature-256': sign('test-secret', body2) }, body: body2 });
    assert(res2.status === 422 && /blocked/.test(res2.body.reason), `blocked task refuses further repair: ${JSON.stringify(res2.body)}`);
  } finally {
    child.kill('SIGTERM'); await new Promise((r) => child.on('close', r)); rmSync(dir, { recursive: true, force: true });
  }
});

test('integration: repair:retry requires a trusted current event and matching terminal state', async () => {
  const escalatedDir = mkdtempSync(join(tmpdir(), 'sonoran-hermes-reauth-escalated-'));
  const escalatedFixture = writeFakeHermes(escalatedDir, { result: { status: 'escalate', escalation_reason: 'human decision required' } });
  const escalatedRouter = await startHermesRouter(escalatedDir, 8271, { program: 'node', args: [escalatedFixture], repair: true, maxAttempts: 3, allowedPaths: ['app/src/**'], envAllowlist: ['PATH', 'HOME'] });
  try {
    const firstBody = hermesLabeledBody(escalatedRouter.repoSlug, escalatedRouter.baseSha, 'planned');
    const first = await httpRequest(8271, { headers: { 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': 'd-reauth-escalate', 'X-Hub-Signature-256': sign('test-secret', firstBody) }, body: firstBody });
    assert(first.status === 200 && first.body.repairAction === 'escalate', 'fixture established persisted escalated state');

    const ordinaryBody = hermesLabeledBody(escalatedRouter.repoSlug, escalatedRouter.baseSha, 'escalated');
    const ordinary = await httpRequest(8271, { headers: { 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': 'd-reauth-ordinary', 'X-Hub-Signature-256': sign('test-secret', ordinaryBody) }, body: ordinaryBody });
    assert(ordinary.status === 422 && /human re-authorization/.test(ordinary.body.reason), `ordinary automatic event refused: ${JSON.stringify(ordinary.body)}`);

    const untrustedBody = hermesLabeledBody(escalatedRouter.repoSlug, escalatedRouter.baseSha, 'escalated', { actor: 'mallory', label: 'repair:retry' });
    const untrusted = await httpRequest(8271, { headers: { 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': 'd-reauth-untrusted', 'X-Hub-Signature-256': sign('test-secret', untrustedBody) }, body: untrustedBody });
    assert(untrusted.status === 403 && untrusted.body.authorized === false, 'untrusted repair:retry actor refused');

    const mismatchBody = hermesLabeledBody(escalatedRouter.repoSlug, escalatedRouter.baseSha, 'blocked', { label: 'repair:retry' });
    const mismatch = await httpRequest(8271, { headers: { 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': 'd-reauth-mismatch', 'X-Hub-Signature-256': sign('test-secret', mismatchBody) }, body: mismatchBody });
    assert(mismatch.status === 422 && /does not match persisted/.test(JSON.stringify(mismatch.body)), 'persisted/envelope mismatch refused');

    const trustedBody = hermesLabeledBody(escalatedRouter.repoSlug, escalatedRouter.baseSha, 'escalated', { label: 'repair:retry' });
    const trusted = await httpRequest(8271, { headers: { 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': 'd-reauth-trusted', 'X-Hub-Signature-256': sign('test-secret', trustedBody) }, body: trustedBody });
    assert(trusted.status === 200 && trusted.body.ok === true && trusted.body.repairAttempt === 2, `trusted matching repair:retry allowed: ${JSON.stringify(trusted.body)}`);
    const db = new DatabaseSync(join(escalatedDir, 'state.sqlite'), { readOnly: true });
    const runs = db.prepare('SELECT * FROM runs WHERE task_id = ?').all('dualdex-40');
    db.close();
    assert(runs.length === 2, `only initial + trusted retry launched (got ${runs.length})`);
  } finally {
    escalatedRouter.child.kill('SIGTERM');
    await new Promise((resolve) => escalatedRouter.child.on('close', resolve));
    rmSync(escalatedDir, { recursive: true, force: true });
  }

  const blockedDir = mkdtempSync(join(tmpdir(), 'sonoran-hermes-reauth-blocked-'));
  const blockedFixture = writeFakeHermes(blockedDir, { result: { status: 'blocked', escalation_reason: 'human input required' } });
  const blockedRouter = await startHermesRouter(blockedDir, 8272, { program: 'node', args: [blockedFixture], repair: true, maxAttempts: 3, allowedPaths: ['app/src/**'], envAllowlist: ['PATH', 'HOME'] });
  try {
    const firstBody = hermesLabeledBody(blockedRouter.repoSlug, blockedRouter.baseSha, 'planned');
    const first = await httpRequest(8272, { headers: { 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': 'd-reauth-blocked', 'X-Hub-Signature-256': sign('test-secret', firstBody) }, body: firstBody });
    assert(first.status === 200 && first.body.repairAction === 'blocked', 'fixture established persisted blocked state');
    const retryBody = hermesLabeledBody(blockedRouter.repoSlug, blockedRouter.baseSha, 'blocked', { label: 'repair:retry' });
    const retry = await httpRequest(8272, { headers: { 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': 'd-reauth-blocked-retry', 'X-Hub-Signature-256': sign('test-secret', retryBody) }, body: retryBody });
    assert(retry.status === 200 && retry.body.ok === true && retry.body.repairAttempt === 2, `trusted blocked repair:retry allowed: ${JSON.stringify(retry.body)}`);
  } finally {
    blockedRouter.child.kill('SIGTERM');
    await new Promise((resolve) => blockedRouter.child.on('close', resolve));
    rmSync(blockedDir, { recursive: true, force: true });
  }
});

test('integration: hermes nonzero exit produces a durable failed run, never a fake success', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-hermes-fail-'));
  const port = 8255;
  const fixture = writeFakeHermes(dir, { result: null, exitCode: 7 }); // crashes, writes no result
  const { repoSlug, baseSha, child } = await startHermesRouter(dir, port, { program: 'node', args: [fixture], repair: true, maxAttempts: 3, allowedPaths: ['app/src/**'], envAllowlist: ['PATH', 'HOME'] });
  try {
    const body1 = hermesIssueBody(repoSlug, baseSha, 'planned', 'd-hfail-1');
    const res1 = await httpRequest(port, { headers: { 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': 'd-hfail-1', 'X-Hub-Signature-256': sign('test-secret', body1) }, body: body1 });
    assert(res1.status === 200 && res1.body.ok === false, `failed worker reported non-ok: ${JSON.stringify(res1.body)}`);
    const rdb = new DatabaseSync(join(dir, 'state.sqlite'), { readOnly: true });
    const run = rdb.prepare('SELECT status FROM runs WHERE task_id = ?').get('dualdex-40');
    const task = rdb.prepare('SELECT state FROM tasks WHERE id = ?').get('dualdex-40');
    rdb.close();
    assert(run.status === 'failed', `run recorded as failed (got ${run.status})`);
    assert(task.state === 'in_progress', `failed attempt stays retryable (got ${task.state})`);
  } finally {
    child.kill('SIGTERM'); await new Promise((r) => child.on('close', r)); rmSync(dir, { recursive: true, force: true });
  }
});

test('integration: process exit 0 plus invalid repair evidence always fails closed', async () => {
  const cases = [
    { name: 'missing', options: { result: null, exitCode: 0 } },
    { name: 'malformed', options: { rawResult: 'not json', exitCode: 0 } },
    { name: 'oversized', options: { rawResult: 'x'.repeat(MAX_REPAIR_RESULT_BYTES + 1), exitCode: 0 } },
    { name: 'mismatched', options: { result: { status: 'candidate_fix', attempt: 99 }, echoAttempt: false, exitCode: 0 } },
  ];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const dir = mkdtempSync(join(tmpdir(), 'sonoran-hermes-invalid-' + c.name + '-'));
    const port = 8258 + i;
    const fixture = writeFakeHermes(dir, c.options);
    const { repoSlug, baseSha, child } = await startHermesRouter(dir, port, { program: 'node', args: [fixture], repair: true, maxAttempts: 3, allowedPaths: ['app/src/**'], envAllowlist: ['PATH', 'HOME'] });
    try {
      const body = hermesIssueBody(repoSlug, baseSha, 'planned', 'd-hinvalid-' + c.name);
      const res = await httpRequest(port, { headers: { 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': 'd-hinvalid-' + c.name, 'X-Hub-Signature-256': sign('test-secret', body) }, body });
      assert(res.status === 200 && res.body.ok === false && res.body.repairAction === 'invalid', c.name + ' evidence must report invalid/non-ok: ' + JSON.stringify(res.body));
      const rdb = new DatabaseSync(join(dir, 'state.sqlite'), { readOnly: true });
      const run = rdb.prepare('SELECT status, result FROM runs WHERE task_id = ?').get('dualdex-40');
      const task = rdb.prepare('SELECT state FROM tasks WHERE id = ?').get('dualdex-40');
      rdb.close();
      const record = JSON.parse(run.result);
      assert(run.status === 'failed' && record.action === 'invalid' && record.error, c.name + ' evidence recorded as failed/invalid');
      assert(task.state === 'in_progress', c.name + ' invalid attempt remains retryable');
    } finally {
      child.kill('SIGTERM'); await new Promise((r) => child.on('close', r));
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('integration: non-repair runs do not consume the Hermes repair budget (ORCH-098)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-hermes-budget-'));
  const port = 8256;
  const repoSlug = 'Sonoran-Solutions/dualdex';
  const remoteBase = join(dir, 'git-remote');
  const bareRepo = join(remoteBase, repoSlug) + '.git';
  mkdirSync(dirname(bareRepo), { recursive: true });
  spawnSync('git', ['init', '--bare', '--quiet', bareRepo], { cwd: dir }).status === 0 || assert(false, 'bare init');
  const seed = join(dir, 'seed');
  mkdirSync(seed);
  runGit(seed, ['init', '-q']); runGit(seed, ['config', 'user.email', 't@t']); runGit(seed, ['config', 'user.name', 't']);
  runGit(seed, ['remote', 'add', 'origin', bareRepo]);
  writeFileSync(join(seed, 'f.txt'), 'hello'); runGit(seed, ['add', 'f.txt']); runGit(seed, ['commit', '-qm', 'init']);
  runGit(seed, ['branch', '-M', 'main']); runGit(seed, ['push', '-q', '-u', 'origin', 'main']);
  spawnSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: bareRepo }).status === 0 || assert(false, 'bare HEAD');
  const baseSha = runGit(seed, ['rev-parse', 'HEAD']).trim();

  const hermesFixture = writeFakeHermes(dir, { result: { status: 'no_fix' }, exitCode: 0 });
  const cfg = {
    port, devMode: true, testFixtures: true, bodyLimitBytes: 65536, defaultTimeoutMs: 20000, maxConcurrency: 4,
    githubSecretEnv: 'GITHUB_WEBHOOK_SECRET', slackWebhookEnv: 'SLACK_WEBHOOK_URL',
    stateDb: join(dir, 'state.sqlite'), reposRoot: join(dir, 'repos'), worktreeRoot: join(dir, 'worktrees'),
    repoBase: remoteBase, defaultBaseRef: 'main', reapIntervalMs: 0, leaseDurationMs: 86400000,
    allowlist: ['trusted-user'], requireLabel: 'agent:ready',
    workers: {
      codex: { program: 'node', args: ['-e', 'process.exit(0)'], createsTask: true, allowedPaths: ['app/src/**'], envAllowlist: ['PATH', 'HOME'] },
      hermes: { program: 'node', args: [hermesFixture], repair: true, testFixture: true, maxAttempts: 3, allowedPaths: ['app/src/**'], envAllowlist: ['PATH', 'HOME'] },
    },
    rules: [
      { id: 'hermes-repair', when: { events: ['issues'], actions: ['labeled'], labels: ['agent:ready', 'repair'] }, worker: 'hermes', authorize: 'label' },
      { id: 'codex-impl', when: { events: ['issues'], actions: ['labeled'] }, worker: 'codex', authorize: 'label' },
    ],
  };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg));
  const child = spawn('node', ['server.mjs'], { cwd: routerDir, env: { ...process.env, CONFIG_PATH: join(dir, 'config.json'), GITHUB_WEBHOOK_SECRET: 'test-secret', SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/SECRET' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});
  const mkEnv = (agent, state) => `---
schema_version: 1
agent: ${agent}
to: codex
repo: sonoran-solutions/dualdex
issue: "40"
branch: fix/40
base_sha: ${baseSha}
state: ${state}
task: Repair
acceptance: |
  ./ci.sh test passes
---`;
  const mkBody = (agent, state, labels, delivery) => JSON.stringify({
    action: 'labeled', sender: { login: 'trusted-user' }, repository: { full_name: repoSlug },
    label: { name: 'agent:ready' }, issue: { number: 40, title: 'T', body: mkEnv(agent, state), labels },
  });
  try {
    await waitFor(() => httpRequest(port, { method: 'GET', path: '/health' }).then((r) => r.status === 200), 6000);
    // Two non-repair (codex) runs on the same task.
    for (const [state, d] of [['planned', 'd-b1'], ['in_progress', 'd-b2']]) {
      const body = mkBody('codex', state, [{ name: 'agent:ready' }], d);
      const res = await httpRequest(port, { headers: { 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': d, 'X-Hub-Signature-256': sign('test-secret', body) }, body });
      assert(res.status === 200 && res.body.ok === true, `codex run allowed: ${JSON.stringify(res.body)}`);
    }
    // Hermes repairs 1..3 are allowed under a repair-specific budget.
    for (let i = 1; i <= 3; i++) {
      const body = mkBody('hermes', 'in_progress', [{ name: 'agent:ready' }, { name: 'repair' }], `d-rep-${i}`);
      const res = await httpRequest(port, { headers: { 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': `d-rep-${i}`, 'X-Hub-Signature-256': sign('test-secret', body) }, body });
      assert(res.status === 200 && res.body.ok === true && res.body.repairAttempt === i, `hermes repair ${i} allowed (repairAttempt ${i}): ${JSON.stringify(res.body)}`);
    }
    const body4 = mkBody('hermes', 'in_progress', [{ name: 'agent:ready' }, { name: 'repair' }], 'd-rep-4');
    const res4 = await httpRequest(port, { headers: { 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': 'd-rep-4', 'X-Hub-Signature-256': sign('test-secret', body4) }, body: body4 });
    assert(res4.status === 422 && res4.body.refusal === true && /attempt limit reached/.test(res4.body.reason), `repair 4 refused: ${JSON.stringify(res4.body)}`);
  } finally {
    child.kill('SIGTERM'); await new Promise((r) => child.on('close', r));
    const rdb = new DatabaseSync(join(dir, 'state.sqlite'), { readOnly: true });
    const allRuns = rdb.prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY attempt ASC').all('dualdex-40');
    rdb.close();
    const repairRuns = allRuns.filter((r) => r.repair_attempt != null);
    const nonRepairRuns = allRuns.filter((r) => r.repair_attempt == null);
    assert(nonRepairRuns.length === 2, `2 non-repair runs (got ${nonRepairRuns.length})`);
    assert(repairRuns.length === 3, `exactly 3 repair runs (got ${repairRuns.length})`);
    assert(repairRuns.map((r) => r.repair_attempt).join(',') === '1,2,3', `repair attempts are 1,2,3 (got ${repairRuns.map((r) => r.repair_attempt)})`);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('integration: structured repair evidence persists after worktree reconstruction (blocker 4)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-hermes-evidence-'));
  const port = 8257;
  const fixture = writeFakeHermes(dir, { result: { status: 'no_fix', root_cause: 'first hypothesis', commands_executed: ['./ci.sh test'], uncertainty: 'low' }, exitCode: 0 });
  const { repoSlug, baseSha, child } = await startHermesRouter(dir, port, { program: 'node', args: [fixture], repair: true, maxAttempts: 3, allowedPaths: ['app/src/**'], envAllowlist: ['PATH', 'HOME'] });
  try {
    // Attempt 1: no_fix with structured evidence.
    const body1 = hermesIssueBody(repoSlug, baseSha, 'planned', 'd-hev-1');
    const res1 = await httpRequest(port, { headers: { 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': 'd-hev-1', 'X-Hub-Signature-256': sign('test-secret', body1) }, body: body1 });
    assert(res1.status === 200 && res1.body.ok === true && res1.body.repairAttempt === 1, `attempt 1 dispatched: ${JSON.stringify(res1.body)}`);
    // Attempt 2 reconstructs the worktree (destroying attempt 1's result file).
    const body2 = hermesIssueBody(repoSlug, baseSha, 'in_progress', 'd-hev-2');
    const res2 = await httpRequest(port, { headers: { 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': 'd-hev-2', 'X-Hub-Signature-256': sign('test-secret', body2) }, body: body2 });
    assert(res2.status === 200 && res2.body.ok === true && res2.body.repairAttempt === 2, `attempt 2 dispatched: ${JSON.stringify(res2.body)}`);
  } finally {
    child.kill('SIGTERM'); await new Promise((r) => child.on('close', r));
    const rdb = new DatabaseSync(join(dir, 'state.sqlite'), { readOnly: true });
    const runs = rdb.prepare('SELECT * FROM runs WHERE task_id = ? AND repair_attempt IS NOT NULL ORDER BY repair_attempt ASC').all('dualdex-40');
    rdb.close();
    assert(runs.length === 2, `two repair runs persisted (got ${runs.length})`);
    const first = JSON.parse(runs[0].result);
    assert(first.kind === 'repair' && first.status === 'no_fix', 'attempt 1 record is a structured repair record');
    assert(first.root_cause === 'first hypothesis' && Array.isArray(first.commands_executed) && first.uncertainty === 'low', 'attempt 1 structured evidence survived worktree reconstruction');
    assert(first.attempt === 1 && runs[1].repair_attempt === 2, 'attempts recorded as 1 and 2');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('audit remediation: verifier sandbox exploit regression', () => { execFileSync(process.execPath, [join(routerDir, 'repair-verify.test.mjs')], { stdio: 'ignore' }); });

test('integration: real router -> production sandbox -> verifier boundary (F-09)', () => {
  execFileSync(process.execPath, [join(routerDir, 'real-sandbox-fixture.test.mjs')], { stdio: 'inherit' });
});

test('audit remediation: matcher and task containment contracts', () => {
  assert(pathMatches('app/src/a.js', ['app/src/**']), 'recursive matcher accepts direct child');
  assert(pathMatches('app/src/deep/a.js', ['app/src/**']), 'recursive matcher accepts deep child');
  assert(pathMatches('foo/bar.js', ['foo/**/bar.js']), 'double-star accepts zero segments');
  assert(pathMatches('foo/a/bar.js', ['foo/**/bar.js']), 'double-star accepts one segment');
  assert(pathMatches('foo/a/b/bar.js', ['foo/**/bar.js']), 'double-star accepts many segments');
  assert(pathMatches('README.md', ['*.md']) && !pathMatches('docs/README.md', ['*.md']), 'star is root-level for root pattern');
  assert(makeTaskId('org/repo', 3) === 'repo-3');
  const throws = (fn) => { let did = false; try { fn(); } catch { did = true; } assert(did, 'expected rejection'); };
  for (const bad of ['../../foo', '../foo', 'foo/bar', 'foo\\bar', '.', '..', '']) throws(() => containedPath('/tmp/root', bad));
  throws(() => makeTaskId('org/repo', Number.MAX_SAFE_INTEGER + 1));
});

async function waitFor(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await fn()) return; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('timed out waiting for condition');
}

(async () => {
  for (const t of tests) {
    try { await t.fn(); console.log(`PASS  ${t.name}`); passed++; }
    catch (e) { console.log(`FAIL  ${t.name}\n      ${e.message}`); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
