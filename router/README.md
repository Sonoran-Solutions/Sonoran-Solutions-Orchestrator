# Router relay (the "hub")

A tiny, dependency-free Node server that turns GitHub events into **agent
wake-ups**. It never runs an agent itself — it only routes a matching event to a
target (an HTTP endpoint, e.g. the Hermes trigger, or a shell command, e.g.
`codex exec` / the DeepSeek Harness headless CLI) and posts a summary to Slack.

This is where "DeepSeek Harness as the router/hub" lands: DSH receives the
GitHub webhook and can either dispatch from here, or (more in the spirit of the
harness) you register the same webhook directly against DSH's GitHub adapter to
spawn a session. Choose one approach per action, not both.

## Run it

```bash
cd router
cp config.example.json config.local.json   # edit secrets + rules
node server.mjs                            # listens on :8090
```

Requires Node 18+ (global `fetch`). No `npm install`.

## Wire GitHub → router

Repo → Settings → Webhooks → **Add webhook**:
- Payload URL: `http://<your-ip>:8090/github` (any path works — the server accepts POSTs)
- Content type: `application/json`
- Secret: the same as `githubSecret` in `config.local.json`
- Events: `push`, `pull_request`, `issues`, `issue_comment` as needed

The server verifies the `X-Hub-Signature-256` HMAC before dispatching.

## Matching & dispatch

Each target has a `when` (event/repo/branch/action filters) and a `run`:

- `type: "http"` → `fetch` the URL (e.g. POST to Hermes' HTTP trigger). Placeholders
  `{{repo}}`, `{{branch}}`, `{{event}}`, `{{action}}`, `{{sender}}`, `{{head}}` are
  interpolated into the URL/body.
- `type: "exec"` → spawn a shell command (e.g. `codex exec ...` or the DSH
  headless CLI) with the same context as env vars.

Every dispatch is logged to `dispatch.log` (set `dispatchLog`).

## Example rules (see `config.example.json`)

- `push` on a feature/fix branch → wake the Hermes build watcher.
- `issues`/`issue_comment` with a handoff envelope saying `to: codex` → run Codex.
- `pull_request` opened → notify a human to drive Antigravity, then review/merge.

## DeepSeek Harness as the hub (alternative)

Instead of (or in addition to) this relay, register the GitHub webhook directly
with DSH's GitHub adapter so an event spawns a session with a prompt:

```yaml
- name: '@deepseek-ai/dsh-webhook-github'
  config:
    secret: <same githubSecret>
    # on event -> create a session whose prompt routes the work
```

That keeps routing inside the harness (subagents/workflows) and lets one of the
DSH agents act as the dispatcher. **Pick this or the relay per action**, not both.

## Remote access (future nice-to-have)

Once this runs on your box, expose it privately so you can trigger/watch from
other devices: Cloudflare Tunnel or Tailscale to `:8090` (and to the DeepSeek
web UI port) — same hostname, no public exposure. Not part of the initial build.
