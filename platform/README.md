# @ss/platform — the Portal (control plane)

The Portal holds **control-plane data only** (accounts, websites, subscriptions, entitlements, credits, ledger,
audit, keys, delivery metadata — PLAN §1a). Client data lives in the client's own resources. This package is the
foundation every control-plane module builds on: configuration, database access with tenant and append-only
guards, the HTTP layer with all auth modes, cryptography, sessions, RBAC, audit and jobs. Nothing
runs on a schedule (PLAN F.19: event-driven only).

Next.js 16 (App Router) · React 19 · MongoDB driver 6 · Tailwind 4 · JavaScript ESM, functional, JSDoc-typed.

## Architecture

```
app/                         thin Next.js adapters — no logic
  api/[...path]/route.js     every module route (toNextRoute → portal.handle)
  (console)/ (admin)/        Merchant Console and Admin Console adapters over src/console/
proxy.js                     per-request CSP nonce for HTML pages
instrumentation.js           validates configuration when a server instance starts
next.config.js               security headers; /v1/*, /w/* (delivery plane: loaders, pack and widget modules) and
                             /.well-known/jwks.json (Portal + website-key signing keys) → /api/* rewrites
src/
  portal.js                  composition root: createPortal({ config, db, modules, logger, now, randomBytes })
  runtime.js                 getPortal(): lazy, cached; env + system state (secrets, settings), schema prepared
  infra/
    config.js                env → typed, frozen config (fails listing every bad variable)
    db.js                    Mongo client cache, collection registry, ensureIndexes, guarded repositories,
                             locks, transactions, migrations
    schema.js                infra collections (platform_*)
    http.js                  routes, auth modes, CSRF, RBAC, rate limits, idempotency, problems, pagination
    authenticators.js        admin / merchant / websiteKey / product authenticators (+ ports)
    stores.js                shared replay, idempotency and rate-limit stores
    crypto.js                Portal signer + JWKS, dedicated website-key signer, envelope encryption, website-secret hashing
    auth.js                  scrypt passwords, TOTP + recovery codes, sessions, cookies, login throttle, CSRF
    rbac.js                  permissions, role bundles, website-scoped grants, can()
    audit.js                 append-only audit log (record, list)
    mailer.js                platform mailer (SMTP via nodemailer; templates)
    jobs.js                  job queue (leases, retries; exhausted jobs stop as failed)
    background.js            work right after a response, for that request only (deferred tasks, product calls)
    request-scope.js         the request a piece of work belongs to (`afterResponse(task)` from anywhere)
    logger.js                JSON logger with redaction
    modules.js               defineModule / composeModules (isolation boundary)
    security-headers.js      CSP and static security headers
  modules/
    index.js                 the module list
    README.md                how to write a module
    system/                  Portal settings (mail, branding, support, security), Overview and Activity
scripts/                     db.js (indexes | migrate), dev-mongo.js, dev-env.js
test/                        vitest; integration tests on one shared MongoMemoryReplSet (the @ss/config Mongo setup)
```

Request pipeline (`src/infra/http.js`): request id → route match (404/405, CORS preflight) → body cap (413) → auth →
CSRF for cookie sessions (403) → RBAC permission (403) → rate limit (429 + `RateLimit-*`) → JSON (415/400) →
`Idempotency-Key` on POSTs that opt in (428 / 409 / replay with `Idempotent-Replayed: true`) → handler → RFC 9457 problems
(`@ss/contracts` factory, type base `<Portal URL>/problems/`). API responses default to `Cache-Control: no-store`.

**Idempotency.** The request fingerprint is `HMAC-SHA-256(IDEMPOTENCY_SECRET, method ‖ path ‖ query ‖ body)` (the
key defaults to an generated idempotency secret), so a stored fingerprint of a body holding a password or a
credential cannot be brute-forced offline. Route option `idempotent` (POST only): `false` (the default), `true` (key
required, the response is stored and replayed — website create, admin invites, merchant create, app connect,
pack upload, connector create, credits/adjustments/refunds, subscribe, product usage), `'optional'`, or
`'no-store'` — for requests or responses that carry secrets (login, MFA, password routes, website-key create and
rotate): the key is optional, only the status and
the fingerprint are stored, and a retry with the same key answers **409 `idempotency_replay_no_body`** (detail names
the original status) instead of executing twice or re-sending a secret. Use a new key to repeat the operation.

### Auth modes

| mode         | credential                                 | verification                                                                                                                                              |
| ------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin`      | `__Host-ss_admin` cookie                   | session store; a pending two-step step, or **Require two-step for admins** without it set up, only reaches `mfa: false` routes (`two_step_required`, 403) |
| `merchant`   | `__Host-ss_merchant` cookie                | session store                                                                                                                                             |
| `websiteKey` | `Authorization: Bearer pk_…` / `sk_…`      | `@ss/protocol` `verifyWebsiteKey` with the website-key keys, `websiteKeyRevoked(claims, rawKey)` port, `originAllowed` for `pk_`, scopes                  |
| `product`    | `Authorization: Bearer <client assertion>` | `verifyAssertion` — `appKeys` port, `aud` = `PORTAL_URL`, shared replay store                                                                             |
| `public`     | none                                       | —                                                                                                                                                         |

A route may list several modes; the first credential present decides (an invalid one fails — it never falls through).
Modules that receive a website key elsewhere (e.g. a `sendBeacon` body) call `ctx.verifyWebsiteKey({ key, origin,
referer, keyKind?, scopes?, env? })` — the same implementation as the authenticator (claims, or an infra problem).

**CSRF** (cookie sessions only): mutations must carry `Sec-Fetch-Site: same-origin` when the browser sends it, and an
`Origin` exactly equal to the origin of `PORTAL_URL` when sent; a mutation with neither is refused. Together with
`SameSite=Lax` cookies and JSON-only bodies (form posts get 415), no CSRF token is needed. Bearer-authenticated calls
(products, website keys) are not subject to CSRF.

**Sessions**: 256-bit opaque tokens; only `HMAC(session secret, token)` is stored; one absolute lifetime, the
**Session length** setting (default 12 hours, 1–336; Admin → Settings → Security), no idle timeout. `rotate` on a
privilege change keeps the expiry and kills the old token; `revokeAll` on password changes, role changes, suspension
and removal. One login is one admin or one merchant (e-mails unique across both, `identity_logins`). Cookies:
`HttpOnly; SameSite=Lax; Path=/`, plus `Secure` and the `__Host-` prefix when `PORTAL_URL` is https (plain-http
localhost uses `ss_admin` / `ss_merchant`).

**Passwords**: scrypt N=2^15, r=8, p=1, 64-byte key, 16-byte salt; constant-time verify; unknown accounts verify a
dummy hash. **TOTP**: RFC 6238 SHA-1, 6 digits, 30 s, ±1 step, single use (store the returned step).
**Recovery codes**: 10 × 50-bit codes, stored as HMACs. **Login throttle**: 5 failures / 15 min lock the account for
15 min, doubling per consecutive lockout up to 24 h; 50 failures / 15 min per IP; accounts and IPs stored as HMACs.

### Data

- Every collection is declared (`defineCollection`) by its owning module; `ensureIndexes` creates the declared
  indexes and TTLs and reports undeclared ones (it never drops).
- Append-only collections (`platform_audit`, `platform_operation_runs`, `platform_migrations`, ledgers, events) get a
  repository without update/delete. `$out` / `$merge` are refused everywhere so they cannot be bypassed.
- Merchant-scoped collections (`tenant: 'merchant'`) are only reachable through `forMerchant(merchantId)` (filters and
  the first `$match` must pin `merchantId` by equality; inserts are stamped; `merchantId` cannot change;
  cross-collection stages are refused) or the explicit `acrossMerchants()` view.
- Modules can only open their own collections; other modules' data is reached through their services.
- Migrations: `YYYYMMDDHHMM-<module>-<slug>`, ordered across modules, run under a lock, recorded once, with a
  read-only dry run.
- **Transactions**: `ctx.withTransaction(async (session) => …)` runs a multi-document transaction (snapshot reads,
  majority commit; the whole transaction is retried on `TransientTransactionError`, the commit on
  `UnknownTransactionCommitResult`). Pass `{ session }` to every repository call inside it (repositories forward
  driver options; the guards still apply). The callback may run more than once: keep mail, events and HTTP outside.
  The commerce ledger appends entries and moves the account in one transaction; website transfers move the website,
  its domain claim and grants in one.
- **Audit**: `platform_audit` is append-only (`audit.record`, `audit.list`); the commerce ledger keeps its own hash
  chain and verification.

### Jobs and operations (event-driven only)

Nothing runs on a schedule: no crons, no timers, no polling, no periodic or throttled drains (PLAN F.19). Work happens
inside, or right after, the request that caused it, and only for what that request created or touched.

The job queue lives in `platform_jobs`: idempotent enqueue by `key`, a `group` for jobs retried together, atomic leases
with a visibility timeout, exponential backoff with jitter (5 s → 1 h); after `maxAttempts` (default 8) the job stops
as `failed` with its last error. Jobs enqueued with `dropPayload: true` lose their payload when they succeed, e.g. Event Hub deliveries whose
payload is a sealed event. Every request runs in a request scope (`infra/request-scope.js`):

- **a job a request enqueued runs right after that response** (`onEnqueued` → `afterResponse`), and only that job;
- **a failed job waits** with its next-attempt time until there is a natural reason to retry it: the Event Hub retries
  a product's due deliveries (a few) when the next event is delivered to that product and when that product next calls
  the Portal (the `productCalled` port follows every `product`-auth request); a failed website compile is retried when
  the website's loader is next served; admins can press "Retry deliveries" (app page);
- **settlement is computed when read**: a merchant settles (idempotently per `periodKey`) before its balance, meter or
  statement is read, when a product fetches an entitlement document or reports usage for one of its websites (usage:
  right after the response), and before a subscription change; low-balance and spend-cap holds are evaluated at the
  same moments, so the document a product fetches reflects a hold. A product with a still-valid document (10 minutes,
  plus its cache) may keep serving until it refreshes it;
- **time-based state is judged on read**: a rotated website key's revocation takes effect by time in the revocation
  list; a spend-cap hold ends with the UTC month;
- **connectors** are checked when saved (create, edit, assign, test) and when a product resolves one whose last check
  is older than 50 minutes (after the response).

Deferred work runs through Next `after()` (`toNextRoute(handler, { after })` in the one route handler, `app/api`, which
also serves `/w/*` and `/.well-known/jwks.json` through `next.config.js` rewrites).
`createPortal({ background: { mode: 'off' } })` (the default when `NODE_ENV=test`) runs none of it.

There are no on-demand maintenance operations: settlement runs on read, connectors are checked on save and
resolve, and failed jobs retry when their item is next touched.

## Environment

Only the database and the asset storage come from the environment; everything else is generated or set inside the
Portal. All variables are validated together at start (names only are reported, never values), every value is a plain
string, and nothing depends on the hosting provider. The environment comes from `NODE_ENV` (production unless
`development` or `test`); logs are `info` in production and `debug` in development.

| Variable                                                                                                                      | Description                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `MONGODB_URI`                                                                                                                 | Control-plane MongoDB (never a client database; production and preview never share one).                                                     |
| `PORTAL_URL`                                                                                                                  | The Portal's own address (https in production, no path): links in e-mails, token issuer and audience, CSRF origin, the address products pin. |
| `ENCRYPTION_KEY`                                                                                                              | Random, at least 32 characters: seals the stored secrets (mail password, two-step secrets) with AES-256-GCM.                                 |
| `STORAGE_ENDPOINT`, `STORAGE_REGION` (default `auto`), `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` | Asset storage for pack files and compiled website bundles: Cloudflare R2 or any S3-compatible service (optional; a bucket in production).    |

Optional, never needed: `STORAGE_PREFIX`, `STORAGE_PATH_STYLE`, `STORAGE_DIR` (development only, instead of a bucket:
a directory or `:memory:`) and `OUTBOUND_DEV_ALLOW_HOSTS` (development only, ignored in production). The full list is
`ENV_VARS` in `src/infra/config.js`. Everything else is a fixed constant there: database = the path of `MONGODB_URI`
(else `ss_portal`), pool 5, 1 MiB body cap. Proxies: `X-Forwarded-For` and `X-Forwarded-Proto` are read as the first hop (the proxy in front of
the Portal) set them — their last entry.

### Kept in the database (`platform_system`, `src/infra/system.js`)

- **Generated on first start**, inserted only if absent so concurrent cold starts agree: the Ed25519 Portal signing
  key, the website-key signing key, the encryption key (KEK), the session secret, the key pepper and the idempotency
  secret. Loaded once per instance and cached.
- **Portal address**: `PORTAL_URL`, never the request's host — the issuer and audience of the tokens it signs, the
  base of e-mail and launch links and the CSRF origin. Products pin it at connect time.
- **First admin**: while no admin exists, `/login` shows **Create the first admin** (`POST /v1/auth/first-admin`:
  name, e-mail, password); the visitor becomes an Owner and is signed in. **Do it right after deploying**: until then,
  whoever opens the login first becomes the Owner. Everyone (admins and merchants) signs in at `/login` with e-mail and
  password, plus the two-step code once it is on.
- **Admin → Settings** (`/v1/admin/settings…`, Owner, audited): Mail (host, port, TLS, user, password sealed with
  `ENCRYPTION_KEY`, sender name and address, send a test e-mail), Branding (name, accent colour, logo ≤ 200 kB PNG,
  JPEG or WebP served at `/branding/logo`), Support (e-mail, phone, WhatsApp) and Security (Session length, Require
  two-step for admins). Every instance applies a change within 5 seconds (a cheap read of the settings
  version).
- **Indexes and migrations** run automatically on the first request after a deploy, once per schema version, under a
  lock (`scripts/db.js` stays for developers: dry runs, applying ahead of time).

### Key management

- **Rotation**: the key lists in `platform_system` take a prepended key; it signs (or seals) from then on while the
  old ones stay published (or able to open). Product JWKS caches refresh within 5 minutes; launch and assertion
  lifetimes are minutes. Website keys have their own signer: after rotating it, re-issue the website keys signed by the
  old key (F.5). Encryption keys: new secrets are sealed with the new KEK; `envelope.rewrap(sealed)` moves a record
  without touching its ciphertext.
- **Website-key signer** (`ctx.keys.websiteKeySigner`): signs `pk_`/`sk_` keys only and verifies them through
  `ctx.keys.websiteKeyResolver` (a Portal-signed token is never a website key). Its public keys are published in the
  same JWKS with distinct kids.

### Mail

`ctx.mailer` sends the Portal's own mail right after the response (texts in `src/texts/mail.js`: `merchant_setup`,
`admin_invite`, `password_reset`, `email_change_confirm`, `email_change_notice`, `two_step_off`, `test_email`,
`issuer_request`; each signed with the Branding name and the Support line; plain text + simple inline-styled HTML, no external assets, escaped variables, http(s)
links only). With a mailer set in Admin → Settings it is a pooled nodemailer transport (10 s timeouts, TLS ≥ 1.2 with
certificate checks; in production a non-TLS port must upgrade with STARTTLS). Without one no mail is sent and the
action still succeeds; admins copy setup links instead.

### Rights

`src/infra/rbac.js` holds PLAN 0.10.2 as data: three admin roles (Owner, Support, Finance) and the merchant column.
`can(actor, permission)` decides every route; `websitesVisible(actor)` answers `all`, `own` or `none`. Merchants only
reach their own merchant. `test/rights.test.js` checks every row and column.

## Admin Console

Admin console at **`/admin`** (`app/(admin)/` adapters over `src/console/admin/`: `paths.js`, `loaders.js`, `client.js`,
`views/*`). Every read and action is a public API call (server components call `portal.handle` in-process with the
request's cookies, browsers `fetch` the same `/v1/*` routes); destructive actions sit behind a typed confirmation
(`TypedConfirmDialog`). Navigation is filtered by the admin's role (`infra/rbac.js`).

- **Sign-in:** the shared `/login` (with Forgot password, `/reset-password`, `/set-password` for setup links,
  `/confirm-email`). An admin invite link lasts 24 hours, a merchant setup link 72 hours; links carry the token in
  the fragment. **My account** (`/admin/account`): name, e-mail change (confirmed from the new address), password,
  two-step sign-in with 10 recovery codes, own Activity.
- **Pages:** Overview · Merchants (search by name, e-mail or domain; bulk suspend, resume, send setup links; **Add
  merchant**; merchant page with details, websites, products, credits, activity; suspend, resume, setup link, turn
  off two-step, delete) · apps · finance · Activity (filters by actor, merchant, action, dates) · Admins (Owner:
  invite, resend or copy, correct invite e-mail, change role, turn off two-step, remove; always one Owner) · Settings.

| Route                                            | Rights (PLAN 0.10.2)                     | Notes                                                                        |
| ------------------------------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------- |
| `GET\|POST /v1/admin/merchants`                  | `merchants.read` / `.write`              | `q` searches name, e-mail or domain; create sends (or copies) the setup link |
| `PATCH\|DELETE /v1/admin/merchants/:merchantId`  | `merchants.write` / `.delete`            | delete needs the typed name and no websites                                  |
| `POST /v1/admin/merchants/bulk`                  | per action                               | suspend, resume, setup links                                                 |
| `GET\|POST /v1/admin/admins…`                    | `admins.manage` (Owner)                  | invite, role, remove, turn off two-step                                      |
| `GET /v1/admin/activity`, `/v1/admin/overview`   | `activity.read`, `overview.read`         | Activity stores no personal details and is never edited                      |
| `GET\|PUT /v1/admin/settings…`                   | `settings.read`, `portal_settings.write` | Mail, Branding, Support, Security                                            |
| `POST /v1/admin/apps/connect`, `/v1/admin/packs` | `products.manage`                        | add a product or a pack version                                              |

## Local development

```bash
pnpm install                                   # from the repo root (or this folder, once split)
pnpm --filter @ss/platform db:memory           # terminal 1: docker-free MongoDB (in-memory replica set, port 27999)
cd platform && pnpm env:dev > .env.local       # NODE_ENV, MONGODB_URI, PORTAL_URL, ENCRYPTION_KEY, STORAGE_DIR
pnpm --filter @ss/platform dev                 # http://localhost:4000 — then open /login, create the first admin
```

The first request generates the keys and secrets in the database and applies indexes and migrations. A local `mongod`
(`mongodb://127.0.0.1:27017/ss_portal`) works the same; transactions need a replica set.

## Deployment

Any Node 22 host that runs Next.js (`pnpm --filter @ss/platform build` then `start`, a container, or a serverless
platform), one database and database user on the shared Atlas cluster (PLAN §13, F.19). Set `NODE_ENV=production`,
`MONGODB_URI`, `PORTAL_URL` and `ENCRYPTION_KEY` (plus `STORAGE_*` for website scripts) as production-only variables,
deploy, then open `<PORTAL_URL>/login` at once and create the first admin. The `MongoClient`
is created once per instance and cached on `globalThis`. There is nothing to schedule and nothing to run by hand.

## Checks

From this folder (from the root: `pnpm --filter @ss/platform <script>`):

```bash
pnpm check           # format:check, lint, typecheck, runtime:check, test (vitest with coverage, thresholds 90/90/85)
pnpm runtime:check   # the bundled browser runtime is up to date (pnpm runtime:build rewrites it)
pnpm build           # next build
```

The tooling config (`eslint.config.js`, `tsconfig.json`, `vitest.config.js`, the `prettier` key) comes from
`@ss/config`. System tests that run products against this Portal live in the monorepo's `e2e/` workspace and use the
public testing entry `@ss/platform/testing` (`createPortal`, the module list and factories, `loadConfig`, `totpCode`,
`closeMongoClients`); nothing else of `src/` is imported from outside this folder.

Tests: the `@ss/config` Mongo global setup (`defineUnitConfig({ mongo: true })`) starts **one** single-node `MongoMemoryReplSet` for
the whole run and exposes it as `TEST_MONGODB_URI`; for speed it acknowledges majority writes without waiting for a
journal flush (test-only), and its **TTL monitor is off**: tests run on an injected clock (`createClock`, fixed T0), so
TTL indexes (tokens, sessions) must never delete by wall-clock time — expiry is asserted through `now()`. `startMongo()` (`test/helpers.js`) gives each test file its own databases
(`t_<random>_<n>`), recycles a database opened inside a test when the test ends (documents deleted, collections and
indexes kept — creating them dominates test time), and drops them all when the file finishes. Use
`mongo.db(name, { fresh: true })` to inspect index or collection creation. Without the variable (a run without the
global setup) `startMongo()` starts a private replica set.

## Post-launch Portal changes (F.16)

- **Website settings** (`timeZone`, `language`, `currency`): `PATCH /v1/merchants/:m/websites/:w`, merchant console
  Website → Overview and the Admin Console website lookup; copied into every entitlement document (`website` section).
- **Key scopes**: `elements.read`, `events.write`, `<product>.read|write`, `<group>.*`; empty = defaults; catalogue at
  `GET …/keys/scopes`.
- **Product identity issuer requests**: `PUT /v1/product/websites/:websiteId/identity` → pending → merchant approves
  (`…/identity/request/approve|reject`); console banner from `GET /v1/merchants/:m/notifications`; mail
  `issuer_request`.
- **Event provenance**: `context.keyKind` stamped by the Event Hub; **resources**: needed now vs needed if enabled.
  Contracts and wire details: `src/modules/INTERFACES.md`; decisions: PLAN.md F.16.

## Wave-1 platform changes (F.18)

- **Namespaced element ids**: bundles carry each element's `product`; the Loader addresses `<product>:<key>`, so two
  products may deliver the same key (the compile `conflict` is now only a duplicate id).
- **Pack reads**: `manifest.reads` products active on the website give the pack's elements `reads` bases; the loader
  `pk_` gains their read scopes.
- **Strings**: product catalogs `strings/<lang>.json` sliced per element (`stringKeys`) for the website language
  (fallback `en`); per-website overrides `GET|PUT /v1/merchants/:m/websites/:w/delivery/strings[/:appId/:element/:language]`
  (console: Subscription → Texts).
- **Optional resources** (`requires.optionalResources`): never `resource_missing`; listed `optional` in resource needs.
- **Placement features** (`x-kind: placement`) are validated against placement v1 and edited with the `placement`
  widget in Configure.
