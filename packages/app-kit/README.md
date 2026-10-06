# @ss/app-kit

Everything a **service product** needs to follow the Product Standard (PLAN.md Part E): registration, SSO launches,
website keys, entitlements with offline grace, exactly-once usage reporting, signed events, client-owned data access,
connectors that run on the merchant's own credentials, audit, health, and a framework-agnostic HTTP layer with RFC 9457
problems. The binding API is [`API.md`](./API.md); this file is the quickstart.

- JavaScript ESM, functional, JSDoc-typed. Every side effect (fetch, clock, randomness, logger, stores, Mongo client) is
  injected, with defaults.
- All cryptography and validation come from `@ss/protocol` and `@ss/contracts`, and S3 SigV4 and SSRF-safe outbound
  networking come from `@ss/net`. The kit re-implements none of it. `presignUrl` and `signHeaders` remain as thin
  wrappers over `@ss/net` `presignV4` and `signV4`.
- Connector calls to merchant providers (AI, messaging, object stores) go through `@ss/net` `safeFetch` under the
  `outbound` policy. They accept only public https destinations, and every DNS answer is vetted at connect time. For a
  local MinIO or a mock provider in development, set `outbound: { allowHosts: ['localhost'] }`. The same policy guards the
  merchant database: the URI must pass `isSafeMongoUri`, otherwise it is refused with `resource_invalid`, and the
  `MongoClient` connects through `guardedLookup`. The allowlist is
  ignored in production.
- `GET /.well-known/ss-app.json` is cacheable for 5 minutes. Once the appId is known, it carries
  `SS-Manifest-Signature` (`@ss/protocol` `signManifest` with the product key).
- Platform-scoped control events (`scope: 'platform'`, no `websiteId`, e.g. `manifest.accepted@1`) are accepted and
  deduplicated under `platform`.
- The kit never writes to the console. Pass a logger (`createLogger({ level, write })` gives JSON lines). Fields that look
  like credentials (`uri`, `apiKey`, `secretAccessKey`, `token`, `authorization`, `descriptor`, …) are redacted.

## Quickstart

```js
// lib/product.js
import { MongoClient } from 'mongodb';
import { configFromEnv, createLogger, createMongoStores, createProduct } from '@ss/app-kit';
import manifest from '../manifest.json' with { type: 'json' };

const env = configFromEnv(); // PORTAL_URL, APP_ID, SIGNING_KEY, REGISTRATION_TOKEN_HASH, DATABASE_URI
const controlDb = new MongoClient(env.productDbUri, { maxPoolSize: 5 }).db(); // the product's OWN small DB

export const product = createProduct({
	manifest,
	portalUrl: env.portalUrl,
	appId: env.appId, // may be null: the id recorded at registration is used
	signingKey: env.signingKey, // `kid:seed` (Ed25519 seed, base64url)
	registrationTokenHash: env.registrationTokenHash,
	stores: createMongoStores({ db: controlDb }), // omit in development → in-memory stores
	logger: createLogger({ level: env.logLevel }),
	data: {
		indexes: [{ collection: 'coupons', keys: { websiteId: 1, code: 1 }, unique: true }],
		migrations: [{ version: 1, name: 'init', up: async (scope) => {} }],
	},
	privacy: { collections: [{ name: 'redemptions', subjectField: 'customerId', fields: ['email'] }] },
	strings: { en: { apply: 'Apply' }, pt: { apply: 'Aplicar' } },
});
```

```js
// lib/routes.js
import { created, defineRoute, paginate, problem, standardRoutes } from '@ss/app-kit';
import { product } from './product.js';

const routes = [
	...standardRoutes(product), // /v1/entitlement, /v1/config, /v1/events, /v1/strings, /healthz, /readyz,
	//                             /v1/data:export, /v1/data:anonymize, /.well-known/ss-{app.json,register,events}, /sso
	defineRoute({
		method: 'GET',
		path: '/v1/coupons',
		auth: 'website', // pk_/sk_ key, offline-verified, origin-checked (pk_), revocation-checked
		scopes: ['coupons.read'],
		element: 'codes', // 403 element_disabled unless enabled in the signed entitlement
		handler: async (ctx) => {
			const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
			const scope = await ctx.product.data.forWebsite(ctx.websiteId);
			const items = await scope
				.collection('coupons') // → ss_<slug>_coupons in the MERCHANT's database
				.find({ websiteId: ctx.websiteId, ...(page.after ? { code: { $gt: page.after } } : {}) })
				.sort({ code: 1 })
				.limit(page.fetchLimit)
				.toArray();
			return page.respond(items, (c) => c.code); // body { items, nextCursor, hasMore } + Link: <…>; rel="next"
		},
	}),
	defineRoute({
		method: 'POST',
		path: '/v1/coupons',
		auth: 'website',
		keyKind: 'sk',
		element: 'codes', // Idempotency-Key required on POST by default; replays return the stored response
		rateLimit: { limit: 60, windowMs: 60_000 },
		handler: async (ctx) => {
			if (typeof ctx.body?.code !== 'string') return problem('validation_failed', 'code is required');
			const max = product.entitlements.feature(ctx.entitlement.doc, 'codes.maxActive');
			const scope = await ctx.product.data.forWebsite(ctx.websiteId, ctx.website);
			const { insertedId } = await scope.collection('coupons').insertOne({ code: ctx.body.code, max });
			await ctx.product.usage.record({
				websiteId: ctx.websiteId,
				subscriptionId: ctx.entitlement.doc.subscriptionId,
				unit: 'redemption',
				quantity: 1,
				idempotencyKey: `coupon:${insertedId}`,
			});
			return created({ id: String(insertedId) }, { location: `/v1/coupons/${insertedId}` });
		},
	}),
];

export const handle = product.handler(routes); // (Request) → Promise<Response>
```

```js
// app/[[...path]]/route.js (Next.js App Router)
import { toNextRoute } from '@ss/app-kit';
import { handle } from '../../lib/routes.js';
import { after } from 'next/server.js';
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = toNextRoute(handle, { after }); // OPTIONS = CORS preflight
```

Nothing runs on a timer (PLAN F.19: event-driven only). Usage and events are sent on requests: an event is sent
inside the request that publishes it, and after a request (Next `after()` when passed to `toNextRoute`, else in the
background of the request) the kit sends the usage and events queued on this instance and the due retries of the
request's website — a send that failed is retried by the next request of this product for that website.
`product.heartbeat()` sends everything first and reports `{ version, status, queues }`; `usage.flush()`,
`outbox.flush()` and `product.flush()` remain for explicit use. `createProduct({ background: { mode: 'on' | 'off' } })`
(`off` under `NODE_ENV=test`).

Products have no crons and no periodic work: anything with an expiry is treated as expired when read and cleaned up
when touched (or by a MongoDB TTL index), and work that must be started without a customer request runs on the event
that makes it relevant or from a dashboard button. The control-database client takes `configFromEnv().productDbOptions`
(pool `DATABASE_MAX_POOL_SIZE`, default 5); merchant database pools hold 3 connections per instance and are closed
when idle (checked when the next website is served).

Route handlers receive `ctx = { website, websiteId, query, searchParams, body, params, idempotencyKey, request, session,
entitlement, … }`. `query` holds the first value of each parameter; `searchParams` has all of them. `toNextRoute` strips a
leading `/api`, so routes are declared as `/v1/...` behind the usual `/v1/:path* → /api/v1/:path*` rewrite.

`product.portal.publishEvent({ websiteId, type, data, idempotencyKey })` builds the full envelope (`id` derived from
`(websiteId, type, idempotencyKey)`, `occurredAt`, `env` from the website's entitlement, `actor: product`, `context`) and
puts it in a **durable outbox** (control store, idempotent by event id): it is sent at once when the Portal answers and
otherwise retried with backoff; Portal rejections are dead-lettered. A Portal outage never loses or throws the event.

`product.portal.requestIdentityIssuer({ websiteId, issuer, jwksUrl, audience, claimMap })` asks the Portal to make the
product the website's identity issuer (`PUT /v1/product/websites/:websiteId/identity`; the manifest must declare
`capabilities.identityIssuer: true`). It resolves `{ status: 'pending', request }` until the merchant approves the
request in the Portal, then `{ status: 'active', issuer }` for the same body, so it is safe to call again; a refusal
(no subscription, capability missing, JWKS unusable) throws `portal_error` with the HTTP `status`.

`product.outbound.fetch(url, init)` is the SSRF-guarded fetch (`@ss/net` `safeFetch` under the product's outbound
policy) for merchant-chosen URLs such as knowledge pages or webhooks.

Route `rateLimit.limit` may be a function of the request (`(ctx) => feature(ctx.entitlement.doc, 'x.perMinute')`), and
`bucket` shares one window between routes. `problem(code, detail, { extensions })` adds RFC 9457 extension members.
`paginate` accepts compound keyset keys (`keyOf` returns an array). `ctx.identity.claims` is the full verified payload.
`product.usage.record` takes `subscriptionId` from the entitlement when it is omitted.

**Development probes** for `ss certify`: pass `devProbes: true`. They are never mounted when `NODE_ENV=production`.

- `GET /v1/ss-probe/data-guard` → `{ rejected, code }`
- `GET /v1/ss-probe/events/:id` → `{ id, effects }`

**Registration audience**: a signed `aud` may be `manifest.endpoints.base`, the appId, or a `registrationAudience` value.
A request without `aud` is rejected (generic 401, reason `audience_missing`).

## What each part does

| Part                                   | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `registration.handle({headers, body})` | `@ss/protocol` `createRegistrationHandler`: the signer comes from `SIGNING_KEY`, token burns and nonces live in the stores, and the Portal JWKS is fetched only from the pinned URL. The appId from the handshake is recorded, so other instances pick it up.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `events.handle({headers, rawBody})`    | Verifies the raw bytes (`verifyEvent`, ±300 s, replay store), validates the envelope, deduplicates on the event `id` and dispatches to `events.on(type, fn)` handlers (`name@v`, `name` or `*`). A failing handler answers 500 and the id is forgotten, so the retry runs. Built in: `entitlement.changed` → refresh, `key.revoked` → revoke, `resource.changed` → drop cached credentials.                                                                                                                                                                                                                                                                        |
| `launch.verify / exchange / session`   | `verifyLaunch` (single use via the shared replay store; optional Portal-side burn). Kinds map to roles `merchant, demo, platform_admin, impersonate, partner, developer`. `exchange` creates an opaque session (`ses_…`); impersonation sessions end at `impExp`.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `keys.verify(auth, opts)`              | Offline `verifyWebsiteKey` plus the revocation list (refreshed by a verification when older than ≤ 5 min, pushed by events, shared through the store), `originAllowed` for `pk_`, and required scopes (`coupons.*` globs). It **fails closed** (`unavailable`) when revocations could not be synced for longer than the offline grace; concurrent cold requests await the single in-flight sync.                                                                                                                                                                                                                                                                   |
| `entitlements.forWebsite(id)`          | Signed document from the Portal, verified with `verifyEntitlementDocument` and validated with `@ss/contracts`. It is fresh for 5 min, single-flight per website, and versions never go backwards; `invalidate(id)` forces a fetch on the next read. If the Portal is down, the last verified copy (memory, then the shared store) is served with `stale: true` until `validUntil + offlineGrace`. 404/410 from the Portal → `not_subscribed`. `can` / `feature` / `config` / `featuresOf` read the canonical document.                                                                                                                                             |
| `identity.verify(request, { doc })`    | Bring-your-own customer identity: the website's own login JWT from `SS-Identity` (or a beacon body's `identity`) verified offline against the issuer keys inline in the entitlement document (EdDSA/ES256/RS256, `iss`, `aud`, `exp`, `nbf`, `iat` ≤ 24 h). Route option `identity: 'required' \| 'optional'` fills `ctx.identity` `{ subject, email?, phone?, issuer }`.                                                                                                                                                                                                                                                                                          |
| `idempotency (handler)`                | The control store holds only HMACs of the key and request, the status and allowlisted headers. Response bodies live in the merchant's database (`ss_<slug>_idempotency`, TTL 24 h); without a website, or when the body is unavailable, a replay answers 409 `idempotency_replay_no_body` (never a re-run).                                                                                                                                                                                                                                                                                                                                                        |
| `usage.record / flush`                 | Durable queue keyed by `idempotencyKey`; a key stays unique even after it is sent (35-day retention). `flush` leases due records, posts batches with the same keys, acks `accepted`/`duplicate`, dead-letters `rejected`, and backs off exponentially with jitter on failure.                                                                                                                                                                                                                                                                                                                                                                                      |
| `data.forWebsite(id, stamp?)`          | Resolves `{ uri }` through `portal.resolveResource(kind: 'database')` and never keeps it past `expiresAt`. Pooled `MongoClient` (maxPoolSize 5, kept on `globalThis`, idle pools closed) and `ss_<slug>_` prefixes. The **tenant guard** requires `websiteId` in every filter and first `$match`, refuses `$where` and cross-collection stages, forbids changing `websiteId`, and stamps `websiteId/createdAt/updatedAt/schemaVersion`. Also provides `ensureIndexes`, `migrate` and `transaction`.                                                                                                                                                                |
| `connectors.*(websiteId)`              | Credentials come from `resolveResource` and are cached ≤ `expiresAt`. `storage`: S3-compatible presigned PUT/GET plus signed HEAD/DELETE, with keys confined to `<prefix><slug>/<websiteId>/`. `ai` / `messaging`: built-ins keyed as the Portal resolves them — `generic-http` (alias `http`; https only, relative paths only) and, for messaging, `smtp` (nodemailer, TLS required outside allowlisted dev hosts, vetted IPs, timeouts). Storage keys are always relative (`fullKey()` gives the object key); `presignPut` signs `content-length`. `payments`: interface only — register adapters with `connectors: { payments: { stripe: (ctx) => adapter } }`. |
| `audit.record(entry)`                  | Appends to `ss_<slug>_audit` in the merchant database (or to an injected `auditSink`). `before`/`after` never reach logs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `health.healthz / readyz`              | `readyz`: product control DB ping (failure → 503) and Portal JWKS reachability (cached 30 s). An unreachable Portal reports `degraded` with 200, because products keep serving on cached entitlements.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `handler(routes, opts)`                | Request id (header or generated), 404/405/CORS preflight, body cap (413), auth, entitlement and element gating, rate limit (429 with `RateLimit-*`), JSON (415/400), Idempotency-Key (428/409/replay; 5xx results are not stored), RFC 9457 problems with a configurable type base.                                                                                                                                                                                                                                                                                                                                                                                |
| `sweepStaleUploads(input)`             | Cron helper for presigned uploads that were never confirmed: per website, finds records past their `staleAt` (bounded, oldest first), deletes the object from the merchant's bucket when present, then deletes (or marks) the record with a compare-and-set. Returns `{ scanned, deleted, missing, failed }`; failures stay for the next run.                                                                                                                                                                                                                                                                                                                      |

### Auth modes

- `website` — `Authorization: Bearer pk_…|sk_…`. `ctx.website` is the key binding, which `X-SS-Website` can never override. The
  entitlement is loaded into `ctx.entitlement` (`stale` is also exposed as the `SS-Entitlement-Stale` header).
- `launch` — dashboard session from the `ss_session` cookie or `Bearer ses_…`. `roles` restricts access. The website is the
  session's only website or `X-SS-Website`, which must be within the session scope.
- `portal` — Portal-signed request, verified with `@ss/protocol` `verifyRequest`. The signature binds the method, the
  canonical path and query as addressed (kept even when `toNextRoute` strips `/api`), the audience (this product's appId) and
  the body hash. A signed call therefore cannot be replayed to another endpoint, method or product.
- `none`.

### Stores

`createMongoStores({ db, prefix = 'ss_kit_' })` puts everything in the product's **own** control database. It never
touches a merchant database. Collections: replay, nonce, registration, entitlements, usage_queue, event_outbox, revocations, state (revocation
cursor, last Portal JWKS), sessions, idempotency (HMACs + status only), rate_limits. The event outbox is the one place
an envelope is held, until it is delivered (dropped on success, dead letters kept ≤ 7 days). Unique `_id` and TTL indexes are created lazily. The
in-memory stores (the default) are per-process and are for development only.

## Testing your product

`@ss/app-kit/testing` exports `createFakePortal()`: a Portal built from `@ss/protocol` primitives that signs entitlement
documents, website keys, launches and events, verifies your client assertions, deduplicates usage, serves revocations and
resource descriptors, records identity-issuer requests (`identityRequests`, `decideIdentityRequest(websiteId,
'approve' | 'reject')`), and can simulate outages (`setDown(true)`, `failNext(path, status)`). Pass `portal.fetch` as
`fetch`. Test and development only.

```
pnpm check   # in this folder: format, lint, typecheck, vitest with coverage
```

The integration tests use `MongoMemoryReplSet` for the tenant guard, indexes, migrations (including concurrent runs and
lock waits), transactions and both store implementations. They also include a two-instance scenario on shared Mongo
stores (idempotency replay, launch replay, revocation propagation, usage exactly once, a cold instance serving stale during an outage).
