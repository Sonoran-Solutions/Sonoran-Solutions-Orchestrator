# Slack notification kit

Posts a change event to a project's Slack channel. One incoming webhook per
project channel is the simplest wiring. Works for **Codex**, **DeepSeek Harness**,
and (via the GitHub action) any agent that pushes to the repo.

## Files

| File | Purpose |
|---|---|
| `slack-notify.sh` | Posts to a Slack incoming webhook. Safe offline mode via `DRY_RUN=1`. |
| `hooks.json` | Codex/DSH hook config — fires the script after file-modifying tools. |
| `.env.example` | Webhook + identity settings. Copy to `.env`, fill in, never commit. |
| `workflows/slack-notify.yml` | GitHub → Slack on push/PR (the cross-harness backstop). |

## Install per repo

Copy this whole `slack-notify/` folder into each repo as `.agent-stack/` (or
symlink it), then drop a `.env` at the repo root or in `.agent-stack/`:

```bash
mkdir -p .agent-stack
cp -r /home/dq/agent-stack/slack-notify/. .agent-stack/
cp .agent-stack/.env.example .env      # then fill in SLACK_WEBHOOK_URL etc.
chmod +x .agent-stack/slack-notify.sh
```

## 1. Create the webhook

- Slack → *Apps* → **Incoming Webhooks** → *Add to Slack* → pick the project
  channel → copy the `https://hooks.slack.com/services/...` URL.
- Put it in `.env` as `SLACK_WEBHOOK_URL`. Every agent and action reads the same
  webhook, so one URL per project channel.

## 2. Test it (no network needed first)

```bash
cd <repo>
DRY_RUN=1 .agent-stack/slack-notify.sh test      # prints payload, does not post
.agent-stack/slack-notify.sh test                # real post once webhook is set
```

## 3. Wire it into each agent

**Codex** — point Codex at a hooks config. Copy `hooks.json` to
`.codex/hooks.json` in the repo, or set your global/project hook config to
load it. The `PostToolUse` matcher triggers the script, which filters out
non-file-changing tools (compiles, reads, etc.) and posts only for edits and
commit/push commands.

**DeepSeek Harness** — the harness runs your existing Codex hooks config, so the
same `hooks.json` just works. Mount the adapter pointing at it:

```yaml
- name: '@deepseek-ai/dsh-hooks-codex'
  config:
    configPath: ./.codex/hooks.json     # or wherever you keep hooks.json
    model: deepseek-v4
```

Inside the harness, the `tool` subcommand reads the hook payload on stdin and
notifies only for file mutations / commits / pushes (tunable via `MUTATION_RE`).

**Antigravity** — you use the interactive app, so it has no hooks.json. Two
options: rely on the GitHub → Slack workflow (Layer A) to report its commits, or
have it call `postMessage` through a Slack MCP server if you wire one up later.

## 4. GitHub → Slack (the backstop)

Copy `workflows/slack-notify.yml` to `.github/workflows/slack-notify.yml` and add
`SLACK_WEBHOOK_URL` as a **repo/org secret**. This reports *every* push/PR from
*any* agent (Codex, Antigravity, Hermes, DeepSeek) or human — so nothing slips
through even if a per-agent hook misses.

## Test the filter without Slack

```bash
# A "read"-type tool should NOT notify (exits quietly):
echo '{"tool_name":"Read","tool_input":{"file_path":"src/a.ts"}}' \
  | .agent-stack/slack-notify.sh tool && echo "sent" || echo "skipped"

# A file-edit tool SHOULD notify (DRY_RUN prints the payload):
echo '{"tool_name":"Edit","tool_input":{"file_path":"src/a.ts"}}' \
  | DRY_RUN=1 .agent-stack/slack-notify.sh tool
```
