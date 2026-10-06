# Coupons (`coupons`)

An SSPS v1 **service product** (PLAN Part D §4, Part E). Merchants create coupon codes — one shared code or thousands of
unique single-use codes — decide who and what they apply to, what they take off, how often they can be used and how
they combine, and redeem them at **any** checkout: drop-in apply box, headless core or API only. **All coupon data
lives in the merchant's own MongoDB** (connected in the Portal); this deployment keeps only caches, queues and website
ids.

The offer engine is ported from ibrahimMobiles `packages/shared/src/pricing/**` (offer evaluator, matching, scope,
schedule with time zones and overnight windows, stacking with the loyalty flag) and generalised: no store assumptions —
carts are generic `{ currency, lines: [{ itemId, variantId?, quantity, unitAmount, attributes?, collections? }],
customer?, paymentMethod?, deliveryMethod? }`. Built on `@ss/app-kit` and `@ss/rules`; business rules live only in
`core/` (pure) and `headless/`.

## Elements

Every element is switchable per website and priced in millicredits per hour; every setting is a feature with a schema,
a default and plan bounds (`x-plan`) in `schemas/<element>.features.json` — nothing is hard-coded.

| Element        | Modes   | Price /h | What it does                                                                                                                                                                                                                                            |
| -------------- | ------- | -------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codes`        | C       |      250 | Coupons and codes: shared code or bulk unique codes from patterns (`?` alphabet, `#` digit; cryptographically random, unbiased, entropy-checked), single-/multi-use, validity (dates, weekday/time windows incl. overnight, any zone), auto-apply links |
| `eligibility`  | C       |      150 | Structured conditions (items, variants, collections, attributes, unit price, line/cart quantity, subtotal, payment/delivery method, country, segments, first order, device, source; and/or groups) + rules@1 `when`                                     |
| `actions`      | C       |      100 | percent (0 < p ≤ `max_percent` ≤ 100), fixed (once or per unit, capped), free shipping, buy X get Y (cheapest units), tiered by quantity or subtotal, gift item; rounded once, allocated to lines (largest remainder)                                   |
| `limits`       | C       |      100 | Uses per customer (bring-your-own identity) and per device, velocity limits (checks, failed codes, reservations per window), blocklist (customer, e-mail, device, code)                                                                                 |
| `stacking`     | C       |       50 | Classes that combine (item / order / shipping or your own), exclusive coupons, priorities, `best_discount` or `in_order`, max per cart, `loyaltyAllowed` / `dealsAllowed` on every quote                                                                |
| `api`          | C       |      150 | validate / quote / reserve / redeem / release / attach — idempotent; reservations with a TTL on atomic counters. Metered: `redemption` (1 mc each; starter 500 / pro 5 000 included)                                                                    |
| `apply_box`    | A, B, C |       50 | Drop-in renderer (≤ 8 KB, tokens only, `inline` / `collapsible`, slots `before` / `after` / `success`), headless core, element-stub view                                                                                                                |
| `distribution` | C       |      100 | Share links (auto-apply parameter, UTM), QR codes as SVG generated in `core/qr.js`, CSV exports (formula injection neutralised)                                                                                                                         |
| `reporting`    | C       |      100 | Redemptions, discount, revenue and average order per currency, discount rate, undone redemptions, top codes, per coupon                                                                                                                                 |

Plans: **starter** = codes, eligibility, actions, limits, api, apply_box (800 mc/h; add-ons stacking, distribution,
reporting); **pro** = all nine (1 050 mc/h). Trial 48 h.

**Events.** Publishes `coupons.redeemed@1`, `coupons.released@1` (reason `released` / `expired` / `order_cancelled` /
`order_refunded`), `coupons.exhausted@1` (scope `code` or `coupon`); schemas in `schemas/events/`. Consumes
`order.completed@1` (confirm the order's reservations), `order.cancelled@1` and `order.refunded@1` (release per
`api.release_on_cancel` / `api.release_on_refund`).

**Customer identity.** Browser (`pk_`) calls take the customer only from `SS-Identity` (the website's own login token,
verified by app-kit, `identity: 'optional'`); a body `customer.id` is ignored for browser keys. Server (`sk_`) calls name
the customer in the cart.

## How it works

- **Atomic limits.** A reservation claims one unit of each limit of each code (`code`, `coupon`, `customer`, `device`)
  with a single conditional `$inc` (`taken < max`); a refused claim gives back those already taken. Concurrent
  checkouts can never over-redeem a limited code (tested with four parallel reservations and through the real Portal).
- **Lifecycle.** `pending → reserved → redeemed | released | expired` by compare-and-set; a lapsed reservation is
  treated as expired as soon as it is read or touched (its uses go back then, also when its code, customer or device
  needs the use, or its code is read), and the dashboard's "Release expired reservations" releases them all at once.
  Nothing runs on a timer (no crons, no background loops, no periodic heartbeat); app-kit sends usage and events right
  after the request that queued them. See `jobs/README.md`.
  A late `order.completed@1` re-claims an expired reservation when `api.confirm_expired` allows and the use is free.
- **Exactly once.** Reservation ids derive from `reference` or the Idempotency-Key; redemption counters count once per
  code (`counted`); usage records and events carry deterministic idempotency keys.
- **Data.** Collections `ss_coupons_{coupons,codes,reservations,usage,velocity,blocks,audit}` in the merchant database,
  `websiteId` first in every index, TTL on velocity windows, versioned migrations, export/anonymise via the
  Portal-signed standard routes (reservations: customer id, e-mail, device id; usage: customer id; usage keys are hashes).

## API (Mode C)

`openapi.json` documents every operation with examples. Highlights (`sk_` = server key, `pk_` = browser key):

| Operation    | Route                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Coupons      | `GET/POST /v1/coupons` · `GET/PATCH/DELETE /v1/coupons/{id}` · `GET /v1/coupons/{id}/codes` · `POST …/codes:generate`                      |
| Codes        | `GET/PATCH /v1/codes/{code}`                                                                                                               |
| Eligibility  | `POST /v1/eligibility:check`                                                                                                               |
| Checkout     | `POST /v1/validations` (pk) · `POST /v1/quotes` (pk) · `POST /v1/reservations` · `GET …/{id}` · `…/{id}/redeem` · `…/release` · `…/attach` |
| Redemptions  | `GET/POST /v1/redemptions` · `GET /v1/redemptions/{id}` · `POST …/{id}/release`                                                            |
| Limits       | `GET/POST /v1/blocks` · `DELETE /v1/blocks/{id}`                                                                                           |
| Distribution | `POST /v1/share-links` · `GET /v1/share-links/{code}` · `GET …/{code}/qr` (SVG) · `GET /v1/exports/{couponId}` (CSV)                       |
| Reporting    | `GET /v1/reports?from=&to=`                                                                                                                |
| Apply box    | `GET /v1/elements/apply_box/view` · `POST /v1/elements/apply_box/actions/apply` (element stub, pk)                                         |
| Standard     | `/v1/entitlement`, `/v1/config`, `/v1/events`, `/v1/strings`, `/healthz`, `/readyz`, `/v1/data:export`, `/v1/data:anonymize`               |

Errors are RFC 9457 problems with stable codes (`code_not_found`, `exhausted`, `not_eligible`, `outside_schedule`,
`currency_mismatch`, `identity_required`, `customer_limit_reached`, `not_combinable`, `velocity_limited`,
`reservation_expired`, …). See `docs/guide.md` for the checkout flow, the apply box and condition examples.

## Dashboard (SSO)

Opened from the Portal (`/sso?launch=` → `ss_session`): overview KPIs and top codes, coupon list with a create form
(audited), coupon detail with codes, share link, QR code and CSV export, a live rules@1 checker, settings (link to the
Portal — the product never stores merchant configuration). Demo launches show sandbox data computed with the real
core; impersonation shows the audit banner.

## Develop and certify

```sh
ss dev env > .env.local        # signing key, token hash, portal URL (keep the printed registration token)
ss dev                         # local Portal emulator (ss.dev.json)
pnpm dev                       # Next.js on :3000 — or `node serve.js 3000` (plain node:http)
ss dev register --url http://localhost:3000 --token <token>
ss app validate
ss certify . --url http://localhost:3000 --token <fresh token>
pnpm check                     # format, lint, typecheck, tests with coverage: core, headless, renderer, API on MongoDB, certify
```

`tests/certify.test.js` runs the full `ss certify` suite (every check must pass); the system test `e2e/tests/coupons-portal.test.js` (monorepo workspace `@ss/e2e`) runs the
real Portal in process: staff bootstrap → catalog handshake → activation → merchant signup → website → credits →
subscription → database connector → single-use code created through the API → two concurrent reservations (exactly
one wins) → `order.completed@1` through the Event Hub → redeemed in the merchant DB → usage → hourly settlement
(elements charged, metered hour booked).

## Deploy

1. Deploy this directory on any Node 22 host that runs Next.js (on Vercel: Root Directory = this folder). In the monorepo, `next.config.js` sets the
   workspace root automatically.
2. Environment variables (Production): `PORTAL_URL` (pinned Portal), `SIGNING_KEY` (`kid:seed`, Ed25519 seed in
   base64url), `REGISTRATION_TOKEN_HASH`, `APP_ID` (optional; recorded by the handshake), `DATABASE_URI` (the
   product's own small MongoDB — required in production), `DATABASE_MAX_POOL_SIZE` (optional, default 5).
3. Deploy, then register from the Portal admin (`POST /v1/admin/apps/register` with the deployment URL and the token),
   review and activate. `endpoints.base` in `manifest.json` must be the deployment's https origin.
4. Run `ss certify . --url https://<deployment> --token <token>` against a fresh deployment before listing.

## Changelog

- **1.0.0** — first release: nine elements, apply box renderer and headless core, REST v1, dashboard.
