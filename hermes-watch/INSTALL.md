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
binary inside `hermes-watch/sandbox-exec` — a bubblewrap mount/user/pid
namespace with a curated root filesystem.

Effective sandbox view:

| Path (inside sandbox) | Content | Access |
|---|---|---|
| `/opt/hermes-agent` | Hermes code + venv | read-only |
| `/opt/jdk17` | JDK 17 | read-only |
| `/opt/android-sdk` | Android SDK/NDK/CMake | read-only |
| `/home/dq/.local/share/uv/python` | uv-managed Python | read-only |
| `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/etc` | system toolchain (gcc, git, sh, certs) | read-only |
| `/dev`, `/proc`, `/tmp`, `/var`, `/run`, `/home`, `/root` | fresh/minimal (no host content) | fresh |
| `/home/hermes` | dedicated sandbox HOME (skills, git identity, gradle cache) | read-write |
| `$SONORAN_WORKTREE` | the assigned task worktree | read-write |

**Not visible:** `~/.git-credentials`, `~/.ssh`, `~/.config/sonoran`, the
orchestrator checkout, unrelated repositories/worktrees, and any other host
`/home/dq` content (except the worktree parent directory, which bwrap creates
empty to hold the worktree mount).

`--yolo` (command autonomy) is retained **only because it executes inside this
sandbox**. The sandbox is the security boundary; env allowlisting and filesystem
sandboxing are separate boundaries. Hermes has no owner Git credentials and
cannot push (ORCH-080 remains open).

Prove the boundary:

```bash
bash hermes-watch/sandbox-test.sh   # prints PASS lines; exits 0
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
- The sandbox git identity is the harmless
  `Sonoran Hermes Repair Worker <hermes@local>` (see the deploy script); there
  are no remote/owner credentials.
- `ripgrep` was not present at install time; Hermes falls back to `grep`.
  Install it for faster search: `sudo apt install ripgrep`.
- The router launches Hermes as a **fixed executable** with an explicit
  environment allowlist; task-controlled files never redefine the Hermes
  executable, sandbox flags, mounts, HOME, credentials, or network policy.
