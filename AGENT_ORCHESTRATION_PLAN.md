# Multi-Agent Coding Stack — Orchestration Plan

**Status:** Draft for review
**Scope:** Codex + Google Antigravity + Hermes Agent (+ DeepSeek Harness, TBD) working on shared GitHub repos, posting to per-project Slack channels, and handing work off to each other.

---

## 1. Goal

A small "team" of coding agents that:

1. **Post to a per-project Slack channel** whenever one of them changes code (human visibility).
2. **Hand work to each other** through a durable, auditable record (GitHub), with a clear owner at every moment (no two agents editing the same files at once).
3. **Keep builds green autonomously** — an always-on agent watches a build and fixes failures in a tight loop, escalating only when it's stuck.

---

## 2. The stack and role assignments

This is the refined split you described, with an honest note on *why* each tool fits (and where to validate rather than assume).

| Agent | Role | Strengths that justify the role | Notes / caveats |
|---|---|---|---|
| **Codex** | **Planner + Debugger/Bugfixer** | Strong at decomposing specs into tasks, reasoning about a failing system, and producing fixes. `codex exec` gives a headless entry point; hooks.json fires on tool events. | Don't also make it do bulk codegen — keep it off the critical path so it's free for reasoning. |
| **Google Antigravity** | **Implementer ("grunt" work)** | IDE-native bulk edits, scaffolding, project-wide context, MCP connections ([docs/mcp](https://antigravity.google/docs/mcp)); has an SDK and CLI for scripted driving. | Validate the *autonomous* path: if you drive it through the IDE by hand it can't take unattended handoffs. Confirm the [SDK](https://antigravity.google/docs/sdk/mcp) / CLI can run headless before promising full automation. |
| **Hermes Agent** (Nous Research) | **Build Herald — live build/test debugging** | Open-source, self-hosted, always-on; native [Slack](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/slack/), cron scheduling + HTTP triggers, GitHub workflows, MCP, persistent memory; runs a local model (e.g. Hermes 4) for zero API cost. | This is the piece that makes "live debugging while running a build" real — see §6. |
| **DeepSeek Harness** | **TBD — recommended: Orchestrator / Hub** | Already has subagents, multi-agent workflows, an MCP *client*, inbound GitHub-webhook → new-session adapter, headless mode, and runs local *and* API models. | You're still evaluating it. Two ways it fits: as the router that receives events and dispatches to the others (§5.3), or as the in-house multi-agent debugging layer. |
| **Human** | **Goal-setter + merge gate** | Final review and merge approval; owns the Slack channels. | Agents should be *able* to escalate to you, never required to wait on you for routine merges. |

**Principle:** keep each tool in its lane, and let a *neutral bus* (GitHub + Slack + webhooks) carry work between them — no single vendor is the hub. This is what makes it survive you swapping DeepSeek, Hermes, or Codex in/out.

---

## 3. The coordination substrate

Three layers, each with one job:

1. **GitHub = the durable record and handoff medium.** Issues and PRs are the machine-readable conversation. Branch ownership = "who is allowed to touch these files right now."
2. **Slack = the human view and control plane.** One channel per project. Agents post *events* (started, changed, failed, escalated, done); humans post *steering* (stop, redo, approve).
3. **Webhooks = the wake-up mechanism.** A push/issue/PR/comment event wakes the next agent in the chain. (DeepSeek Harness ships a GitHub webhook adapter; Hermes has HTTP triggers; Codex/Antigravity can be started from a small relay.)

```
        ┌─────────────── GitHub ───────────────┐
        │  issues · PRs · branches · webhooks  │
        └───────┬───────────────┬──────────────┘
                │               │
   ┌────────────▼───┐   ┌───────▼────────────┐
   │  Codex (plan/  │   │  Antigravity       │
   │  debug)        │   │  (implement)       │
   └────────┬───────┘   └────────┬───────────┘
            │                     │
        ┌───▼─────────────────────▼───┐
        │  Hermes Agent (build herald) │──▶ Slack (per-project channel)
        └──────────────┬───────────────┘
                       │ escalate
        ┌──────────────▼───────────────┐
        │  DeepSeek Harness (router /  │
        │  multi-agent debug, TBD)     │
        └──────────────────────────────┘
```

---

## 4. Ownership and turn-taking (the part that stops chaos)

Multiple agents editing one checkout = merge conflicts and clobbered work. Rules:

1. **Branch ownership.** Exactly one agent owns a branch at a time:
   - `feat/<issue-id>` — Antigravity (implementation).
   - `fix/<issue-id>` — Codex (debugging) or Hermes (build hotfix).
   - `plan/<issue-id>` — Codex writes specs, not code.
2. **Handoff only through artifacts, never through the working tree.** An agent "passes the baton" by committing, pushing, and writing/updating an issue/PR with a structured block (below). The next agent starts from that commit.
3. **One commit-owner per branch.** Hermes may *only* commit build/test fixes onto the branch it's watching; if the fix needs design reasoning, it escalates to Codex instead of guessing.
4. **Merge gate.** A PR is merged only after the build is green and (for non-trivial changes) a human or Codex approves. Hermes reports green/red on every PR; this is the "build is healthy" signal everyone trusts.

### Handoff envelope (the structured block agents write)

```yaml
---
agent: codex            # who is writing this
to: antigravity         # who should pick it up
repo: myorg/project
branch: feat/123
task: implement UserService.create()
state: planned
acceptance: |
  POST /users returns 201; validation rejects empty email; tests in users.test.ts pass
urgency: normal
escalate_to: human
---
```

Agents are instructed to read the latest envelope on an issue/PR before acting, and to write one when they finish. Keep it machine-parseable (YAML front-matter) so a future router can act on it.

---

## 5. Change notification → per-project Slack channel

Two layers, same as the earlier design:

- **Layer A — GitHub → Slack (source of truth, covers every harness).** Per repo, the Slack GitHub app or a GitHub Actions workflow on `push`/`pull_request` posts to that project's channel with agent, branch, and commit link. This fires for Codex, Antigravity, Hermes, and humans alike.
- **Layer B — per-agent hooks (instant, with attribution).** Codex and DeepSeek Harness can share one `hooks.json` (`PostToolUse` → `curl` a Slack incoming webhook); Hermes has native Slack messaging; Antigravity posts via a Slack MCP tool.

One incoming webhook URL per project channel, exported as `SLACK_WEBHOOK_URL` in each repo/env. Message template (per project): `[project] <agent> <action> <branch> — <files changed> — <link>`.

---

## 6. Hermes Agent — live build debugging (the always-on loop)

Hermes Agent is the right tool here because it is *already* a daemon with cron + HTTP triggers + GitHub + Slack, and it runs a local Hermes 4 model, so an aggressive fix-retry loop costs nothing in API fees.

### 6.1 The loop

```
push / cron / manual trigger
        │
        ▼
  Hermes runs the build/test target on the watched branch
        │
   ┌────┴────┐
   │  green  │──▶ post "✅ green" to project channel ──▶ wait for next trigger
   └────┬────┘
        │ red
        ▼
  parse compiler/test errors into a fix list
        │
        ▼
  edit files (scoped, smallest change first) ──▶ rebuild
        │
        ├── fixed within N attempts ──▶ commit to branch ──▶ push ──▶ post fix summary
        │
        └── still red after N attempts ──▶ open/update issue + @codex ──▶ post escalation to Slack
```

### 6.2 Trigger modes

- **Event-driven (preferred):** GitHub webhook on `push`/`pull_request` hits a Hermes HTTP trigger (or a tiny relay), which starts a build pass.
- **Cron fallback:** a Hermes cron job polls the watched branch every few minutes so a stuck/hung build is never silently left red.

### 6.3 Guardrails (this is what makes "live" safe instead of dangerous)

- **Bounded retries:** max N fix attempts per failure (e.g. 5), then escalate — no infinite edit loops.
- **Revert-on-regression:** if a "fix" makes more tests fail, revert that commit and try the next hypothesis.
- **Scoped commits:** one commit per build failure, message links the failing test/line, so a human can `git revert` one step.
- **No design decisions:** if the fix requires changing a public API, a schema, or a spec, Hermes escalates to Codex rather than inventing behavior.
- **Deterministic build target:** everything runs through a single scripted command (e.g. `./ci.sh build` / `./ci.sh test`) so every agent sees the same green/red definition.

### 6.4 Where it runs

Self-host on your existing box (you already run Ollama + LM Studio). Hermes supports local models via [Ollama](https://hermes-agent.nousresearch.com/docs/guides/local-ollama-setup) or its [built-in local runtime](https://hermes-agent.nousresearch.com/docs/user-guide/local-models). Use Hermes 4 (35B A3B or 70B depending on GPU) for the fix loop; fall back to a hosted model for harder debugging.

---

## 7. Escalation ladder

1. **Hermes** fixes build/test failures in-loop.
2. Still red after N attempts, or the fix needs design → **Codex** takes over as debugger (on a `fix/` branch).
3. Still stuck, or a product/API decision is needed → **human**, with the full trail (issue + Hermes attempts + Codex analysis) already in the issue thread.

Each rung posts to the project's Slack channel with the handoff link, so you can watch or intervene at any rung.

---

## 8. End-to-end scenarios

**A. Feature, spec → merged PR (Antigravity human-steered)**
1. Human or Codex writes a spec + acceptance into issue #123; Codex posts `to: antigravity`.
2. The router posts "ready for implementation" to the project's Slack channel (and previews the envelope).
3. A human opens the **interactive Antigravity app** on `feat/123` and runs the implementation (this is the human-directed step).
4. Antigravity pushes; GitHub→Slack posts "implemented"; push event wakes Hermes.
5. Hermes builds/tests; on green, posts ✅ and marks the PR ready.
6. Codex reviews + approves; human merges.

**B. Build breaks, Hermes fixes it**
1. Any commit breaks `./ci.sh test`; push event wakes Hermes.
2. Hermes loops up to 5 fixes, commits each scoped change, pushes.
3. Green → posts "✅ fixed — see PR"; done. No human involved.

**C. Hard bug, Hermes escalates to Codex**
1. Hermes can't fix within 5 attempts → opens `fix/<issue>` with its attempts + failing test; `@codex` in the issue; Slack escalation post.
2. Codex debugs on `fix/` branch, opens a PR with the real fix + explanation.
3. Hermes verifies the PR branch is green; Codex approves; human merges.

---

## 9. Decisions & open items

**Locked in (as of this conversation):**

1. **Antigravity = interactive app, human-steered.** You're using the current Antigravity application (not the IDE). Consequence: *implementation is not an automated hop.* The router can hand off a scoped task and post "ready for implementation," but a human runs the Antigravity app to execute it. Autonomous edges are covered by Codex + Hermes; Antigravity stays in the loop as the human-directed implementer. (Revisit only if you later drive Antigravity via its SDK/CLI.)
2. **DeepSeek Harness = both router/hub *and* in-house debug layer.** It receives GitHub/Slack events, dispatches to the others, and hosts the multi-agent debugging workflows.
3. **Merge policy.** Auto-merge build-only fixes (Hermes/Codex); human approval gate on features (via branch protection / review).
4. **Single machine.** Everything self-hosted on your box. Keep all secrets (webhooks, tokens) in one env/secret store.
5. **Remote access = future nice-to-have.** Later, expose the router/hub HTTP API (or the DeepSeek web UI) through a private tunnel (e.g. Cloudflare Tunnel / Tailscale) so you can trigger or watch the workflow from other devices. Not needed for the initial build.

**Still open (project-specific):**

- **Canonical build command.** Each repo needs a single `./ci.sh <build|test>` (or equivalent) that all agents run. This is the shared "ground truth" the whole loop depends on — define it per repo in the first milestone (M0/M1).

---

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Two agents edit the same files | Branch ownership (§4); one commit-owner per branch |
| Infinite fix loop / runaway agent | Bounded attempts, revert-on-regression, escalation after N (§6.3) |
| Agent "ships" something wrong | Merge gate + green-build signal + human review on features |
| Cost (API) | Hermes runs local; Codex only on planning/debugging; budget caps per provider |
| Agents mis-trusting Slack/GitHub content | Treat all external text as data, never instructions; no secrets in issues |
| Antigravity can't be driven headless | Fall back to interactive implementer; Codex covers autonomous gap until verified |

---

## 11. Phased rollout

- **M0 — Manual:** run each agent by hand on one repo; confirm the role split actually produces better results (small benchmark task).
- **M1 — Visibility:** GitHub → Slack per-project channel + shared `hooks.json`. (Zero automation risk; immediate value.)
- **M2 — Build Herald:** Hermes Agent watching one repo's build/test with the §6 loop and guardrails.
- **M3 — Handoff:** Codex planner → Antigravity implementer via the handoff envelope + webhook wake-ups.
- **M4 — Full loop + hub:** escalation ladder end-to-end; decide DeepSeek's hub role; add Slack steering commands.

---

## 12. References

- Hermes Agent: [docs](https://hermes-agent.nousresearch.com/docs/), [Slack](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/slack/), [local models](https://hermes-agent.nousresearch.com/docs/user-guide/local-models), [Ollama setup](https://hermes-agent.nousresearch.com/docs/guides/local-ollama-setup), [GitHub repo](https://github.com/nousresearch/hermes-agent)
- Antigravity: [MCP](https://antigravity.google/docs/mcp), [SDK MCP](https://antigravity.google/docs/sdk/mcp), [Google Workspace MCP codelab (2.0/IDE/CLI)](https://codelabs.developers.google.com/google-workspace-mcp-antigravity)
- Codex: [hooks doc](https://github.com/openai/codex/blob/main/docs/hooks.md)
- DeepSeek Harness: [repo](https://github.com/deepseek-ai/deepseek-harness) (subagents, workflows, MCP client, GitHub-webhook adapter, headless mode — verified in the installed packages)
