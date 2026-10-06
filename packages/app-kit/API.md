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
	resource,
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
	createSmtpMessaging,
	SMTP_PORTS,
	createOutbox,
	createBackground,
	CONTROL_DB_POOL_SIZE,
	CLIENT_DB_POOL_SIZE,
	REPLAY_COLLECTION,
	REPLAY_HEADERS,
	RESERVED_PROBLEM_MEMBERS,
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
	createIdentity,
	verifyIdentityToken,
	identityTokenOf,
	IDENTITY_HEADER,
	IDENTITY_MAX_AGE_MS,
	sweepStaleUploads,
	SWEEP_DEFAULT_LIMIT,
	SWEEP_MAX_LIMIT,
} from '@ss/app-kit';
import { createFakePortal, createTestIdentityIssuer, entitlementPayload } from '@ss/app-kit/testing'; // tests / `ss dev` only
// createTestIdentityIssuer({ alg, kid, issuer, audience, claimMap }) → { section, sign(claims, header?) }:
//   a website identity issuer for tests — pass `section` as `setEntitlement({ identity })`, send `sign(...)` in SS-Identity
```

### Bootstrapping

```js
createProduct({
  manifest,                 // validated SSPS manifest (service product, features inline) — throws AppKitError invalid_manifest
  stores,                   // Partial<Stores>; default in-memory (dev only); production: createMongoStores({ db }) — the
                            // product's control database also keeps the Portal connection, its key and generated secrets
  connectSecret,            // CONNECT_SECRET (≥ 32 chars); without it POST /.well-known/ss-connect answers 503
  portalUrl, appId, signingKey,   // optional FIXED connection (tests, tools); omit them: the Portal connects at /.well-known/ss-connect
  fetch, now, randomBytes, logger,
  strings,                  // { [lang]: { key: text } } or async (lang) => catalog | null — served at GET /v1/strings
  defaultLang,              // 'en'
  data: { indexes, migrations, createClient, clientOptions, idleMs },   // indexes/migrations applied lazily per website
  privacy: { collections: [{ name, subjectField = 'customerId', fields: [] }] } | { export(input), anonymize(input) },
  connectors: { [kind]: { [provider]: (ctx) => adapter } },             // e.g. payments adapters; ctx = { descriptor, websiteId, slug, send, policy, fetch, now }
  outbound: { allowHosts, allowHttpForAllowed, ports, maxRedirects, timeoutMs, maxBytes, resolve },
                            // @ss/net createOutboundPolicy options for connector calls; allowHosts ignored when nodeEnv === 'production'
  outboundSend,             // (url, init) => { status, headers, body: Buffer, url } — replaces @ss/net safeFetch (tests; also behind outbound.fetch)
  createSmtpTransport,      // replaces nodemailer's transport of the built-in smtp messaging adapter (tests)
  background: { mode },     // queue delivery after requests (below): 'on' (default; 'auto' is an alias) | 'off' (default when NODE_ENV=test)
  auditSink,                // async (entry) => void; default: merchant DB collection `audit`
  problemBaseUri,           // RFC 9457 type base, default `<endpoints.base>/problems/`
  problemCodes,             // product-specific { code: { status, title } }
  portalIssuer,             // launch `iss`, default the canonical Portal URL
  sessionCookie,            // 'ss_session'
  sessionTtlMs,             // 8 h
  onlineLaunchConsume,      // also burn launches at POST /v1/product/launch/consume
  requestIdHeader,          // 'x-request-id'
  cache: { entitlementTtlMs /* 5 min */, revocationSyncMs /* ≤ 5 min */ },
  devProbes,                // true → mount /v1/ss-probe/* (only when nodeEnv !== 'production')
  nodeEnv,                  // default process.env.NODE_ENV
}) → product = {
  manifest,
  ready() → Promise,                                                   // load the generated secrets and the connection (cached; the handler awaits it)
  connected() → boolean,                                               // false until the Portal connected it (routes then answer 503)
  secret(label) → Buffer,                                              // a secret generated once and kept in the control DB, derived per label
  baseUrl() → string,                                                  // this deployment's address (recorded at connect)
  handleConnect({ headers, rawBody }) → { status, headers, body },     // POST /.well-known/ss-connect (shared-secret onboarding)
  events: {
    handle({ headers, rawBody }) → { status, body },                   // POST /.well-known/ss-events (event signatures)
    on(type, handler) → unsubscribe,                                   // type: 'name@v' | 'name' | '*'; handler(event, { source, website? })
    dispatch(event, meta) → { duplicate },                             // dedupe on event id, then handlers
    effects(websiteId, eventId) → number,                              // handler runs (dev probes only, else 0)
  },
  manifestRoute: async () => ({ status: 200, body: manifest, headers }),  // GET /.well-known/ss-app.json
        // headers: cache-control public, max-age=300; ss-manifest-signature: <@ss/protocol signManifest JWS> once the appId is known
  launch: {
    verify(token) → { ok: true, claims, role, scope } | { ok: false, code },   // role: merchant|demo|platform_admin|impersonate|partner|developer
    exchange(token, { ttlMs }?) → { ok: true, session } | { ok: false, code },  // opaque session `ses_…`; impersonation ends at impExp
    session(id) → session | null,  logout(id),
  },
  keys: {
    verify(authorizationHeader, { origin, referer, requiredScopes, expectedKind, expectedEnv })
      → { ok: true, website: { websiteId, merchantId, domain, allowSubdomains, env, scopes, kind, keyId } }
      | { ok: false, code: unauthorized|invalid_credentials|origin_not_allowed|scope_missing|forbidden|unavailable, detail },
    // a cold instance's concurrent first requests await the one in-flight revocation sync (single-flight) instead of
    // answering 503; `unavailable` only when revocations could not be synced within the offline grace
    revoke(keyIds), sync(), isRevoked(keyId),
  },
  entitlements: {
    forWebsite(websiteId) → { ok: true, doc, stale, version, fetchedAt } | { ok: false, reason: not_subscribed|unavailable|invalid },
    refresh(websiteId),            // fetch now
    invalidate(websiteId),         // the next forWebsite(websiteId) fetches from the Portal (cached copy kept as offline fallback)
    can(doc, elementKey), feature(doc, 'element.feature'), config(doc, elementKey), featuresOf(doc, elementKey),
    resource(doc, kind) → { kind, status: connected|missing|failing|revoked, connected },
      // F.18: an element with requires.optionalResources stays on without them — check resource(doc, kind).connected
      // before using one (e.g. catalog media without storage keeps working with external image URLs)
  },
  identity: {                                                          // bring-your-own customer identity (PLAN F.14)
    verify(request, { doc, body? }) → { ok: true, identity: { subject, email?, phone?, issuer, claims } } | { ok: false, code },
      // claims = the full verified JWT payload (deep-frozen), e.g. a tier claim: identity.claims.tier
      // reads SS-Identity (else body.identity, sendBeacon); verifies the JWT with doc.identity (issuer keys inline):
      // EdDSA | ES256 | RS256 matched to the key type, kid (or the only compatible key), iss, aud (when configured),
      // exp (required), nbf, iat (required, ≤ 24 h old), 60 s skew; codes: identity_missing | identity_not_configured |
      // malformed | algorithm | unknown_key | signature | issuer | audience | expired | not_yet_valid | too_old | subject
    verifyToken(token, identitySection) → same result,
  },
  usage: {
    record({ websiteId, subscriptionId?, unit, quantity, idempotencyKey, occurredAt? }) → { ok, duplicate },  // subscriptionId defaults from the entitlement
    flush({ maxBatches, websiteId }?) → { sent, duplicates, rejected, failed, batches },  // websiteId: only that website's records
    stats() → { pending, sent, dead },
  },
  portal: {                                                            // signed client (client assertion, aud = Portal URL)
    entitlements(websiteId), revocations({ since }), usage(records, { idempotencyKey }), consumeLaunch({ jti }),
    heartbeat({ version, status, queues? }), rotateKey({ publicJwk }), resolveResource({ websiteId, kind }), jwks(),
    publishEvent({ websiteId, type, data, idempotencyKey, id?, env?, occurredAt?, context? }) → envelope,
      // fills id (evt_… derived from (websiteId, type, idempotencyKey) unless given), occurredAt, env (from the website's
      // entitlement), actor { type: 'product', id: slug }, context { source: 'product', product: slug }; type must be in
      // the product namespace or manifest `events.publishes`. DURABLE: the envelope is written to the control-store outbox
      // (idempotent by event id), sent right away when the Portal answers, else retried with backoff by outbox.flush() /
      // the next request for that website (never by a timer); Portal `rejected` results and permanent 4xx are dead-lettered (kept 7 days). A delivery
      // failure never throws; invalid input still throws invalid_event.
    publishEvents(envelopes),                                          // raw: POST /v1/product/events { events: [...] }
    requestIdentityIssuer({ websiteId, issuer, jwksUrl | publicJwks, audience?, claimMap? })
      → { status: 'pending', request } | { status: 'active', issuer },
      // PUT /v1/product/websites/:websiteId/identity: ask to become the website's identity issuer (bring-your-own
      // identity). Needs manifest capabilities.identityIssuer: true and an active subscription on the website (else
      // portal_error 403). Stored pending (202) until the merchant approves it in the Portal (Website → Identity); a
      // request equal to the active issuer answers active (200) — safe to repeat. Errors throw portal_error.
    baseUrl, jwksUrl,
  },
  outbox: { flush({ maxBatches, websiteId }?) → { sent, duplicates, rejected, failed, batches }, stats() → { pending, sent, dead } },
    // event outbox (store `eventOutbox`, collection ss_kit_event_outbox): batches ≤ 50 events / ~200 kB per
    // POST /v1/product/events; per-event results { id, status: accepted|duplicate|rejected }; envelope dropped once sent
  outbound: {
    fetch(url, init?) → { status, headers, body: Buffer, url },   // @ss/net safeFetch under the product's outbound policy:
    policy,                                                        // public https only, DNS answers vetted at connect time,
  },                                                               // same-origin GET/HEAD redirects, deadline, size cap
  flush() → Promise<void>,           // send everything due in the usage queue and the event outbox now (single-flight)
  background: { mode: 'on'|'off' },  // queue delivery after requests (below)
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
    // built-ins keyed by descriptor.provider as the Portal resolves it: storage `s3` (default); ai `http` (default) /
    //   `generic-http`; messaging `http` (default) / `generic-http` (JSON POST through `send`) and `smtp` (nodemailer)
    // storage: keys are ALWAYS relative to `<prefix><slug>/<websiteId>/` in arguments and results (an absolute key → invalid_key):
    //   presignPut({ key, contentType?, contentLength?, expiresIn? = 300 }) → { method: 'PUT', url, headers, key, expiresAt }
    //     content-type and content-length are SigV4 signed headers, so the bucket enforces type and exact size; the
    //     client must send exactly `headers` (browsers set Content-Length from the body)
    //   presignGet({ key, expiresIn?, downloadName? }) → { method: 'GET', url, key, expiresAt }
    //   headObject({ key }) → { exists: false } | { exists: true, size, contentType, etag };  deleteObject({ key }) → { deleted: true }
    //   fullKey(key) → absolute object key (keyFor = deprecated alias)
    // ai: { request, complete(input) }   messaging (http): { request, send(message) }
    // messaging (smtp): send({ to (1..50), subject, text?, html?, from?, replyTo?, headers? }) → { id, accepted, rejected };
    //   descriptor baseUrl smtps://host:port (implicit TLS) | smtp://host:port (STARTTLS, requireTLS) or host/port/secure,
    //   username|user, apiKey|password, from?; TLS ≥ 1.2 with certificate checks required except for outbound.allowHosts
    //   (ignored in production); host vetted with checkHost (ports 25/465/587/2525) and every send dials an IP vetted by
    //   resolveVetted (SNI = host); timeouts connect 10 s / greeting 10 s / socket 30 s; CR/LF and reserved headers refused;
    //   errors invalid_argument | resource_invalid | timeout | upstream_error (details.reason, responseCode), never credentials
    // every connector call goes through @ss/net safeFetch under the `outbound` policy: https only, public addresses only
    // (checked again on each DNS answer at connect time), no redirects for providers, size cap; endpoints/baseUrls that
    // fail the policy are refused up front with resource_invalid
    // payments: interface { createPayment, capture, refund, status, verifyWebhook } — provided by an injected adapter
  audit: { record({ websiteId, actor: { type, id?, act? }, action, target?, before?, after?, requestId? }) → { ok, id? } },
  health: { healthz() → { status, body }, readyz() → { status: 200|503, body: { status: ok|degraded|unavailable, checks } } },
  handler(routes, options?) → (Request) → Promise<Response>,         // = createRequestHandler(product, routes, options)
  heartbeat() → flushes the queues, then Portal heartbeat { version, status: 'ok', queues: { usagePending, usageDead, eventsPending, eventsDead } },
  close(),                                                             // close pooled client-DB connections
  context,                                                             // internal wiring used by the handler and standardRoutes
}
```

**Connection (`/.well-known/ss-connect`).** A product is configured with its control database and `CONNECT_SECRET`
(`connectSecret`, ≥ 32 chars). Until it is connected, every route except `/.well-known/ss-connect`, `/healthz`,
`/readyz` and `/.well-known/ss-app.json` answers 503 ("not connected… Portal: Admin → Apps → Add product"). The Portal
(Admin → Apps → Add product: URL + secret) sends `POST /.well-known/ss-connect` with `{ portalUrl, jwks, appId,
baseUrl, nonce }`, `SS-Connect-Timestamp` and `SS-Connect-Signature` (HMAC-SHA256 with the secret, `@ss/protocol`
`createConnectRequest`). `handleConnect` verifies it (`verifyConnectRequest`: constant time, ± 5 min, nonce single-use
via a TTL record), generates the product's Ed25519 key if none, stores `{ portalUrl, appId, baseUrl }` plus the Portal
JWKS and answers `{ appId, nonce, publicJwk, manifest }` signed with the same secret (`createConnectResponse`). Without
a secret it answers 503. The served manifest carries the recorded https address as `endpoints.base`. Connecting again
with the right secret replaces the binding; to lock a Portal out, change `CONNECT_SECRET` and connect from the right
Portal. Other instances pick a new connection up within a second. Generated secrets: one 32-byte root secret (`setting:secrets`), derived per
purpose with `product.secret(label)` (the idempotency HMAC key, product token secrets).

### Routes

```js
createRequestHandler(product, routes, { basePath?, maxBodyBytes? = 1 MiB, requestIdHeader?, trustForwardedFor? = true })
defineRoute({
  method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE', path,   // `:id` segments are params; '/v1/data:export' is a literal segment
  auth: 'website'|'launch'|'portal'|'none',
  scopes?, keyKind?: 'pk'|'sk', roles?, element?,      // element: 403 element_disabled unless enabled (402/403 for spend_cap/paused)
  idempotent?: true|'optional'|false,                  // POST default true (428 without Idempotency-Key); replay (see below)
  rateLimit?: { limit: number | (ctx) => number | Promise<number>, windowMs | windowSeconds, key?(ctx), bucket? },
                                                       // evaluated after auth, entitlement, JSON body and identity;
                                                       // limit ≥ 0 integer (0 = refuse all) or Infinity (no limit); an invalid
                                                       // or throwing limit is logged and not enforced; `bucket` shares one
                                                       // window between routes (default: the route id); 429 rate_limited + RateLimit-*
  rawBody?, maxBodyBytes?, entitlement?: false, cors?,
  identity?: 'required'|'optional',                    // website auth: ctx.identity from SS-Identity (401 identity_required |
                                                       // identity_invalid when required; null + ctx.identityProblem when optional)
  handler(ctx) → ok()/created()/noContent()/problem() result | Response | plain value (→ 200 JSON) | undefined (→ 204)
})
ctx = { request, requestId, method, path, params, query /* { name: first value } */, searchParams, headers, body, rawBody,
        idempotencyKey, website, websiteId, entitlement: { doc, stale, version } | null, session | null, portal | null,
        identity: { subject, email?, phone?, issuer, claims } | null, identityProblem: string | null, product, log }
```

**Idempotency and privacy.** The product's control store keeps, per Idempotency-Key, only `{ _id: HMAC(principal, route,
path, key), fingerprint: HMAC(method, path, query, body), response: { status, headers (allowlist: content-type,
content-language, location, link, etag, last-modified, cache-control), replay: 'empty' | 'website' | 'none' } }` (HMAC key
derived from the product signing key, TTL 24 h). The response **body** of a route with a website (`ctx.websiteId`) is
stored in the merchant's own database (`ss_<slug>_idempotency` `{ websiteId, key, body, expireAt }` via
`data.forWebsite`, unique `(websiteId, key)`, TTL 24 h). Routes without a website (e.g. `auth: 'portal'`) store no body;
a replay of a response that had a body that is not available (no website, merchant DB down, expired) answers **409
`idempotency_replay_no_body`** — never a second execution. 5xx results are not stored.

**Queue delivery on requests (no timers).** Nothing in the kit runs on a timer, polls or sweeps (PLAN F.19:
event-driven only). An event is sent inside the request that publishes it. After a request, the kit sends the usage
and events queued on this instance since the last run and the due retries of the request's website (`ctx.websiteId`),
one batch per website and queue: a send that failed is retried by the next request of this product for that website.
The run goes through the framework's `after()` when the adapter provided one (`toNextRoute(handler, { after })` with
`import { after } from 'next/server.js'`), else in the background of the request. Mode `off` (the test default) leaves
sending to explicit `usage.flush()` / `outbox.flush()` / `product.flush()`; `heartbeat()` sends everything first.

**No periodic product work.** Products register no crons and no background loops. Anything with an expiry is treated
as expired when read and cleaned up when touched (or by a MongoDB TTL index: `ensureIndexes` accepts
`expireAfterSeconds`); work that must be started without a customer request runs on the event or request that makes
it relevant, or from a dashboard button.

**Connection budget.** `configFromEnv().productDbOptions` are the control-database `MongoClient` options: pool
`DATABASE_MAX_POOL_SIZE` (default `CONTROL_DB_POOL_SIZE` = 5), `minPoolSize` 0, idle connections closed after
60 s. Create the client once per instance (in the composition root that is cached on `globalThis`), never per
request. Merchant database pools are `CLIENT_DB_POOL_SIZE` (3) per instance, cached on `globalThis` and closed when
idle (checked when the next website is served; no timer).

```js

```

- `auth: 'portal'` verifies with `@ss/protocol` `verifyRequest({ method, path, audience: appId, headers, rawBody, keyResolver,
replayStore })`. The path is the one the client addressed, including the query; `toNextRoute` keeps the path from before
  it stripped `/api`.
- `auth: 'launch'` takes the session from the `ss_session` cookie or `Authorization: Bearer ses_…`. The website is the
  session's only website or `X-SS-Website`, which must be within the session scope.

```js
ok(body, { status?, headers? }) ; created(body, { location?, headers? }) ; noContent() ;
problem(code, detail?, { errors?, headers?, status?, extensions? })   // return or throw; RFC 9457 with requestId + instance
  // extensions: RFC 9457 extension members, names /^[A-Za-z][A-Za-z0-9_]{2,63}$/, JSON values; may not redefine
  // type, title, status, detail, instance, requestId, errors (TypeError at construction)
paginate({ cursor, limit, url? }, { defaultLimit = 20, maxLimit = 100 })
  → { limit, after, fetchLimit, page(items, keyOf?) → { items, nextCursor, hasMore },
      // keyOf may return a compound key (array of ≤ 8 strings/numbers/booleans/nulls/Dates → ISO strings), e.g.
      // (r) => [r.createdAt, r.id]; the cursor encodes it opaquely and `after` is that array on the next page
      link(nextCursor) → '<path?cursor=…&limit=…>; rel="next"' | null,
      respond(items, keyOf?) → ok({ items, nextCursor, hasMore }) with the `Link` header }
toNextRoute(handler, { stripPrefix = '/api' | false, after? }?) → { GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS }
  // export OPTIONS too (CORS preflight); `after` = Next's after() for the post-response background flush
```

`standardRoutes(product, { wellKnown = true, sso = true }?)` returns:

- `GET /v1/entitlement`, `GET /v1/config?element=a,b` and `POST /v1/events` (website key).
- `GET /v1/strings?lang=` (none).
- `GET /healthz` and `GET /readyz`.
- `POST /v1/data:export` and `POST /v1/data:anonymize` (portal; body `{ websiteId, subject?, requestId? }`).
- `GET /.well-known/ss-app.json` and `POST /.well-known/ss-events`.
- `POST /.well-known/ss-connect` (none; HMAC with `CONNECT_SECRET`, also while unconnected).
- `GET /sso?launch=`, which sets the `ss_session` cookie and redirects with 303 to `endpoints.dashboard`.
- With `createProduct({ devProbes: true })` (never in production), mounted by `standardRoutes`, website key:
   - `GET /v1/ss-probe/data-guard` → `{ rejected, code }`: runs a query without `websiteId` through the guard.
   - `GET /v1/ss-probe/events/:id` → `{ id, effects }`: how many times handlers ran for that event id.

### Stale uploads

```js
sweepStaleUploads({
  collection,               // guarded collection of data.forWebsite(websiteId): one record per presigned upload slot
  websiteId,                // pinned in every filter
  storage,                  // connectors.storage(websiteId), or async () => storage (resolved only when something is stale)
  now = Date.now, olderThanMs = 0,   // records with record[field] <= now - olderThanMs are stale
  field = 'staleAt',        // the record's "stale at" date
  filter = {},              // extra conditions, e.g. { status: 'pending' } (may not set websiteId or field)
  keyOf = (record) => record.key,    // RELATIVE object key; null/'' -> no object
  limit = 100,              // per run, clamped to 1..SWEEP_MAX_LIMIT (1000), oldest first
  mark = null,              // { ...$set } to keep the record (field is $unset) instead of deleting it
  onDeleted(record, { existed }), onError(record | null, error),
}) → { scanned, deleted, missing, failed }
```

Per stale record: `storage.headObject({ key })`, `deleteObject` when it exists, then `deleteOne` (or the `mark` update) with
a compare-and-set filter (the stale query plus `_id`), so a record confirmed meanwhile is kept. A storage or database
error counts as `failed` and leaves the record for the next run; an unresolvable storage fails the whole batch. Safe to
repeat and to run concurrently. The product indexes `{ websiteId, …filter fields, [field] }`, keeps a TTL index on a
later date as a backstop, and refuses to confirm a slot past its stale date (so deleting its object is always safe).

### Stores (product's own control DB, NOT the client DB)

`createMongoStores({ db, prefix = 'ss_kit_', now? })` and `createMemoryStores({ now? })` return:

```
{ replay, nonce, settings, entitlements, usageQueue, eventOutbox, revocations, sessions, idempotency, rateLimits, portalKeys, ping }
```

Mongo stores also provide `ensureIndexes()` and `collections`. The interfaces are in `src/stores/types.js`.

### Environment

`configFromEnv(env = process.env)` → `{ productDbUri, productDbOptions, connectSecret, logLevel, outboundAllowHosts }`.
It reads `DATABASE_URI` (the product's own control DB) and `CONNECT_SECRET` (the connect secret) — the two variables a
deployment needs — and optionally
`DATABASE_MAX_POOL_SIZE` (its pool, default 5) and `OUTBOUND_DEV_ALLOW_HOSTS` (comma-separated development allowlist
for `outbound.allowHosts`; ignored in production). `logLevel` is `info` in production and `debug` elsewhere. No value
is JSON, and no URL, key or other secret is read from the environment.

The merchant database is vetted with `@ss/net` `isSafeMongoUri` under the `outbound` policy before connecting (refused →
`resource_invalid`), and the `MongoClient` dials every host through `guardedLookup` (the `lookup` option cannot be
overridden by `data.clientOptions`).

### Portal endpoints app-kit calls

These calls are signed with a client assertion. Formats are in PLAN.md F.9.

- `GET /v1/product/entitlements?websiteId=` and `GET /v1/product/revocations?since=`.
- `POST /v1/product/usage` (batch, with `Idempotency-Key`).
- `POST /v1/product/launch/consume`, `POST /v1/product/heartbeat` and `POST /v1/product/keys/rotate`.
- `POST /v1/product/events` with `{ events: [...] }`.
- `POST /v1/product/resources/resolve`.
- `GET /.well-known/jwks.json`, which is unsigned. The last good copy is persisted in `portalKeys`.
