#!/usr/bin/env bash
#
# sandbox-test.sh — deterministic runtime tests for the exact Hermes sandbox.
# Creates a router-style task-private Git checkout and exercises filesystem,
# Git, credential, /proc, DNS, and TLS behavior without an LLM call.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"

REMOTE="$tmp/remote.git"
SEED="$tmp/seed"
SOURCE_REPO="$tmp/router-source"
WORKTREE_ROOT="$tmp/task-checkouts"
TASK_ID="hermes-git-runtime"
RUN_ID="11111111-1111-4111-8111-111111111111"
RUN_HOME_ROOT="/home/dq/.hermes-sandbox/runs/$RUN_ID/home"
RUN_STATE_ROOT="/home/dq/.local/state/sonoran-orchestrator/runs/$RUN_ID"
RUN_ID_B="22222222-2222-4222-8222-222222222222"
RUN_HOME_ROOT_B="/home/dq/.hermes-sandbox/runs/$RUN_ID_B/home"
RUN_STATE_ROOT_B="/home/dq/.local/state/sonoran-orchestrator/runs/$RUN_ID_B"
RUN_ID_TIMEOUT="33333333-3333-4333-8333-333333333333"
RUN_HOME_ROOT_TIMEOUT="/home/dq/.hermes-sandbox/runs/$RUN_ID_TIMEOUT/home"
RUN_STATE_ROOT_TIMEOUT="/home/dq/.local/state/sonoran-orchestrator/runs/$RUN_ID_TIMEOUT"
BRANCH="repair/runtime-smoke"
WORKTREE="$WORKTREE_ROOT/$TASK_ID"
HOST_SENTINEL="$tmp/unrelated-repo/secret.txt"
HOST_HTTP_PID=""

cleanup() {
  if [ -n "$HOST_HTTP_PID" ]; then
    kill "$HOST_HTTP_PID" >/dev/null 2>&1 || true
    wait "$HOST_HTTP_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "/home/dq/.hermes-sandbox/runs/$RUN_ID"
  rm -rf "/home/dq/.local/state/sonoran-orchestrator/runs/$RUN_ID"
  rm -rf "/home/dq/.hermes-sandbox/runs/$RUN_ID_B"
  rm -rf "/home/dq/.local/state/sonoran-orchestrator/runs/$RUN_ID_B"
  rm -rf "/home/dq/.hermes-sandbox/runs/$RUN_ID_TIMEOUT"
  rm -rf "/home/dq/.local/state/sonoran-orchestrator/runs/$RUN_ID_TIMEOUT"
  rm -rf "$tmp"
}
trap cleanup EXIT

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

mkdir -p "$WORKTREE_ROOT" "$(dirname "$HOST_SENTINEL")" "$RUN_HOME_ROOT" "$RUN_STATE_ROOT" "$RUN_HOME_ROOT_B" "$RUN_STATE_ROOT_B" "$RUN_HOME_ROOT_TIMEOUT" "$RUN_STATE_ROOT_TIMEOUT"
"$here/deploy-fix-build-skill.sh" >/dev/null
printf 'TOP-SECRET\n' > "$HOST_SENTINEL"
printf 'run-a\n' > "$RUN_STATE_ROOT/run-a-only"
printf 'run-b\n' > "$RUN_STATE_ROOT_B/run-b-only"

# A controlled host-local endpoint must remain unreachable from the worker's
# private network namespace through loopback, localhost, and the host LAN IP.
HOST_HTTP_PORT_FILE="$tmp/host-http.port"
node --input-type=module - "$HOST_HTTP_PORT_FILE" <<'NODE' &
import http from 'node:http';
import { writeFileSync } from 'node:fs';
const portFile = process.argv[2];
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('HOST-SECRET\n');
});
server.listen(0, '0.0.0.0', () => writeFileSync(portFile, String(server.address().port)));
NODE
HOST_HTTP_PID="$!"
for _ in $(seq 1 100); do [ -s "$HOST_HTTP_PORT_FILE" ] && break; sleep 0.02; done
[ -s "$HOST_HTTP_PORT_FILE" ] || { echo "host HTTP fixture failed to start" >&2; exit 1; }
HOST_HTTP_PORT="$(<"$HOST_HTTP_PORT_FILE")"
HOST_LAN_IP="$(ip -4 route get 1.1.1.1 | awk '{ for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit } }')"
HOST_NET_NS="$(readlink /proc/self/ns/net)"

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
HOST_HTTP_PORT="$5"
HOST_LAN_IP="$6"
HOST_NET_NS="$7"
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
skill=/home/hermes/.hermes/skills/software-development/fix-build/SKILL.md
if [ -r "$skill" ] && grep -q '^name: fix-build$' "$skill"; then pass immutable-skill-readable; else fail immutable-skill-readable; fi
if printf 'overwrite\n' 2>/dev/null > "$skill"; then fail immutable-skill-overwrite-denied; else pass immutable-skill-overwrite-denied; fi
if touch /home/hermes/.poison; then pass run-a-home-write; else fail run-a-home-write; fi
if [ "$SONORAN_RESULT_FILE" = /run/sonoran/repair-result.json ] && printf 'run-a-result\n' > "$SONORAN_RESULT_FILE"; then pass current-run-result-mount; else fail current-run-result-mount; fi
if [ -f /run/sonoran/run-a-only ] && [ ! -e /run/sonoran/run-b-only ]; then pass current-run-state-only; else fail current-run-state-only; fi

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

# The production namespace must differ from the host and its filter must be
# immutable to the nested worker user namespace.
ACTUAL_NET_NS="$(readlink /proc/self/ns/net 2>/dev/null || true)"
if [ -n "$ACTUAL_NET_NS" ] && [ "$ACTUAL_NET_NS" != "$HOST_NET_NS" ]; then pass private-network-namespace; else fail "private-network-namespace($ACTUAL_NET_NS)"; fi
if nft flush ruleset >/dev/null 2>&1; then fail network-policy-worker-immutable; else pass network-policy-worker-immutable; fi

url_denied() {
  label="$1"; url="$2"
  if curl -fsS --connect-timeout 2 --max-time 3 "$url" >/dev/null 2>&1; then fail "$label"; else pass "$label"; fi
}
url_denied host-loopback-denied "http://127.0.0.1:$HOST_HTTP_PORT/"
url_denied host-localhost-denied "http://localhost:$HOST_HTTP_PORT/"
if [ -n "$HOST_LAN_IP" ]; then url_denied host-private-lan-denied "http://$HOST_LAN_IP:$HOST_HTTP_PORT/"; else fail host-private-lan-address-missing; fi
url_denied rfc1918-10-denied http://10.0.0.1/
url_denied rfc1918-172-denied http://172.16.0.1/
url_denied rfc1918-192-denied http://192.168.0.1/
url_denied link-local-metadata-denied http://169.254.169.254/latest/meta-data/

# Public DNS and provider-relevant TLS transport remain available without a key.
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
  SONORAN_RESULT_FILE="/run/sonoran/repair-result.json" \
  "$here/sandbox-exec" /bin/bash "$fixture" "$HOST_SENTINEL" "$repo_root" "$START_SHA" "$BRANCH" "$HOST_HTTP_PORT" "$HOST_LAN_IP" "$HOST_NET_NS"

if [ "$(<"$RUN_STATE_ROOT/repair-result.json")" = run-a-result ]; then
  printf 'PASS:result-channel-host-mapping\n' >> "$WORKTREE/.sandbox-probe-out"
else
  printf 'FAIL:result-channel-host-mapping\n' >> "$WORKTREE/.sandbox-probe-out"
fi

# A second exact production sandbox gets a different HOME and run-state mount.
# It must not observe run A poison/state and must see the same immutable base skill.
if env -i \
  PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  HOME="/home/dq" \
  SONORAN_WORKTREE="$WORKTREE" \
  SONORAN_RUN_ID="$RUN_ID_B" \
  SONORAN_RESULT_FILE="/run/sonoran/repair-result.json" \
  "$here/sandbox-exec" /bin/bash -c '
    set -eu
    skill=/home/hermes/.hermes/skills/software-development/fix-build/SKILL.md
    [ ! -e /home/hermes/.poison ]
    [ -r "$skill" ] && grep -q "^name: fix-build$" "$skill"
    ! printf "overwrite\n" 2>/dev/null > "$skill"
    [ -f /run/sonoran/run-b-only ] && [ ! -e /run/sonoran/run-a-only ]
  '; then
  printf 'PASS:run-b-home-and-state-isolated\n' >> "$WORKTREE/.sandbox-probe-out"
else
  printf 'FAIL:run-b-home-and-state-isolated\n' >> "$WORKTREE/.sandbox-probe-out"
fi

# Simulate the router timeout signal. Killing the foreground pasta supervisor
# must terminate Bubblewrap and the worker rather than orphaning the process tree.
set +e
timeout --signal=TERM --kill-after=2 1 env -i \
  PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  HOME="/home/dq" \
  SONORAN_WORKTREE="$WORKTREE" \
  SONORAN_RUN_ID="$RUN_ID_TIMEOUT" \
  SONORAN_RESULT_FILE="/run/sonoran/repair-result.json" \
  "$here/sandbox-exec" /bin/bash -c 'exec -a sonoran-timeout-probe sleep 30'
timeout_status="$?"
set -e
if [ "$timeout_status" = 124 ] && ! pgrep -f '^sonoran-timeout-probe 30$' >/dev/null 2>&1; then
  printf 'PASS:timeout-process-tree-terminated\n' >> "$WORKTREE/.sandbox-probe-out"
else
  printf 'FAIL:timeout-process-tree-terminated(status=%s)\n' "$timeout_status" >> "$WORKTREE/.sandbox-probe-out"
fi

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

# pasta command mode must have exited with each sandbox and left no live helper.
for state_dir in "$RUN_STATE_ROOT" "$RUN_STATE_ROOT_B" "$RUN_STATE_ROOT_TIMEOUT"; do
  if [ -s "$state_dir/network-helper.pid" ]; then
    NETWORK_HELPER_PID="$(<"$state_dir/network-helper.pid")"
    if kill -0 "$NETWORK_HELPER_PID" >/dev/null 2>&1; then
      printf 'FAIL:network-helper-lifecycle(pid=%s)\n' "$NETWORK_HELPER_PID" >> "$out"
    else
      printf 'PASS:network-helper-lifecycle\n' >> "$out"
    fi
  else
    printf 'FAIL:network-helper-pid-missing\n' >> "$out"
  fi
done

echo "--- sandbox runtime probe results ---"
cat "$out"

if grep -q '^FAIL:' "$out"; then
  echo "SANDBOX TEST: FAILED"
  exit 1
fi
echo "SANDBOX TEST: PASSED"
echo "NETWORK: isolated filtered transport proven; provider authentication not proven"
