# DualDex pilot issue (M0 benchmark)

> Roadmap tasks: ORCH-005 (select issue), ORCH-006 (acceptance criteria),
> ORCH-007 (record current workflow).

## Status: proposed — awaiting human confirmation

The roadmap requires **one real, low-risk DualDex issue** to benchmark the manual
role split (Codex plan → human-steered Antigravity implement → Codex review →
GitHub Actions → human merge) before any automation is built.

## Recommended pilot issue (Candidate A)

**Title:** Add a new ROM-hack profile with a parsing unit test

**Why this one:**
- It is the exact contribution path documented in `CONTRIBUTING.md` (§2–§3).
- It is **low risk**: a JSON config in `app/src/main/assets/profiles/` plus one
  unit test in `app/src/test/java/com/dualdex/romhack/RomHackProfileTest.kt`.
  It does not touch the emulator, save handling, damage calculator, or UI.
- It exercises the whole loop (plan → implement → review → test → merge) on a
  change that is real but hard to get dangerously wrong.

**Blocker to clear first:** the human must pick the ROM hack and supply its real
metadata (id, name, baseGame, gameId, engine, offsets, header titles, SHA-256
hashes, and any custom species). None of that may be invented by an agent.

## Acceptance criteria (ORCH-006)

1. New profile file exists at `app/src/main/assets/profiles/<id>.json` and parses
   via `ProfileLoader.parseProfile`.
2. A unit test in `RomHackProfileTest.kt` asserts `id`, `name`, and one other
   meaningful field for the new profile.
3. `./gradlew testDebugUnitTest` passes.
4. `./gradlew assembleDebug` succeeds with no new warnings attributable to the change.
5. No files outside `app/src/main/assets/profiles/` and
   `app/src/test/java/com/dualdex/romhack/` are modified.
6. `headerTitles` and memory offsets are verified against a real patched ROM,
   not guessed.

## Baseline workflow (ORCH-007)

Current manual path to record, so the orchestrator has something to beat:

```text
1. Human reads CONTRIBUTING.md profile guide.
2. Human writes <id>.json by hand from real ROM data.
3. Human adds one RomHackProfileTest.kt case.
4. Human runs ./gradlew testDebugUnitTest, then ./gradlew assembleDebug.
5. Human opens a PR and merges (or asks for review).
```

Measure: wall-clock time, number of context lookups, and number of
human-intervention points for this same task done manually vs. through the
agent stack.

## Candidate B (deferred warm-up, even lower risk)

**Title:** Replace stale `devils-17` GitHub links in `README.md` with
`Sonoran-Solutions`.

- Acceptance: `grep -ri devils-17` in the repo returns nothing; both links resolve.
- Status: **already applied locally** during identity cleanup (ORCH-003); keep as
  a trivial smoke-test if a zero-risk first run is preferred.

## Decision needed from human

- [ ] Confirm Candidate A as the pilot issue, or pick another.
- [ ] For Candidate A: provide the ROM hack name + real profile data.
