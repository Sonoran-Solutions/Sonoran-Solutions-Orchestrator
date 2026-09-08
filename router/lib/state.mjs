// lib/state.mjs — durable router state (tasks/runs/deliveries/leases).
// ORCH-067..072. Uses Node's built-in `node:sqlite` (Node 22.5+, stable in 24).
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

export function openDb(path) {
  if (dirname(path)) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  init(db);
  // Lightweight migration for DBs created before base_ref was tracked.
  ensureColumn(db, 'tasks', 'base_ref', 'base_ref TEXT');
  return db;
}

// Add a column only if it is missing (CREATE TABLE IF NOT EXISTS does not alter
// an existing table, so we guard upgrades for older state.sqlite files).
function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

function init(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS deliveries (
      id          TEXT PRIMARY KEY,
      received_at TEXT NOT NULL,
      repo        TEXT,
      event       TEXT,
      actor       TEXT
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id         TEXT PRIMARY KEY,
      repo       TEXT NOT NULL,
      issue      TEXT,
      state      TEXT NOT NULL,
      owner      TEXT,
      branch     TEXT,
      base_sha   TEXT,
      base_ref   TEXT,
      risk       TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id         TEXT PRIMARY KEY,
      task_id    TEXT NOT NULL,
      agent      TEXT NOT NULL,
      attempt    INTEGER NOT NULL,
      status     TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at   TEXT,
      result     TEXT
    );
    CREATE TABLE IF NOT EXISTS leases (
      id          TEXT PRIMARY KEY,
      task_id     TEXT NOT NULL,
      worktree    TEXT NOT NULL,
      base_sha    TEXT,
      owner       TEXT,
      source_repo TEXT,
      status      TEXT NOT NULL,
      expires_at  TEXT
    );
  `);
}

export function now() { return new Date().toISOString(); }

// Returns true if this delivery is new (and was recorded); false if duplicate.
export function recordDelivery(db, { id, repo, event, actor }) {
  if (!id) return true; // no delivery id -> cannot dedupe; still process
  const t = now();
  const r = db.prepare('INSERT OR IGNORE INTO deliveries (id, received_at, repo, event, actor) VALUES (?,?,?,?,?)')
    .run(id, t, repo, event, actor);
  return r.changes === 1;
}

// Idempotent task creation (ORCH-057 + retry hardening): a task ID is
// repo-name + issue-number, so the same label being removed and re-added (a new
// GitHub delivery, same task ID) must be a deliberate state transition/retry,
// never an INSERT collision that turns into a 500.
export function createTask(db, task) {
  const t = now();
  const existing = getTask(db, task.id);
  if (existing) {
    db.prepare(`UPDATE tasks SET repo=?, issue=?, state=?, owner=?, branch=?, base_sha=?, base_ref=?, risk=?, updated_at=?
                WHERE id=?`)
      .run(task.repo, task.issue ?? null, task.state ?? existing.state, task.owner ?? existing.owner,
           task.branch ?? existing.branch, task.baseSha ?? existing.base_sha, task.baseRef ?? existing.base_ref,
           task.risk ?? existing.risk, t, task.id);
    return getTask(db, task.id);
  }
  db.prepare(`INSERT INTO tasks (id, repo, issue, state, owner, branch, base_sha, base_ref, risk, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(task.id, task.repo, task.issue ?? null, task.state || 'planned', task.owner ?? null,
         task.branch ?? null, task.baseSha ?? null, task.baseRef ?? null, task.risk ?? null, t, t);
  return getTask(db, task.id);
}

export function getTask(db, id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

export function updateTaskState(db, id, state) {
  db.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?').run(state, now(), id);
  return getTask(db, id);
}

export function createRun(db, run) {
  db.prepare(`INSERT INTO runs (id, task_id, agent, attempt, status, started_at)
              VALUES (?,?,?,?,?,?)`)
    .run(run.id, run.taskId, run.agent, run.attempt ?? 1, run.status || 'running', now());
  return run.id;
}

// next attempt number for a task (1-based): the highest previous attempt + 1.
export function nextAttempt(db, taskId) {
  const r = db.prepare('SELECT COALESCE(MAX(attempt), 0) AS m FROM runs WHERE task_id = ?').get(taskId);
  return ((r && r.m) || 0) + 1;
}

export function updateRun(db, id, { status, result }) {
  db.prepare('UPDATE runs SET status = ?, result = ?, ended_at = ? WHERE id = ?')
    .run(status, result ?? null, now(), id);
}

export function createLease(db, lease) {
  db.prepare(`INSERT INTO leases (id, task_id, worktree, base_sha, owner, source_repo, status, expires_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(lease.id, lease.taskId, lease.worktree, lease.baseSha ?? null, lease.owner ?? null,
         lease.sourceRepo ?? null, lease.status || 'active', lease.expiresAt ?? null);
}

export function getActiveLeaseForTask(db, taskId) {
  return db.prepare(`SELECT * FROM leases WHERE task_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`)
    .get(taskId);
}

export function releaseLease(db, id) {
  db.prepare(`UPDATE leases SET status = 'released' WHERE id = ?`).run(id);
}

export function listExpiredLeases(db, atIso) {
  return db.prepare(`SELECT * FROM leases WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < ?`)
    .all(atIso);
}

export function close(db) { db.close(); }
