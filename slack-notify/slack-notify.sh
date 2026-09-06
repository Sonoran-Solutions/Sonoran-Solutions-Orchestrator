#!/usr/bin/env bash
#
# slack-notify.sh — post a state-transition event to a project's Slack channel.
#
# Per the Sonoran notification policy (ORCH-034/035), this script posts ONLY the
# five top-level project events; it does NOT post per-file/tool-call spam.
#
#   task-started <task> [--link <url>] [--branch <b>]
#   pr-ready     <task> [--link <url>] [--branch <b>]
#   blocked      <task> --reason <why> [--link <url>] [--branch <b>]
#   done         <task> [--link <url>] [--branch <b>]
#   stopped      <task> --reason <why> [--link <url>] [--branch <b>]
#   send         <text> [--channel <c>] [--link <url>]   # explicit fallback
#   test                                                        # validate config
#
# Configuration (ORCH-037/038/039) lives OUTSIDE any task worktree and is loaded
# as plain KEY=VALUE lines — never sourced/evaluated as executable Bash.
#
#   $SONORAN_CONFIG_DIR/orchestrator.env   (default: ~/.config/sonoran/orchestrator.env)
#
# Env vars override the file. See sonoran.env.example.
#
#   SLACK_WEBHOOK_URL  (required)  SLACK_CHANNEL (optional override)
#   SONORAN_PROJECT     display name   DRY_RUN=1 to print instead of post

set -euo pipefail

SONORAN_CONFIG_DIR="${SONORAN_CONFIG_DIR:-$HOME/.config/sonoran}"
CONFIG_FILE="${SONORAN_CONFIG_FILE:-$SONORAN_CONFIG_DIR/orchestrator.env}"

# --- safe config loader: reads KEY=VALUE lines, never sources/evaluates -------
load_config() {
  local file="$1" line key val
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"
    val="${line#*=}"
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    val="${val%$'\r'}"                    # strip CR (CRLF files)
    [ -n "$key" ] || continue
    # env wins over file: only import when the var is not already set
    if [ -z "${!key:-}" ]; then
      export "$key=$val"
    fi
  done < "$file"
}

load_config "$CONFIG_FILE"

SLACK_WEBHOOK_URL="${SLACK_WEBHOOK_URL:-}"
SLACK_CHANNEL="${SLACK_CHANNEL:-}"
SONORAN_PROJECT="${SONORAN_PROJECT:-project}"
DRY_RUN="${DRY_RUN:-0}"

log() { printf '[slack-notify] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

have_jq() { command -v jq >/dev/null 2>&1; }

build_payload() {
  local text="$1" branch="$2" link="$3" channel="$4"
  local headline="${SONORAN_PROJECT}"
  if have_jq; then
    jq -n \
      --arg ch "$channel" \
      --arg headline "$headline" \
      --arg text "$text" \
      --arg branch "$branch" \
      --arg link "$link" \
      'def ctx:
         [ (if $branch == "" then null else { type: "mrkdwn", text: ("Branch: `" + $branch + "`") } end),
           (if $link == "" then null else { type: "mrkdwn", text: ("<" + $link + "|open on GitHub>") } end) ]
         | map(select(. != null));
       {
         channel: (if $ch == "" then null else $ch end),
         blocks: (
           [ { type: "section", text: { type: "mrkdwn", text: ("*" + $headline + "*") } },
             { type: "section", text: { type: "mrkdwn", text: $text } } ]
           + (if (ctx | length) > 0 then [ { type: "context", elements: ctx } ] else [] end)
         )
       }'
  else
    printf '{"text":"%s"}' "$(printf '%s' "${headline}\n${text}\n${branch}\n${link}" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
  fi
}

post() {
  local body="$1"
  if [ "${DRY_RUN:-0}" = "1" ]; then
    log "DRY_RUN — not posting. Payload:"
    printf '%s\n' "$body"
    return 0
  fi
  [ -n "$SLACK_WEBHOOK_URL" ] || die "SLACK_WEBHOOK_URL is not set (see sonoran.env.example; config: $CONFIG_FILE)"
  local resp
  resp="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
    -H 'Content-type: application/json' \
    --data "$body" \
    "$SLACK_WEBHOOK_URL")" || die "curl failed"
  case "$resp" in
    2*) log "posted (HTTP $resp)"; return 0 ;;
    *)  log "WARNING: Slack returned HTTP $resp"; return 1 ;;
  esac
}

emit() {
  # emit <emoji> <line1> <task> [branch] [link]
  local emoji="$1" line1="$2" task="$3" branch="${4:-}" link="${5:-}"
  local text="${emoji} *${line1}*: ${task}"
  post "$(build_payload "$text" "$branch" "$link" "${SLACK_CHANNEL:-}")"
}

# --- parse simple flags: --branch, --link, --reason, --channel ----------------
parse_flags() {
  BRANCH="${BRANCH:-}"; LINK="${LINK:-}"; REASON="${REASON:-}"; CHANNEL="${SLACK_CHANNEL:-}"
  while [ $# -gt 0 ]; do
    case "$1" in
      --branch) BRANCH="$2"; shift 2 ;;
      --link)   LINK="$2";   shift 2 ;;
      --reason) REASON="$2"; shift 2 ;;
      --channel) CHANNEL="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
}

cmd="${1:-send}"
shift || true

case "$cmd" in
  test)
    log "config=$CONFIG_FILE project=$SONORAN_PROJECT dry_run=$DRY_RUN"
    post "$(build_payload "Test message from the Sonoran orchestrator. If you can read this, the webhook works." "" "" "${SLACK_CHANNEL:-}")"
    ;;
  task-started) parse_flags "$@"; emit "▶️" "Task started" "$1" "$BRANCH" "$LINK" ;;
  pr-ready)     parse_flags "$@"; emit "🧪" "PR ready for review" "$1" "$BRANCH" "$LINK" ;;
  blocked)      parse_flags "$@"; emit "🚨" "Blocked / escalated" "${1}${REASON:+ — $REASON}" "$BRANCH" "$LINK" ;;
  done)         parse_flags "$@"; emit "✅" "Completed" "$1" "$BRANCH" "$LINK" ;;
  stopped)      parse_flags "$@"; emit "🛑" "Stopped / cancelled" "${1}${REASON:+ — $REASON}" "$BRANCH" "$LINK" ;;
  send)
    parse_flags "$@"
    [ -n "$1" ] || die "send requires <text>"
    post "$(build_payload "$1" "$BRANCH" "$LINK" "$CHANNEL")"
    ;;
  *) die "unknown command '$cmd' (expected: task-started|pr-ready|blocked|done|stopped|send|test)" ;;
esac
