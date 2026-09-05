# Handoff envelope

The handoff envelope is the canonical machine-readable task block an agent writes or updates in a GitHub issue/PR when planning, starting, handing off, blocking, or completing work.

It is intentionally boring. The router should be able to validate it deterministically without asking a model what the task state probably means.

## Canonical template

```yaml
---
schema_version: 1
task_id: ss-123
run_id: ss-123-001
agent: codex
to: antigravity
repo: sonoran-solutions/project
issue: "123"
branch: feat/123
base_sha: abcdef1234567890
state: planned
risk: normal
attempt: 0
max_attempts: 3
lease_expires_at: 2026-09-05T23:00:00Z
allowed_paths:
  - app/src/**
  - tests/**
required_checks:
  - build
  - test
task: Implement POST /users.
summary: |
  Planning complete. No code has been changed yet.
acceptance: |
  POST /users returns 201.
  Empty email is rejected.
  Required tests are green.
escalate_to: human
---
```

Normal prose may follow the closing `---`, but the router must treat prose as context rather than authority.

## Field definitions

| Field | Purpose |
|---|---|
| `schema_version` | Envelope format version. Required so future schema changes can be rejected or migrated safely. |
| `task_id` | Stable task identifier across all runs/handoffs. |
| `run_id` | Identifier for the current execution attempt/session. |
| `agent` | Worker writing the current state (`codex`, `antigravity`, `hermes`, `human`, etc.). |
| `to` | Intended next owner. |
| `repo` | `owner/repo` task target. |
| `issue` | GitHub issue/PR number associated with the task. |
| `branch` | Current task branch. |
| `base_sha` | Commit state the worker was assigned against. Used to detect unexpected movement. |
| `state` | Lifecycle state. See below. |
| `risk` | Suggested values: `low`, `normal`, `high`. High-risk work always requires human review. |
| `attempt` | Current bounded attempt count. |
| `max_attempts` | Hard ceiling before blocking/escalation. |
| `lease_expires_at` | Expiry for the current worker's ownership lease. |
| `allowed_paths` | Explicit repository paths the worker may modify for this run. |
| `required_checks` | CI checks required before completion/merge. |
| `task` | Concise instruction for the current work. |
| `summary` | What has been done, observed, or attempted so far. |
| `acceptance` | Observable definition of success. |
| `escalate_to` | Owner to receive the task if limits are hit or judgment is required. |

## Recommended states

```text
planned
  ↓
authorized
  ↓
assigned
  ↓
in_progress
  ↓
review
  ↓
verification
  ↓
done

blocked / escalated may be entered from any active state.
```

The router, not free-form agent interpretation, should enforce legal transitions.

## Authorization rule

A valid envelope is **not authorization by itself**.

Before execution, the router must also verify a trusted authorization signal such as an allowlisted actor or an `agent:ready` label applied by a trusted actor. A public user must not be able to start a local coding worker simply by posting a correctly formatted envelope.

## Lease and scope rules

- Exactly one active execution lease owns a task worktree at a time.
- `state: in_progress` is valid only while the writer owns that lease.
- `base_sha` must be checked before commit/push; unexpected branch movement stops the task.
- `allowed_paths` is a hard boundary. A worker cannot silently widen its own scope.
- If the necessary fix lies outside `allowed_paths`, set `state: blocked` or `escalated` and explain why.
- Secrets/config owned by the orchestrator are never included in `allowed_paths`.

## Handoff rules

- **One canonical envelope per issue/PR.** Update it in place rather than creating competing task states in multiple comments.
- **Front-matter stays first.** Put human-readable discussion after the closing fence.
- **Never claim work you did not do.** `summary` must describe actual actions/evidence.
- Before handing off, commit/push any intended code state and update `base_sha`/branch information as appropriate.
- The next worker starts from the recorded GitHub state, not from another agent's dirty working tree.
- Every execution attempt gets a new `run_id` and incremented `attempt` when applicable.
- Exceeding `max_attempts` must stop execution and escalate; do not reset the counter to keep trying.

## Example: Hermes escalating a failed repair

```yaml
---
schema_version: 1
task_id: ss-141
run_id: ss-141-006
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
lease_expires_at: 2026-09-06T00:00:00Z
allowed_paths:
  - src/layout/**
  - tests/e2e.spec.js
required_checks:
  - build
  - e2e
 task: Fix the Safari layout regression without changing public behavior.
summary: |
  Five bounded repair attempts were tried. All either left the WebKit failure
  unchanged or regressed tests/e2e.spec.js. The remaining hypothesis appears to
  require a layout/API decision rather than a mechanical fix.
acceptance: |
  Build passes.
  e2e.spec.js is green on Chromium and WebKit.
  Existing layout behavior remains unchanged.
escalate_to: human
---
```

> Note: before implementing schema parsing, add validation tests using valid, malformed, malicious, stale-lease, and out-of-scope envelopes.
