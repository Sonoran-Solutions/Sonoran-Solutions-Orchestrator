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
- **ORCH-050…083 (control plane)** — router rebuilt and **tested (20/20)**:
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
