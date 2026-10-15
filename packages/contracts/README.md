# @ss/contracts

Versioned JSON Schemas (2020-12) and validators that bind the Portal and every product (PLAN.md Part 0: 0.4.9,
0.4.11, 0.4.12, 0.4.13): the product manifest and its settings schemas, the Product ↔ Portal wire shapes,
business.json, the cross-product data-rights and activity shapes, the website Setup sheet, ids and RFC 9457 problems. Pure, functional ESM; the
only dependencies are `ajv` and `ajv-formats`.

## Results

Every validator returns `{ ok: true, value }` or `{ ok: false, problems: [{ path, message, keyword }] }`. `path` is a
JSON Pointer; `keyword` is the failing schema keyword or a semantic rule id (for example `recommendRule`). The named
functions share one lazily created validator.

## Manifest

```js
import { validateManifest, manifestPriceList } from '@ss/contracts';

const result = validateManifest(json);
const prices = manifestPriceList(json); // { version: 1, features: [{ key, name, description, dependsOn, millicreditsPerHour: 0 }] }
```

`manifest.json` has exactly `id`, `name`, `version` (semver), `endpoints: { base, dashboard }`, `widgetScriptUrl`
(or `null`), optionally `widgetScriptLoading` (`async`, the default, or `blocking` for a script that must run in page
order; only with a widget script), `docsUrl`, `features: [{ key, name, description, dependsOn, settings, recommendFor? }]`,
`permissions: [{ key, name, feature }]` and `widgets: [{ key, feature, kind: 'visitor' | 'admin' }]` (a widget's
`feature` is one key or a list of keys, any of which turns it on). Rules:

- `id` matches `^[a-z][a-z0-9-]{1,30}$`.
- Feature keys `^[a-z][a-z0-9_]{0,39}$`, unique; `dependsOn` keys exist, no self-dependency, no cycles.
- Permission keys `^[a-z][a-z0-9_.]{0,63}$`, unique, and their feature exists. Widget keys unique, feature exists.
- `widgetScriptUrl` is `null` exactly when there are no widgets.
- `endpoints.base` is an https URL (http only on `localhost`, `*.localhost`, `127.0.0.1`, `[::1]`);
  `endpoints.dashboard`, `docsUrl` and `widgetScriptUrl` are a path (`/docs`) or such a URL.
- Every feature's `settings` is a valid settings schema (below), defaults included.
- `recommendFor` (optional, at most 20 rules, each once): the business profile answers the feature suits, for the
  Setup sheet's advisor (below). A rule is one to four tags joined by `+` (all must hold), each a tag of
  `@ss/contracts/profile` (`recommendRule` otherwise), for example `["pays.cod"]` or
  `["pays.online+countries.za"]`.

## Settings schemas

A feature's settings are `{ type: 'object', properties: { <setting>: <node> }, additionalProperties?: false }`. Each
setting has `type` (`string`, `integer`, `number`, `boolean`, `array`), `title` and `default`, and may add
`description`, `minimum` / `maximum` (the hard maximums of limits), `maxLength`, `enum`, `format` (`email`, `uri` or
`hostname`), `items` (lists, item `type` plus `minimum`, `maximum`, `maxLength`, `enum`, `format`) and `x-ui` (`widget`,
`group`, `placeholder`, `labels`: `country` shows ISO country codes by name, or a map of each choice to its own words
(labels are data, never made from a code; it names only choices), `suggestions`: values a text or a list of texts
without choices offers while the merchant may type their own, `wide`: spans the whole row of the form or, `false`,
keeps a list or long text in one cell). Keywords must fit the type, lists need `items`, defaults and enum values must
be valid (`settingLabels` for a label of no choice or suggestions where they do not fit).

- `checkSettingsSchema(schema)` → problems (empty when valid).
- `validateSettingValue(schema, key, value)` → result for one value; unknown keys are refused.

## Product ↔ Portal shapes (0.4.12)

| Validator                | Shape                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `validatePriceReport`    | `{ version ≥ 1, features: [{ key, name, description, dependsOn, millicreditsPerHour integer ≥ 0 }] }`, unique keys, deps exist |
| `validateFeatureReport`  | `{ version ≥ 1, on: unique feature keys, adminId, adminName }`                                                                 |
| `validateStatusResponse` | `{ websiteId, merchantId, merchantName, domain, status, graceEndsAt, todayMillicredits, featuresVersion, validUntil }`         |
| `validateWebsitesPage`   | `{ items: [{ websiteId, domain, merchantId, merchantName, status }], cursor: string \| null }`                                 |
| `validateRevocations`    | `{ tokenIds: string[], cursor: string \| null }`                                                                               |
| `validateDirectory`      | `{ baseUrl }` (https, or http on a local host)                                                                                 |
| `validateDirectoryList`  | `{ items: [{ productId, name, baseUrl }] }`: every connected product once, by id                                               |

Times are ISO-8601 UTC strings (`Z`) and must be real instants; `graceEndsAt` is set exactly while the status is
`grace`. Money is integer millicredits. Notice bodies are checked by `@ss/protocol` (`verifyNotice`).

Vocabularies: `ADMIN_ROLES` (`owner`, `support`, `finance`) and `PRODUCT_UNAVAILABLE_REASONS` (`stopped`, `suspended`,
`removed`: the `reason` of a `product_unavailable` problem).

## business.json (0.4.9)

`validateBusinessJson(value)` returns the normalized `{ name, logo, email, phone, address, country, timeZone, currency,
currencies, language }`. Only `name` is required (a missing or invalid name fails the whole file); any other invalid
field becomes `null` (`currencies`: `[]`). `logo` must be an https URL, `country` an ISO 3166-1 alpha-2 code (returned
upper-case), `timeZone` an IANA name the runtime knows (returned in canonical form), `currency` the store currency
(ISO 4217, upper-case), `currencies` the currencies the business takes (the store currency first, each once, at most
`MAX_CURRENCIES` 20; codes that are not currencies are dropped) and `language` the default language (a canonical BCP
47 tag). `BUSINESS_JSON_TEMPLATE` is the example every product's docs ship.

## Cross-product shapes (0.4.11)

- `validateDataRightsRequest`: `{ user: { id?, email?, phone? } }` with at least one member. Answers: export
  `{ records }`, delete `{ deleted, anonymised }`.
- `validateActivityCopy`: `{ websiteId, productId, actor: { kind, id, name?, role? }, action, target, label?, detail?, at }`
  (`label` at most 200 characters, `detail` at most 2,000 plain-text characters; PLAN 0.8.10 K9).
- `IMPORT_LIMITS`: one call of a product's import route takes NDJSON of at most 1,000 records and 4 MB (K10).
- `validateMessageDefaults`: a product's message defaults (its `schemas/messages.json`; the kit serves them at
  `GET /v1/message-defaults` with `productId`): `{ productId?, messages }`, at most 200 messages, each
  `{ key, name, description?, values, longValues?, required?, urgent?, sensitive?, channels }`. `longValues` names the
  values that hold long text (for example a chat transcript; up to 50,000 characters each). `channels` names every
  channel the message is sent on with its US-English default words: `email`, `push` and `staff_push`
  `{ subject, text }`, `sms` `{ text }`, and `whatsapp: null` (WhatsApp sends only templates the merchant had approved
  at Meta, so it has no default). Keys are declared once and start with the product's id; the words follow the
  template rules below as written (no spaces at their ends) and use only the message's `values`, plus
  `{unsubscribeUrl}` in a message that is not required; each long value is one of the `values` and used in no subject
  or title.

## Website Setup sheet (`ss.blueprint/1`)

One sheet per website: every product's features, settings, connections state, widgets,
permissions, events, checklist and docs, generated on request and never stored.

- `validateProductBlueprint`: a product's part, answered by `@ss/app-kit` at `GET /v1/blueprint?websiteId=` (a signed
  Portal call): `{ productId, name, version, status, docs: { guide, openapi }, business, install, features, shared,
connections, widgets, staffPermissions, events, checklist, summaries, build }`. Features carry their `recommendFor`
  rules and their settings `{ key, title, value, default }` (`default: true` while the website has not saved its own
  value; a value holding a secret saved in the website's Connections is never shown: `set: true` instead of `value`)
  and their lists `{ name, title, summary, count }` only while the feature is on. Connections are `{ key, title,
kind, neededBy, needed, set, state, testedAt }`: never a value, its last characters or a test message (the schema
  refuses them). `build: [{ feature, what, docs }]`: what the merchant's website builds for each feature that is on
  (at most `BUILD_TEXT_MAX` characters) and the guide's section of it.
- `validateBlueprint`: the Portal's sheet `{ schema: 'ss.blueprint/1' (BLUEPRINT_SCHEMA), generatedAt, website: { id,
domain, status, business, profile }, access: { allowedOrigins, testingOrigins, serverTokens }, products, share? }`.
  `status` is the status of the website's products (`active`, `grace`, `stopped`, `suspended`); `profile` the website's
  business profile (or `null`). A product is its blueprint plus `reachable: true`, `apiBase` (its address, before the
  API paths), `serverToken:
{ issued }` (the token itself is never in a sheet), in `install` the public browser token and the install snippet,
  and the advisor's view: `recommended: [{ feature, on, because, why }]` (features the profile calls for, `because`
  the tags of the rule that holds) and `notRecommended: [{ feature, missing, why }]` (features that are on although
  the profile rules them out). One that did not answer in time is `{ productId, name, reachable: false, reason }`
  (`timeout`, `unreachable`, `refused`, `invalid`). A copy opened from a share link
  has `share: { expiresAt, values, install }`: without values every setting's `value` is left out, without install
  the browser token and snippet.

## Business profile and recommendations (`@ss/contracts/profile`, browser-safe)

A website's business profile is a few optional answers kept by the Portal: what it sells, how shoppers pay, how
orders reach them, how shoppers sign in, who answers the chat, how it messages customers, marketing, what it offers
shoppers (`PROFILE_CHOICES`, each a list of options; `none` stands alone), the merchant's own answers where the
options cannot list everything (`other: { <question>: [text] }` for the questions of `PROFILE_OTHER`, at most
`OTHER_MAX.answers` of at most `OTHER_MAX.length` characters, each once), whether it is moving from another website or
system and whether it charges tax at checkout (`moving`, `taxes`, yes or no), and its countries (ISO 3166-1 alpha-2,
capitals) and languages (ISO 639, two or three small letters). `validateBusinessProfile(value)` checks it
(`profileAnswer` for `none` with other options or own answers, and an own answer twice; `PROFILE_NONE` is that option).

A profile's tags are `<question>.<option>` (`pays.cod`, `moving.yes`, `countries.us`, `languages.fr`),
`<question>.other` for own answers, `<question>.many` for two countries or languages or more, and `countries.<region>`
when a country of a region is answered (`PROFILE_REGIONS`: `eea`, the European Economic Area with the UK and
Switzerland, where tracking needs consent); a rule's `<choice>.*` holds for any option but `none`, own answers
included. A rule names the answer that asks for the feature (`offers.coupons` for coupon codes, `delivers.courier_api`
for courier booking, `taxes.yes` for tax rules), never a broad one that does not, so the advisor recommends only what
the profile asks for. A feature is `recommended` (with the tags of the first rule that holds), `ruled_out` (every rule
fails on a question the profile answered; `missing` one tag per rule) or `neutral` (no rules, or an open question could
still make a rule hold): `adviseFeatures(features, profile)` → `{ recommended, notRecommended }` for a product's
features (`notRecommended`: ruled out and on). The root entry has `PROFILE_CHOICES`, `adviseFeatures` and
`validateBusinessProfile` for servers; `@ss/contracts/profile` has the whole vocabulary and `adviseFeatures` for the
browser.

## Message templates (`@ss/contracts/templates`)

Pure and browser-safe; Notifications checks every template with it, and `validateMessageDefaults` checks products'
defaults with the same rules.

- `TEMPLATE_CHANNELS` (`email`, `sms`, `whatsapp`, `push`, `staff_push`), `TEMPLATE_KEY`, `VALUE_NAME`, `TEXT_LIMITS`
  (email 100,000, SMS 1,600, WhatsApp 4,096, push 500 characters), `SUBJECT_LIMIT` (200), `BUILT_IN_VALUES`
  (`unsubscribeUrl`), `isTitled(channel)`.
- The values of a send: at most `MAX_VALUES` (50), each at most `VALUE_LIMIT` (1,000) characters, `VALUES_TOTAL_LIMIT`
  (100,000) in all; a value the product declares long (`longValues`) holds up to `LONG_VALUE_LIMIT` (50,000). Email
  sends a long value whole; Notifications cuts it to fit a channel with a shorter limit.
  `longValueProblem(part, longValues)`: a subject, title or WhatsApp button using a long value (null when fine).
- `placeholdersOf(text)` and `valueNamesOf(text)` (placeholders and optional-section names, in order of first use),
  `sectionProblem(text)` (`{?name}…{/name}` closed, not crossing, not inside one of the same name) and
  `wordsProblem(channel, { subject, text })` (the text written and within the channel's limit, a subject on email and
  push, one line of at most 200 characters, sections well formed), each null when fine.

## Format and time zone (`@ss/contracts/format`, PLAN 0.8.10 K7, K8)

Pure and browser-safe, so products' `core/` and widgets (through `@ss/app-kit/widget`) use the same code.

- `DEFAULT_FORMAT` `{ locale: '', currencyDisplay: 'code', currencySymbols: {}, wholeUnits: false, times: 'viewer' }`,
  `FORMAT_FIELDS`, `formatViolation(field, value)`, `normaliseFormat(value)`. `currencySymbols` is the merchant's own
  symbol per currency (`{ PKR: 'Rs', CHF: 'Fr.' }`, at most 20, each 1 to 8 characters): one currency's symbol never
  replaces another's.
- `formatMoney(amount, currency, format?, viewer?)`: integer minor units (ISO 4217 exponents, `currencyDigits`) as
  `USD 12,500.00` (code), `$12,500.00` (symbol), the currency's own symbol in the code's place (`Rs 12,500.00`), or
  without minor units (`wholeUnits`). The locale is
  the Format's, else the viewer's (widgets), else `en-US` (US English).
- `formatDate(value, format?, { timeZone, style: 'date' | 'datetime' | 'time', viewer })`: `Mar 12, 2026`,
  `Mar 12, 2026, 7:30 PM` or `7:30 PM` in `en-US`; text the server makes (`viewer` null) uses the business time zone;
  widgets use the viewer's unless `times` is `business`.
- `zonedParts(at, timeZone)`, `zonedDay(at, timeZone)` (`YYYY-MM-DD`) and `zonedDayStart(day, timeZone)` (epoch ms):
  every calendar rule in the business.json time zone, UTC when missing.
- Money checks (on this path only): `currencyDigits(currency)` (ISO 4217 minor units), `MAX_AMOUNT` (10^12 minor
  units, so sums stay exact), `isCurrency(value)` (three capital letters), `isAmount(value)` (a whole number 0 to
  `MAX_AMOUNT`), `isPositiveAmount(value)` (1 to `MAX_AMOUNT`), `toDecimal(amount, currency)` (plain decimal text with
  the currency's digits, no grouping: `1050 USD` → `10.50`, `-5 USD` → `-0.05`) and `fromDecimal(text, currency)`
  (`10.5` → `1050`; null unless 1 to `MAX_AMOUNT` minor units with at most the currency's decimals).

## Phone numbers (`@ss/contracts/phone`)

Pure and browser-safe; every product normalizes phones with it, so one person has one number everywhere.

- `normalisePhone(input, defaultCallingCode | { defaultCallingCode, trunkPrefix })` → E.164 or null. Spaces, dashes,
  dots, slashes and brackets are dropped; `+` or `00` name the calling code (any assigned code, +800 and +882 too);
  after it a trunk `0` (also `(0)`) is dropped, except where national numbers keep their 0 (Italy, San Marino, Côte
  d'Ivoire, Benin, Gabon, Congo). A number without `+`/`00` needs the default calling code and is read as already
  international (`447700900123`), national after its trunk prefix (`0`; `8` for +7; or `trunkPrefix`) or national as
  typed; the country's usual national lengths, where listed, pick the reading, else the digits are kept as typed (no
  second code). Any reading of 8–15 digits is accepted: the lengths never refuse a number.
- `websiteCallingCode(setting, country)`: the website's default calling code, its setting else the calling code of its
  business.json `country`; `callingCodeOf(country)`.
- `PHONE_COUNTRIES` (ISO codes a setting may name) and `phoneInCountries(phone, countries)` (`[]` = any).
- `nationalNumberOf(phone)`: the national significant number of an E.164 number (its digits after the calling code),
  or null; products search numbers by its end, never by a fixed count of last digits.

## CSV (`@ss/contracts/csv`)

Pure and browser-safe; every export and import (RFC 4180) uses it.

- `toCsv(header, rows, { delimiter? })`: a UTF-8 byte order mark, then CRLF records; cells with the delimiter, `"`,
  CR or LF quoted. Text starting with `=`, `+`, `-`, `@`, TAB or CR (after any leading `'`) gets one more `'` so
  spreadsheets never run it as a formula; numbers are written as numbers (`-12.5`, never guarded; not finite → ''),
  booleans as `true` / `false`, null and undefined as ''. `csvCell(value, delimiter?)` writes one cell the same way.
- `parseCsv(input, { delimiter?, maxRows? })` → `{ ok: true, rows }` or `{ ok: false, code }` (`empty`,
  `unterminated_quote`, `too_many_rows`; `maxRows` counts records after the header). Without `delimiter` it takes
  the one the first line holds most of (comma, semicolon or tab). Quoted cells, doubled quotes, line breaks, CRLF, LF
  or CR, a byte order mark and blank lines are handled, and the formula guard is undone: a round trip gives back every
  text as written.
- `csvRecords(rows)` → `{ header, records: [{ line, values }] }`: names trimmed and in lower case (first column of a
  repeated name wins, empty names skipped), values trimmed, `line` counted from the header (line 1).

## Email addresses (`@ss/contracts/email`)

Pure and browser-safe; every product and the Portal check addresses with it, so an address one accepts is never
refused by another.

- `normalizeEmail(input)` → the stored form or null. The local part is an ASCII dot-atom (no dot first, last or
  doubled; plus-addressing kept; quoted and non-ASCII local parts refused, as they need SMTPUTF8) of at most 64
  characters; the domain has 2 or more labels of letters, digits and hyphens and a top-level label of 2 or more
  characters that is not all digits (`ana@example.xn--p1ai` yes; IP addresses, domain literals and single-label names
  no). A domain typed in Unicode is stored as punycode (`ana@bücher.de` → `ana@xn--bcher-kva.de`). The stored form is
  trimmed, entirely in lower case (local part too: one person, one record) and at most 254 characters.
- `isEmailAddress(value)`: true for an address already in its stored form (check stored and received values before
  sending; check what people type with `normalizeEmail`).

## Text (`@ss/contracts/text`)

Pure and browser-safe; servers, products' `core/` and widget bundles share it.

- `escapeHtml(value)`: text safe in an HTML or XML element and in a quoted attribute (`&`, `<`, `>`, `"`, `'` as
  `&#38;`, `&#60;`, `&#62;`, `&#34;`, `&#39;`); null and undefined become ''.
- `decodeEntities(text)`: decimal, hexadecimal and named character references decoded (the Latin-1 names and usual
  punctuation such as `&rsquo;`, `&hellip;`, `&euro;`; case-sensitive; `&nbsp;` is U+00A0). A reference needs its `;`
  and an unknown name stays as written; 0, surrogates and code points past U+10FFFF become U+FFFD, and U+0080–U+009F
  are read as windows-1252, as HTML reads them.
- `widgetScriptTag({ src, token?, loading? })`: the install snippet `<script src="…" data-token="…" async></script>`,
  attribute values escaped; no `data-token` when `token` is null or left out, no `async` when `loading` is `blocking`
  (the manifest's `widgetScriptLoading`; default `async`).
- `pathMatches(pattern, path)`: the one path pattern rule ("hide on pages", page rules). A pattern is a path from `/`
  (else it matches nothing; `/` is the home page); `**` as a whole segment is any number of segments, none included;
  `*` elsewhere is any characters inside one segment (`/shop/*`, `/sale-*`); the rest matches itself,
  case-sensitively. Queries, fragments, empty segments and trailing slashes are ignored, and segments are compared
  decoded (`/café` matches `/caf%C3%A9`).
- `luhnValid(digits)`: true for a string of at least 2 ASCII digits whose last digit is its Luhn check digit (cards,
  IMEIs); callers add their own length rules.

## Value helpers (`@ss/contracts/util`)

Pure and browser-safe.

- `isObject(value)`: true for an object that is neither null nor an array.
- `deepFreeze(value)`: the value frozen all the way down (same reference); safe on values that refer to themselves;
  typed arrays and other buffer views are left as they are (they cannot be frozen).

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

`createId(prefix)` → `<prefix>_<26 lowercase Crockford base32 chars>` (128 random bits; the prefix is 2–8 lower-case
letters naming the kind, such as `web`, `mer` or `req`); `isId(value, prefix?)` checks one. `PATTERNS` holds the
patterns of the schemas (product ids, feature, permission, widget and setting keys, versions, times, countries,
host names) for code that checks the same values.
`normaliseDomain(input, { allowLocal?, isPublicSuffix? })` returns `{ ok, value }` or `{ ok: false, code, message }`:
lower-case punycode, no scheme, port, path or trailing dot; IP literals, `localhost` and single-label names refused.

## Testing entry

`@ss/contracts/testing` returns fresh fixtures: `manifest()` (product `notes`: two features with a dependency, a
permission, a visitor and an admin widget) and `productBlueprint()` (its Setup sheet part).

## Versioning

Additive only within v1: new optional members, new schemas, new problem codes. Objects are closed
(`additionalProperties: false`), so validators upgrade before producers send new members. Anything else ships as
`urn:ss:contracts:v2:*` alongside v1.
