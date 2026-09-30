# @ss/entitlements

The pure commerce core of the platform: catalog normalisation, entitlement resolution (precedence,
locks, runtime state), quotas, hourly settlement math and spend caps.

This document is **normative**: the behaviour described here is the contract that the Portal,
`@ss/app-kit` and the settlement jobs rely on, and the tests in `test/` enforce it.

- JavaScript ESM, functional, JSDoc-typed. No classes, no I/O, no clock: time is always a parameter.
- Inputs are never mutated; every function returns new values.
- Depends on nothing at runtime except `node:crypto` (SHA-256). Rules are **injected**
  (`evaluateRule(ruleSource, context)`), so this package does not depend on the `@ss/rules` API.

## 1. Units and representations

| Concept  | Representation                                                                                                                                                                                                                                                                          |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Money    | **Integer millicredits**. `1 credit = 1000 millicredits` (`MILLICREDITS_PER_CREDIT`). Plain JS numbers (exact up to 2^53). Manifest prices are already integer millicredits (`@ss/contracts`); `toMillicredits` converts display/decimal credits and rejects sub-millicredit precision. |
| Rates    | Metered prices are rationals `Rate = { millicredits, per }` — the manifest's `perUnit` millicredits per `per` units (charge `floor(q × millicredits / per)`), reduced to lowest terms. `rateFromCredits(0.00001)` → `{ millicredits: 1, per: 100 }`.                                    |
| Instants | Accepted as epoch ms, ISO string or `Date`; internally epoch ms (UTC). Outputs use ISO-8601 UTC without milliseconds when they are zero (`2026-10-01T10:00:00Z`).                                                                                                                       |
| Hashes   | `stableStringify` (keys sorted recursively) + SHA-256 hex. `bucketOf(parts)` = first 48 bits of `sha256(parts.join('\0'))` mod 10 000.                                                                                                                                                  |

Rounding: every charge rounds **down** to a whole millicredit. Metered charges are computed on
cumulative period-to-date usage (`charge(after) − charge(before)`), so the hourly entries of a period
always sum to exactly the charge of the period total (no drift; at most < 1 millicredit in the
merchant's favour per period and unit).

## 2. Catalog (`catalog.js`)

`normaliseProduct(input)` turns a contracts-validated SSPS v1 manifest into a `Product`:

- **Elements** `{ key, name, dependsOn[], requires[], defaultEnabled, features[] }`. `requires` is the
  manifest's `requires.resources` (resource kinds such as `database`, `ai`; a bare array is accepted).
  `defaultEnabled` is not an SSPS field and defaults to `false`. Dependencies must exist and be acyclic;
  `elementOrder` is a deterministic topological order.
- **Features** are the top-level properties of the element's `features` JSON Schema, keyed
  `element.name`. Metadata read from each node: `x-kind` (`flag|quota|limit|rate|config`; inferred as
  `flag` for booleans, `config` otherwise), `x-lock` (lockable, default `true`), `x-experiment`
  (default `false`), `x-plan` (`{ planCode: { default?, max? } }` — the **only** source of per-plan
  defaults and maxima), quota `x-period` (required) / `x-hardStop` (default `true`) / `x-unit`, rate
  `x-per` (required, `second|minute|hour`) / `x-unit`. `x-ui` is ignored. Numeric JSON types keep
  `minimum`/`maximum` as absolute bounds (quota/limit/rate default minimum 0); quota/limit/rate values
  may also be `null` = unlimited (an internal extension). Values are valid when they match the JSON
  type, `enum`, and string/array length bounds.
- **Plans** `{ code, name, elements, addons, available, defaults, max }`: `elements` are included and on
  by default, `addons` are allowed but off by default, `available = elements ∪ addons`; anything else is
  unavailable on the plan. Included elements' dependencies must be included; addons' dependencies must
  be available. `defaults`/`max` are collected from `x-plan`. A plan max is a number bound for numbers,
  the character length for strings, the item count for arrays, and a boolean for flags (`false` = cannot
  be enabled). `x-plan` defaults must satisfy their max.
- **Prices** are integer millicredits: `price.hourly`, `price.metered[] = { unit, perUnit, per = 1, included: { plan: n } }`.
- **Price books** `{ version, effectiveFrom, baseHourly, elements: { key: mc/h }, metered: { unit: { element, included, overage: Rate } } }`,
  sorted by `effectiveFrom` then `version`. The manifest's `priceBook { version, effectiveFrom }` takes
  prices from the elements; the Portal may pass the version history as `priceBooks[]`, each optionally
  overriding `base` (default 0), `elements` and `metered`.

Helpers: `elementDependencies(product, key)` → transitive `{ dependsOn, dependents }`;
`planDefaults(product, plan)` → `{ elements, available, features }`; `findPriceBook`,
`currentPriceBook(product, at)`. Errors carry `code = 'catalog/<reason>'`.

## 3. Resolution (`resolve.js`)

`resolveEntitlement({ product, subscription, layers, runtime, now, evaluateRule?, hash? })` returns the
**unsigned** entitlement payload (`schema: 'entitlement@1'`). Signing and `validUntil` belong to the
protocol layer.

### 3.1 Layers and precedence

Configuration layers, in precedence order (later wins):

| #   | Layer      | Supplied by                                 | Authority | Bounded by plan max | May lock |
| --- | ---------- | ------------------------------------------- | --------- | ------------------- | -------- |
| 1   | `product`  | schema `default` / element `defaultEnabled` | 3         | —                   | no       |
| 2   | `plan`     | plan `elements` / `x-plan` defaults         | 3         | —                   | no       |
| 3   | `platform` | `layers.platform` (staff policy)            | 4         | no                  | yes      |
| 4   | `merchant` | `layers.merchant` (merchant-wide defaults)  | 2         | **yes**             | yes      |
| 5   | `website`  | `layers.website` (website override)         | 1         | **yes**             | yes      |
| 6   | `admin`    | `layers.admin` (staff override)             | 5         | no (may exceed)     | yes      |
| 7   | runtime    | `subscription.status` + `runtime`           | —         | —                   | —        |

With a plan, the plan layer supplies an on/off value for **every** element (on for `elements`, off for
addons and unavailable ones) and a feature value for keys with an `x-plan` default. Without a plan, all
elements are available, product defaults apply and nothing is plan-bounded.

**Plan availability.** An element that is neither included nor an addon is unavailable: it resolves to
`enabled: false`, reason `not_in_plan`, and merchant/website attempts to enable it are reported as
`ignored / not_in_plan` (switching it off is not reported). Platform and admin may still enable it.

Layer entries: elements `{ enabled, locked?, from?, until? }` (or a bare boolean); features
`{ value, locked?, from?, until? }`. An entry applies only when `from ≤ now < until` (scheduled
switches). Entries with the wrong type are **ignored** (`invalid`); unknown keys are ignored (`unknown`).

### 3.2 Locks

- The **lock holder** is the locking candidate with the highest authority (ties: the later layer).
- Every candidate with authority **lower** than the holder is excluded; the effective value is the
  last remaining candidate in precedence order. Excluded merchant/website values are reported as
  `ignored / locked` with `lockedBy`.
- Consequences: a platform lock binds merchant and website; a merchant lock binds website; an admin
  value always applies and an admin lock also reports merchant/website attempts. Manifests cannot lock
  (product and plan layers never lock).
- `locked`/`lockedBy` in the output describe the holder even when admin overrode the value.
- A feature with `x-lock: false` ignores lock requests from non-admin layers (`lock_not_allowed`).

### 3.3 Bounds and clamping

Applied to the effective value only:

- Merchant, website and experiment values are clamped to the plan max (`plan_max`): numbers → the max
  (also when the attempt is `null`/unlimited), flags → `false`. Strings and arrays above the max
  (length / item count) cannot be clamped and are **ignored** (`ignored / plan_max`), so the next lower
  layer applies.
- Every layer, including admin, is clamped to the feature's **absolute** schema bounds (`min`, `max`).
- Each clamp is reported `{ kind: 'clamped', attempted, applied, reason }` and the feature's `reason`
  is `clamped`.

### 3.4 Runtime state

`state` is the first that applies: `cancelled` › `suspended` › `paused` (from `subscription.status`
or `runtime.state`) › `spend_cap` (`runtime.spendCap === true`) › `active` (`trialing` counts as
active). For each element that is **configured on**, in topological order, the first matching reason
disables it:

1. `state ≠ active` → reason = state;
2. `resource_missing` — a required resource kind is not `'connected'` in `runtime.resources` (a
   `{ kind: status }` map or the document's `[{ kind, status }]` list; listed in `missing`);
3. `rollout` — `runtime.rollouts[element] = { id, percent?, rule? }` excludes the subscription:
   `bucketOf([subscriptionId, element, id]) ≥ round(percent × 100)`, or `evaluateRule(rule, context)`
   does not return exactly `true` (missing evaluator or a throw fails closed). `context` =
   `runtime.context` + `subscriptionId, websiteId, merchantId, plan, now, element`;
4. `dependency` — a direct dependency is (finally) disabled (listed in `blockedBy`). Disabling cascades
   transitively; enabling an element never enables its dependencies.

Configured-off elements keep their configuration reason (the source layer or `not_in_plan`).

**Quotas:** for a `quota` feature with `hardStop`, `runtime.usage[key] ≥ value` sets `blocked: true`,
reason `quota_exhausted` (the element stays enabled; only that feature stops). Soft quotas never block.

**Experiments:** `runtime.experiments[] = { id, element, variants: [{ key, weight, values }] }`.
Variants are sorted by key; the subscription's bucket `bucketOf([subscriptionId, element, id])` is
mapped onto cumulative weights (`bucket < floor(cumulative × 10 000 / total)`). The selected
variant's values (feature names within the element) override the feature with `source: 'experiment'`,
subject to: feature is `experiment: true` (else `not_experimentable`), not locked (else `locked`), valid,
and clamped like a customer value. Experiments apply in id order.

### 3.5 Resolver output (internal)

```text
{ schema, subscriptionId, productSlug, productVersion, plan, priceBookVersion, state,
  elements: { key: { enabled, source, locked, lockedBy, reason, missing?, blockedBy? } },
  features: { key: { value, source, locked, lockedBy, reason, blocked } },
  config:   { element: { name: value } },
  experiments: { id: { element, variant } },
  contentHash, resolvedAt, report[] }
```

This richer shape is internal to the Portal. `priceBookVersion` is the subscription's pin, else the
book current at `now`. `contentHash = hash(stableStringify(content))` over everything before it —
`contentHash(resolved)` recomputes it — excluding `resolvedAt` and the diagnostic `report`, so an
unchanged effective state keeps its hash. The default hasher is SHA-256 via `node:crypto`
(deterministic, no I/O); pass `hash` to replace it. Output is independent of object key order and
experiment array order; keys are sorted. At most one experiment may run per element.

### 3.6 Canonical document (`document.js`)

The `@ss/contracts` entitlement document is canonical. `toDocument(resolved, meta)` maps the resolver
output plus Portal metadata (`websiteId, merchantId, domain, allowSubdomains, env, version, issuedAt,
validFrom, validUntil, resources, dataScope`, optional `subscriptionId`/`productSlug`/`planCode` which
must match, optional `priceBookVersion` override) and returns `{ ok: true, document }` only if
`validateEntitlementDocument` accepts it, else `{ ok: false, problems }`.

- `version` is the Portal's integer, bumped when `contentHash` changes.
- `cancelled` never yields a document: `{ ok: false, reason: 'cancelled' }` (the Portal revokes instead).
- `runtime` = `{ state: 'active' }` or `{ state, reason: state }` for `paused | suspended | spend_cap`.
  Per-element problems (resources, rollouts, dependencies) stay on the elements; the subscription state
  remains `active`.
- Elements: `{ enabled: true }` or `{ enabled: false, reason }`, where reason is the source name
  (`website_override`, …), `not_in_plan`, `rollout`, the runtime state, `resource_missing:<kinds…>` or
  `dependency:<elements…>`.
- Features: `{ value, source, locked, reason? }` with source `product_default | plan_default |
platform_policy | merchant_default | website_override | admin_override | runtime` (experiments);
  `reason` is `clamped` or `quota_exhausted` (the element stays enabled). `lockedBy`, `blocked`,
  `missing`, `blockedBy` are dropped.
- `experiments` = `[{ element, variant }]` sorted by element.

## 4. Quotas (`quotas.js`)

`periodBounds({ unit, timeZone = 'UTC', at })` → `{ start, end, key }` (half-open), using `Intl` only:

- `hour`: between instants whose local minutes/seconds are 0; a UTC-offset change also starts a new
  period (so a 30-minute DST shift yields a 30-minute period). The repeated fall-back hour is two
  periods. Key `hour:YYYY-MM-DDTHH:MM±hh:mm`.
- `day`: local midnight → next local midnight (23/25 h on DST days). Key `day:YYYY-MM-DD`.
- `week`: ISO week, Monday 00:00 local. Key `week:<monday date>`.
- `month`: the 1st 00:00 local. Key `month:YYYY-MM`.
- A local boundary inside a DST gap (e.g. skipped midnight in Santiago) starts at the first instant after the gap.

`quotaState({ feature: { value | included, hardStop, period }, counters, period?: { unit, timeZone }, now })`
→ `{ used, included, remaining, overage, exhausted, blocked, hardStop, period }`. `counters` is a list
of `{ at, quantity }` (summed within the period) or a period-to-date number. `null` included =
unlimited. `quotaAllows(state, qty)`; `overageCharge({ used, included, rate })`;
`incrementalOverageCharge({ usedBefore, usedAfter, included, rate })`.

## 5. Settlement (`settlement.js`)

`planSettlement({ subscription, priceBook, elementTimeline, pauses, from, to })` → `{ buckets, skipped, cursor, total }`.

- Buckets are **UTC hours**. Only complete buckets (`bucketEnd ≤ to`) starting at or after the cursor
  (`from`, rounded **up** to the hour) are produced, and only within `[startedAt, endedAt)`.
- **Started-hour rule:** a bucket is billable when the subscription has at least one active instant
  in it (in life and not covered by any pause). It is charged in full. The **sample instant** is the
  first active instant.
- **Amount** = `baseHourly + Σ hourly(element)` for elements enabled at the sample instant, using the
  price book pinned at the sample instant. Therefore an element enabled (or a new book pinned) after
  the sample instant is charged from the next bucket; an element disabled mid-hour is still charged
  for that started hour. Simultaneous events for one element resolve to disabled.
- `elementTimeline[] = { at, element, enabled }` must carry the effective billable states (from the
  entitlement history). `pauses[] = { from, to?, reason }` covers paused / suspended / spend-cap /
  balance time; `to` absent = still paused.
- **Pins:** `subscription.pins[] = { version, at }` (or `priceBookVersion` = one pin at `startedAt`). A
  pin applies from `max(pin.at, book.effectiveFrom)`. Without pins, the latest book effective at the
  sample applies. No applicable book → bucket skipped `unpriced` (never billed).
- **Skipped** buckets `{ periodKey, bucketStart, reason }` are never billed; reason = the
  highest-priority pause covering the bucket's first in-life instant (`suspended` › `spend_cap` ›
  `balance` › `paused` › others).
- `periodKey = ${subscriptionId}:${bucketStart}` with `bucketStart = YYYY-MM-DDTHH:00:00Z`. Zero-amount
  buckets are emitted so reconciliation sees every billable hour.
- Idempotency: identical inputs give identical output; any sequence of runs advancing `cursor`
  produces each bucket exactly once (catch-up after downtime is a single larger run).
- `nextCursor({ cursor, to }) = max(ceilHour(cursor), floorHour(to))` — monotonic, hour-aligned.

`planMeteredSettlement({ usageByUnit, included, overageRate, bucket })` → one entry
`periodKey = ${subscriptionId}:${bucketStart}:metered` with per-unit lines; `usageByUnit[unit]` is a
bucket quantity or `{ before, delta }` (period-to-date before the bucket). Missing `included` = 0,
`null` = unlimited.

`reconcile({ expectedBuckets, ledgerKeys })` → `{ missing, duplicates, extra, mismatched }` (keys or
`{ periodKey, amount }` on both sides; amounts compared when both are present).

Balance helpers: `balanceAfter({ balance, charges, credits })`,
`hoursRemaining({ balance, burnRatePerHour })` (`0` when balance ≤ 0, `null` when nothing burns),
`projectedMonth({ monthToDate, burnRatePerHour, now, timeZone })` (projects the current and remaining
UTC hours of the local calendar month), `hourlyCharge`/`burnRate({ priceBook, elements })`.

## 6. Spend caps (`spend.js`)

Caps `{ scope: 'website' | 'merchant', scopeId, window: 'day' | 'month', limit, timeZone? }` over
spend entries `{ at, amount, websiteId?, merchantId? }`.

- `spendCapState({ cap, entries, now, upcoming })` → `{ key, spent, limit, remaining, reached, wouldExceed, periodStart, periodEnd }`;
  `reached = spent ≥ limit`, `wouldExceed = reached || (upcoming > 0 && spent + upcoming > limit)`.
- `spendCapDecision({ caps, entries, now, upcoming })` → `{ shouldPause, blocking, resumeAt, states }`.
  Pause when any cap would be exceeded (pass the next hour's burn as `upcoming` to avoid starting an
  hour that breaks the cap); `resumeAt` = end of the latest blocking period. The resulting pause is fed
  to settlement as `pauses[{ reason: 'spend_cap' }]` and to resolution as `runtime.spendCap`.
