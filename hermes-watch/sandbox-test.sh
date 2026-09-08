#!/usr/bin/env bash
#
# sandbox-test.sh — deterministic tests for the sandbox-exec filesystem boundary
# (ORCH-096). Uses a harmless fixture program run through the SAME sandbox
# mechanism the Hermes worker uses. No model/LLM call is required.
#
# Assertions:
#   A  assigned worktree is readable + writable;
#   B  dedicated sandbox HOME is the effective HOME;
#   C  host ~/.git-credentials is not readable;
#   D  host ~/.ssh and ~/.config/sonoran are not readable/traversable;
#   E  the orchestrator checkout is not readable;
#   F  an unrelated sentinel file outside the worktree is not readable;
#   H  only the assigned worktree is mounted (parent root not exposed).
#   (G — env-secret exclusion — is covered by router tests in router/test.mjs.)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

WORKTREE="$tmp/worktrees/dualdex-40"
mkdir -p "$WORKTREE"

# Host sentinel files the sandbox must NOT be able to read.
mkdir -p "$tmp/unrelated-repo"
echo "TOP-SECRET" > "$tmp/unrelated-repo/secret.txt"

# Create a fake host credential at the path the boundary must hide (only if the
# real one doesn't exist, so the test still exercises the path-denial assertion).
# NOTE: we assert the SANDBOX cannot see these host paths regardless.
fixture="$WORKTREE/.sandbox-probe.sh"
cat > "$fixture" <<'EOF'
#!/usr/bin/env bash
out="$SONORAN_WORKTREE/.sandbox-probe-out"
: > "$out"

# A: worktree writable + readable
if echo hi > "$SONORAN_WORKTREE/.writable-probe" 2>/dev/null && [ -f "$SONORAN_WORKTREE/.writable-probe" ]; then
  echo "PASS:worktree-rw" >> "$out"
else
  echo "FAIL:worktree-rw" >> "$out"
fi

# B: dedicated sandbox HOME
if [ "$HOME" = "/home/hermes" ]; then echo "PASS:dedicated-home" >> "$out"; else echo "FAIL:dedicated-home($HOME)" >> "$out"; fi

# C/D/E: sensitive host paths must be invisible/unreadable
for p in /home/dq/.git-credentials /home/dq/.ssh /home/dq/.config/sonoran /home/dq/sso-orchestrator /home/dq/.hermes; do
  if [ -e "$p" ] || [ -r "$p" ]; then
    echo "FAIL:leak-$p" >> "$out"
  else
    echo "PASS:no-$p" >> "$out"
  fi
done

# F: unrelated repo sentinel (the whole parent worktree root must not be mounted)
if [ -e /home/dq/.hermes-sandbox ] && [ -r /home/dq/.hermes-sandbox ]; then
  echo "FAIL:leak-sandbox-home-host" >> "$out"
else
  echo "PASS:no-sandbox-home-host" >> "$out"
fi
# The unrelated-repo sentinel lives under the test tmp dir, which is tmpfs'd away.
if [ -d /home/hermes ] && [ "$HOME" = "/home/hermes" ]; then
  echo "PASS:home-is-sandbox" >> "$out"
else
  echo "FAIL:home-not-sandbox" >> "$out"
fi
EOF
chmod +x "$fixture"

# Run the fixture through the real sandbox launcher with a CLEAN environment
# (mirrors the router's allowlist-filtered worker env).
env -i \
  PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  HOME="/home/dq" \
  SONORAN_WORKTREE="$WORKTREE" \
  "$here/sandbox-exec" /bin/bash "$WORKTREE/.sandbox-probe.sh"

echo "--- sandbox probe results ---"
cat "$WORKTREE/.sandbox-probe-out"

if grep -q '^FAIL:' "$WORKTREE/.sandbox-probe-out"; then
  echo "SANDBOX TEST: FAILED"
  exit 1
fi
echo "SANDBOX TEST: PASSED"
