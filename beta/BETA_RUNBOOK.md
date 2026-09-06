# DualDex Beta — Orchestrator Runbook

**Goal:** ship the DualDex public beta (release blockers + full UI redesign) as the
full-scale proof of the Sonoran Solutions orchestrator. Success = the beta ships
and we'd rather use this workflow than work without it.

**Source of truth for scope:** `dualdex/RELEASE_CHECKLIST.md` (273 tasks) and
`dualdex/UI_DESIGN_AUDIT.md` (53 tasks). This runbook does **not** re-plan that
work; it sequences it into executable rings the orchestrator can drive.

---

## Rings (mapped to the checklist's own bug-fix order)

| Ring | Scope | Maps to |
|---|---|---|
| **Ring 1** | Protect saves + stabilize the emulator core + identity/versioning + CI | Tier 1 + Phase 2 (versioning/signing/CI) |
| **Ring 2** | Trustworthy live companion data (ROM detection + engine/layout profile architecture + species mapping #26) | Tier 2 + Phase 1 (Detection/Profile Arch) |
| **Ring 3** | Beta UX: UI redesign ("Quiet Handheld Companion" design system + screen fixes) + controller + first-run | Tier 3 + Phase 5 + UI_DESIGN_AUDIT |
| **Ring 4** | Cleanup + regression: docs, GitHub Releases, signing release builds, soak testing, privacy | Tier 4 + Phases 3/4/7 |

Ring 1 is the only ring with a fully-extracted backlog today
([`ring-1-backlog.md`](ring-1-backlog.md)). Later rings are extracted when the
prior ring is done — no giant up-front backlog.

---

## Safety prerequisites (do before Ring 1 traffic)

- [ ] **GitHub Rulesets on `dualdex`** — require PRs, require the `DualDex CI` check, block force-push. *(human: GitHub Settings)*
- [ ] **Control plane operational** — base-SHA push check + stale-lease auto-reap (in progress this session).
- [ ] **Secrets** — `.env`/webhook already live outside worktrees; move to 1Password before production signing keys are involved.

The CI workflow is already merged and green; it just needs to become a *required* check.

---

## Per-task loop (one task at a time)

```text
1. Plan      — Codex (or DeepSeek for now) writes a scoped envelope:
               acceptance criteria, likely files, risks, test plan.
2. Implement — Antigravity (human-steered) on a feat/<id> branch.
3. Build     — ./ci.sh all locally (Antigravity), then GitHub Actions.
4. Review    — Codex (or DeepSeek) reviews the diff vs. acceptance.
5. Merge     — human (product gate) merges after CI green.
```

Post the five state transitions to Slack via `slack-notify.sh`
(`task-started`, `pr-ready`, `blocked`, `done`, `stopped`). One Slack thread per
issue/PR for detail.

## Roles

| Role | Owner |
|---|---|
| Planner / reviewer | Codex (DeepSeek stand-in until Codex is in the loop) |
| Implementer + local build | Antigravity (human-steered) |
| Build herald (mechanical build fixes) | Hermes (install in Ring 2, when real breakage appears) |
| CI authority | GitHub Actions (required check) |
| Product + merge gate | Human |

## Exit gates

- **After Ring 1:** answer the roadmap's evaluation question — *would we rather
  use this workflow than work normally?* If no, simplify before Ring 2.
- **After Ring 2:** Hermes has fixed ≥1 deliberate mechanical failure and
  correctly refused ≥1 non-mechanical failure.
- **Ring 3 (UI):** the "Quiet Handheld Companion" design system lands before
  per-screen changes, so the redesign doesn't become 53 disconnected tweaks.
- **Beta done:** `RELEASE_CHECKLIST.md` "Beta Definition of Done" + a signed,
  versioned GitHub Release with the required checks green.

## What blocks on the human (not automatable)

1. GitHub Rulesets (Settings → Rules/Rulesets on `dualdex`).
2. Permanent Android signing key + secure backup.
3. Hermes install (Ring 2).
4. Product/scope decisions (which UI changes ship in beta vs. later).
5. Linear + 1Password setup (parallel foundation).
