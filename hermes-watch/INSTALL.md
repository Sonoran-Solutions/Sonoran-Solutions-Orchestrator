# Hermes agent — installation & configuration (ORCH-095)

Hermes is Nous Research's agent CLI (`github.com/nousresearch/hermes-agent`). It
is the **bounded CI repair technician** in the Sonoran workflow. This runbook
records the single self-hosted development-machine install.

## Installed version

| Item | Value |
|---|---|
| Version | `v0.21.1` (2026.9.7) |
| Upstream commit | `f03ed94a` |
| Install method | `git` (managed by the installer) |
| Code | `/home/dq/.hermes/hermes-agent` |
| Data/config/skills | `/home/dq/.hermes` |
| Launcher | `/home/dq/.local/bin/hermes` (wrapper → `~/.hermes/hermes-agent/hermes`) |
| Python | `3.11.16` (managed venv) |

## Smoke test

```bash
hermes --version
# Hermes Agent v0.21.1 (2026.9.7) · upstream f03ed94a
```

If `hermes` is not on PATH, `source ~/.bashrc` (the installer adds
`~/.local/bin`).

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

## Notes

- Hermes owns its config under `~/.hermes` (including any provider/model
  credentials configured later via `hermes setup`). Those credentials are
  Hermes's own and are **not** committed to the repository.
- `ripgrep` was not present at install time; Hermes falls back to `grep`.
  Install it for faster search: `sudo apt install ripgrep`.
- The router launches Hermes as a **fixed executable** with an explicit
  environment allowlist; task-controlled files never redefine the Hermes
  executable, and router-only secrets are never passed to it.
- The exact headless invocation is `hermes -z <prompt> --in <worktree>
  --skills fix-build --yolo` (see `router/config.example.json`). Confirm flag
  semantics against the installed version (`hermes --help`) before relying on it.
