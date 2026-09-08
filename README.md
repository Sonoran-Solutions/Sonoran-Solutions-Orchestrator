# Sonoran Solutions Orchestrator

A concrete starter kit for a small multi-agent software-development workflow used across Sonoran Solutions projects.

The goal is **not** to build an autonomous fake company for its own sake. The goal is to make real product work — starting with DualDex — easier to plan, implement, test, review, and monitor.

## Current architecture

| Component | Role |
|---|---|
| **Codex** | Planner, reviewer, debugger/bug fixer |
| **Google Antigravity** | Primary implementer; human-steered during the initial rollout |
| **Hermes Agent** | CI/build repair technician with bounded attempts |
| **DeepSeek Harness** | Optional specialist swarm / multi-agent debug layer |
| **Sonoran router** | Deterministic authorization, state, lease, and dispatch policy |
| **SQLite** | Durable runtime task/run/delivery/lease state |
| **Git worktrees** | One isolated mutable checkout per active task |
| **GitHub Actions** | Independent required-check authority |
| **Slack** | Human-facing project/operations view |
| **Human** | Product authority and initial merge gate |

**Neutral bus:** GitHub remains the durable work record. The router owns runtime policy/state. No model vendor is the source of truth.

### Cost-aware model routing

Agent roles and model capability are separate concerns. Sonoran Solutions uses a capability ladder so routine work stays on economical models and expensive research models are reserved for genuinely unresolved problems.

> **Core rule:** Astra should usually receive evidence produced by cheaper models rather than being asked to gather all of the evidence itself.

The current ladder runs from Flash-tier reconnaissance/mechanical work → Terra for normal serious engineering → DeepSeek Pro for hard problems/second opinions → Astra for bounded research and experimental reverse engineering. The durable architecture is **capability-tier based**, not tied to a permanent vendor or model name.

See [`MODEL_ROUTING.md`](MODEL_ROUTING.md) for model selection, escalation triggers, evidence-first handoffs, step-down rules, and examples across Sonoran projects.

## Supporting Sonoran toolchain

The orchestrator is only one layer of the broader development workflow. Each supporting tool gets one clear responsibility:

| Tool | Responsibility | Adoption |
|---|---|---|
| **Linear** | Product backlog, priorities, projects, roadmap | Add early |
| **GitHub Rulesets** | Hard merge/branch/required-check policy | Configure before unattended writes |
| **1Password** | Local/orchestrator secret authority and controlled injection | Add before credentials multiply |
| **Sentry** | Production crashes, release health, real-user error evidence | Add per product before public beta/release |
| **Tailscale** | Private access between trusted development/build machines | Add when remote operations are useful |
| **Renovate** | Dependency-update proposals and maintenance visibility | Add once multiple repos make updates noisy |
| **Taskfile** | Optional shared command vocabulary (`task build`, `task test`, etc.) | Evaluate when repo count grows |
| **Dagger** | Potential future portable CI layer | Park until a real CI portability problem exists |

The intended source-of-truth split is:

```text
Linear             = what should we build, why, and in what order
GitHub              = code + PRs + durable engineering record
Sonoran Router      = what is authorized/assigned/executing right now
SQLite              = runtime task/run/lease/retry state
GitHub Actions      = whether required checks actually pass
Slack               = what needs human attention
Sentry              = what is breaking for real users
1Password           = protected credentials
Tailscale           = private machine connectivity
Renovate            = dependency maintenance
```

See [`TOOLING_STACK.md`](TOOLING_STACK.md) for boundaries/integration rules and [`TOOLING_ROADMAP.md`](TOOLING_ROADMAP.md) for the phased adoption checklist.

## Core safety rules

1. **Public GitHub/Slack text is untrusted data.** A random issue must never be enough to launch a local worker.
2. **Every unattended task requires an explicit trusted authorization signal** such as an allowlisted actor or trusted `agent:ready` label.
3. **No webhook-derived shell strings.** Worker executables are fixed configuration and structured arguments are dispatched with `shell: false`.
4. **One task = one worktree + lease.** Agents do not share a mutable checkout.
5. **GitHub Actions is the independent green/red judge.** Workers may test locally, but they do not self-certify correctness.
6. **No unattended agent-authored merges during the pilot.** CI + review + human merge until the system earns more trust.
7. **Secrets live outside task worktrees.** Never source task-controlled `.env` files as orchestrator configuration; move toward a dedicated secret authority such as 1Password.
8. **Bound every loop.** Attempts, runtime, concurrency, and retries must have hard limits and escalation behavior.
9. **Repository policy is independently enforced.** GitHub Rulesets should prevent the router or an agent from bypassing required review/checks.

## Repository layout

| Path | Purpose |
|---|---|
| [`AGENT_ORCHESTRATION_PLAN.md`](AGENT_ORCHESTRATION_PLAN.md) | Full architecture, authority model, trust boundaries, state machine, CI/review flow, and rollout strategy |
| [`MODEL_ROUTING.md`](MODEL_ROUTING.md) | Cost-aware model ladder, escalation/step-down policy, evidence-first handoffs, and vendor-neutral capability routing |
| [`IMPLEMENTATION_ROADMAP.md`](IMPLEMENTATION_ROADMAP.md) | Core phased checklist from manual DualDex pilot through safe automation |
| [`TOOLING_STACK.md`](TOOLING_STACK.md) | Supporting tools: Linear, Rulesets, 1Password, Sentry, Tailscale, Renovate, Taskfile, and parked Dagger option |
| [`TOOLING_ROADMAP.md`](TOOLING_ROADMAP.md) | Parallel `TOOL-###` adoption tasks aligned to the core orchestrator phases |
| `handoff/` | Versioned machine-readable handoff envelope and task-state rules |
| `slack-notify/` | Early notification helpers; should evolve toward state-transition notifications rather than tool-call spam |
| `hermes-watch/` | Hermes repair skill/scaffolding; must be integrated with task scope, worktrees, leases, and independent CI before unattended use |
| `router/` | Prototype webhook relay/control-plane scaffolding; **not yet production-safe** |

## Rollout

The recommended order is deliberately conservative:

### P0 — Identity + management foundation

Stabilize the Sonoran Solutions GitHub identity first. Then establish the planning/security foundations that are cheap to add early:

- use Linear as the product/project planning layer;
- configure GitHub Rulesets for hard repository policy;
- begin moving orchestration secrets toward 1Password rather than growing plaintext `.env` usage.

None of these systems may bypass the router's execution authorization model.

### M0 — Manual benchmark

Use one real low-risk DualDex issue and manually run:

```text
human/Linear goal
→ Codex plan
→ human-steered Antigravity implementation
→ Codex review
→ GitHub Actions
→ human merge
```

Do not automate a role split that has not proven useful manually.

### M1 — Visibility

Wire concise project notifications into Slack. Start with `#dual-dex`. Post meaningful transitions, not every edit/tool call.

### M1.5 — Safety/control plane

Before any unattended code execution:

- authenticated + deduplicated GitHub events;
- trusted authorization gate;
- safe process dispatch (`shell: false`);
- SQLite state;
- validated handoff schema;
- per-task worktrees and leases;
- path/scope enforcement;
- timeouts and concurrency limits;
- GitHub Rulesets/required checks that the router cannot bypass;
- orchestration secrets outside task worktrees.

### M2 — Hermes repair pilot

Define the canonical DualDex CI commands, run them in GitHub Actions, then let Hermes attempt controlled mechanical fixes on deliberately broken test branches. GitHub Actions remains authoritative and humans still merge.

### Evaluation gate

Stop and ask whether the stack is actually saving time. If not, simplify it before proceeding.

### M3 — Structured handoffs

Automate Codex planning → implementation readiness → review → CI transitions while preserving durable state and explicit ownership. Linear may reflect planning/progress, but GitHub + router state remain authoritative for execution.

### M4 — Operations/convenience

Only after the core flow is reliable: authenticated Slack controls, DeepSeek specialist workflows, health/status views, and private remote access through Tailscale when useful.

### M5 — Product expansion

Use the proven system on SaveBridge, then later on Dungeon Dispatcher where appropriate. As products approach public testing, add Sentry for production feedback. Add Renovate once dependency maintenance across active repos becomes repetitive. Evaluate Taskfile only when common repo commands would actually reduce glue.

Dagger remains parked until local/hosted CI divergence becomes a demonstrated problem.

See [`IMPLEMENTATION_ROADMAP.md`](IMPLEMENTATION_ROADMAP.md) for the core implementation gates, [`TOOLING_ROADMAP.md`](TOOLING_ROADMAP.md) for the parallel supporting-tool checklist, and [`MODEL_ROUTING.md`](MODEL_ROUTING.md) for the model escalation policy used by workers.

## Current prototype caveats

The control plane (HMAC, dedupe, authorization, SQLite state, safe `shell: false`
dispatch, worktrees + named branches + lease, base-ref movement guard, worker
env allowlist) is implemented and tested (`node test.mjs` → 20 passing). It is
**not yet production-safe** for unattended use until these remain:

- GitHub Actions as the required-check authority (M2.1 `ci.sh` contract);
- GitHub Rulesets so required checks/review cannot be bypassed by normal agent
  credentials (TOOL-021+);
- Hermes repair wiring with minimum-environment leases (M2.2), plus the
  deliberate-failure M2.3 tests;

Also confirm ORCH-080 (verify lease ownership before push) before wide autonomous
use. Do not expose the router publicly or give it unattended code-editing
authority until the above are complete.

## Definition of success

This project succeeds if it helps Sonoran Solutions ship products faster and more safely.

The first meaningful milestone is not "four agents can talk to each other." It is:

> One real DualDex task can move from scoped product goal → implementation → review → independent CI → human merge with less context loss and less repetitive work than the manual workflow.

If maintaining the orchestrator or its supporting SaaS stack starts consuming more time than it saves, pause it and return effort to SaveBridge / Dungeon Dispatcher.
