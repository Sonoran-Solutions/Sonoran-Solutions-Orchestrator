# Triggers for the Hermes repair worker

The `fix-build` skill should start only for a **known, authorized task/run**. A raw public push/issue event should not directly grant Hermes repository write access.

## Preferred trigger path

```text
GitHub event / CI result
        │
        ▼
Sonoran router
  - verify signature
  - dedupe delivery
  - authorize task
  - validate state/envelope
  - allocate Hermes lease/worktree
        │
        ▼
Hermes trigger
  - task_id
  - run_id
  - worktree
  - branch/base SHA
  - allowed paths
  - build command
  - attempt budget
```

This keeps Hermes focused on repair reasoning while the router owns authorization and orchestration policy.

## HTTP trigger

An HTTP trigger is appropriate after the event has passed the router's policy checks.

Representative payload:

```json
{
  "task_id": "ss-141",
  "run_id": "ss-141-003",
  "repo": "sonoran-solutions/dualdex",
  "branch": "fix/141",
  "base_sha": "8f2c91a44d8f",
  "worktree": "/worktrees/dualdex/issue-141-hermes",
  "build_cmd": "./ci.sh test",
  "attempt": 2,
  "max_attempts": 3
}
```

The exact Hermes HTTP-trigger syntax/API must be confirmed against the installed Hermes version.

## GitHub-native/event integration

If Hermes is later configured to receive GitHub events directly, it must not bypass the same security model. Either:

1. the direct integration is limited to non-mutating observation; or
2. it performs equivalent authorization/dedupe/task validation before any code-changing repair begins.

Do not maintain two independent systems that can both launch the same repair.

## Cron fallback

Cron can be useful for detecting a stuck orchestrator/run, but it should **not** blindly poll a branch and start a second repair loop.

A safe cron-style check should ask the durable task store/router something like:

```text
Are there authorized Hermes runs in assigned/in_progress state
that have no live worker and whose lease/retry policy allows restart?
```

Only then should it resume/re-dispatch the known run according to policy.

Do not make "branch is red" alone sufficient to start arbitrary repair work.

## Required anti-duplication behavior

Before Hermes starts:

- GitHub delivery/event has been deduplicated;
- task/run ID is known;
- no conflicting active lease exists;
- the current attempt budget allows work;
- the worktree/base SHA still matches the lease.

If any condition fails, report/escalate rather than launching another worker.

## Secrets

Do not pass Slack/GitHub/model secrets through task-controlled files in the worktree. The orchestration process should inject only the minimum required credentials/configuration from outside the checkout.

## Implementation order

Trigger wiring is an **M2 task**. Complete the M1.5 router/auth/state/worktree work first. See [`../IMPLEMENTATION_ROADMAP.md`](../IMPLEMENTATION_ROADMAP.md).
