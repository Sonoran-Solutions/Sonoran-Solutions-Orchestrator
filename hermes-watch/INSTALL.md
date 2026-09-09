# Hermes agent — installation & configuration (ORCH-095..097)

Hermes is Nous Research's agent CLI (`github.com/nousresearch/hermes-agent`). It
is the **bounded CI repair technician** in the Sonoran workflow. This runbook
records the single self-hosted development-machine install, the sandboxed
execution boundary, and the fix-build skill deployment.

## Installed version

| Item | Value |
|---|---|
| Version | `v0.21.1` (2026.9.7) |
| Upstream commit | `f03ed94a` |
| Install method | `git` (managed by the installer) |
| Code | `/home/dq/.hermes/hermes-agent` |
| Data/config/skills | `/home/dq/.hermes` |
| Launcher | `/home/dq/.local/bin/hermes` (wrapper → `~/.hermes/hermes-agent/hermes`) |
| Python | `3.11.16` (managed venv, `/home/dq/.local/share/uv/python/...`) |

## Smoke test

```bash
hermes --version
# Hermes Agent v0.21.1 (2026.9.7) · upstream f03ed94a
```

If `hermes` is not on PATH, `source ~/.bashrc` (the installer adds `~/.local/bin`).

## Install / reinstall

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
# non-interactive, no model setup wizard:
bash <(curl -fsSL https://hermes-agent.nousresearch.com/install.sh) --non-interactive --skip-setup
```

The installer manages `uv`, Python, Node.js, and the agent under
`$HERMES_HOME` (default `~/.hermes`).

## Upgrade

```bash
hermes update
```

## Sandboxed execution boundary (ORCH-096)

The router does **not** launch `hermes` directly as the owner. It launches the
fixed launcher `hermes-watch/run-hermes-sandboxed`, which runs the real Hermes
binary inside `hermes-watch/sandbox-exec` — a Bubblewrap mount namespace with
explicit user, IPC, PID, UTS, and cgroup isolation plus a curated root filesystem.
The network namespace is deliberately shared for outbound inference transport.

Effective sandbox view:

| Path (inside sandbox) | Content | Access |
|---|---|---|
| `/opt/hermes-agent` | Hermes code + venv | read-only |
| `/opt/jdk17` | JDK 17 | read-only |
| `/opt/android-sdk` | Android SDK/NDK/CMake | read-only |
| `/home/dq/.local/share/uv/python` | uv-managed Python | read-only |
| `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/etc` | system toolchain (gcc, git, sh, certs) | read-only |
| `/dev`, `/proc`, `/tmp`, `/var`, `/run`, `/home`, `/root` | fresh/minimal (no host content) | fresh |
| `/home/hermes` | dedicated sandbox HOME (skills, provider config, caches) | read-write |
| `$SONORAN_WORKTREE` | assigned task-private Git checkout, including private `.git` metadata | read-write |

**Not visible:** `~/.git-credentials`, `~/.ssh`, `~/.config/sonoran`, the
orchestrator checkout, unrelated repositories/worktrees, and any other host
`/home/dq` content (except the worktree parent directory, which bwrap creates
empty to hold the checkout mount). Literal synthetic-sentinel and
`/proc/1/root` probes enforce these claims.

`--yolo` (command autonomy) is retained **only because it executes inside this
sandbox**. The sandbox is the security boundary; env allowlisting and filesystem
sandboxing are separate boundaries. `GIT_CONFIG_GLOBAL` and
`GIT_CONFIG_SYSTEM` point to `/dev/null`, interactive credential prompts are
disabled, the task remote has a disabled push URL, and Hermes receives no owner
Git/SSH/GitHub credentials. ORCH-080 remains open.

### Git-metadata isolation

The router source clone remains authoritative for repository identity, the live
base SHA, the assigned branch, ownership, lease, and allowed paths. For each run,
`prepareWorktreeForRun` creates a fresh standalone repository under
`worktreeRoot`, fetches only the router-approved starting commit over `file://`
(normal Git object transfer; no alternates or shared hardlinks), and creates the
assigned branch in that private repository. Its refs, index, config, hooks, and
objects are writable only inside the task checkout. A harmless repo-local
identity, `Sonoran Hermes Repair Worker <hermes@local>`, supports local commits.
The source checkout and its shared Git metadata are never mounted.

The private repository keeps a credential-free fetch URL for inspection, but
`origin`'s push URL is fixed to
`sonoran-no-push://router-owned-publication-required`. Local status/diff/add/
commit work; remote publication does not.

### Namespace and network policy

Bubblewrap always creates the mount namespace. The launcher explicitly unshares
user, IPC, PID, UTS, and cgroup namespaces. It intentionally does not unshare the
network namespace, and mounts only the resolved `/etc/resolv.conf` target back
into the otherwise-fresh `/run`. This preserves the curated filesystem while
enabling DNS and outbound HTTPS/TLS. Provider authentication is not configured
or proven; any future provider key belongs only in the dedicated Hermes HOME and
must be provider-specific, low-privilege, and budget/rate limited.

Prove the boundary and runtime behavior (no LLM call):

```bash
bash hermes-watch/sandbox-test.sh
# Git status/rev-parse/branch/diff/add/commit; credential absence;
# literal sentinel + /proc denial; DNS + HTTPS transport
```

## Deploy + verify the fix-build skill (ORCH-097)

The source of truth is `hermes-watch/fix-build.skill.md`. Deploy it into the
sandboxed Hermes HOME in the layout Hermes v0.21.1 resolves:

```bash
bash hermes-watch/deploy-fix-build-skill.sh
# deployed -> /home/dq/.hermes-sandbox/home/.hermes/skills/software-development/fix-build/SKILL.md
```

Verify with the real installation (through the sandbox):

```bash
WORKTREE=$(mktemp -d) SONORAN_WORKTREE="$WORKTREE" \
  hermes-watch/run-hermes-sandboxed skills list | grep fix-build
# │ fix-build │ software-development │ local │ local │ enabled │
```

A full `--skills fix-build` run requires a configured inference provider
(`hermes setup` inside the sandbox home) — that is model configuration, deferred
to M2.3, not a skill-resolution gap.

## Notes

- Hermes owns its sandbox config under `/home/dq/.hermes-sandbox/home/.hermes`
  (including any provider/model credentials configured later via `hermes setup`
  inside the sandbox). Those credentials are Hermes's own and are **not**
  committed to the repository.
- Each task-private repository has the harmless repo-local identity
  `Sonoran Hermes Repair Worker <hermes@local>`. Global/system Git config is
  ignored inside the sandbox; there are no remote/owner credentials.
- `ripgrep` was not present at install time; Hermes falls back to `grep`.
  Install it for faster search: `sudo apt install ripgrep`.
- The router launches Hermes as a **fixed executable** with an explicit
  environment allowlist; task-controlled files never redefine the Hermes
  executable, sandbox flags, mounts, HOME, credentials, or network policy.
