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
- Implements ports `sessionActor`, `websiteKeyRevoked`.
- Calls `integration.emitControl('key.revoked@1', …)` on revoke.

## catalog (`modules/catalog`)

Apps (products), registration handshake (Portal side), manifest versions and review, app keys, environments,
health, launches.

- `getApp(appId)` → `{ appId, slug, kind: service|pack, status: pending|active|deprecated|retired, endpoints, currentVersion }`
- `appBySlug(slug)`
- `getManifest(appId, version?)` → validated manifest (features inline)
- `activeProducts()` → catalog list for consoles
- `issueLaunch({ kind, appId, subject, user, scope, subscriptions, actor?, impersonationSeconds? })` → `{ url, token }`
  (`url` = `<product>/sso?launch=<token>`)
- Implements port `appKeys(appId)` → KeyResolver of registered (non-revoked) app keys.
- Emits `manifest.accepted@1` via integration on approval.

## commerce (`modules/commerce`)

Subscriptions, element switches, entitlement documents, usage, quotas, ledger (append-only, hash-chained),
credits, settlement, spend caps.

- `subscribe({ websiteId, appId, planCode? })` → subscription (requires ≥ 1 hour of credits; pins price book)
- `getSubscription(subscriptionId)`, `subscriptionsForWebsite(websiteId)`
- `setElement({ subscriptionId, elementKey, enabled, actor })`
- `pause / resume / cancel({ subscriptionId, reason, actor })`
- `documentFor({ websiteId, appId })` → compact JWS (signed by Portal signer, cached until content hash changes)
- `recordUsage({ appId, records })` → `{ results }` (F.9)
- `addCredits({ merchantId, amountMillicredits, reference, note, actor })`, `adjust`, `refund`
- `balance(merchantId)`, `statement(merchantId, { from, to, websiteId? })`
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
- `emitControl(type, data, { appIds?, websiteId? })` (Portal-only control events)
- Fan-out: subscriptions derived from accepted manifests (`events.consumes`) × active subscriptions; deliveries are
  jobs `integration.deliver` signed with `@ss/protocol` `signEvent`, retries with backoff, DLQ, replay.
- `deliveryLog({ websiteId | appId, cursor })`, `replay(deliveryId)`.
- Because payloads are not stored, fan-out happens at ingest time (payload carried inside the job only, job deleted
  on success; DLQ keeps the payload sealed with `ctx.envelope` for at most 7 days).

## connectors (`modules/connectors`)

Client-owned resources (§1a): database, storage, ai, messaging, payments, analytics.

- `create({ merchantId, kind, provider, credentials, websiteIds })` (credentials sealed with `ctx.envelope`, aad =
  merchantId + connectorId; never returned)
- `test(connectorId)` → check report (database: reachability, auth, role can create indexes in its own db, no
  `admin`/cluster privileges required; storage: put/get/delete probe object; ai/messaging: a cheap authenticated call)
- `rotate`, `revoke`, `assign({ connectorId, websiteIds })`
- `statusFor(websiteId)` → `[{ kind, ref, status: connected|missing|failing|revoked }]`
- `resolve({ appId, websiteId, kind })` → `{ kind, descriptor, expiresAt }` (F.9) — only for products whose manifest
  `requires.resources` includes `kind` and that have an active subscription on that website; audited every time;
  `expiresAt` ≤ 15 min.
- Emits `resource.changed@1` via integration.

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

Website-facing: `POST /v1/events` (integration, `websiteKey`). Console routes (`/v1/merchants/...`, `/v1/admin/...`)
belong to the module owning the entity.
