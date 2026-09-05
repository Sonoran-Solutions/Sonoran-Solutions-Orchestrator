# Handoff envelope

The structured block an agent writes when it finishes (or when it hands a task
to another agent). Copy this into the **body of a GitHub issue** (or top of a PR
description). Paste the whole block with the front-matter fences intact so other
agents — and a future router — can parse it.

```yaml
---
agent: codex            # who wrote this
to: antigravity         # who should pick it up next (codex | antigravity | hermes | human)
repo: myorg/project
issue: "123"            # the issue/PR this lives on
branch: feat/123        # the branch the work is on (empty if not started)
state: planned          # planned | in_progress | needs_fix | blocked | done
task: Implement POST /users
summary: Show what was done, or the failure and what was tried.
acceptance: |
  POST /users returns 201; empty email rejected; tests in users.test.ts pass.
urgency: normal          # normal | asap
escalate_to: human      # who to escalate to if this stalls
---
```

## Example (Codex handing a bug to itself after Hermes escalated)

```yaml
---
agent: hermes
to: codex
repo: myorg/project
issue: "141"
branch: fix/141
state: needs_fix
task: build fails on Safari — CSS anchor positioning
summary: |
  Hermes tried 5 fixes; all regressed `tests/e2e.spec.js`. Root cause looks like a
  layout/anchor-positioning decision, not a syntax fix.
acceptance: |
  tsc passes; e2e.spec.js green on Chromium + WebKit; no layout regressions.
urgency: asap
escalate_to: human
---
```

## Rules

- **One envelope per issue/PR.** Update it in place; don't start new threads.
- **Front-matter must stay first.** Put normal prose after the closing `---`.
- **`to` and `state` are the only fields that change often**; edit them, push, and
  the next agent reads the latest.
- **Never claim work you didn't do.** `state: in_progress` only while you own it;
  set `state: done` + `branch` + `summary` on handoff.
- The router (see `../router/`) can interpret `to` + `state` to wake the right
  harness automatically.
