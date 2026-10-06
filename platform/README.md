# @ss/platform — the Portal (control plane)

The Portal holds **control-plane data only** (accounts, websites, subscriptions, entitlements, credits, ledger,
audit, keys, delivery metadata — PLAN §1a). Client data lives in the client's own resources. This package is the
foundation every control-plane module builds on: configuration, database access with tenant and append-only
guards, the HTTP layer with all auth modes, cryptography, sessions, RBAC, audit, jobs and on-demand operations. Nothing
runs on a schedule (PLAN F.19: event-driven only).

Next.js 16 (App Router) · React 19 · MongoDB driver 6 · Tailwind 4 · JavaScript ESM, functional, JSDoc-typed.

## Architecture

```
app/                         thin Next.js adapters — no logic
  api/[...path]/route.js     every module route (toNextRoute → portal.handle)
  w/[...path]/ p/[...path]/  delivery plane: bundles, pack and UI-bundle modules (/w/*), preview proxy (/p/*) → portal.handle
  .well-known/jwks.json/     published JWKS: Portal keys (current + previous) + website-key signing keys
  healthz/  readyz/          liveness (no deps) / readiness (config + DB ping)
  layout.js  page.js         placeholder console shell
proxy.js                     per-request CSP nonce for HTML pages
instrumentation.js           validates configuration when a server instance starts
next.config.js               security headers, /v1/* → /api/v1/* rewrite
src/
  portal.js                  composition root: createPortal({ config, db, modules, logger, now, randomBytes })
  runtime.js                 getPortal(): lazy, cached on globalThis, built from process.env
  infra/
    config.js                env → typed, frozen config (fails listing every bad variable)
    db.js                    Mongo client cache, collection registry, ensureIndexes, guarded repositories,
                             locks, transactions, migrations
    schema.js                infra collections (platform_*)
    http.js                  routes, auth modes, CSRF, RBAC, rate limits, idempotency, problems, pagination
    authenticators.js        staff / merchant / websiteKey / product authenticators (+ ports)
    stores.js                shared replay, idempotency and rate-limit stores
    crypto.js                Portal signer + JWKS, dedicated website-key signer, envelope encryption, website-secret hashing
    auth.js                  scrypt passwords, TOTP + recovery codes, sessions, cookies, login throttle, CSRF
    rbac.js                  permissions, role bundles, website-scoped grants, can()
    audit.js                 append-only, hash-chained audit log (per-scope chains, verification)
    mailer.js                platform mailer (SMTP via nodemailer; templates)
    jobs.js                  job queue (leases, retries, dead letters) and the on-demand operation runner
    background.js            work right after a response, for that request only (deferred tasks, product calls)
    request-scope.js         the request a piece of work belongs to (`afterResponse(task)` from anywhere)
    logger.js                JSON logger with redaction
    modules.js               defineModule / composeModules (isolation boundary)
    security-headers.js      CSP and static security headers
  modules/
    index.js                 the module list
    README.md                how to write a module
    system/                  reference module: /v1/system/info, /v1/system/whoami, PUT /v1/system/notice
scripts/                     db.js (indexes | migrate), dev-mongo.js, dev-env.js
test/                        vitest; integration tests on one shared MongoMemoryReplSet (the @ss/config Mongo setup)
```

Request pipeline (`src/infra/http.js`): request id → route match (404/405, CORS preflight) → body cap (413) → auth →
CSRF for cookie sessions (403) → RBAC permission (403) → rate limit (429 + `RateLimit-*`) → JSON (415/400) →
`Idempotency-Key` on POST (428 / 409 / replay with `Idempotent-Replayed: true`) → handler → RFC 9457 problems
(`@ss/contracts` factory, type base `PROBLEM_BASE_URI`). API responses default to `Cache-Control: no-store`.

**Idempotency.** The request fingerprint is `HMAC-SHA-256(IDEMPOTENCY_SECRET, method ‖ path ‖ query ‖ body)` (the
key defaults to an HKDF derivation of `SESSION_SECRET`), so a stored fingerprint of a body holding a password or a
credential cannot be brute-forced offline. Route option `idempotent`: `true` (default for POST: key required, the
response is stored and replayed), `'optional'`, `false`, or `'no-store'` — for requests or responses that carry
secrets (login, MFA, password and key routes; connector create/rotate): the key is optional, only the status and
the fingerprint are stored, and a retry with the same key answers **409 `idempotency_replay_no_body`** (detail names
the original status) instead of executing twice or re-sending a secret. Use a new key to repeat the operation.

### Auth modes

| mode         | credential                                 | verification                                                                                                                             |
| ------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `staff`      | `__Host-ss_staff` cookie                   | session store; **MFA required** (routes opt out with `mfa: false` only for the second-factor step)                                       |
| `merchant`   | `__Host-ss_merchant` cookie                | session store                                                                                                                            |
| `websiteKey` | `Authorization: Bearer pk_…` / `sk_…`      | `@ss/protocol` `verifyWebsiteKey` with the website-key keys, `websiteKeyRevoked(claims, rawKey)` port, `originAllowed` for `pk_`, scopes |
| `product`    | `Authorization: Bearer <client assertion>` | `verifyAssertion` — `appKeys` port, `aud` = `PORTAL_URL`, shared replay store                                                            |
| `public`     | none                                       | —                                                                                                                                        |

A route may list several modes; the first credential present decides (an invalid one fails — it never falls through).
Modules that receive a website key elsewhere (e.g. a `sendBeacon` body) call `ctx.verifyWebsiteKey({ key, origin,
referer, keyKind?, scopes?, env? })` — the same implementation as the authenticator (claims, or an infra problem).

**CSRF** (cookie sessions only): mutations must carry `Sec-Fetch-Site: same-origin` when the browser sends it, and an
`Origin` exactly equal to the `PORTAL_URL` origin when sent; a mutation with neither is refused. Together with
`SameSite=Lax` cookies and JSON-only bodies (form posts get 415), no CSRF token is needed. Bearer-authenticated calls
(products, website keys) are not subject to CSRF.

**Sessions**: 256-bit opaque tokens; only `HMAC(SESSION_SECRET, token)` is stored; idle and absolute expiry (TTL);
`rotate` on any privilege change (MFA completed, roles changed, impersonation) keeps the absolute expiry and kills the
old token; `revokeAll` for password changes and offboarding. Cookies: `HttpOnly; Secure; SameSite=Lax; Path=/` with
the `__Host-` prefix whenever Secure (plain-http localhost uses `ss_staff` / `ss_merchant`).

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
- **Audit chain**: `platform_audit` entries are chained per scope (`global` for staff/platform actions,
  `merchant:<id>` per merchant): `seq`, `prevHash`, `hash = sha256(prevHash ‖ canonical JSON)`, appended under a
  per-scope lease lock (unique `{ scope, seq }`). `audit.verifyChain(scope)` recomputes a scope; the admin operation
  `audit_verify` (on demand, resumable with `after`) verifies every scope and logs `audit chain broken` errors with the first
  broken link (`seq_gap`, `prev_hash`, `hash`).

### Jobs and operations (event-driven only)

Nothing runs on a schedule: no crons, no timers, no polling, no periodic or throttled drains (PLAN F.19). Work happens
inside, or right after, the request that caused it, and only for what that request created or touched.

The job queue lives in `platform_jobs`: idempotent enqueue by `key`, a `group` for jobs retried together, atomic leases
with a visibility timeout, exponential backoff with jitter (5 s → 1 h), dead letters after `maxAttempts` (default 8),
replay. Jobs enqueued with `dropPayload: true` lose their payload when they succeed, e.g. Event Hub deliveries whose
payload is a sealed event. Every request runs in a request scope (`infra/request-scope.js`):

- **a job a request enqueued runs right after that response** (`onEnqueued` → `afterResponse`), and only that job;
- **a failed job waits** with its next-attempt time until there is a natural reason to retry it: the Event Hub retries
  a product's due deliveries (a few) when the next event is delivered to that product and when that product next calls
  the Portal (the `productCalled` port follows every `product`-auth request); a failed website compile is retried when
  the website's loader is next served; staff can press "Retry deliveries now" (app page) or run `drain`;
- **settlement is computed when read**: a merchant settles (idempotently per `periodKey`) before its balance, meter or
  statement is read, when a product fetches an entitlement document or reports usage for one of its websites (usage:
  right after the response), and before a subscription change; low-balance and spend-limit holds are evaluated at the
  same moments, so the document a product fetches reflects a hold. A product with a still-valid document (10 minutes,
  plus its cache) may keep serving until it refreshes it;
- **time-based state is judged on read**: scheduled configuration changes are applied by the first read of the
  merchant's configuration at or after their time; a rotated website key's revocation takes effect by time in the
  revocation list; a deprecated app is retired the first time it is read after its sunset;
- **product liveness** needs no periodic heartbeat: every authenticated product call marks the app as seen
  (`health.lastSeenAt`, written at most every 5 minutes); an app silent for a day is flagged stale;
- **connectors** are checked when saved (create, rotate, update, assign, test) and when a product resolves one whose
  last check is older than 50 minutes (after the response).

Deferred work runs through Next `after()` (`toNextRoute(handler, { after })` in `app/api` and `app/w`).
`createPortal({ background: { mode: 'off' } })` (the default when `PORTAL_ENV=test`) runs none of it.

**Operations** are bounded, resumable maintenance tasks that staff run on demand from the admin console (Platform
health → Operations, `POST /v1/admin/operations/:name` with `platform.jobs.manage`, body `{ after? }` to continue a
cut run). Each run holds a lease lock (no overlaps), gets `OPERATION_DEADLINE_MS`, and appends a
`platform_operation_runs` record.

| operation           | owner                     | resumes from                                        |
| ------------------- | ------------------------- | --------------------------------------------------- |
| `settlement`        | commerce                  | each subscription's `settledThrough` cursor         |
| `reconciliation`    | commerce                  | the saved run (phase and cursor), even the next day |
| `connectors-health` | connectors                | connectors not checked within 50 minutes stay due   |
| `catalog_refresh`   | catalog                   | `after`: the `resumeAfter` app of the last run      |
| `audit_verify`      | infra (audit hash chains) | `after`: the `resumeAfter` scope of the last run    |
| `drain`             | infra (runs due jobs)     | the queue                                           |

`drain` and `audit_verify` are reserved: a module registering them is a boot error.

## Environment

All variables are validated together at start (names only are reported, never values). No host is hardcoded.

| Variable                        | Required | Description                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MONGODB_URI`                   | yes      | Control-plane MongoDB connection string (never a client database).                                                                                                                                                                                                                                                                                                  |
| `MONGODB_DB`                    |          | Database name; default: path of `MONGODB_URI`, else `ss_portal`.                                                                                                                                                                                                                                                                                                    |
| `MONGODB_MAX_POOL_SIZE`         |          | Pool size per instance (default 5: one Atlas M0 cluster allows ~500 connections across every deployment and instance).                                                                                                                                                                                                                                              |
| `PORTAL_URL`                    | yes      | Canonical Portal URL (issuer of launches, audience of assertions, CSRF origin). https unless localhost in development.                                                                                                                                                                                                                                              |
| `PORTAL_SIGNING_KEYS`           | yes      | JSON array of private Ed25519 JWKs with unique `kid`s. The first signs; all are published in the JWKS.                                                                                                                                                                                                                                                              |
| `SECRETS_KEK`                   | yes      | `kid:base64(32 bytes)[,kid:base64…]`, first = active (one bare base64 key is accepted as `k1`).                                                                                                                                                                                                                                                                     |
| `SESSION_SECRET`                | yes      | ≥ 32 bytes (base64 or text). HMAC key for session ids, recovery codes, throttle keys.                                                                                                                                                                                                                                                                               |
| `WEBSITE_KEY_PEPPER`            | yes      | ≥ 32 bytes, different from `SESSION_SECRET`. HMAC pepper for website secret keys at rest.                                                                                                                                                                                                                                                                           |
| `WEBSITE_KEY_SIGNING_KEYS`      | prod     | JSON array of private Ed25519 JWKs that sign website keys only (first signs, all published; kids ≠ Portal kids). Outside production a key is derived from `SESSION_SECRET`.                                                                                                                                                                                         |
| `IDEMPOTENCY_SECRET`            |          | ≥ 32 bytes. HMAC key of idempotency fingerprints (default: HKDF of `SESSION_SECRET`).                                                                                                                                                                                                                                                                               |
| `OUTBOUND_DEV_ALLOW_HOSTS`      |          | Comma-separated hosts/IPs outbound calls (event deliveries, registrations, identity-issuer JWKS, connector checks) may reach although private or plain http (`ctx.config.outbound.allowHosts`); ignored in production.                                                                                                                                              |
| `PLATFORM_SMTP_URL`             |          | Platform mailer `smtp(s)://user:pass@host:port` (percent-encode the credentials).                                                                                                                                                                                                                                                                                   |
| `PLATFORM_MAIL_FROM`            |          | Sender, `Name <address>` or `address`; required with `PLATFORM_SMTP_URL`.                                                                                                                                                                                                                                                                                           |
| `PLATFORM_ASSET_STORAGE`        |          | Platform-owned artefact storage (pack assets, compiled website bundles — our software, never client data): JSON `{ endpoint?, region, bucket, accessKeyId, secretAccessKey, sessionToken?, forcePathStyle?, prefix? }` (S3-compatible, https in production), or `memory` / `file:<dir>` outside production. Without it the delivery routes answer 503.              |
| `DELIVERY_BUDGET_KB`            |          | Website bundle budget in KB gzip: Loader + Σ element `budget.js` + Σ product `budget.shared`, all measured minified and gzipped (default 60; PLAN F.18 has the reasoning).                                                                                                                                                                                          |
| `PREVIEW_ORIGIN`                |          | Dedicated cookie-less preview origin (https, host ≠ `PORTAL_URL`'s, ideally another registrable domain) pointed at the same deployment. Preview links use it, the Portal host refuses `/p/*`, and that host serves only `/p/*` (API, `/w/*` and console pages answer 404). Previews there stay `CSP: sandbox` + `allow-same-origin` and run the merchant's scripts. |
| `PROBLEM_BASE_URI`              |          | RFC 9457 type base (default `<PORTAL_URL>/problems/`).                                                                                                                                                                                                                                                                                                              |
| `PORTAL_ENV`                    |          | `production` · `preview` · `development` · `test` (default from `NODE_ENV`).                                                                                                                                                                                                                                                                                        |
| `PORTAL_VERSION`                |          | Reported by `/healthz` and `/v1/system/info` (default `dev`).                                                                                                                                                                                                                                                                                                       |
| `LOG_LEVEL`                     |          | `debug` · `info` (default) · `warn` · `error` · `silent`.                                                                                                                                                                                                                                                                                                           |
| `TRUST_PROXY_HEADERS`           |          | `true` behind a proxy that sets `X-Forwarded-For` (needed for per-IP limits).                                                                                                                                                                                                                                                                                       |
| `MAX_BODY_BYTES`                |          | Default body cap (1 MiB).                                                                                                                                                                                                                                                                                                                                           |
| `OPERATION_DEADLINE_MS`         |          | Time budget of one admin operation (50 000; keep below the function time limit, 60 s on Vercel Hobby).                                                                                                                                                                                                                                                              |
| `STAFF_SESSION_IDLE_MINUTES`    |          | Default 30.                                                                                                                                                                                                                                                                                                                                                         |
| `STAFF_SESSION_MAX_HOURS`       |          | Default 12.                                                                                                                                                                                                                                                                                                                                                         |
| `MERCHANT_SESSION_IDLE_MINUTES` |          | Default 1440.                                                                                                                                                                                                                                                                                                                                                       |
| `MERCHANT_SESSION_MAX_HOURS`    |          | Default 336.                                                                                                                                                                                                                                                                                                                                                        |

`instrumentation.js` loads the configuration when a server instance starts: an invalid configuration is logged as
`Failed to prepare server … Invalid Portal configuration: …` and every request (including `/healthz`) fails, so a
bad deployment is visible immediately. `next build` never needs the environment or a database.

### Key management

- **Signing key rotation**: generate a new key, deploy `PORTAL_SIGNING_KEYS=[new, old]` (both published; the new one
  signs), wait for the overlap (product JWKS caches refresh within 5 min; launch and assertion lifetimes are minutes),
  then remove the old key. Website keys are not affected: they have their own signer.
- **Website-key signer** (`WEBSITE_KEY_SIGNING_KEYS`, `ctx.keys.websiteKeySigner`): signs `pk_`/`sk_` keys only and
  verifies them through `ctx.keys.websiteKeyResolver` (a Portal-signed token is never a website key). Its public keys
  are published in the same JWKS with distinct kids. Rotation: prepend a new key (new keys are signed with it, old
  ones keep verifying), **re-issue the website keys signed by the old key, then remove it** (F.5). Compromise: remove
  the key at once and re-issue.
- **KEK rotation**: prepend a new KEK (`SECRETS_KEK=k2:…,k1:…`). New secrets are sealed with `k2`; old ones still open
  with `k1`; `envelope.rewrap(sealed)` moves a record to `k2` without touching its ciphertext. Remove `k1` only after
  every record is rewrapped.
- Generate values: `node scripts/dev-env.js` (development only) or, for production, fresh keys from
  `generateSigningKey` (`@ss/protocol`) for `PORTAL_SIGNING_KEYS` and `WEBSITE_KEY_SIGNING_KEYS` (distinct kids) and
  `openssl rand -base64 32` for the secrets.

### Mail

`ctx.mailer` sends the Portal's own mail (templates `verify_email`, `account_exists`, `password_reset`, `invite`,
`staff_welcome`, `issuer_request`: plain text + simple inline-styled HTML, no external assets, escaped variables, http(s) links only).
With `PLATFORM_SMTP_URL` it is a pooled nodemailer transport (10 s connection/greeting/socket timeouts, TLS ≥ 1.2 with
certificate checks; in production `smtp://` must upgrade with STARTTLS). Without it: development/test log the message
(including the link — never in production); production and preview refuse (503, `available: false`). The identity
module uses `ctx.mailer` unless given its own `mailer`.

### RBAC

Staff permission `platform.config.write` (admin, superadmin) guards admin configuration writes: per-subscription
admin overrides, locks and rollbacks, and platform policies.

## Admin Console

Staff console at **`/admin`** (`app/(admin)/` adapters over `src/console/admin/`: `paths.js`, `loaders.js`, `client.js`,
`views/*`). Same rules as the Merchant Console: every read and action is a public API call (server components call
`portal.handle` in-process with the request's cookies, browsers `fetch` the same `/v1/*` routes), pages have loading,
empty and error states, and destructive actions sit behind a typed confirmation (`TypedConfirmDialog`). Navigation
is filtered by the staff member's permissions (`infra/rbac.js`).

- **Sign-in:** `/admin/login` (password, then the mandatory TOTP — enrolment with one-time recovery codes on the first
  sign-in, verification afterwards), `/admin/forgot-password`, and `/staff/reset-password` (target of the staff setup
  and reset e-mails). The staff session is the `__Host-ss_staff` cookie, separate from merchant sessions; a session
  without its second factor only reaches the MFA routes.
- **Pages:** dashboard (deliveries, dead letters, unhealthy service apps, operations with Run buttons, job queue, last audit verification,
  reconciliation, alerts) · merchants (search, detail, suspend/resume, notes, impersonation) · websites (lookup,
  transfer) · apps (register, pack upload, versions with manifest diff and breaking flags, review, lifecycle,
  environments, keys, health, admin launch per merchant or app-wide) · subscriptions (admin overrides and locks,
  history, rollback) · platform policies per app · finance (credits/adjustments/refunds, ledger and chain
  verification, settlement, reconciliation, alerts) · integration (delivery log, dead letters, replay, metrics) ·
  connectors (status only) · audit log (search, chain verification) · staff (invite, roles, MFA reset, deactivate).

| Route (staff)                                       | Permission                | Notes                                                                            |
| --------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------- |
| `GET /v1/admin/merchants?q=`                        | `platform.merchants.read` | `q`: name prefix (case/accent-insensitive `nameKey`) or member e-mail prefix     |
| `GET\|POST /v1/admin/merchants/:merchantId/notes`   | `.read` / `.write`        | append-only staff notes, audited (`merchant.note_added`, body not copied)        |
| `POST /v1/admin/merchants/:merchantId/impersonate`  | `platform.impersonate`    | `{ userId, minutes ≤ 60, reason }` → one-time exchange token (60 s)              |
| `POST /v1/auth/impersonation/exchange`              | staff session             | `{ token }` → merchant session cookie with `via`                                 |
| `GET /v1/admin/system/health`                       | `platform.jobs.read`      | `{ operations: [{ name, status, lastRun }], jobs, audit: { lastVerification } }` |
| `GET /v1/admin/audit?scope&actorId&targetId&action` | `platform.audit.read`     | newest first, cursor pagination; `action` may end in `.*`; no IP addresses       |
| `GET /v1/admin/audit/verification?scope=`           | `platform.audit.read`     | recomputes one chain (`global` or `merchant:<id>`), rate-limited                 |

**Impersonation.** Starting one mints a single-use token bound to the staff member (only its HMAC is stored; an
attempt by anyone else does not burn it). The staff member's own browser exchanges it within 60 s for a merchant
session of the member: MFA complete, absolute lifetime = the minutes asked for, `via: { type: 'staff', id, name }`.
The start is audited on the global chain (`staff.impersonation_started`) and the merchant's chain
(`merchant.impersonation_started`), with the reason. Every request made with the session runs as the member with
`via` on the actor, so its audit entries record the staff member. The Merchant Console shows a banner on every page
(read from `GET /v1/system/whoami`); "End impersonation" signs the session out, which revokes it and is audited on both
chains (`*.impersonation_ended`). Product impersonation stays a separate `impersonate` launch
(`POST /v1/admin/apps/:appId/launch`).

## Local development

```bash
pnpm install                                   # from the repo root (or this folder, once split)
pnpm --filter @ss/platform db:memory           # terminal 1: docker-free MongoDB (in-memory replica set, port 27999)
cd platform && node scripts/dev-env.js > .env.local   # fresh dev keys; edit MONGODB_URI for a local mongod
pnpm --filter @ss/platform db:indexes          # create indexes
pnpm --filter @ss/platform db:migrate          # apply migrations (db:migrate:dry to preview)
pnpm --filter @ss/platform dev                 # http://localhost:4000
curl localhost:4000/v1/system/info
```

The ops scripts read the environment from the shell (`set -a; . ./.env.local; set +a` first); Next loads `.env.local`
by itself. A local `mongod` (`mongodb://127.0.0.1:27017/ss_portal`) works the same; transactions need a replica set.

## Deployment

One Vercel project (Hobby works), one database and database user on the shared Atlas M0 cluster (PLAN §13, F.19). The
`MongoClient` is created once per instance and cached on `globalThis` (`getMongoClient`). Set the variables above (`TRUST_PROXY_HEADERS=true` behind the
hosting edge). The deploy pipeline runs `db:indexes` and `db:migrate` before traffic moves (migration gate).
There is nothing to schedule: `vercel.json` has no crons and no `CRON_SECRET` exists.

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
the whole run and exposes it as `SS_TEST_MONGO_URI`; for speed it acknowledges majority writes without waiting for a
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
- **Service UI bundles**: `POST /v1/product/ui-bundles`, `PUT /v1/product/ui-bundles/:version/assets/*`, served at
  `/w/ui/…`; element stub v2 (`ss-element-stub@2`: `?ctx=` page context, input `fields`).
- **Event provenance**: `context.keyKind` stamped by the Event Hub; **resources**: needed now vs needed if enabled.
  Contracts and wire details: `src/modules/INTERFACES.md`; decisions: PLAN.md F.16.

## Wave-1 platform changes (F.18)

- **Delivery budgets** are measured with `@ss/contracts/budget` (the measurement `ss app validate` uses): each
  element's own entry modules against its `budget.js`, every product's shared chunks once against `budget.shared`
  (`shared_over_declared`; undeclared counts as measured with a warning). Element-stub elements take 0 KB.
- **Namespaced element ids**: bundles carry each element's `product`; the Loader addresses `<product>:<key>`, so two
  products may deliver the same key (the compile `conflict` is now only a duplicate id).
- **Pack reads**: `manifest.reads` products active on the website give the pack's elements `reads` bases; the loader
  `pk_` gains their read scopes.
- **Strings**: product catalogs `strings/<lang>.json` sliced per element (`stringKeys`) for the website language
  (fallback `en`); per-website overrides `GET|PUT /v1/merchants/:m/websites/:w/delivery/strings[/:appId/:element/:language]`
  (console: Subscription → Texts).
- **Staff API tokens**: `POST /v1/admin/api-tokens` → `sst_…` bearer for tooling (`ss pack publish`), ≤ 12 h,
  revocable in `/v1/me/sessions`.
- **Optional resources** (`requires.optionalResources`): never `resource_missing`; listed `optional` in resource needs.
- **Placement features** (`x-kind: placement`) are validated against placement v1 and edited with the `placement`
  widget in Configure.
