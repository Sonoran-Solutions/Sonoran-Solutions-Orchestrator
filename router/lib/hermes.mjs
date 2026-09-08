// lib/hermes.mjs — bounded repair-worker contract (ORCH-098/099).
//
// Hermes is a narrow mechanical repair worker. It receives structured
// task/run/lease context through SONORAN_* environment variables and reports a
// structured JSON result (never free-form prose) that the router interprets.
//
// The router — not the worker — decides whether the autonomous repair loop
// continues. `escalate` and `blocked` are terminal for the automatic loop.
import { readFileSync, existsSync } from 'node:fs';

export const REPAIR_STATUSES = ['candidate_fix', 'no_fix', 'escalate', 'blocked'];
export const DEFAULT_MAX_REPAIR_ATTEMPTS = 3;

// The canonical local CI command a repair worker runs. Configurable per worker;
// this is the DualDex canonical contract default.
export const DEFAULT_REPAIR_BUILD_CMD = './ci.sh test';

// Terminal statuses stop the autonomous repair loop (ORCH-099).
export function isEscalationStatus(status) {
  return status === 'escalate' || status === 'blocked';
}

// Read + validate the structured result the worker wrote to `path`. The router
// treats a missing/malformed result as a failed run, never as a fake success.
export function readRepairResult(path) {
  try {
    if (!path || !existsSync(path)) return { ok: false, error: 'no repair result file written' };
    const raw = readFileSync(path, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, error: 'repair result is not a JSON object' };
    }
    if (!REPAIR_STATUSES.includes(data.status)) {
      return { ok: false, error: `unknown repair status '${data.status}'` };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// Map a parsed repair result to a control-plane action. Only these actions are
// understood; anything else is invalid and treated as a failed run.
export function classifyRepairResult(read) {
  if (!read.ok) return { action: 'invalid', reason: read.error };
  const d = read.data;
  switch (d.status) {
    case 'escalate': return { action: 'escalate', reason: String(d.escalation_reason || 'worker escalated') };
    case 'blocked': return { action: 'blocked', reason: String(d.escalation_reason || 'worker blocked') };
    case 'candidate_fix': return { action: 'candidate_fix' };
    case 'no_fix': return { action: 'no_fix' };
    default: return { action: 'invalid', reason: `unhandled status '${d.status}'` };
  }
}

// A repair attempt is exhausted when the next attempt number would exceed the
// configured ceiling. Attempt N+1 is refused by the control plane.
export function attemptExceeded(nextAttempt, maxAttempts) {
  return Number(nextAttempt) > Number(maxAttempts);
}
