// lib/handoff.mjs — parse + validate the handoff envelope (schema_version: 1).
// ORCH-073..076. Only the YAML front-matter block is interpreted; prose outside
// the fences is untrusted and ignored.
//
// Supported subset (enough for the canonical envelope):
//   key: value          scalar
//   key: | / key: >     block scalar (multi-line)
//   key:                YAML list (following indented "- item" lines)

export const STATES = ['planned', 'authorized', 'assigned', 'in_progress', 'review', 'verification', 'done', 'blocked', 'escalated'];

// Matches the state flow in handoff/handoff-envelope.md. blocked/escalated may
// be entered from any active state; done is terminal.
export const VALID_TRANSITIONS = {
  planned: ['authorized', 'blocked', 'escalated', 'done'],
  authorized: ['assigned', 'blocked', 'escalated'],
  assigned: ['in_progress', 'blocked', 'escalated'],
  in_progress: ['review', 'blocked', 'escalated'],
  review: ['verification', 'in_progress', 'blocked', 'escalated'],
  verification: ['done', 'in_progress', 'blocked', 'escalated'],
  blocked: ['assigned', 'in_progress', 'escalated', 'done'],
  escalated: ['assigned', 'in_progress', 'done'],
  done: [],
};

const REQUIRED = ['schema_version', 'agent', 'to', 'repo', 'issue', 'branch', 'state', 'task', 'acceptance'];

export function parseEnvelope(text) {
  const errors = [];
  const lines = String(text ?? '').split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === '---');
  if (start === -1) return fail(errors, 'no front-matter fence (---) found');

  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end === -1) return fail(errors, 'unterminated front-matter fence');

  const data = {};
  let cur = null; let mode = null; // mode: 'block' | 'list'

  for (const raw of lines.slice(start + 1, end)) {
    if (cur && mode === 'block') {
      if (raw.trim() === '' || /^[ \t]/.test(raw)) {
        data[cur] = (data[cur] ?? '') + '\n' + raw.replace(/^[ \t]{0,2}/, '');
        continue;
      }
      cur = null; mode = null;
    }
    if (cur && mode === 'list') {
      const m = raw.match(/^\s*-\s*(.*)$/);
      if (m) { (data[cur] ??= []).push(m[1].trim()); continue; }
      if (raw.trim() === '') continue;
      cur = null; mode = null; // list ended — fall through to scalar parse
    }
    const sm = raw.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!sm) { errors.push(`bad line: ${raw.slice(0, 60)}`); continue; }
    const k = sm[1]; const v = sm[2];
    if (v === '|' || v === '>') { cur = k; mode = 'block'; data[k] = ''; }
    else if (v === '') { cur = k; mode = 'list'; data[k] = undefined; }
    else data[k] = unquote(v);
  }
  for (const k of Object.keys(data)) if (data[k] === undefined) data[k] = '';

  return validate(data, errors);
}

function unquote(v) {
  const m = v.match(/^"(.*)"$/s) || v.match(/^'(.*)'$/s);
  return m ? m[1] : v;
}

function fail(errors, msg) {
  errors.push(msg);
  return { ok: false, data: null, errors };
}

function validate(data, errors) {
  if (data.schema_version !== '1') {
    errors.push(`unsupported schema_version: ${JSON.stringify(data.schema_version ?? '(missing)')}`);
  }
  for (const f of REQUIRED) {
    if (data[f] == null || String(data[f]).trim() === '') errors.push(`missing required field: ${f}`);
  }
  if (data.state != null && !STATES.includes(data.state)) {
    errors.push(`invalid state: ${data.state} (allowed: ${STATES.join(', ')})`);
  }
  const ok = errors.length === 0;
  return { ok, data: ok ? data : null, errors };
}

export function legalTransition(from, to) {
  return (VALID_TRANSITIONS[from] || []).includes(to);
}

// Conservative branch-name validator (kept in sync with lib/worktrees.mjs), so a
// malicious envelope branch can never become argument injection for git.
const BRANCH_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
export function validBranchName(name) {
  if (!name) return false;
  const s = String(name).trim();
  if (!BRANCH_NAME_RE.test(s)) return false;
  if (s.startsWith('-') || s.startsWith('/') || s.endsWith('/') || s.endsWith('.')) return false;
  if (s.includes('..') || s.includes('//') || /\.lock$/i.test(s)) return false;
  return true;
}

// Cross-check the parsed envelope against the normalized event context / router
// state where applicable (repo, issue, branch, allowed_paths). base_sha is
// cross-checked separately against the resolved live base SHA in dispatch.
export function validateEnvelopeContext(envelope, ctx) {
  const errors = [];
  if (!envelope) return { ok: false, errors: ['missing envelope'] };

  if (ctx.repo && String(envelope.repo || '').toLowerCase() !== String(ctx.repo).toLowerCase()) {
    errors.push(`envelope repo '${envelope.repo}' does not match event repo '${ctx.repo}'`);
  }
  const envIssue = envelope.issue != null && envelope.issue !== '' ? String(envelope.issue) : '';
  if (ctx.issueNumber != null && envIssue && String(ctx.issueNumber) !== envIssue) {
    errors.push(`envelope issue '${envelope.issue}' does not match event issue '${ctx.issueNumber}'`);
  }
  if (!validBranchName(envelope.branch)) {
    errors.push(`envelope branch '${envelope.branch}' is not a valid branch name`);
  }
  // PR head-branch cross-check: when the event carries a known branch (e.g. the PR
  // head ref), the envelope's task branch MUST equal it. There is no alternate
  // trusted task-branch mapping yet, so this fails closed on mismatch.
  if (ctx.branch && envelope.branch && ctx.branch !== envelope.branch) {
    errors.push(`envelope branch '${envelope.branch}' does not match event branch '${ctx.branch}'`);
  }
  if (envelope.allowed_paths !== undefined && envelope.allowed_paths !== null && envelope.allowed_paths !== '') {
    if (!Array.isArray(envelope.allowed_paths) || !envelope.allowed_paths.every((p) => typeof p === 'string' && p.trim() !== '')) {
      errors.push('envelope allowed_paths must be a list of non-empty path strings');
    }
  }
  return { ok: errors.length === 0, errors };
}

// Path scoping is TWO independent scopes, never a single "effective" list:
//   worker = worker/repository baseline (MAXIMUM trusted boundary)
//   task   = optional additional narrowing boundary from the envelope
// A task can never widen the worker baseline because both are enforced per file.
export function pathScopes(envelope, workerAllowedPaths = []) {
  const worker = (Array.isArray(workerAllowedPaths) ? workerAllowedPaths : []).filter((p) => typeof p === 'string' && p.trim() !== '');
  const task = (Array.isArray(envelope?.allowed_paths) ? envelope.allowed_paths : []).filter((p) => typeof p === 'string' && p.trim() !== '');
  return { worker, task };
}

// A brand-new task (no prior router state) must start in a state that can legally
// reach `in_progress` through the documented lifecycle. planned is preferred; a
// trusted agent:ready signal is what authorizes the task, so 'authorized' is also
// accepted deliberately. We do NOT accept every non-terminal enum value: a new task
// declaring done/review/verification/escalated/blocked/in_progress implies a prior
// lifecycle the router has no record of and is refused.
export const ACCEPTED_NEW_TASK_STATES = ['planned', 'authorized', 'assigned'];
export function validateNewTaskState(state) {
  if (!ACCEPTED_NEW_TASK_STATES.includes(state)) {
    return { ok: false, errors: [`a new task must start in one of: ${ACCEPTED_NEW_TASK_STATES.join(', ')}; got '${state}'`] };
  }
  return { ok: true, errors: [] };
}

// May an existing task be dispatched to a fresh execution (i.e. enter `in_progress`)?
// A same-state in_progress re-run is allowed (a worker may have crashed without
// marking blocked); otherwise only a documented legal transition into in_progress.
// `done` stays terminal (no reopen operation exists).
export function canEnterInProgress(existingState) {
  return existingState === 'in_progress' || legalTransition(existingState, 'in_progress');
}
