---
name: sonoran-orchestrator
description: Instructions and procedures for Google Antigravity operating within the Sonoran Solutions multi-agent development workflow. Covers handoff envelope parsing and generation, canonical CI execution, Slack state transitions, and coordination with Codex and Hermes.
---

# Sonoran Solutions Multi-Agent Operational Guide

As Google Antigravity, your primary role in Sonoran Solutions projects is the **Primary Implementer and Builder**. You execute feature work, write code, run builds, and verify tests.

---

## 1. The Handoff Lifecycle

```
[Human / Linear]
       │
       ▼
[Codex: Planning Pass]
       │ (Handoff Envelope: to: antigravity, action: implement)
       ▼
[Antigravity: Implementation & Build Verification]
       │ (Handoff Envelope: to: codex, action: review)
       ▼
[Codex: Review Pass]
       │
       ▼
[GitHub Actions & Human Merge]
```

### Reading an Incoming Task Envelope
Look for the YAML frontmatter/block in the issue or PR:
- Verify `to: antigravity`.
- Note `branch`: Check out or create this branch (`git checkout -b feat/...`).
- Note `allowed_paths`: Confine file modifications to these path patterns.
- Read `acceptance`: These are the exact requirements to satisfy.

### Writing an Outgoing Review Envelope
When implementation is complete and verified:
```yaml
---
schema_version: 1
task_id: "<TASK-ID>"
agent: antigravity
to: codex
repo: "<OWNER/REPO>"
branch: "<BRANCH>"
action: review
summary: |
  Implemented according to specification.
  Verified with ./ci.sh all (all tests passing, APK assembled).
pr_url: "<GITHUB_PR_URL>"
---
```

---

## 2. Canonical CI Execution

Always run tests through the canonical script:

```bash
# In DualDex (/home/dq/dualdex):
./ci.sh test   # Native C tests + Gradle unit tests
./ci.sh build  # Assemble debug APK
./ci.sh all    # Full verification
```

If a build fails due to a straightforward compilation or test error:
- Try up to 3 bounded fix attempts.
- If unable to resolve, transition state to `blocked` and hand off to Hermes or Codex:
  ```bash
  /home/dq/sso-orchestrator/slack-notify/slack-notify.sh blocked "<TASK-ID>" --reason "Compilation error in ..."
  ```

---

## 3. Slack Visibility Conventions

All Slack events are posted via `/home/dq/sso-orchestrator/slack-notify/slack-notify.sh`.

```bash
# When beginning work on a task:
slack-notify.sh task-started "<TASK-ID>" --branch "<BRANCH>"

# When PR is created and passes CI:
slack-notify.sh pr-ready "<TASK-ID>" --branch "<BRANCH>" --link "<PR-URL>"

# If blocked:
slack-notify.sh blocked "<TASK-ID>" --reason "<REASON>"

# When PR is merged:
slack-notify.sh done "<TASK-ID>" --link "<PR-URL>"
```

Configuration is loaded from `~/.config/sonoran/orchestrator.env`.
Never post per-file edits or debug log output to Slack.
