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
