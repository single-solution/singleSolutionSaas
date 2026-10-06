# Module interfaces (binding for the M2 module wave)

Modules call each other only through `ctx.service(name)`. These are the public service functions each module MUST
expose (extra functions allowed). All functions are async, take plain objects, return plain objects, and throw
`ctx.problems` problems on failure. Ids use `@ss/contracts` `createId` prefixes.

## identity (`modules/identity`)

Merchants, merchant users, staff users, partners, developers, sessions, websites, website keys.

- `getMerchant(merchantId)` → `{ merchantId, name, status: active|suspended, createdAt }`
- `getWebsite(websiteId)` → `{ websiteId, merchantId, domain, env: 'live'|'test', twinId, status, timeZone, language,
currency, createdAt }` — the **website settings** (F.16) are `null` when unset: `timeZone` (IANA, checked with `Intl`,
  canonical spelling), `language` (BCP 47, `Intl.getCanonicalLocales`), `currency` (ISO 4217, upper case).
  `updateWebsiteSettings({ merchantId, websiteId, settings, actor })` sets them on the live/test pair (`null` clears),
  audits `website.settings_updated` and calls `commerce.invalidateWebsite` for both ids. Route:
  `PATCH /v1/merchants/:merchantId/websites/:websiteId` (`websites.write`; staff via the Admin Console).
- `listWebsites(merchantId)`
- `websiteByDomain(domain)` (normalised via `@ss/contracts` `normaliseDomain`)
- `suspendMerchant / resumeMerchant` (emit audit; commerce reacts via `onMerchantStatus` hook below)
- Website keys: `issueKey({ websiteId, kind: 'pk'|'sk', scopes?, expiresAt? })` → `{ keyId, key }` (shown once),
  `revokeKey({ keyId, reason })`, `revocationsSince(cursor)` → `{ keyIds, cursor }`.
- **Key scope vocabulary** (F.16, `core/scopes.js`), checked on every issue (422 `validation_failed`, `/scopes/<i>`):
  `elements.read` (element views and read routes; the Loader's key), `events.write` (Event Hub), and per listed
  service product `<slug>.read` / `<slug>.write` (from `catalog.activeProducts({ kind: 'service' })`); `<group>.*`
  grants a whole group (`events.*`, `<slug>.*`; products match it as a prefix). Empty or omitted scopes = the defaults
  `['elements.read', 'events.write']`. `GET /v1/merchants/:merchantId/websites/:websiteId/keys/scopes` →
  `{ defaults, items: [{ scope, group, label, description, product? }] }` (the console key form: one checkbox group
  per product).
- Website keys are signed with a **dedicated website-key signing key** (generated on first start, `infra/system.js`), not the launch key.
- **Staff API tokens** (F.18): `POST /v1/admin/api-tokens` (`platform.apps.manage`, `{ minutes: 5..720, label? }`) →
  201 `{ token: 'sst_…', sessionId, expiresAt }` — a staff session flagged `api` with the member's roles and MFA
  satisfied, accepted only as `Authorization: Bearer sst_…` (no cookie, so no CSRF check; a cookie carrying it and a
  bearer carrying a browser session are refused), listed (`api: true`) and revocable under `/v1/me/sessions`; a token
  cannot mint another. Audited `staff.api_token_created`. Used by `ss pack publish`.
- Implements ports `sessionActor(session)` and `websiteKeyRevoked(claims, rawKey)` → `true` when the key is revoked,
  unknown, or (for `sk_`) its HMAC does not match `rawKey`; infra calls it after the offline signature check.
- Calls `integration.emitControl('key.revoked@1', …)` on revoke.
- Staff building blocks (`service.admin`, `service.impersonation`): `admin.listMerchants({ after, limit, status?, q? })`
  — `q` is a case/accent-insensitive prefix of the merchant name (`nameKey`), or of a member e-mail when it contains
  `@`; `admin.listNotes({ merchantId, before?, limit })` / `admin.addNote({ merchantId, body ≤ 2000, actor })`
  (append-only, audited without the body); `impersonation.start({ merchantId, userId, minutes ≤ 60, reason, actor })`
  → one-time exchange token (only its HMAC stored, bound to the staff member, 60 s), `impersonation.exchange({ token,
actor })` → merchant session with `via`, `impersonation.ended({ session })` (audited on both chains).
- **Bring-your-own customer identity** (PLAN §5.3, F.14), one issuer per website (`identity_issuers`, `_id` =
  websiteId): `setIdentityIssuer({ merchantId, websiteId, input: { issuer, jwksUrl | publicJwks[], audience?,
claimMap: { subject = 'sub', email?, phone? } }, actor })` (public signature keys only — Ed25519, P-256, RSA ≥ 2048,
  ≤ 5; a `jwksUrl` is fetched with `@ss/net` `safeFetch`, no redirects, 5 s, 64 KiB, and must yield a usable key),
  `getIdentityIssuer`, `removeIdentityIssuer`, `refreshIdentityIssuer` (fetch now). Every change is audited
  (`website.identity_*`) and calls `commerce.invalidateWebsite(websiteId)`. `identityFor(websiteId)` → the
  entitlement-document `identity` section `{ issuer, jwks, audience?, claimMap }` or null; a JWKS URL is refetched at
  most hourly when documents are rebuilt (failures keep the last good keys, retry after 5 min). Deleting or
  transferring a website drops its issuer. Routes: `GET|PUT|DELETE /v1/merchants/:merchantId/websites/:websiteId/identity`
  (`websites.read` / `websites.write`), `POST …/identity/refresh`. The GET also returns the pending product `request`.
- **Product issuer requests** (F.16, `identity_issuer_requests`, `_id` = websiteId): `PUT
/v1/product/websites/:websiteId/identity` (product auth, same body as the merchant PUT) is accepted only for a product
  with an **active subscription** on the website whose accepted manifest declares **`capabilities.identityIssuer:
true`** (else 403). A JWKS URL must yield a usable key now. The request is stored **pending** (202 `{ status:
'pending', request }`; one per website, a newer one replaces it), audited `website.identity_issuer_requested` (actor
  the product) and announced to the merchant owner (mail template `issuer_request`) and in the console (shell banner
  from `GET /v1/merchants/:merchantId/notifications` → `{ items: [{ kind: 'identity_issuer_request', websiteId,
domain, request }] }`, Website → Identity card). A request identical to the active issuer answers 200 `{ status:
'active', issuer }` (safe to repeat on every product boot). The merchant decides with `POST …/identity/request/approve`
  or `…/reject` (`websites.write`, optional `{ reason }`): approve re-checks eligibility and calls `setIssuer` with
  `managedBy: { appId, slug, name }` (shown on the issuer); both are audited (`website.identity_request_approved |
_rejected`). A merchant's own PUT clears `managedBy`. Deleting/transferring a website drops its requests.

## catalog (`modules/catalog`)

Apps (products), onboarding with the product's connect secret (Portal side), manifest versions and review, app keys,
environments, health, launches.

- Onboarding: `connectProduct({ url, secret })` (staff `POST /v1/admin/apps/connect`) → `{ appId, slug, baseUrl, kid,
reconnected }`: `@ss/protocol` `createConnectRequest` to `<url>/.well-known/ss-connect` (HMAC with the deployer's
  `CONNECT_SECRET`, never sent nor stored), `verifyConnectResponse`, manifest and base-URL checks, app + version + key
  created — or, for a known slug, the binding replaced (key replaced, base URL moved).
- `getApp(appId)` → `{ appId, slug, kind: service|pack, status: pending|active|deprecated|retired, endpoints, currentVersion }`
- `appBySlug(slug)`
- `getManifest(appId, version?)` → validated manifest (features inline)
- `activeProducts()` → catalog list for consoles
- `issueLaunch({ kind, appId, subject, user, scope, subscriptions, actor?, impersonationSeconds? })` → `{ url, token }`
  (`url` = `<product>/sso?launch=<token>`). Admin launches carry `scope.merchantId` or the app-wide `scope: { all: true }`
  (exclusive: only `permissions` may sit next to it). The staff route `POST /v1/admin/apps/:appId/launch` with
  `{ kind: 'admin', all: true }` needs `platform.launch.admin` **and** the `superadmin` or `admin` staff role (support
  staff may launch per merchant only).
- Merchant "Try demo": `POST /v1/merchants/:merchantId/apps/:appId/demo` (`subscriptions.read`, listed apps only,
  30/min) → `{ url, expiresAt }` of a `demo` launch with no merchant or website scope (the product shows its sandbox).
- Environments: `setEnvironments({ appId, production?, staging? })` (the connection records the product's base URL as
  production). Integration delivers to these registered bases, never to the manifest's self-declared `endpoints.base`.
- `refreshManifest({ appId })` imports `/.well-known/ss-app.json` only with a valid `SS-Manifest-Signature`
  (`@ss/protocol` `verifyManifest` over the app's registered, non-revoked keys, `expectedAppId = appId`, ≤ 24 h old).
  An unsigned or invalid refresh is stored as a `rejected` version with `review.reason`
  (`manifest_signature_missing | _no_keys | _malformed | _signature | _issuer | _expired | _unknown_kid | …`), audited
  as `catalog.manifest_signature_rejected` and alerted (error log `catalog alert: …`); identical repeats are not
  stored again. Returns `{ changed, version, rejected?, reason? }`.
- Implements port `appKeys(appId)` → KeyResolver of registered (non-revoked) app keys.
- Emits `manifest.accepted@1` (platform-scoped, `appIds: [appId]`) via integration on approval.

## commerce (`modules/commerce`)

Subscriptions, element switches, entitlement documents, usage, quotas, ledger (append-only, hash-chained),
credits, settlement, spend caps.

- `subscribe({ websiteId, appId, planCode? })` → subscription (requires ≥ 1 hour of credits; pins price book). A manifest
  `trialHours` is granted once per website × app at the first subscribe as an `adjustment` ledger entry
  (`entryKey trial:<websiteId>:<appId>`, worth `trialHours ×` the first hour's charge; it counts towards the one-hour
  minimum; audited `credits.trial_granted`).
- `getSubscription(subscriptionId)`, `subscriptionsForWebsite(websiteId)`
- `setElement({ subscriptionId, elementKey, enabled, actor })`
- `pause / resume / cancel({ subscriptionId, reason, actor })`
- `documentFor({ websiteId, appId })` → compact JWS (signed by Portal signer, cached until content hash changes)
- `recordUsage({ appId, records })` → `{ results }` (F.9)
- `addCredits({ merchantId, amountMillicredits, reference, note, actor })`, `adjust`, `refund`
- `balance(merchantId)`, `meter(merchantId)` — both settle the merchant's due complete hours first (lazy settlement:
  `runSettlement({ merchantId })`, 2 s budget, idempotent per `periodKey`; a failure never fails the read)
- `statement(merchantId, { from, to, websiteId? })`
- `invalidate(subscriptionId)`, `invalidateWebsite(websiteId)`, `invalidateApp(appId)` (re-resolve and re-sign the
  documents of every live subscription of an app, e.g. after a manifest is accepted) → `{ invalidated }`
- `previewDocument({ subscriptionId, layers })` → the canonical, unsigned document the subscription would get with
  `layers` (config dry runs; nothing stored or emitted)
- Settlement on read (F.19, no cron): `settleDue(merchantId)` runs before balance, meter and statement reads, product
  document fetches (`documentFor`), subscription changes, and right after a product's usage batch; admin operations
  `settlement` and `reconciliation` run on demand.
- Reads configuration layers from `config.layersFor(subscriptionId)`; resource status from
  `connectors.statusFor(websiteId)`; the website's identity issuer from `identity.identityFor(websiteId)` (document
  `identity` section; it extends the content hash, so an issuer change or key rotation bumps the version) and the
  website settings as the document **`website` section** `{ timeZone?, language?, currency? }` (only set values;
  omitted when none; also in the content hash — F.16).
- **Resources** (F.16): product-level `requires.resources` are always required (`@ss/entitlements` adds them to every
  element, so a missing one disables every element); an element's kinds only while that element is on.
  `resourceNeeds(websiteId)` → `[{ subscriptionId, appId, productSlug, kind, scope: 'product'|'element', elements,
neededNow, optional? }]` from the last resolution (stored with the document); `websitesOfApp(appId)` → website ids with
  a live subscription. Element `requires.optionalResources` (F.18) never disable an element; they appear with
  `optional: true`, needed while a using element is on.
- Calls `delivery.requestCompile(websiteId)` whenever a document version is bumped and when a subscription is
  cancelled (failures are logged, never fail commerce).
- Emits `entitlement.changed@1` and `subscription.*@1` via integration.
- Hook: `onMerchantStatus({ merchantId, status })` (called by identity).

## config (`modules/config`)

Layered overrides with versions, locks, templates and scheduled changes for subscriptions/merchants/platform.

- `layersFor(subscriptionId)` → `{ platform, merchant, website, admin }` in the shape `@ss/entitlements`
  `resolveEntitlement` expects (elements on/off, feature values, config, locks)
- `setOverride({ level: 'merchant'|'website'|'admin'|'platform', target, elementKey?, featureKey?, value, lock?, actor })`
  → new version (validated against the manifest feature schema via `@ss/contracts` `validateFeatureConfig`)
- `history(target)`, `rollback({ target, version, actor })`
- Templates: `saveTemplate`, `applyTemplate({ templateId, websiteIds })`
- Scheduled changes: `schedule({ change, at })`, applied on read (`applyDue(merchantId)`, called by `layersFor` and
  `listSchedules`) at or after `at` — no job
- Calls `commerce.invalidate(subscriptionId)` (commerce exposes `invalidate`) after every change.

## integration (`modules/integration`)

Event Hub and control-event delivery.

- **Provenance** (F.16): ingest strips any producer-supplied `context.keyKind` and stamps the verified key's kind
  (`pk` | `sk`, `@ss/contracts` `KEY_KINDS`) on the delivered envelope; actor types per key kind follow
  `actorAllowedForKeyKind`. Product-published events lose any `keyKind` and are marked `context.source: 'product'`,
  `context.product: <slug>`.
- `ingest({ website, events })` (website keys; `@ss/contracts` envelope validation; dedupe `(websiteId,
idempotencyKey)`; payloads are NOT persisted in Portal — only routing metadata: id, type, websiteId, receivedAt,
  delivery status) → `{ results }`
- `publishFromProduct({ appId, events })` (scope + namespace rules from the manifest)
- `emitControl(type, data, { appIds?, websiteId? })` (Portal-only control events). Website-scoped types need `websiteId`
  (targets: `appIds`, else every product subscribed on the website); **platform-scoped** types (`manifest.accepted@1`)
  carry no `websiteId` in the envelope and need `appIds`.
- Fan-out: subscriptions derived from accepted manifests (`events.consumes`, which may hold globs such as `custom.*` or
  `order.*@1`, each covered by an `events.subscribe:` scope) × active subscriptions; deliveries are jobs
  `integration.deliver` signed with `@ss/protocol` `signEvent`, attempted right after the ingesting request; a failed
  one is retried (backoff, then due) on the next delivery to that product and when the product next calls the Portal
  (port `productCalled`), or by staff (`POST /v1/admin/apps/:appId/deliveries/retry`, `retryNow`); DLQ, replay.
- **Delivery target:** the app's registered environment base (`catalog.getApp().environments`) + the manifest's
  `endpoints.events` path: events of `test` websites go to `staging` when one is registered, everything else to
  `production`; no environment → dead-lettered `no_endpoint`. https only; plain http and private addresses only for
  `OUTBOUND_DEV_ALLOW_HOSTS` outside production (the allowlist is empty in production).
- `deliveryLog({ websiteId | appId, cursor })`, `replay(deliveryId)`.
- Because payloads are not stored, fan-out happens at ingest time (payload carried inside the job only, job deleted
  on success; DLQ keeps the payload sealed with `ctx.envelope` for at most 7 days).

## connectors (`modules/connectors`)

Client-owned resources (§1a): database, storage, ai, messaging, payments, analytics.

- `create({ merchantId, kind, provider, credentials, websiteIds })` (credentials sealed with `ctx.envelope`, aad =
  merchantId + connectorId; never returned)
- `test(connectorId)` → check report (database: reachability, auth, least privilege, role can create indexes in its own
  db; storage: put/get/delete probe object; ai/messaging: a cheap authenticated call). Least privilege: any role or
  privilege on another database (including `admin`), cluster-level roles (`root`, `clusterAdmin`, …), any
  `*AnyDatabase` role or cluster / any-resource privilege fails the check (`least_privilege` step, code
  `over_privileged`, status `failing`); `dbAdmin` / `dbOwner` / `userAdmin` on the target database is a `db_admin`
  warning only. Every destination passes the `@ss/net` outbound policy.
- `rotate`, `revoke`, `assign({ connectorId, websiteIds })`
- `statusFor(websiteId)` → `[{ kind, ref, status: connected|missing|failing|revoked }]`
- `resolve({ appId, websiteId, kind })` → `{ kind, descriptor, expiresAt }` (F.9) — only for products whose manifest
  requires `kind` (product level, or an element, optional kinds included — F.18) and that have an active subscription on that website, and (F.16)
  only while the kind is **needed now** per `commerce.resourceNeeds` (an element-level kind whose elements are all
  off is refused, `element_off`); audited every time; `expiresAt` ≤ 15 min.
- `GET /v1/merchants/:merchantId/websites/:websiteId/resources` adds `needs` (above); the console shows "needed now"
  vs "needed if you enable …".
- SMTP messaging descriptors: implicit TLS (`smtps://`) on port 465 (the default) unless `secure` says otherwise; any
  other port is STARTTLS (`smtp://`).
- Emits `resource.changed@1` via integration.

## delivery (`modules/delivery`)

Delivery plane (PLAN §4): pack asset storage, the per-website bundle compiler, serving, rollback, preview proxy.
Artefacts (pack assets, compiled bundles) are **our software** and live in platform asset storage
(`STORAGE_*`, an S3-compatible bucket signed with `@ss/net` `signV4`; `STORAGE_DIR` (a directory or `:memory:`)
outside production). Collections hold metadata only; fetched merchant pages are never stored.

- `requestCompile(websiteId, { reason? })` → `{ websiteId, request, jobId }` — called by **commerce** whenever a
  document version is bumped and when a subscription is cancelled; increments `delivery_aliases.requested` and
  enqueues job `delivery.compile` (key `delivery.compile:<websiteId>:<n>`; a job skips itself when a newer request
  exists, so bursts coalesce).
- `compile({ websiteId, merchantId?, actor?, reason?, request? })` → `{ changed, version, previousVersion?, stale?,
artefact, warnings }`. Inputs: `commerce.subscriptionsForWebsite` + `commerce.documentFor` (verified with the Portal
  key resolver, bound to the website's domain, `graceMs: 0`), `catalog.getApp` / `getManifest(appId,
sub.manifestVersion)` / `versionDetail` (pack descriptor assets), `identity.getWebsite` / `issueKey` / `listKeys` /
  `revokeKey` (one `pk_` key per website, scopes `events.write elements.read`, issued by the system actor on first
  compile and re-issued when it is no longer active). Delivered: elements the document enables, of `runtime.state =
active` subscriptions, whose manifest declares mode A. Packs → their headless + renderer modules
  (`/w/packs/<appId>/<version>/<path>`, lazy `import()`); service products → the element stub
  (`ss-element-stub@1`, below). Output `w/<websiteId>/<env>/<version>/loader.js` + `manifest.json`
  (`ss-website-bundle@1`: integrity sha384, sha256, sizes, budget, CSP sources, elements, warnings); version = first 16
  hex of SHA-256 of the bundle (deterministic). The alias flips by compare-and-set on `compiledRequest`.
  Refusals: `delivery_budget_exceeded` (422; `errors[]` lists offenders: `budget` when loader gzip + Σ `budget.js` +
  Σ product `budget.shared` > `DELIVERY_BUDGET_KB` (default 60), `over_declared` when an element's own entry modules
  ship more gzip bytes than its `budget.js`, `shared_over_declared` when a product's shared chunks exceed its
  `budget.shared`), `conflict` (one product delivers the same element id twice).
  **Wave-1 (F.18):** sizes come from `@ss/contracts/budget` `measureBundle` over the stored modules (own entry modules
  per element; shared modules and every imported chunk once per product; an undeclared `budget.shared` counts as
  measured, warning `shared_undeclared`); stub elements count 0 KB. Every bundle element carries `product` (the Loader
  id is `<product>:<key>`; two products may deliver the same key). Pack elements get `reads: { <slug>: <base> }` for
  each manifest `reads` product with an active subscription (warning `reads_inactive` otherwise) and the loader key
  gains their read scopes (re-issued when one is missing). Strings: the product catalogs `strings/<lang>.json` sliced
  by the element's `stringKeys` (default `<key>.*`) for the website language (`identity.getWebsite().language`,
  fallback `en`), then the merchant's overrides. `manifest.json` adds `budget.sharedKb`, `budget.shared[]` and per
  element `gzipBytes` / `reads`.
- `rollback({ websiteId, merchantId?, version, actor })`, `status({ websiteId, merchantId? })`, `snippet(...)`.
- **String overrides** (F.18, `delivery_strings`, `_id` = `<websiteId>:<appId>:<element>`):
  `listStringOverrides({ merchantId, websiteId })` → `{ items: [{ appId, element, languages, updatedAt }] }` and
  `setStringOverride({ merchantId, websiteId, appId, element, language, body: { strings }, actor })` (`language` a BCP
  47 tag or `*`; ≤ 200 keys, text ≤ 2000, ≤ 32 KiB; an empty object removes that language; the website must subscribe
  to the product and the element must be mode A) — audited `delivery.strings_updated`, then `requestCompile`. Routes
  `GET /v1/merchants/:m/websites/:w/delivery/strings`, `PUT …/delivery/strings/:appId/:element/:language`
  (`websites.read` / `websites.write`).
- `uploadAsset({ appId, version, path, bytes, contentType, actor })` — bytes must equal the descriptor's sha256 and
  size (`delivery_asset_mismatch`), types js/mjs/css/json/svg/png/woff2 with per-type caps (415 / 413).
- **Service UI bundles** (F.16, `delivery_ui_bundles`): a service product publishes the browser modules of its mode-A
  elements itself. `POST /v1/product/ui-bundles` (product auth) with `{ descriptor, signature }` — the pack format
  `ss-pack-bundle@1`, signature over `ss-pack-bundle.v1.<sha256(canonicalJson(descriptor))>` with a **registered
  product key** (`catalog.verifyUiBundle`; no `publicJwk`), `descriptor.manifest` = `{ product: { slug, version },
elements: [{ key, headless: 'file.js#export', renderer, strings? }] }` → `{ version, status: pending|ready, missing,
uploadPath }` (same descriptor = same version). Then `PUT /v1/product/ui-bundles/:version/assets/<path>` per asset
  (raw bytes, checks as for packs). When the last asset lands the bundle is `ready` (audited) and every subscribed
  website recompiles; `GET /v1/product/ui-bundles` lists them. Assets are served immutable at
  `/w/ui/<appId>/<version>/<path>`. The compiler uses the newest ready bundle for the elements the pinned manifest
  declares mode A (budgets as for packs; the element API client is bound to `endpoints.base`), else the stub.
  `manifest.json` records `delivery: 'pack' | 'ui-bundle' | 'ss-element-stub@2'`. Bundle data `assets` is
  `<portal>/w/` and module paths start with `packs/` or `ui/`.
- `createPreview({ merchantId, websiteId, body: { path?, base?: 'current'|'empty', elements?: [{ appId, key, config?,
strings?, placement? }] }, actor })` → `{ previewId, url, expiresAt, version, budget, elements, warnings }`;
  `servePreview({ token, path, search, host })`. With a preview URL setting (F.16) preview URLs use that origin, `/p/*` on
  the Portal host is refused (`delivery_preview_refused`), and the preview host serves nothing but `/p/*` (404 from
  `portal.handle` for API and `/w/*` paths; `proxy.js` for console pages). There the page keeps `CSP: sandbox`
  but adds `allow-same-origin` and admits the merchant's own scripts (`script-src https: 'unsafe-inline'`).
- Job `delivery.compile` (runs right after the request that asked for it; a failed one is retried when the website's
  loader is next served). Problems `delivery_budget_exceeded`, `delivery_asset_mismatch`, `delivery_preview_refused`.

- Commerce calls `requestCompile` (see commerce); the compile reads only public service functions, so delivery has no
  write path into other modules except `identity.issueKey` / `revokeKey` for its one `pk_` key.

**Element stub contract (`ss-element-stub@2`; `@1` bundles keep working)** — how a service product's mode-A element
without a UI bundle runs inside the Loader with no product code in the bundle. The stub's headless core calls the
product with the website's `pk_` key (`Authorization: Bearer pk_…`, `SS-Identity` when federated, `Idempotency-Key` on
POST; Origin enforcement as for any `pk_` call): `GET <endpoints.base>/v1/elements/<key>/view?ctx=<JSON>` → view
model; `POST <endpoints.base>/v1/elements/<key>/actions/<action>?ctx=<JSON>` (`action` matches
`^[a-z][a-z0-9_]{0,39}$`, JSON body) → the next view model. `ctx` (v2) is the page context `{ path ≤ 512, itemId? ≤
128, pageType? ≤ 40 }`: item id / page type from `data-ss-item-id` / `data-ss-page-type` on the element's nearest
ancestor, else the placement target, else `<html>` or `<meta name="ss:item-id|ss:page-type">`. View model (all
optional, text only, never HTML): `{ title ≤ 200, body ≤ 2000, items: [{ text, href? }] ≤ 50, fields: [{ name
(^[a-z][a-z0-9_]{0,39}$), type: text|email|tel|number|textarea|select|checkbox, label ≤ 200, required?, options?:
[{ value, label? }] ≤ 50 }] ≤ 20, actions: [{ action, label ≤ 80 }] ≤ 10 }`. With fields, an action posts `{ ...input,
fields: { <name>: string | number | null | boolean } }` (required fields are checked in the browser first); without
fields the body is the action input as in v1.
Errors are RFC 9457 problems. The stub renders with the Loader's safe `h()` (class names `ss-el`, `ss-el__title`,
`ss-el__body`, `ss-el__items`, `ss-el__fields`, `ss-el__field`, `ss-el__input`, `ss-el__action`; design tokens via CSS variables), emits `<key>.action@1` (`{ action, ok? }`, catalogued in `@ss/contracts` `ELEMENT_EVENT_DATA` with `<key>.shown@1`), and exposes
`actions.refresh()` / `actions.invoke(action, input)` on `SS.elements.get(key)`.

## Product API routes (`/v1/product/*`, `auth: 'product'`) — owned by the module named

| Route                                                                               | Module          |
| ----------------------------------------------------------------------------------- | --------------- |
| `GET /v1/product/entitlements`                                                      | commerce        |
| `GET /v1/product/revocations`                                                       | identity        |
| `POST /v1/product/usage`                                                            | commerce        |
| `POST /v1/product/launch/consume`                                                   | catalog         |
| `POST /v1/product/heartbeat`                                                        | catalog         |
| `POST /v1/product/keys/rotate`                                                      | catalog         |
| `POST /v1/product/events`                                                           | integration     |
| `POST /v1/product/resources/resolve`                                                | connectors      |
| `PUT /v1/product/websites/:websiteId/identity`                                      | identity (F.16) |
| `POST\|GET /v1/product/ui-bundles` · `PUT /v1/product/ui-bundles/:version/assets/*` | delivery (F.16) |

Website-facing: `POST /v1/events` (integration, `websiteKey`); delivery serves `/w/*` and `/p/*` (public). Console routes (`/v1/merchants/...`, `/v1/admin/...`)
belong to the module owning the entity.
