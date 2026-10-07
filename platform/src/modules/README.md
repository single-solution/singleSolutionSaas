# Portal modules

Every control-plane capability (identity, catalog, commerce, configuration, delivery, connectors, …) is a **module**.
Modules plug into the infra layer through one definition object and never import each other.

## Layout

```
src/modules/<name>/
  schema.js     collections (defineCollection) — the only place the module's data shape is declared
  core/*.js     pure logic: validation, calculations, state machines (no I/O, no imports from infra except types)
  repo.js       data access over the module's own repositories
  service.js    the module's public API (other modules call it via ctx.service('<name>'))
  routes.js     HTTP adapters: defineRoute(...) → service calls; no business logic
  index.js      defineModule({ ... }) wiring the pieces together
```

Register the module by appending it to `src/modules/index.js`. The API catch-all (`app/api/[...path]/route.js`)
mounts the routes of every registered module; nothing in `app/` changes when a module is added.

## Definition

```js
import { defineModule } from '../../infra/modules.js';

export const exampleModule = defineModule({
	name: 'example', // lower-case; collections are example_*, jobs example.*
	collections, // from schema.js
	migrations: [{ id: '202610150900-example-backfill', description, plan, up }],
	problems: { example_conflict: { status: 409, title: 'Example conflict' } }, // extra RFC 9457 codes
	service: (ctx) => createExampleService(ctx), // built lazily, once
	routes: (ctx) => exampleRoutes(ctx.service('example')),
	jobs: (ctx) => ({ 'example.sync': async (payload, { job, signal, deadline, logger }) => {} }),
	ports: (ctx) => ({ appKeys: (appId) => keyResolverFor(appId) }), // infra ports this module implements
});
```

Every factory receives a `ModuleContext`:

| member                                                                                                | what                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collection(name)`                                                                                    | repository of **one of this module's** collections (foreign collections throw)                                                                            |
| `service(name)`                                                                                       | another module's (or this module's) public service                                                                                                        |
| `moduleNames()`                                                                                       | registered module names                                                                                                                                   |
| `config`, `logger` (child with `module`), `now`, `randomBytes`                                        | configuration and injected I/O                                                                                                                            |
| `config.outbound.allowHosts`                                                                          | development outbound allowlist (`OUTBOUND_DEV_ALLOW_HOSTS`; always empty in production) — build the `@ss/net` policy from it                              |
| `problems`                                                                                            | RFC 9457 factory (`@ss/contracts`) including every module's codes                                                                                         |
| `keys`                                                                                                | Portal signer(s) (`signer`, `signers`), `jwks()`, `keyResolver` over our own keys (`@ss/protocol` primitives)                                             |
| `keys.websiteKeySigner`, `keys.websiteKeySigners`, `keys.websiteKeyResolver`, `keys.websiteKeyJwks()` | dedicated website-key (`pk_`/`sk_`) signing keys (generated on first start, `infra/system.js`) — never the launch key; `keys.publishedJwks()` = both sets |
| `envelope`                                                                                            | `seal(plaintext, { aad })` / `open` / `rewrap` for client credentials                                                                                     |
| `secretBox`                                                                                           | `seal` / `open` with `ENCRYPTION_KEY` for the Portal's own stored secrets (mail password, two-step secrets)                                               |
| `secretHasher`                                                                                        | `hash` / `verify` website secret keys (HMAC with the generated key pepper)                                                                                |
| `verifyWebsiteKey({ key, origin, referer, keyKind?, scopes?, env? })`                                 | the `websiteKey` authenticator's verification for keys carried outside `Authorization` (e.g. `sendBeacon` body auth); throws infra problems               |
| `withTransaction(fn)`                                                                                 | run `fn(session)` in a retried multi-document transaction; pass `{ session }` to every repository call inside it                                          |
| `mailer`                                                                                              | platform mailer `send({ to, template, data })` (texts in `src/texts/mail.js`); `available` false → no mail is sent (send after the response)              |
| `audit`                                                                                               | `record({ actor, action, target, before, after, requestId, ip, reason })`, `list(...)` (append-only)                                                      |
| `jobs`                                                                                                | `enqueue({ name, payload, key, runAt, maxAttempts, group })`, `runBatch({ groups, maxJobs })`; exhausted → `failed`                                       |
| `locks`                                                                                               | lease locks                                                                                                                                               |
| `sessions`, `loginThrottle`, `cookies`                                                                | console session primitives (identity module)                                                                                                              |
| `replayStore`                                                                                         | shared atomic replay store for `@ss/protocol` verifiers (launch `consume`, nonces)                                                                        |
| `rbac`                                                                                                | `can(actor, permission, resource)`, `websitesVisible(actor)` (`all` / `own` / `none`) over the PLAN 0.10.2 rights table                                   |

## Rules

- **Collections**: declare them in `schema.js` with `defineCollection({ module, name: '<module>_<x>', indexes, ttl,
appendOnly, tenant })`. `ensureIndexes` creates everything declared. Merchant-owned records use
  `tenant: 'merchant'` and are reached with `repo.forMerchant(merchantId)` (every filter pins `merchantId`);
  admin/system code that must cross merchants uses `repo.acrossMerchants()` explicitly. Ledgers, audit-like and
  event-like records use `appendOnly: true` (the repository has no update or delete).
- **Outbound calls** to merchant- or developer-supplied destinations (product connect, event deliveries, connector checks, client databases) go through `@ss/net` only: one `createOutboundPolicy` per
  module built from `ctx.config.outbound.allowHosts` (forced empty when `ctx.config.isProduction`), `safeFetch` for
  HTTP(S), `checkHost` + `guardedLookup` for sockets and the MongoDB driver, `isSafeMongoUri` for connection strings,
  `signV4` for object stores. No module keeps its own SSRF rules.
- **No client data** in Portal collections (PLAN §1a): ids, hashes, sealed credentials, control-plane facts only.
- **Routes** are `/v1/...` with an `auth` mode (`admin`, `merchant`, `websiteKey`, `product`, `public`, or a
  list tried in order) and, for console routes, a `permission` checked against `resource(ctx)` (default
  `{ merchantId: params.merchantId ?? actor.merchantId, websiteId: params.websiteId }`). Load the entity, then call
  `ctx.authorize(permission, { merchantId, websiteId })` when the resource is only known after a lookup. `idempotent`
  defaults to `false`; set `true` on POSTs where a retried request must not act twice (creates, money moves, usage)
  and `'no-store'` when the request or response carries a secret. Duplicate routes across modules are a boot error.
- **Wire formats** in PLAN F.9 (`/v1/product/*`) are binding; product routes use `auth: 'product'` (client
  assertion; `ctx.app.appId`).
- **Nothing is scheduled** (PLAN F.19): no crons, timers, polling or periodic passes. Work runs inside, or right after
  (`ctx.defer` / `afterResponse()` from `infra/request-scope.js`), the request that caused it, for what it touched.
  Time-based state is judged when read.
- **Jobs** are named `<module>.<job>`, idempotent (they may run more than once) and should check `signal`/`deadline`
  in long loops. A job enqueued during a request runs right after that response. A failed one waits for a natural
  trigger: tag it with a `group` and run that group's due jobs (`ctx.jobs.runBatch({ groups, maxJobs })`) when the
  thing it concerns is touched again. Use a job `key` to dedupe enqueues. Throw `permanentFailure(message)` for errors
  retries cannot fix.
- **Ports** are infra extension points with a single provider each: `sessionActor(session)` (identity: live role, name and
  `twoStepRequired`; removed admins and suspended merchants → null), `appKeys(appId)` (catalog: registered app keys as a `KeyResolver`),
  `websiteKeyRevoked(claims, rawKey)` (identity: revocation + `sk_` hash check), `productCalled(appId)` (integration:
  retries the product's due deliveries after any request it made). Without a provider, product assertions are refused and
  website keys fail closed (503).
- **Migrations** are `YYYYMMDDHHMM-<module>-<slug>`, run in id order across modules under a lock, recorded once, and
  must be safe to re-run after a crash. Provide `plan()` for the dry run. They receive the raw `Db` and must never
  update append-only collections.
- **Audit** every admin and merchant mutation (Activity; never personal details) with the actor from `ctx.actor`.
- **Tests** live in `platform/test/**`: pure `core/` tests, and repository/route tests on `MongoMemoryReplSet`
  through `createPortal` (see `test/integration.test.js` for a probe module that uses every extension point).
