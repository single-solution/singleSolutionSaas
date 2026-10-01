## @ss/app-kit public API (binding contract shared by the app-kit, web and cli workers)

This file describes the API exactly as implemented. Wire formats to and from the Portal are canonical in PLAN.md Part F.9.
All functions are pure factories. Every side effect (fetch, clock, random, db client, stores, logger) is injected, with
sensible defaults.

```js
import {
	createProduct,
	configFromEnv,
	createLogger,
	noopLogger,
	redact,
	createMemoryStores,
	createMongoStores,
	createRequestHandler,
	defineRoute,
	standardRoutes,
	toNextRoute,
	ok,
	created,
	noContent,
	problem,
	paginate,
	isProblem,
	can,
	feature,
	config,
	featuresOf,
	// lower-level factories (normally used through createProduct)
	createPortalClient,
	createEntitlements,
	createWebsiteKeys,
	createLaunch,
	createUsage,
	createData,
	createConnectors,
	createS3Storage,
	createHttpConnector,
	createHttpAi,
	createHttpMessaging,
	presignUrl,
	signHeaders,
	createEvents,
	checkEvent,
	CONTROL_EVENTS,
	createAudit,
	createHealth,
	createPrivacy,
	resolveStrings,
	guardFilter,
	guardPipeline,
	guardUpdate,
	planIndexes,
	scopeGranted,
	backoffDelay,
	collectionPrefix,
	isKitError,
	STOPPED_STATES,
	ROLE_OF_KIND,
	PAYMENTS_METHODS,
} from '@ss/app-kit';
import { createFakePortal, entitlementPayload } from '@ss/app-kit/testing'; // tests / `ss dev` only
```

### Bootstrapping

```js
createProduct({
  manifest,                 // validated SSPS manifest (service product, features inline) — throws AppKitError invalid_manifest
  portalUrl,                // pinned Portal URL (SS_PORTAL_URL)
  appId,                    // assigned at registration; null → the appId recorded by the registration handshake is used
  signingKey,               // product private Ed25519 JWK (object or JSON string, SS_APP_SIGNING_KEY)
  registrationTokenHash,    // sha256 hex of the one-time registration token (SS_REGISTRATION_TOKEN_HASH); absent → register always 401
  stores,                   // Partial<Stores>; default in-memory (dev only); production: createMongoStores({ db })
  fetch, now, randomBytes, logger,
  strings,                  // { [lang]: { key: text } } or async (lang) => catalog | null — served at GET /v1/strings
  defaultLang,              // 'en'
  data: { indexes, migrations, createClient, clientOptions, idleMs },   // indexes/migrations applied lazily per website
  privacy: { collections: [{ name, subjectField = 'customerId', fields: [] }] } | { export(input), anonymize(input) },
  connectors: { [kind]: { [provider]: (ctx) => adapter } },             // e.g. payments adapters
  auditSink,                // async (entry) => void; default: merchant DB collection `audit`
  problemBaseUri,           // RFC 9457 type base, default `<endpoints.base>/problems/`
  problemCodes,             // product-specific { code: { status, title } }
  registrationAudience,     // string | string[]: extra accepted registration `aud` values (see below)
  portalIssuer,             // launch `iss`, default the canonical Portal URL
  onRegistered,             // (registration) => void
  sessionCookie,            // 'ss_session'
  sessionTtlMs,             // 8 h
  onlineLaunchConsume,      // also burn launches at POST /v1/product/launch/consume
  requestIdHeader,          // 'x-request-id'
  cache: { entitlementTtlMs /* 5 min */, revocationSyncMs /* ≤ 5 min */ },
  devProbes,                // true → mount /v1/ss-probe/* (only when nodeEnv !== 'production')
  nodeEnv,                  // default process.env.NODE_ENV
}) → product = {
  manifest,
  registration: { handle({ headers, body }) → { status, body } },     // POST /.well-known/ss-register
  events: {
    handle({ headers, rawBody }) → { status, body },                   // POST /.well-known/ss-events (event signatures)
    on(type, handler) → unsubscribe,                                   // type: 'name@v' | 'name' | '*'; handler(event, { source, website? })
    dispatch(event, meta) → { duplicate },                             // dedupe on event id, then handlers
    effects(websiteId, eventId) → number,                              // handler runs (dev probes only, else 0)
  },
  manifestRoute: () => ({ status: 200, body: manifest }),              // GET /.well-known/ss-app.json
  launch: {
    verify(token) → { ok: true, claims, role, scope } | { ok: false, code },   // role: merchant|demo|platform_admin|impersonate|partner|developer
    exchange(token, { ttlMs }?) → { ok: true, session } | { ok: false, code },  // opaque session `ses_…`; impersonation ends at impExp
    session(id) → session | null,  logout(id),
  },
  keys: {
    verify(authorizationHeader, { origin, referer, requiredScopes, expectedKind, expectedEnv })
      → { ok: true, website: { websiteId, merchantId, domain, allowSubdomains, env, scopes, kind, keyId } }
      | { ok: false, code: unauthorized|invalid_credentials|origin_not_allowed|scope_missing|forbidden|unavailable, detail },
    revoke(keyIds), sync(), isRevoked(keyId),
  },
  entitlements: {
    forWebsite(websiteId) → { ok: true, doc, stale, version, fetchedAt } | { ok: false, reason: not_subscribed|unavailable|invalid },
    refresh(websiteId), invalidate(websiteId),
    can(doc, elementKey), feature(doc, 'element.feature'), config(doc, elementKey), featuresOf(doc, elementKey),
  },
  usage: {
    record({ websiteId, subscriptionId?, unit, quantity, idempotencyKey, occurredAt? }) → { ok, duplicate },  // subscriptionId defaults from the entitlement
    flush({ maxBatches }?) → { sent, duplicates, rejected, failed, batches },
    stats() → { pending, sent, dead },
  },
  portal: {                                                            // signed client (client assertion, aud = Portal URL)
    entitlements(websiteId), revocations({ since }), usage(records, { idempotencyKey }), consumeLaunch({ jti }),
    heartbeat({ version, status, queues? }), rotateKey({ publicJwk }), resolveResource({ websiteId, kind }), jwks(),
    publishEvent({ websiteId, type, data, idempotencyKey, env?, occurredAt?, context? }) → envelope,
      // fills id (evt_…), occurredAt, env (from the website's entitlement), actor { type: 'product', id: slug },
      // context { source: 'product', product: slug }; type must be in the product namespace or manifest `events.publishes`
    publishEvents(envelopes),                                          // raw: POST /v1/product/events { events: [...] }
    baseUrl, jwksUrl,
  },
  data: {
    forWebsite(websiteId, { merchantId?, env? }?) → {
      websiteId, prefix,                                               // 'ss_<slug with - → _>_'
      collection(name) → guarded collection: find, findOne, countDocuments, distinct, aggregate, insertOne, insertMany,
        updateOne, updateMany, replaceOne, findOneAndUpdate, findOneAndDelete, deleteOne, deleteMany
        // filters / first $match must pin websiteId; inserts stamped websiteId, merchantId, env, createdAt, updatedAt, schemaVersion
      ensureIndexes(defs) → { created },   // defs: [{ collection, keys|key, name?, unique?, sparse?, expireAfterSeconds?, partialFilterExpression? }]
                                           //   or { [collection]: [{ keys|key, ... }] }; websiteId first (TTL single-field excepted)
      migrate([{ version, name?, up(scope) }]) → { version, applied },  // lazy, versioned, lock document
      transaction(async (session) => …),
    },
    forget(websiteId), closeIdle({ idleMs }?), closeAll(), prefix,
  },
  connectors: { ai(websiteId), messaging(websiteId), storage(websiteId), payments(websiteId), forget(websiteId) },
    // storage: { presignPut({ key, contentType?, expiresIn? }), presignGet({ key, expiresIn?, downloadName? }), headObject, deleteObject, keyFor }
    // ai: { request, complete(input) }   messaging: { request, send(message) }
    // payments: interface { createPayment, capture, refund, status, verifyWebhook } — provided by an injected adapter
  audit: { record({ websiteId, actor: { type, id?, act? }, action, target?, before?, after?, requestId? }) → { ok, id? } },
  health: { healthz() → { status, body }, readyz() → { status: 200|503, body: { status: ok|degraded|unavailable, checks } } },
  handler(routes, options?) → (Request) → Promise<Response>,         // = createRequestHandler(product, routes, options)
  heartbeat() → Portal heartbeat { version, status: 'ok', queues: { usagePending, usageDead } },
  close(),                                                             // close pooled client-DB connections
  context,                                                             // internal wiring used by the handler and standardRoutes
}
```

**Registration audience:** a registration request without a signed `aud` is rejected (generic 401, logged reason
`audience_missing`). The `aud` must equal
`manifest.endpoints.base` (trailing-slash and case-insensitive host variants included), the appId, or a
`registrationAudience` value. The appId is the known one, or the request's `appId` before registration. All other
handshake rules are those of `@ss/protocol` `createRegistrationHandler`.

### Routes

```js
createRequestHandler(product, routes, { basePath?, maxBodyBytes? = 1 MiB, requestIdHeader?, trustForwardedFor? = true })
defineRoute({
  method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE', path,   // `:id` segments are params; '/v1/data:export' is a literal segment
  auth: 'website'|'launch'|'portal'|'none',
  scopes?, keyKind?: 'pk'|'sk', roles?, element?,      // element: 403 element_disabled unless enabled (402/403 for spend_cap/paused)
  idempotent?: true|'optional'|false,                  // POST default true (428 without Idempotency-Key); replay of stored response
  rateLimit?: { limit, windowMs | windowSeconds, key?(ctx) },
  rawBody?, maxBodyBytes?, entitlement?: false, cors?,
  handler(ctx) → ok()/created()/noContent()/problem() result | Response | plain value (→ 200 JSON) | undefined (→ 204)
})
ctx = { request, requestId, method, path, params, query /* { name: first value } */, searchParams, headers, body, rawBody,
        idempotencyKey, website, websiteId, entitlement: { doc, stale, version } | null, session | null, portal | null,
        product, log }
```

- `auth: 'portal'` verifies with `@ss/protocol` `verifyRequest({ method, path, audience: appId, headers, rawBody, keyResolver,
replayStore })`. The path is the one the client addressed, including the query; `toNextRoute` keeps the path from before
  it stripped `/api`.
- `auth: 'launch'` takes the session from the `ss_session` cookie or `Authorization: Bearer ses_…`. The website is the
  session's only website or `X-SS-Website`, which must be within the session scope.

```js
ok(body, { status?, headers? }) ; created(body, { location?, headers? }) ; noContent() ;
problem(code, detail?, { errors?, headers?, status? })   // return or throw; RFC 9457 with requestId + instance
paginate({ cursor, limit, url? }, { defaultLimit = 20, maxLimit = 100 })
  → { limit, after, fetchLimit, page(items, keyOf?) → { items, nextCursor, hasMore },
      link(nextCursor) → '<path?cursor=…&limit=…>; rel="next"' | null,
      respond(items, keyOf?) → ok({ items, nextCursor, hasMore }) with the `Link` header }
toNextRoute(handler, { stripPrefix = '/api' | false }?) → { GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS }
```

`standardRoutes(product, { wellKnown = true, sso = true }?)` returns:

- `GET /v1/entitlement`, `GET /v1/config?element=a,b` and `POST /v1/events` (website key).
- `GET /v1/strings?lang=` (none).
- `GET /healthz` and `GET /readyz`.
- `POST /v1/data:export` and `POST /v1/data:anonymize` (portal; body `{ websiteId, subject?, requestId? }`).
- `GET /.well-known/ss-app.json`, `POST /.well-known/ss-register` and `POST /.well-known/ss-events`.
- `GET /sso?launch=`, which sets the `ss_session` cookie and redirects with 303 to `endpoints.dashboard`.
- With `createProduct({ devProbes: true })` (never in production), mounted by `standardRoutes`, website key:
   - `GET /v1/ss-probe/data-guard` → `{ rejected, code }`: runs a query without `websiteId` through the guard.
   - `GET /v1/ss-probe/events/:id` → `{ id, effects }`: how many times handlers ran for that event id.

### Stores (product's own control DB, NOT the client DB)

`createMongoStores({ db, prefix = 'ss_kit_', now? })` and `createMemoryStores({ now? })` return:

```
{ replay, nonce, burnedTokens, entitlements, usageQueue, revocations, sessions, idempotency, rateLimits, portalKeys, ping }
```

Mongo stores also provide `ensureIndexes()` and `collections`. The interfaces are in `src/stores/types.js`.

### Environment

`configFromEnv(env = process.env)` → `{ portalUrl, appId, signingKey, registrationTokenHash, productDbUri, logLevel }`. It reads
`SS_PORTAL_URL`, `SS_APP_ID`, `SS_APP_SIGNING_KEY` (private JWK JSON), `SS_REGISTRATION_TOKEN_HASH`, `SS_PRODUCT_DB_URI`
(the product's own control DB) and `SS_LOG_LEVEL`.

### Portal endpoints app-kit calls

These calls are signed with a client assertion. Formats are in PLAN.md F.9.

- `GET /v1/product/entitlements?websiteId=` and `GET /v1/product/revocations?since=`.
- `POST /v1/product/usage` (batch, with `Idempotency-Key`).
- `POST /v1/product/launch/consume`, `POST /v1/product/heartbeat` and `POST /v1/product/keys/rotate`.
- `POST /v1/product/events` with `{ events: [...] }`.
- `POST /v1/product/resources/resolve`.
- `GET /.well-known/jwks.json`, which is unsigned. The last good copy is persisted in `portalKeys`.
