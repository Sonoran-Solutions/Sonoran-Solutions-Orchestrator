# Sonoran Model Routing Ladder

**Status:** Working policy
**Last reviewed:** 2026-09-06

This document defines how Sonoran Solutions should choose models for development work without wasting premium-model capacity on tasks that cheaper models can complete reliably.

The goal is not to always use the strongest available model. The goal is to route each task to the **cheapest model tier that can complete it safely and correctly**, then escalate only when the problem actually requires more reasoning or research capability.

> **Core rule:** Astra should usually receive evidence produced by cheaper models rather than being asked to gather all of the evidence itself.

Model names and provider offerings will change. Treat the specific models below as the current implementation of the ladder, not as permanent architecture. The durable concept is the **capability tier**.

---

## 1. The ladder

| Tier | Current models | Primary role | Typical work |
|---|---|---|---|
| **Tier 1 — Bulk / grunt work** | **DeepSeek V4 Flash**, **Gemini 3.8 Flash** | High-throughput reconnaissance and mechanical implementation | Scaffolding, tests, docs, inventories, log reduction, simple fixes, repetitive edits, known-interface integration |
| **Tier 2 — Normal serious engineering** | **GPT-5.6 Terra Medium** | Default engineering workhorse | Feature implementation, cross-file changes, debugging, refactors, correctness-sensitive work in an active codebase |
| **Tier 3 — Hard problems / second opinion** | **DeepSeek V4 Pro High** | Escalation layer before frontier research | Large-repo reasoning, ugly debugging, architecture, static reverse engineering, difficult failure analysis, second opinions after Tier 2 stalls |
| **Tier 4 — Research problems** | **GPT-6 Astra Medium / High** | Bounded research and experimental problem solving | Unknown protocols, undocumented state, difficult reverse engineering, hypothesis → experiment → evidence loops, novel cross-layer failures |

### Tier 1 — Bulk / grunt work

Use Tier 1 when the path is mostly known and the task benefits more from throughput, context capacity, or terminal access than from frontier reasoning.

Good examples:

- repository or machine inventories;
- scaffolding;
- test generation;
- documentation;
- CI plumbing;
- parsers and serializers;
- mechanical refactors;
- collecting and reducing logs;
- implementing a known interface from a written specification;
- searching a large evidence corpus for relevant events or patterns.

Tier 1 should often build the **evidence packet** that a higher tier consumes later.

### Tier 2 — Normal serious engineering

GPT-5.6 Terra Medium is the default when correctness matters across a real codebase and the work is more than mechanical, but the underlying problem is still conventional software engineering.

Good examples:

- non-trivial features;
- multi-file refactors;
- ordinary bug investigation;
- lifecycle and state-management fixes;
- implementation from an established architecture;
- integrating newly discovered protocol/API behavior;
- reviewing and repairing Tier 1 output.

Do not escalate merely because a task is large. A large task with a known solution can remain Tier 2.

### Tier 3 — Hard problems / second opinion

Use DeepSeek V4 Pro High when Tier 2 has made serious attempts without resolving the problem, or when the task begins with unusually tangled architecture, decompiled/static-analysis work, or a large ambiguous search space.

Good examples:

- difficult cross-layer bugs;
- large-repository reasoning;
- architectural failure analysis;
- static binary/decompiler archaeology;
- analyzing competing hypotheses from logs and traces;
- reviewing a proposed high-impact refactor;
- giving a fresh model a well-documented second attempt before escalating to Tier 4.

Tier 3 is the preferred **pre-Astra escalation step** when the problem might still yield to stronger conventional reasoning without requiring an experimental research loop.

### Tier 4 — Research problems

Use GPT-6 Astra Medium or High when the important question is not merely *how should we implement this?* but *what is actually true about this system?*

Good examples:

- undocumented network or Bluetooth protocols;
- unknown game/save/RAM structures;
- difficult reverse engineering;
- hardware/software behavior requiring controlled experiments;
- problems where the agent must form hypotheses, design tests, observe results, reject explanations, and iterate;
- novel failures spanning several layers where static inspection alone has stalled.

Astra High should normally be a **bounded mission with explicit success/stop conditions**, not the default model for an open-ended implementation sprint.

---

## 2. Routing principle: uncertainty, not prestige

Model escalation is driven by **unresolved uncertainty**, not by how exciting, important, or large a task sounds.

Examples:

- Building a large settings UI from a complete backend contract is probably Tier 1 or Tier 2.
- Discovering the undocumented BLE commands that make a proprietary liquid cooler operate safely is Tier 4 even if the final implementation is only a few hundred lines.
- Reading 40,000 lines of diagnostics and extracting relevant PCIe/NVMe events is Tier 1.
- Designing experiments that distinguish a PCIe power-management failure from an electrical/firmware failure may be Tier 3 or Tier 4.

Use premium reasoning on the **unknown**, not on boilerplate surrounding the unknown.

---

## 3. Default escalation path

The normal path is:

```text
Tier 1
  ↓ if task requires serious engineering
Tier 2
  ↓ after bounded, evidence-producing attempts
Tier 3
  ↓ if the remaining blocker is genuinely research/experimental
Tier 4
```

This is a guideline, not a requirement to waste attempts at every tier. A clearly research-class problem may begin at Tier 4 once cheaper reconnaissance has gathered the obvious evidence.

Conversely, never promote a task merely because one attempt failed. First ask whether the failure produced useful evidence and whether the next attempt is meaningfully different.

### Suggested escalation triggers

Escalate when one or more of the following is true:

1. **Repeated serious attempts fail.** The current tier has made approximately two well-designed attempts and the blocker remains unresolved.
2. **The problem changed class.** Implementation exposed an undocumented protocol, state machine, binary format, hardware interaction, or other research problem.
3. **Evidence is contradictory.** Logs, tests, traces, or source inspection support competing explanations that require deeper analysis or experiments.
4. **Static reasoning has stalled.** The next useful step requires designing and running discriminating experiments rather than reading more code.
5. **Cross-layer complexity exceeds the current worker.** The problem spans enough systems that the current model repeatedly loses important constraints or causal relationships.

Do **not** use unlimited retries at a cheaper tier just to avoid escalation. Attempts remain bounded under the orchestrator's normal safety rules.

---

## 4. Evidence-first handoff

Higher tiers should inherit a concise, durable evidence packet rather than rediscovering the project from scratch.

Before escalation, capture as much of the following as is relevant:

```yaml
goal: What must become true?
acceptance_criteria: How will success be verified?
current_state: What is known to work now?
blocker: What specifically remains unresolved?
attempts:
  - approach: What was tried?
    result: What happened?
    evidence: Relevant test/log/trace/output
confirmed_facts:
  - Evidence-backed observations only
open_hypotheses:
  - Plausible explanations not yet proven
rejected_hypotheses:
  - What was disproved and how
relevant_artifacts:
  - Files, commits, logs, captures, binaries, issue/PR links
safety_constraints:
  - Operations the next worker must not perform
stop_conditions:
  - What constitutes success or an evidence-backed blocker
```

The handoff should distinguish **confirmed fact**, **inference**, and **hypothesis**. Higher-tier models should not have to reverse-engineer the previous model's thought process from a giant chat transcript.

GitHub issues, PRs, research notes, and machine-readable handoff metadata should contain the durable result.

---

## 5. Step back down after discovery

Escalation is not permanent.

A common optimal workflow is:

```text
Tier 1: gather evidence and build tooling
    ↓
Tier 2/3: narrow the blocker
    ↓
Tier 4: discover the unknown behavior
    ↓
Tier 2: implement the production solution
    ↓
Tier 1: tests, docs, cleanup, packaging
```

For example, Astra may derive an undocumented BLE packet format. Once that behavior is documented and verified, Terra or a Flash-tier model should usually build the production UI, parsers, tests, packaging, and routine integrations.

Do not leave an expensive research model running simply because it solved the hardest part first.

---

## 6. Model-specific strengths in the current stack

These are **routing preferences**, not hard capability boundaries.

### Gemini 3.8 Flash

Prefer for:

- machine/repository reconnaissance;
- very large evidence or log corpora;
- multimodal supporting material such as screenshots/manuals;
- terminal-heavy inventory work;
- broad first-pass research where a large context window is valuable.

### DeepSeek V4 Flash

Prefer for:

- routine implementation;
- tests;
- parsers and CLI plumbing;
- documentation;
- CI/configuration;
- mechanical changes after the architecture is known.

### GPT-5.6 Terra Medium

Prefer for:

- the majority of serious day-to-day coding;
- implementation where repository-wide correctness matters;
- debugging conventional software failures;
- integrating findings produced by research models.

### DeepSeek V4 Pro High

Prefer for:

- hard second opinions;
- tangled architecture;
- static reverse engineering;
- difficult repository-wide debugging;
- narrowing a research problem before spending Tier 4 capacity.

### GPT-6 Astra Medium / High

Prefer for:

- unknown protocols/formats/state;
- agentic reverse engineering;
- experimental debugging;
- hardware/software archaeology;
- hypothesis-driven research loops.

Use **Medium** when the problem benefits from Astra's agentic/research behavior but is reasonably bounded. Use **High** for the rare cases where the research problem is genuinely difficult and the extra reasoning budget is justified.

---

## 7. Router architecture: route capability, not vendor

The Sonoran router should remain vendor-neutral.

Do **not** make durable task state depend on values such as:

```text
model = "gpt-6-astra"
```

Instead, future routing metadata should express the **required capability class** and optionally a preference. For example:

```yaml
capability_tier: 3
work_class: hard_debug
preferred_worker: deepseek-v4-pro
fallback_tier: 4
```

The exact field names are not yet an implementation requirement. The principle is:

> **Task state describes what capability the work requires. Configuration decides which current provider/model satisfies that capability.**

This allows Sonoran Solutions to replace a model, change providers, or re-price the ladder without changing the task lifecycle or durable GitHub history.

The router must also remain deterministic about authorization, leases, allowed paths, attempt counts, and safety policy. Model selection never gives a worker broader authority.

---

## 8. Cost-aware parallelism

Parallel agents are useful only when they explore meaningfully different paths.

Good parallelism:

- Gemini Flash reduces a large diagnostic corpus while DeepSeek Flash prepares reusable parsing tooling.
- Two Tier 1 workers independently inventory different subsystems.
- Tier 3 evaluates two competing architectural explanations with separate evidence.

Bad parallelism:

- launching four premium agents with the same prompt;
- asking Astra to perform routine repository reconnaissance that a Flash model can gather first;
- spawning a swarm when one deterministic test would settle the question.

Every additional worker should have a distinct question, evidence source, or implementation responsibility.

---

## 9. Safety overrides model economics

The ladder optimizes cost and capability. It never overrides safety.

For hardware control, destructive storage tests, production data, credentials, security-sensitive changes, or other high-risk work:

- begin read-only when possible;
- define forbidden operations explicitly;
- preserve backups and recovery paths;
- require human approval where the orchestration policy demands it;
- prefer the smallest discriminating experiment;
- do not let a stronger model infer that it has broader authority.

A higher reasoning tier is **not** a higher permission tier.

---

## 10. Examples across Sonoran projects

### Super X Helper

```text
Gemini 3.8 Flash
→ machine/hardware baseline and Linux interface inventory

DeepSeek V4 Flash / Terra
→ diagnostic collector and routine backend plumbing

DeepSeek V4 Pro
→ static OneXConsole/BLE archaeology and hard failure analysis

GPT-6 Astra
→ unresolved Frost Bay protocol research or Mini SSD hypothesis/experiment loop

Terra / Flash
→ production implementation after behavior is known
```

### DualDex

Use Flash-tier workers for routine tests/docs/data work, Terra for normal implementation and beta stabilization, DeepSeek Pro for difficult architecture/static-analysis work, and Astra only for genuinely unresolved emulator/protocol/reverse-engineering problems.

### Project Holocron

Use Terra while protocol progress remains steady. Escalate through a stronger second opinion when useful, then use Astra when the retail protocol blocker requires sustained hypothesis → trace → experiment reasoning rather than routine implementation.

---

## 11. Review cadence

Revisit this document when any of the following happens:

- a provider materially changes model capabilities or pricing;
- a new model is added to the Sonoran toolchain;
- real project data shows a cheaper tier consistently outperforming a higher one for a work class;
- the orchestrator gains automated model-routing support.

Do not preserve a model assignment for sentimental reasons. The ladder exists to optimize real project work.

The enduring policy is simple:

> **Cheap models build the laboratory. Strong engineering models narrow the problem. Frontier models do the science. Then cheaper models build the product from what was learned.**
