# @ss/contracts

Versioned JSON Schemas (2020-12) and validators that bind the Portal and every product (PLAN.md Part 0: 0.4.9,
0.4.11, 0.4.12, 0.4.13): the product manifest and its settings schemas, the Product ↔ Portal wire shapes,
business.json, the cross-product data-rights and activity shapes, ids and RFC 9457 problems. Pure, functional ESM; the
only dependencies are `ajv` and `ajv-formats`.

## Results

Every validator returns `{ ok: true, value }` or `{ ok: false, problems: [{ path, message, keyword }] }`. `path` is a
JSON Pointer; `keyword` is the failing schema keyword or a semantic rule id from `RULES`. The named functions use one
lazily created validator; `createValidator({ schemas })` makes another with extra schemas (each with a string `$id`)
that may `$ref` the common definitions (`urn:ss:contracts:v1:common#/$defs/<name>`).

## Manifest

```js
import { validateManifest, manifestPriceList } from '@ss/contracts';

const result = validateManifest(json);
const prices = manifestPriceList(json); // { version: 1, features: [{ key, name, description, dependsOn, millicreditsPerHour: 0 }] }
```

`manifest.json` has exactly `id`, `name`, `version` (semver), `endpoints: { base, dashboard }`, `widgetScriptUrl`
(or `null`), `docsUrl`, `features: [{ key, name, description, dependsOn, settings }]`,
`permissions: [{ key, name, feature }]` and `widgets: [{ key, feature, kind: 'visitor' | 'admin' }]`. Rules:

- `id` matches `^[a-z][a-z0-9-]{1,30}$` (the six products are `PRODUCT_IDS`).
- Feature keys `^[a-z][a-z0-9_]{0,39}$`, unique; `dependsOn` keys exist, no self-dependency, no cycles.
- Permission keys `^[a-z][a-z0-9_.]{0,63}$`, unique, and their feature exists. Widget keys unique, feature exists.
- `widgetScriptUrl` is `null` exactly when there are no widgets.
- `endpoints.base` is an https URL (http only on `localhost`, `*.localhost`, `127.0.0.1`, `[::1]`);
  `endpoints.dashboard`, `docsUrl` and `widgetScriptUrl` are a path (`/docs`) or such a URL.
- Every feature's `settings` is a valid settings schema (below), defaults included.

## Settings schemas

A feature's settings are `{ type: 'object', properties: { <setting>: <node> }, additionalProperties?: false }`. Each
setting has `type` (`string`, `integer`, `number`, `boolean`, `array`), `title` and `default`, and may add
`description`, `minimum` / `maximum` (the hard maximums of limits), `maxLength`, `enum`, `format`, `items` (lists, item
`type` plus `minimum`, `maximum`, `maxLength`, `enum`, `format`) and `x-ui` (`widget`, `group`, `order`, `help`,
`placeholder`). Keywords must fit the type, lists need `items`, defaults and enum values must be valid.

- `checkSettingsSchema(schema)` → problems (empty when valid).
- `validateSettingValue(schema, key, value)` → result for one value; unknown keys are refused.
- `validateSettings(schema, values)` → result for an object holding any subset of the settings.

## Product ↔ Portal shapes (0.4.12)

| Validator                | Shape                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `validatePriceReport`    | `{ version ≥ 1, features: [{ key, name, description, dependsOn, millicreditsPerHour integer ≥ 0 }] }`, unique keys, deps exist |
| `validateFeatureReport`  | `{ version ≥ 1, on: unique feature keys, adminId, adminName }`                                                                 |
| `validateStatusResponse` | `{ websiteId, merchantId, merchantName, domain, status, graceEndsAt, todayMillicredits, featuresVersion, validUntil }`         |
| `validateWebsitesPage`   | `{ items: [{ websiteId, domain, merchantId, merchantName, status }], cursor: string \| null }`                                 |
| `validateRevocations`    | `{ tokenIds: string[], cursor: string \| null }`                                                                               |
| `validateDirectory`      | `{ baseUrl }` (https, or http on a local host)                                                                                 |
| `validateNotice`         | `{ type, websiteId }` for `status.changed`, `token.revoked`, `website.deleted`; `{ type, subject }` for `sessions.revoked`     |

Times are ISO-8601 UTC strings (`Z`) and must be real instants; `graceEndsAt` is set exactly while the status is
`grace`. Money is integer millicredits.

Vocabularies: `PRODUCT_STATUSES` (`active`, `grace`, `stopped`, `suspended`, `removed`), `MERCHANT_STATUSES`
(`active`, `low_balance`, `grace`, `stopped`, `suspended`), `ADMIN_ROLES` (`owner`, `support`, `finance`),
`DASHBOARD_ROLES` (`owner`, `support`), `NOTICE_TYPES`, `PRODUCT_IDS`, `PRODUCT_UNAVAILABLE_REASONS`.

## business.json (0.4.9)

`validateBusinessJson(value)` returns the normalised `{ name, logo, email, phone, address, country, timeZone }`. Only
`name` is required (a missing or invalid name fails the whole file); any other invalid field becomes `null`. `logo`
must be an https URL, `country` an ISO 3166-1 alpha-2 code (returned upper-case), `timeZone` an IANA name the runtime
knows (returned in canonical form). `BUSINESS_JSON_TEMPLATE` is the example every product's docs ship.

## Cross-product shapes (0.4.11, provisional)

- `validateDataRightsRequest`: `{ user: { id?, email?, phone? } }` with at least one member. Answers: export
  `{ records }`, delete `{ deleted, anonymised }` (types `DataRightsExport`, `DataRightsDelete`).
- `validateActivityCopy`: `{ websiteId, productId, actor: { kind, id, name?, role? }, action, target, label?, detail?, at }`
  (`label` at most 200 characters, `detail` at most 2,000 plain-text characters; PLAN 0.8.10 K9).
- `IMPORT_LIMITS`: one call of a product's import route takes NDJSON of at most 1,000 records and 4 MB (K10).

## Format and time zone (`@ss/contracts/format`, PLAN 0.8.10 K7, K8)

Pure and browser-safe, so products' `core/` and widgets (through `@ss/app-kit/widget`) use the same code.

- `DEFAULT_FORMAT` `{ locale: '', currencyDisplay: 'code', currencySymbol: '', wholeUnits: false, times: 'viewer' }`,
  `FORMAT_FIELDS`, `formatViolation(field, value)`, `normaliseFormat(value)`.
- `formatMoney(amount, currency, format?, viewer?)`: integer minor units (ISO 4217 exponents, `currencyDigits`) as
  `PKR 12,500.00` (code), `Rs 12,500.00` (symbol), a custom symbol, or without minor units (`wholeUnits`). The locale is
  the Format's, else the viewer's (widgets), else `en`.
- `formatDate(value, format?, { timeZone, style: 'date' | 'datetime' | 'time', viewer })`: text the server makes
  (`viewer` null) uses the business time zone; widgets use the viewer's unless `times` is `business`.
- `zonedParts(at, timeZone)`, `zonedDay(at, timeZone)` (`YYYY-MM-DD`) and `zonedDayStart(day, timeZone)` (epoch ms):
  every calendar rule in the business.json time zone, UTC when missing.

## Problems (RFC 9457)

```js
import { createProblemFactory } from '@ss/contracts';

const problems = createProblemFactory({ baseUri: 'https://errors.example.dev' });
problems.create('feature_off', { detail: 'Notes is off' });
problems.create('product_unavailable', { reason: 'stopped' }); // reason: stopped | suspended | removed
problems.fromValidation(result.problems, { code: 'invalid_manifest' });
```

Codes include `invalid_token` (401), `product_unavailable` (403, with `reason`), `feature_off` (403),
`database_not_connected` (403), `website_not_found` (404), `portal_unreachable` (503) and the generic HTTP ones
(`PROBLEM_CODES`). Products may add their own codes with `createProblemFactory({ baseUri, codes })`.

## Ids and domains

`createId(prefix)` → `<prefix>_<26 lowercase Crockford base32 chars>` (128 random bits); `ID_PREFIXES` lists the
Portal's (`web`, `mer`, `adm`, `req`). `isId`, `parseId`. `normaliseDomain(input, { allowLocal?, isPublicSuffix? })`
returns `{ ok, value }` or `{ ok: false, code, message }`: lower-case punycode, no scheme, port, path or trailing dot;
IP literals, `localhost` and single-label names refused. `hostMatchesDomain(host, domain)` compares exactly.

## Testing entry

`@ss/contracts/testing` returns fresh fixtures: `manifest()` (product `notes`: two features with a dependency, a
permission, a visitor and an admin widget), `priceReport()`, `statusResponse()`, `businessJson()`, plus the ids
`WEBSITE` and `MERCHANT`.

## Versioning

Additive only within v1: new optional members, new schemas, new problem codes. Objects are closed
(`additionalProperties: false`), so validators upgrade before producers send new members. Anything else ships as
`urn:ss:contracts:v2:*` alongside v1.
