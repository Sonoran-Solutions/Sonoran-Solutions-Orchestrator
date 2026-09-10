#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"; rm -rf /home/dq/.hermes-sandbox/runs/11111111-1111-4111-8111-111111111111 /home/dq/.hermes-sandbox/runs/22222222-2222-4222-8222-222222222222 /home/dq/.local/state/sonoran-orchestrator/runs/11111111-1111-4111-8111-111111111111 /home/dq/.local/state/sonoran-orchestrator/runs/22222222-2222-4222-8222-222222222222' EXIT
"$here/deploy-fix-build-skill.sh" >/dev/null
mkdir -p "$tmp/worktree" /home/dq/.hermes-sandbox/runs/11111111-1111-4111-8111-111111111111/home /home/dq/.hermes-sandbox/runs/22222222-2222-4222-8222-222222222222/home /home/dq/.local/state/sonoran-orchestrator/runs/11111111-1111-4111-8111-111111111111 /home/dq/.local/state/sonoran-orchestrator/runs/22222222-2222-4222-8222-222222222222
probe="$tmp/worktree/probe.sh"; cat >"$probe" <<'PROBE'
set -eu
skill=/home/hermes/.hermes/skills/software-development/fix-build/SKILL.md
[ -f "$skill" ] && grep -q '^name: fix-build$' "$skill"
touch /home/hermes/.poison
if printf 'poison\n' 2>/dev/null > "$skill"; then exit 21; fi
[ -d /run/sonoran ]
PROBE
chmod +x "$probe"
env -i PATH=/usr/bin:/bin HOME=/home/dq SONORAN_WORKTREE="$tmp/worktree" SONORAN_RUN_ID=11111111-1111-4111-8111-111111111111 SONORAN_FILESYSTEM_TEST=1 "$here/sandbox-exec" /bin/bash "$probe"
[ ! -e /home/dq/.hermes-sandbox/runs/22222222-2222-4222-8222-222222222222/home/.poison ]
env -i PATH=/usr/bin:/bin HOME=/home/dq SONORAN_WORKTREE="$tmp/worktree" SONORAN_RUN_ID=22222222-2222-4222-8222-222222222222 SONORAN_FILESYSTEM_TEST=1 "$here/sandbox-exec" /bin/bash "$probe"
[ ! -e /home/dq/.hermes-sandbox/base/skills/software-development/fix-build/SKILL.md.tmp ]
grep -q '^name: fix-build$' /home/dq/.hermes-sandbox/base/skills/software-development/fix-build/SKILL.md
echo 'filesystem sandbox tests passed'
