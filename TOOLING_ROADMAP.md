# Sonoran Solutions — Supporting Tooling Roadmap

**Purpose:** phase in Linear, GitHub Rulesets, 1Password, Sentry, Tailscale, Renovate, Taskfile, and (only if justified later) Dagger without letting the tooling stack become its own full-time project.

This roadmap runs **alongside** `IMPLEMENTATION_ROADMAP.md`. Core orchestrator milestones still control when unattended agents are allowed to execute. Completing a tooling item never bypasses those gates.

---

## Status legend

- [ ] Not started
- [x] Complete
- **GATE** — do not proceed until the prerequisite is actually useful/working

Task IDs use `TOOL-###` so they can be moved into Linear later without colliding with `ORCH-###` implementation tasks.

---

# T0 — Planning foundation: Linear

**When:** after the Sonoran Solutions GitHub identity is stable; can happen before M0.

**Goal:** create one clean place for product planning without changing GitHub/router execution authority.

- [ ] **TOOL-001** Create/configure the Sonoran Solutions Linear workspace/team structure.
- [ ] **TOOL-002** Create top-level planning areas/projects for:
  - DualDex;
  - SaveBridge;
  - Dungeon Dispatcher;
  - Sonoran Infrastructure / Orchestrator.
- [ ] **TOOL-003** Import/recreate only the **active** roadmap work; do not turn old notes into hundreds of fake backlog tickets.
- [ ] **TOOL-004** Define a minimal issue taxonomy (feature, bug, chore/infrastructure, research/spike).
- [ ] **TOOL-005** Define a minimal priority policy so agents cannot interpret every backlog item as urgent.
- [ ] **TOOL-006** Link Linear to GitHub for branch/PR visibility.
- [ ] **TOOL-007** Link Linear to Slack for human planning/update workflows.
- [ ] **TOOL-008** Document the authority boundary: Linear issue existence **does not authorize agent execution**.
- [ ] **TOOL-009** Pilot the workflow with the selected DualDex M0 task.
- [ ] **TOOL-010** Decide whether Linear should be the long-term backlog source of truth after the pilot.

### Optional later Linear automation

- [ ] **TOOL-011** Evaluate Linear MCP access for Codex/planning agents.
- [ ] **TOOL-012** Permit read/search first.
- [ ] **TOOL-013** Permit issue drafting/update only after taxonomy/status conventions are stable.
- [ ] **TOOL-014** Keep prioritization/initiative decisions human-controlled.
- [ ] **TOOL-015** Evaluate GitHub Issue synchronization only after the execution authorization model is proven; do not enable broad bidirectional sync by default.

### T0 exit criteria

A human can look at Linear and understand what Sonoran Solutions is working on next, while GitHub/router state still clearly answers what is actually being executed.

---

# T1 — Repository enforcement: GitHub Rulesets

**When:** before M1.5 grants unattended write access.

**Goal:** make critical merge/branch policy independent from agent prompts and router behavior.

- [x] **TOOL-020** Inventory current default/release branches for active repos.
- [x] **TOOL-021** Configure a baseline ruleset for DualDex (`protect-main`).
- [x] **TOOL-022** Require PRs before merge to the protected/default branch.
- [x] **TOOL-023** Require the canonical GitHub Actions checks once M2 CI is defined (`Native & Unit Tests`, `Build Debug APK`).
- [x] **TOOL-024** Block force pushes to protected branches.
- [x] **TOOL-025** Restrict direct pushes/bypass permissions to the minimum practical set (admin `RepositoryRole` bypass only).
- [ ] **TOOL-026** Require review for agent-authored feature/fix work during the pilot (deliberately `0` approvals for the solo-repo pilot).
- [ ] **TOOL-027** Verify the router/agent credential cannot silently bypass the normal merge policy.
- [ ] **TOOL-028** Test a failing required check and confirm merge is blocked.
- [ ] **TOOL-029** Test an unauthorized direct push/merge path and confirm it is blocked where intended.

### T1 exit criteria

A worker can push a candidate branch/PR, but repository policy independently controls whether that candidate can land.

---

# T2 — Secret management: 1Password

**When:** begin during M1 secret cleanup; complete before the orchestrator accumulates production credentials.

**Goal:** stop growing plaintext `.env` sprawl and minimize what each worker can see.

- [ ] **TOOL-030** Create a dedicated Sonoran/orchestrator vault structure.
- [ ] **TOOL-031** Inventory existing local credentials/webhooks/tokens.
- [ ] **TOOL-032** Classify which secrets belong in:
  - 1Password/local orchestration;
  - GitHub Actions secrets;
  - product/release-specific storage.
- [ ] **TOOL-033** Move Slack/orchestrator credentials out of agent-controlled worktrees.
- [ ] **TOOL-034** Move model/provider credentials into controlled secret storage.
- [ ] **TOOL-035** Configure a restricted automated identity/service account if unattended processes need secret access.
- [ ] **TOOL-036** Inject secrets into the router/worker process at runtime rather than copying broad secret files into worktrees.
- [ ] **TOOL-037** Define per-worker minimum credential sets.
- [ ] **TOOL-038** Verify secrets do not appear in router logs, agent prompts, handoff envelopes, GitHub issues/PRs, or Slack.
- [ ] **TOOL-039** Document credential rotation/revocation after a suspected leak.

### T2 exit criteria

No autonomous task requires a general-purpose plaintext project `.env` containing unrelated Sonoran credentials.

---

# T3 — Production feedback: Sentry

**When:** per product as it approaches a meaningful public beta/release. Not required for the orchestrator pilot itself unless the orchestrator becomes a deployed service worth monitoring.

**Goal:** turn real-user failures into evidence-driven work.

## T3.1 — Product integration

- [ ] **TOOL-050** Choose the first product that actually needs Sentry (likely DualDex public beta or SaveBridge).
- [ ] **TOOL-051** Configure crash/error reporting with privacy-conscious defaults.
- [ ] **TOOL-052** Include release/version metadata in builds.
- [ ] **TOOL-053** Confirm symbols/source mappings/context are sufficient for useful diagnosis.
- [ ] **TOOL-054** Verify privacy/support documentation matches the telemetry actually collected.

## T3.2 — Workflow integration

- [ ] **TOOL-055** Define the Sentry → human triage → Linear bug flow.
- [ ] **TOOL-056** Link actionable bugs to GitHub execution work only after normal authorization.
- [ ] **TOOL-057** Ensure a raw Sentry event cannot directly launch a write-capable worker.
- [ ] **TOOL-058** Add Sentry evidence/release context to Codex debugging inputs when useful.
- [ ] **TOOL-059** After a fix ships, verify the regression/error actually declines or disappears.

## T3.3 — Avoid competing repair bots

- [ ] **TOOL-060** Keep automatic Sentry-generated code fixes/PRs disabled during the Sonoran repair pilot unless explicitly testing them as an alternative.
- [ ] **TOOL-061** If evaluated later, define ownership so Sentry automation and Hermes/Codex cannot race on the same bug.

### T3 exit criteria

A real production problem can travel from Sentry evidence → planned/authorized work → tested fix → release → verified production outcome without bypassing the Sonoran gates.

---

# T4 — Private networking: Tailscale

**When:** M4 remote-operations phase, or sooner only if a real private-machine access need appears.

**Goal:** remotely reach trusted development/build resources without exposing the router as a normal public service.

- [ ] **TOOL-070** Create/configure the Sonoran tailnet/device policy.
- [ ] **TOOL-071** Join the primary orchestrator/development box.
- [ ] **TOOL-072** Join only the personal devices that actually need remote access.
- [ ] **TOOL-073** Keep router authentication/webhook validation enabled even over the private network.
- [ ] **TOOL-074** Define ACL/grant rules so services/devices get minimum access.
- [ ] **TOOL-075** Test private router/status access without opening a public listener unnecessarily.
- [ ] **TOOL-076** Evaluate an ephemeral CI identity only if GitHub Actions genuinely needs access to a private build/test resource.
- [ ] **TOOL-077** If physical Android-device automation becomes useful, prototype a private runner/build-box → device workflow.
- [ ] **TOOL-078** Document device removal/key revocation for a lost or retired machine.

### T4 exit criteria

Remote operations work privately without weakening the orchestrator's normal trust/auth model.

---

# T5 — Dependency maintenance: Renovate

**When:** after multiple active repos make dependency upkeep repetitive; not necessary to prove M0–M3.

**Goal:** centralize dependency maintenance without generating PR spam or bypassing review.

- [ ] **TOOL-090** Inventory active package ecosystems across Sonoran repos.
- [ ] **TOOL-091** Configure Renovate on one pilot repo.
- [ ] **TOOL-092** Enable/use a dependency dashboard or equivalent consolidated maintenance view.
- [ ] **TOOL-093** Group obviously related updates where that reduces noise.
- [ ] **TOOL-094** Require manual approval/review for major/platform-sensitive updates.
- [ ] **TOOL-095** Route Renovate PRs through the normal GitHub Actions/Ruleset requirements.
- [ ] **TOOL-096** Keep Renovate auto-merge disabled initially.
- [ ] **TOOL-097** Measure PR volume/noise for a month of real maintenance.
- [ ] **TOOL-098** Only consider narrow low-risk patch/dev-tool auto-merge after the main future auto-merge gate is satisfied.

### T5 exit criteria

Dependency maintenance becomes more visible and less manual without drowning the repo in low-value PRs.

---

# T6 — Command standardization: Taskfile evaluation

**When:** when SaveBridge/other repos make command inconsistency annoying.

**Goal:** determine whether one command vocabulary makes humans and agents more reliable.

- [ ] **TOOL-110** Compare current `ci.sh`/repo-specific command conventions across active projects.
- [ ] **TOOL-111** Identify duplicated build/test/lint/release command glue.
- [ ] **TOOL-112** Prototype a `Taskfile.yml` in one repo without deleting the proven canonical CI path.
- [ ] **TOOL-113** Evaluate commands such as `task build`, `task test`, `task lint`, `task ci`, and platform-specific tasks.
- [ ] **TOOL-114** Test human, Codex, Hermes, and GitHub Actions use of the same task interface.
- [ ] **TOOL-115** Adopt only if it meaningfully reduces per-repo instructions/duplication.
- [ ] **TOOL-116** If adopted, document a small shared Sonoran command contract.

### T6 exit criteria

Either Taskfile clearly reduces command glue and becomes the shared interface, or the existing `ci.sh` contract remains because it is simpler.

---

# T7 — Dagger decision gate (parked)

**When:** future only.

**Goal:** prevent adding a portable CI framework without an actual portability problem.

Do not begin implementation unless one or more of these pains exists repeatedly:

- local and GitHub Actions results diverge;
- CI pipeline logic is heavily duplicated across environments;
- self-hosted runner behavior is difficult to reproduce;
- cross-project CI reuse becomes a significant maintenance burden.

If that happens:

- [ ] **TOOL-130** Document the concrete CI portability failures Dagger is expected to solve.
- [ ] **TOOL-131** Build a small comparison prototype against the existing GitHub Actions + canonical command path.
- [ ] **TOOL-132** Measure complexity, runtime, cache behavior, and debugging experience.
- [ ] **TOOL-133** Adopt only if the benefit is obvious enough to justify another infrastructure layer.

Until then: **do nothing.**

---

# Recommended near-term order

These are the tooling tasks worth mixing into the existing orchestrator work first:

1. [ ] **TOOL-001** Set up Linear.
2. [ ] **TOOL-002** Create the four active planning areas/projects.
3. [ ] **TOOL-006** Link Linear ↔ GitHub.
4. [ ] **TOOL-008** Document that Linear does not authorize execution.
5. [ ] **TOOL-021** Configure the initial DualDex GitHub Ruleset.
6. [ ] **TOOL-022** Require PRs before protected-branch merge.
7. [ ] **TOOL-030** Create the Sonoran 1Password vault structure.
8. [ ] **TOOL-031** Inventory/migrate current orchestration secrets.
9. [ ] Continue the core `M0 → M1 → M1.5` orchestrator roadmap.
10. [ ] Add Sentry/Tailscale/Renovate only when their trigger conditions become real.

The goal is **not** to finish every TOOL task before writing product code. Linear, Rulesets, and secret hygiene improve the foundation; everything else should arrive just-in-time.
