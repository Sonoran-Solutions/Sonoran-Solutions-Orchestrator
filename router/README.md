# Sonoran router

The router is the **deterministic control plane** for the Sonoran Solutions agent workflow.

The current `server.mjs` is prototype relay scaffolding. It demonstrates event → target dispatch, but it must **not** be treated as production-safe or exposed to untrusted/public webhook traffic with code-execution authority in its current form.

See:

- [`../AGENT_ORCHESTRATION_PLAN.md`](../AGENT_ORCHESTRATION_PLAN.md) for the architecture and trust model.
- [`../IMPLEMENTATION_ROADMAP.md`](../IMPLEMENTATION_ROADMAP.md) for the implementation order.
- [`../handoff/handoff-envelope.md`](../handoff/handoff-envelope.md) for the task schema.

## What the router should own

The router owns boring, deterministic orchestration facts:

- webhook authentication;
- trusted-task authorization;
- delivery deduplication;
- task/run state;
- worker leases;
- branch/base SHA tracking;
- worktree ownership;
- attempt/time/concurrency limits;
- handoff-envelope validation;
- worker dispatch;
- cancellation/escalation;
- concise state notifications.

It should **not** ask a model to decide whether a webhook is trusted or which process may be executed.

## What the router should not own

- Product decisions.
- Architecture decisions.
- Model reasoning/debugging.
- The authoritative CI result.
- Slack conversation history as task state.
- A shared dirty working tree.

GitHub remains the durable work record. SQLite should hold runtime orchestration state. GitHub Actions remains the independent required-check authority.

## Target architecture

```text
signed GitHub event
        │
        ▼
normalize + dedupe
        │
        ▼
authorization policy
        │
        ▼
validate task/envelope
        │
        ▼
SQLite transaction
(task/run/lease state)
        │
        ▼
create/confirm isolated worktree lease
        │
        ▼
dispatch fixed executable + validated args
        │
        ├── Codex
        ├── Antigravity (human-steered initially)
        ├── Hermes
        └── DeepSeek specialist workflow
```

## Required event context

Before routing, normalize the webhook into a small internal object containing at least:

```text
delivery_id
webhook_event
webhook_action
repo
issue_or_pr_number
actor
branch
head_sha
base_sha
labels
authorization_facts
```

Do not overload a commit SHA field to represent an issue number. Task identity should be explicit.

## Authorization

A syntactically valid GitHub event is not enough to launch a worker.

Initial recommended policy:

1. webhook signature is valid;
2. delivery ID has not already been processed;
3. repo is allowlisted;
4. actor is trusted **or** a trusted actor applied an `agent:ready` label;
5. task/envelope validates;
6. requested worker/action is allowed for the task's current state.

A random public issue opening must never satisfy this policy by itself.

## Safe dispatch

The current prototype uses interpolated shell commands. Replace that before unattended execution.

### Do not

```text
command = "codex exec \"...{{sender}}...{{branch}}...\""
spawn(command, { shell: true })
```

### Prefer

```text
executable = configured constant
args       = [validated, structured, values]
shell      = false
```

Webhook/task text may be passed to a worker as untrusted prompt/context, but it may not choose the executable, shell syntax, secret path, working directory, or routing policy.

## SQLite state

Recommended minimum tables:

### `tasks`

- `task_id`
- `repo`
- `issue_number`
- `state`
- `risk`
- `current_owner`
- `branch`
- `base_sha`
- timestamps

### `runs`

- `run_id`
- `task_id`
- `agent`
- `attempt`
- `status`
- start/end timestamps
- last result/error

### `deliveries`

- GitHub delivery ID (unique)
- event/action
- received/processed timestamps
- result

### `leases`

- task/run ID
- agent
- worktree path
- branch/base SHA
- expiry
- allowed-path scope

A duplicate delivery should return success/idempotent status without launching a second worker.

## Worktree model

The router should allocate/track an isolated git worktree per execution lease, for example:

```text
/worktrees/dualdex/issue-123-antigravity/
/worktrees/dualdex/issue-141-hermes/
```

Before commit/push, verify:

- lease is still active;
- expected branch/base SHA still matches policy;
- modified paths remain within `allowed_paths`.

Unexpected movement or scope expansion should stop/escalate the run.

## Operational limits

Implement hard bounds before autonomous workers:

- request-body size;
- worker runtime timeout;
- max attempts;
- max concurrent runs per repo/task;
- cancellation;
- stale-lease expiration/reaping;
- log retention.

No infinite retry loops.

## Slack

The router may emit project/ops notifications, but Slack is not task state.

Default messages should be state transitions only:

- started/assigned;
- ready for verification;
- blocked/escalated;
- completed/merged;
- stopped.

Avoid one message per file edit/tool call.

## DeepSeek Harness

DeepSeek Harness can be a powerful worker/specialist-swarm layer, but the initial router should not delegate durable state, authorization, dedupe, or leases to it.

If DSH receives a webhook directly for a future specialist workflow, make sure that event has already passed the same authorization/task policy or that DSH is itself behind an equivalent trusted gate. Do not create two independent routers for the same action.

## Current prototype gaps

Before unattended use, `server.mjs` still needs the following work:

- [ ] replace `shell: true` dispatch;
- [ ] explicit issue/PR/task IDs;
- [ ] handoff-envelope parser + schema validation;
- [ ] trusted authorization gate;
- [ ] mandatory signature verification outside local-dev mode;
- [ ] GitHub delivery dedupe;
- [ ] SQLite task/run/delivery/lease state;
- [ ] request/body limits;
- [ ] worker timeouts;
- [ ] concurrency limits;
- [ ] cancellation;
- [ ] isolated worktree allocation;
- [ ] base-SHA/lease validation;
- [ ] allowed-path enforcement;
- [ ] external orchestration-owned secret/config handling.

These tasks are broken down and ordered in [`../IMPLEMENTATION_ROADMAP.md`](../IMPLEMENTATION_ROADMAP.md).

## Local prototype use

For manual/local experiments only, the existing relay can still be useful as scaffolding:

```bash
cd router
cp config.example.json config.local.json
node server.mjs
```

Keep it on a trusted local network while the safety/control-plane work is incomplete. Do not treat the example config as a secure production configuration.
