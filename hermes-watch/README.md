# Hermes CI Repair Worker

Hermes is the **bounded CI repair technician** in the Sonoran Solutions workflow.

It should not blindly watch a shared branch and continuously mutate code. The target model is narrower: an **authorized task** receives an isolated worktree/lease, Hermes reproduces a concrete CI failure, attempts a small mechanical repair, pushes a candidate, and then waits for **independent GitHub Actions verification + review**.

See [`fix-build.skill.md`](fix-build.skill.md) for the operating procedure and [`../IMPLEMENTATION_ROADMAP.md`](../IMPLEMENTATION_ROADMAP.md) for the M2 pilot.

## Role

Hermes may:

- reproduce the canonical build/test failure;
- inspect the files implicated by that failure;
- make a small repair inside the assigned `allowed_paths`;
- run the canonical local CI command;
- push a candidate fix;
- escalate with evidence when it is stuck or judgment is required.

Hermes may **not**:

- expand its own scope;
- make product/API/schema/security decisions;
- weaken meaningful tests just to get green;
- share a dirty checkout with another worker;
- declare its own local result authoritative;
- merge its own repair.

## Pilot setup

Do not begin here. Complete the M1.5 safety/control-plane phase first.

For M2:

1. Define the DualDex canonical CI command(s).
2. Run the same CI contract in GitHub Actions.
3. Configure the router to allocate an authorized task/run/worktree lease.
4. Install Hermes and the `fix-build` skill.
5. Provide validated task context such as:
   - task/run ID;
   - isolated worktree path;
   - branch/base SHA;
   - allowed paths;
   - canonical build command;
   - attempt/max-attempt state.
6. Keep orchestration secrets outside the task worktree.
7. Start with **deliberately broken pilot branches** before real autonomous repair.

## Target flow

```text
GitHub Actions failure on authorized task
        │
        ▼
router validates task + assigns Hermes lease
        │
        ▼
Hermes reproduces canonical failure locally
        │
        ├─ requires judgment/scope expansion ──▶ escalate + stop
        │
        ▼
small mechanical repair within allowed paths
        │
        ▼
local canonical CI command
        │
        ├─ regression ──▶ revert attempt
        │
        └─ promising/green ──▶ commit + push candidate
                                  │
                                  ▼
                           GitHub Actions
                                  │
                    ┌─────────────┴─────────────┐
                    │                           │
                  green                         red
                    │                           │
               Codex review              retry only if
                    │                     budget/scope allow
               human merge
             (initial policy)
```

## Attempt policy

The attempt ceiling should come from the task/router rather than be hard-coded into Hermes.

For the initial pilot, start low (for example **3 attempts**) and measure whether extra attempts produce useful fixes or just churn. Reaching the limit means escalation, not resetting the counter.

## Slack policy

Avoid posting every build/retry/edit.

Useful project-channel transitions are:

- repair started/assigned (optional if router already posted it);
- candidate ready / CI verification started;
- blocked/escalated;
- verified/review-ready.

Detailed logs belong in GitHub/task logs.

## Files

| File | Purpose |
|---|---|
| `fix-build.skill.md` | Repair procedure, limits, scope rules, CI handoff, escalation. |
| `triggers.md` | How Hermes should be awakened without bypassing task authorization/state. |

## Accuracy note

Hermes' exact skill/trigger configuration can change between versions. Confirm current syntax against Hermes documentation when implementing M2. The durable part of this repo is the **workflow contract**: authorized task, isolated worktree, bounded mechanical repair, independent CI, review, escalation.
