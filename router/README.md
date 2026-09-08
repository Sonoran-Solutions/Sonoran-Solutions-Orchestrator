# Sonoran router

The **deterministic control plane** for the Sonoran Solutions agent workflow.
It owns boring, mechanical orchestration facts and never asks a model to decide
whether a webhook is trusted.

See [`../AGENT_ORCHESTRATION_PLAN.md`](../AGENT_ORCHESTRATION_PLAN.md) for the
architecture/trust model, [`../IMPLEMENTATION_ROADMAP.md`](../IMPLEMENTATION_ROADMAP.md)
for ordering, and [`../handoff/handoff-envelope.md`](../handoff/handoff-envelope.md)
for the task schema.

## Layout

```
router/
  server.mjs            HTTP entry: HMAC, body limit, dedupe, auth, dispatch, shutdown
  lib/config.mjs        config loading (outside the repo; secrets via env)
  lib/events.mjs        normalized event context + template vars
  lib/handoff.mjs       handoff envelope parser/validator + state machine
  lib/auth.mjs          trusted-actor / agent:ready authorization gate
  lib/state.mjs         SQLite state (tasks/runs/deliveries/leases)
  lib/workers.mjs       fixed-executable dispatch (shell:false, timeout)
  lib/worktrees.mjs     per-task git worktrees + lease + push guard
  test.mjs              test suite (node test.mjs)
```

## What is implemented (ORCH-050…083 + ORCH-094 groundwork)

| Area | Status |
|---|---|
| Normalized event context (delivery id, event/action, repo, issue/PR, actor, branch, head/base SHA, base ref, labels) | ✅ |
| Request-body size limit, worker timeout, concurrency limit, graceful shutdown | ✅ |
| Mandatory HMAC signature verification (rejects missing/invalid; `devMode` is the only opt-out) | ✅ |
| GitHub delivery-id dedupe (idempotent) | ✅ |
| Safe dispatch: fixed `program` + argv template, `shell: false`, no webhook-derived shell strings | ✅ |
| Authorization gate: trusted-actor allowlist and `agent:ready` label (labeler must be trusted) | ✅ |
| SQLite `tasks`, `runs`, `deliveries`, `leases` (state survives restart) | ✅ |
| Handoff envelope parser/validator (`schema_version: 1`, required fields, legal transitions) | ✅ |
| Per-task git worktree + **named task branch** + lease + allowed-path / base-ref movement pre-push guard | ✅ (create/reap/guard) |
| Worker env hygiene: allowlist-only environment (no router-secret leakage) | ✅ |
| Tests: 20 passing (`node test.mjs`) | ✅ |

A random public issue/PR **cannot** launch a worker: it needs a valid signature,
an untrusted actor is rejected, a code-editing dispatch additionally needs a
valid handoff envelope, and the `agent:ready` path requires a trusted labeler.

## Not yet implemented (do not rely on these)

- **GitHub Actions as the required-check authority** and **Hermes repair** are
  M2 (see the roadmap) — not part of this control-plane milestone.
- **M2.1 CI contract** (`ci.sh`) and **M2.2 Hermes install** remain open.
- **Body-limit / concurrency / timeout paths** are implemented but exercised only
  indirectly by the HTTP integration test.

Note on ORCH-081/083: both **are wired**. The pre-push guard records the task's
base ref and blocks a push when the live remote base tip moved from the recorded
base SHA, and `server.mjs` reaps expired leases on `reapIntervalMs`. The intended
independent backstop remains GitHub Rulesets (TOOL-021+).

## Configuration

Config is loaded from the first of:

1. `$CONFIG_PATH`
2. `router/config.local.json`
3. `~/.config/sonoran/router.json`
4. `router/config.example.json` (committed, no secrets — dev fallback)

Secrets never live in config: the webhook secret is read from
`$GITHUB_WEBHOOK_SECRET` (configurable via `githubSecretEnv`) and the Slack
webhook from `$SLACK_WEBHOOK_URL` (`slackWebhookEnv`).

```bash
cd router
cp config.example.json config.local.json   # edit ports/paths/allowlist/rules
GITHUB_WEBHOOK_SECRET=... SLACK_WEBHOOK_URL=... node server.mjs
```

### Workers (fixed executables)

```jsonc
"workers": {
  "codex": { "program": "codex", "args": ["exec", "--full-auto", "{{prompt}}"],
             "createsTask": true, "allowedPaths": ["app/src/**"],
             "envAllowlist": ["PATH", "HOME"] },
  "notify": { "program": "../slack-notify/slack-notify.sh",
              "args": ["pr-ready", "{{task}}", "--link", "{{link}}"],
              "envAllowlist": ["PATH", "HOME", "SLACK_WEBHOOK_URL"] }
}
```

`program` is a fixed path (or a PATH command); `args` are template strings.
Interpolation uses only the normalized context (`{{repo}}`, `{{branch}}`,
`{{task}}`, `{{link}}`, `{{prompt}}`, `{{worktree}}`…), never raw body text.
`createsTask: true` marks a worker as code-editing: it requires a valid handoff
envelope and gets an isolated worktree + lease.

`envAllowlist` is the **only** environment a worker sees. Default when omitted is
`["PATH", "HOME"]`. The router never passes its own secrets to a worker, so the
GitHub webhook secret (`GITHUB_WEBHOOK_SECRET`) and the Slack webhook URL are
only available to a worker that explicitly declares them (e.g. the `notify`
worker declares `SLACK_WEBHOOK_URL`). Code-editing workers must not declare the
webhook secret. `SONORAN_TASK_ID` and `SONORAN_WORKTREE` are always added.

`defaultBaseRef` (default `"main"`) names which branch a task is based on,
falling back to the PR base ref when the event carries one.

### Rules

```jsonc
"rules": [
  { "id": "pr-opened-notify", "when": { "events": ["pull_request"], "actions": ["opened"] },
    "worker": "notify", "authorize": "trusted" },
  { "id": "codex-on-ready-label", "when": { "events": ["issues"], "actions": ["labeled"] },
    "worker": "codex", "authorize": "label" }
]
```

`authorize: "trusted"` requires `actor ∈ allowlist`; `authorize: "label"`
requires a trusted actor **and** the `agent:ready` label.

## GitHub webhook wiring

Repo → Settings → Webhooks → **Add webhook**:

- Payload URL: `http://<your-ip>:8090/github` (any path)
- Content type: `application/json`
- Secret: the same value as `$GITHUB_WEBHOOK_SECRET`
- Events: `pull_request`, `issues`, `issue_comment` (as needed)

Keep it on a trusted network. Do not expose the router publicly; the HMAC gate
is for authenticity, not a replacement for a private network + Rulesets.

## Tests

```bash
cd router
node test.mjs
```

Covers handoff parsing/validation (valid, missing, unknown schema, malicious,
lists/block-scalars, state transitions), authorization, event normalization,
SQLite dedupe/round-trip/idempotent task re-delivery, worktree create/reap and
named-branch + safe-branch-name validation, base-ref movement + scope push-guard,
shell-injection safety, worker env allowlist filtering, and a full HTTP
integration flow (HMAC 401, untrusted 403, notify dispatch, dedupe, and the
invalid-envelope 422 gate).
