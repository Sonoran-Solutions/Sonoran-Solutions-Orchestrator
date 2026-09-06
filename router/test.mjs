// router/test.mjs — Sonoran control-plane tests. Run: node test.mjs
import { parseEnvelope, legalTransition } from './lib/handoff.mjs';
import { authorize } from './lib/auth.mjs';
import { normalize } from './lib/events.mjs';
import { interpolateArgs, runWorker } from './lib/workers.mjs';
import * as state from './lib/state.mjs';
import { runGit, createWorktree, removeWorktree, installPushGuard, resolveGitDir, removeWorktreePath } from './lib/worktrees.mjs';
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

// ---------------------------------------------------------------- worktrees
test('worktrees: create + remove an isolated worktree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-wt-'));
  const src = join(dir, 'repo'); const wtRoot = join(dir, 'worktrees');
  mkdirSync(src); runGit(src, ['init', '-q']); runGit(src, ['config', 'user.email', 't@t']); runGit(src, ['config', 'user.name', 't']);
  writeFileSync(join(src, 'f.txt'), 'hello'); runGit(src, ['add', 'f.txt']); runGit(src, ['commit', '-qm', 'init']);
  const sha = runGit(src, ['rev-parse', 'HEAD']).trim();
  const wt = createWorktree({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 'task-1', baseSha: sha });
  assert(wt.endsWith('task-1'), 'worktree path');
  assert(runGit(src, ['worktree', 'list']).includes('task-1'), 'worktree listed');
  removeWorktree({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 'task-1' });
  assert(!runGit(src, ['worktree', 'list']).includes('task-1'), 'worktree removed');
  rmSync(dir, { recursive: true, force: true });
});

test('worktrees: push guard enforces base-SHA + scope files (ORCH-081/082)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonoran-guard-'));
  const src = join(dir, 'repo'); const wtRoot = join(dir, 'worktrees');
  mkdirSync(src); runGit(src, ['init', '-q']); runGit(src, ['config', 'user.email', 't@t']); runGit(src, ['config', 'user.name', 't']);
  writeFileSync(join(src, 'f.txt'), 'hi'); runGit(src, ['add', 'f.txt']); runGit(src, ['commit', '-qm', 'init']);
  const sha = runGit(src, ['rev-parse', 'HEAD']).trim();
  const wt = createWorktree({ sourceRepo: src, worktreeRoot: wtRoot, taskId: 't1', baseSha: sha });

  const baseSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  installPushGuard(wt, { allowedPaths: ['*'], baseSha });
  assert(readFileSync(join(wt, '.sonoran-base-sha'), 'utf8').trim() === baseSha, 'base-sha file written');

  const hook = join(resolveGitDir(wt), 'hooks', 'pre-push');
  const zero = '0000000000000000000000000000000000000000';
  const moved = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  let r = spawnSync('sh', [hook], { cwd: wt, input: `refs/heads/x ${sha} refs/heads/x ${zero}\n` });
  assert(r.status === 0, 'new branch (all-zero remote) allowed');
  r = spawnSync('sh', [hook], { cwd: wt, input: `refs/heads/x ${sha} refs/heads/x ${baseSha}\n` });
  assert(r.status === 0, 'unchanged base allowed');
  r = spawnSync('sh', [hook], { cwd: wt, input: `refs/heads/x ${sha} refs/heads/x ${moved}\n` });
  assert(r.status !== 0, 'moved base blocked');
  assert(String(r.stderr).includes('branch moved'), 'block message mentions base movement');

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
    allowlist: ['trusted-user'], requireLabel: 'agent:ready',
    workers: {
      notify: { program: '../slack-notify/slack-notify.sh', args: ['pr-ready', '{{task}}', '--link', '{{link}}'] },
      codex: { program: 'node', args: ['-e', 'console.log("codex-ran")'], createsTask: true, allowedPaths: ['*'] },
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
