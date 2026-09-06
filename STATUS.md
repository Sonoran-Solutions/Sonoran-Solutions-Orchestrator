# Status — control-plane wiring (this session)

Work completed against [`IMPLEMENTATION_ROADMAP.md`](IMPLEMENTATION_ROADMAP.md).
This is additive progress toward M1/M1.5; nothing here grants unattended merge
or code-editing authority (that stays gated on M2 + Rulesets + human merge).

## Done

- **ORCH-003** — stale `devils-17` → `Sonoran-Solutions` links fixed in
  `dualdex/README.md` (2 occurrences). Orchestrator repo has no other stale refs.
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
- **ORCH-050…083 (control plane)** — router rebuilt and **tested (15/15)**:
  - normalized event context; body limit, timeout, concurrency, clean shutdown;
  - mandatory HMAC + delivery dedupe;
  - fixed-executable dispatch with `shell: false` (injection-proof, tested);
  - trusted-actor + `agent:ready` authorization gate;
  - SQLite `tasks`/`runs`/`deliveries`/`leases`;
  - handoff envelope parser/validator (`schema_version: 1`, legal transitions);
  - per-task git worktree + lease + allowed-path pre-push guard.

## Not yet done (needs a human / next milestone)

- **ORCH-005** final issue confirmation (human decision).
- **ORCH-001/002/004** remaining identity checks: GitHub Actions, badges,
  remotes, Slack links, tokens — verify once integrations are actually wired.
- **M0 manual passes** (ORCH-010…019): Codex plan, human-steered Antigravity
  implementation, Codex review — driven by the human, not this session.
- **M2** (ORCH-090…110): define `ci.sh` for DualDex, add GitHub Actions required
  checks, install Hermes, run deliberate-failure tests.
- **ORCH-081/083** (router): push-time base-SHA movement check + automatic
  stale-lease reaping are recorded but not yet wired into a periodic gate.
- **TOOL-021…029**: GitHub Rulesets on DualDex (required checks + review gate).

## How to run the control plane locally

```bash
cd router
cp config.example.json config.local.json   # set reposRoot/worktreeRoot/allowlist
GITHUB_WEBHOOK_SECRET=... SLACK_WEBHOOK_URL=... node server.mjs
# in another shell:
node test.mjs
```
