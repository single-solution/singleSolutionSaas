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
	crons: (ctx) => ({ settlement: async ({ deadline, signal, logger }) => ({ settled: 12 }) }),
	ports: (ctx) => ({ appKeys: (appId) => keyResolverFor(appId) }), // infra ports this module implements
});
```

Every factory receives a `ModuleContext`:

| member                                                         | what                                                                                   |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `collection(name)`                                             | repository of **one of this module's** collections (foreign collections throw)         |
| `service(name)`                                                | another module's (or this module's) public service                                     |
| `moduleNames()`                                                | registered module names                                                                |
| `config`, `logger` (child with `module`), `now`, `randomBytes` | configuration and injected I/O                                                         |
| `problems`                                                     | RFC 9457 factory (`@ss/contracts`) including every module's codes                      |
| `keys`                                                         | Portal signer(s), JWKS, resolver over our own keys (`@ss/protocol` primitives)         |
| `envelope`                                                     | `seal(plaintext, { aad })` / `open` / `rewrap` for client credentials                  |
| `secretHasher`                                                 | `hash` / `verify` website secret keys (HMAC with `WEBSITE_KEY_PEPPER`)                 |
| `audit`                                                        | `record({ actor, action, target, before, after, requestId, ip, reason })`, `list(...)` |
| `jobs`                                                         | `enqueue({ name, payload, key, runAt, maxAttempts })`, dead letters, replay            |
| `locks`                                                        | lease locks                                                                            |
| `sessions`, `loginThrottle`, `cookies`                         | console session primitives (identity module)                                           |
| `replayStore`                                                  | shared atomic replay store for `@ss/protocol` verifiers (launch `consume`, nonces)     |
| `rbac`                                                         | `can(actor, permission, resource)`, `websitesVisible(actor, permission)`               |

## Rules

- **Collections**: declare them in `schema.js` with `defineCollection({ module, name: '<module>_<x>', indexes, ttl,
appendOnly, tenant })`. `ensureIndexes` creates everything declared. Merchant-owned records use
  `tenant: 'merchant'` and are reached with `repo.forMerchant(merchantId)` (every filter pins `merchantId`);
  staff/system code that must cross merchants uses `repo.acrossMerchants()` explicitly. Ledgers, audit-like and
  event-like records use `appendOnly: true` (the repository has no update or delete).
- **No client data** in Portal collections (PLAN §1a): ids, hashes, sealed credentials, control-plane facts only.
- **Routes** are `/v1/...` with an `auth` mode (`staff`, `merchant`, `websiteKey`, `product`, `cron`, `public`, or a
  list tried in order) and, for console routes, a `permission` checked against `resource(ctx)` (default
  `{ merchantId: params.merchantId ?? actor.merchantId, websiteId: params.websiteId }`). Load the entity, then call
  `ctx.authorize(permission, { merchantId, websiteId })` when the resource is only known after a lookup. POSTs that
  create or move state keep the default `idempotent: true`. Duplicate routes across modules are a boot error.
- **Wire formats** in PLAN F.9 (`/v1/product/*`) are binding; product routes use `auth: 'product'` (client
  assertion; `ctx.app.appId`).
- **Jobs** are named `<module>.<job>`, idempotent (they may run more than once) and should check `signal`/`deadline`
  in long loops. Use a job `key` to dedupe enqueues. Throw `permanentFailure(message)` for errors retries cannot fix.
- **Crons** are global names (`settlement`, `reconciliation`); add the schedule to `vercel.json`. The built-in
  `drain` cron runs queued jobs. Unknown cron names answer 404.
- **Ports** are infra extension points with a single provider each: `sessionActor(session)` (identity: live roles,
  deactivated users → null), `appKeys(appId)` (catalog: registered app keys as a `KeyResolver`),
  `websiteKeyRevoked(claims)` (keys: revocation + hash check). Without a provider, product assertions are refused and
  website keys fail closed (503).
- **Migrations** are `YYYYMMDDHHMM-<module>-<slug>`, run in id order across modules under a lock, recorded once, and
  must be safe to re-run after a crash. Provide `plan()` for the dry run. They receive the raw `Db` and must never
  update append-only collections.
- **Audit** every staff and merchant mutation with the actor from `ctx.actor` (including `via` for impersonation).
- **Tests** live in `platform/test/**`: pure `core/` tests, and repository/route tests on `MongoMemoryReplSet`
  through `createPortal` (see `test/integration.test.js` for a probe module that uses every extension point).
