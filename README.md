# Agent stack — working artifacts

A concrete starter kit for a multi-agent coding stack. All four artifacts below
share one design (see [`AGENT_ORCHESTRATION_PLAN.md`](AGENT_ORCHESTRATION_PLAN.md))
and the decisions you've made so far.

## The stack

| Agent | Role |
|---|---|
| Codex | Planner + Debugger/bug fixer |
| Google Antigravity (interactive app) | Implementer — **human-steered** |
| Hermes Agent (Nous) | Build herald — live build/test debugging, always-on |
| DeepSeek Harness | Router/hub **and** in-house multi-agent debug layer |

**Neutral bus:** GitHub (durable record + handoff) · Slack (per-project channel,
human view) · webhooks (wake-ups). No single vendor is the hub.

## The artifacts

| Folder | What it is | Milestone |
|---|---|---|
| `slack-notify/` | Post change events to a project channel. `hooks.json` + script for Codex/DSH; GitHub Actions backstop for everyone. | **M1** — visibility |
| `handoff/` | The envelope template + ownership/turn-taking rules agents follow. | M1–M3 |
| `hermes-watch/` | `fix-build` skill + trigger config for the always-on build debugger. | **M2** — build herald |
| `router/` | Dependency-free GitHub webhook → agent wake-up relay (DSH hub path). | **M3** — handoff |

## Quickstart

**M1 — visibility (do this first, zero risk)**
1. Create a Slack incoming webhook per project channel → copy into `.env`
   (see `slack-notify/.env.example`).
2. Copy `slack-notify/` into each repo as `.agent-stack/`, set the webhook.
3. Test: `DRY_RUN=1 .agent-stack/slack-notify.sh test`, then real `test`.
4. Point Codex at `hooks.json` (and mount it in DSH via
   `@deepseek-ai/dsh-hooks-codex`).
5. Add `slack-notify/workflows/slack-notify.yml` to `.github/workflows/` +
   the `SLACK_WEBHOOK_URL` secret → every agent/human push is reported.

**M2 — build herald**
1. Install Hermes Agent, use a local model (Hermes 4 via Ollama/llama.cpp).
2. Copy `hermes-watch/fix-build.skill.md` into Hermes' skills dir.
3. Set `HERMES_WATCH_REPO` / `HERMES_BUILD_CMD` / `WATCH_BRANCH` /
   `SLACK_WEBHOOK_URL`.
4. Wire a trigger (see `hermes-watch/triggers.md`): HTTP on push + cron safety net.

**M3 — handoff**
1. Define each repo's canonical build command (`./ci.sh <build|test>`).
2. Run `router/` (`node server.mjs`), point a GitHub webhook at it.
3. Add rules: push→Hermes, `to: codex` issue→Codex, PR→human for Antigravity.
4. Agents read/write the handoff envelope in issues; humans merge features,
   auto-merge build-only fixes.

**M4 — hub + remote**
- DeepSeek Harness as the router (register the same GitHub webhook against its
  GitHub adapter) and as the in-house multi-agent debug layer. Choose relay or
  DSH adapter per action.
- Later: expose the router + DSH web UI over a private tunnel for remote access.

## Decisions locked in (this conversation)

- **Antigravity is interactive/human-steered** → implementation is a human step;
  automation handles Codex/Hermes/DSH edges.
- **DeepSeek = both hub/router and in-house debug layer.**
- **Auto-merge build-only fixes; human approval on features.**
- **Single machine**, self-hosted; remote access is a later nice-to-have.

## Open item (per repo)

- **Canonical build command** — every agent must run the same `./ci.sh`. Define
  it per repo in M1.

## Honest caveats

- **Accuracy:** the Codex `hooks.json` schema and the Hermes skill/cron/trigger
  syntax are adapted from each product's docs and can drift between versions —
  verify against your installed versions. The **logic** (ownership rules, the
  envelope, the bounded fix loop, the routing) is version-independent.
- **Security:** never commit real `.env`/secrets; GitHub webhook secrets and Slack
  URLs should live in a secret store. The router warns you to set a signature
  secret and to only accept webhooks on a trusted network.
