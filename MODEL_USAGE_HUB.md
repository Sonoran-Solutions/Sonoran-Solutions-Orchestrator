# Sonoran Model Usage & Capacity Hub

**Status:** Planned
**Related policy:** [`MODEL_ROUTING.md`](MODEL_ROUTING.md)

The Sonoran Orchestrator should maintain one normalized view of model/provider availability, usage, quota, rate limits, and budget so both humans and the capability-tier router can answer a simple question before work is assigned:

> **What model capacity is actually available right now, and how trustworthy is that number?**

The hub is not only a dashboard. It is an input to routing policy. A Tier 4 task should not be assigned to Astra merely because Astra is the preferred model if the relevant quota is nearly exhausted, a provider is rate-limited, or an equivalent allowed worker has substantially more available capacity.

## Principles

1. **Provider-neutral state.** Durable orchestration state describes capability and capacity, not one vendor's quota format.
2. **Never invent precision.** If a provider does not expose an exact remaining percentage, record what is actually known rather than fabricating a number.
3. **Every value has provenance.** Usage/capacity data records its source, observation time, freshness, and confidence/quality.
4. **Routing consumes snapshots, not secrets.** Provider credentials remain in the secret authority; normalized capacity snapshots contain no API keys or reusable tokens.
5. **Local accounting supplements provider data; it does not silently replace it.** Local token/run accounting can estimate consumption when provider telemetry is incomplete, but estimates must be labeled as estimates.
6. **Capacity is not authority.** A model having available quota never grants it additional repository, hardware, secret, merge, or task permissions.
7. **Reserve expensive capacity for expensive problems.** The hub should help preserve scarce Tier 3/Tier 4 capacity for tasks that actually require it.

## Normalized capacity snapshot

A provider adapter should emit a normalized snapshot similar to:

```yaml
provider: openai
worker: gpt-6-astra-high
capability_tier: 4
status: available
observed_at: 2026-09-06T21:00:00Z
fresh_until: 2026-09-06T21:05:00Z
source: provider_api
quality: authoritative

capacity:
  remaining_fraction: 0.42       # optional; null when unknown
  requests_remaining: null       # optional
  tokens_remaining: null         # optional
  reset_at: null                 # optional

rate_limits:
  requests_remaining: 18         # optional
  requests_reset_at: 2026-09-06T21:01:00Z
  tokens_remaining: 85000        # optional
  tokens_reset_at: 2026-09-06T21:01:00Z

budget:
  spend_period: monthly
  spent: null                    # optional
  limit: null                    # optional

local_accounting:
  runs_today: 3
  input_tokens_today: 0          # populated when available
  output_tokens_today: 0
  estimated: true

notes: []
```

Fields that a provider cannot support should remain `null`/unknown. The UI must distinguish:

- **authoritative** — directly reported by the provider/account system;
- **derived** — calculated from authoritative observations;
- **estimated** — inferred from local accounting or known plan behavior;
- **manual** — configured by the human operator;
- **stale/unknown** — not safe for automatic routing decisions.

## Provider adapter interface

Each provider/model source should implement a small read-only adapter that can answer as much as it legitimately can:

```text
ProviderCapacityAdapter
├── identity/models
├── availability/health
├── quota or subscription usage (when exposed)
├── rate-limit state (when exposed)
├── reset windows (when exposed)
├── billing/budget usage (when authorized and useful)
└── provenance + freshness
```

Initial adapters should cover the models currently used by Sonoran Solutions:

- GPT-5.6 Terra;
- GPT-6 Astra;
- Gemini 3.8 Flash;
- DeepSeek V4 Flash;
- DeepSeek V4 Pro;
- any local/Hermes/Antigravity worker where useful.

The implementation should not assume every product exposes a public quota endpoint. Possible evidence sources include, in descending preference:

1. official provider usage/quota APIs;
2. official account/SDK telemetry;
3. rate-limit response headers;
4. authenticated billing APIs;
5. local run/token accounting;
6. explicit human-configured limits/reset schedules.

Screen-scraping account dashboards should not be the default architecture and should only be considered if it is permitted, stable, and genuinely necessary.

## Hub views

The human-facing hub should make the current state obvious at a glance:

```text
MODEL CAPACITY

Tier 1
  Gemini 3.8 Flash        AVAILABLE   high capacity     fresh 20s ago
  DeepSeek V4 Flash       AVAILABLE   high capacity     fresh 12s ago

Tier 2
  GPT-5.6 Terra Medium    AVAILABLE   71% remaining     authoritative

Tier 3
  DeepSeek V4 Pro High    AVAILABLE   54% remaining     estimated

Tier 4
  GPT-6 Astra High        LIMITED      8% remaining     authoritative
  GPT-6 Astra Medium      AVAILABLE   26% remaining     authoritative
```

Useful views include:

- current capacity by capability tier;
- provider/model availability and rate-limit state;
- quota/reset countdowns where known;
- current task/run reservations;
- consumption by repo/task/work class;
- daily/weekly/monthly usage history;
- estimated cost where applicable;
- stale/failed telemetry warnings;
- recent routing decisions affected by capacity.

## Router integration

Capacity should be one input to the deterministic routing decision engine described in [`MODEL_ROUTING.md`](MODEL_ROUTING.md), after capability and authorization requirements are satisfied.

Example decision:

```text
Task requires Tier 4 research
        ↓
Astra High is preferred
        ↓
capacity hub reports Astra High at 8% remaining
        ↓
policy reserves final 10% for explicit human-approved emergencies
        ↓
Astra High is ineligible for automatic dispatch
        ↓
try allowed Tier 4 equivalent / Astra Medium / human approval
```

Conversely, the router must not downgrade a task below the capability required merely to save quota. If no allowed model has enough capacity, the task becomes queued/blocked or requires human approval.

### Reservations

The hub should eventually support short-lived capacity reservations so concurrent tasks do not all observe the same remaining quota and simultaneously dispatch expensive runs.

A reservation records:

- task/run;
- worker/model;
- expected cost/capacity class;
- creation/expiry time;
- actual consumption after completion when known.

This is advisory capacity control, not a substitute for provider rate limits.

## Alerts

Useful alerts should be concise and exception-driven:

- premium tier below configured reserve threshold;
- provider/model unavailable or repeatedly rate-limited;
- usage telemetry stale beyond policy;
- unexpectedly rapid capacity consumption;
- monthly/daily budget threshold reached;
- actual usage materially exceeds a reservation/estimate;
- provider quota resets and previously blocked work can resume.

Avoid noisy per-request notifications.

## Persistence

SQLite can store normalized observations and usage history. A simple initial schema could include:

```text
provider_capacity_snapshots
usage_events
capacity_reservations
provider_health_events
budget_periods
```

Retention should preserve enough history to answer whether routing policy is actually saving scarce capacity without turning the orchestrator into a full billing warehouse.

## Security and privacy

- Read-only usage credentials where providers support scoped access.
- Credentials stay outside task worktrees and eventually in 1Password/secret authority.
- Never expose API keys, billing identifiers, or account secrets to arbitrary task workers.
- Sanitize provider errors before storing/displaying them.
- Provider telemetry is operational data, not task authority.

## MVP

The first useful version does not need perfect support for every provider.

1. Define the normalized snapshot schema.
2. Add one authoritative provider adapter and one local-accounting fallback adapter.
3. Persist snapshots in SQLite.
4. Expose a CLI/status endpoint showing all configured workers and freshness.
5. Feed availability/capacity into the model router in dry-run mode.
6. Add a simple dashboard after routing behavior is proven.
7. Add additional providers incrementally.

## Success criteria

The feature succeeds when:

- a human can see all configured model capacity in one place without visiting several provider dashboards;
- the router can avoid dispatching to an exhausted/rate-limited model;
- premium capacity can be protected by configurable reserve thresholds;
- unknown/stale telemetry cannot masquerade as precise live quota;
- routing decisions remain reproducible and auditable;
- adding/replacing a provider does not require changing durable task-state semantics.
