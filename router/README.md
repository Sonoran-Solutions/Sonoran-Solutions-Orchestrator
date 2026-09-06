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

## What is implemented (ORCH-050…083)

| Area | Status |
|---|---|
| Normalized event context (delivery id, event/action, repo, issue/PR, actor, branch, head/base SHA, labels) | ✅ |
| Request-body size limit, worker timeout, concurrency limit, graceful shutdown | ✅ |
| Mandatory HMAC signature verification (rejects missing/invalid; `devMode` is the only opt-out) | ✅ |
| GitHub delivery-id dedupe (idempotent) | ✅ |
| Safe dispatch: fixed `program` + argv template, `shell: false`, no webhook-derived shell strings | ✅ |
| Authorization gate: trusted-actor allowlist and `agent:ready` label (labeler must be trusted) | ✅ |
| SQLite `tasks`, `runs`, `deliveries`, `leases` (state survives restart) | ✅ |
| Handoff envelope parser/validator (`schema_version: 1`, required fields, legal transitions) | ✅ |
| Per-task git worktree + lease + allowed-path pre-push guard | ✅ (create/reap/guard) |
| Tests: 15 passing (`node test.mjs`) | ✅ |

A random public issue/PR **cannot** launch a worker: it needs a valid signature,
an untrusted actor is rejected, a code-editing dispatch additionally needs a
valid handoff envelope, and the `agent:ready` path requires a trusted labeler.

## Not yet implemented (do not rely on these)

- **Base-SHA movement check at push time** (ORCH-081): the router records
  `base_sha`, but the "stop if the branch moved unexpectedly" check is not wired
  into a pre-push gate yet. GitHub Rulesets (TOOL-021+) are the intended
  independent backstop.
- **Automatic stale-lease reaping** (ORCH-083): `listExpiredLeases` exists, but
  there is no periodic reaper; expired worktrees must be removed manually or via
  a cron for now.
- **Body-limit / concurrency / timeout paths** are implemented but not yet
  covered by an automated test.
- **GitHub Actions as the required-check authority** and **Hermes repair** are
  M2 (see the roadmap) — not part of this control-plane milestone.

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
             "createsTask": true, "allowedPaths": ["app/src/**"] },
  "notify": { "program": "../slack-notify/slack-notify.sh",
              "args": ["pr-ready", "{{task}}", "--link", "{{link}}"] }
}
```

`program` is a fixed path (or a PATH command); `args` are template strings.
Interpolation uses only the normalized context (`{{repo}}`, `{{branch}}`,
`{{task}}`, `{{link}}`, `{{prompt}}`, `{{worktree}}`…), never raw body text.
`createsTask: true` marks a worker as code-editing: it requires a valid handoff
envelope and gets an isolated worktree + lease.

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
SQLite dedupe/round-trip, worktree create/reap, shell-injection safety, and a
full HTTP integration flow (HMAC 401, untrusted 403, notify dispatch, dedupe,
and the invalid-envelope 422 gate).
