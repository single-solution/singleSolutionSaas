# Portal modules

The Portal is four **modules**: `identity`, `catalog`, `commerce` and `system` (their public services are in
`INTERFACES.md`). Modules plug into the infra layer through one definition object and never import each other.

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
	name: 'example', // lower-case; collections are example_*
	collections, // from schema.js
	problems: { example_conflict: { status: 409, title: 'Example conflict' } }, // extra RFC 9457 codes
	service: (ctx) => createExampleService(ctx), // built lazily, once
	routes: (ctx) => exampleRoutes(ctx.service('example')),
	ports: (ctx) => ({ productKeys: (productId) => keyResolverFor(productId) }), // infra ports this module implements
});
```

Every factory receives a `ModuleContext`:

| member                                                          | what                                                                                                                                                        |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collection(name)`                                              | repository of **one of this module's** collections (foreign collections throw)                                                                              |
| `service(name)`                                                 | another module's (or this module's) public service                                                                                                          |
| `moduleNames()`                                                 | registered module names                                                                                                                                     |
| `config`, `logger` (child with `module`), `now`, `randomBytes`  | configuration and injected I/O                                                                                                                              |
| `config.outbound.allowHosts`                                    | hosts outbound calls may reach over loopback / plain http (the loopback hosts outside production; empty in production) — build the `@ss/net` policy from it |
| `problems`                                                      | RFC 9457 factory (`@ss/contracts`) including every module's codes                                                                                           |
| `keys`                                                          | Portal signer(s) (`signer`, `signers`), `jwks()`, `keyResolver` over our own keys (`@ss/protocol` primitives); launches and notices                         |
| `keys.tokenSigner`, `keys.tokenKeyResolver`, `keys.tokenJwks()` | the dedicated signer of browser and server tokens (generated on first start, `infra/system.js`); `keys.publishedJwks()` = both sets                         |
| `secretBox`                                                     | `seal` / `open` with `ENCRYPTION_KEY` for the Portal's stored secrets (mail password, two-step secrets, server tokens)                                      |
| `withTransaction(fn)`                                           | run `fn(session)` in a retried multi-document transaction; pass `{ session }` to every repository call inside it                                            |
| `mailer`                                                        | platform mailer `send({ to, template, data })` (texts in `src/texts/mail.js`); `available` false → no mail is sent (send after the response)                |
| `audit`                                                         | `record({ actor, action, target, before, after, requestId, ip, reason })`, `list(...)` (append-only)                                                        |
| `locks`                                                         | lease locks                                                                                                                                                 |
| `sessions`, `loginThrottle`, `cookies`                          | console session primitives (identity module)                                                                                                                |
| `replayStore`                                                   | shared atomic replay store for `@ss/protocol` verifiers (client assertions, launch consumption)                                                             |
| `rbac`                                                          | `can(actor, permission, resource)`, `websitesVisible(actor)` (`all` / `own` / `none`) over the PLAN 0.2 rights table                                        |

## Rules

- **Collections**: declare them in `schema.js` with `defineCollection({ module, name: '<module>_<x>', indexes, ttl,
appendOnly, tenant })`. `ensureIndexes` creates everything declared. Merchant-owned records use
  `tenant: 'merchant'` and are reached with `repo.forMerchant(merchantId)` (every filter pins `merchantId`);
  admin/system code that must cross merchants uses `repo.acrossMerchants()` explicitly. Ledgers, audit-like and
  event-like records use `appendOnly: true` (the repository has no update or delete).
- **Outbound calls** to admin-supplied destinations (product connect, notices) go through `@ss/net` only: one
  `createOutboundPolicy` per module built from `ctx.config.outbound.allowHosts` (forced empty when
  `ctx.config.isProduction`), `safeFetch` for HTTP(S). No module keeps its own SSRF rules.
- **No business data** in Portal collections: ids, hashes, sealed secrets, control-plane facts only.
- **Routes** are `/v1/...` with an `auth` mode (`admin`, `merchant`, `product`, `public`, or a list tried in order) and, for console routes, a `permission` checked against `resource(ctx)` (default
  `{ merchantId: params.merchantId ?? actor.merchantId, websiteId: params.websiteId }`). Load the entity, then call
  `ctx.authorize(permission, { merchantId, websiteId })` when the resource is only known after a lookup. `idempotent`
  defaults to `false`; set `true` on POSTs where a retried request must not act twice (creates, money moves)
  and `'no-store'` when the request or response carries a secret. Duplicate routes across modules are a boot error.
- **Wire formats** of the Product ↔ Portal contract (PLAN 0.4.12, `/v1/product/*`) are binding; product routes use
  `auth: 'product'` (client assertion; `ctx.product.productId`).
- **Nothing is scheduled** (PLAN 0.10): no crons, timers, polling or periodic passes. Work runs inside, or right after
  (`ctx.defer` / `afterResponse()` from `infra/request-scope.js`), the request that caused it, for what it touched.
  Time-based state is judged when read.
- **Failed work waits for a natural trigger**: a notice a product did not take stays in `catalog_notices` and is sent
  again right after that product's next call to the Portal.
- **Ports** are infra extension points with a single provider each: `sessionActor(session)` (identity: live role, name
  and `twoStepRequired`; removed admins and suspended merchants → null), `productKeys(productId)` (catalog: the key the
  product answered at connect, as a `KeyResolver`), `productCalled(productId)` (catalog: the product's waiting notices,
  after any request it made). Without `productKeys`, product assertions are refused.
- **Audit** every admin and merchant mutation (Activity; never personal details) with the actor from `ctx.actor`.
- **Tests** live in `platform/test/**`: pure `core/` tests, and repository/route tests on `MongoMemoryReplSet`
  through `createPortal` (see `test/integration.test.js` for a probe module that uses every extension point, and
  `test/modules/catalog/boot.js` for the real modules with fake products).
