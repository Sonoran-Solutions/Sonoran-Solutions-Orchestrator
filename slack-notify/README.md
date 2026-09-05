# Slack notification kit

Prototype helpers for sending Sonoran Solutions workflow events to project Slack channels.

**Current direction:** Slack is a human-facing operations view, not the durable task database. Default notifications should describe meaningful **task-state transitions**, not every tool call or file edit.

See [`../AGENT_ORCHESTRATION_PLAN.md`](../AGENT_ORCHESTRATION_PLAN.md) and [`../IMPLEMENTATION_ROADMAP.md`](../IMPLEMENTATION_ROADMAP.md) before wiring this for unattended workers.

## Recommended channel model

Organize channels around projects:

- `#dual-dex`
- `#savebridge` (when active)
- `#dungeon-dispatcher` (when active)
- `#agent-ops` for orchestrator-wide failures/alerts

Do not create one channel per agent. The agents are implementation details; projects are the durable unit humans care about.

## Default notification policy

Top-level project messages should normally be limited to:

- ▶️ task assigned/started;
- 🧪 PR ready / verification started;
- 🚨 blocked or escalated;
- ✅ completed/merged;
- ⛔ stopped/cancelled.

Detailed retry logs, compiler output, tool calls, and file-edit chatter belong in GitHub/task logs. If a task needs discussion, prefer one Slack thread tied to the GitHub issue/PR.

## Files

| File | Purpose |
|---|---|
| `slack-notify.sh` | Prototype incoming-webhook sender with `DRY_RUN=1`. |
| `hooks.json` | Legacy/experimental Codex/DSH mutation hook wiring. Useful for testing attribution, but too noisy for the target default workflow. |
| `.env.example` | Prototype configuration example. **Do not make task-controlled repo `.env` files the secret source for unattended orchestration.** |
| `workflows/slack-notify.yml` | GitHub → Slack example/backstop. Tune events so it does not duplicate router/app notifications. |

## Security/configuration direction

For the initial manual M1 visibility phase, a local `.env` can be convenient for smoke tests.

Before unattended workers are enabled:

- keep Slack credentials in orchestration-owned configuration **outside task worktrees**;
- do not source arbitrary `.env` files from agent-controlled repository checkouts;
- inject only the minimum Slack configuration required by the notification process;
- never include tokens/webhook URLs in GitHub issues, PRs, handoff envelopes, or logs.

The current `slack-notify.sh` still supports repo-local `.env` loading because it is prototype scaffolding. Treat removing/replacing that behavior as part of M1/M1.5, not as the long-term secret model.

## M1 smoke test

Use the helper only to prove the outbound path works:

```bash
DRY_RUN=1 ./slack-notify.sh test
./slack-notify.sh test
```

Then verify a real DualDex task/PR can produce one concise message linking back to GitHub.

## Mutation hooks

`hooks.json` and the `tool` subcommand can still be useful during development to understand what Codex/DeepSeek are doing, but **do not enable mutation-level messages as the normal project-channel experience**.

If you temporarily test them:

```bash
# A read-type tool should be ignored.
echo '{"tool_name":"Read","tool_input":{"file_path":"src/a.ts"}}' \
  | DRY_RUN=1 ./slack-notify.sh tool

# A file-edit tool can be inspected in dry-run mode.
echo '{"tool_name":"Edit","tool_input":{"file_path":"src/a.ts"}}' \
  | DRY_RUN=1 HOOK_ALWAYS=1 ./slack-notify.sh tool
```

Keep this debug signal separate from the eventual state-transition notifications.

## GitHub → Slack backstop

A GitHub Action can report cross-harness events, but avoid configuring multiple layers to post the same event. Pick one owner for each notification category.

For example:

- GitHub/Actions → verification state;
- router → assignment/escalation/task completion state;
- `#agent-ops` → orchestrator failures.

## Future Slack control plane

Incoming webhooks are outbound-only scaffolding. After M3 is reliable, a real Sonoran Orchestrator Slack app can provide authenticated commands such as:

```text
status <task>
stop <task>
retry <task>
approve <task>
```

Those commands must translate into validated router/GitHub state transitions. Slack itself never becomes the source of truth.
