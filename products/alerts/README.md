# Alerts & Waitlists (`alerts`)

An SSPS v1 **service product** (PLAN Part D §16, Part E). Shoppers ask to be told when an item is **back in stock**,
when its **price drops**, when a **slot or seat** opens up, or when anything the merchant defines happens (**custom**
alerts from `custom.*` events). Stock, price and custom changes arrive from the Event Hub, the API or CSV; the product
claims the right waiters exactly once and delivers through the **merchant's own messaging provider** with templates
per language, frequency caps, quiet hours in the website's time zone, batching and safe unsubscribe links. **All data
lives in the merchant's own MongoDB** (connected in the Portal); this deployment keeps only caches, queues and website
ids.

Built on `@ss/app-kit` (registration, SSO launches, website keys, entitlements with offline grace, events, usage,
client-owned data, connectors, bring-your-own identity) and `@ss/rules` (custom-type conditions). Business rules live
only in `core/` (pure) and `headless/`. Ported from ibrahimMobiles (`packages/shared/src/stockAlerts.ts`,
`packages/db/src/stockAlerts.ts`, the WhatsApp unsubscribe page): the before/after decision of `shouldSendStockAlert`,
the pending → notified compare-and-set claim before sending, one active alert per contact and target, the two-step
unsubscribe page that link previews cannot trigger.

## Elements

Every element is switchable per website and priced in millicredits per hour; every setting is a feature with a schema,
a default and plan bounds (`x-plan`) in `schemas/<element>.features.json` — nothing is hard-coded, no regional
defaults (phones are international E.164, the time zone and language are features).

| Element             | Modes   | Price /h | What it does                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------- | ------- | -------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `triggers`          | C       |      100 | `inventory.changed@1`, `price.changed@1`, `custom.*` (Event Hub or `POST /v1/events`), `POST /v1/triggers`, `:batch`, `:import` (CSV). Stock per location (tracked locations, in-stock threshold), price lists, out-of-order protection. Stock and price are trusted only from servers (`merchant`/`staff`/`system` actors, `sk_` keys) unless `accept_customer_events`. Fan-out limit per run; larger waitlists continue in the next run |
| `types`             | C       |      200 | Back-in-stock; price-drop (minimum drop % and/or minor-unit amount, shopper target price, only while in stock); availability / slot waitlists (free units × notify-per-unit, in waitlist order); custom types (`custom.<name>[@v]`, target field, rules@1 `when`, browser events opt-in, capacity field); expiry, retention, repeat                                                                                                       |
| `capture`           | A, B, C |      200 | The "Notify me" form: drop-in renderer (`inline`, `button`), headless core, `POST /v1/subscriptions`. Address from the customer's own login token (`SS-Identity`) or a typed e-mail / E.164 phone, consent text (version stored), double opt-in, per-IP-per-hour and per-contact-per-day limits, active caps per contact and website                                                                                                      |
| `dispatch`          | C       |      300 | Outbox through the merchant's messaging connector: templates per type × channel × language (catalog + merchant overrides), frequency caps per contact (day / ISO week, defer or drop), quiet hours, batching into digests, retries with backoff, claim-before-send. Metered **`alert_send`**: 1 mc per message (pro includes 2 000 / hour)                                                                                                |
| `waitlist_priority` | C       |      150 | FIFO or tier order from a claim of the customer's login token (`tier_claim`, e.g. `loyalty.tier`), positions for shoppers, ordered waitlists for the merchant                                                                                                                                                                                                                                                                             |
| `unsubscribe`       | C       |       50 | Signed links (`us1.<payload>.<hmac>`, TTL) in every message, hosted confirm page (`GET /u/{token}` shows a button, `POST` applies), RFC 8058 one-click, scope contact / subscription, suppression list (keyed hashes), your own page via `page_url` + `POST /v1/unsubscribe`                                                                                                                                                              |
| `analytics`         | C       |      100 | Subscriptions by type and status, messages by channel and status, notified / unsubscribe / delivery rates (basis points), daily series                                                                                                                                                                                                                                                                                                    |

Plans: **starter** = triggers, types, capture, dispatch, unsubscribe (850 mc/h; analytics add-on); **pro** = all seven
(1 100 mc/h, 2 000 sends/h included). `dispatch` depends on `unsubscribe`, so every message has a working opt-out.
Trial 48 h.

**Events.** Consumes `custom.*`, `inventory.changed@1`, `price.changed@1`. Publishes `alerts.subscribed@1` and
`alerts.sent@1` (schemas in `schemas/events/`; no addresses in either).

**Customer identity.** Browser (`pk_`) routes take the customer from `SS-Identity` (the website's own login, verified
by app-kit with the issuer in the entitlement document, `identity: 'optional'`): its subject is the customer id, its
e-mail / phone the address, and a configurable claim the waitlist tier. Guests type an address when the merchant
allows it.

## How it works

- **Exactly once.** A trigger run is unique per event id / Idempotency-Key. A subscription is told about a change by
  being **claimed** (`pending → claimed`, compare-and-set on its `cycle`) before its alert is queued, so duplicate
  deliveries, a second event reporting the same change and concurrent instances never tell anyone twice.
- **Claim before send.** The outbox (`ss_alerts_messages`) is drained with `findOneAndUpdate` (`queued → sending`,
  lease owner and expiry); only the owner may settle a message. A crashed instance's lease expires and another takes
  over with the same `Idempotency-Key: <message id>` towards the provider. `recover` repairs claims whose queue or
  close step was lost. Usage (`alert_send:<message id>`) and `alerts.sent@1` are keyed by the message.
- **Before a send:** quiet hours (deferred, no attempt spent), suppression (cancelled), still-claimed items only,
  frequency caps (atomic reservations, given back when nothing is sent).
- **Provider wire format** (generic HTTP connector, `POST <baseUrl><dispatch.send_path>`):
  `{ id, channel, to: { email } | { phone }, lang, subject?, text, headers?: { List-Unsubscribe, List-Unsubscribe-Post },
metadata: { websiteId, product, kind, types, subscriptionIds } }`, `Authorization` per the connector, `Idempotency-Key`.
- **Data.** `ss_alerts_{subscriptions,messages,triggers,items,counters,suppressions,audit}` in the merchant database,
  `websiteId` first in every index, TTL on expiry fields, versioned migrations; export / anonymise by customer id,
  e-mail or phone via the Portal-signed standard routes.

## API (Mode C)

`openapi.json` documents every operation with examples (`x-ss-key-kind: "sk"` = server keys only).

| Operation     | Route                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------- |
| Triggers      | `POST /v1/triggers` · `POST /v1/triggers:batch` · `POST /v1/triggers:import` (CSV) · `GET /v1/triggers[/{id}]` (sk) |
| Types         | `GET /v1/alert-types` (pk/sk — what the widget needs)                                                               |
| Subscriptions | `POST /v1/subscriptions` · `GET /v1/subscriptions` · `GET`/`DELETE /v1/subscriptions/{id}` · `POST …:confirm`       |
| Outbox        | `GET /v1/messages[/{id}]` · `POST /v1/messages:dispatch` (sk)                                                       |
| Waitlist      | `GET /v1/waitlist?type=&itemId=` (sk) · `GET /v1/waitlist/position?subscriptionId=`                                 |
| Unsubscribe   | `GET /v1/unsubscribe/{token}` (preview) · `POST /v1/unsubscribe` · hosted `GET`/`POST /u/{token}`, `/c/{token}`     |
| Analytics     | `GET /v1/analytics?days=` (sk)                                                                                      |
| Standard      | `/v1/entitlement`, `/v1/config`, `/v1/events`, `/v1/strings`, `/healthz`, `/readyz`, `/v1/data:export\|anonymize`   |

Errors are RFC 9457 problems with stable codes (`contact_invalid`, `consent_required`, `entry_not_allowed`,
`in_stock`, `limit_reached`, `contact_suppressed`, `rate_limited`, `token_invalid`, `csv_invalid`, …).

**Headless (Mode B).** `headless/notifyMe.js#createNotifyMe({ config: { itemId, variantId?, item?, price?, types?,
lang? }, strings, client, identity: { signedIn }, emit })` → `{ state, actions: { load, setType, setChannel, setEmail,
setPhone, setConsent, setTarget, subscribe, unsubscribe }, subscribe, validate, strings, t, destroy }`;
`notifyMeClient(createElementApi(…))` adapts the `@ss/web/element` API client. **Drop-in (Mode A).**
`ui/notifyMe.js#render({ state, actions, strings, theme: { variant: 'inline' | 'button' }, slots, dom })`, design
tokens only, native controls, polite live region.

## Dashboard (SSO)

Opened from the Portal (`/sso?launch=` → `ss_session`): overview KPIs (active, subscribed, sent, failed, notified and
unsubscribe rates), latest subscriptions and messages (addresses masked). Demo launches show sandbox data decided by
the real type rules; impersonation shows the audit banner.

## Develop and certify

```sh
ss dev env > .env.local        # signing key, token hash, portal URL (keep the printed registration token)
ss dev                         # local Portal emulator (ss.dev.json)
pnpm dev                       # Next.js on :3000 — or `node serve.js 3000` (plain node:http)
ss dev register --url http://localhost:3000 --token <token>
ss app validate                # manifest, anatomy, import direction, tokens, strings, OpenAPI coverage
ss certify . --url http://localhost:3000 --token <fresh token>
pnpm check                     # format, lint, typecheck, tests with coverage: core, headless, renderer, API on MongoDB, certify
```

`tests/certify.test.js` runs the full `ss certify` suite (every check must pass). The system test `e2e/tests/alerts-portal.test.js` (monorepo workspace `@ss/e2e`) runs the
real Portal in process: staff bootstrap → catalog handshake → activation → merchant signup → website → credits →
starter subscription → database **and messaging** connectors (a fake HTTP provider on 127.0.0.1, dev allowlist) → a
shopper subscribes with the `pk_` key → `inventory.changed@1` (0 → 5) through the Event Hub, duplicated → exactly one
message at the provider → unsubscribe (GET changes nothing, POST stops) → usage once → hourly settlement (850 base +
1 metered).

## Deploy to Vercel

1. Create a Vercel project with this directory as root (framework: Next.js). In the monorepo, `next.config.js` sets
   the workspace root automatically.
2. Environment variables (Production):
   - `SS_PORTAL_URL` — the Portal URL this product trusts (pinned).
   - `SS_APP_SIGNING_KEY` — Ed25519 private JWK (one line); `SS_REGISTRATION_TOKEN_HASH` — SHA-256 of the one-time
     registration token issued by Portal staff; `SS_APP_ID` — after registration (optional; recorded by the handshake).
   - `SS_PRODUCT_DB_URI` — the product's own small MongoDB (sessions, caches, usage queue, website ids). Required.
   - `CRON_SECRET` (≥ 16 chars) — for `vercel.json`'s `/cron/dispatch`, the daily catch-up over every website.
     Deferred, batched and retried messages and open waitlists are otherwise sent by a short background pass after
     requests (at most every 5 minutes per website), so the free Vercel Hobby plan (one daily cron) is enough.
   - `ALERTS_TOKEN_SECRET` — optional (≥ 32 chars) secret of unsubscribe / confirm links and contact hashes; derived
     from the signing key when empty (rotating the key then invalidates outstanding links and re-keys contact hashes).
3. Deploy, then register from the Portal admin (`POST /v1/admin/apps/register`), review and activate. `endpoints.base`
   in `manifest.json` must be the deployment's https origin (it is also the origin of the hosted unsubscribe pages).
4. Run `ss certify . --url https://<deployment> --token <token>` against a fresh deployment before listing.

## Platform gaps (resolved in the kit)

- Messaging: app-kit's built-in `generic-http` and `smtp` adapters match the Portal's descriptors, so the product
  registers none. Over SMTP, e-mail alerts go out as plain text with the List-Unsubscribe headers; SMS needs an HTTP
  gateway (`channel_unsupported`, not retried); SMTP 5xx replies fail permanently, 4xx replies and timeouts are retried.
- `ss certify` uses the resource marked `x-ss-certify: true` in `openapi.json` (`POST /v1/triggers`) and has samples for
  every catalogued event (`inventory.changed@1`, `price.changed@1` included).
- `keys.verify` awaits the in-flight revocation sync on a cold instance (no 503 for concurrent first requests).
- The waitlist tier is read from `ctx.identity.claims` (the payload app-kit verified), not by decoding the token again.
- Manifest: product-level `requires` lists only `database`; `messaging` is required by `dispatch`.
- Still pending on the Portal: the entitlement document's `website { timeZone, language }` (until it is filled,
  `dispatch.time_zone` and `capture.default_lang` are features) and `context.keyKind` on deliveries (provenance is
  inferred from the actor type until then).

## Changelog

- **1.0.0** — first release: seven elements, Notify-me renderer and headless core, REST v1, hosted link pages,
  dashboard, scheduled outbox job.
