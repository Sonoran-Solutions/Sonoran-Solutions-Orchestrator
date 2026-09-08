// router/test.mjs — Sonoran control-plane tests. Run: node test.mjs
import { parseEnvelope, legalTransition } from './lib/handoff.mjs';
import { authorize } from './lib/auth.mjs';
import { normalize } from './lib/events.mjs';
import { interpolateArgs, runWorker, buildWorkerEnv } from './lib/workers.mjs';
import * as state from './lib/state.mjs';
import { runGit, createWorktree, removeWorktree, installPushGuard, resolveGitDir, removeWorktreePath, safeBranchName } from './lib/worktrees.mjs';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const routerDir = dirname(fileURLToPath(import.meta.url));
let passed = 0; let failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

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
  assert(!legalTransition('done', 'in_progress'), 'done->in_progress illegal');
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

// ---------------------------------------------------------------- worktrees
test('worktrees: create + remove an isolated worktree on a named branch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-wt-'));
  const src = join(dir, 'repo'); const wtRoot = join(dir, 'worktrees');
  mkdirSync(src); runGit(src, ['init', '-q']); runGit(src, ['config', 'user.email', 't@t']); runGit(src, ['config', 'user.name', 't']);
  writeFileSync(join(src, 'f.txt'), 'hello'); runGit(src, ['add', 'f.txt']); runGit(src, ['commit', '-qm', 'init']);
  const sha = runGit(src, ['rev-parse', 'HEAD']).trim();
  const wt = createWorktree({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 'task-1', baseSha: sha, branch: 'feat/1' });
  assert(wt.endsWith('task-1'), 'worktree path');
  assert(runGit(src, ['worktree', 'list']).includes('task-1'), 'worktree listed');
  const br = runGit(wt, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  assert(br === 'feat/1', `named task branch created (got ${br})`);
  removeWorktree({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 'task-1' });
  assert(!runGit(src, ['worktree', 'list']).includes('task-1'), 'worktree removed');
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

test('worktrees: push guard blocks base-branch movement + direct base push + scope (ORCH-081/082)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-guard-'));
  const { remoteDir, src, baseSha } = makeRemoteRepo(dir);
  const wtRoot = join(dir, 'worktrees');
  const wt = createWorktree({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 't1', baseSha, branch: 'feat/1' });
  installPushGuard(wt, { allowedPaths: ['*'], baseSha, baseRef: 'main' });
  assert(readFileSync(join(wt, '.sonoran-base-sha'), 'utf8').trim() === baseSha, 'base-sha file written');
  assert(readFileSync(join(wt, '.sonoran-base-ref'), 'utf8').trim() === 'main', 'base-ref file written');

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

  // 3. Allow-paths gate: an out-of-scope file is blocked (while the base is unchanged)
  writeFileSync(join(wt, 'outside.txt'), 'x');
  runGit(wt, ['add', 'outside.txt']);
  runGit(wt, ['commit', '-qm', 'outside change']);
  const localSha2 = runGit(wt, ['rev-parse', 'HEAD']).trim();
  installPushGuard(wt, { allowedPaths: ['app/src/**'], baseSha, baseRef: 'main' });
  r = spawnSync('sh', [hook], { cwd: wt, input: `refs/heads/feat/1 ${localSha2} refs/heads/feat/1 ${ZERO}\n` });
  assert(r.status !== 0, 'out-of-scope file blocked');
  assertStderr(r, "outside this task's allowed paths");

  // 4. Move main on the remote (simulating the base moving unexpectedly)
  const peer = join(dir, 'peer');
  spawnSync('git', ['clone', '-q', '-b', 'main', remoteDir, peer], { cwd: dir }).status === 0 || assert(false, 'peer clone');
  git(peer, ['config', 'user.email', 't@t']);
  git(peer, ['config', 'user.name', 't']);
  writeFileSync(join(peer, 'g.txt'), 'x');
  git(peer, ['add', 'g.txt']);
  git(peer, ['commit', '-qm', 'move base']);
  git(peer, ['push', '-q', 'origin', 'main']);
  const newBase = git(src, ['ls-remote', 'origin', 'refs/heads/main']).split('\t')[0].trim();
  assert(newBase !== baseSha, 'remote main advanced past recorded base');

  // 5. Now a NEW feature branch push is blocked because the base moved
  r = spawnSync('sh', [hook], { cwd: wt, input: `refs/heads/feat/2 ${localSha2} refs/heads/feat/2 ${ZERO}\n` });
  assert(r.status !== 0, 'new branch blocked after base moved');
  assertStderr(r, 'base branch moved unexpectedly');

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

  removeWorktreePath(src, wt);
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
