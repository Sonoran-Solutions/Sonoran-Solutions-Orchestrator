# Status — control-plane wiring (this session)

Work completed against [`IMPLEMENTATION_ROADMAP.md`](IMPLEMENTATION_ROADMAP.md).
This is additive progress toward M1/M1.5; nothing here grants unattended merge
or code-editing authority (that stays gated on M2 + Rulesets + human merge).

## Done

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
- **M2** (ORCH-090…110): define `ci.sh` for DualDex, add GitHub Actions required
  checks, install Hermes, run deliberate-failure tests. ORCH-094's *minimum
  environment* building block is in place; the Hermes wiring itself remains.
- **M2.1 CI contract** and the **M2.2 Hermes install** are untouched this session.
- **ORCH-080** (verify lease ownership before push) still open — the pre-push guard
  is a cooperative layer; router-owned push verification does not exist yet.
- **TOOL-021…029**: GitHub Rulesets on DualDex (required checks + review gate).

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
