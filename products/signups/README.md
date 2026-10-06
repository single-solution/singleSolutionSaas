# Signups & Identity (`signups`)

An SSPS v1 **service product** (PLAN Part D §2, Part E): passwordless sign-in for any website — one-time codes by
e-mail, SMS or WhatsApp, magic links — customer profiles, and **sessions issued by the website's own identity issuer**
that every other product accepts offline (bring-your-own identity, PLAN §5.3 / F.14). All customer data lives in the
merchant's own MongoDB; every message goes through the merchant's own messaging connector; this deployment keeps only
caches, queues and website ids.

Built on `@ss/app-kit` (registration, SSO launches, website keys, entitlements with offline grace, events, usage,
client-owned data, connectors). Business rules live only in `core/` (pure) and `headless/`. Ported from ibrahimMobiles:
the OTP service (atomic attempts, per-identity / IP / global caps, hashed codes — `apps/web/src/lib/otp`), the gateway
response handling (`packages/shared/src/messaging`) and the phone rules (`packages/shared/src/phone.ts`, generalised to
E.164 for any country).

## Elements

Every element is switchable per website and priced in millicredits per hour; every setting is a feature with a schema,
a default and plan bounds (`x-plan`) in `schemas/<element>.features.json` — nothing is hard-coded.

| Element         | Modes   | Price /h | What it does                                                                                                                                                                                                                                                   |
| --------------- | ------- | -------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profile`       | C       |      200 | Customers (unique e-mail / E.164 phone / external id per website), the merchant's field schema, international addresses, custom fields, verification badges, server import and administration (block, delete)                                                  |
| `sessions`      | C       |      300 | The website's identity issuer: EdDSA access tokens (`iss = <base>/i/<websiteId>`), per-website JWKS with pre-published key rotation, rotating refresh tokens with reuse detection, device list, revoke one / all (session version), lifetimes and idle timeout |
| `otp`           | C       |      300 | Codes by e-mail / SMS / WhatsApp: length, alphabet, expiry, cooldown, attempts, caps per identity / IP / website, templates per channel and language, sign-up on or off with uniform answers. Metered `otp_send` (2 mc each; starter 500 / pro 5 000 included) |
| `magic_link`    | C       |      200 | Single-use e-mail links back to the website's own domain (https, allowed paths, token in the URL fragment), optional same-device binding. Metered `magic_link_send` (2 mc; starter 200 / pro 2 000 included)                                                   |
| `account_pages` | A, B, C |      100 | Profile, addresses, devices, orders (from order events), agreements and data requests — default renderer (`tabs` / `stacked`), headless core, `GET /v1/account`                                                                                                |
| `widget`        | A, B    |        0 | Sign-in UI (`modal` / `inline`): identifier → code or link → terms → signed in; one-time-code autofill, remembered device                                                                                                                                      |
| `risk`          | C       |      150 | Disposable / blocked e-mail domains, distinct identities and failed verifications per IP per hour, new-device notices, risk event log                                                                                                                          |
| `consent`       | C       |       50 | Versioned terms / privacy documents, captured at sign-up, asked again when a required version changes; append-only acceptance records                                                                                                                          |
| `data_rights`   | C       |       50 | Self-service export (download window) and deletion after a cooling-off period (cancellable), executed when the customer is next read or by the dashboard's "Run due deletions" button                                                                          |

Plans: **starter** = profile, sessions, otp, widget, account_pages (+ add-ons magic_link, risk, consent, data_rights) —
900 mc/h; **pro** = everything. Trial 48 h.

**Events.** Publishes `customer.created@1`, `customer.signed_in@1`, `customer.updated@1` (standard events, scope
`events.publish:customer.*`) and `signups.customer_created@1`, `signups.signed_in@1` (schemas in `schemas/events/`).
`customer.created@1` carries only the customer id unless `profile.share_identifiers_in_events` is on. Consumes
`order.placed|completed|cancelled|refunded@1` for the account pages' order list (idempotent; out-of-order deliveries
converge).

## Bring-your-own identity: Signups as the website's issuer

1. Sign-in returns `{ customer, created, tokens: { accessToken, expiresAt, refreshToken, refreshExpiresAt, sessionId } }`.
   The access token is a JWT (`alg: EdDSA`, `kid`) with `iss = <base>/i/<websiteId>`, `sub` = customer id,
   `aud` = `sessions.audience` (default the website id), `sid`, `sv`, `amr`, and optionally `email` / `phone_number`
   with `*_verified`. Lifetime `sessions.access_ttl_minutes` (≤ 60, under app-kit's 24 h `iat` limit).
2. Public keys: `GET /.well-known/jwks/<websiteId>.json` (cacheable); discovery at
   `<iss>/.well-known/openid-configuration`.
3. **Signups asks the Portal to become the website's issuer; the merchant approves.** The manifest declares
   `capabilities.identityIssuer: true`, so Signups may call the Portal's product route
   `PUT /v1/product/websites/{w}/identity` (app-kit `product.portal.requestIdentityIssuer`) with
   `{ issuer, jwksUrl, audience, claimMap: { subject: "sub", email: "email", phone: "phone_number" } }`:
   - `POST /v1/issuer:register` (sk_, idempotent) sends it and answers **202 `{ status: "pending" }`** — the Portal
     stores the request, e-mails the merchant owner and shows it under Website → Identity — or **200
     `{ status: "active", registered: true }`** once the merchant has approved (repeating is safe). The dashboard's
     Identity page has the same action ("Request in the Portal") and shows the last request.
   - On **`entitlement.changed@1`** Signups sends the request once by itself when the website's entitlement document
     does not carry the issuer yet and there is no request for the current issuer configuration (a rejected request is
     not repeated on its own). Failures (Portal down, 403) are logged and never fail the event; the next entitlement
     change, the dashboard or `POST /v1/issuer:register` retries.
   - On approval the Portal makes Signups the website's active issuer (`managedBy` Signups), fetches the JWKS and
     re-signs the entitlement documents; `GET /v1/issuer` then reports `registered: true`. The merchant can still set
     or replace the issuer directly (Website → Identity, or `PUT /v1/merchants/{m}/websites/{w}/identity` with the
     same body — `GET /v1/issuer` returns that call as `portal`), and may reject the request.
4. From then on every product verifies the customer offline with app-kit (`identity: 'optional' | 'required'`). The
   Portal end-to-end test proves it: Loyalty serves `GET /v1/wallet` to a Signups token.

Revocation: Signups' own routes check the session and session version on every request (immediate); other products
see a revoked session when its short-lived access token expires. Key rotation (`sessions.key_rotation_days`, or
`POST /v1/issuer:rotate`) publishes the next key `sessions.key_prepublish_hours` before it signs (the Portal refreshes a
JWKS URL at most hourly) and keeps the old key until its tokens have expired. Rotation and pruning happen when the keys are read (signing, JWKS);
nothing runs on a timer.

## Security

- **Codes and tokens are never stored.** Codes, magic-link and refresh tokens are HMAC-SHA-256 with a per-website
  pepper; IPs and identifiers used as counter keys are HMACs too; comparisons are constant time.
- **Key custody.** The pepper and the issuer's Ed25519 private keys live in the merchant's database, sealed with
  AES-256-GCM; the sealing key is derived per website (HKDF, `info` = website id) from `SIGNUPS_SEAL_SECRET`, and the AAD
  binds website, purpose and key id. The merchant database alone reveals no key; this deployment alone holds no key.
  Rotate with `SIGNUPS_SEAL_SECRET_PREVIOUS` (old records open and are re-sealed). Losing the secret invalidates every
  sealed key (customers sign in again).
- **Attempts.** Each verification reserves an attempt atomically (`attempts < maxAttempts`) before comparing; parallel
  guesses never exceed the budget; consumption is a compare-and-set so one code signs in once.
- **Limits.** Cooldown first (so "resend" spam does not burn the hourly budget), then per identity / per IP / whole
  website per hour (gateway-pumping cap), plus risk velocity (distinct identities and failures per IP). All are atomic
  counters in the merchant database; answers carry `Retry-After`. Browser IP = first `X-Forwarded-For` hop (deploy behind
  a proxy that sets it, e.g. Vercel); server keys may forward the customer's IP in `SS-Client-IP`.
- **Anti-enumeration.** `POST /v1/otp` and `POST /v1/magic-links` answer identically whether or not an account exists.
  With sign-up off, unknown identifiers (and blocked accounts) get a decoy challenge that is never delivered and can
  never verify. Residual: a decoy answers without the gateway's latency (timing).
- **Refresh tokens** rotate on every use; replaying an old one ends the session (`refresh_reused`, risk event) except
  within `sessions.reuse_grace_seconds` (two tabs racing → `refresh_conflict`).
- **Redirects** of magic links: https on the website's domain only (subdomains when the website allows them), no
  credentials or ports, allowed path prefixes; the token is in the fragment (never sent to servers or in `Referer`).
- **Replay cache.** Token-issuing POSTs (verify, consume, refresh) are single use by construction and not replayable;
  POST answers that are replayable carry no personal data (`POST /v1/customers` → `{ id, status, createdAt }`; exports
  are downloaded with GET).

## API (Mode C)

`openapi.json` documents every operation with examples (`sk_` = server key, `pk_` = browser key; customer routes take
the access token in `SS-Identity`, server keys may name `?customerId=` instead).

| Operation      | Route                                                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Codes          | `POST /v1/otp` `{ channel, to, purpose?, locale?, deviceId? }` → 202 · `POST /v1/otp/{id}/verify` `{ code, consents? }`      |
| Magic links    | `POST /v1/magic-links` `{ email, redirect? }` → 202 · `POST /v1/magic-links:consume` `{ token }`                             |
| Sessions       | `POST /v1/sessions:refresh` · `:logout` · `:revoke-all` · `GET /v1/sessions` · `DELETE /v1/sessions/{id}`                    |
| Issuer         | `GET /v1/issuer` (sk) · `POST /v1/issuer:rotate` (sk) · `GET /.well-known/jwks/{websiteId}.json` · discovery                 |
| Customers (sk) | `GET /v1/customers?email=&phone=` · `POST /v1/customers` · `GET/PATCH/DELETE /v1/customers/{id}`                             |
| Profile        | `GET /v1/profile` · `PATCH /v1/profile` (field schema; identifiers change only through `purpose: "link"`)                    |
| Account        | `GET /v1/account`                                                                                                            |
| Consent        | `GET /v1/consents` · `POST /v1/consents`                                                                                     |
| Data rights    | `POST /v1/data-requests` `{ type }` · `GET /v1/data-requests` · `GET /v1/data-requests/{id}/export` · `DELETE …/{id}`        |
| Risk (sk)      | `GET /v1/risk-events`                                                                                                        |
| Standard       | `/v1/entitlement`, `/v1/config`, `/v1/events`, `/v1/strings`, `/healthz`, `/readyz`, `/v1/data:export`, `/v1/data:anonymize` |

Errors are RFC 9457 problems with stable codes (`code_invalid` — RFC 9457 extension member `attemptsRemaining` (also `errors[0]` `attempts_remaining`, kept for v1 clients) —,
`code_expired`, `attempts_exhausted`, `too_soon`, `send_limit`, `velocity_limit`, `identifier_invalid`,
`identifier_blocked`, `channel_disabled`, `delivery_failed`, `consent_required` — `errors` list the documents —,
`refresh_reused`, `refresh_conflict`, `session_ended`, `redirect_not_allowed`, `identity_required`, …); 429s also carry `retryAfterSeconds`.

**Messaging.** Both connector kinds are app-kit built-ins (the product registers no adapter): `smtp` delivers e-mail
codes only (`to`, `subject`, `text`; SMS / WhatsApp fail with `delivery_failed`). **Wire format of `generic-http`.** The
merchant's `generic-http` messaging connector receives `POST <baseUrl>/messages` with
`{ channel, to, subject?, text, purpose: otp | magic_link | new_device, lang, reference, idempotencyKey, variables }`
and routes it to its e-mail / SMS / WhatsApp provider. A non-2xx answer, or a 2xx body such as `{ "sent": false }` /
`{ "error": … }`, is a failed delivery (`502 delivery_failed`, the cooldown is released).

**Headless (Mode B).** `headless/signIn.js#createSignIn({ config, strings, client, session, deviceId, emit })`,
`headless/account.js#createAccount({ config, strings, client, session, emit })`, the session store
`headless/session.js#createSessionStore({ storage })` (refreshes early, single flight) and
`headless/client.js#createSignupsClient({ api })` over any `@ss/web/element` `createElementApi`. **Drop-in (Mode A).**
`ui/signIn.js#render` (`modal` / `inline`) and `ui/account.js#render` (`tabs` / `stacked`), design tokens only.

## Dashboard (SSO)

Opened from the Portal (`/sso?launch=` → `ss_session`): overview KPIs, customers with verification badges, and the
Identity page (issuer, JWKS URL, audience, claim map, published keys, registered or not, the last Portal request and a
"Request in the Portal" button for merchant / admin / impersonation launches). Demo launches show sandbox
data; impersonation shows the audit banner.

## Develop and certify

```sh
ss dev env > .env.local        # signing key, token hash, portal URL (keep the printed registration token)
ss dev                         # local Portal emulator (ss.dev.json)
pnpm dev                       # Next.js on :3000 — or `node serve.js 3000` (plain node:http)
ss app validate                # manifest, anatomy, import direction, tokens, strings, OpenAPI coverage
ss certify . --url http://localhost:3000 --token <fresh token>
pnpm check                     # format, lint, typecheck, tests with coverage: core, headless, renderers, API on MongoDB, certify
```

`tests/certify.test.js` runs the full `ss certify` suite (every check must pass). The system test `e2e/tests/signups-portal.test.js` (monorepo workspace `@ss/e2e`) runs the
real Portal in process with Signups **and** Loyalty: staff bootstrap → both products registered and activated →
merchant, website, credits, two subscriptions → database and messaging connectors (a fake gateway on loopback) →
browser asks for a code → the gateway receives it → verify → JWT → issuer registered through the Portal API → Loyalty
accepts the Signups token → `customer.created@1` routed by the Event Hub → usage reported → hourly settlement.

## Deploy

1. Deploy this directory on any Node 22 host that runs Next.js (on Vercel: Root Directory = this folder). In the monorepo, `next.config.js` sets the
   workspace root automatically.
2. Environment variables (Production): `PORTAL_URL`, `SIGNING_KEY` (`kid:seed`, Ed25519 seed in base64url),
   `REGISTRATION_TOKEN_HASH`, `APP_ID` (optional), `DATABASE_URI` (the product's own small MongoDB —
   required in production), **`SIGNUPS_SEAL_SECRET`** (≥ 32 random characters; keep it safe).
   There are no crons: nothing runs unless a request or event arrives (see [jobs/README.md](jobs/README.md)).
3. Deploy, register from the Portal admin (`POST /v1/admin/apps/register` with the deployment URL and the token),
   review and activate. `endpoints.base` in `manifest.json` must be the deployment's https origin — it is also the
   prefix of every website's issuer, so keep it stable.
4. Run `ss certify . --url https://<deployment> --token <token>` against a fresh deployment before listing.
5. Per merchant website: connect a database and a messaging connector; Signups then requests to be the issuer and the
   merchant approves it in the Portal (above).

## Changelog

- **Unreleased** — problems carry RFC 9457 extension members (`attemptsRemaining`, `retryAfterSeconds`); messaging
  uses app-kit's built-in `generic-http` / `smtp` adapters; Signups requests to be the website's identity issuer
  (`capabilities.identityIssuer`, `POST /v1/issuer:register`, on `entitlement.changed@1`, dashboard button; the
  merchant approves). Event-driven only: the maintenance cron, the background task after requests and the site
  registry are gone — a due deletion runs when the customer is read (single reads and listings) or from the
  dashboard's "Run due deletions" button (`POST /v1/dashboard/deletions:run`), keys rotate and are pruned when read.
- **1.0.0** — first release: nine elements, sign-in and account renderers with headless cores, REST v1, issuer (JWKS,
  discovery, rotation), dashboard, daily job (removed since).
