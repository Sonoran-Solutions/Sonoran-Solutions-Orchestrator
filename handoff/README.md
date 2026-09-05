# Handoff protocol (who owns what, and how agents pass work)

The coordinating rules that stop multiple agents from editing the same files at
once. This is the "turn-taking" contract; the envelope template is in
[`handoff-envelope.md`](handoff-envelope.md).

## Ownership rules

1. **One branch owner at a time.** Whoever is listed as `to` in the latest
   envelope owns the branch and may commit to it. Everyone else lays off until
   they hand it over.
2. **Branches by role**, so ownership is obvious:
   - `feat/<issue>` — implementation (Antigravity, human-steered).
   - `fix/<issue>` — debugging (Codex) or build hotfix (Hermes).
   - `plan/<issue>` — specs only, no code (Codex).
3. **Handoff goes through an artifact, never the working tree.** Commit + push +
   write/update the envelope, then the next agent starts from your commit.
4. **No parallel edits to the same files.** If two agents need the same area,
   split the work by file/branch first (or serialize via the envelope).
5. **Hermes only commits build/test fixes** to the branch it's watching. If a
   problem needs a design decision, it escalates to Codex instead of guessing.

## The merge gate

- **Build-only fixes → auto-merge** (Hermes/Codex, via branch protection on
  build-only labels / a CI green check).
- **Features → human approval.** This is the default in this stack.

## Reading conventions for agents

Every agent, before acting:

1. Read the latest envelope on the issue it was handed (`state`, `to`,
   `acceptance`, `summary`).
2. If `to` isn't you, stop — you were not handed the baton.
3. If `state` is already `done`, there is nothing to do; verify and report.
4. Work in a fresh branch off the handed branch; commit scoped changes.
5. On completion, write the envelope (`state: done`, `branch`, `summary`) and
   push, then post a one-liner to the project Slack channel via
   `../slack-notify/slack-notify.sh`.

## Who is listening

| Event | Listener |
|---|---|
| New issue with `to: <agent>` | Router wakes that agent (or posts to Slack) |
| Push to a branch | Hermes build watcher |
| Build failure, Hermes stuck (>N tries) | Escalate to Codex (`to: codex`) |
| Feature ready | Human drives Antigravity, then reviews/merges |
