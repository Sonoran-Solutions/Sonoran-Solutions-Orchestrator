# Sonoran Solutions — Supporting Tooling Stack

**Purpose:** define the tools around the agent orchestrator and give each one a single clear job.

The rule for this stack is simple: **do not add a tool because it is cool; add it because it owns a problem that is not already owned well somewhere else.**

The orchestrator remains the execution/control system. These tools provide planning, security, operations, production feedback, networking, and maintenance around it.

---

## 1. Source-of-truth map

| System | Owns | Does **not** own |
|---|---|---|
| **Linear** | Product backlog, roadmap, priorities, project planning | Runtime agent state or code truth |
| **GitHub** | Code, commits, PRs, execution artifacts, durable engineering record | Product roadmap or active worker leases |
| **Sonoran router + SQLite** | Authorization, active task/run state, leases, retries, dispatch | Product priorities or final code validation |
| **GitHub Actions** | Independent CI/required-check result | Product decisions or worker routing |
| **Slack** | Human-facing alerts, project discussion, control requests | Canonical task state |
| **1Password** | Human/local orchestration secret storage and controlled secret injection | GitHub Actions secret execution policy |
| **Sentry** | Production crash/error evidence and release health | Product planning or automatic merge authority |
| **Tailscale** | Private machine/network access | Public webhook authorization policy |
| **Renovate** | Dependency-update proposals and maintenance visibility | Product feature work |
| **Taskfile / `ci.sh`** | Standard developer/agent commands inside each repo | CI authority |
| **Dagger (parked)** | Potential future portable CI execution | Required today |

### Mental model

```text
Linear
  │ product priority / approved work
  ▼
GitHub ──────────────── Slack
  │ durable work         ▲ human view
  ▼                      │
Sonoran router + SQLite ─┘
  │ dispatch / leases
  ├── Codex
  ├── Antigravity
  ├── Hermes
  └── DeepSeek specialists
  │
  ▼
GitHub PR
  │
  ▼
GitHub Actions / Rulesets
  │
  ▼
Human merge → release → Sentry → real-user evidence → Linear

1Password protects credentials underneath the stack.
Tailscale provides private machine connectivity.
Renovate handles dependency maintenance.
```

---

# 2. Linear — product and project management

**Recommendation:** adopt early.

Linear should be the **management layer** for Sonoran Solutions: what should be built, why, in what order, and how larger bodies of work are progressing.

Suggested hierarchy:

```text
Sonoran Solutions
│
├── Initiative / area: SaveBridge
│   ├── Project: v0.1 MVP
│   └── Project: later sync work
│
├── Initiative / area: Dungeon Dispatcher
│   ├── Project: Prototype 0.01
│   └── Project: Vertical Slice 0.1
│
├── Initiative / area: DualDex
│   └── Project: public beta / platform expansion
│
└── Initiative / area: Sonoran Infrastructure
    └── Project: Agent Orchestrator
```

## Linear boundary

- Linear issue = **work that Sonoran Solutions may want done**.
- GitHub issue/PR + valid handoff envelope = **engineering work that has entered execution**.
- Router/SQLite task = **work currently authorized/assigned to an execution worker**.

Do not treat existence of a Linear issue as authorization for a local coding agent.

## Initial integration policy

1. Link Linear work to GitHub branches/PRs.
2. Allow engineering activity to update Linear status where useful.
3. Use Slack ↔ Linear workflows for human planning/discussion.
4. Consider Linear MCP access for planning agents **after** the planning taxonomy is stable.
5. **Do not enable broad two-way GitHub Issue synchronization on day one.** First prove that it cannot accidentally create confusing duplicate task/authorization states.

## Agent permissions

Planning agents may eventually:

- search/read project context;
- draft issues;
- update status/comments;
- break approved project work into proposed tasks.

Agents should **not** independently reprioritize initiatives, authorize execution, or close major product decisions without human policy.

---

# 3. GitHub Rulesets — hard repository policy

**Recommendation:** configure before unattended writes.

Rulesets should enforce safety independently from whatever an agent claims in a comment or Slack message.

Recommended baseline for active Sonoran repos:

- require pull requests before merge;
- require the canonical GitHub Actions checks;
- block force-pushes to protected branches;
- restrict direct pushes to release/default branches where appropriate;
- require review for agent-authored feature/fix work during the pilot;
- enable code/security checks where appropriate to the repo;
- keep auto-merge disabled until the documented future gate is passed.

The important trust boundary is:

```text
worker says local tests pass
       ↓
GitHub Actions independently runs them
       ↓
Ruleset sees required check from the expected CI system
       ↓
merge becomes eligible
```

The router must not be able to bypass repository rules merely because it has push access.

---

# 4. 1Password — secret authority

**Recommendation:** adopt before the orchestrator accumulates more credentials.

Use 1Password for **human/local orchestration secrets** and controlled runtime injection rather than building a growing collection of plaintext `.env` files.

Likely secret classes:

- GitHub app/token material;
- Slack app/webhook credentials;
- Linear credentials;
- model-provider API keys;
- Sentry credentials;
- Tailscale/service credentials;
- release/signing credentials where appropriate.

## Rules

- Orchestrator secrets live outside project worktrees.
- Prefer runtime injection over writing plaintext secret files into task directories.
- Give automated identities access only to the vault/items they need.
- Workers receive the minimum environment necessary for that run.
- Never include secrets in prompts, task envelopes, issues, PRs, Slack messages, or logs.
- Continue using GitHub Actions secrets/appropriate GitHub secret mechanisms for CI jobs rather than pulling arbitrary local secrets into hosted CI.

---

# 5. Sentry — production feedback loop

**Recommendation:** add per product before public release/beta when crash reporting is appropriate.

Sentry should answer **what is actually breaking for users?**

Desired long-term loop:

```text
production error
  ↓
Sentry groups error + release/context
  ↓
human triage / Linear bug
  ↓
execution authorized
  ↓
GitHub task / Codex diagnosis / implementation
  ↓
GitHub Actions + review
  ↓
release
  ↓
Sentry shows whether the error/regression stopped
```

## Policy

- Sentry evidence may create or inform proposed work.
- A Sentry event must **not directly launch a write-capable local worker** without the normal authorization gate.
- Do not enable competing automatic code-fix/PR systems until the Sonoran repair/review flow is proven; avoid having two autonomous systems race to fix the same error.
- Include release/version metadata so errors can be tied to deployed builds.
- Keep telemetry/privacy choices consistent with each product's privacy policy.

---

# 6. Tailscale — private operations network

**Recommendation:** add during the remote-operations phase, not before local execution is stable.

Use Tailscale for private connectivity between trusted machines rather than exposing the router directly to the public internet.

Potential nodes:

- primary development/orchestrator machine;
- laptop/desktop used for remote control;
- phone/tablet for operational access where useful;
- future dedicated build/test machine;
- ephemeral CI identities if a workflow genuinely needs access to a private resource.

Potential future Android use:

```text
GitHub Actions / trusted runner
       ↓ private authenticated network
self-hosted build/test machine
       ↓
physical Android test device
```

## Rules

- Tailscale connectivity does not replace webhook signatures, authorization checks, or router authentication.
- Do not expose the router publicly simply because remote access is convenient.
- Keep device/service identities scoped to the minimum network resources they need.

---

# 7. Renovate — dependency janitor

**Recommendation:** add once multiple active Sonoran repositories make dependency maintenance repetitive.

Renovate should own **dependency-update proposals**, not general feature development.

Useful policy:

- central dashboard/visibility for pending dependency updates;
- group related dependency updates where it reduces PR noise;
- require approval before expensive/high-risk major updates;
- keep automatic merge disabled initially;
- route updates through the same required CI/ruleset policy as human/agent changes;
- explicitly exclude or require review for security-sensitive/platform-breaking dependency changes.

After a long history of strong CI, narrow classes such as low-risk patch/dev-tool updates may become candidates for auto-merge under the same future auto-merge policy documented in the main roadmap.

---

# 8. Taskfile — optional command standardization

**Recommendation:** evaluate when SaveBridge begins or when the second/third actively maintained repo makes shell-script conventions annoying.

The current `./ci.sh build` / `./ci.sh test` contract is deliberately simple and remains valid.

Taskfile may become useful if Sonoran repositories benefit from a consistent interface:

```text
task build
task test
task lint
task ci
task android
task release
```

Benefits for agents:

- fewer repo-specific commands to memorize;
- one discoverable command vocabulary;
- potential reuse of shared Sonoran task definitions;
- easier local parity between humans and agents.

Do **not** migrate working projects just for aesthetics. Adopt only if it reduces duplicated command glue.

---

# 9. Dagger — parked future option

**Recommendation:** do not add now.

Dagger may be useful later if Sonoran Solutions develops a real problem with CI portability/reproducibility across local machines, self-hosted infrastructure, and hosted CI.

Only revisit when at least one of these is true:

- local and hosted CI behavior repeatedly diverge;
- build pipelines become difficult to reproduce;
- cross-project CI reuse is painful;
- self-hosted runners require substantial duplicated pipeline logic.

Until then, GitHub Actions + the canonical repo command (`ci.sh` or Taskfile) is simpler and easier to debug.

---

# 10. Explicitly not adding yet

Avoid stacking tools that duplicate existing responsibilities without demonstrated pain.

Do not add by default:

- Jira in addition to Linear;
- Notion as another task source of truth;
- n8n/Zapier solely to duplicate router/webhook behavior;
- additional AI PR reviewers while Codex review is being validated;
- Kubernetes/container-orchestration complexity for a single-machine pilot;
- a large observability platform for the orchestrator before basic logs/health are insufficient;
- another generic multi-agent framework without a specific capability gap.

---

# 11. Recommended adoption order

```text
1. Linear
2. GitHub Rulesets
3. 1Password
4. Core orchestrator safety/control-plane work
5. Sentry as each product approaches public testing
6. Tailscale when remote/private machine access becomes useful
7. Renovate once dependency maintenance across repos becomes noisy
8. Taskfile if command standardization earns its migration cost
9. Dagger only after a real CI portability problem appears
```

The first three improve organization and safety without requiring the orchestrator to become more autonomous. The later tools should be pulled in by real operational/product needs.
