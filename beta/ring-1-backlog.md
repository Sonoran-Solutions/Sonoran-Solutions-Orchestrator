# DualDex Beta — Ring 1 Backlog

Extracted from `RELEASE_CHECKLIST.md` (Tier 1 "Protect Saves and Stabilize the
Emulator Core" + Phase 2 identity/versioning/CI). Each item is scoped with
acceptance criteria so an agent can pick it up via a handoff envelope
([`../handoff/handoff-envelope.md`](../handoff/handoff-envelope.md)).

Priority: **P0** = ship-blocking, **P1** = required for beta, **P2** = beta polish.

---

## R1 — Identity, versioning, CI (do first; everything else depends on it)

### R1-001 · Beta versioning — P0
- Set version to `0.9.0-beta.1` and establish the versioning scheme.
- **Acceptance:** version visible in Settings/About; `versionName` matches the
  tag/release convention; docs agree.
- **Files:** `app/build.gradle.kts`, About/Settings UI, `README.md`.

### R1-002 · Permanent signing key — P0 *(human-owned)*
- Generate the permanent Android signing key; back it up in ≥2 secure places;
  document the process privately; never ship a debug-signed public build.
- **Acceptance:** a signed `0.9.0-beta.1` can be produced from a non-temporary key.
- **Owner:** human (secret material — not in a worktree).

### R1-003 · Required CI checks (Rulesets) — P0 *(human-owned)*
- Make `DualDex CI` a required check on PRs to `main`; require PRs; block force-push.
- **Acceptance:** a PR without green CI cannot merge; direct push to `main` is rejected.
- **Owner:** human (GitHub Settings → Rules/Rulesets).

### R1-004 · Documentation/gameId consistency — P1
- Finish the docs cleanup already started (clone URL and `gameId` table are done).
- **Acceptance:** stale `gameId` test fixtures fixed (radical_red `5→7`,
  heart_and_soul `1→8`); supported-ROM list matches reality; README controller
  mappings verified.

---

## R1 — Save safety (the core of Tier 1)

### R1-005 · Unique ROM identity for saves — P0
- Key battery saves / save-states by a stable ROM identifier (SHA-256), not the
  profile name; store friendly metadata (name, hack, SHA-256, last played).
- **Acceptance:** two FireRed-based hacks never share a `.sav`/quicksave/save-state.
- **Files:** `SaveStateManager.kt`, `SettingsManager.kt`, save path logic.

### R1-006 · Safe ROM-switching sequence — P0
- Implement the 8-step switch: pause → flush battery save → backup → unload mGBA
  → clear companion state → load new ROM → load its save → resume.
- **Acceptance:** switching ROMs never loses or corrupts the previous save.
- **Files:** `LibretroHost.kt`, `MainActivity.kt`, `SaveStateManager.kt`.

### R1-007 · Atomic battery-save writes — P0
- Write to a temp file, verify, then replace the main `.sav`.
- **Acceptance:** killing the app mid-save never leaves a truncated `.sav`.
- **Files:** `SaveStateManager.kt` / SRAM flush path.

### R1-008 · Automatic `.sav.bak` backup + recovery — P0
- Keep ≥1 automatic backup; verify it restores.
- **Acceptance:** a corrupted main save can be recovered from `.sav.bak`.

### R1-009 · Safe save import — P0
- Do not overwrite the existing save until the import validates; auto-backup first.
- **Acceptance:** a malformed import leaves the existing save intact.

### R1-010 · Save stress tests — P1
- Rapid ROM switching, kill-after-in-game-save, pause/resume-while-saving.
- **Acceptance:** manual/automated test cases pass; no lost saves.

---

## R1 — Save import/export cleanup

### R1-011 · Emulator-neutral import UI — P2
- Remove "My Boy!" wording; rename to `Import Battery Save (.sav)`; clarify tested
  compatibility (DualDex, RetroArch/mGBA, My Boy!, standard GBA saves).
- **Acceptance:** copy no longer implies a single emulator.

### R1-012 · Save size validation + footer stripping — P1
- Validate known GBA save sizes; strip/convert known footer data; round-trip test
  across emulators.
- **Acceptance:** round-trips succeed without data loss or corruption.

### R1-013 · Replace-save warning + auto-backup — P1
- Warn before replacing an existing battery save; auto-backup before import.
- **Acceptance:** import flow shows the warning and creates the backup.

---

## R1 — Emulator core thread safety

### R1-014 · Single mutation owner + command queue — P0
- One thread owns all mGBA-mutating operations; add a command queue.
- **Acceptance:** no operation races `retro_run()`.
- **Files:** `LibretroHost.kt`, native JNI layer.

### R1-015 · Route core ops through the queue — P0
- Load/unload ROM, reset, save/load state, cheats, SRAM flush all go through the queue.
- **Acceptance:** operations serialize; no concurrent core mutation.

### R1-016 · Thread-safety stress tests — P1
- Save states while fast-forwarding; ROM switching while companion polling is active.
- **Acceptance:** no crashes/corruption under stress.

---

## R1 — Controller

### R1-017 · Wire advertised shortcuts — P1
- L2/R2 = quick-save/quick-load; X/Y = advertised functions; fast-forward toggle;
  ensure shortcuts don't leak into the GBA core.
- **Acceptance:** every README/Settings controller claim actually works.
- **Files:** `InputManager.kt`, `LibretroHost.kt`.

### R1-018 · Controller claims audit — P2
- Verify README + Settings against real behavior.
- **Acceptance:** no advertised-but-missing mappings.

---

## Later rings (high level — extract when reached)

- **Ring 2:** ROM detection states (verified/recognized/unsupported), engine/layout
  profile refactor, species-name mapping (#26).
- **Ring 3:** UI redesign — "Quiet Handheld Companion" design system first, then
  screen-by-screen fixes (UI_DESIGN_AUDIT.md).
- **Ring 4:** docs, GitHub Releases + signed builds, soak testing, privacy.
