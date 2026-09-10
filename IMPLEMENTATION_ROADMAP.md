# Sonoran Solutions Orchestrator — Implementation Roadmap

**Purpose:** get the agent stack running without letting orchestration infrastructure become a larger project than the software it is supposed to help ship.

**Pilot repository:** DualDex

**Rule:** do not advance a phase because the infrastructure looks cool. Advance only when the previous phase works on a real task and is making the workflow clearer, safer, or faster.

---

## Current position — September 2026

**Active milestone: M2.3 — deliberate Hermes repair tests.**

- ✅ **M1.5 control plane:** complete for the pilot except **ORCH-080**, which is intentionally deferred until router-owned publication in M2.4.
- ✅ **M2.1 canonical DualDex CI:** complete; `./ci.sh test`, `./ci.sh build`, and `./ci.sh all` are the contract, and the pilot branch ruleset requires `Native & Unit Tests` and `Build Debug APK`.
- ✅ **M2.2 Hermes setup:** complete and merged via Orchestrator PR #8. Hermes runs in a task-private checkout with per-run HOME/state, Bubblewrap filesystem isolation, private `pasta` networking, private-range denial, bounded repair attempts, router-owned post-run Git verification, and durable structured evidence.
- ✅ **F-09 deterministic real-boundary fixture:** complete. Synthetic HTTP traverses the real router → production sandbox → local candidate commit/result → verifier → SQLite → cleanup without calling an LLM.
- ➡️ **Next:** configure a dedicated low-privilege inference credential, then run ORCH-100 through ORCH-105 using real Hermes/model calls.
- ⬜ **M2.4 publication/review:** not started. Hermes still has no push authority; completed candidate checkouts are retained until M2.4 defines publication/rejection retention and garbage collection.
- ⬜ **Evaluation Gate:** required before M3.

Before ORCH-100, do two small prerequisites rather than opening another architecture phase:

1. Add a minimal Orchestrator GitHub Actions workflow so portable router tests are reproduced on GitHub instead of existing only as local evidence.
2. Configure Hermes provider authentication with a dedicated, budget-limited credential that is available only inside the repair worker boundary. Do not expose owner Git/GitHub credentials or broaden filesystem/network access to accomplish model authentication.

---

## Status legend

- [ ] Not started / still required
- [x] Complete
- **GATE** — stop and evaluate before continuing

Suggested issue/task IDs use `ORCH-###` so they can later be copied into GitHub Issues if desired.

---

# Phase P0 — Preflight and identity

**Goal:** avoid wiring integrations around names/configuration that will immediately change.

### P0.1 — Sonoran Solutions identity

- [x] **ORCH-001** Complete the GitHub identity rename to the final Sonoran Solutions namespace.
- [x] **ORCH-002** Verify this orchestrator repo and DualDex resolve correctly under Sonoran Solutions.
- [x] **ORCH-003** Search orchestration/config/docs for hard-coded `devils-17` repository references and update them.
- [ ] **ORCH-004** Re-check GitHub Actions, webhooks, badges, remotes, Slack links, and any tokens/integrations that may reference the old namespace.

### P0.2 — Decide the pilot boundary

- [ ] **ORCH-005** Human-confirm **one real, low-risk DualDex issue** for the first end-to-end benchmark. A candidate and pilot document already exist; final human choice remains.
- [x] **ORCH-006** Write explicit acceptance criteria for the pilot issue.
- [x] **ORCH-007** Record the current/manual workflow so the orchestrator has something to beat.
- [ ] **ORCH-008** Formally record SaveBridge and Dungeon Dispatcher as out of scope for orchestration testing until the DualDex pilot passes M2.

### P0 exit criteria

- GitHub identity is stable enough to wire integrations.
- One DualDex pilot task is human-confirmed.
- Success criteria are known before automation begins.

---

# Phase M0 — Manual role benchmark

**Goal:** preserve a baseline for whether multi-agent handoffs are actually better than working normally.

No daemon/router automation is required in this phase. This phase is partially complete historically and is not the active implementation milestone, but its benchmark data is still needed for the Evaluation Gate.

### M0.1 — Codex planning pass

- [ ] **ORCH-010** Give Codex the human-confirmed DualDex pilot issue.
- [x] **ORCH-011** Produce a planning-pass artifact with scope, acceptance criteria, likely files/components, risks/non-goals, and test plan.
- [ ] **ORCH-012** Confirm the plan does not unnecessarily expand scope for the final chosen pilot issue.

### M0.2 — Antigravity implementation pass

- [ ] **ORCH-013** Create a dedicated feature branch manually.
- [ ] **ORCH-014** Drive Antigravity interactively using the Codex plan.
- [ ] **ORCH-015** Commit implementation without involving Hermes/router automation.

### M0.3 — Review/debug pass

- [ ] **ORCH-016** Have Codex review the actual diff against the acceptance criteria.
- [ ] **ORCH-017** Fix review findings manually or with the appropriate agent.
- [ ] **ORCH-018** Run the repo's canonical build/tests.
- [ ] **ORCH-019** Human-review and merge the pilot PR if correct.

### M0.4 — Benchmark notes

- [ ] **ORCH-020** Record where context was lost between agents.
- [ ] **ORCH-021** Record which role assignment felt forced or redundant.
- [ ] **ORCH-022** Record approximate human intervention points.
- [ ] **ORCH-023** Decide whether Codex → implementation worker → Codex is actually useful enough to automate.

### M0 exit criteria

- One real DualDex change has passed through the proposed roles.
- The role split is useful enough to keep.
- Known handoff information requirements are documented.

**GATE:** if manual multi-agent handoff creates more overhead than doing the task normally, simplify the role model before expanding automation.

---

# Phase M1 — Visibility without autonomy

**Goal:** make agent/project activity visible in Slack without giving Slack or webhooks the ability to launch dangerous work yet.

### M1.1 — Slack channel structure

- [ ] **ORCH-030** Keep `#dual-dex` as the DualDex project channel.
- [ ] **ORCH-031** Create `#agent-ops` for orchestrator-wide failures/alerts when needed.
- [ ] **ORCH-032** Repurpose/archive generic placeholder channels that will not be used.
- [ ] **ORCH-033** Do **not** create separate `#codex`, `#hermes`, or worker-specific channels; organize around projects.

### M1.2 — Notification policy

- [x] **ORCH-034** Define the default top-level project events: task assigned/started; PR ready/verification started; blocked/escalated; completed/merged; stopped/cancelled.
- [x] **ORCH-035** Remove/disable default notifications for every file edit/tool call.
- [ ] **ORCH-036** Use a single Slack thread per GitHub issue/PR when detailed discussion is useful.

### M1.3 — Secret/config cleanup

- [x] **ORCH-037** Move Slack webhook/config ownership outside agent-controlled repository worktrees.
- [x] **ORCH-038** Stop sourcing arbitrary task-repository `.env` files as executable Bash configuration.
- [x] **ORCH-039** Confirm `.env`, tokens, webhook URLs, and local config cannot be committed through the normal worker path.

### M1.4 — GitHub → Slack smoke test

- [ ] **ORCH-040** Send a dry-run notification.
- [ ] **ORCH-041** Send a real test event to `#dual-dex`.
- [ ] **ORCH-042** Trigger a test PR/commit event and verify the message is concise and links back to GitHub.
- [ ] **ORCH-043** Confirm duplicate systems are not both posting the same event.

### M1 exit criteria

- A real DualDex PR can produce useful Slack visibility.
- Slack is readable rather than noisy.
- No untrusted Slack/GitHub message launches an agent.

---

# Phase M1.5 — Safety and control plane

**Status: pilot control-plane requirements complete except ORCH-080 publication authority.**

**Goal:** make unattended dispatch technically safe enough to test.

## M1.5.1 — Router event model

- [x] **ORCH-050** Add normalized event context: delivery ID, event/action, repo, issue/PR, actor, branch, head/base SHA, labels/authorization facts.
- [x] **ORCH-051** Add a request-body size limit.
- [x] **ORCH-052** Add dispatch/execution timeout support.
- [x] **ORCH-053** Add cancellation/clean shutdown behavior.
- [x] **ORCH-054** Add per-task concurrency protection / single-live-execution semantics.

## M1.5.2 — Webhook security

- [x] **ORCH-055** Make valid GitHub signature verification mandatory outside explicit local-dev mode.
- [x] **ORCH-056** Reject missing/invalid signatures.
- [x] **ORCH-057** Store GitHub delivery IDs and make duplicate deliveries idempotent.

## M1.5.3 — Safe process dispatch

- [x] **ORCH-058** Remove webhook-derived command strings executed with `shell: true`.
- [x] **ORCH-059** Define worker executables as fixed configuration.
- [x] **ORCH-060** Pass validated structured values as argument arrays with `shell: false`.
- [x] **ORCH-061** Add tests proving malicious branch/user/issue strings cannot become shell syntax.

## M1.5.4 — Authorization gate

- [x] **ORCH-062** Implement trusted-user allowlist support.
- [x] **ORCH-063** Implement `agent:ready` (or equivalent) label authorization.
- [x] **ORCH-064** Require the authorizing label/action to come from a trusted actor.
- [x] **ORCH-065** Verify a random public issue cannot launch a worker.
- [x] **ORCH-066** Log authorization decisions without logging secrets.

## M1.5.5 — SQLite state store

- [x] **ORCH-067** Add SQLite to the router.
- [x] **ORCH-068** Create durable task state.
- [x] **ORCH-069** Create durable run state, including repair-specific attempt accounting.
- [x] **ORCH-070** Create delivery deduplication state.
- [x] **ORCH-071** Create lease state for worktree ownership.
- [x] **ORCH-072** Verify router restart preserves durable state and completed deliveries do not re-run.

## M1.5.6 — Handoff parser/validator

- [x] **ORCH-073** Implement `schema_version: 1` parsing for `handoff/handoff-envelope.md`.
- [x] **ORCH-074** Validate required fields and legal state transitions.
- [x] **ORCH-075** Treat prose outside the envelope as untrusted context.
- [x] **ORCH-076** Add adversarial fixtures for invalid/malicious/stale/out-of-scope/exceeded-attempt inputs.

## M1.5.7 — Worktree + lease isolation

- [x] **ORCH-077** Define the local worktree root outside the orchestrator source checkout.
- [x] **ORCH-078** Create one task-private standalone Git checkout per task/lease with private refs/index/config/objects.
- [x] **ORCH-079** Record worktree path + base SHA + owner in SQLite.
- [ ] **ORCH-080** Verify lease ownership before router-owned commit/push. **Intentionally open until M2.4; workers currently cannot push.**
- [x] **ORCH-081** Stop/escalate if the authoritative base/branch moved unexpectedly.
- [x] **ORCH-082** Enforce worker-baseline AND optional task `allowed_paths` scope through router-owned verification.
- [x] **ORCH-083** Clean/reap expired active task checkouts safely without deleting a newer/live execution.
- [x] **ORCH-140 (lifecycle groundwork)** Retries reconstruct clean task-private repositories from authoritative Git state; incompatible branches fail closed.
- [x] **Single live execution per task** — live/ambiguous execution states refuse redispatch rather than clobbering another worker.

### M1.5 exit criteria

**Passed for autonomous local repair testing.** Signed/authorized events create exactly one durable isolated execution; duplicate/untrusted/malicious inputs fail closed. Publication authority remains deliberately absent until M2.4.

---

# Phase M2 — Canonical CI + Hermes repair pilot

**Goal:** prove bounded autonomous repair while keeping CI and merge authority independent from Hermes.

## M2.1 — Define the DualDex CI contract — COMPLETE

- [x] **ORCH-090** Canonical commands: `./ci.sh build`, `./ci.sh test`, `./ci.sh all` (DualDex PR #28).
- [x] **ORCH-091** Commands are deterministic/non-interactive.
- [x] **ORCH-092** Developer/agent can run the same commands locally.
- [x] **ORCH-093** GitHub Actions runs the same CI contract (`Native & Unit Tests`, `Build Debug APK`).
- [x] **ORCH-094** Pilot branch/ruleset requires those checks and blocks force-push/deletion; human merge remains authoritative.

## M2.2 — Hermes setup — COMPLETE / MERGED

Merged through Orchestrator PR #8 after adversarial review and remediation.

- [x] **ORCH-095** Install/configure Hermes on the self-hosted machine (`hermes-agent` v0.21.1).
- [x] **ORCH-096** Give Hermes only the task-private checkout and minimum environment; isolate filesystem/process state and use supervised `pasta` networking with namespace-local private-range denial while allowing public DNS/HTTPS.
- [x] **ORCH-097** Fix-build skill consumes router-owned task/run/lease scope and emits a bounded structured result file.
- [x] **ORCH-098** Enforce repair `maxAttempts: 3`; attempt 4 never launches, including after `repair:retry`.
- [x] **ORCH-099** Require escalation/blocked state for API/schema/product/security and other human-decision boundaries.

Additional M2.2 evidence now on `main`:

- per-run HOME and run-state isolation;
- no worker owner Git/GitHub/SSH credentials and no worker push authority;
- router-owned post-run Git verification in a separate network-disabled verifier sandbox;
- hostile Git configuration, fsmonitor, replacement-object, dirty-tree, path-scope, and result-spoofing regressions;
- bounded verifier execution/output;
- `no_fix` is a failed consumed repair attempt, not success;
- trusted `repair:retry` never resets the three-attempt budget;
- F-09 real deterministic boundary fixture proves HTTP → router → private checkout → production sandbox → external result → verifier → SQLite → cleanup without an LLM.

Completed candidate checkouts remain retained for review. M2.4 must define their retention/garbage-collection policy as part of publication/rejection; the stale active-lease reaper must not delete released candidate artifacts.

## M2.3 — Deliberate failure tests — CURRENT

Create controlled failures rather than trusting the first real incident. These are the first tests that use a real inference provider/model.

**M2.3 prerequisites:** dedicated low-privilege/budget-limited provider authentication; recommended small Orchestrator GitHub Actions smoke workflow for portable router tests.

- [ ] **ORCH-100** Trivial compile/syntax failure Hermes should fix.
- [ ] **ORCH-101** Narrow failing unit test with an obvious implementation bug.
- [ ] **ORCH-102** Proposed fix makes more tests fail → bad attempt is discarded/reconstructed rather than becoming the accepted candidate.
- [ ] **ORCH-103** Failure requires behavior/API decision → Hermes escalates without guessing.
- [ ] **ORCH-104** Failure cannot be fixed within max attempts → Hermes stops/escalates after the bounded budget.
- [ ] **ORCH-105** Hermes local run passes but GitHub Actions fails → CI remains authoritative and task is not marked done.

## M2.4 — Review + merge policy

- [ ] **ORCH-106** Router publishes the verified Hermes candidate to the assigned task branch/PR; finish ORCH-080 as part of this authority boundary.
- [ ] **ORCH-107** Codex/senior reviewer reviews the actual candidate diff.
- [ ] **ORCH-108** GitHub Actions verifies required checks.
- [ ] **ORCH-109** Human performs the merge.
- [ ] **ORCH-110** Keep automatic merge disabled during the pilot.
- [ ] Define completed-candidate checkout retention/garbage collection after publication/rejection.

### M2 exit criteria

- Hermes fixes at least one deliberate mechanical failure with a real model.
- Hermes correctly refuses/escalates at least one non-mechanical failure.
- GitHub Actions, not Hermes, determines required-check status.
- Candidate publication is router-owned and lease-verified; the worker never receives merge authority.
- Human merge remains required.

---

# Evaluation Gate — Is this actually helping?

**Do this before M3.**

- [ ] **ORCH-120** Compare human intervention in M0 vs M2.
- [ ] **ORCH-121** Count duplicate/noisy Slack events.
- [ ] **ORCH-122** Count failed/incorrect agent handoffs.
- [ ] **ORCH-123** Count Hermes repair attempts that helped vs created churn.
- [ ] **ORCH-124** Record time spent maintaining the orchestrator itself.
- [ ] **ORCH-125** Ask the only question that matters: **would I rather use this workflow for the next DualDex task than work normally?**

### Decision

- [ ] **Continue:** clear productivity/visibility/safety benefit → proceed to M3.
- [ ] **Simplify:** useful pieces exist but full stack is too heavy → keep CI/Slack/worktrees and remove unnecessary agents.
- [ ] **Pause:** orchestration maintenance exceeds the benefit → return effort to product work and revisit later.

---

# Phase M3 — Structured handoff automation

**Goal:** automate the boring baton passing after the control plane is proven.

## M3.1 — Planner automation

- [ ] **ORCH-130** Authorize a task through the trusted gate.
- [ ] **ORCH-131** Router dispatches a planning run to the configured planning worker.
- [ ] **ORCH-132** Planner updates the validated envelope with acceptance criteria/scope.
- [ ] **ORCH-133** Router validates the envelope before implementation.

## M3.2 — Implementation handoff

- [ ] **ORCH-134** Router creates the implementation worktree/lease.
- [ ] **ORCH-135** Post one `ready for implementation` event to the project Slack channel.
- [ ] **ORCH-136** Keep the primary implementation worker human-steered initially.
- [ ] **ORCH-137** Only experiment with headless implementation after the manual path is reliable.

## M3.3 — Review + verification automation

- [ ] **ORCH-138** Implementation completion moves task to `review`.
- [ ] **ORCH-139** Reviewer receives a review run against the actual diff.
- [ ] **ORCH-140** Required fixes return to the appropriate worker with a new run ID/lease.
- [ ] **ORCH-141** Accepted review moves task to `verification`.
- [ ] **ORCH-142** Required GitHub Actions checks gate completion.
- [ ] **ORCH-143** Human merge marks the task `done`.

## M3.4 — Capability-tier model router

**Goal:** turn [`MODEL_ROUTING.md`](MODEL_ROUTING.md) into deterministic, provider-neutral routing behavior. Choose the cheapest capable worker, preserve evidence between attempts, escalate only for a reason, and step back down once the hard unknown is resolved.

- [ ] **ORCH-144** Extend task/run metadata and handoff schema with provider-neutral routing fields (`work_class`, `capability_tier`, max/fallback tier, evidence packet, budget/approval requirements).
- [ ] **ORCH-145** Add a configurable model/worker registry mapping capability tiers to available providers, models, harnesses, tools, and cost policy.
- [ ] **ORCH-146** Implement deterministic cheapest-capable routing subject to task capability, repo policy, required tools, availability, and budget.
- [ ] **ORCH-147** Preserve structured evidence packets before escalation: original goal, confirmed facts, commands/tests, failed hypotheses, logs/diffs/artifacts, and the specific unresolved question.
- [ ] **ORCH-148** Implement bounded escalation + step-down. Premium research resolves the unknown; routine implementation returns to cheaper tiers.
- [ ] **ORCH-149** Add routing regressions for tier selection, promotion, research triggers, provider outage/fallback, budget/approval gates, step-down, and invariant permission boundaries.

### M3 exit criteria

One real DualDex issue can move from authorized plan → implementation → review → CI → human merge with durable state and no ambiguous ownership.

At least one controlled pilot task can also be classified and routed through the capability ladder with a durable evidence packet, deterministic escalation/step-down behavior, and no provider/model name acting as the source of truth for task state.

**GATE:** do not enable automatic premium-model escalation until routing tests, budget limits, evidence handoffs, and required human approval gates have been exercised deliberately.

---

# Phase M4 — Operations and convenience

**Goal:** add quality-of-life features after the core workflow is trustworthy.

## M4.1 — Slack control app

- [ ] **ORCH-150** Replace/augment incoming webhooks with a real Sonoran Orchestrator Slack app.
- [ ] **ORCH-151** Add authenticated `status <task>`.
- [ ] **ORCH-152** Add authenticated `stop <task>`.
- [ ] **ORCH-153** Add authenticated `retry <task>` with bounded semantics.
- [ ] **ORCH-154** Add `approve` only if it maps to an explicit router/GitHub authorization transition.
- [ ] **ORCH-155** Route orchestration/system failures to `#agent-ops`.

## M4.2 — DeepSeek specialist workflows

- [ ] **ORCH-156** Add DeepSeek Harness as an optional specialist worker, not the state owner.
- [ ] **ORCH-157** Test parallel root-cause investigation on a known hard bug.
- [ ] **ORCH-158** Test multi-agent review/research without granting extra merge authority.
- [ ] **ORCH-159** Measure whether swarm runs produce better results than a single senior debugging pass.

## M4.3 — Remote operations

- [ ] **ORCH-160** Add private remote access only if it solves an actual need.
- [ ] **ORCH-161** Prefer a private/authenticated tunnel rather than exposing the router publicly.
- [ ] **ORCH-162** Confirm remote exposure does not bypass webhook/auth rules.

## M4.4 — Reliability/observability

- [ ] **ORCH-163** Add basic status/health view for active tasks and leases.
- [ ] **ORCH-164** Add log rotation/retention.
- [ ] **ORCH-165** Add stuck-run detection.
- [ ] **ORCH-166** Add provider/model failure classification and clean escalation.

## M4.5 — Model usage & capacity hub

**Goal:** give humans and the capability-tier router one normalized, near-real-time view of which model capacity is actually available. See [`MODEL_USAGE_HUB.md`](MODEL_USAGE_HUB.md).

- [ ] **ORCH-167** Build provider-capacity adapters + normalized capacity snapshots with provenance/freshness and no fabricated quota precision.
- [ ] **ORCH-168** Build the human-facing usage hub/persistence layer for availability, quota/reset state, rate limits, active reservations, usage history, budgets/reserves, and stale telemetry warnings.
- [ ] **ORCH-169** Integrate capacity into deterministic routing without weakening capability/security requirements; add capacity-aware routing regressions.

### M4 exit criteria

The operations layer provides a trustworthy view of active work and configured model capacity. A human can see model availability/usage in one place, and the router can make auditable capacity-aware choices without relying on fabricated quota precision or provider-specific task semantics.

---

# Phase M5 — Expand beyond the pilot

**Goal:** use the system on products, not just on itself.

## M5.1 — SaveBridge

- [ ] **ORCH-170** Add SaveBridge only after DualDex M3 is reliable.
- [ ] **ORCH-171** Define SaveBridge canonical CI/build commands.
- [ ] **ORCH-172** Configure `#savebridge` project notifications.
- [ ] **ORCH-173** Start with low-risk implementation/test tasks, not storage architecture decisions.
- [ ] **ORCH-174** Keep product/storage-safety decisions human-controlled.

## M5.2 — Dungeon Dispatcher

- [ ] **ORCH-175** Add Dungeon Dispatcher after the game prototype has a proven core loop.
- [ ] **ORCH-176** Let agents own plumbing/tooling/tests/data-structure work.
- [ ] **ORCH-177** Keep `is this fun?` and core game-design decisions human-controlled.
- [ ] **ORCH-178** Configure `#dungeon-dispatcher` only when active development begins.

---

# Future auto-merge gate — deliberately parked

Do **not** implement this during M0–M3.

Before allowing any unattended merge, require evidence and a written policy covering:

- [ ] **ORCH-190** Minimum successful reviewed agent PR history.
- [ ] **ORCH-191** Exact low-risk change categories eligible for auto-merge.
- [ ] **ORCH-192** Required reviewers/checks.
- [ ] **ORCH-193** Test-deletion/test-weakening detection.
- [ ] **ORCH-194** Dependency/security-sensitive change exclusions.
- [ ] **ORCH-195** Emergency global kill switch.
- [ ] **ORCH-196** Audit/revert procedure.

Until all of these exist, **agent-authored changes require a human merge**.

---

# Immediate next 10 tasks

Starting from the current post-M2.2 state:

1. [ ] **Housekeeping:** add minimal GitHub Actions for the Orchestrator's portable router tests and prove it with a harmless PR.
2. [ ] **M2.3 prerequisite:** create a dedicated, budget-limited Hermes inference credential and wire it only into the repair sandbox.
3. [ ] **ORCH-100:** run the first real Hermes repair against a deliberately trivial compile/syntax failure.
4. [ ] **ORCH-101:** run a narrow failing-unit-test repair.
5. [ ] **ORCH-102:** prove a repair that worsens tests is not accepted and the next attempt starts clean.
6. [ ] **ORCH-103:** prove a behavior/API decision escalates rather than being guessed.
7. [ ] **ORCH-104:** prove three failed repair attempts stop the loop and attempt 4 never launches.
8. [ ] **ORCH-105:** prove GitHub Actions remains authoritative when Hermes passes locally but required CI fails.
9. [ ] **M2.4 / ORCH-080 + ORCH-106–110:** implement router-owned candidate publication, senior review, CI gating, retention/GC, and human-only merge.
10. [ ] **Evaluation Gate / ORCH-120–125:** compare M0 vs M2 and decide whether the system has earned M3.

Do not begin M3 until the Evaluation Gate says the workflow is genuinely worth keeping.