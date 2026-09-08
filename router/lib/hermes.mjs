// lib/hermes.mjs — bounded repair-worker contract (ORCH-098/099).
//
// Hermes is a narrow mechanical repair worker. It receives structured
// task/run/lease context through SONORAN_* environment variables and reports a
// structured JSON result (never free-form prose) that the router interprets and
// durably persists.
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
// treats a missing/malformed/mis-attempted result as failed evidence, never as a
// fake success. When `expectedAttempt` is provided, the result MUST claim the
// same router-owned repair attempt (Hermes cannot redefine its attempt number).
export function readRepairResult(path, { expectedAttempt = null } = {}) {
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
    if (data.attempt !== undefined) {
      if (!Number.isInteger(data.attempt) || data.attempt < 1) {
        return { ok: false, error: `result attempt '${data.attempt}' is not a positive integer` };
      }
      if (expectedAttempt != null && data.attempt !== expectedAttempt) {
        return { ok: false, error: `result attempt ${data.attempt} does not match router-owned repair attempt ${expectedAttempt}` };
      }
    } else if (expectedAttempt != null) {
      return { ok: false, error: `result is missing the required attempt field (expected ${expectedAttempt})` };
    }
    if (data.files_changed !== undefined && !Array.isArray(data.files_changed)) {
      return { ok: false, error: 'files_changed must be an array when present' };
    }
    if (data.commands_executed !== undefined && !Array.isArray(data.commands_executed)) {
      return { ok: false, error: 'commands_executed must be an array when present' };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// Map a validated repair result to a control-plane action. Only these actions are
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

// Build the durable structured repair record the router persists into
// `runs.result`. It preserves the validated result plus bounded process evidence
// so a later retry / worktree reconstruction cannot lose it.
export function buildRepairRecord({ data = null, action = null, error = null, attempt = null, exitCode = null, timedOut = false, output = '' }) {
  return {
    kind: 'repair',
    status: data?.status ?? null,
    attempt,
    action: action ?? null,
    files_changed: Array.isArray(data?.files_changed) ? data.files_changed : [],
    commands_executed: Array.isArray(data?.commands_executed) ? data.commands_executed : [],
    root_cause: data?.root_cause ?? null,
    summary: data?.summary ?? null,
    uncertainty: data?.uncertainty ?? null,
    escalation_reason: data?.escalation_reason ?? null,
    exit_code: exitCode,
    timed_out: timedOut,
    output_excerpt: String(output || '').slice(0, 2000),
    error,
  };
}

// A repair attempt is exhausted when the next attempt number would exceed the
// configured ceiling. Attempt N+1 is refused by the control plane.
export function attemptExceeded(nextAttempt, maxAttempts) {
  return Number(nextAttempt) > Number(maxAttempts);
}
