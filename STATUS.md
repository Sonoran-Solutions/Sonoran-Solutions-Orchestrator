# Status — M2.1 CI contract + M2.2 Hermes setup (this session)

Work completed against [`IMPLEMENTATION_ROADMAP.md`](IMPLEMENTATION_ROADMAP.md).
M2.1 (canonical CI) and M2.2 (Hermes repair worker) are implemented; M2.3
deliberate repair and M2.4 merge policy remain intentionally untouched.

## Done (this session — M2.1 / M2.2)

- **M2.1 merged** — DualDex PR #28 (canonical `./ci.sh test/build/all`,
  fail-closed submodule/compiler handling, GitHub Actions running the exact
  contract) merged into `main` (`b0f733a`).
- **ORCH-094** — DualDex `protect-main` ruleset configured and read back:
  PR required, required checks `Native & Unit Tests` + `Build Debug APK`,
  `required_approving_review_count: 0`, force-push + deletion blocked, admin
  bypass retained, no auto-merge.
- **Follow-up issue** — `dualdex#29` (QuickJS calculator host-CI coverage gap),
  recorded, not implemented.
- **ORCH-095** — Hermes agent installed/pinned: `v0.21.1` (`f03ed94a`),
  launcher `~/.local/bin/hermes`, data `~/.hermes`; `hermes --version` smoke OK.
  Runbook: [`hermes-watch/INSTALL.md`](hermes-watch/INSTALL.md).
- **ORCH-096/097** — Hermes worker receives an explicit `SONORAN_*` task/run/lease
  context (worktree, repo, branch, base SHA, allowed paths, attempt/max, build
  command, result file) via the env allowlist; the fix-build skill writes a
  structured JSON result (`candidate_fix`/`no_fix`/`escalate`/`blocked`).
- **ORCH-098** — control-plane-enforced `maxAttempts: 3`; attempt 4 is refused
  before a worker launches and the task is escalated.
- **ORCH-099** — `escalate`/`blocked` results stop the autonomous repair loop;
  a subsequent automatic dispatch is refused (human re-authorization required).
- **Tests** — router suite is `50 passed, 0 failed` (9 new Hermes plumbing tests
  against a fake executable: structured context, secret exclusion, attempt
  boundary, escalation terminal, blocked refusal, nonzero-exit durability).

## Done (earlier sessions)

- **ORCH-003** — stale `devils-17` → `Sonoran-Solutions` links fixed in
  `dualdex/README.md` (2 occurrences). The orchestrator's own `config.example.json`
  `allowlist` had one remaining `devils-17` placeholder; it now reads
  `["Sonoran-Solutions"]`. No other stale `devils-17` refs remain in source/config.
- **ORCH-005/006/007** — pilot issue proposed + acceptance criteria + baseline
  workflow: [`pilot/dualdex-pilot-issue.md`](pilot/dualdex-pilot-issue.md).
  **Awaiting human confirmation of the issue (and ROM data if Candidate A).**
- **ORCH-011** — planning-pass artifact: [`pilot/planning-pass.md`](pilot/planning-pass.md).
- **ORCH-034/035** — `slack-notify.sh` now posts only state transitions
  (`task-started`, `pr-ready`, `blocked`, `done`, `stopped`); per-tool/per-file
  spam removed; `hooks.json` emptied.
- **ORCH-037/038/039** — Slack config moved outside worktrees
  (`~/.config/sonoran/orchestrator.env`), loaded as plain `KEY=VALUE` and never
  sourced/evaluated as Bash (verified with an injection test).
- **ORCH-050…083 (control plane)** — router rebuilt and **tested (41/41)**:
  - normalized event context (incl. base ref); body limit, timeout, concurrency,
    clean shutdown;
  - mandatory HMAC + delivery dedupe;
  - fixed-executable dispatch with `shell: false` (injection-proof, tested);
  - trusted-actor + `agent:ready` authorization gate;
  - SQLite `tasks`/`runs`/`deliveries`/`leases`;
  - handoff envelope parser/validator (`schema_version: 1`, legal transitions);
  - per-task git worktree + **named task branch** + lease + allowed-path
    pre-push guard.
- **ORCH-081 (base-ref movement)** — the pre-push guard now records the task's
  **base ref** and compares the live remote base tip against the recorded base
  SHA, separately from the pushed ref. A brand-new feature branch (all-zero
  remote SHA) no longer slips past a moved base; pushing directly to the base
  branch is also blocked. Regression-tested.
- **ORCH-083 (stale-lease reaper)** — `server.mjs` runs a periodic
  `reapExpired()` on `reapIntervalMs` (default `300000`, enabled in
  `config.example.json`). Registration tests pass.
- **ORCH-094 groundwork (minimum env)** — worker dispatch no longer inherits the
  router process environment. Workers get only an explicit `envAllowlist`
  (default `["PATH", "HOME"]`) plus `SONORAN_TASK_ID`/`SONORAN_WORKTREE`, so the
  GitHub webhook secret and Slack webhook URL are never leaked to a coding
  worker. Regression-tested.
- **Task retry idempotency** — a re-delivered webhook with the same
  `repo-name + issue-number` task ID is now a deliberate state transition, not an
  `INSERT` collision 500 (`createTask` upserts; runs get an incremented
  `attempt`). Regression-tested.
- **Live-remote base tracking** — a code task resolves the CURRENT authoritative
  remote base tip (`refs/remotes/origin/<baseRef>`) by explicitly refreshing the
  remote (`git fetch --prune origin`) and fails closed if the fetch fails, the ref
  is missing, or a provided/envelope base SHA is stale vs. the live tip. Regression
  tests cover the stale-clone case (router clone at ABC, remote advances to DEF,
  resolution returns DEF).
- **Envelope/context cross-check** — envelope `repo`, `issue`, `branch`,
  `allowed_paths`, and (a) PR-head-branch equality when the event carries a branch
  are validated against the event context and the resolved base SHA. Mismatches
  refuse the dispatch.
- **Two-scope path policy** — worker/repository baseline is the REQUIRED MAXIMUM
  trusted boundary; the envelope's task `allowed_paths` is an optional ADDITIONAL
  narrowing boundary. A changed file must satisfy BOTH when both exist; a task `*`
  can never widen the worker baseline; **an omitted task scope means
  worker-baseline-only (never deny-all)**, and a stale task-scope file is removed
  when a later run supplies no task scope. An empty worker baseline fails closed.
- **Single live execution per task** — a delivery that finds a run still marked
  `running` AND an active, unexpired lease is refused (`task already has an active
  execution`) and does NOT release the lease, delete the worktree, or launch a
  second worker. A stale `running` run (expired/no lease) is reconciled to
  `abandoned` and its stale lease released before a controlled recovery. The
  reservation section is serialized per task with an in-process lock so two
  near-simultaneous deliveries cannot both reserve execution. Regression-tested with
  a live sleeping worker over the real HTTP path.
- **Existing-task state agreement** — for an existing task the handoff envelope's
  `state` must equal the persisted task state; a mismatch fails closed (rather than
  auto-reconciling). `done` stays terminal.
- **Single active lease** — re-delivery releases prior active leases first; a
  stale lease never reaps a worktree a newer active lease still owns.
- **Retry reconstructs clean state** — each new attempt rebuilds the worktree from
  authoritative Git state (no dirty/local-only commit/old-base/wrong-branch
  inheritance); an incompatible remote task branch fails closed rather than
  auto-rebasing/merging.
- **Raw lifecycle enforcement** — a brand-new task must start in
  `planned`/`authorized`/`assigned` (the trusted `agent:ready` signal is what
  authorizes; `planned` is preferred); an existing task's retry must follow legal
  transitions (`canEnterInProgress`), and `done` stays terminal (no reopen).
  No explicit `done → in_progress` reopen.
- **Fail-closed worktree branch** — `createWorktree` never silently falls back to
  a detached HEAD; if the named branch cannot be created/attached, the dispatch
  fails closed.
- **Cleanup** — the obsolete `fetchLatest()` (`git fetch origin --all`) helper was
  removed; base refresh now uses `git fetch --prune origin` in `resolveBaseSha`.

## Not yet done (needs a human / next milestone)

- **ORCH-005** final issue confirmation (human decision).
- **ORCH-001/002/004** remaining identity checks: GitHub Actions, badges,
  remotes, Slack links, tokens — verify once integrations are actually wired.
- **M0 manual passes** (ORCH-010…019): Codex plan, human-steered Antigravity
  implementation, Codex review — driven by the human, not this session.
- **M2.3** (ORCH-100…105) deliberate repair tests — intentionally not started.
- **M2.4** (ORCH-106…110) review/merge policy — not started.
- **ORCH-080** (verify lease ownership before push) still open — the pre-push guard
  is a cooperative layer; router-owned push verification does not exist yet, so
  Hermes's eventual candidate push path is deliberately deferred.
- **TOOL-026…029** (review gate + ruleset failure/push tests on DualDex) — the
  baseline ruleset (TOOL-021…025) is done; review-gate and adversarial tests
  remain.

## How to run the control plane locally

```bash
cd router
cp config.example.json config.local.json   # set reposRoot/worktreeRoot/allowlist
GITHUB_WEBHOOK_SECRET=... SLACK_WEBHOOK_URL=... node server.mjs
# in another shell:
node test.mjs
```

The example config now enables the stale-lease reaper (`reapIntervalMs: 300000`)
and the code-editing worker declares `"envAllowlist": ["PATH", "HOME"]` so the
router's webhook secret never reaches a worker.
