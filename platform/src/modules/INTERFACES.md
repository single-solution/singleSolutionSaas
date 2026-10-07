# Module interfaces (binding for the M2 module wave)

Modules call each other only through `ctx.service(name)`. These are the public service functions each module MUST
expose (extra functions allowed). All functions are async, take plain objects, return plain objects, and throw
`ctx.problems` problems on failure. Ids use `@ss/contracts` `createId` prefixes.

## identity (`modules/identity`)

Admins, merchants (one login each, e-mails unique across both through `identity_logins`), sessions, websites,
website keys (PLAN 0.8).

- `getMerchant(merchantId)` → `{ merchantId, name, status: active|suspended, createdAt }`
- `getWebsite(websiteId)` → `{ websiteId, merchantId, domain, env: 'live'|'test', twinId, status, timeZone, language,
currency, createdAt }` — the **website settings** (F.16) are `null` when unset: `timeZone` (IANA, checked with `Intl`,
  canonical spelling), `language` (BCP 47, `Intl.getCanonicalLocales`), `currency` (ISO 4217, upper case).
  `updateWebsiteSettings({ merchantId, websiteId, settings, actor })` sets them on the live/test pair (`null` clears),
  audits `website.settings_updated` and calls `commerce.invalidateWebsite` for both ids. Route:
  `PATCH /v1/merchants/:merchantId/websites/:websiteId` (`websites.write`; admins via the Admin Console).
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
- Implements ports `sessionActor(session)` and `websiteKeyRevoked(claims, rawKey)` → `true` when the key is revoked,
  unknown, or (for `sk_`) its HMAC does not match `rawKey`; infra calls it after the offline signature check.
- Calls `integration.emitControl('key.revoked@1', …)` on revoke.
- Admin building blocks: `getMerchantRecord(merchantId)`, `merchantNames(ids)` (Activity), `counts()` (Overview),
  `getAdmin(adminId)`; the parts `accounts`, `admins`, `merchants` and `websites` back the `/v1/auth/*`, `/v1/me/*`,
  `/v1/admin/merchants*` and `/v1/admin/admins*` routes.
- **Bring-your-own customer identity** (PLAN §5.3, F.14), one issuer per website (`identity_issuers`, `_id` =
  websiteId): `setIdentityIssuer({ merchantId, websiteId, input: { issuer, jwksUrl | publicJwks[], audience?,
claimMap: { subject = 'sub', email?, phone? } }, actor })` (public signature keys only — Ed25519, P-256, RSA ≥ 2048,
  ≤ 5; a `jwksUrl` is fetched with `@ss/net` `safeFetch`, no redirects, 5 s, 64 KiB, and must yield a usable key),
  `getIdentityIssuer`, `removeIdentityIssuer`, `refreshIdentityIssuer` (fetch now). Every change is audited
  (`website.identity_*`) and calls `commerce.invalidateWebsite(websiteId)`. `identityFor(websiteId)` → the
  entitlement-document `identity` section `{ issuer, jwks, audience?, claimMap }` or null; a JWKS URL is refetched at
  most hourly when documents are rebuilt (failures keep the last good keys, retry after 5 min). Removing a
  website drops its issuer. Routes: `GET|PUT|DELETE /v1/merchants/:merchantId/websites/:websiteId/identity`
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
_rejected`). A merchant's own PUT clears `managedBy`. Removing a website drops its requests.

## catalog (`modules/catalog`)

Apps (service products and element packs): onboarding with the product's connect secret (Portal side), pack and
widget uploads, manifest versions, status, app keys, launches.

- `getApp(appId)` → `{ appId, slug, kind: service|pack, status: active|inactive, name, productVersion, endpoints,
baseUrl, currentVersion, createdAt }` — `baseUrl` is the connected address (service only); `currentVersion` is `null`
  for a pack whose first version is still uploading. `appBySlug(slug)`.
- **Status**: new apps are `inactive`; admins switch with `setStatus({ appId, status, actor })`
  (`POST /v1/admin/apps/:appId/status`, `products.manage`; activating needs a current version). Inactive apps are
  not listed, not newly subscribable and cannot be opened by merchants; existing subscriptions keep working.
- Onboarding: `connectProduct({ url, secret })` (admin `POST /v1/admin/apps/connect`, idempotent) → `{ appId, slug,
baseUrl, kid, reconnected, version, priceChanges? }`: `@ss/protocol` `createConnectRequest` to
  `<url>/.well-known/ss-connect` (HMAC with the deployer's `CONNECT_SECRET`, never sent nor stored),
  `verifyConnectResponse`, manifest and base-URL checks, app (inactive) + version + key created — or, for a known slug,
  the binding replaced (key replaced, base URL moved). A changed manifest becomes the current version at once
  (`priceChanges` lists changed element prices).
- **One upload path for packs and widgets**: `uploadPack({ body: { descriptor } })` (`POST /v1/admin/packs`,
  idempotent; the `ss pack build` descriptor) → `{ appId, slug, kind, version, status: uploading|ready, missing,
uploadPath, changed }`. A pack slug creates the pack (inactive, version 1) or a new uploading version (same manifest
  and assets as the latest = no change); the slug of a connected service product hands its widgets to
  `delivery.registerWidgets` (their elements must be mode A in the current manifest). Assets then go one by one to
  `PUT <uploadPath><path>` (delivery). `versionReady({ appId, version })` (called by delivery when a pack version has
  every asset) makes it current (the previous one superseded). Idempotent.
- `getManifest(appId, version?)` → validated manifest (features inline); `versionDetail(appId, version)` (descriptor
  assets included).
- `activeProducts({ kind? })` → active apps with a current version (consoles, key scopes).
- `issueLaunch({ kind: 'merchant'|'admin', appId, subject, user, scope, subscriptions?, actor? })` → `{ url, token }`
  (`url` = `<baseUrl>/sso?launch=<token>`). Merchant launches need an active app. Admin launches carry
  `scope.merchantId` or the app-wide `scope: { all: true }` (exclusive: only `permissions` may sit next to it). The
  admin route `POST /v1/admin/apps/:appId/launch` needs `dashboards.open`; with `{ all: true }` it also needs
  `products.manage` (Owner only).
- Admin reads: `GET /v1/admin/apps`, `GET /v1/admin/apps/:appId` (versions summary, keys),
  `GET /v1/admin/apps/:appId/versions/:version`.
- Implements port `appKeys(appId)` → KeyResolver of the app's registered keys.
- A new current version emits `manifest.accepted@1` (platform-scoped, `appIds: [appId]`) via integration and calls
  `commerce.invalidateApp`.

## commerce (`modules/commerce`)

Subscriptions, element switches, entitlement documents, usage, quotas, ledger (append-only, hash-chained),
credits, settlement, spend caps.

- `subscribe({ websiteId, appId, planCode? })` → subscription (active apps only; requires ≥ 1 hour of credits; pins
  price book). A manifest
  `trialHours` is granted once per website × app at the first subscribe as an `adjustment` ledger entry
  (`entryKey trial:<websiteId>:<appId>`, worth `trialHours ×` the first hour's charge; it counts towards the one-hour
  minimum; audited `credits.trial_granted`).
- `getSubscription(subscriptionId)`, `subscriptionsForWebsite(websiteId)`
- `setElement({ subscriptionId, elementKey, enabled, actor })`
- `pause / resume / cancel({ subscriptionId, reason, actor })`
- `documentFor({ websiteId, appId })` → compact JWS (signed by Portal signer, cached until content hash changes)
- `recordUsage({ appId, records })` → `{ results }` (F.9)
- `addCredits({ merchantId, amountMillicredits, reference, note, actor })`, `adjust`, `refund`
- **Spend cap** (`commerce_spend_caps`, `_id` = merchantId, `{ limit, updatedAt, updatedBy }`): `spendCap(merchantId)`
  → `{ limit, spent, remaining, reached, periodStart, periodEnd }` (UTC month), `setSpendCap(merchantId, { limit },
caller)`, `removeSpendCap(merchantId, caller)` (audited `spend_cap.*`). Routes `GET|PUT|DELETE
/v1/merchants/:merchantId/spend-cap` (`billing.read` / `billing.manage`). When the month's spend plus the coming
  hours' burn would exceed the cap, live subscriptions get the `spend_cap` hold until the month ends.
- `balance(merchantId)`, `meter(merchantId)` — both settle the merchant's due complete hours first (lazy settlement:
  `runSettlement({ merchantId })`, 2 s budget, idempotent per `periodKey`; a failure never fails the read)
- `statement(merchantId, { from, to, websiteId? })`
- `invalidate(subscriptionId)`, `invalidateWebsite(websiteId)`, `invalidateApp(appId)` (re-resolve and re-sign the
  documents of every live subscription of an app, e.g. after a manifest is accepted) → `{ invalidated }`
- `previewDocument({ subscriptionId, layers })` → the canonical, unsigned document the subscription would get with
  `layers` (config dry runs; nothing stored or emitted)
- Settlement on read (F.19, no cron): `settleDue(merchantId)` runs before balance, meter and statement reads, product
  document fetches (`documentFor`), subscription changes, and right after a product's usage batch.
- Reads configuration layers `{ platform, website, admin }` from `config.layersFor(subscriptionId)`; resource status from
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

Layered overrides with versions and locks for subscriptions (website, admin) and platform policies per app.

- `layersFor(subscriptionId)` → `{ platform, website, admin }` in the shape `@ss/entitlements` `resolveEntitlement`
  expects (elements on/off, feature values, config, locks)
- `setOverride({ level: 'website'|'admin'|'platform', target, elementKey?, featureKey?, value, lock?, actor })` → new
  version (validated against the manifest feature schema via `@ss/contracts` `validateFeatureConfig`)
- `history(target)`, `rollback({ target, version, actor })`, `preview(...)` (dry run)
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
  (port `productCalled`), or by admins (`POST /v1/admin/apps/:appId/deliveries/retry`, `retryNow`). A delivery that
  meets a permanent error, uses its last attempt or is older than 24 h is marked `failed` (`failedAt`,
  `lastErrorCode`; metadata only). Inactive service apps still receive events.
- **Delivery target:** `catalog.getApp().baseUrl` + the manifest's `endpoints.events` path; no base → `failed`
  `no_endpoint`. https only; plain http and private addresses only for
  `OUTBOUND_DEV_ALLOW_HOSTS` outside production (the allowlist is empty in production).
- Because payloads are not stored, fan-out happens at ingest time (payload sealed with `ctx.envelope` inside the job
  only, dropped on success and gone with the job when it fails).

## connectors (`modules/connectors`)

Client-owned resources (§1a): database, storage, ai, messaging, payments.

- `create({ merchantId, kind, provider, credentials, websiteIds })` (idempotent route; credentials sealed with `ctx.envelope`, aad =
  merchantId + connectorId; never returned)
- `test(connectorId)` → check report (database: reachability, auth, least privilege, role can create indexes in its own
  db; storage: put/get/delete probe object; ai/messaging: a cheap authenticated call). Least privilege: any role or
  privilege on another database (including `admin`), cluster-level roles (`root`, `clusterAdmin`, …), any
  `*AnyDatabase` role or cluster / any-resource privilege fails the check (`least_privilege` step, code
  `over_privileged`, status `failing`); `dbAdmin` / `dbOwner` / `userAdmin` on the target database is a `db_admin`
  warning only. Every destination passes the `@ss/net` outbound policy.
- `update({ merchantId, connectorId, label?, credentials? })` (`PATCH …/connectors/:connectorId`: new credentials are
  re-sealed in place and re-checked), `remove` (`DELETE`: record and sealed material gone, resolution stops at once),
  `assign({ connectorId, websiteIds })` (`PUT …/websites`)
- `statusFor(websiteId)` → `[{ kind, ref, status: connected|missing|failing }]`
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

Delivery plane (PLAN §4): pack and widget asset storage, the per-website bundle compiler, serving, snippets.
Artefacts (pack and widget assets, compiled bundles) are **our software** and live in platform asset storage
(`STORAGE_*`, an S3-compatible bucket signed with `@ss/net` `signV4`; `STORAGE_DIR` (a directory or `:memory:`)
outside production). Collections hold metadata only.

- `requestCompile(websiteId, { reason? })` → `{ websiteId, request, jobId }` — called by **commerce** whenever a
  document version is bumped and when a subscription is cancelled; increments `delivery_aliases.requested` and
  enqueues job `delivery.compile` (key `delivery.compile:<websiteId>:<n>`; a job skips itself when a newer request
  exists, so bursts coalesce).
- `compile({ websiteId, merchantId?, actor?, reason?, request? })` → `{ changed, version, previousVersion?, stale?,
artefact, warnings }`. Inputs: `commerce.subscriptionsForWebsite` + `commerce.documentFor` (verified with the Portal
  key resolver, bound to the website's domain, `graceMs: 0`), `catalog.getApp` / `getManifest(appId,
sub.manifestVersion)` / `versionDetail` (pack descriptor assets), `identity.getWebsite` / `issueKey` / `listKeys` /
  `revokeKey` (one `pk_` key per website, scopes `events.write elements.read` plus the product scopes below, issued by
  the system actor and re-issued when it is no longer active or lacks a scope). Delivered: elements the document
  enables, of `runtime.state = active` subscriptions, whose manifest declares mode A. Pack elements → the pack's
  headless + renderer modules; service elements → the modules of the product's newest ready widget bundle, with
  `api: <baseUrl>` (fallback `endpoints.base`), and the loader key gains `<slug>.read` / `<slug>.write`. Both are served
  at `/w/packs/<appId>/<version>/<path>` (lazy `import()`). Skipped elements are warnings: `widgets_missing` (service
  element without widgets), `no_api_base` (no https base URL), `reads_inactive`, module and placement problems. Output
  `w/<websiteId>/<env>/<version>/loader.js` + `manifest.json` (`ss-website-bundle@1`: integrity sha384, sha256, bytes,
  CSP sources, elements, warnings); version = first 16 hex of SHA-256 of the bundle (deterministic). The alias flips by
  compare-and-set on `compiledRequest`. Refusal: `conflict` (one product delivers the same element id twice).
  Every bundle element carries `product` (the Loader id is `<product>:<key>`; two products may deliver the same key).
  Pack elements get `reads: { <slug>: <base> }` for each manifest `reads` product with an active subscription and the
  loader key gains their read scopes. Strings: the product catalogs `strings/<lang>.json` sliced by the element's
  `stringKeys` (default `<key>.*`) for the website language (`identity.getWebsite().language`, fallback `en`), then the
  merchant's overrides.
- `status({ websiteId, merchantId? })`.
- **Install snippet**: `snippet({ websiteId, merchantId? })` (`GET /v1/merchants/:m/websites/:w/delivery/snippet`) →
  `{ websiteId, env, version, alias: { url, tag, note }, immutable: { url, integrity, tag, note }, csp }`. The alias
  tag (`<script src="<portal>/w/<websiteId>/loader.js" crossorigin="anonymous" defer>`) always serves the current
  version and is what the Merchant Console's install code card shows (with copy); the immutable tag pins one version
  with SRI. Before the first compile `version`, `immutable` and `csp` are `null` and the alias tag is already valid.
- **String overrides** (F.18, `delivery_strings`, `_id` = `<websiteId>:<appId>:<element>`):
  `listStringOverrides({ merchantId, websiteId })` → `{ items: [{ appId, element, languages, updatedAt }] }` and
  `setStringOverride({ merchantId, websiteId, appId, element, language, body: { strings }, actor })` (`language` a BCP
  47 tag or `*`; ≤ 200 keys, text ≤ 2000, ≤ 32 KiB; an empty object removes that language; the website must subscribe
  to the product and the element must be mode A) — audited `delivery.strings_updated`, then `requestCompile`. Routes
  `GET /v1/merchants/:m/websites/:w/delivery/strings`, `PUT …/delivery/strings/:appId/:element/:language`
  (`websites.read` / `websites.write`).
- `registerWidgets({ appId, descriptor, actor })` (called by `catalog.uploadPack` for a service product;
  `delivery_widgets`) → `{ version, status: uploading|ready, missing, uploadPath, changed }` (same descriptor = same
  version).
- `uploadAsset({ appId, version, path, bytes, contentType, actor })` — one route for both kinds,
  `PUT /v1/admin/packs/:appId/versions/:version/assets/<path>` (`products.manage`): bytes must equal the
  descriptor's sha256 and size (`delivery_asset_mismatch`), types js/mjs/css/json/svg/png/woff2 with per-type caps
  (415 / 413). The last asset of a pack version calls `catalog.versionReady`; the last of a widget bundle makes it
  `ready`. Either way every website subscribed to the app recompiles.
- Job `delivery.compile` (runs right after the request that asked for it; a failed one is retried when the website's
  loader is next served). Problem `delivery_asset_mismatch`.
- Commerce calls `requestCompile` (see commerce); the compile reads only public service functions, so delivery has no
  write path into other modules except `identity.issueKey` / `revokeKey` for its one `pk_` key.

## Product API routes (`/v1/product/*`, `auth: 'product'`) — owned by the module named

| Route                                          | Module          |
| ---------------------------------------------- | --------------- |
| `GET /v1/product/entitlements`                 | commerce        |
| `GET /v1/product/revocations`                  | identity        |
| `POST /v1/product/usage`                       | commerce        |
| `POST /v1/product/launch/consume`              | catalog         |
| `POST /v1/product/events`                      | integration     |
| `POST /v1/product/resources/resolve`           | connectors      |
| `PUT /v1/product/websites/:websiteId/identity` | identity (F.16) |

Website-facing: `POST /v1/events` (integration, `websiteKey`); delivery serves `/w/*` (public). Console routes (`/v1/merchants/...`, `/v1/admin/...`)
belong to the module owning the entity.
