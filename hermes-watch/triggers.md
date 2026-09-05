# Triggers for the build watcher

The `fix-build` skill needs to be *started* when the watcher should act. Two ways:

## 1. HTTP trigger (preferred — event-driven)

Hermes supports HTTP triggers (per the docs). Register one that starts `fix-build`
when a push/PR webhook arrives for the watched repo. A push event is the natural
"something changed, go build" signal.

```bash
# Example (GitHub webhook -> router -> Hermes HTTP trigger):
# The router (../router/) can POST here on a matching GitHub event.
curl -X POST http://127.0.0.1:<hermes-http-port>/trigger \
  -H 'Content-Type: application/json' \
  -d '{"repo":"myorg/project","branch":"feat/123","event":"push"}'
```

## 2. Cron fallback (ensures a stuck build is never silently left red)

A cron job that periodically runs the build check on the watched branch. If it's
red and no fix is in progress, start the loop.

```yaml
# Representative declaration — CONFIRM the exact cron/trigger schema against
# https://hermes-agent.nousresearch.com/docs/ (it varies by Hermes version).
cron:
  - name: build-watch-feat
    schedule: "*/5 * * * *"      # every 5 minutes
    command: fix-build
    env:
      HERMES_WATCH_REPO: /path/to/repo
      HERMES_BUILD_CMD: ./ci.sh test
      WATCH_BRANCH: feat/123
```

> **Verify:** the precise YAML keys for cron / HTTP triggers and how to pass `env`
> differ between Hermes versions. Check the current docs before wiring — the
> *logic* in `fix-build.skill.md` is stable; the trigger syntax is not.

## Recommended setup

- **HTTP trigger** for immediacy on real commits.
- **Cron every few minutes** as the safety net, with a guard so it doesn't start a
  second `fix-build` for a branch that's already being fixed.
- Use a **local model** (Hermes 4 via [Ollama](https://hermes-agent.nousresearch.com/docs/guides/local-ollama-setup) or the
  [built-in local runtime](https://hermes-agent.nousresearch.com/docs/user-guide/local-models))
  so poll-and-fix loops cost nothing in API fees.
