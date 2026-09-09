# Sonoran Solutions Orchestrator — Implementation Roadmap

**Purpose:** get the agent stack running without letting orchestration infrastructure become a larger project than the software it is supposed to help ship.

**Pilot repository:** DualDex

**Rule:** do not advance a phase because the infrastructure looks cool. Advance only when the previous phase works on a real task and is making the workflow clearer, safer, or faster.

---

## Status legend

- [ ] Not started
- [x] Complete
- **GATE** — stop and evaluate before continuing

Suggested issue/task IDs use `ORCH-###` so they can later be copied into GitHub Issues if desired.

---

# Phase P0 — Preflight and identity

**Goal:** avoid wiring integrations around names/configuration that will immediately change.

### P0.1 — Sonoran Solutions identity

- [ ] **ORCH-001** Complete the planned GitHub identity rename to the final Sonoran Solutions username before configuring long-lived external integrations.
- [ ] **ORCH-002** Verify this orchestrator repo and DualDex resolve correctly after the rename.
- [ ] **ORCH-003** Search orchestration/config/docs for hard-coded `devils-17` repository references and update them.
- [ ] **ORCH-004** Re-check GitHub Actions, webhooks, badges, remotes, Slack links, and any tokens/integrations that may reference the old namespace.

### P0.2 — Decide the pilot boundary

- [ ] **ORCH-005** Select **one real, low-risk DualDex issue** for the first end-to-end benchmark.
- [ ] **ORCH-006** Write explicit acceptance criteria for that issue.
- [ ] **ORCH-007** Record the current/manual workflow so the orchestrator has something to beat.
- [ ] **ORCH-008** Declare SaveBridge and Dungeon Dispatcher **out of scope for orchestration testing** until the DualDex pilot passes M2.

### P0 exit criteria

- GitHub identity is stable enough to wire integrations.
- One DualDex pilot task is selected.
- Success criteria are known before automation begins.

---

# Phase M0 — Manual role benchmark

**Goal:** prove that the proposed employee/role split produces better work before automating handoffs.

No daemon/router automation is required in this phase.

### M0.1 — Codex planning pass

- [ ] **ORCH-010** Give Codex the selected DualDex issue.
- [ ] **ORCH-011** Have Codex produce:
  - scoped task statement;
  - acceptance criteria;
  - likely files/components;
  - known risks/non-goals;
  - test plan.
- [ ] **ORCH-012** Confirm the plan does not unnecessarily expand scope.

### M0.2 — Antigravity implementation pass

- [ ] **ORCH-013** Create a dedicated feature branch manually.
- [ ] **ORCH-014** Drive Antigravity interactively using the Codex plan.
- [ ] **ORCH-015** Commit implementation without involving Hermes/router automation.

### M0.3 — Review/debug pass

- [ ] **ORCH-016** Have Codex review the actual diff against the acceptance criteria.
- [ ] **ORCH-017** Fix review findings manually or with the appropriate agent.
- [ ] **ORCH-018** Run the repo's current build/tests.
- [ ] **ORCH-019** Human-review and merge the pilot PR if correct.

### M0.4 — Benchmark notes

- [ ] **ORCH-020** Record where context was lost between agents.
- [ ] **ORCH-021** Record which role assignment felt forced or redundant.
- [ ] **ORCH-022** Record approximate human intervention points.
- [ ] **ORCH-023** Decide whether Codex → Antigravity → Codex is actually useful enough to automate.

### M0 exit criteria

- One real DualDex change has passed through the proposed roles.
- The role split is useful enough to keep.
- Known handoff information requirements are documented.

**GATE:** if manual multi-agent handoff creates more overhead than doing the task normally, simplify the role model before building the router.

---

# Phase M1 — Visibility without autonomy

**Goal:** make agent/project activity visible in Slack without giving Slack or webhooks the ability to launch dangerous work yet.

### M1.1 — Slack channel structure

- [ ] **ORCH-030** Keep `#dual-dex` as the DualDex project channel.
- [ ] **ORCH-031** Create `#agent-ops` for orchestrator-wide failures/alerts when needed.
- [ ] **ORCH-032** Repurpose/archive generic placeholder channels that will not be used.
- [ ] **ORCH-033** Do **not** create separate `#codex`, `#hermes`, or `#antigravity` channels; organize around projects.

### M1.2 — Notification policy

- [ ] **ORCH-034** Define the only default top-level project events:
  - task assigned/started;
  - PR ready/verification started;
  - blocked/escalated;
  - completed/merged;
  - stopped/cancelled.
- [ ] **ORCH-035** Remove/disable default notifications for every file edit/tool call.
- [ ] **ORCH-036** Use a single Slack thread per GitHub issue/PR when detailed discussion is useful.

### M1.3 — Secret/config cleanup

- [ ] **ORCH-037** Move Slack webhook/config ownership outside agent-controlled repository worktrees.
- [ ] **ORCH-038** Stop sourcing arbitrary task-repository `.env` files as executable Bash configuration.
- [ ] **ORCH-039** Confirm `.env`, tokens, webhook URLs, and local config cannot be committed.

### M1.4 — GitHub → Slack smoke test

- [ ] **ORCH-040** Send a dry-run notification.
- [ ] **ORCH-041** Send a real test event to `#dual-dex`.
- [ ] **ORCH-042** Trigger a test PR/commit event and verify the message is concise and links back to GitHub.
- [ ] **ORCH-043** Confirm duplicate systems are not both posting the same event.

### M1 exit criteria

- A real DualDex PR can produce useful Slack visibility.
- Slack is readable rather than noisy.
- No untrusted Slack/GitHub message launches an agent yet.

---

# Phase M1.5 — Safety and control plane

**Goal:** make unattended dispatch technically safe enough to test.

This phase is intentionally before Hermes/autonomous handoffs.

## M1.5.1 — Router event model

- [ ] **ORCH-050** Add a normalized event context containing at least:
  - GitHub delivery ID;
  - event/action;
  - repository;
  - issue/PR number;
  - actor;
  - branch;
  - head/base SHA;
  - labels/authorization facts.
- [ ] **ORCH-051** Add a request-body size limit.
- [ ] **ORCH-052** Add dispatch/execution timeout support.
- [ ] **ORCH-053** Add cancellation/clean shutdown behavior.
- [ ] **ORCH-054** Add a per-repo/task concurrency limit.

## M1.5.2 — Webhook security

- [ ] **ORCH-055** Make valid GitHub signature verification mandatory outside explicit local-dev mode.
- [ ] **ORCH-056** Reject missing/invalid signatures.
- [ ] **ORCH-057** Store GitHub delivery IDs and make duplicate deliveries idempotent.

## M1.5.3 — Safe process dispatch

- [ ] **ORCH-058** Remove webhook-derived command strings executed with `shell: true`.
- [ ] **ORCH-059** Define worker executables as fixed configuration.
- [ ] **ORCH-060** Pass validated structured values as argument arrays with `shell: false`.
- [ ] **ORCH-061** Add tests proving malicious branch/user/issue strings cannot become shell syntax.

## M1.5.4 — Authorization gate

- [ ] **ORCH-062** Implement trusted-user allowlist support.
- [ ] **ORCH-063** Implement `agent:ready` (or equivalent) label authorization.
- [ ] **ORCH-064** Require the authorizing label/action to come from a trusted actor.
- [ ] **ORCH-065** Verify a random public issue cannot launch a worker.
- [ ] **ORCH-066** Log authorization decisions without logging secrets.

## M1.5.5 — SQLite state store

- [ ] **ORCH-067** Add SQLite to the router.
- [ ] **ORCH-068** Create a `tasks` table with:
  - task ID;
  - repo/issue;
  - current state;
  - current owner;
  - branch/base SHA;
  - risk;
  - timestamps.
- [ ] **ORCH-069** Create a `runs` table with:
  - run ID;
  - task ID;
  - agent;
  - attempt;
  - start/end status;
  - last error/result.
- [ ] **ORCH-070** Create a `deliveries` table for webhook deduplication.
- [ ] **ORCH-071** Create a `leases` table for worktree ownership.
- [ ] **ORCH-072** Verify router restart preserves task state and does not re-run completed deliveries.

## M1.5.6 — Handoff parser/validator

- [ ] **ORCH-073** Implement `schema_version: 1` parsing for `handoff/handoff-envelope.md`.
- [ ] **ORCH-074** Validate required fields and legal state transitions.
- [ ] **ORCH-075** Treat prose outside the envelope as untrusted context.
- [ ] **ORCH-076** Add fixtures/tests for:
  - valid envelope;
  - missing fields;
  - unknown schema version;
  - malicious task text;
  - stale base SHA;
  - expired lease;
  - out-of-scope paths;
  - exceeded attempts.

## M1.5.7 — Worktree + lease isolation

- [x] **ORCH-077** Define the local worktree root outside the orchestrator source checkout. (`worktreeRoot` config)
- [x] **ORCH-078** Create one task-private standalone Git checkout per task/lease (private refs/index/config/objects; no shared alternates or linked-worktree metadata).
- [x] **ORCH-079** Record worktree path + base SHA + owner in SQLite. (`leases` table)
- [ ] **ORCH-080** Verify lease ownership before commit/push. (still open: the pre-push guard is a *cooperative* layer and does not yet confirm the pusher holds the active lease; router-owned push verification does not exist)
- [x] **ORCH-081** Stop/escalate if the branch moved unexpectedly. (pre-push guard compares the live remote base tip against the recorded base SHA, independent of the pushed ref; `resolveBaseSha` tracks the live remote tip and refuses a stale provided base)
- [x] **ORCH-082** Enforce `allowed_paths` before commit/push. (worker/repository baseline REQUIRED AND optional task scope enforced per file; task cannot widen the worker baseline; an omitted task scope means worker-baseline-only, and a stale task-scope file is removed)
- [x] **ORCH-083** Clean/reap expired task checkouts safely. (periodic `reapExpired()` in `server.mjs`; a stale lease never reaps a worktree a newer active lease owns)
- [x] **ORCH-140 (lifecycle groundwork)** Retries reconstruct a clean task-private repository from authoritative Git state (`prepareWorktreeForRun`); incompatible remote task branches fail closed rather than auto-rebasing. (full M3.3 review/verification automation remains)
- [x] **Single live execution per task** — a delivery that finds a run still `running` + an active, unexpired lease is refused (`task already has an active execution`) and never releases the lease/checkout/launches a second worker; stale `running` runs are reconciled to `abandoned`. Serialized per task with an in-process lock. The handoff envelope's `state` must equal persisted task state for existing tasks (fail closed on mismatch).

### M1.5 exit criteria

A signed, authorized test event can create **exactly one** durable task/run and isolated task-private checkout. Duplicate/untrusted/malicious events cannot launch arbitrary commands or duplicate work.

**GATE:** do not connect an autonomous code-editing worker until this phase passes.

---

# Phase M2 — Canonical CI + Hermes repair pilot

**Goal:** prove bounded autonomous repair while keeping CI and merge authority independent from Hermes.

## M2.1 — Define the DualDex CI contract

- [x] **ORCH-090** Choose canonical build command(s): `./ci.sh build` / `./ci.sh test` / `./ci.sh all` (merged in DualDex #28).
- [x] **ORCH-091** Make the commands deterministic/non-interactive.
- [x] **ORCH-092** Ensure a developer/agent can run them locally.
- [x] **ORCH-093** Add/update GitHub Actions to run the same CI contract (`Native & Unit Tests`, `Build Debug APK`).
- [x] **ORCH-094** Configure required checks for the pilot PR flow (DualDex `protect-main` ruleset, verified by read-back).

## M2.2 — Hermes setup

- [x] **ORCH-095** Install/configure Hermes on the self-hosted machine (`hermes-agent` v0.21.1, `~/.hermes`).
- [x] **ORCH-096** Give Hermes only the task-private checkout and minimum required environment (structured `SONORAN_*` metadata + env allowlist); preserve mount/user/PID isolation while allowing outbound DNS/HTTPS transport.
- [x] **ORCH-097** Update the fix-build skill to consume task/run/lease scope from the router (structured result file contract).
- [x] **ORCH-098** Set a bounded repair limit (control-plane enforced `maxAttempts: 3`; attempt 4 refused).
- [x] **ORCH-099** Require escalation for API/schema/product/security decisions (`escalate`/`blocked` stop the autonomous loop).

## M2.3 — Deliberate failure tests

Create controlled failures rather than trusting the first real incident.

- [ ] **ORCH-100** Test: trivial compile/syntax failure Hermes should fix.
- [ ] **ORCH-101** Test: narrow failing unit test with an obvious implementation bug.
- [ ] **ORCH-102** Test: proposed fix makes more tests fail → attempt is reverted.
- [ ] **ORCH-103** Test: failure requires behavior/API decision → Hermes escalates without guessing.
- [ ] **ORCH-104** Test: failure cannot be fixed within max attempts → Hermes stops/escalates.
- [ ] **ORCH-105** Test: Hermes local run passes but GitHub Actions fails → CI remains authoritative and task is not marked done.

## M2.4 — Review + merge policy

- [ ] **ORCH-106** Hermes pushes candidate repair to the assigned task branch/PR.
- [ ] **ORCH-107** Codex reviews the candidate repair.
- [ ] **ORCH-108** GitHub Actions verifies required checks.
- [ ] **ORCH-109** Human performs the merge.
- [ ] **ORCH-110** Keep all automatic merge behavior disabled during the pilot.

### M2 exit criteria

- Hermes can fix at least one deliberate mechanical failure.
- Hermes correctly refuses/escalates at least one non-mechanical failure.
- GitHub Actions, not Hermes, determines required-check status.
- No automatic agent merge is required.

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
- [ ] **Pause:** orchestration maintenance exceeds the benefit → return effort to SaveBridge and revisit later.

---

# Phase M3 — Structured handoff automation

**Goal:** automate the boring baton passing after the control plane is proven.

## M3.1 — Codex planner automation

- [ ] **ORCH-130** Authorize a task through the trusted gate.
- [ ] **ORCH-131** Router dispatches a planning run to Codex.
- [ ] **ORCH-132** Codex updates the validated envelope with acceptance criteria/scope.
- [ ] **ORCH-133** Router validates the envelope before moving to implementation.

## M3.2 — Implementation handoff

- [ ] **ORCH-134** Router creates the implementation worktree/lease.
- [ ] **ORCH-135** Post one `ready for implementation` event to the project Slack channel.
- [ ] **ORCH-136** Keep Antigravity human-steered initially.
- [ ] **ORCH-137** Only experiment with headless Antigravity after the manual path is reliable.

## M3.3 — Review + verification automation

- [ ] **ORCH-138** Implementation completion moves task to `review`.
- [ ] **ORCH-139** Codex receives a review run against the actual diff.
- [ ] **ORCH-140** Required fixes return to the appropriate worker with a new run ID/lease.
- [ ] **ORCH-141** Accepted review moves task to `verification`.
- [ ] **ORCH-142** Required GitHub Actions checks gate completion.
- [ ] **ORCH-143** Human merge marks the initial M3 task `done`.

## M3.4 — Capability-tier model router

**Goal:** turn the policy in [`MODEL_ROUTING.md`](MODEL_ROUTING.md) into deterministic, provider-neutral routing behavior. The router should choose the cheapest capable worker, preserve evidence between attempts, escalate only for a reason, and step back down once the hard unknown is resolved.

- [ ] **ORCH-144** Extend task/run metadata and the handoff schema with provider-neutral routing fields such as:
  - `work_class`;
  - `capability_tier`;
  - `max_capability_tier`;
  - `preferred_worker` / optional provider preference;
  - `fallback_tier`;
  - `evidence_packet_ref`;
  - budget and human-approval requirements where applicable.
- [ ] **ORCH-145** Add a configurable model/worker registry mapping capability tiers to the currently available providers, models, harnesses, tool access, and cost policy. Durable task state must describe required capability rather than hard-code a permanent model name.
- [ ] **ORCH-146** Implement a deterministic routing decision engine that selects the cheapest allowed worker satisfying the task's capability tier, work class, repository policy, required tools, availability, and configured budget.
- [ ] **ORCH-147** Implement structured escalation packets. Before moving a task to a higher capability tier, preserve at least:
  - the original question/acceptance criteria;
  - confirmed facts and collected evidence;
  - commands/tests already run and their important results;
  - attempted hypotheses/fixes and why they failed;
  - relevant logs, traces, diffs, artifacts, or research notes;
  - the specific unresolved question the higher tier should attack.
- [ ] **ORCH-148** Implement bounded escalation and step-down policy:
  - do not escalate merely because a task is large;
  - require evidence-producing attempts or an explicit research-class trigger;
  - respect `max_capability_tier` and human approval/budget gates;
  - after a Tier 4 research run resolves the unknown, route ordinary implementation/tests/docs back to Tier 2 or Tier 1 instead of leaving the premium model attached indefinitely.
- [ ] **ORCH-149** Add routing regression tests covering at least:
  - Tier 1 routine work stays on Tier 1;
  - Tier 2 receives normal serious engineering work;
  - repeated evidence-producing Tier 2 failures can promote to Tier 3;
  - research-class/undocumented-system work can reach Tier 4 under policy;
  - provider outage selects an allowed equivalent/fallback without corrupting task state;
  - budget caps and human-approval requirements block unauthorized premium escalation;
  - a resolved Tier 4 research task steps back down for implementation;
  - capability tier never grants broader repository, secret, hardware, merge, or authorization permissions.

### M3 exit criteria

One real DualDex issue can move from authorized plan → implementation → review → CI → human merge with durable state and no ambiguous ownership.

At least one controlled pilot task can also be classified and routed through the capability ladder with a durable evidence packet, deterministic escalation/step-down behavior, and no provider/model name acting as the source of truth for task state.

**GATE:** do not enable automatic premium-model escalation until routing tests, budget limits, evidence handoffs, and any required human approval gates have been exercised deliberately.

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
- [ ] **ORCH-159** Measure whether swarm runs produce better results than a single Codex debugging pass.

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

**Goal:** give humans and the capability-tier router one normalized, near-real-time view of which model capacity is actually available. See [`MODEL_USAGE_HUB.md`](MODEL_USAGE_HUB.md) for the design.

- [ ] **ORCH-167** Build provider-capacity adapters and a normalized capacity snapshot schema covering configured models/workers. Capture authoritative quota/usage when providers expose it, plus availability, rate-limit state, reset windows, billing/budget data when useful, and provenance fields such as `observed_at`, freshness, source, and quality. Where exact quota is unavailable, support clearly labeled derived/estimated/manual values instead of inventing precision.
- [ ] **ORCH-168** Build the human-facing usage hub and persistence layer:
  - current availability/capacity grouped by capability tier;
  - remaining quota/usage and reset countdowns where known;
  - rate-limit state;
  - current task/run reservations;
  - usage history by model, repo, task, and work class;
  - configured budget/reserve thresholds;
  - stale/failed telemetry warnings;
  - concise alerts when premium capacity is low, providers become unavailable, or quota resets make blocked work runnable again.
- [ ] **ORCH-169** Integrate capacity into deterministic routing policy:
  - prefer the cheapest capable worker that also has sufficient fresh capacity;
  - protect configurable Tier 3/Tier 4 reserve thresholds;
  - never silently downgrade below required capability just to save quota;
  - queue/block or require human approval when no eligible worker has enough capacity;
  - add short-lived capacity reservations so concurrent tasks do not all spend the same apparent remaining quota;
  - treat stale/unknown usage as uncertainty rather than as an exact remaining percentage;
  - add regression tests proving capacity affects worker selection but never expands repository, secret, hardware, merge, or authorization permissions.

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
- [ ] **ORCH-176** Let agents own plumbing/tooling/tests/data structure work.
- [ ] **ORCH-177** Keep "is this fun?" and core game-design decisions human-controlled.
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

If starting today, do these in order:

1. [ ] **ORCH-001** Finish/stabilize the Sonoran Solutions GitHub identity rename.
2. [ ] **ORCH-005** Choose one small real DualDex pilot issue.
3. [ ] **ORCH-011** Run the Codex planning pass manually.
4. [ ] **ORCH-014** Implement it with human-steered Antigravity.
5. [ ] **ORCH-016** Have Codex review the resulting diff.
6. [ ] **ORCH-034** Lock the minimal Slack notification policy.
7. [ ] **ORCH-037** Move orchestration secrets/config outside task worktrees.
8. [ ] **ORCH-058** Replace unsafe shell-string router dispatch.
9. [ ] **ORCH-067** Add SQLite task/run/delivery/lease state.
10. [ ] **ORCH-077** Add isolated per-task git worktrees.

Only after those basics are healthy should Hermes receive unattended repair work.