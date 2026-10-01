# @ss/contracts

Versioned JSON Schemas (2020-12) and validators that bind the Portal and every product (SSPS v1): product manifest,
element feature schemas, entitlement document payload, event envelope + standard events, placement, Website Graph
entities, and RFC 9457 problem details. Pure, functional ESM; the only dependencies are `ajv` and `ajv-formats`.

## API

```js
import {
	createValidator, // ({ schemas?, events? }) → { validate(id, value), has, validateManifest, validateEntitlementDocument,
	//                  validateEvent, validatePlacement, validateGraphEntity, validateFeatureConfig }
	validateManifest,
	validateEntitlementDocument,
	validateEvent,
	validatePlacement,
	validateGraphEntity,
	validateFeatureConfig,
	checkManifest,
	checkFeatureSchema,
	checkEntitlementDocument,
	checkPlacement, // pure semantic checks → problems[]
	isTimeZone,
	isLanguageTag,
	actorAllowedForKeyKind, // (kind: 'pk' | 'sk', actorType) → boolean
	KEY_KINDS, // ['pk', 'sk']
	WEBSITE_KEY_ACTORS, // { pk: ['customer', 'anonymous'], sk: ['customer', 'anonymous', 'staff', 'merchant'] }
	problem,
	createProblemFactory,
	PROBLEM_CODES, // RFC 9457
	createId,
	isId,
	parseId,
	ID_PREFIXES,
	normaliseDomain,
	hostMatchesDomain,
	SCHEMA_IDS,
	ALL_SCHEMAS,
	GRAPH_ENTITY_SCHEMAS,
	STANDARD_EVENT_DATA,
	MILLICREDITS_PER_CREDIT,
} from '@ss/contracts';

const result = validateManifest(json); // { ok: true, value } | { ok: false, problems: [{ path, message, keyword }] }
const errors = createProblemFactory({ baseUri: 'https://errors.example.dev' });
if (!result.ok) return errors.fromValidation(result.problems, { code: 'invalid_manifest', requestId });
```

- `path` is a JSON Pointer; `keyword` is the failing schema keyword or a semantic rule id (`MANIFEST_RULES`, `DOCUMENT_RULES`).
- Each validator owns one Ajv instance (strict, `allErrors`, formats) and compiles each schema once. The named helpers use a
  lazily created process-wide validator. Product events are added with `createValidator({ events: { 'coupon.redeemed@1': schema } })`.
- Schema ids are URNs: `urn:ss:contracts:v1:<name>`; standard event data: `urn:ss:contracts:v1:event:<type@v>`.

## Conventions

- **Credits** are **millicredits (1 credit = 1000)** everywhere — manifest prices and the ledger. A metered price is `perUnit`
  millicredits per `per` units.
- **Per-plan bounds** live only in feature schemas (`x-plan: { <plan>: { default, max } }`); `plans[]` list `elements` (included, on by default) and `addons` (allowed, off by default); anything else is unavailable on that plan.
- **Feature metadata**: `x-kind` (flag|quota|limit|rate|config); quotas need `x-period` (hour|day|week|month) and may set
  `x-hardStop`, `x-unit`; rates need `x-per` (second|minute|hour) and may set `x-unit`.
- **Events**: every consumed entry — an exact `type@v` or a glob such as `custom.*` / `order.*@1` (`isEventGlob`; a
  version-less glob matches every version) — needs an `events.subscribe:<glob>` scope that covers it; published types must be in the product namespace
  (`<slug>.*`, `-` → `_`) or be standard events covered by an `events.publish:<glob>` scope.
- **Event scopes**: the envelope has an optional `scope`, either `'website'` (the default) or `'platform'`.
  Website-scoped events require `websiteId`. Platform-scoped events concern a product or the platform as a whole and
  must not carry one. Each catalogued type has a fixed scope (`eventScopeOf(type)`), and `validateEvent` refuses a
  mismatch at `/scope` (rule `eventScope`). `PLATFORM_SCOPED_EVENTS` is currently `['manifest.accepted@1']`, so it is
  sent with `scope: 'platform'` and no `websiteId`. A sentinel website id is refused. JSDoc types:
  `EventEnvelope` (website), `PlatformEventEnvelope` and `AnyEventEnvelope`.
- **Catalogue additions (v1, additive):** order lifecycle events accept an optional `customer` identity reference
  `{ customerId?, subject?, email?, phone? }`; `order.completed@1` / `order.cancelled@1` also accept `number`,
  `customerId`, `currency`, `lines`, `amounts` like `order.placed@1` (`lines`/`amounts` require `currency`), and
  `order.refunded@1` richer lines and `amounts`. Element UI events `<element>.shown@1` and `<element>.action@1`
  (`ELEMENT_EVENT_DATA`) and `loader.element_failed@1` (with `phase`) are catalogued. Problem codes `identity_required`
  and `identity_invalid` are standard.
- **Identity section** (bring-your-own identity): an entitlement document may carry `identity: { issuer, jwks (1–5
public JWKs: OKP Ed25519, EC P-256, RSA ≥ 2048; no private members), audience?, claimMap: { subject, email?,
phone? } }` (`identitySectionSchema`, rule `duplicateIdentityKey`).
- **Website section**: an entitlement document may carry `website: { timeZone?, language?, currency? }`
  (`websiteSectionSchema`, closed): an IANA time zone name (rule `timezone` checks the runtime knows it), a BCP-47
  language tag (rule `languageTag`, `isLanguageTag`) and an ISO-4217 currency. The Portal fills it from the website's
  settings in every document of the website; products use it as their default time zone, language and store currency.
- **Resource requirements**: element `requires.resources` stands on its own and gates only that element
  (`resource_missing` while a kind is not connected). Product-level `requires.resources` means **always required**:
  every subscription needs those kinds, whatever elements are enabled, so a missing one disables every element. List a
  kind at product level only when every element needs it. The kinds a product may resolve are the union of both
  levels. Rule `undeclaredResource` (element kinds had to be repeated at product level) is retired and never reported.
- **Catalog events** (website-scoped, additive v1): `item.created@1` (`itemId`, `title` required), `item.updated@1`
  (`itemId` required, optional `changed[]`) carry an item snapshot `{ itemId, title, status?, brand?, collections?
(ids/handles), attributes? (≤ 50 scalar or scalar-array values), currency?, variants?: [{ variantId, price, sku?,
title?, attributes?, compareAtPrice?, cost?, inventory? }] }`: variant amounts are integer minor units in the item's
  one `currency`, required with `variants` (no per-variant currency). `item.deleted@1` is `{ itemId, reason? }`.
  `inventory.changed@1` gains optional `sku`, `available`, `previousAvailable` (sellable = on hand − reserved;
  `quantity`/`previousQuantity` stay on hand) and `reason`; `price.changed@1` gains optional `sku`, `compareAtPrice`,
  `previousCompareAtPrice` (money objects) and `reason` (`reason` is a snake_case code such as `restock`, `sale`).
- **Key kind on delivery**: the envelope's optional `context.keyKind` (`'pk' | 'sk'`, `KEY_KINDS`) records which website
  key an event was ingested with. Only the Portal Event Hub sets it, on delivery; producers cannot set it (the Portal
  strips any value it receives). It is absent on events that did not come through a website key (product-published,
  Portal control events, imports), so consumers treat a missing `keyKind` as "not from a website key".
- **Website-event actor rule**: events ingested with a `pk_` key may only carry actor `customer` or `anonymous`; with
  an `sk_` key any actor except `product` and `system` (those are reserved for products' own publishing and the
  Portal). The Portal refuses others (`actor_not_allowed`); `actorAllowedForKeyKind(kind, actorType)` /
  `WEBSITE_KEY_ACTORS` state the rule.
- **Element packs** have no endpoints or admin launch, only modes A/B, no `api.resources`, and only `graph.*` /
  `events.publish:*` scopes; their state goes through the Website Graph. Service products need `endpoints.base`,
  `register` and `events`.
- **Money** is integer minor units + ISO-4217 code. Several amounts sharing a context (cart, order) use one `currency` and
  integer `*Amount` fields; standalone values use `{ amount, currency }`.
- **Time** is ISO-8601 UTC with `Z`; durations are ISO-8601 (`P365D`, `PT24H`); time zones are IANA names.
- **Ids** are opaque strings; platform ids are `<prefix>_<26 lowercase Crockford base32 chars>`.
- **Domains** are stored normalised (lowercase ASCII/punycode, no scheme/port/path/trailing dot).

## Versioning

Additive only within v1: new optional properties, new enum values only where consumers must already tolerate unknowns,
new schemas, new problem codes. Objects are closed (`additionalProperties: false`), so validators (the Portal) upgrade before
producers emit new fields. Anything else is breaking and ships as `urn:ss:contracts:v2:*` alongside v1.
