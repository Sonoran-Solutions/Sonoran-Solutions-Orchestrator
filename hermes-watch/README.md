# Hermes CI Repair Worker

Hermes is the **bounded CI repair technician** in the Sonoran Solutions workflow.

It should not blindly watch a shared branch and continuously mutate code. The target model is narrower: an **authorized task** receives an isolated worktree/lease, Hermes reproduces a concrete CI failure, attempts a small mechanical repair inside a real OS sandbox, records a local candidate commit + structured result, and then waits for **independent GitHub Actions verification + review**.

See [`fix-build.skill.md`](fix-build.skill.md) for the operating procedure and [`../IMPLEMENTATION_ROADMAP.md`](../IMPLEMENTATION_ROADMAP.md) for the M2 pilot.

## Role

Hermes may:

- reproduce the canonical build/test failure;
- inspect the files implicated by that failure;
- make a small repair inside the assigned `allowed_paths`;
- run the canonical local CI command;
- record a LOCAL candidate commit and return structured evidence;
- escalate with evidence when it is stuck or judgment is required.

Hermes may **not**:

- expand its own scope;
- make product/API/schema/security decisions;
- weaken meaningful tests just to get green;
- share a dirty checkout with another worker;
- declare its own local result authoritative;
- merge its own repair;
- push (ORCH-080/router-owned push remains open — it has no owner Git credentials).

## Pilot setup

Do not begin here. Complete the M1.5 safety/control-plane phase first.

For M2:

1. Define the DualDex canonical CI command(s).
2. Run the same CI contract in GitHub Actions.
3. Configure the router to allocate an authorized task/run/worktree lease.
4. Install Hermes (see [INSTALL.md](INSTALL.md)) and the `fix-build` skill.
5. The router provides validated task context as structured `SONORAN_*`
   environment variables (task/run/lease ID, isolated worktree path, branch,
   base SHA, allowed paths, canonical build command, attempt/max-attempt state).
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

## Security boundary

Hermes runs inside `sandbox-exec` (bubblewrap) with a curated root filesystem —
see [INSTALL.md](INSTALL.md). Env allowlisting (router) and filesystem
sandboxing (launcher) are **separate** boundaries. `--yolo` is only acceptable
because it executes inside the sandbox; the sandbox is the security boundary.
Hermes's effective HOME is a dedicated sandbox home, not the owner's HOME.

## Attempt policy

The attempt ceiling comes from the router, not from Hermes. It counts **repair
attempts only** — unrelated planning/implementation runs on the same task do not
consume the budget. The control plane refuses repair attempt `N+1` before
launching a worker, so a fourth autonomous repair attempt is impossible without
human re-authorization.

For the initial pilot the limit is **3 attempts**. Reaching the limit means
escalation, not resetting the counter.

## Result contract

Hermes writes a structured JSON result to `$SONORAN_RESULT_FILE` (status:
`candidate_fix` / `no_fix` / `escalate` / `blocked`, plus evidence fields). The
router validates it (including that the claimed `attempt` matches the
router-owned repair attempt) and **durably persists** it into `runs.result`, so
worktree reconstruction cannot lose it. `escalate`/`blocked` stop the autonomous
loop. Free-form worker prose never mutates router state.

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
| `fix-build.skill.md` | Repair procedure, `SONORAN_*` context, structured result, escalation. |
| `triggers.md` | How Hermes should be awakened without bypassing task authorization/state. |
| `INSTALL.md` | Install/version/config/upgrade, sandbox, skill deployment + smoke tests. |
| `sandbox-exec` | The fixed OS filesystem sandbox (bubblewrap curated root). |
| `run-hermes-sandboxed` | Router-facing launcher that runs Hermes inside `sandbox-exec`. |
| `deploy-fix-build-skill.sh` | Deploys the repo-controlled `fix-build` skill into the sandbox HOME. |
| `sandbox-test.sh` | Deterministic boundary tests (worktree RW, host-credential denial). |

## Accuracy note

Hermes' exact skill/trigger configuration can change between versions. Confirm current syntax against Hermes documentation when implementing M2. The durable part of this repo is the **workflow contract**: authorized task, isolated worktree, bounded mechanical repair, independent CI, review, escalation.
