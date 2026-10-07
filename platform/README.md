# @ss/platform — the Portal

The Portal is where our admins (Owner, Support, Finance) manage merchants, their websites, which products each website
has, and credits; merchants use it to see their websites, tokens, install code, usage and credits, and to open each
product's dashboard (PLAN.md Part 0). It holds control-plane records only: people and logins, websites, connected
products, products on websites with their tokens, money histories and the ledger, Activity. Business data lives in each
merchant's own database, inside the products. Nothing runs on a schedule (PLAN F.19): work happens inside, or right
after, the request that caused it.

Next.js 16 (App Router) · React 19 · MongoDB driver 6 · Tailwind 4 · JavaScript ESM, functional, JSDoc-typed.

## Architecture

```
app/                         thin Next.js adapters — no logic
  api/[...path]/route.js     every module route (toNextRoute → portal.handle)
  (console)/ (admin)/        Merchant Console and Admin Console adapters over src/console/
proxy.js                     per-request CSP nonce for HTML pages
instrumentation.js           validates configuration when a server instance starts
next.config.js               security headers; /v1/*, /branding/logo and /.well-known/jwks.json → /api/* rewrites
src/
  portal.js                  composition root: createPortal({ config, db, modules, logger, now, randomBytes })
  runtime.js                 getPortal(): lazy, cached; env + system state (secrets, settings), schema prepared
  testing.js                 @ss/platform/testing: what system tests in e2e/ may use
  infra/
    config.js                env → typed, frozen config (fails listing every bad variable)
    system.js                generated secrets and Owner settings in the database (platform_system)
    db.js                    Mongo client cache, collection registry, ensureIndexes, guarded repositories,
                             locks, transactions, migrations
    schema.js                infra collections (platform_*)
    http.js                  routes, auth modes, CSRF, RBAC, rate limits, idempotency, problems, pagination
    authenticators.js        admin / merchant session cookies, product client assertions (+ ports)
    stores.js                shared replay, idempotency and rate-limit stores
    crypto.js                Portal signer + JWKS, dedicated token signer, sealing with ENCRYPTION_KEY
    auth.js                  scrypt passwords, TOTP + recovery codes, sessions, cookies, login throttle, CSRF
    rbac.js                  the rights table of PLAN 0.2 as data, can()
    audit.js                 append-only Activity (record, list)
    mailer.js                platform mailer (SMTP via nodemailer; templates in src/texts/mail.js)
    background.js            work right after a response, for that request only (deferred tasks, product calls)
    request-scope.js         the request a piece of work belongs to (`afterResponse(task)` from anywhere)
    client.js                createPortalClient: a small HTTP driver of the API for system tests
    logger.js                JSON logger with redaction
    modules.js               defineModule / composeModules (isolation boundary)
    security-headers.js      CSP and static security headers
  modules/                   identity, catalog, commerce, system — see modules/README.md and INTERFACES.md
  console/                   the two consoles (views, loaders, API clients)
  texts/                     every console and e-mail text
scripts/                     db.js (indexes | migrate), dev-mongo.js, dev-env.js
test/                        vitest; integration tests on one shared MongoMemoryReplSet (the @ss/config Mongo setup)
```

| Module     | What it owns                                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity` | admins, merchants, logins, two-step, setup and reset links, websites, the browser and server token of each product on a website, revoked token ids |
| `catalog`  | connected products (Add product, Reconnect, Active/Inactive), launches into product dashboards, notices to products                                |
| `commerce` | products on websites (added/removed, switches), price and feature reports, status responses, credits and billing (PLAN 0.5)                        |
| `system`   | Settings (e-mail, billing rules, branding, support contact, security), Activity, admin Overview                                                    |

Request pipeline (`src/infra/http.js`): request id → route match (404/405, OPTIONS) → body cap (413) → auth → CSRF for
cookie sessions (403) → RBAC permission (403) → rate limit (429 + `RateLimit-*`) → JSON (415/400) → `Idempotency-Key`
on POSTs that opt in (428 / 409 / replay with `Idempotent-Replayed: true`) → handler → RFC 9457 problems
(`@ss/contracts` factory, type base `<PORTAL_URL>/problems/`). API responses default to `Cache-Control: no-store`.

**Idempotency.** The request fingerprint is `HMAC-SHA-256(idempotency secret, method ‖ path ‖ query ‖ body)`, so a
stored fingerprint of a body holding a password cannot be brute-forced offline. Route option `idempotent` (POST only):
`false` (the default), `true` (key required, the response is stored and replayed — website create, admin invites,
merchant create, Add product, Add product to a website, receipts), `'optional'`, or `'no-store'` — for requests or
responses that carry secrets (sign-in, two-step, password routes, server-token reveal and regenerate): only the status
and the fingerprint are stored, and a retry with the same key answers **409 `idempotency_replay_no_body`**.

### Auth modes

| mode       | credential                                 | verification                                                                                                                                              |
| ---------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin`    | `__Host-ss_admin` cookie                   | session store; a pending two-step step, or **Require two-step for admins** without it set up, only reaches `mfa: false` routes (`two_step_required`, 403) |
| `merchant` | `__Host-ss_merchant` cookie                | session store                                                                                                                                             |
| `product`  | `Authorization: Bearer <client assertion>` | `@ss/protocol` `verifyAssertion` — `productKeys` port (the key pinned at connect), `aud` = `PORTAL_URL`, shared replay store                              |
| `public`   | none                                       | —                                                                                                                                                         |

A route may list several modes; the first credential present decides (an invalid one fails — it never falls through).
After every `product` request the `productCalled` port runs (the product's waiting notices are sent again).

**CSRF** (cookie sessions only): mutations must carry `Sec-Fetch-Site: same-origin` when the browser sends it, and an
`Origin` exactly equal to `PORTAL_URL` when sent; a mutation with neither is refused. Product calls are not subject to
CSRF.

**Sessions**: 256-bit opaque tokens; only `HMAC(session secret, token)` is stored; one absolute lifetime, the
**Session length** setting (default 12 hours, 1–336), no idle timeout. Product dashboard sessions never outlive the
Portal session that launched them (the launch carries its expiry). Password changes and resets, sign-out, role changes,
admin removal, merchant suspension and deletion end the person's Portal sessions and send `sessions.revoked` to every
connected product. Cookies: `HttpOnly; SameSite=Lax; Path=/`, plus `Secure` and the `__Host-` prefix when
`PORTAL_URL` is https.

**Passwords**: scrypt N=2^15, r=8, p=1. **TOTP**: RFC 6238, 6 digits, 30 s, single use. **Recovery codes**: 10, stored
as HMACs. **Login throttle**: 5 failures / 15 min lock the account (doubling up to 24 h); 50 per IP.

### Products and the contract (PLAN 0.4.12)

- **Add product** (Owner): the admin enters the product's URL and its `CONNECT_SECRET` (never stored). The Portal
  calls `<url>/.well-known/ss-connect` (HMAC both ways) with `PORTAL_URL`, its published keys and its last accepted
  price-list version; the product answers its id (the manifest `id`), its public key, its manifest and its price list.
  The product is stored under its id, inactive; an id already connected is refused (`use Reconnect`).
- **Reconnect**: the same handshake with a new URL and/or secret; the same id is required; websites, tokens, switches
  and charges stay; the returned price list is handled as a price report.
- **Product routes** (`auth: 'product'`): `PUT /v1/product/prices`, `PUT /v1/product/websites/:websiteId/features`,
  `GET /v1/product/websites/:websiteId/status` (settles the merchant first), `GET /v1/product/websites`,
  `GET /v1/product/revocations`, `GET /v1/product/directory/:productId`, `POST /v1/product/launch/consume`.
- **Notices** (`status.changed`, `token.revoked`, `sessions.revoked`, `website.deleted`) are signed with the Portal key
  (`@ss/protocol` `signNotice`) and posted to `<base>/.well-known/ss-events` right after the request that caused them.
  A product that does not answer 2xx keeps them in `catalog_notices`; they are sent again, oldest first, right after its
  next call to any product route.
- **Tokens** (PLAN 0.4.4): two per product on a website, signed by the dedicated token signer (`ctx.keys.tokenSigner`,
  generated on first start, published in the same JWKS with its own kid). The browser token is stored in full; the
  server token is sealed with `ENCRYPTION_KEY` and revealed only on request (Activity `token.revealed`); regenerating
  revokes the old id at once. A server token sealed under another `ENCRYPTION_KEY` cannot be shown until regenerated.

### Data

- Every collection is declared (`defineCollection`) by its owning module; `ensureIndexes` creates the declared
  indexes and TTLs and reports undeclared ones (it never drops).
- Append-only collections (`platform_audit`, `platform_migrations`, the ledger, money histories, revoked token ids) get
  a repository without update/delete. `$out` / `$merge` are refused everywhere.
- Merchant-scoped collections (`tenant: 'merchant'`) are only reachable through `forMerchant(merchantId)` or the
  explicit `acrossMerchants()` view.
- Modules can only open their own collections; other modules' data is reached through their services.
- **Transactions**: `ctx.withTransaction(async (session) => …)`; the commerce ledger appends entries and moves the
  account in one transaction.

### Work after responses (event-driven only)

Every request runs in a request scope (`infra/request-scope.js`). Notices and e-mails are handed to `afterResponse`
and run through Next `after()` (`toNextRoute(handler, { after })`); outside a request they run at once.
`createPortal({ background: { mode: 'off' } })` (the default when `NODE_ENV=test`) runs none of it. Billing is checked
on use (PLAN 0.5.7): when a product fetches a status and when a Portal page shows a merchant; the check writes the day
charges of complete UTC days, records grace starts and stops once (and tells the products), and sends any due billing
e-mail once per state.

## Environment

Exactly three variables (PLAN 0.11), validated together at start (names only are reported, never values):

| Variable         | Description                                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MONGODB_URI`    | The Portal's own database (`ss_portal`; never a merchant database; production and preview never share one).                                                 |
| `PORTAL_URL`     | The Portal's final address (https in production, no path): links in e-mails, issuer of tokens, launches and notices, CSRF origin, the address products pin. |
| `ENCRYPTION_KEY` | Random, at least 32 characters: seals the stored secrets (mail password, two-step secrets, server tokens).                                                  |

The environment comes from `NODE_ENV` (production unless `development` or `test`). Outside production the Portal may
reach products on `localhost`, `127.0.0.1` and `::1` over plain http; in production only public https addresses.

### Kept in the database (`platform_system`, `src/infra/system.js`)

- **Generated on first start**, inserted only if absent so concurrent cold starts agree: the Portal signing key, the
  token signing key, the session secret and the idempotency secret.
- **First admin**: while no admin exists, `/login` offers **Create admin** (name, e-mail, password) and the visitor
  becomes an Owner. Do it right after deploying.
- **Admin → Settings** (Owner, audited): e-mail sending (password sealed with `ENCRYPTION_KEY`), Branding, Support
  contact, Security (Session length, Require two-step for admins), Billing rules. Every instance applies a change within
  5 seconds.
- **Indexes and migrations** run automatically on the first request after a deploy, once per schema version.

### Rights

`src/infra/rbac.js` holds the rights table of PLAN 0.2 as data: three admin roles and the merchant column.
`can(actor, permission)` decides every route. The rows each product enforces on its own server
(`PRODUCT_ENFORCED_ROWS`: switching features, settings, defaults and prices) have no Portal permission; the Portal's
part is what it signs and accepts (launches carry the role, Finance is never launched; feature reports only for a
current Owner or Support admin). `test/rights.test.js` checks every row and column.

## Local development

```bash
pnpm install                                   # from the repo root (or this folder, once split)
pnpm --filter @ss/platform db:memory           # terminal 1: docker-free MongoDB (in-memory replica set, port 27999)
cd platform && pnpm env:dev > .env.local       # NODE_ENV, MONGODB_URI, PORTAL_URL, ENCRYPTION_KEY
pnpm --filter @ss/platform dev                 # http://localhost:4000 — then open /login, create the first admin
```

## Deployment

Any Node 22 host that runs Next.js. Set `NODE_ENV=production`, `MONGODB_URI`, `PORTAL_URL` and `ENCRYPTION_KEY` as
production-only variables, deploy, then open `<PORTAL_URL>/login` at once and create the first Owner; connect products
in Admin → Products as each one ships. There is nothing to schedule and nothing to run by hand.

## Checks

From this folder (from the root: `pnpm --filter @ss/platform <script>`):

```bash
pnpm check           # format:check, lint, typecheck, test (vitest with coverage, thresholds 90/90/85)
pnpm build           # next build
```

System tests that run products against this Portal live in the monorepo's `e2e/` workspace and use the public testing
entry `@ss/platform/testing` (`createPortal`, the module list and factories, `loadConfig`, `totpCode`,
`closeMongoClients`, and `createPortalClient` to drive the API with session cookies and product assertions); nothing
else of `src/` is imported from outside this folder.

Tests: the `@ss/config` Mongo global setup starts one `MongoMemoryReplSet` for the whole run (`TEST_MONGODB_URI`, TTL
monitor off: tests run on an injected clock). `startMongo()` (`test/helpers.js`) gives each test file its own
databases. `test/modules/catalog/boot.js` boots the real modules with fake products on local HTTP servers
(`test/modules/catalog/fakes/product.js`: the connect handshake and verified notices).
