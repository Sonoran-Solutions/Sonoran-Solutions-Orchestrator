#!/usr/bin/env bash
#
# sandbox-test.sh — deterministic runtime tests for the exact Hermes sandbox.
# Creates a router-style task-private Git checkout and exercises filesystem,
# Git, credential, /proc, DNS, and TLS behavior without an LLM call.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

REMOTE="$tmp/remote.git"
SEED="$tmp/seed"
SOURCE_REPO="$tmp/router-source"
WORKTREE_ROOT="$tmp/task-checkouts"
TASK_ID="hermes-git-runtime"
RUN_ID="11111111-1111-4111-8111-111111111111"
RUN_HOME_ROOT="/home/dq/.hermes-sandbox/runs/$RUN_ID/home"
BRANCH="repair/runtime-smoke"
WORKTREE="$WORKTREE_ROOT/$TASK_ID"
HOST_SENTINEL="$tmp/unrelated-repo/secret.txt"

# A real local remote + known main commit. The router source clone is authoritative;
# prepareWorktreeForRun must materialize an independent task-private repository.
git init --bare --quiet "$REMOTE"
git init --quiet "$SEED"
git -C "$SEED" config user.name "Sandbox Test"
git -C "$SEED" config user.email "sandbox-test@example.invalid"
printf 'base\n' > "$SEED/file.txt"
git -C "$SEED" add file.txt
git -C "$SEED" commit --quiet -m base
git -C "$SEED" branch -M main
git -C "$SEED" remote add origin "$REMOTE"
git -C "$SEED" push --quiet -u origin main
git --git-dir="$REMOTE" symbolic-ref HEAD refs/heads/main
git clone --quiet "$REMOTE" "$SOURCE_REPO"
START_SHA="$(git -C "$SOURCE_REPO" rev-parse HEAD)"

mkdir -p "$WORKTREE_ROOT" "$(dirname "$HOST_SENTINEL")" "$RUN_HOME_ROOT"
"$here/deploy-fix-build-skill.sh" >/dev/null
printf 'TOP-SECRET\n' > "$HOST_SENTINEL"

node --input-type=module - "$repo_root" "$SOURCE_REPO" "$WORKTREE_ROOT" "$TASK_ID" "$START_SHA" "$BRANCH" <<'NODE'
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const [repoRoot, sourceRepo, worktreeRoot, taskId, baseSha, branch] = process.argv.slice(2);
const mod = await import(pathToFileURL(join(repoRoot, 'router/lib/worktrees.mjs')).href);
const prepared = mod.prepareWorktreeForRun({ sourceRepo, worktreeRoot, taskId, baseSha, branch });
mod.installPushGuard(prepared.path, {
  workerAllowedPaths: ['*'], taskAllowedPaths: [], baseSha, baseRef: 'main',
});
if (prepared.startSha !== baseSha || prepared.branch !== branch) process.exit(2);
NODE

fixture="$WORKTREE/.sandbox-probe.sh"
cat > "$fixture" <<'PROBE'
#!/usr/bin/env bash
set -u
out="$SONORAN_WORKTREE/.sandbox-probe-out"
HOST_SENTINEL="$1"
ORCHESTRATOR_CHECKOUT="$2"
EXPECTED_SHA="$3"
EXPECTED_BRANCH="$4"
: > "$out"

pass() { printf 'PASS:%s\n' "$1" >> "$out"; }
fail() { printf 'FAIL:%s\n' "$1" >> "$out"; }

file_denied() {
  label="$1"; path="$2"
  if cat "$path" >/dev/null 2>&1; then fail "$label"; else pass "$label"; fi
}
path_denied() {
  label="$1"; path="$2"
  if ls -ld "$path" >/dev/null 2>&1; then fail "$label"; else pass "$label"; fi
}

# Filesystem + dedicated HOME.
if printf 'rw\n' > "$SONORAN_WORKTREE/.writable-probe" 2>/dev/null && [ -r "$SONORAN_WORKTREE/.writable-probe" ]; then
  pass worktree-rw
else
  fail worktree-rw
fi
if [ "$HOME" = "/home/hermes" ] && [ -d "$HOME" ]; then pass dedicated-home; else fail dedicated-home; fi

# Direct host-secret and unrelated-checkout probes.
file_denied no-owner-git-credentials /home/dq/.git-credentials
path_denied no-owner-ssh /home/dq/.ssh
path_denied no-sonoran-control-config /home/dq/.config/sonoran
path_denied no-owner-hermes-home /home/dq/.hermes
path_denied no-owner-orchestrator-checkout /home/dq/sso-orchestrator
path_denied no-current-orchestrator-checkout "$ORCHESTRATOR_CHECKOUT"
file_denied no-unrelated-sentinel "$HOST_SENTINEL"

# Literal /proc/1/root escape probes. PID 1 is in the sandbox PID/mount view.
file_denied no-proc-root-sentinel "/proc/1/root$HOST_SENTINEL"
file_denied no-proc-root-git-credentials /proc/1/root/home/dq/.git-credentials
path_denied no-proc-root-ssh /proc/1/root/home/dq/.ssh
path_denied no-proc-root-sonoran-config /proc/1/root/home/dq/.config/sonoran

# Task-private Git metadata and exact starting state.
if [ -d .git ] && [ ! -e .git/objects/info/alternates ]; then pass git-private-metadata; else fail git-private-metadata; fi
if git status --porcelain >/dev/null 2>&1; then pass git-status; else fail git-status; fi
ACTUAL_SHA="$(git rev-parse HEAD 2>/dev/null || true)"
if [ "$ACTUAL_SHA" = "$EXPECTED_SHA" ]; then pass git-rev-parse-head; else fail "git-rev-parse-head($ACTUAL_SHA)"; fi
ACTUAL_BRANCH="$(git branch --show-current 2>/dev/null || true)"
if [ "$ACTUAL_BRANCH" = "$EXPECTED_BRANCH" ]; then pass git-branch; else fail "git-branch($ACTUAL_BRANCH)"; fi

printf 'sandbox change\n' >> file.txt
if git diff --name-only | grep -Fxq file.txt; then pass git-diff; else fail git-diff; fi
if git add file.txt && git diff --cached --name-only | grep -Fxq file.txt; then pass git-add; else fail git-add; fi
if git commit --quiet -m 'sandbox local commit'; then pass git-commit; else fail git-commit; fi
NEW_SHA="$(git rev-parse HEAD 2>/dev/null || true)"
PARENT_SHA="$(git rev-parse HEAD^ 2>/dev/null || true)"
if [ -n "$NEW_SHA" ] && [ "$NEW_SHA" != "$EXPECTED_SHA" ] && [ "$PARENT_SHA" = "$EXPECTED_SHA" ]; then
  pass git-local-commit-parent
else
  fail git-local-commit-parent
fi

# Publication authority is absent: fixed disabled push URL, no token/SSH env,
# no usable GitHub credential lookup, and owner credential files remain hidden.
PUSH_URL="$(git remote get-url --push origin 2>/dev/null || true)"
if [ "$PUSH_URL" = "sonoran-no-push://router-owned-publication-required" ]; then pass git-push-disabled; else fail "git-push-disabled($PUSH_URL)"; fi
if git push --dry-run origin HEAD >/dev/null 2>&1; then fail git-push-refused; else pass git-push-refused; fi
if env | grep -Eq '^(GH_TOKEN|GITHUB_TOKEN|GITLAB_TOKEN|SSH_AUTH_SOCK)='; then fail publication-secret-env; else pass publication-secret-env-absent; fi
if printf 'protocol=https\nhost=github.com\n\n' | git credential fill >/dev/null 2>&1; then fail github-credential-fill; else pass github-credential-absent; fi

# Shared network namespace + minimal resolver-file mount: transport only.
if getent ahosts api.anthropic.com >/dev/null 2>&1; then pass network-dns; else fail network-dns; fi
HTTPS_CODE="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 8 --max-time 15 https://api.anthropic.com/ 2>/dev/null || true)"
case "$HTTPS_CODE" in
  [1-5][0-9][0-9]) pass "network-https($HTTPS_CODE)" ;;
  *) fail "network-https($HTTPS_CODE)" ;;
esac
PROBE
chmod +x "$fixture"

# Run through the exact production sandbox launcher with a router-style clean env.
env -i \
  PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  HOME="/home/dq" \
  SONORAN_WORKTREE="$WORKTREE" \
  SONORAN_RUN_ID="$RUN_ID" \
  "$here/sandbox-exec" /bin/bash "$fixture" "$HOST_SENTINEL" "$repo_root" "$START_SHA" "$BRANCH"

# A sandbox-local commit must not create/update the task branch in the shared
# router source repository or alter its checked-out state.
out="$WORKTREE/.sandbox-probe-out"
if git -C "$SOURCE_REPO" show-ref --verify --quiet "refs/heads/$BRANCH"; then
  printf 'FAIL:shared-router-task-ref-created\n' >> "$out"
else
  printf 'PASS:shared-router-task-ref-absent\n' >> "$out"
fi
if [ "$(git -C "$SOURCE_REPO" rev-parse HEAD)" = "$START_SHA" ] && [ -z "$(git -C "$SOURCE_REPO" status --porcelain)" ]; then
  printf 'PASS:shared-router-repo-unchanged\n' >> "$out"
else
  printf 'FAIL:shared-router-repo-unchanged\n' >> "$out"
fi

echo "--- sandbox runtime probe results ---"
cat "$out"

if grep -q '^FAIL:' "$out"; then
  echo "SANDBOX TEST: FAILED"
  exit 1
fi
echo "SANDBOX TEST: PASSED"
echo "NETWORK: transport proven; provider authentication not proven"
