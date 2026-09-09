# Local Worker — Flash-Next on the Super X

**Status:** Qualified local bounded implementation worker  
**Qualified:** 2026-09-09  
**Primary machine:** ONEXPLAYER Super X (Ryzen AI MAX+ 395 / Radeon 8060S, Linux)

This document records where the local Flash-Next worker fits in the Sonoran Solutions model-routing stack, the configuration that was actually qualified, the failure modes discovered during qualification, and the operating rules that should be preserved when the worker is integrated into the router.

The important conclusion is not that a particular model benchmarked well in isolation. The qualified unit is the **model + runtime + harness + worker profile**.

---

## 1. Role in the routing stack

Flash-Next is the preferred **local-first bounded implementation worker** for tasks that have:

- clear acceptance criteria;
- a real repository and canonical tests/builds;
- a reasonably bounded implementation surface;
- conventional software-engineering uncertainty rather than research-class uncertainty;
- a human/stronger-model review path when needed.

It should be attempted before spending cloud-model budget on suitable low-risk implementation work.

Conceptually, the routing path becomes:

```text
Local bounded implementation
  Flash-Next
       ↓ escalate if task exceeds its capability / risk envelope
Tier 1 cloud
  DeepSeek V4 Flash / Gemini 3.8 Flash
       ↓
Tier 2
  GPT-5.6 Terra Medium
       ↓
Tier 3
  DeepSeek V4 Pro High
       ↓
Tier 4
  GPT-6 Astra Medium / High
```

This is a **local execution lane**, not a new permanent capability tier. The durable router policy should still describe task capability, risk, evidence, and escalation requirements rather than hard-coding a vendor/model into durable task state.

### Good Flash-Next work

Prefer Flash-Next for:

- bounded bug fixes;
- implementation from explicit issue acceptance criteria;
- CI/configuration changes;
- tests and test hardening;
- parsers, adapters, and local plumbing;
- multi-file conventional changes where the repository has useful tests;
- repetitive or mechanical engineering with enough room for edit/test correction;
- first-pass implementation that can be independently reviewed.

### Escalate instead of forcing it

Do not use Flash-Next as the default owner for:

- research / reverse engineering where the main question is "what is actually true?";
- undocumented hardware/protocol discovery;
- large ambiguous architecture redesigns;
- high-risk security/data-loss changes without stronger review;
- tasks whose acceptance criteria cannot be made concrete;
- work that repeatedly fails after a bounded attempt and a meaningful retry.

Use the normal evidence-first escalation ladder for those cases.

---

## 2. Qualified configuration

### Model

- **Model:** Qwen3.8-Flash-Next
- **GGUF:** `unsloth/Qwen3.8-Flash-Next-GGUF`
- **Quant:** `UD-IQ1_S`
- **Exact model payload:** 72,546,461,344 bytes

The quant is extremely aggressive. Its qualification means this exact configuration is useful; it does **not** imply that quantization has no effect on planning or quality.

### Runtime

- **llama.cpp:** b10858
- **Backend:** Vulkan
- **GPU offload:** local Super X GPU path
- **Practical context:** 32K
- **Flash attention:** enabled
- **KV:** F16
- **Observed generation:** approximately 22.5–23.2 tokens/s across the tested 8K–32K context ladder
- **Desktop condition:** Brave intentionally remained open during qualification
- **Paging:** no sustained swap I/O observed during the healthy context tests

The 32K configuration is the current known-good production baseline. Do not silently raise context or change the quant/runtime while treating prior qualification results as equivalent.

### OpenCode / provider metadata

The local OpenAI-compatible provider MUST declare explicit model limits:

```json
"limit": {
  "context": 32768,
  "output": 4096
}
```

OpenCode did not reliably infer the correct limits for this local provider. Missing/incorrect metadata contributed to an observed context-overflow/compaction failure during qualification.

### Worker behavior profile

The qualified worker is **not** a generic/default OpenCode agent prompt.

It requires an action-disciplined profile with these principles:

1. inspect enough to act, rather than trying to understand the entire repository first;
2. maintain a small reconnaissance budget before the first implementation attempt;
3. limit repeated investigation of one environmental blocker;
4. after a coherent patch exists, run the narrowest useful test early;
5. use test failures as new evidence and iterate;
6. avoid giant full-file reads unless genuinely necessary;
7. preserve enough context for implementation and debugging.

### Bounded-read rule

For large files, prefer:

```text
rg / grep → targeted line ranges → expand only if required
```

rather than reading an entire large file.

A single inspection result should normally stay below roughly 2,000–4,000 tokens. This is not merely a model preference: an earlier transfer run returned an ~18K-token tool payload, exceeded the provider/context limit, triggered OpenCode compaction, and destroyed useful task state.

---

## 3. Qualification evidence

The qualification series deliberately included failures; those failures are part of the operating contract.

### Dense Qwen3.8-27B controls

Dense stock Qwen3.8-27B and the Huihui variant were not good bounded workers under the tested small-worker configuration.

Observed failure modes included:

- approximately 5.4–6 generation tokens/s;
- excessive reconnaissance;
- zero-edit step-limit runs;
- incomplete or invalid patches;
- poor wall-clock economics compared with Flash-Next.

Keep Huihui only as an optional uncensored/debug/research standby. Dense Qwen is not the preferred implementation worker on the Super X.

### Flash-Next initial bounded task

On DualDex issue #6, Flash-Next produced a coherent, buildable partial patch. Independent host verification passed, but the worker edited only at the final step and completed roughly half of the issue.

Result: evidence of real coding capability, but the default worker behavior was still too reconnaissance-heavy.

### Real-work failure with normal profile

On DualDex issue #29, a 30-step normal-profile run produced **zero edits**. Re-running with the QuickJS submodule/environmental confound removed still produced the same zero-edit reconnaissance spiral.

Result: the environment was not the primary cause; the worker contract was.

### Action-disciplined success

With the action-disciplined profile, the same Flash-Next model implemented DualDex issue #29 through a real engineering loop:

```text
inspect
→ edit
→ test
→ diagnose
→ edit
→ test
```

Independent verification confirmed that the patch compiled and that the previously uncovered QuickJS calculator tests genuinely executed through the canonical CI entrypoint. A deliberate calculator-test failure also propagated correctly to CI failure.

Result: prompt/agent behavior is a major part of the worker's capability.

### Cross-repository transfer success

The decisive transfer test used Sonoran Solutions Orchestrator issue #7 (lease duration vs worker timeout).

After fixing explicit OpenCode limits and adding bounded-read discipline, Flash-Next:

- worked from a clean Orchestrator worktree;
- edited at step 13;
- made 8 edit calls across 4 files;
- ran tests;
- discovered a real defect in its first implementation (`max` had been seeded at 0 instead of the default timeout baseline);
- fixed the defect;
- reached **46/46 green tests**;
- passed an independent invalid-configuration probe;
- satisfied the independent acceptance review at normal code-review quality.

This cross-repository self-correction is the basis for the current classification:

> **LOCAL AUTONOMOUS BOUNDED IMPLEMENTATION WORKER**

"Autonomous" here means it can own a bounded implementation attempt inside the router's normal scope, worktree, test, timeout, and review constraints. It does not mean unrestricted shell/filesystem authority, unattended merge permission, or research-grade autonomy.

---

## 4. Known failure modes and mitigations

### Failure: reconnaissance spiral

**Symptom:** reads/searches consume the entire step budget before the first edit.

**Mitigation:** use the action-disciplined worker profile. More steps alone did not fix this behavior.

### Failure: oversized tool output / context compaction

**Symptom:** one giant read consumes a large fraction of context; the next provider request overflows; OpenCode compacts the session and loses useful task state.

**Mitigation:** explicit OpenCode context/output limits plus bounded file reads.

### Failure: late testing

Even successful runs can delay the first test too long.

**Mitigation:** once a coherent first-pass patch exists, prefer testing over additional polishing/reconnaissance. The target behavior is to leave enough budget for at least one test → diagnose → repair cycle.

### Thinking telemetry ambiguity

The thinking-enabled llama.cpp server produced `reasoning_content` in direct smoke tests, while OpenCode's recorded `reasoning` token field remained zero during agent runs.

Treat OpenCode reasoning-token accounting as unresolved for this provider. Thinking-enabled runs produced good engineering results, but causal superiority over thinking-off is not yet proven.

Operational default:

- use the qualified action profile;
- thinking may be used for design-heavy bounded tasks;
- do not make routing decisions from the current `reasoning=0` telemetry alone.

---

## 5. Router integration contract

When Flash-Next is wired into the Sonoran router, preserve these boundaries:

- one task = one isolated worktree + lease;
- minimum allowlisted environment only;
- no notifier/router secrets in the worker environment;
- explicit allowed paths;
- fixed worker executable/arguments (`shell: false`);
- hard timeout / step budget;
- canonical repo tests/builds;
- independent GitHub Actions remain authoritative;
- human merge remains the default until repository policy explicitly changes;
- OpenCode model limits are explicit;
- action-disciplined + bounded-read profile is selected;
- OpenCode process success is never treated as task success without inspecting diff/test evidence.

Recommended conceptual capability declaration:

```yaml
worker: local-flashnext
capabilities:
  - bounded-implementation
  - tests
  - ci-config
  - mechanical-refactor
constraints:
  research: false
  autonomous_merge: false
  requires_clear_acceptance: true
  requires_independent_verification: true
fallback:
  - tier-1-cloud
  - tier-2
```

The router should select this worker from task capability/risk policy rather than because a task explicitly names `flashnext`.

---

## 6. Relationship to SillyCode

SillyCode should not directly turn the conversational/RP model into this coding worker.

The intended future relationship is:

```text
SillyTavern character
    ↓ understands user intent / inspects repo through SillyCode
SillyCode
    ↓ requests bounded implementation capability
Sonoran Orchestrator
    ↓ selects worker
Flash-Next local worker
    ↓ patch + tests + evidence
Orchestrator / SillyCode
    ↓
Character reviews/explains result with the user
```

This preserves the key boundary:

> **The conversational character owns the interaction. Delegated coding workers own bounded implementation tasks.**

Flash-Next therefore gives SillyCode a cheap local implementation backend later, but SillyCode's first milestone should remain read-only repository-aware conversation.

---

## 7. What not to change yet

The current worker is qualified well enough to begin real use. Avoid turning qualification into another optimization project.

Defer unless real usage exposes a need:

- 48K/64K context experiments;
- MTP tuning;
- alternate Flash-Next quants;
- more dense-Qwen benchmarking;
- RTX 3080 multi-node execution;
- deep reasoning-token accounting work.

Use the worker on real bounded issues, collect success/rework data, and optimize only where production evidence shows a recurring problem.
