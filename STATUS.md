# Status — control-plane wiring (this session)

Work completed against [`IMPLEMENTATION_ROADMAP.md`](IMPLEMENTATION_ROADMAP.md).
This is additive progress toward M1/M1.5; nothing here grants unattended merge
or code-editing authority (that stays gated on M2 + Rulesets + human merge).

## Done

- **ORCH-003** — stale `devils-17` → `Sonoran-Solutions` links fixed in
  `dualdex/README.md` (2 occurrences). Orchestrator repo has no other stale refs.
- **ORCH-005/006/007** — pilot issue confirmed and implemented: Pokemon Unbound
  ROM-hack profile (`app/src/main/assets/profiles/unbound.json`), native C offsets
  and detection in `pokemon_reader.c` / `pokemon_reader.h`, merged into DualDex
  `main` via PR #21.
- **ORCH-011** — planning-pass artifact: [`pilot/planning-pass.md`](pilot/planning-pass.md).
- **ORCH-014/018 (M0.2 Antigravity Build Verification)**:
  - Antigravity executed `./ci.sh test`: 8/8 native C tests passed, 23/23 Gradle unit tests passed.
  - Antigravity executed `./ci.sh build`: successfully assembled debug APK (`app-debug.apk`, 16.8 MB).
  - Resolved `native/quickjs` submodule mapping in `.gitmodules` and auto-initialization in `ci.sh`.
- **ORCH-090/091 (M2.1 Canonical CI Contract & GitHub Actions)**:
  - Added canonical `./ci.sh` in DualDex (PR #22).
  - Added `.github/workflows/ci.yml` for DualDex to enforce required test checks on PRs/pushes.
- **Antigravity Customizations & Rules**:
  - Added `AGENTS.md` to `dualdex` defining agent roles, build contract, and handoff protocols.
  - Added `AGENTS.md` to `sso-orchestrator` defining control plane safety and Slack notification policy.
  - Added `.agents/skills/sonoran-orchestrator/SKILL.md` for seamless agent execution.
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

- **Slack Webhook Rotation**: Previous webhook URL was revoked by Slack policy (HTTP 403); fresh webhook URL needed in `~/.config/sonoran/orchestrator.env`.
- **ORCH-016/017 (M0.3 Review Pass)**: Codex review of the merged Unbound diff (PR #21) against acceptance criteria.
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
