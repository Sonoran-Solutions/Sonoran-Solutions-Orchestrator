import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const routerDir = dirname(fileURLToPath(import.meta.url));
const fixedRunStateRoot = '/home/dq/.local/state/sonoran-orchestrator/runs';
const fixedRunHomeRoot = '/home/dq/.hermes-sandbox/runs';
const fixtureLauncher = join(routerDir, '..', 'hermes-watch', 'run-repair-fixture-sandboxed');
const deploySkill = join(routerDir, '..', 'hermes-watch', 'deploy-fix-build-skill.sh');

function git(cwd, args, options = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}

function request(port, body, delivery) {
  const signature = 'sha256=' + crypto.createHmac('sha256', 'fixture-secret').update(body).digest('hex');
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/',
      headers: {
        'X-GitHub-Event': 'issues',
        'X-GitHub-Delivery': delivery,
        'X-Hub-Signature-256': signature,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function waitForHealth(port, child, logs) {
  for (let i = 0; i < 150; i++) {
    if (child.exitCode != null) throw new Error(`router exited before health check: ${logs()}`);
    try {
      const ok = await new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/health' }, (res) => {
          res.resume(); resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
      });
      if (ok) return;
    } catch { /* retry until bounded deadline */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`router health check timed out: ${logs()}`);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function seedRemote(dir) {
  const repoSlug = 'Sonoran-Solutions/dualdex';
  const remoteBase = join(dir, 'git-remote');
  const bareRepo = join(remoteBase, repoSlug) + '.git';
  const seed = join(dir, 'seed');
  mkdirSync(dirname(bareRepo), { recursive: true });
  spawnSync('git', ['init', '--bare', '--quiet', bareRepo], { cwd: dir }).status === 0 || assert.fail('bare init');
  mkdirSync(seed);
  git(seed, ['init', '--quiet']);
  git(seed, ['config', 'user.name', 'Fixture Seed']);
  git(seed, ['config', 'user.email', 'fixture@example.invalid']);
  mkdirSync(join(seed, 'app', 'src', 'import'), { recursive: true });
  writeFileSync(join(seed, 'app', 'src', 'import', 'base.txt'), 'base\n');
  writeFileSync(join(seed, 'README.md'), 'fixture repository\n');
  git(seed, ['add', '.']);
  git(seed, ['commit', '--quiet', '-m', 'base']);
  git(seed, ['branch', '-M', 'main']);
  git(seed, ['remote', 'add', 'origin', bareRepo]);
  git(seed, ['push', '--quiet', '-u', 'origin', 'main']);
  git(bareRepo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  return { repoSlug, remoteBase, bareRepo, baseSha: git(seed, ['rev-parse', 'HEAD']) };
}

function eventBody(repoSlug, baseSha) {
  const envelope = `---
schema_version: 1
agent: hermes
to: codex
repo: ${repoSlug.toLowerCase()}
issue: "90"
branch: fix/90-real-sandbox
base_sha: ${baseSha}
state: planned
allowed_paths:
  - app/src/import/**
task: Deterministic real sandbox fixture
acceptance: |
  Router verifies the committed candidate.
---`;
  return JSON.stringify({
    action: 'labeled',
    sender: { login: 'trusted-user' },
    repository: { full_name: repoSlug },
    label: { name: 'agent:ready' },
    issue: {
      number: 90,
      title: 'Real sandbox fixture',
      body: envelope,
      labels: [{ name: 'agent:ready' }, { name: 'repair' }],
    },
  });
}

async function runCase(mode) {
  const dir = mkdtempSync(join(tmpdir(), `sonoran-real-sandbox-${mode}-`));
  const port = await freePort();
  const { repoSlug, remoteBase, bareRepo, baseSha } = seedRemote(dir);
  const reposRoot = join(dir, 'repos');
  const worktreeRoot = join(dir, 'worktrees');
  const dbPath = join(dir, 'state.sqlite');
  const cfg = {
    port,
    devMode: true,
    testFixtures: true,
    bodyLimitBytes: 65536,
    defaultTimeoutMs: 30000,
    maxConcurrency: 1,
    leaseDurationMs: 60000,
    reapIntervalMs: 0,
    githubSecretEnv: 'GITHUB_WEBHOOK_SECRET',
    slackWebhookEnv: 'SLACK_WEBHOOK_URL',
    stateDb: dbPath,
    runStateRoot: fixedRunStateRoot,
    reposRoot,
    worktreeRoot,
    repoBase: remoteBase,
    defaultBaseRef: 'main',
    allowlist: ['trusted-user'],
    requireLabel: 'agent:ready',
    workers: {
      hermes: {
        program: fixtureLauncher,
        args: [mode],
        createsTask: true,
        repair: true,
        sandboxedTestFixture: true,
        maxAttempts: 3,
        allowedPaths: ['app/src/**'],
        envAllowlist: ['PATH', 'HOME'],
      },
    },
    rules: [{
      id: 'real-sandbox-fixture',
      when: { events: ['issues'], actions: ['labeled'], labels: ['agent:ready', 'repair'] },
      worker: 'hermes',
      authorize: 'label',
    }],
  };
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify(cfg));

  let stderr = '';
  let runId = '';
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: routerDir,
    env: {
      ...process.env,
      CONFIG_PATH: configPath,
      GITHUB_WEBHOOK_SECRET: 'fixture-secret',
      SLACK_WEBHOOK_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    await waitForHealth(port, child, () => stderr);
    const body = eventBody(repoSlug, baseSha);
    const response = await request(port, body, `real-sandbox-${mode}-${crypto.randomUUID()}`);
    assert.equal(response.status, 200, `HTTP response (${stderr})`);
    runId = response.body.runId;
    assert.match(runId, /^[0-9a-f-]{36}$/i, 'router returned run UUID');
    assert.equal(response.body.repairAction, mode === 'allowed' ? 'candidate_fix' : 'invalid');
    assert.equal(response.body.ok, mode === 'allowed');

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const tasks = db.prepare('SELECT * FROM tasks').all();
    const runs = db.prepare('SELECT * FROM runs').all();
    const leases = db.prepare('SELECT * FROM leases').all();
    db.close();
    assert.equal(tasks.length, 1, 'one task created');
    assert.equal(runs.length, 1, 'one repair run created');
    assert.equal(leases.length, 1, 'one lease created');
    assert.equal(leases[0].status, 'released', 'owned lease released');
    assert.equal(runs[0].status, mode === 'allowed' ? 'success' : 'failed');
    const durable = JSON.parse(runs[0].result);
    assert.equal(durable.action, mode === 'allowed' ? 'candidate_fix' : 'invalid');
    assert.match(durable.output_excerpt, new RegExp(`REAL_SANDBOX_FIXTURE mode=${mode}`), 'actual sandbox fixture executed');

    const expectedFile = mode === 'allowed'
      ? 'app/src/import/fixture-fix.txt'
      : 'unauthorized/fixture-escape.txt';
    const worktree = join(worktreeRoot, 'dualdex-90');
    assert.ok(existsSync(join(worktree, '.git')), 'task-private checkout has independent Git metadata');
    const changed = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', `${baseSha}..HEAD`], { cwd: worktree });
    const actualFiles = changed.toString('utf8').split('\0').filter(Boolean);
    assert.deepEqual(actualFiles, [expectedFile], 'actual committed files are deterministic');
    assert.deepEqual(durable.files_changed, [expectedFile], 'durable declaration equals actual files');
    if (mode === 'unauthorized') {
      assert.match(durable.error, /outside allowed scope/, 'router verifier rejected worker-declared success');
    }

    assert.equal(existsSync(join(fixedRunStateRoot, runId)), false, 'per-run state removed');
    assert.equal(existsSync(join(fixedRunHomeRoot, runId)), false, 'per-run HOME removed');
    const sourceRepo = join(reposRoot, 'dualdex');
    assert.equal(git(sourceRepo, ['rev-parse', 'HEAD']), baseSha, 'shared source repository HEAD unchanged');
    assert.equal(git(sourceRepo, ['status', '--porcelain']), '', 'shared source repository clean');
    const pushedTaskBranch = spawnSync('git', ['show-ref', '--verify', '--quiet', 'refs/heads/fix/90-real-sandbox'], { cwd: bareRepo });
    assert.notEqual(pushedTaskBranch.status, 0, 'worker did not push a task branch');
  } catch (error) {
    error.message += `\nrouter stderr:\n${stderr}`;
    throw error;
  } finally {
    if (child.exitCode == null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('close', resolve));
    }
    if (/^[0-9a-f-]{36}$/i.test(runId)) {
      rmSync(join(fixedRunStateRoot, runId), { recursive: true, force: true });
      rmSync(join(fixedRunHomeRoot, runId), { recursive: true, force: true });
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

execFileSync(deploySkill, [], { stdio: 'ignore' });
await runCase('allowed');
console.log('PASS F-09 allowed candidate accepted through real production sandbox');
await runCase('unauthorized');
console.log('PASS F-09 unauthorized candidate rejected by router verifier');
