# Module interfaces (binding for the M2 module wave)

Modules call each other only through `ctx.service(name)`. These are the public service functions each module MUST
expose (extra functions allowed). All functions are async, take plain objects, return plain objects, and throw
`ctx.problems` problems on failure. Ids use `@ss/contracts` `createId` prefixes.

## identity (`modules/identity`)

Merchants, merchant users, staff users, partners, developers, sessions, websites, website keys.

- `getMerchant(merchantId)` → `{ merchantId, name, status: active|suspended, createdAt }`
- `getWebsite(websiteId)` → `{ websiteId, merchantId, domain, env: 'live'|'test', twinId, status, createdAt }`
- `listWebsites(merchantId)`
- `websiteByDomain(domain)` (normalised via `@ss/contracts` `normaliseDomain`)
- `suspendMerchant / resumeMerchant` (emit audit; commerce reacts via `onMerchantStatus` hook below)
- Website keys: `issueKey({ websiteId, kind: 'pk'|'sk', scopes, expiresAt? })` → `{ keyId, key }` (shown once),
  `revokeKey({ keyId, reason })`, `revocationsSince(cursor)` → `{ keyIds, cursor }`.
- Website keys are signed with a **dedicated website-key signing key** (`WEBSITE_KEY_SIGNING_KEYS`), not the launch key.
- Implements ports `sessionActor(session)` and `websiteKeyRevoked(claims, rawKey)` → `true` when the key is revoked,
  unknown, or (for `sk_`) its HMAC does not match `rawKey`; infra calls it after the offline signature check.
- Calls `integration.emitControl('key.revoked@1', …)` on revoke.

## catalog (`modules/catalog`)

Apps (products), registration handshake (Portal side), manifest versions and review, app keys, environments,
health, launches.

- `getApp(appId)` → `{ appId, slug, kind: service|pack, status: pending|active|deprecated|retired, endpoints, currentVersion }`
- `appBySlug(slug)`
- `getManifest(appId, version?)` → validated manifest (features inline)
- `activeProducts()` → catalog list for consoles
- `issueLaunch({ kind, appId, subject, user, scope, subscriptions, actor?, impersonationSeconds? })` → `{ url, token }`
  (`url` = `<product>/sso?launch=<token>`). Admin launches carry `scope.merchantId` or the app-wide `scope: { all: true }`
  (exclusive: only `permissions` may sit next to it). The staff route `POST /v1/admin/apps/:appId/launch` with
  `{ kind: 'admin', all: true }` needs `platform.launch.admin` **and** the `superadmin` or `admin` staff role (support
  staff may launch per merchant only).
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
- Crons `settlement` (hourly), `reconciliation` (nightly).
- Reads configuration layers from `config.layersFor(subscriptionId)`; resource status from
  `connectors.statusFor(websiteId)`.
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
- Scheduled changes: `schedule({ change, at })` + job `config.apply_scheduled`
- Calls `commerce.invalidate(subscriptionId)` (commerce exposes `invalidate`) after every change.

## integration (`modules/integration`)

Event Hub and control-event delivery.

- `ingest({ website, events })` (website keys; `@ss/contracts` envelope validation; dedupe `(websiteId,
idempotencyKey)`; payloads are NOT persisted in Portal — only routing metadata: id, type, websiteId, receivedAt,
  delivery status) → `{ results }`
- `publishFromProduct({ appId, events })` (scope + namespace rules from the manifest)
- `emitControl(type, data, { appIds?, websiteId? })` (Portal-only control events). Website-scoped types need `websiteId`
  (targets: `appIds`, else every product subscribed on the website); **platform-scoped** types (`manifest.accepted@1`)
  carry no `websiteId` in the envelope and need `appIds`.
- Fan-out: subscriptions derived from accepted manifests (`events.consumes`) × active subscriptions; deliveries are
  jobs `integration.deliver` signed with `@ss/protocol` `signEvent`, retries with backoff, DLQ, replay.
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
  `requires.resources` includes `kind` and that have an active subscription on that website; audited every time;
  `expiresAt` ≤ 15 min.
- Emits `resource.changed@1` via integration.

## delivery (`modules/delivery`)

Delivery plane (PLAN §4): pack asset storage, the per-website bundle compiler, serving, rollback, preview proxy.
Artefacts (pack assets, compiled bundles) are **our software** and live in platform asset storage
(`PLATFORM_ASSET_STORAGE`, an S3-compatible bucket signed with `@ss/net` `signV4`; `memory` / `file:<dir>` outside
production). Collections hold metadata only; fetched merchant pages are never stored.

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
  Refusals: `delivery_budget_exceeded` (422; `errors[]` lists offenders: `budget` when loader gzip + Σ `budget.js` >
  `DELIVERY_BUDGET_KB` (default 60), `over_declared` when an element's modules ship more gzip bytes than its
  `budget.js`), `conflict` (two products deliver the same element key).
- `rollback({ websiteId, merchantId?, version, actor })`, `status({ websiteId, merchantId? })`, `snippet(...)`.
- `uploadAsset({ appId, version, path, bytes, contentType, actor })` — bytes must equal the descriptor's sha256 and
  size (`delivery_asset_mismatch`), types js/mjs/css/json/svg/png/woff2 with per-type caps (415 / 413).
- `createPreview({ merchantId, websiteId, body: { path?, base?: 'current'|'empty', elements?: [{ appId, key, config?,
strings?, placement? }] }, actor })` → `{ previewId, url, expiresAt, version, budget, elements, warnings }`;
  `servePreview({ token, path, search })`.
- Job `delivery.compile`. Problems `delivery_budget_exceeded`, `delivery_asset_mismatch`, `delivery_preview_refused`.

**Element stub contract (`ss-element-stub@1`)** — how a service product's mode-A element runs inside the Loader with
no product code in the bundle. The stub's headless core calls the product with the website's `pk_` key (`Authorization:
Bearer pk_…`, `SS-Identity` when federated, `Idempotency-Key` on POST; Origin enforcement as for any `pk_` call):
`GET <endpoints.base>/v1/elements/<key>/view` → view model; `POST <endpoints.base>/v1/elements/<key>/actions/<action>`
(`action` matches `^[a-z][a-z0-9_]{0,39}$`, JSON body) → the next view model. View model (all optional, text only,
never HTML): `{ title ≤ 200, body ≤ 2000, items: [{ text, href? }] ≤ 50, actions: [{ action, label ≤ 80 }] ≤ 10 }`.
Errors are RFC 9457 problems. The stub renders with the Loader's safe `h()` (class names `ss-el`, `ss-el__title`,
`ss-el__body`, `ss-el__items`, `ss-el__action`; design tokens via CSS variables), emits `<key>.action@1`, and exposes
`actions.refresh()` / `actions.invoke(action, input)` on `SS.elements.get(key)`.

## Product API routes (`/v1/product/*`, `auth: 'product'`) — owned by the module named

| Route                                | Module      |
| ------------------------------------ | ----------- |
| `GET /v1/product/entitlements`       | commerce    |
| `GET /v1/product/revocations`        | identity    |
| `POST /v1/product/usage`             | commerce    |
| `POST /v1/product/launch/consume`    | catalog     |
| `POST /v1/product/heartbeat`         | catalog     |
| `POST /v1/product/keys/rotate`       | catalog     |
| `POST /v1/product/events`            | integration |
| `POST /v1/product/resources/resolve` | connectors  |

Website-facing: `POST /v1/events` (integration, `websiteKey`); delivery serves `/w/*` and `/p/*` (public). Console routes (`/v1/merchants/...`, `/v1/admin/...`)
belong to the module owning the entity.
