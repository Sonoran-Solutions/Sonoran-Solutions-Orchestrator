# Slack notification kit

Helpers for sending Sonoran Solutions workflow events to project Slack channels.

**Policy:** Slack is a human-facing operations view, not the durable task
database. Default notifications describe meaningful **task-state transitions**,
not every tool call or file edit.

See [`../AGENT_ORCHESTRATION_PLAN.md`](../AGENT_ORCHESTRATION_PLAN.md) and
[`../IMPLEMENTATION_ROADMAP.md`](../IMPLEMENTATION_ROADMAP.md) before wiring this
for unattended workers.

## Recommended channel model

Organize channels around projects:

- `#dual-dex`
- `#savebridge` (when active)
- `#dungeon-dispatcher` (when active)
- `#agent-ops` for orchestrator-wide failures/alerts

Do not create one channel per agent. Agents are implementation details; projects
are the durable unit humans care about.

## Default notification policy (ORCH-034/035)

Top-level project messages are limited to these five transitions:

| Command | Meaning |
|---|---|
| `task-started <task>` | ▶️ task assigned/started |
| `pr-ready <task>` | 🧪 PR ready / verification started |
| `blocked <task> --reason <why>` | 🚨 blocked or escalated |
| `done <task>` | ✅ completed/merged |
| `stopped <task> --reason <why>` | 🛑 stopped/cancelled |

Per-file/tool-call notifications are **removed**. Compiler output, tool calls,
and retry logs belong in GitHub/task logs, not the project channel.

## Configuration (ORCH-037/038/039)

The script reads plain `KEY=VALUE` lines from:

```
$SONORAN_CONFIG_DIR/orchestrator.env    # default: ~/.config/sonoran/orchestrator.env
```

- Config lives **outside task worktrees**.
- Values are parsed line-by-line and **never sourced/evaluated** as Bash.
- Environment variables override the file.

Copy [`sonoran.env.example`](sonoran.env.example) to `~/.config/sonoran/orchestrator.env`
and fill in the webhook URL. (Optional env vars: `SONORAN_CONFIG_DIR`,
`SONORAN_CONFIG_FILE`, `SLACK_CHANNEL`, `DRY_RUN`.)

## Smoke test

```bash
DRY_RUN=1 ./slack-notify.sh test                 # prints payload, no network
./slack-notify.sh test                           # real post once config is set
./slack-notify.sh pr-ready "ORCH-042" --link "https://github.com/Sonoran-Solutions/dualdex/pull/1"
```

## Files

| File | Purpose |
|---|---|
| `slack-notify.sh` | State-transition sender with safe config loading + `DRY_RUN=1`. |
| `sonoran.env.example` | Orchestration config template (goes in `~/.config/sonoran/`, not the repo). |
| `hooks.json` | Empty no-op. Per-tool Codex/DSH hooks were removed — notifications now fire on state transitions via the router/GitHub Actions. |
| `workflows/slack-notify.yml` | GitHub → Slack example/backstop for push/PR events. |

## Ownership (avoid duplicate posts)

Pick one owner per notification category:

- GitHub Actions → verification/PR state;
- router → assignment/escalation/task-completion state;
- `#agent-ops` → orchestrator failures.

## Future Slack control plane

Incoming webhooks are outbound-only scaffolding. After M3 is reliable, a real
Sonoran Orchestrator Slack app can provide authenticated commands such as
`status <task>`, `stop <task>`, `retry <task>`, `approve <task>`. Those commands
must translate into validated router/GitHub state transitions — Slack never
becomes the source of truth.
