# Loyalty & Rewards (`loyalty`)

An SSPS v1 **service product** (PLAN Part D §3, Part E). Merchants reward customers with points for purchases and any
other event, let them redeem points at any checkout, grow them through tiers, expire unused points, reward referrals and
show a wallet on the website — drop-in, headless or API only. **All loyalty data lives in the merchant's own MongoDB**
(connected in the Portal); this deployment keeps only caches, queues and website ids.

Built on `@ss/app-kit` (shared-secret Portal connect, SSO launches, website keys, entitlements with offline grace, events, usage,
client-owned data) and `@ss/rules` (conditions). Business rules live only in `core/` (pure) and `headless/`.

## Elements

Every element is switchable per website and priced in millicredits per hour; every setting is a feature with a schema,
a default and plan bounds (`x-plan`) in `schemas/<element>.features.json` — nothing is hard-coded.

| Element       | Modes   | Price /h | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------- | ------- | -------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `earn_rules`  | C       |      400 | Members and their points. Rules: trigger `type@v` (`order.placed`, `order.completed`, `customer.created`, `custom.*`) + optional rules@1 `when` + formula (`fixed`, `percent` of an amount field, `per_unit`) + caps per event and per customer period (day/week/month/year, website time zone) + exclusions (items, SKUs, shipping, tax, discounts). Manual/API earns. Metered: `point_transaction` (1 mc per 10; starter 2 000 / pro 20 000 included) |
| `redeem`      | C       |      300 | `quote` / `redeem` / `release` / `confirm` for any checkout (idempotent): minimum points, maximum share of the transaction, conversion rate (`rate_points` → `rate_value_minor`), with or without offers                                                                                                                                                                                                                                                |
| `wallet`      | A, B, C |      200 | Balance badge, tier progress, points expiring soon, history; default renderer ≤ 8 KB, headless core, `GET /v1/wallet` with customer wallet tokens                                                                                                                                                                                                                                                                                                       |
| `tiers`       | C       |      300 | Ladder by points earned or spend in a rolling window of local months, earn multipliers, perk flags, downgrade policy (`never`, `end_of_period`, `immediate`)                                                                                                                                                                                                                                                                                            |
| `expiry`      | C       |      100 | Lots expire FIFO `months` after they were earned (+ grace days); `loyalty.expiring@1` notices `notice_days` ahead; expired, noticed and tier-reviewed when a member is read; whole website from the dashboard button                                                                                                                                                                                                                                    |
| `referrals`   | C       |      300 | Codes (`<prefix><random>`), attribution (API or `customer.created@1` `source: "referral:<CODE>"`), window, rewards for both sides on the referee's first qualifying order, fraud caps (self, duplicates, existing customers, per month, lifetime)                                                                                                                                                                                                       |
| `adjustments` | C       |      100 | Manual credits/debits with reason codes and notes (API and dashboard), audited in the merchant database                                                                                                                                                                                                                                                                                                                                                 |
| `reversal`    | C       |      100 | `order.cancelled@1` / `order.refunded@1`: redeemed points back first, then earned points reversed (proportionally for partial refunds), capped at the balance or allowed negative                                                                                                                                                                                                                                                                       |

Plans: **starter** = earn_rules, redeem, wallet (+ add-ons reversal, adjustments); **pro** = everything but referrals
(+ add-on referrals). Trial 48 h.

**Events.** Consumes `order.placed@1` (order snapshot: customer, lines, amounts), `order.completed@1` (a completion
that carries its own `customer`/`currency`/`lines`/`amounts` settles even without a placement), `order.cancelled@1`,
`order.refunded@1`, `customer.created@1` and `custom.*` (from the Event Hub; same earn rules and idempotency key as
`POST /v1/activities`; the customer is `data.customerId` or the customer actor). The customer of an order is
`customerId`, else `customer.customerId`, else the federated `customer.subject`.

**Customer identity.** Browser (`pk_`) routes take the customer from `SS-Identity`: when the website registered its own
identity issuer in the Portal (Website → Identity), the site's login token is verified by app-kit (`identity:
'optional'`, `ctx.identity.subject` = customer id); otherwise — or for wallet tokens — a Loyalty wallet token minted by
the merchant's server with `POST /v1/wallet-tokens` (the fallback).
Publishes `loyalty.earned@1`, `loyalty.redeemed@1`, `loyalty.tier_changed@1`, `loyalty.expiring@1` (schemas in
`schemas/events/`).

## How it works

- **Member document = unit of consistency.** Balance, FIFO lots, debt, tier buckets, cap usage and a short journal move
  together under an optimistic `version` — no multi-document transactions, so standalone MongoDB works too.
- **Exactly once.** Every movement has a deterministic source key (`earn:order.completed@1:<orderId>`,
  `redeem:<id>`, `return:<id>`, `reverse:<orderId>:<claim>`, `adjust:<Idempotency-Key>` …). The append-only ledger
  (`ss_loyalty_transactions`) is unique on it; the journal repairs a ledger write lost to a crash; transaction ids,
  usage records and published events derive from it. Reversals are claimed on the order first, so concurrent refunds
  never reverse more than was earned.
- **Lots.** Credits open lots; spending consumes the oldest first. Released or refunded redemptions are restored into
  their original lots (original expiry) — a redeem/release cannot extend the life of points.
- **Data.** Collections `ss_loyalty_{members,transactions,orders,redemptions,referrals,audit}` in the merchant
  database, `websiteId` first in every index, created lazily; versioned migrations; export/anonymise via the
  Portal-signed standard routes.
- **No background work.** Nothing runs on a timer (no crons, no background tasks). When a request reads or moves a
  member, that member's lapsed lots are expired, a due tier review is applied and a due `loyalty.expiring@1` notice is
  published. The merchant can run the same for the whole website with the dashboard's "Run expiry now" button
  (`POST /v1/dashboard/expiry:run`, 10 s per press; press again while more remain) or `POST /v1/expiry:run`.

## API (Mode C)

`openapi.json` documents every operation with examples. Highlights (`sk_` = server key, `pk_` = browser key):

| Operation              | Route                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| Earn (manual / server) | `POST /v1/earnings` (sk, Idempotency-Key) · `GET /v1/earnings` (sk; pk only with a wallet token)             |
| Members                | `GET /v1/members?q=` · `GET /v1/members/{customerId}` · `…/balance` · `…/history` (cursor)                   |
| Rules                  | `GET /v1/rules` (with diagnostics) · `POST /v1/rules:check`                                                  |
| Custom events          | `POST /v1/activities` `{ type: "custom.<name>@1", customerId, data }`                                        |
| Checkout               | `POST /v1/redemptions:quote` · `POST /v1/redemptions` · `POST /v1/redemptions/{id}/release` · `…/confirm`    |
| Wallet                 | `POST /v1/wallet-tokens` (sk, fallback) · `GET /v1/wallet` (pk + `SS-Identity`: login token or wallet token) |
| Tiers, expiry          | `GET /v1/tiers` · `POST /v1/expiry:run`                                                                      |
| Referrals              | `POST /v1/referral-codes` · `POST /v1/referrals` · `GET /v1/referrals/{customerId}`                          |
| Adjustments            | `POST /v1/adjustments` · `GET /v1/adjustments`                                                               |
| Standard               | `/v1/entitlement`, `/v1/config`, `/v1/events`, `/v1/strings`, `/healthz`, `/readyz`, `/v1/data:export        | anonymize` |

Errors are RFC 9457 problems with stable codes (`insufficient_points`, `below_minimum`, `above_maximum`,
`offers_not_allowed`, `self_referral`, `identity_required`, …).

**Headless (Mode B).** `headless/wallet.js#createWallet({ config, strings, client, emit })` → `{ state, actions: { load,
loadMore }, subscribe, validate, strings, t, formatPoints, destroy }`; `client.wallet({ cursor })` calls
`GET /v1/wallet`. **Drop-in (Mode A).** `ui/wallet.js#render({ state, actions, strings, theme: { variant: 'badge' |
'panel' }, slots, dom })`, design tokens only.

## Dashboard (SSO)

Opened from the Portal (`/sso?launch=` → `ss_session`): overview KPIs with a "Run expiry now" button, earn rules with live rules@1 validation, member
search, member detail with history and audited adjustments, settings (link to the subscription's configuration in the
Portal — the product never stores merchant configuration). Demo launches ("Try demo") show sandbox data computed with
the real core; impersonation shows the audit banner.

## Develop and certify

```sh
ss dev env > .env.local        # DATABASE_URI (empty = in-memory control store) + a generated CONNECT_SECRET
ss dev                         # local Portal emulator (ss.dev.json)
pnpm dev                       # Next.js on :3000 — or `node serve.js 3000` (plain node:http)
ss dev connect --url http://localhost:3000 --secret <CONNECT_SECRET>   # from .env.local
ss app validate                # manifest, anatomy, import direction, tokens, strings, OpenAPI coverage
ss certify . --url http://localhost:3000   # restart the product first (fresh token)
pnpm check                     # format, lint, typecheck, tests with coverage: core, headless, renderer, API on MongoDB, certify
```

The test suite includes `tests/certify.test.js` (the full `ss certify` suite, every check must pass). The system test
`e2e/tests/loyalty-portal.test.js` (monorepo workspace `@ss/e2e`) runs the product against the real Portal in process (staff bootstrap → Add product (URL + connect secret) → activation → merchant
signup → website → credits → subscription → database connector → Event Hub delivery → points in the merchant DB →
hourly settlement).

## Deploy

1. Deploy this directory on any Node 22 host that runs Next.js (on Vercel: Root Directory = this folder). In the
   monorepo, `next.config.js` sets the workspace root automatically.
2. Set two environment variables: `DATABASE_URI`, the product's own small MongoDB (sessions, caches, usage queue, its
   signing key and generated secrets), and `CONNECT_SECRET` (random, at least 32 characters). Nothing else.
3. Portal → Admin → Apps → **Add product** → the product URL and `CONNECT_SECRET` → **Connect**. The product generates
   its key and pins the Portal; then review and activate it in the Portal. Nothing runs on a timer.
4. Run `ss certify . --url https://<deployment> --secret <CONNECT_SECRET>` against a fresh (unconnected) deployment before listing.

## Changelog

- **1.1.0 (unreleased)** — bring-your-own identity via app-kit (wallet tokens as fallback), `custom.*` consumed from
  the Event Hub, self-contained order completions; no scheduled or periodic work at all (no crons, no background
  tasks): a member's lapsed points, due tier review and expiry notice are handled when a request reads or moves that
  member, and the dashboard's "Run expiry now" button (`POST /v1/dashboard/expiry:run`) or `POST /v1/expiry:run` runs
  the whole website.
- **1.0.0** — first release: eight elements, wallet renderer and headless core, REST v1, dashboard.
