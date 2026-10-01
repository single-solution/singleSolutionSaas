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
  .well-known/jwks.json/     Portal JWKS (current + previous keys)
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
                             locks, migrations
    schema.js                infra collections (platform_*)
    http.js                  routes, auth modes, CSRF, RBAC, rate limits, idempotency, problems, pagination
    authenticators.js        staff / merchant / websiteKey / product / cron authenticators (+ ports)
    stores.js                shared replay, idempotency and rate-limit stores
    crypto.js                Portal signer + JWKS, envelope encryption, website-secret hashing
    auth.js                  scrypt passwords, TOTP + recovery codes, sessions, cookies, login throttle, CSRF
    rbac.js                  permissions, role bundles, website-scoped grants, can()
    audit.js                 append-only audit log
    jobs.js                  job queue (leases, retries, dead letters) and cron runner
    logger.js                JSON logger with redaction
    modules.js               defineModule / composeModules (isolation boundary)
    security-headers.js      CSP and static security headers
  modules/
    index.js                 the module list
    README.md                how to write a module
    system/                  reference module: /v1/system/info, /v1/system/whoami, PUT /v1/system/notice
scripts/                     db.js (indexes | migrate), dev-mongo.js, dev-env.js
test/                        vitest; integration tests on MongoMemoryReplSet
```

Request pipeline (`src/infra/http.js`): request id → route match (404/405, CORS preflight) → body cap (413) → auth →
CSRF for cookie sessions (403) → RBAC permission (403) → rate limit (429 + `RateLimit-*`) → JSON (415/400) →
`Idempotency-Key` on POST (428 / 409 / replay with `Idempotent-Replayed: true`) → handler → RFC 9457 problems
(`@ss/contracts` factory, type base `PROBLEM_BASE_URI`). API responses default to `Cache-Control: no-store`.

### Auth modes

| mode         | credential                                 | verification                                                                                                              |
| ------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `staff`      | `__Host-ss_staff` cookie                   | session store; **MFA required** (routes opt out with `mfa: false` only for the second-factor step)                        |
| `merchant`   | `__Host-ss_merchant` cookie                | session store                                                                                                             |
| `websiteKey` | `Authorization: Bearer pk_…` / `sk_…`      | `@ss/protocol` `verifyWebsiteKey` with the Portal's own keys, `websiteKeyRevoked` port, `originAllowed` for `pk_`, scopes |
| `product`    | `Authorization: Bearer <client assertion>` | `verifyAssertion` — `appKeys` port, `aud` = `PORTAL_URL`, shared replay store                                             |
| `cron`       | `Authorization: Bearer <CRON_SECRET>`      | constant-time comparison                                                                                                  |
| `public`     | none                                       | —                                                                                                                         |

A route may list several modes; the first credential present decides (an invalid one fails — it never falls through).

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

### Jobs and crons

The job queue lives in `platform_jobs`: idempotent enqueue by `key`, atomic leases with a visibility timeout,
exponential backoff with jitter (5 s → 1 h), dead letters after `maxAttempts` (default 8), replay. There are no
workers: `vercel.json` schedules `/api/cron/drain` every minute and the drain runs jobs until the queue is empty or
`CRON_DEADLINE_MS` approaches. Each cron run holds a lease lock (no overlaps) and appends a `platform_cron_runs`
record. `settlement` (hourly) and `reconciliation` (nightly) are scheduled as placeholders and answer 404 until the
Commerce module registers them.

## Environment

All variables are validated together at start (names only are reported, never values). No host is hardcoded.

| Variable                        | Required | Description                                                                                                            |
| ------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `MONGODB_URI`                   | yes      | Control-plane MongoDB connection string (never a client database).                                                     |
| `MONGODB_DB`                    |          | Database name; default: path of `MONGODB_URI`, else `ss_portal`.                                                       |
| `MONGODB_MAX_POOL_SIZE`         |          | Pool size per instance (default 10).                                                                                   |
| `PORTAL_URL`                    | yes      | Canonical Portal URL (issuer of launches, audience of assertions, CSRF origin). https unless localhost in development. |
| `PORTAL_SIGNING_KEYS`           | yes      | JSON array of private Ed25519 JWKs with unique `kid`s. The first signs; all are published in the JWKS.                 |
| `SECRETS_KEK`                   | yes      | `kid:base64(32 bytes)[,kid:base64…]`, first = active (one bare base64 key is accepted as `k1`).                        |
| `SESSION_SECRET`                | yes      | ≥ 32 bytes (base64 or text). HMAC key for session ids, recovery codes, throttle keys.                                  |
| `WEBSITE_KEY_PEPPER`            | yes      | ≥ 32 bytes, different from `SESSION_SECRET`. HMAC pepper for website secret keys at rest.                              |
| `CRON_SECRET`                   | yes      | ≥ 32 characters. Cron routes require `Authorization: Bearer <CRON_SECRET>`.                                            |
| `PROBLEM_BASE_URI`              |          | RFC 9457 type base (default `<PORTAL_URL>/problems/`).                                                                 |
| `PORTAL_ENV`                    |          | `production` · `preview` · `development` · `test` (default from `NODE_ENV`).                                           |
| `PORTAL_VERSION`                |          | Reported by `/healthz` and `/v1/system/info` (default `dev`).                                                          |
| `LOG_LEVEL`                     |          | `debug` · `info` (default) · `warn` · `error` · `silent`.                                                              |
| `TRUST_PROXY_HEADERS`           |          | `true` behind a proxy that sets `X-Forwarded-For` (needed for per-IP limits).                                          |
| `MAX_BODY_BYTES`                |          | Default body cap (1 MiB).                                                                                              |
| `CRON_DEADLINE_MS`              |          | Cron time budget (50 000; keep below the route's `maxDuration` of 60 s).                                               |
| `STAFF_SESSION_IDLE_MINUTES`    |          | Default 30.                                                                                                            |
| `STAFF_SESSION_MAX_HOURS`       |          | Default 12.                                                                                                            |
| `MERCHANT_SESSION_IDLE_MINUTES` |          | Default 1440.                                                                                                          |
| `MERCHANT_SESSION_MAX_HOURS`    |          | Default 336.                                                                                                           |

`instrumentation.js` loads the configuration when a server instance starts: an invalid configuration is logged as
`Failed to prepare server … Invalid Portal configuration: …` and every request (including `/healthz`) fails, so a
bad deployment is visible immediately. `next build` never needs the environment or a database.

### Key management

- **Signing key rotation**: generate a new key, deploy `PORTAL_SIGNING_KEYS=[new, old]` (both published; the new one
  signs), wait for the overlap (product JWKS caches refresh within 5 min; launch and assertion lifetimes are minutes),
  then remove the old key. Website keys are signed by the Portal key: **re-issue website keys before removing the
  key that signed them** (F.5). Compromise: remove the key at once and re-issue.
- **KEK rotation**: prepend a new KEK (`SECRETS_KEK=k2:…,k1:…`). New secrets are sealed with `k2`; old ones still open
  with `k1`; `envelope.rewrap(sealed)` moves a record to `k2` without touching its ciphertext. Remove `k1` only after
  every record is rewrapped.
- Generate values: `node scripts/dev-env.js` (development only) or, for production, a fresh key from
  `generateSigningKey` (`@ss/protocol`) and `openssl rand -base64 32` for the secrets.

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
