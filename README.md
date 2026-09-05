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

## Core safety rules

1. **Public GitHub/Slack text is untrusted data.** A random issue must never be enough to launch a local worker.
2. **Every unattended task requires an explicit trusted authorization signal** such as an allowlisted actor or trusted `agent:ready` label.
3. **No webhook-derived shell strings.** Worker executables are fixed configuration and structured arguments are dispatched with `shell: false`.
4. **One task = one worktree + lease.** Agents do not share a mutable checkout.
5. **GitHub Actions is the independent green/red judge.** Workers may test locally, but they do not self-certify correctness.
6. **No unattended agent-authored merges during the pilot.** CI + review + human merge until the system earns more trust.
7. **Secrets live outside task worktrees.** Never source task-controlled `.env` files as orchestrator configuration.
8. **Bound every loop.** Attempts, runtime, concurrency, and retries must have hard limits and escalation behavior.

## Repository layout

| Path | Purpose |
|---|---|
| [`AGENT_ORCHESTRATION_PLAN.md`](AGENT_ORCHESTRATION_PLAN.md) | Full architecture, authority model, trust boundaries, state machine, CI/review flow, and rollout strategy |
| [`IMPLEMENTATION_ROADMAP.md`](IMPLEMENTATION_ROADMAP.md) | Phased project checklist from manual DualDex pilot through safe automation |
| `handoff/` | Versioned machine-readable handoff envelope and task-state rules |
| `slack-notify/` | Early notification helpers; should evolve toward state-transition notifications rather than tool-call spam |
| `hermes-watch/` | Hermes repair skill/scaffolding; must be integrated with task scope, worktrees, leases, and independent CI before unattended use |
| `router/` | Prototype webhook relay/control-plane scaffolding; **not yet production-safe** |

## Rollout

The recommended order is deliberately conservative:

### M0 — Manual benchmark

Use one real low-risk DualDex issue and manually run:

```text
human goal
→ Codex plan
→ human-steered Antigravity implementation
→ Codex review
→ build/tests
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
- timeouts and concurrency limits.

### M2 — Hermes repair pilot

Define the canonical DualDex CI commands, run them in GitHub Actions, then let Hermes attempt controlled mechanical fixes on deliberately broken test branches. GitHub Actions remains authoritative and humans still merge.

### Evaluation gate

Stop and ask whether the stack is actually saving time. If not, simplify it before proceeding.

### M3 — Structured handoffs

Automate Codex planning → implementation readiness → review → CI transitions while preserving durable state and explicit ownership.

### M4 — Operations/convenience

Only after the core flow is reliable: authenticated Slack controls, DeepSeek specialist workflows, health/status views, and optional private remote access.

### M5 — Product expansion

Use the proven system on SaveBridge, then later on Dungeon Dispatcher where appropriate. Agents can own implementation plumbing; humans still own product/game-design judgment.

See [`IMPLEMENTATION_ROADMAP.md`](IMPLEMENTATION_ROADMAP.md) for the actual task list and gates.

## Current prototype caveats

The checked-in router and helper scripts are scaffolding. Before unattended use, the most important changes are:

- replace `shell: true` command interpolation;
- parse/validate the handoff envelope instead of matching only generic webhook fields;
- add correct issue/PR/task identifiers;
- require signatures outside explicit local dev;
- add authorization, SQLite state, dedupe, timeouts, concurrency, worktrees, and leases;
- move Slack/secrets configuration outside agent-controlled worktrees;
- make GitHub Actions the required-check authority.

Do not expose the current router publicly or give it unattended code-editing authority until those items are complete.

## Definition of success

This project succeeds if it helps Sonoran Solutions ship products faster and more safely.

The first meaningful milestone is not "four agents can talk to each other." It is:

> One real DualDex task can move from scoped goal → implementation → review → independent CI → human merge with less context loss and less repetitive work than the manual workflow.

If maintaining the orchestrator starts consuming more time than it saves, pause it and return effort to SaveBridge / Dungeon Dispatcher.
