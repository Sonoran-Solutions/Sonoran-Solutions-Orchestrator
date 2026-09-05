#!/usr/bin/env bash
#
# slack-notify.sh — post a change event to a project's Slack channel.
#
# One webhook per project channel is the simplest wiring (Slack incoming
# webhooks are pinned to a single channel). Configure via .env (see .env.example).
#
# Usage:
#   slack-notify.sh <command> [options]
#
# Commands:
#   test               Send a test message (validates webhook + env).
#   send               Post a plain message. Options: --text <msg> [--channel <c>] [--link <url>]
#   tool               Parse a Codex/DSH hook payload from stdin and notify if it's a file
#                      mutation / commit / push. Reads tool name from the payload (see below).
#   commit             Notify about the latest commit + changed files on the current branch.
#
# Options (also settable via env):
#   --tool-name <n>    Force the tool name when stdin isn't available (e.g. HOOK_TOOL_NAME).
#   --branch <b>       Branch label (default: current git branch).
#   --files <csv>      Comma-separated changed files (default: from git status).
#   --link <url>       Link to paste in the message (commit/PR/run).
#   --channel <c>      Slack channel override (webhook apps may allow it).
#
# Env (see .env.example): SLACK_WEBHOOK_URL, AGENT_LABEL, PROJECT_NAME, REPO_SLUG,
#   SLACK_CHANNEL, DRY_RUN, HOOK_TOOL_NAME, HOOK_COMMAND, HOOK_ALWAYS, MUTATION_RE.
#
# Set DRY_RUN=1 to print the payload instead of posting (no network needed).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load .env from the script dir and the current working dir, if present.
for env_file in "$SCRIPT_DIR/.env" "$PWD/.env"; do
  [ -f "$env_file" ] && set -a && . "$env_file" && set +a || true
done

SLACK_WEBHOOK_URL="${SLACK_WEBHOOK_URL:-}"
AGENT_LABEL="${AGENT_LABEL:-agent}"
PROJECT_NAME="${PROJECT_NAME:-project}"
REPO_SLUG="${REPO_SLUG:-${PROJECT_NAME}}"
SLACK_CHANNEL="${SLACK_CHANNEL:-}"
DRY_RUN="${DRY_RUN:-0}"

# What counts as a file-mutation/commit/push tool. Matched case-insensitively.
MUTATION_RE="${MUTATION_RE:-write|edit|multi-?edit|apply_patch|str-replace|create|patch|commit|push|rename|move|delete|rm|fs\..*write}"

# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
log()  { printf '[slack-notify] %s\n' "$*" >&2; }
die()  { log "ERROR: $*"; exit 1; }

json_escape() {
  # Minimal JSON string escaping (stable for our own, non-arbitrary text).
  sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' -e "s/'/\\'/g"
}

have_jq() { command -v jq >/dev/null 2>&1; }

current_branch() {
  git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown"
}

changed_files() {
  # Best-effort list of modified/untracked files in the working tree.
  git status --porcelain 2>/dev/null | sed -E 's/^.. //' | paste -sd, - || echo "n/a"
}

post() {
  # $1 = JSON payload body. POST it to the incoming webhook.
  local body="$1"
  if [ "${DRY_RUN:-0}" = "1" ]; then
    log "DRY_RUN — not posting. Payload:"
    printf '%s\n' "$body"
    return 0
  fi
  [ -n "$SLACK_WEBHOOK_URL" ] || die "SLACK_WEBHOOK_URL is not set (see .env.example)"
  local resp
  resp="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
    -H 'Content-type: application/json' \
    --data "$body" \
    "$SLACK_WEBHOOK_URL")" || die "curl failed"
  log "posted (HTTP $resp)"
  case "$resp" in
    2*) return 0 ;;
    *)  log "WARNING: Slack returned HTTP $resp" ; return 1 ;;
  esac
}

# Build a Slack blocks payload (jq when available, else a plain text fallback).
build_payload() {
  local text="$1" branch="$2" link="$3" channel="$4"
  local headline="${PROJECT_NAME} — ${AGENT_LABEL}"
  if have_jq; then
    jq -n \
      --arg ch "$channel" \
      --arg headline "$headline" \
      --arg text "$text" \
      --arg branch "$branch" \
      --arg link "$link" \
      '{
        channel: (if $ch == "" then null else $ch end),
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: ("*" + $headline + "*") } },
          { type: "section", text: { type: "mrkdwn", text: $text } },
          { type: "context",
            elements: [
              { type: "mrkdwn", text: ("Branch: `" + $branch + "`") },
              (if $link == "" then null else { type: "mrkdwn", text: ("Link: " + $link) } end)
            ]
            | map(select(. != null)) }
        ]
      }'
  else
    local line="${headline}\n${text}\nBranch: ${branch}"
    [ -n "$link" ] && line="${line}\nLink: ${link}"
    printf '{"text":"%s"}' "$(printf '%s' "$line" | json_escape)"
  fi
}

# Decide whether a tool call is a "change to the codebase" worth posting about.
is_mutation() {
  # $1 = tool name, $2 = raw command text (for bash/exec/shell types).
  local tool="$1" cmd="$2" haystack
  haystack="$(printf '%s %s' "$tool" "$cmd" | tr '[:upper:]' '[:lower:]')"
  printf '%s' "$haystack" | grep -Eq "$MUTATION_RE" || return 1
  # Bash/exec/shell only count if they actually commit/push (avoid spam on compile-only).
  if printf '%s' "$tool" | grep -Eiq 'bash|exec|shell|command|terminal'; then
    printf '%s' "$haystack" | grep -Eq 'git (commit|push|merge|add)|git\s+\S+\s+\S+.*(commit|push)' || return 1
  fi
  return 0
}

# Extract a human-readable action summary from the hook payload.
summarize_payload() {
  # $1 = raw stdin payload. Best-effort: look for commit message or tool message.
  local pl="$1"
  if have_jq; then
    printf '%s' "$pl" | jq -r '
      [ .tool_input.message, .tool_input.commit_message, .tool_input.command,
        .tool_input.file_path, .tool_input.old_string, .detail,
        (.tool_input.text // .text // "") ]
      | map(select(. != null and . != "")) | .[0]? // "change applied"'
  else
    printf '%s' "$pl" | grep -oE '"(message|commit_message|command|file_path)"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/^[^:]*:[[:space:]]*//; s/"$//' || true
  fi
}

# ----------------------------------------------------------------------------
# Commands
# ----------------------------------------------------------------------------
cmd_send() {
  local text="${1:-}" channel="${SLACK_CHANNEL:-}" link="" branch=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --text)  text="$2"; shift 2 ;;
      --channel) channel="$2"; shift 2 ;;
      --link)  link="$2"; shift 2 ;;
      --branch) branch="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  [ -n "$text" ] || die "send requires --text"
  [ -n "$branch" ] || branch="$(current_branch)"
  post "$(build_payload "$text" "$branch" "$link" "$channel")"
}

cmd_test() {
  log "AGENT_LABEL=$AGENT_LABEL PROJECT_NAME=$PROJECT_NAME REPO_SLUG=$REPO_SLUG DRY_RUN=$DRY_RUN"
  post "$(build_payload "Test message from ${AGENT_LABEL} ($PROJECT_NAME). If you can read this, the webhook works." "$(current_branch)" "" "${SLACK_CHANNEL:-}")"
}

cmd_tool() {
  local payload tool_name command_text action branch
  payload="$(cat)"                      # hook payload arrives on stdin
  tool_name="${HOOK_TOOL_NAME:-}"
  command_text="${HOOK_COMMAND:-}"
  if have_jq && [ -n "$payload" ]; then
    # Be tolerant of the field-name differences between Codex and DSH payloads.
    tool_name="${tool_name:-$(printf '%s' "$payload" | jq -r '.tool_name // .name // .tool.name // ""')}"
    command_text="${command_text:-$(printf '%s' "$payload" | jq -r '.tool_input.command // .tool_input.arguments // .arguments // ""')}"
    action="$(summarize_payload "$payload" || true)"
  fi
  [ -n "$tool_name" ] || { tool_name="${HOOK_TOOL_NAME:-unknown}"; }
  # HOOK_ALWAYS=1 notifies regardless of filter (useful for CI/test).
  if [ "${HOOK_ALWAYS:-0}" != "1" ]; then
    is_mutation "$tool_name" "$command_text" || { log "skipping non-mutation tool: $tool_name"; exit 0; }
  fi
  branch="$(current_branch)"
  files="$(changed_files)"
  local text="*Action:* \`${tool_name}\`\n*Changed:* ${files}"
  [ -n "$action" ] && text="${text}\n*Detail:* ${action}"
  post "$(build_payload "$text" "$branch" "" "${SLACK_CHANNEL:-}")"
}

cmd_commit() {
  local branch msg files
  branch="$(current_branch)"
  msg="$(git log -1 --pretty=%s 2>/dev/null || echo "commit")"
  files="$(changed_files)"
  [ "$files" = "n/a" ] && files="$(git diff --name-only HEAD~1 HEAD 2>/dev/null | paste -sd, - || echo "n/a")"
  local text="*Commit:* ${msg}\n*Changed:* ${files}"
  post "$(build_payload "$text" "$branch" "" "${SLACK_CHANNEL:-}")"
}

# ----------------------------------------------------------------------------
# Dispatch
# ----------------------------------------------------------------------------
cmd="${1:-send}"
shift || true
case "$cmd" in
  send)   cmd_send "$@" ;;
  test)   cmd_test ;;
  tool)   cmd_tool "$@" ;;
  commit) cmd_commit "$@" ;;
  *)      die "unknown command '$cmd' (expected: test|send|tool|commit)" ;;
esac
