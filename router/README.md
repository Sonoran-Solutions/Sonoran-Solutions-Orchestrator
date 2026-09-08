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
| Per-task git worktree + **named task branch** + lease + allowed-path / base-ref movement pre-push guard | ✅ (create/reap/guard, fail-closed) |
| Live-remote base tracking: refresh + verify base SHA against `refs/remotes/origin/<baseRef>`, stale base refused | ✅ |
| Envelope/context cross-check (repo/issue/branch/allowed_paths/base_sha, PR-head branch) | ✅ |
| Path policy: worker baseline REQUIRED AND (optional) task scope enforced per file; task cannot widen worker baseline; omitted task scope = worker-baseline-only | ✅ |
| Retry lifecycle: clean worktree reconstructed from authoritative Git state, incompatible branch fails closed | ✅ |
| Single live execution per task: a 2nd delivery while a run is 'running' + an active, unexpired lease is refused | ✅ |
| Existing-task envelope state must equal persisted task state (fail closed on mismatch); done stays terminal | ✅ |
| Exactly one active lease per task; stale lease never reaps an owned worktree | ✅ |
| Worker env hygiene: allowlist-only environment (no router-secret leakage) | ✅ |
| Hermes bounded repair worker: structured `SONORAN_*` context, structured result file, attempt limit, escalation terminal | ✅ |
| Tests: 50 passing (`node test.mjs`) | ✅ |

A random public issue/PR **cannot** launch a worker: it needs a valid signature,
an untrusted actor is rejected, a code-editing dispatch additionally needs a
valid handoff envelope, and the `agent:ready` path requires a trusted labeler.

## Not yet implemented (do not rely on these)

- **GitHub Actions as the required-check authority** is wired for DualDex (the
  `Native & Unit Tests` + `Build Debug APK` checks are required on `main`); the
  router's own CI-event consumption is not yet built.
- **Hermes candidate push** (ORCH-080, router-owned lease verification before
  push) remains open. The pre-push guard is a *cooperative* layer; the M2.2
  worker is wired to repair locally and return a structured result, but does not
  push. Push is deferred to the M2.4 pilot integration.
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

`repoBase` (default `https://github.com`) is the base URL the router clones task
repos from; point it at a local path in tests so the flow runs without network.
`defaultBaseRef` (default `"main"`) is the branch a code task is based on when
the event does not carry a PR base ref.

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

### Repair workers (Hermes)

A worker with `"repair": true` is a bounded repair worker (and is inherently a
code worker, so it always gets an envelope + worktree + lease). It additionally:

- receives structured `SONORAN_*` context instead of a free-form prompt: task/run/
  lease IDs, repo, branch, base SHA, attempt/max-attempts, allowed/task paths,
  canonical build command, and `SONORAN_RESULT_FILE`;
- must write a structured JSON result to `SONORAN_RESULT_FILE` with `status` in
  `candidate_fix | no_fix | escalate | blocked`;
- is subject to a control-plane-enforced attempt limit (`maxAttempts`, default
  `3`): attempt `N+1` is refused before a worker launches and the task is
  escalated;
- has `escalate`/`blocked` treated as terminal for the autonomous loop: the next
  automatic dispatch is refused until a human re-authorizes.

```jsonc
"hermes": {
  "program": "hermes",
  "args": ["-z", "{{prompt}}", "--in", "{{worktree}}", "--skills", "fix-build", "--yolo"],
  "createsTask": true, "repair": true, "maxAttempts": 3,
  "buildCmd": "./ci.sh test",
  "allowedPaths": ["app/src/**", "native/**", "*.md"],
  "envAllowlist": ["PATH", "HOME"]
}
```

The router interprets the structured result; free-form worker prose never mutates
router state.

### Allowed-path policy (two scopes, never widening)

Path scope is two independent scopes, both enforced per changed file by the
cooperative pre-push guard:

- **worker/repository baseline** = the worker's `allowedPaths` (the REQUIRED MAXIMUM
  trusted boundary). Always written to `.sonoran-worker-allowed-paths`.
- **task scope** = the envelope's `allowed_paths` (an OPTIONAL additional narrowing
  boundary). Written to `.sonoran-task-allowed-paths` **only when non-empty**;
  omitted task scope means worker-baseline-only, NOT deny-all.

A file must match BOTH when a task scope exists. A task `allowed_paths` of `*` can
**never** widen the worker baseline. If a code worker has an empty baseline, the
dispatch fails closed. A stale task-scope file from a previous run is removed when
a later run supplies no task scope, so an old restriction cannot leak forward.

> Note: this Git hook is a **cooperative** enforcement layer (a worker can tamper
> with its own hook/worktree). It is not router-owned push verification, so it is
> not an unbypassable security boundary. ORCH-080 (router-owned lease verification
> before push) remains open.

### Worktree retry + single-live-execution lifecycle

Each new execution attempt reconstructs a clean named worktree from authoritative
Git state (`prepareWorktreeForRun`): it removes any prior worktree for the task,
refreshes the remote, and either uses the task branch from origin (only if it is
compatible with the verified base — otherwise it fails closed and refuses rather
than auto-rebasing/merging) or recreates it from the verified base SHA. A retry
never inherits dirt, local-only commits, an old base, or the wrong branch. The
worktree must be on the expected named branch, non-detached, clean, and at the
expected starting commit before a worker is launched.

At most **one live execution** may exist per task. The router's live-execution
ownership signal is: a run still marked `running` AND an active, unexpired lease.
A delivery that finds such a state is refused with `task already has an active
execution` and does NOT release the lease, delete the worktree, or launch a second
worker. If a `running` run exists but the lease is expired (or there is no active
lease), the previous execution is treated as stale: the old `running` run is
reconciled to `abandoned` and the stale lease is released before a controlled
recovery is allowed. An omitted/done task stays terminal (no reopen).

For an existing task, the handoff envelope's `state` must equal the persisted task
state; a mismatch is refused (fail closed) rather than auto-reconciled.

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

Covers handoff parsing/validation, authorization, event normalization, SQLite
state (dedupe/idempotent re-delivery/single active lease/stale-lease ownership/
live-execution detection), worktrees (named branch, safe branch names, live-remote
base tracking, fetch-failure fail-closed, retry-clean lifecycle, incompatible-branch
fail-closed, omitted-task-scope = worker-baseline-only, stale task-scope removal),
two-scope push-guard enforcement, shell-injection safety, worker env allowlist
filtering, and offline HTTP integration tests (HMAC/auth/dedupe/422 gates, a full
issues:labeled code task that honors lifecycle + path policy, a PR-context
branch-mismatch refusal, and a concurrent test proving a live worker is never
clobbered by a second delivery).
