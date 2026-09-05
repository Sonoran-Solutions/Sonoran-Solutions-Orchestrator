# Hermes Build Watcher

The always-on **build herald** that watches a branch, keeps it green, and
escalates to Codex when a failure needs real debugging. Matches your "Hermes
agent that can do live debugging while running a build."

## Install

1. Install Hermes Agent ([docs](https://hermes-agent.nousresearch.com/docs/)) on
   your box. Run it self-hosted with the terminal UI
   (`hermes`) and the messaging gateway so it can post to Slack.
2. Use a **local model** (Hermes 4 via Ollama / the built-in local runtime) for
   the fix loop — free and fast enough for 100-step loops.
3. Copy `fix-build.skill.md` into your Hermes **skills** directory (adapt the
   front-matter to your Hermes version).
4. Set up triggers (see [`triggers.md`](triggers.md)) — an HTTP trigger for
   push-driven checks plus a cron safety net.
5. Give Hermes a `.env` with `HERMES_WATCH_REPO`, `HERMES_BUILD_CMD`,
   `WATCH_BRANCH`, and `SLACK_WEBHOOK_URL` (the same project webhook the other
   agents use).

## What it does

```
push / cron
   │
   ▼
run $HERMES_BUILD_CMD ── green ──▶ post ✅ to Slack, wait
   │
   ▼ red
collect errors → patch smallest fix → rebuild
   ├─ fixed (≤5 tries) ──▶ commit + push + post fix summary
   └─ still red / needs design ──▶ open fix/<issue>, envelope to: codex,
                                    post escalation, stop
```

## Guardrails (baked into the skill)

- Max 5 fix attempts, then escalate — no infinite loops.
- Revert on regression; one scoped commit per fix.
- No design decisions — escalate instead of inventing behavior.
- One canonical `$HERMES_BUILD_CMD` shared by every agent = one definition of green.

## Files

| File | Purpose |
|---|---|
| `fix-build.skill.md` | The operating procedure (loop + limits + escalation). |
| `triggers.md` | How to start the watcher (HTTP trigger + cron safety net). |

## Note on accuracy

Hermes' exact skill/cron/trigger config schema changes across versions. The
**procedure** in `fix-build.skill.md` is the durable part; confirm the current
`cron`/`trigger`/skill front-matter syntax in the Hermes docs before wiring.
