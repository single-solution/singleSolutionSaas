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

const env = configFromEnv(); // SS_PORTAL_URL, SS_APP_ID, SS_APP_SIGNING_KEY, SS_REGISTRATION_TOKEN_HASH, SS_PRODUCT_DB_URI, SS_LOG_LEVEL
const controlDb = new MongoClient(env.productDbUri, { maxPoolSize: 5 }).db(); // the product's OWN small DB

export const product = createProduct({
	manifest,
	portalUrl: env.portalUrl,
	appId: env.appId, // may be null: the id recorded at registration is used
	signingKey: env.signingKey, // private Ed25519 JWK (JSON)
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
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = toNextRoute(handle);
```

Run `product.usage.flush()` from a scheduled job (e.g. every minute). Send `product.heartbeat()` periodically; it reports
`{ version, status, queues }`.

Route handlers receive `ctx = { website, websiteId, query, searchParams, body, params, idempotencyKey, request, session,
entitlement, … }`. `query` holds the first value of each parameter; `searchParams` has all of them. `toNextRoute` strips a
leading `/api`, so routes are declared as `/v1/...` behind the usual `/v1/:path* → /api/v1/:path*` rewrite.

`product.portal.publishEvent({ websiteId, type, data, idempotencyKey })` builds the full envelope before sending it:
`id`, `occurredAt`, `env` from the website's entitlement, `actor: product` and `context`.
`product.usage.record` takes `subscriptionId` from the entitlement when it is omitted.

**Development probes** for `ss certify`: pass `devProbes: true`. They are never mounted when `NODE_ENV=production`.

- `GET /v1/ss-probe/data-guard` → `{ rejected, code }`
- `GET /v1/ss-probe/events/:id` → `{ id, effects }`

**Registration audience**: a signed `aud` may be `manifest.endpoints.base`, the appId, or a `registrationAudience` value.
A request without `aud` is rejected (generic 401, reason `audience_missing`).

## What each part does

| Part                                   | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registration.handle({headers, body})` | `@ss/protocol` `createRegistrationHandler`: the signer comes from `SS_APP_SIGNING_KEY`, token burns and nonces live in the stores, and the Portal JWKS is fetched only from the pinned URL. The appId from the handshake is recorded, so other instances pick it up.                                                                                                                                                                                                                                |
| `events.handle({headers, rawBody})`    | Verifies the raw bytes (`verifyEvent`, ±300 s, replay store), validates the envelope, deduplicates on the event `id` and dispatches to `events.on(type, fn)` handlers (`name@v`, `name` or `*`). A failing handler answers 500 and the id is forgotten, so the retry runs. Built in: `entitlement.changed` → refresh, `key.revoked` → revoke, `resource.changed` → drop cached credentials.                                                                                                         |
| `launch.verify / exchange / session`   | `verifyLaunch` (single use via the shared replay store; optional Portal-side burn). Kinds map to roles `merchant, demo, platform_admin, impersonate, partner, developer`. `exchange` creates an opaque session (`ses_…`); impersonation sessions end at `impExp`.                                                                                                                                                                                                                                   |
| `keys.verify(auth, opts)`              | Offline `verifyWebsiteKey` plus the revocation list (pulled every ≤ 5 min, pushed by events, shared through the store), `originAllowed` for `pk_`, and required scopes (`coupons.*` globs). It **fails closed** (`unavailable`) when revocations could not be synced for longer than the offline grace.                                                                                                                                                                                             |
| `entitlements.forWebsite(id)`          | Signed document from the Portal, verified with `verifyEntitlementDocument` and validated with `@ss/contracts`. It is fresh for 5 min, single-flight per website, and versions never go backwards. If the Portal is down, the last verified copy (memory, then the shared store) is served with `stale: true` until `validUntil + offlineGrace`. 404/410 from the Portal → `not_subscribed`. `can` / `feature` / `config` / `featuresOf` read the canonical document.                                |
| `usage.record / flush`                 | Durable queue keyed by `idempotencyKey`; a key stays unique even after it is sent (35-day retention). `flush` leases due records, posts batches with the same keys, acks `accepted`/`duplicate`, dead-letters `rejected`, and backs off exponentially with jitter on failure.                                                                                                                                                                                                                       |
| `data.forWebsite(id, stamp?)`          | Resolves `{ uri }` through `portal.resolveResource(kind: 'database')` and never keeps it past `expiresAt`. Pooled `MongoClient` (maxPoolSize 5, kept on `globalThis`, idle pools closed) and `ss_<slug>_` prefixes. The **tenant guard** requires `websiteId` in every filter and first `$match`, refuses `$where` and cross-collection stages, forbids changing `websiteId`, and stamps `websiteId/createdAt/updatedAt/schemaVersion`. Also provides `ensureIndexes`, `migrate` and `transaction`. |
| `connectors.*(websiteId)`              | Credentials come from `resolveResource` and are cached ≤ `expiresAt`. `storage`: S3-compatible presigned PUT/GET plus signed HEAD/DELETE, with keys confined to `<prefix><slug>/<websiteId>/`. `ai` / `messaging`: generic HTTP adapters (https only, relative paths only). `payments`: interface only — register adapters with `connectors: { payments: { stripe: (ctx) => adapter } }`.                                                                                                           |
| `audit.record(entry)`                  | Appends to `ss_<slug>_audit` in the merchant database (or to an injected `auditSink`). `before`/`after` never reach logs.                                                                                                                                                                                                                                                                                                                                                                           |
| `health.healthz / readyz`              | `readyz`: product control DB ping (failure → 503) and Portal JWKS reachability (cached 30 s). An unreachable Portal reports `degraded` with 200, because products keep serving on cached entitlements.                                                                                                                                                                                                                                                                                              |
| `handler(routes, opts)`                | Request id (header or generated), 404/405/CORS preflight, body cap (413), auth, entitlement and element gating, rate limit (429 with `RateLimit-*`), JSON (415/400), Idempotency-Key (428/409/replay; 5xx results are not stored), RFC 9457 problems with a configurable type base.                                                                                                                                                                                                                 |

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
touches a merchant database. Collections: replay, nonce, registration, entitlements, usage_queue, revocations, state (revocation
cursor, last Portal JWKS), sessions, idempotency, rate_limits. Unique `_id` and TTL indexes are created lazily. The
in-memory stores (the default) are per-process and are for development only.

## Testing your product

`@ss/app-kit/testing` exports `createFakePortal()`: a Portal built from `@ss/protocol` primitives that signs entitlement
documents, website keys, launches and events, verifies your client assertions, deduplicates usage, serves revocations and
resource descriptors, and can simulate outages (`setDown(true)`, `failNext(path, status)`). Pass `portal.fetch` as
`fetch`. Test and development only.

```
pnpm vitest run packages/app-kit --coverage --coverage.include='packages/app-kit/src/**'
```

The integration tests use `MongoMemoryReplSet` for the tenant guard, indexes, migrations (including concurrent runs and
lock waits), transactions and both store implementations. They also include a two-instance scenario on shared Mongo
stores (idempotency replay, launch replay, revocation propagation, usage exactly once, a cold instance serving stale during an outage).
