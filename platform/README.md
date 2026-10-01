# @ss/platform — the Portal (control plane)

The Portal holds **control-plane data only** (accounts, websites, subscriptions, entitlements, credits, ledger,
audit, keys, delivery metadata — PLAN §1a). Client data lives in the client's own resources. This package is the
foundation every control-plane module builds on: configuration, database access with tenant and append-only
guards, the HTTP layer with all auth modes, cryptography, sessions, RBAC, audit, jobs and crons.

Next.js 16 (App Router) · React 19 · MongoDB driver 6 · Tailwind 4 · JavaScript ESM, functional, JSDoc-typed.

## Architecture

```
app/                         thin Next.js adapters — no logic
  api/[...path]/route.js     every module route (toNextRoute → portal.handle)
  api/cron/[job]/route.js    cron triggers (Bearer CRON_SECRET) → cron runner
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
    authenticators.js        staff / merchant / websiteKey / product / cron authenticators (+ ports)
    stores.js                shared replay, idempotency and rate-limit stores
    crypto.js                Portal signer + JWKS, dedicated website-key signer, envelope encryption, website-secret hashing
    auth.js                  scrypt passwords, TOTP + recovery codes, sessions, cookies, login throttle, CSRF
    rbac.js                  permissions, role bundles, website-scoped grants, can()
    audit.js                 append-only, hash-chained audit log (per-scope chains, verification)
    mailer.js                platform mailer (SMTP via nodemailer; templates)
    jobs.js                  job queue (leases, retries, dead letters) and cron runner
    logger.js                JSON logger with redaction
    modules.js               defineModule / composeModules (isolation boundary)
    security-headers.js      CSP and static security headers
  modules/
    index.js                 the module list
    README.md                how to write a module
    system/                  reference module: /v1/system/info, /v1/system/whoami, PUT /v1/system/notice
scripts/                     db.js (indexes | migrate), dev-mongo.js, dev-env.js
test/                        vitest; integration tests on one shared MongoMemoryReplSet (global-setup.js)
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
| `cron`       | `Authorization: Bearer <CRON_SECRET>`      | constant-time comparison                                                                                                                 |
| `public`     | none                                       | —                                                                                                                                        |

A route may list several modes; the first credential present decides (an invalid one fails — it never falls through).
Modules that receive a website key elsewhere (e.g. a `sendBeacon` body) call `ctx.verifyWebsiteKey({ key, origin,
referer, keyKind?, scopes?, env? })` — the same implementation as the authenticator (claims, or an infra problem).

**CSRF** (cookie sessions only): mutations must carry `Sec-Fetch-Site: same-origin` when the browser sends it, and an
`Origin` exactly equal to the `PORTAL_URL` origin when sent; a mutation with neither is refused. Together with
`SameSite=Lax` cookies and JSON-only bodies (form posts get 415), no CSRF token is needed. Bearer-authenticated calls
(products, website keys, cron) are not subject to CSRF.

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
- Append-only collections (`platform_audit`, `platform_cron_runs`, `platform_migrations`, ledgers, events) get a
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
  per-scope lease lock (unique `{ scope, seq }`). `audit.verifyChain(scope)` recomputes a scope; the nightly cron
  `audit_verify` (and the job `audit.verify`) verifies every scope and logs `audit chain broken` errors with the first
  broken link (`seq_gap`, `prev_hash`, `hash`).

### Jobs and crons

The job queue lives in `platform_jobs`: idempotent enqueue by `key`, atomic leases with a visibility timeout,
exponential backoff with jitter (5 s → 1 h), dead letters after `maxAttempts` (default 8), replay. There are no
workers: `vercel.json` schedules `/api/cron/drain` every minute and the drain runs jobs until the queue is empty or
`CRON_DEADLINE_MS` approaches. Each cron run holds a lease lock (no overlaps) and appends a `platform_cron_runs`
record. Jobs enqueued with `dropPayload: true` lose their payload when they succeed (`complete(job, { dropPayload:
true })`), e.g. Event Hub deliveries whose payload is a sealed event.

| cron                | schedule (UTC) | owner                     |
| ------------------- | -------------- | ------------------------- |
| `drain`             | every minute   | infra (runs queued jobs)  |
| `settlement`        | `5 * * * *`    | commerce                  |
| `connectors-health` | `15 * * * *`   | connectors                |
| `reconciliation`    | `30 2 * * *`   | commerce                  |
| `catalog_refresh`   | `15 3 * * *`   | catalog                   |
| `audit_verify`      | `45 3 * * *`   | infra (audit hash chains) |

`drain` and `audit_verify` (and the job `audit.verify`) are reserved: a module registering them is a boot error.

## Environment

All variables are validated together at start (names only are reported, never values). No host is hardcoded.

| Variable                        | Required | Description                                                                                                                                                                 |
| ------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MONGODB_URI`                   | yes      | Control-plane MongoDB connection string (never a client database).                                                                                                          |
| `MONGODB_DB`                    |          | Database name; default: path of `MONGODB_URI`, else `ss_portal`.                                                                                                            |
| `MONGODB_MAX_POOL_SIZE`         |          | Pool size per instance (default 10).                                                                                                                                        |
| `PORTAL_URL`                    | yes      | Canonical Portal URL (issuer of launches, audience of assertions, CSRF origin). https unless localhost in development.                                                      |
| `PORTAL_SIGNING_KEYS`           | yes      | JSON array of private Ed25519 JWKs with unique `kid`s. The first signs; all are published in the JWKS.                                                                      |
| `SECRETS_KEK`                   | yes      | `kid:base64(32 bytes)[,kid:base64…]`, first = active (one bare base64 key is accepted as `k1`).                                                                             |
| `SESSION_SECRET`                | yes      | ≥ 32 bytes (base64 or text). HMAC key for session ids, recovery codes, throttle keys.                                                                                       |
| `WEBSITE_KEY_PEPPER`            | yes      | ≥ 32 bytes, different from `SESSION_SECRET`. HMAC pepper for website secret keys at rest.                                                                                   |
| `CRON_SECRET`                   | yes      | ≥ 32 characters. Cron routes require `Authorization: Bearer <CRON_SECRET>`.                                                                                                 |
| `WEBSITE_KEY_SIGNING_KEYS`      | prod     | JSON array of private Ed25519 JWKs that sign website keys only (first signs, all published; kids ≠ Portal kids). Outside production a key is derived from `SESSION_SECRET`. |
| `IDEMPOTENCY_SECRET`            |          | ≥ 32 bytes. HMAC key of idempotency fingerprints (default: HKDF of `SESSION_SECRET`).                                                                                       |
| `OUTBOUND_DEV_ALLOW_HOSTS`      |          | Comma-separated hosts/IPs outbound calls may reach although private or plain http (`ctx.config.outbound.allowHosts`); ignored in production.                                |
| `PLATFORM_SMTP_URL`             |          | Platform mailer `smtp(s)://user:pass@host:port` (percent-encode the credentials).                                                                                           |
| `PLATFORM_MAIL_FROM`            |          | Sender, `Name <address>` or `address`; required with `PLATFORM_SMTP_URL`.                                                                                                   |
| `PROBLEM_BASE_URI`              |          | RFC 9457 type base (default `<PORTAL_URL>/problems/`).                                                                                                                      |
| `PORTAL_ENV`                    |          | `production` · `preview` · `development` · `test` (default from `NODE_ENV`).                                                                                                |
| `PORTAL_VERSION`                |          | Reported by `/healthz` and `/v1/system/info` (default `dev`).                                                                                                               |
| `LOG_LEVEL`                     |          | `debug` · `info` (default) · `warn` · `error` · `silent`.                                                                                                                   |
| `TRUST_PROXY_HEADERS`           |          | `true` behind a proxy that sets `X-Forwarded-For` (needed for per-IP limits).                                                                                               |
| `MAX_BODY_BYTES`                |          | Default body cap (1 MiB).                                                                                                                                                   |
| `CRON_DEADLINE_MS`              |          | Cron time budget (50 000; keep below the route's `maxDuration` of 60 s).                                                                                                    |
| `STAFF_SESSION_IDLE_MINUTES`    |          | Default 30.                                                                                                                                                                 |
| `STAFF_SESSION_MAX_HOURS`       |          | Default 12.                                                                                                                                                                 |
| `MERCHANT_SESSION_IDLE_MINUTES` |          | Default 1440.                                                                                                                                                               |
| `MERCHANT_SESSION_MAX_HOURS`    |          | Default 336.                                                                                                                                                                |

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
`staff_welcome`: plain text + simple inline-styled HTML, no external assets, escaped variables, http(s) links only).
With `PLATFORM_SMTP_URL` it is a pooled nodemailer transport (10 s connection/greeting/socket timeouts, TLS ≥ 1.2 with
certificate checks; in production `smtp://` must upgrade with STARTTLS). Without it: development/test log the message
(including the link — never in production); production and preview refuse (503, `available: false`). The identity
module uses `ctx.mailer` unless given its own `mailer`.

### RBAC

Staff permission `platform.config.write` (admin, superadmin) guards admin configuration writes: per-subscription
admin overrides, locks and rollbacks, and platform policies.

## Local development

```bash
pnpm install                                   # from the repo root
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

One Vercel project, one Atlas database (PLAN §13). Set the variables above (`TRUST_PROXY_HEADERS=true` behind the
hosting edge). The deploy pipeline runs `db:indexes` and `db:migrate` before traffic moves (migration gate).
Crons in `vercel.json` call `/api/cron/<job>` with the `CRON_SECRET` bearer.

## Checks

From the repository root:

```bash
pnpm typecheck && pnpm lint && pnpm prettier --check platform
pnpm vitest run platform --coverage --coverage.include='platform/src/**'
cd platform && npx next build
```

Tests: `platform/test/global-setup.js` (vitest `globalSetup`) starts **one** single-node `MongoMemoryReplSet` for
the whole run and exposes it as `SS_TEST_MONGO_URI`; for speed it acknowledges majority writes without waiting for a
journal flush (test-only). `startMongo()` (`test/helpers.js`) gives each test file its own databases
(`t_<random>_<n>`), recycles a database opened inside a test when the test ends (documents deleted, collections and
indexes kept — creating them dominates test time), and drops them all when the file finishes. Use
`mongo.db(name, { fresh: true })` to inspect index or collection creation. Without the variable (a run without the
global setup) `startMongo()` starts a private replica set.
