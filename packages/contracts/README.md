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
- **Events**: every consumed type needs an `events.subscribe:<glob>` scope; published types must be in the product namespace
  (`<slug>.*`, `-` → `_`) or be standard events covered by an `events.publish:<glob>` scope.
- **Event scopes**: the envelope has an optional `scope`, either `'website'` (the default) or `'platform'`.
  Website-scoped events require `websiteId`. Platform-scoped events concern a product or the platform as a whole and
  must not carry one. Each catalogued type has a fixed scope (`eventScopeOf(type)`), and `validateEvent` refuses a
  mismatch at `/scope` (rule `eventScope`). `PLATFORM_SCOPED_EVENTS` is currently `['manifest.accepted@1']`, so it is
  sent with `scope: 'platform'` and no `websiteId`. A sentinel website id is refused. JSDoc types:
  `EventEnvelope` (website), `PlatformEventEnvelope` and `AnyEventEnvelope`.
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
