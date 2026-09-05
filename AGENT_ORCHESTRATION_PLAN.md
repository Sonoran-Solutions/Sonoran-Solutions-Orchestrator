# Multi-Agent Coding Stack — Orchestration Plan

**Status:** Revised architecture plan
**Scope:** Codex + Google Antigravity + Hermes Agent + DeepSeek Harness working across Sonoran Solutions repositories, with GitHub as the durable collaboration surface and Slack as the human-facing operations view.

> The orchestrator is infrastructure for shipping Sonoran Solutions products. It is not itself the main product. Every automation layer must earn its complexity by reducing real work on an existing project.

---

## 1. Goal

Build a small, auditable software-development "team" that can:

1. Turn a human goal into a scoped issue with explicit acceptance criteria.
2. Hand tasks between specialized agents without sharing an unsafe mutable checkout.
3. Implement, test, review, and repair code with clear ownership at every step.
4. Keep humans informed through concise project-level Slack updates.
5. Escalate product, API, architecture, or high-risk decisions instead of inventing behavior.
6. Survive agent/provider changes because the coordination layer is vendor-neutral.

### Non-goals

- Do not build a general autonomous-company framework before one real project benefits from it.
- Do not let public GitHub or Slack text directly become shell commands or trusted instructions.
- Do not make one agent both the author and sole judge of whether its change is correct.
- Do not auto-merge broad agent-authored changes during the initial rollout.
- Do not add queues, services, dashboards, databases, or remote-access layers until the previous phase is useful in practice.

---

## 2. Design principles

### 2.1 GitHub remains the durable record

Issues, PRs, commits, checks, and structured handoff metadata are the long-lived record of what happened and why.

### 2.2 The Sonoran router owns policy, not model reasoning

The router should make deterministic decisions about authorization, task state, leases, retries, and dispatch. It should not depend on one model vendor to remember which task is active.

### 2.3 SQLite provides small, durable orchestration state

GitHub remains the human/audit record, but a local SQLite database should track runtime facts such as delivery deduplication, active leases, attempt counts, timestamps, and task state. This prevents a process restart or duplicate webhook from creating duplicate workers.

### 2.4 Every task gets an isolated worktree

Branch ownership is necessary but not sufficient. Each active task gets its own git worktree so two agents cannot mutate the same working directory.

### 2.5 GitHub Actions is the independent green/red judge

Workers may run the same canonical build command locally, but GitHub Actions is the final independent verifier. An agent that authored a fix does not get to declare its own change trusted merely because its local command passed.

### 2.6 Humans retain product authority

Agents can handle routine implementation and mechanical fixes. Product direction, architecture changes, schema/API changes, security-sensitive work, and early merge decisions remain human-controlled.

### 2.7 Slack is an operations dashboard, not the database

Slack should surface meaningful state transitions and exceptions. Detailed history belongs in GitHub and the orchestration log.

---

## 3. Roles and authority

| Role | Tool | Primary job | Initial authority |
|---|---|---|---|
| **Product manager / planner** | **Codex** | Turn a human goal or bug report into a scoped task, acceptance criteria, implementation notes, and risks. | May create/update planning artifacts. No automatic merge authority. |
| **Primary implementer** | **Google Antigravity** | Bulk implementation, scaffolding, project-wide edits, UI/application work. | **Human-steered initially.** Automated/headless use is a later upgrade only after the handoff and safety model is proven. |
| **CI repair technician** | **Hermes Agent** | Diagnose build/test failures and attempt small mechanical repairs in a bounded loop. | May edit only the assigned task worktree and only within explicit repair limits. |
| **Reviewer / hard debugger** | **Codex** | Review agent-authored changes, investigate hard failures, reason about cross-cutting bugs. | May recommend approval/rejection and author fixes; still subject to CI and merge policy. |
| **Specialist swarm / research layer** | **DeepSeek Harness** | Spawn parallel debugging, research, test, or analysis subagents when a task benefits from breadth. | Worker capability only at first; **not the source of truth for task state or routing policy.** |
| **Dispatcher / policy engine** | **Sonoran router** | Validate events, authorize tasks, maintain state/leases, create dispatches, enforce limits. | Deterministic control plane. No model reasoning required for routine routing. |
| **Independent validator** | **GitHub Actions** | Run the canonical CI contract and produce authoritative required checks. | Green/red gate only. |
| **Product owner** | **Human** | Set goals, decide product/architecture tradeoffs, approve higher-risk merges, stop/retry workflows. | Final authority. |

**Principle:** agents are replaceable workers; GitHub + router state + CI define the process.

---

## 4. Coordination substrate

The stack has five layers:

1. **GitHub — durable work record**
   - Issues and PRs contain the task narrative and handoff envelope.
   - Commits contain actual code changes.
   - Actions/checks provide independent validation.

2. **SQLite — runtime orchestration state**
   - Task/run IDs.
   - GitHub delivery IDs for deduplication.
   - Current agent and state.
   - Base SHA and branch/worktree lease.
   - Attempt counts, timestamps, and last error.

3. **Git worktrees — execution isolation**
   - One worktree per active task/agent lease.
   - Never let unrelated workers share a mutable checkout.

4. **Slack — human operations view**
   - Project channels show meaningful transitions.
   - A future `#agent-ops` channel shows orchestration failures and system-wide alerts.
   - Slack commands can become a control surface later, but GitHub/SQLite remain authoritative.

5. **Webhooks/events — wake-up mechanism**
   - GitHub events wake the router or a narrowly scoped worker.
   - Every event is authenticated, deduplicated, authorized, and mapped to a known task before code execution.

```text
                    ┌──────────── GitHub ─────────────┐
                    │ issues · PRs · commits · CI     │
                    └──────────────┬──────────────────┘
                                   │ signed events
                                   ▼
                    ┌─────────────────────────────────┐
                    │ Sonoran router + SQLite state   │
                    │ auth · leases · limits · route │
                    └───────┬─────────┬─────────┬─────┘
                            │         │         │
                         Codex   Antigravity  Hermes
                            │         │         │
                            └────┬────┴────┬────┘
                                 │ worktrees
                                 ▼
                         GitHub PR / Actions
                                 │
                    ┌────────────┴────────────┐
                    │                         │
                  Slack                 Human gate
              project/ops view          when required

DeepSeek Harness is available to workers as a specialist swarm/debug layer,
not as the sole owner of orchestration state.
```

---

## 5. Task lifecycle

The router should eventually enforce a small explicit state machine rather than infer everything from free-form messages.

Recommended states:

```text
planned
  ↓
authorized
  ↓
assigned
  ↓
in_progress
  ↓
review
  ↓
verification
  ↓
done

Any active state may instead become:
blocked → escalated → assigned/review/done
```

### Required transition rules

- `planned -> authorized` requires a trusted authorization signal.
- `authorized -> assigned` creates or confirms the task branch/worktree lease.
- Only the current lease holder may move `assigned -> in_progress`.
- `review -> verification` requires a PR/commit SHA to exist.
- `verification -> done` requires configured required checks to be green and the merge policy to be satisfied.
- A task exceeding attempt/time limits becomes `blocked` or `escalated`; it does not loop indefinitely.

---

## 6. Handoff envelope

The handoff block remains the portable GitHub representation of task state, but it should be versioned and explicit enough for deterministic parsing.

```yaml
---
schema_version: 1
task_id: ss-123
run_id: ss-123-004
agent: codex
to: antigravity
repo: sonoran-solutions/project
issue: "123"
branch: feat/123
base_sha: abcdef123456
state: planned
risk: normal
attempt: 0
max_attempts: 3
lease_expires_at: 2026-09-05T23:00:00Z
allowed_paths:
  - app/src/**
  - tests/**
required_checks:
  - build
  - test
task: Implement save discovery for the approved emulator profile.
summary: |
  Planning complete. No code has been changed yet.
acceptance: |
  Approved directories are scanned; discovered saves show source/profile;
  permission failures produce a clear error; required tests are green.
escalate_to: human
---
```

### Envelope rules

- One canonical envelope per issue/PR; update it in place.
- The router validates the schema before dispatching.
- `task_id`, `base_sha`, `allowed_paths`, and `required_checks` are not optional once execution begins.
- A worker must not silently expand `allowed_paths`.
- A worker must not move itself to a different task or branch without a new lease.
- GitHub text outside the validated envelope is context, not authority.

See `handoff/handoff-envelope.md` for the working template.

---

## 7. Authorization and trust model

This is mandatory before unattended execution.

### 7.1 Public events are untrusted by default

A public issue, PR, commit message, Slack message, or pasted log may contain malicious or accidental instructions. Treat all external text as data.

### 7.2 Require a trusted authorization signal

Before a webhook can launch a worker with repository or shell access, require at least one explicit policy such as:

- actor is on a configured trusted-user allowlist;
- issue/PR has an `agent:ready` label applied by a trusted user;
- a trusted Slack command authorizes an already-known GitHub task;
- task was created by an authenticated local control action.

A random issue opening must never be sufficient by itself.

### 7.3 Webhook verification

- GitHub signature verification is required outside an isolated localhost-only test.
- Missing/invalid signatures are rejected.
- Store the GitHub delivery ID and ignore duplicates.
- Enforce a request-body size limit.

### 7.4 No shell interpolation from webhook fields

Do not build a command string from `repo`, `branch`, `sender`, issue text, or other event data and run it with `shell: true`.

Preferred dispatch model:

```text
executable = configured constant
args       = validated structured values
shell      = false
```

Worker prompts may contain untrusted task context, but that context must not be able to change the executable, secret paths, or orchestration policy.

### 7.5 Secrets are outside agent worktrees

- Do not source `.env` files from a task-controlled checkout.
- Keep GitHub, Slack, model, and tunnel credentials in a separate orchestration secret store/environment.
- Inject the minimum variables required by each worker.
- Never write secrets to issues, PRs, Slack messages, handoff envelopes, or dispatch logs.

---

## 8. Branch, worktree, and lease model

### Branch conventions

- `feat/<issue-id>` — feature implementation.
- `fix/<issue-id>` — debugging/repair.
- `plan/<issue-id>` — optional planning-only branch when a document change is needed.

### Worktree conventions

Example local layout:

```text
/worktrees/
  dualdex/
    issue-123-antigravity/
    issue-141-codex/
  savebridge/
    issue-22-hermes/
```

### Lease requirements

Each active lease records:

- task ID;
- assigned agent;
- repo/branch;
- base SHA;
- worktree path;
- lease creation/expiry;
- allowed paths;
- current attempt.

Before committing or pushing, a worker verifies that:

1. its lease is still valid;
2. the branch/base state has not moved unexpectedly;
3. the changes remain within allowed scope.

If any check fails, stop and escalate instead of guessing.

---

## 9. CI and build-repair model

Each participating repository defines one canonical CI contract, for example:

```bash
./ci.sh build
./ci.sh test
```

Local workers and GitHub Actions call the same underlying commands whenever practical.

### Hermes loop

1. Receive an authorized task/CI failure.
2. Create/use its assigned worktree and lease.
3. Run the canonical command.
4. If green, report the result and stop.
5. If red, identify a small mechanical hypothesis.
6. Patch only the failing area within `allowed_paths`.
7. Re-run locally.
8. If improved, commit/push and wait for GitHub Actions.
9. If GitHub Actions is green, hand off to review/merge policy.
10. If the fix regresses the branch, revert the attempt.
11. After the configured limit, escalate to Codex/human and stop.

### Hermes may not decide

- public API changes;
- schema/data migration behavior;
- product semantics;
- security policy;
- broad test deletion/weakening;
- architecture rewrites.

### Independent validation

Hermes saying "green" is useful telemetry; the required GitHub Actions check is the authoritative signal.

---

## 10. Review and merge policy

### Initial policy

**No unattended agent-authored merges.**

Recommended early flow:

- Antigravity implementation → Codex review → GitHub Actions → human merge.
- Hermes fix → Codex review → GitHub Actions → human merge.
- Codex fix → GitHub Actions → human review/merge.

This intentionally creates a small amount of friction while the system earns trust.

### Future low-risk auto-merge

Only consider auto-merge after a substantial successful history, and only for a narrow documented class of changes with all of the following:

- low risk classification;
- no API/schema/security/product behavior change;
- required CI checks green;
- change scope within explicitly allowed paths;
- reviewer policy satisfied;
- no weakened/deleted required tests;
- no dependency/security-sensitive change unless separately approved.

---

## 11. Slack design

Organize Slack around **projects**, not fake employee departments.

Recommended structure:

- `#dual-dex` — DualDex project activity.
- `#savebridge` — SaveBridge project activity.
- `#dungeon-dispatcher` — game project activity when development begins.
- `#agent-ops` — system-wide failures: dead workers, auth failures, queue/lease problems, provider outages.
- existing general/social channels remain human spaces.

### Default project-channel events

Post only meaningful transitions:

- ▶️ task started / assigned;
- 🧪 PR ready for verification;
- 🚨 CI failure or escalation requiring attention;
- ✅ completed/merged;
- ⛔ stopped/blocked.

Do **not** post every file edit, tool call, compiler invocation, or retry to the channel by default. Detailed execution history belongs in logs/GitHub. If a task needs discussion, keep it in one Slack thread tied to the GitHub issue/PR.

### Slack as a control surface

Incoming webhooks are sufficient for early outbound notifications. A real Slack app/bot can be added later for authenticated commands such as:

- `stop <task>`
- `retry <task>`
- `status <task>`
- `approve <task>`

Those commands must map to router state transitions; Slack itself is not the authoritative task database.

---

## 12. DeepSeek Harness placement

DeepSeek Harness is useful for multi-agent debugging/research and may eventually host richer routing workflows, but the initial architecture should not depend on it as the sole orchestration hub.

Use it initially for tasks such as:

- parallel root-cause hypotheses;
- codebase research;
- test-generation proposals;
- implementation/review subagents;
- comparing multiple debugging strategies.

The Sonoran router still owns authorization, state, leases, retry counts, and dispatch policy. This keeps the orchestration layer stable even if DeepSeek Harness changes or is replaced.

---

## 13. End-to-end scenarios

### A. Feature: goal → PR

1. Human creates/approves an issue.
2. Codex turns it into a scoped envelope with acceptance criteria.
3. Human applies/approves the authorization signal (`agent:ready` initially).
4. Router creates the task record, branch/worktree lease, and assigns Antigravity.
5. Human drives Antigravity during the early rollout.
6. Antigravity commits/pushes and opens/updates the PR.
7. Codex reviews the diff against acceptance criteria.
8. GitHub Actions runs the canonical CI contract.
9. Human merges when review + required checks are satisfied.
10. Router marks the task done and Slack receives one concise completion message.

### B. Mechanical CI failure: Hermes repair

1. GitHub Actions reports a failure on an authorized task PR.
2. Router assigns a Hermes repair lease for the affected task/worktree.
3. Hermes tries the smallest mechanical fix within scope.
4. Hermes commits/pushes the candidate repair.
5. GitHub Actions independently verifies it.
6. Codex reviews the repair.
7. Human merges during the initial policy period.

### C. Hard failure: escalation

1. Hermes reaches the attempt limit or detects a design/API/schema decision.
2. Router changes the task to `blocked/escalated`.
3. Hermes updates the handoff envelope with attempts and evidence.
4. Codex receives a new debugging lease.
5. If Codex cannot resolve it without a product decision, the task escalates to the human with the full GitHub trail already attached.

---

## 14. Current implementation gaps to fix before unattended use

The existing scaffolding demonstrates the intended flow, but it is not yet a production-safe control plane.

### Router

- Replace shell-string dispatch with executable + argument-array dispatch (`shell: false`).
- Parse and validate the handoff envelope instead of routing based only on generic webhook event/action fields.
- Add task IDs and correct issue/PR identifiers to the event context.
- Reject missing webhook signatures outside explicit local-dev mode.
- Add body-size limits, execution timeouts, concurrency limits, and cancellation.
- Add GitHub delivery-ID deduplication.
- Add SQLite task/run/lease state.
- Add trusted actor/label authorization gates.

### Workspaces

- Move from a shared checkout to isolated git worktrees.
- Store worktree path/base SHA/lease state in SQLite.
- Validate scope before commit/push.

### Slack notifications

- Stop sourcing task-repository `.env` files as executable shell configuration.
- Keep Slack credentials in orchestration-owned configuration outside worktrees.
- Reduce default notifications to meaningful state transitions.

### CI

- Define the canonical build/test command in the pilot repo.
- Run that same contract in GitHub Actions.
- Make GitHub checks authoritative instead of trusting the repair agent's local result.

---

## 15. Risk register

| Risk | Mitigation |
|---|---|
| Duplicate webhooks launch duplicate agents | Store delivery IDs in SQLite and make dispatch idempotent. |
| Two agents mutate the same checkout | One isolated worktree + lease per active task. |
| Branch moves under a worker | Store/verify base SHA and lease before push. |
| Public issue triggers shell access | Trusted actor/label authorization gate before dispatch. |
| Webhook text causes command injection | No `shell: true`; fixed executable + validated args. |
| Worker accesses orchestration secrets | Secrets live outside task worktrees; least-privilege env injection. |
| Infinite fix loop | Attempt/time budgets + explicit blocked/escalated state. |
| Agent makes tests pass incorrectly | Independent GitHub Actions + reviewer + initial human merge gate. |
| Slack becomes unreadable | Post state transitions only; keep detailed logs in GitHub/router logs. |
| DeepSeek/Hermes/vendor behavior changes | Vendor-neutral router state and GitHub artifacts remain authoritative. |
| Infrastructure steals time from products | Phase gates; pilot only on DualDex; stop if it does not save time. |

---

## 16. Rollout strategy

Use **DualDex as the pilot** because its existing behavior is understood and failures are easier to judge. Do not start by testing the orchestrator on SaveBridge or Dungeon Dispatcher while those products are themselves undefined.

High-level phases:

- **M0 — Manual benchmark:** manually execute the proposed role split on one real DualDex task.
- **M1 — Visibility:** clean GitHub/agent → Slack state notifications.
- **M1.5 — Safety/control plane:** SQLite state, authorization gate, safe dispatch, worktrees, leases.
- **M2 — Build repair pilot:** Hermes repairs a deliberately broken DualDex branch; GitHub Actions independently verifies it.
- **Evaluation gate:** decide whether the stack is actually saving time.
- **M3 — Structured handoffs:** automate Codex → implementer → review/CI transitions.
- **M4 — Operations layer:** authenticated Slack controls, richer DeepSeek specialist workflows, optional remote access.

The detailed checklist, acceptance criteria, and suggested task order live in [`IMPLEMENTATION_ROADMAP.md`](IMPLEMENTATION_ROADMAP.md).

---

## 17. Definition of success

The orchestrator succeeds when it makes shipping Sonoran Solutions software **faster and safer than working manually**.

A successful first version should be able to take one well-scoped DualDex issue through:

```text
human goal
→ Codex plan
→ authorized task
→ isolated implementation worktree
→ PR
→ independent CI
→ review
→ human merge
→ concise Slack completion
```

and handle at least one deliberately introduced CI failure through a bounded Hermes repair/escalation flow.

If maintaining the orchestration infrastructure takes more time than it saves, stop expanding it and return effort to SaveBridge / Dungeon Dispatcher.

---

## 18. References

- Hermes Agent: [docs](https://hermes-agent.nousresearch.com/docs/), [Slack](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/slack/), [local models](https://hermes-agent.nousresearch.com/docs/user-guide/local-models), [Ollama setup](https://hermes-agent.nousresearch.com/docs/guides/local-ollama-setup), [GitHub repo](https://github.com/nousresearch/hermes-agent)
- Antigravity: [MCP](https://antigravity.google/docs/mcp), [SDK MCP](https://antigravity.google/docs/sdk/mcp), [Google Workspace MCP codelab](https://codelabs.developers.google.com/google-workspace-mcp-antigravity)
- Codex: [hooks doc](https://github.com/openai/codex/blob/main/docs/hooks.md)
- DeepSeek Harness: [repo](https://github.com/deepseek-ai/deepseek-harness)
