// lib/worktrees.mjs — per-task git worktree + lease isolation. ORCH-077..083.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function runGit(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

// A reference (non-bare) clone is the git database we attach worktrees to.
export function ensureRepo(repoSlug, reposRoot, base = 'https://github.com') {
  const name = repoSlug.split('/').pop();
  const dir = join(reposRoot, name);
  if (existsSync(join(dir, '.git'))) return dir;
  mkdirSync(reposRoot, { recursive: true });
  runGit(reposRoot, ['clone', '--quiet', `${base}/${repoSlug}.git`, dir]);
  return dir;
}

export function fetchLatest(sourceRepo, branch = '--all') {
  runGit(sourceRepo, ['fetch', '--quiet', 'origin', ...(branch === '--all' ? ['--all'] : [branch])]);
}

// Resolve a plain commit-ish (full or short SHA, or a ref) to a full 40-hex commit
// SHA *without* hitting the network. Used to expand a provided base SHA and then
// compare it to the live remote tip. Returns null when it cannot be resolved.
export function resolveCommitSha(sourceRepo, sha) {
  if (!sourceRepo || !sha) return null;
  try {
    const s = runGit(sourceRepo, ['rev-parse', '--verify', `${sha}^{commit}`]).trim();
    return /^[0-9a-f]{40}$/i.test(s) ? s : null;
  } catch {
    return null;
  }
}

// Normalize a base branch name to its remote-tracking ref so we resolve the LIVE
// remote tip, not a possibly-stale local branch.
function remoteTrackingRef(baseRef) {
  const r = String(baseRef || '').trim();
  if (!r) return '';
  if (r.startsWith('refs/remotes/')) return r;
  if (r.startsWith('refs/heads/')) return `refs/remotes/origin/${r.slice('refs/heads/'.length)}`;
  return `refs/remotes/origin/${r}`;
}

// Establish the CURRENT authoritative remote base tip for a code task.
//
//   - Explicitly refreshes the configured remote (fail closed on fetch failure, so
//     a stale clone can never silently supply an old local ref).
//   - Resolves the LIVE tip from the remote-tracking ref (refs/remotes/origin/<baseRef>),
//     NOT the local refs/heads/<baseRef>.
//   - If a base SHA was supplied (event / envelope), verifies it is a real commit and
//     that it equals the live remote tip; a stale / divergent / nonexistent base SHA
//     is refused.
//
// Returns { ok:true, sha } on success, or { ok:false, reason } otherwise. The router
// must refuse the task before worker execution on any { ok:false } result.
export function resolveBaseSha(sourceRepo, baseRef, { providedSha = '', remote = 'origin' } = {}) {
  if (!sourceRepo || !baseRef) return { ok: false, reason: 'missing source repo or base ref' };
  const track = remoteTrackingRef(baseRef);
  if (!track) return { ok: false, reason: 'base ref is empty' };

  // 1. Refresh the remote. Fail closed: never fall back to stale local state.
  try {
    runGit(sourceRepo, ['fetch', '--quiet', '--prune', remote]);
  } catch (e) {
    return { ok: false, reason: `failed to refresh remote '${remote}'` };
  }

  // 2. Resolve the live remote base tip.
  let live;
  try {
    live = runGit(sourceRepo, ['rev-parse', '--verify', `${track}^{commit}`]).trim();
  } catch {
    return { ok: false, reason: `base ref '${baseRef}' not found on remote '${remote}'` };
  }
  if (!/^[0-9a-f]{40}$/i.test(live)) return { ok: false, reason: 'base ref resolved to an invalid commit' };

  // 3. If a base SHA was provided, it must identify a real commit AND equal the live tip.
  if (providedSha) {
    const full = resolveCommitSha(sourceRepo, providedSha);
    if (!full) return { ok: false, reason: `provided base SHA '${providedSha}' is not a valid commit` };
    if (full !== live) {
      return { ok: false, reason: `provided base SHA ${full} is stale; live ${remote}/${baseRef} is ${live}` };
    }
    return { ok: true, sha: full };
  }

  return { ok: true, sha: live };
}

// A git ref name must be path-safe and never a CLI flag. We reject anything that
// isn't a conservative `[A-Za-z0-9._/-]` token, so envelope-supplied branch names
// can never become argument injection for `git worktree add`.
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
export function safeBranchName(name) {
  if (!name) return '';
  const s = String(name).trim();
  if (!s) return '';
  if (!BRANCH_RE.test(s)) return '';
  if (s.startsWith('-') || s.startsWith('/') || s.endsWith('/') || s.endsWith('.')) return '';
  if (s.includes('..') || s.includes('//') || /\.lock$/i.test(s)) return '';
  return s;
}

// Create one named branch + worktree per task (ORCH-077..080). Ownership becomes
// task <=> branch <=> worktree <=> lease. The worktree is placed on an existing or
// new named branch and FAILS CLOSED (throws) if that cannot be done — it never
// falls back to a detached HEAD. Retry/lifecycle policy lives in
// prepareWorktreeForRun, not here.
export function createWorktree({ sourceRepo, worktreeRoot, taskId, baseSha, branch }) {
  const dest = join(worktreeRoot, taskId);
  mkdirSync(worktreeRoot, { recursive: true });
  const safeBranch = safeBranchName(branch) || `agent/${taskId}`;
  try {
    runGit(sourceRepo, ['worktree', 'add', '-b', safeBranch, dest, baseSha || 'HEAD']);
  } catch {
    // Branch already exists — attach to it. Fail closed: if attach also fails we
    // must NOT silently fall back to detached HEAD.
    runGit(sourceRepo, ['worktree', 'add', dest, safeBranch]);
  }
  return dest;
}

// Is `ancestor` reachable from `ref` in the source repo? `git merge-base
// --is-ancestor` exits 0 when yes (we treat a non-zero exit as no/divergent).
function isAncestor(sourceRepo, ancestor, ref) {
  try { runGit(sourceRepo, ['merge-base', '--is-ancestor', ancestor, ref]); return true; }
  catch { return false; }
}

// Verify a freshly-prepared worktree: expected named branch, not detached, clean
// working tree, at the expected starting commit. Throws on any mismatch so the
// fails-closed path in dispatch can block the task.
export function verifyCleanWorktree(path, branch, startSha) {
  if (!existsSync(path)) throw new Error('worktree does not exist');
  const br = runGit(path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (br !== branch) throw new Error(`worktree is on '${br}', expected branch '${branch}'`);
  const head = runGit(path, ['rev-parse', 'HEAD']).trim();
  if (startSha && head !== startSha) throw new Error(`worktree HEAD ${head}, expected ${startSha}`);
  const status = runGit(path, ['status', '--porcelain']).trim();
  if (status) throw new Error('worktree has uncommitted changes');
}

// Prepare a clean worktree for a NEW execution attempt (ORCH-140 / handoff rule:
// "the next worker starts from the recorded GitHub state, not a dirty working
// tree"). A retry must NOT inherit dirt, local-only commits, an old base, or the
// wrong branch from a previous attempt.
//
//   - Removes any prior worktree for this task (no stale reuse, no two simultaneous
//     worktrees for the same task branch).
//   - If the task branch exists on origin, it is authoritative: the local branch is
//     reset to the remote tip, but ONLY if the remote branch is compatible with the
//     verified base (base is an ancestor). Otherwise it fails closed rather than
//     inventing an automatic rebase/merge.
//   - If the task branch is not on origin, it is recreated from the verified base SHA
//     (any stale local-only commits are discarded).
//   - Verifies branch / non-detached / clean / starting commit before returning.
export function prepareWorktreeForRun({ sourceRepo, worktreeRoot, taskId, baseSha, branch }) {
  const dest = join(worktreeRoot, taskId);
  const safeBranch = safeBranchName(branch) || `agent/${taskId}`;

  // 1. Never inherit a prior attempt's worktree state.
  if (existsSync(dest)) removeWorktree({ sourceRepo, worktreeRoot, taskId });

  // 2. Decide the authoritative starting commit for the task branch.
  let startSha = '';
  const remoteTrack = `refs/remotes/origin/${safeBranch}`;
  const remoteTip = resolveCommitSha(sourceRepo, remoteTrack);
  if (remoteTip) {
    // Task branch exists on origin -> authoritative, but it must be compatible with
    // the verified base. Do NOT invent an automatic rebase/merge.
    if (!isAncestor(sourceRepo, baseSha, remoteTrack)) {
      throw new Error(`task branch '${safeBranch}' is not compatible with the current base; explicit rebase/reopen required`);
    }
    // Reset the local branch to the remote tip so the worker continues from the
    // remote, not a stale local-only branch.
    try { runGit(sourceRepo, ['branch', '-f', safeBranch, remoteTrack]); } catch { /* create below if absent */ }
    startSha = remoteTip;
  } else {
    // Task branch not on origin -> recreate from the verified base, discarding any
    // stale local-only commits from an earlier run.
    try { runGit(sourceRepo, ['branch', '-D', safeBranch]); } catch { /* not present */ }
    startSha = baseSha;
  }

  // 3. Create the named worktree from the authoritative state.
  const path = createWorktree({ sourceRepo, worktreeRoot, taskId, baseSha, branch: safeBranch });

  // 4. Verify: expected branch, not detached, clean, at the expected commit.
  verifyCleanWorktree(path, safeBranch, startSha);
  return { path, branch: safeBranch, startSha };
}

export function removeWorktree({ sourceRepo, worktreeRoot, taskId }) {
  const dest = join(worktreeRoot, taskId);
  if (!existsSync(dest)) return;
  try { runGit(sourceRepo, ['worktree', 'remove', '--force', dest]); }
  catch { runGit(sourceRepo, ['worktree', 'prune']); }
}

// Resolve the real git dir for a worktree (its .git may be a "gitdir:" pointer).
export function resolveGitDir(worktreePath) {
  const dotgit = join(worktreePath, '.git');
  if (!existsSync(dotgit)) return null;
  const st = readFileSync(dotgit, 'utf8');
  const m = st.match(/^gitdir:\s*(.+)$/m);
  return m ? join(worktreePath, m[1].trim()) : dotgit;
}

const PUSH_GUARD = `#!/bin/sh
# Generated by the Sonoran router — enforce base-ref movement + allowed-path scope on push (ORCH-081/082).
# The base-branch movement check is intentionally separate from the pushed ref:
# a brand-new feature branch has an all-zero remote SHA, so comparing that against
# the recorded base SHA would wrongly allow a push after the base moved. Instead we
# ask the remote for the base branch's CURRENT tip and compare it to the recorded
# base SHA. Only the base branch's unexpected movement blocks a push.
#
# Allowed-path policy is TWO scopes, both enforced per changed file:
#   .sonoran-worker-allowed-paths  = worker/repository baseline (MAXIMUM trusted boundary)
#   .sonoran-task-allowed-paths    = optional task narrowing boundary
# A file must match the worker baseline AND (when a task scope exists) the task scope.
# This is a cooperative enforcement layer, not router-owned push verification.
worker_scope=".sonoran-worker-allowed-paths"
task_scope=".sonoran-task-allowed-paths"
base_ref="$(cat .sonoran-base-ref 2>/dev/null | tr -d '[:space:]')"
base_sha="$(cat .sonoran-base-sha 2>/dev/null | tr -d '[:space:]')"
zero="0000000000000000000000000000000000000000"
# Normalize to a full ref path so both the remote query and the "don't push to base"
# comparison work whether we stored "main" or "refs/heads/main".
case "$base_ref" in
  refs/heads/*) base_full="$base_ref" ;;
  *) base_full="refs/heads/$base_ref" ;;
esac

warn() { echo "$*" >&2; }
block() { warn "push blocked: $*"; exit 1; }

# in_scope <file> <scope-file> <required:1|0>
#   scope file absent + required  -> BLOCK (fail closed for the worker baseline)
#   scope file absent + optional  -> allow (no task narrowing supplied)
#   otherwise -> matches any glob pattern in the scope file
in_scope() {
  file="$1"; scope="$2"; required="$3"
  if [ ! -f "$scope" ]; then
    [ "$required" = "1" ] && return 1 || return 0
  fi
  while IFS= read -r pat; do
    [ -z "$pat" ] && continue
    case "$file" in
      $pat) return 0 ;;
    esac
  done < "$scope"
  return 1
}

# 1. Base-ref movement gate (ORCH-081): the task's base branch must still be at the
#    recorded SHA on the remote. Checked independently of whatever is being pushed.
if [ -n "$base_ref" ] && [ -n "$base_sha" ]; then
  remote_base="$(git ls-remote origin "$base_full" 2>/dev/null | awk '{print $1}')"
  if [ -z "$remote_base" ]; then
    block "base branch $base_full not found on remote (ref deleted or moved?)"
  elif [ "$remote_base" != "$base_sha" ]; then
    block "base branch moved unexpectedly: $base_full is at $remote_base, expected $base_sha"
  fi
fi

while read -r local_ref local_sha remote_ref remote_sha; do
  # 2. A worker stays on its own branch; never let a push move the base branch itself.
  if [ -n "$base_ref" ] && [ "$remote_ref" = "$base_full" ]; then
    block "cannot push directly to the base branch ($base_full)"
  fi

  # 3. Allowed-paths gate (ORCH-082): worker baseline AND task scope, per file.
  if [ -f "$worker_scope" ] || [ -f "$task_scope" ]; then
    old="$remote_sha"
    [ "$old" = "$zero" ] && old="$base_sha"
    files=$(git diff --name-only "$old"..."$local_sha" 2>/dev/null)
    for f in $files; do
      if ! in_scope "$f" "$worker_scope" "1"; then
        block "'$f' is outside the worker/repository baseline allowed paths"
      fi
      if ! in_scope "$f" "$task_scope" "0"; then
        block "'$f' is outside this task's allowed paths"
      fi
    done
  fi
done
exit 0
`;

// Install a pre-push guard into the worktree's actual git dir (best-effort).
// workerAllowedPaths is the worker/repository baseline (maximum trusted boundary);
// taskAllowedPaths is an optional narrowing boundary. Both are written so the guard
// enforces the intersection per changed file.
export function installPushGuard(worktreePath, { workerAllowedPaths = [], taskAllowedPaths = [], baseSha = '', baseRef = '' } = {}) {
  const gitdir = resolveGitDir(worktreePath);
  if (!gitdir) return;
  writeFileSync(join(worktreePath, '.sonoran-worker-allowed-paths'), (workerAllowedPaths || []).join('\n') + '\n');
  writeFileSync(join(worktreePath, '.sonoran-task-allowed-paths'), (taskAllowedPaths || []).join('\n') + '\n');
  if (baseSha) {
    writeFileSync(join(worktreePath, '.sonoran-base-sha'), baseSha + '\n');
  }
  if (baseRef) {
    writeFileSync(join(worktreePath, '.sonoran-base-ref'), baseRef + '\n');
  }
  const hooksDir = join(gitdir, 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, 'pre-push'), PUSH_GUARD, { mode: 0o755 });
}

// Remove a worktree by explicit source repo + path (used by the lease reaper).
export function removeWorktreePath(sourceRepo, worktreePath) {
  if (!existsSync(worktreePath)) return;
  try { runGit(sourceRepo, ['worktree', 'remove', '--force', worktreePath]); }
  catch { runGit(sourceRepo, ['worktree', 'prune']); }
}
