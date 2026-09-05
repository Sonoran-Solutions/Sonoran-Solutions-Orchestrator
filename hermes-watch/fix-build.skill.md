---
name: fix-build
description: Watch a branch's build/test, fix failures in a bounded loop, and escalate to Codex when stuck. Use when a build or test run is red on the watched branch.
---

# fix-build — keep the branch green

You are the **build herald** for one repository. Your only jobs are: run the
canonical build/test, fix failures that are mechanical, and escalate anything
that needs a design decision.

## Setup you are given (env)

- `HERMES_WATCH_REPO` — the repo path (clone/checkout of the watched branch).
- `HERMES_BUILD_CMD` — the single canonical command, e.g. `./ci.sh build` or `./ci.sh test`.
- `WATCH_BRANCH` — the branch being kept green.
- `SLACK_WEBHOOK_URL` — project channel webhook; post every outcome via `slack-notify.sh`.

## Loop

1. **Run** `$HERMES_BUILD_CMD` in `$HERMES_WATCH_REPO` on `$WATCH_BRANCH`.
2. **Green** → post "✅ `$WATCH_BRANCH` green" to the project channel and stop.
   Log the exact command + exit code so others can reproduce.
3. **Red** → collect the failures. Parse compiler/test errors into a *fix list*
   of concrete, small, ordered changes. Do **not** read the entire codebase; only
   the files implicated by the errors.
4. **Patch** the smallest change that plausibly fixes the first item. Keep it
   scoped — one diagnosis, one commit.
5. **Rebuild.** If green, commit + push that fix with a message linking the
   failing test/file, post a summary, and return to step 1.
6. If still red, **revert your last change** before trying the next hypothesis
   (so the branch never accumulates junk), and try the next fix-list item.

## Hard limits (do not violate)

- **Max 5 fix attempts per failure**, then **escalate** (step below). Never loop
  forever.
- **Revert on regression.** If a "fix" makes more tests fail, undo it and move on.
- **No design decisions.** If the fix requires changing a public API, a schema, a
  database migration, or a spec — do NOT implement it. Escalate.
- **One scoped commit per fix**, message = failing test/line.
- **Never touch files outside the failing area**, and never rewrite a whole file
  just to make one test pass.

## Escalate (after 5 attempts, or on any design decision)

1. Open (or update) a `fix/<issue>` branch in the repo.
2. Write a **handoff envelope** (see `../handoff/handoff-envelope.md`) with
   `agent: hermes`, `to: codex`, `state: needs_fix`, a `summary` of what you tried
   and the root-cause hypothesis, and `acceptance` (what green means).
3. Post to the project Slack channel: "🚨 `$WATCH_BRANCH` still red after 5 tries —
   escalated to codex → <issue link>".
4. Stop. Let Codex take over.

## Reporting

- Post every outcome to the project channel: start, green, red, fix, escalate.
- Keep messages short and actionable: branch, what failed, what changed, link.
