# Planning pass — ORCH-011

> Roadmap task ORCH-011: have the planner produce a scoped task statement,
> acceptance criteria, likely files/components, known risks/non-goals, and a test
> plan — and confirm the plan does not expand scope (ORCH-012).

The pass below is produced for **Candidate A** (add a ROM-hack profile). It is
a template that a planner (Codex today, DeepSeek later for comparison) should
fill or verify, not an instruction to start writing code.

---

## 1. Scoped task statement

Add one new ROM-hack profile, `<id>`, to DualDex so the companion can detect and
adapt to that hack. The change is limited to:

- a new `app/src/main/assets/profiles/<id>.json`; and
- one parse/field assertion added to
  `app/src/test/java/com/dualdex/romhack/RomHackProfileTest.kt`.

No changes to emulator, save handling, calculator, UI, or release tooling.

## 2. Acceptance criteria

(Same as the issue — copied here so the planner owns them explicitly.)
1. Profile parses via `ProfileLoader.parseProfile`.
2. Unit test asserts `id`, `name`, and one other field.
3. `./gradlew testDebugUnitTest` passes.
4. `./gradlew assembleDebug` succeeds without new attributable warnings.
5. No files outside `profiles/` and the test directory change.
6. `headerTitles`/offsets verified against a real ROM, never guessed.

## 3. Likely files/components

- `app/src/main/assets/profiles/<id>.json` (new)
- `app/src/main/java/com/dualdex/romhack/RomHackProfile.kt` (read-only reference)
- `app/src/main/java/com/dualdex/romhack/ProfileLoader.kt` (read-only reference)
- `app/src/test/java/com/dualdex/romhack/RomHackProfileTest.kt` (add one test)
- `CONTRIBUTING.md` §2–§3 (the field contract)

## 4. Known risks / non-goals

- **Risk:** guessed offsets or `headerTitles` silently mis-detect the wrong ROM.
  **Mitigation:** human verifies against a real patched ROM before merge.
- **Risk:** a `customSpecies` block with wrong stats corrupts calculator output
  for that hack. **Mitigation:** omit `customSpecies` unless verified; it is optional.
- **Non-goal:** do NOT change detection logic, profile schema, or the UI.

## 5. Test plan

1. `./gradlew testDebugUnitTest` — includes the new parse assertion.
2. `./gradlew assembleDebug` — confirms the APK still builds.
3. (Human) spot-check detection on a real patched ROM.
4. (Optional) `gcc … native/tests/test_pokemon_reader.c …` if native is unaffected
   (expected: unaffected).

## 6. Scope check (ORCH-012)

The plan stays within "add data + one test." If the implementer finds they must
change `ProfileLoader` or the schema, that is scope expansion → stop and re-plan.
