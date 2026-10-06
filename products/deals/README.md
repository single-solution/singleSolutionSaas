# Deals & Promotions (`deals`)

An SSPS v1 **service product** (PLAN Part D §5, Part E). Automatic offers without codes for **any** catalog: item and
collection deals with weekday / overnight windows in the website's time zone, cart thresholds and payment or delivery
conditions, free shipping and tiers, flash sales with a countdown and a unit stock, bundles, a stacking policy, price
locks that honour the price a shopper was shown, drop-in or headless badges and a deals page, a rate-limited quote API
and reporting. **All deal data lives in the merchant's own MongoDB** (connected in the Portal); this deployment keeps
only caches, queues and sessions.

Built on `@ss/app-kit` (shared-secret Portal connect, SSO launches, website keys, entitlements with offline grace, events, usage,
client-owned data, bring-your-own identity) and `@ss/rules` (conditions). Business rules live only in `core/` (pure)
and `headless/`. Ported and generalised from ibrahimMobiles `packages/shared/src/pricing/**` (evaluator, matching,
scope, schedule with timezone and overnight windows, stacking, cart offer locks) and its storefront deals page, PDP
pills and card badges.

## Elements

Every element is switchable per website and priced in millicredits per hour; every setting is a feature with a schema,
a default and plan bounds (`x-plan`) in `schemas/<element>.features.json` — nothing is hard-coded.

| Element       | Modes   | Price /h | What it does                                                                                                                                                                                                                      |
| ------------- | ------- | -------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quote_api`   | C       |      200 | The engine and deal store: deals CRUD, catalog sync, cart quotes, commit/release with uses, stock and per-customer limits; rate limited (`rate_per_minute`). Metered `quote`: 1 mc per 20 (starter 20 000 / pro 200 000 included) |
| `item_deals`  | C       |      300 | Deals on items, variants, collections, brands, attributes (+ rules@1 `when`): percent, amount off, fixed price, buy X get Y; schedules, priority, per-customer / total-use / stock limits                                         |
| `cart_deals`  | C       |      200 | Spend or quantity thresholds, payment / delivery / segment / new-customer conditions, free shipping, tiered rewards, upsell hints                                                                                                 |
| `flash_sales` | C       |      200 | Time-boxed item deals (end required, bounded duration) with a stock of discounted units; `deals.exhausted@1` when sold out                                                                                                        |
| `bundles`     | C       |      200 | Buy-together components and mix-and-match "any N for …"; each unit used once, most expensive units first                                                                                                                          |
| `stacking`    | C       |      100 | Stacking classes (mutual `combines_with`, `stack_within`), `best_for_customer` or `priority`, deals per line, coupon / loyalty combinability. Off: one offer per line                                                             |
| `price_locks` | C       |      100 | Signed lock tokens honour a shown price for N minutes; stale behaviour configurable (expired → reprice / reject, base price changed → honour / reprice, better live price wins)                                                   |
| `badges`      | A, B, C |      100 | Card badges, product-page pills (with condition notes), strike-through (compare-at / percent / savings), countdowns, low-stock notes                                                                                              |
| `deals_page`  | A, B, C |      100 | Drop-in deals listing: live and upcoming deals, sorted, with item previews priced with today's deals                                                                                                                              |
| `reporting`   | C       |      100 | Orders with deals, discount, revenue, average order with/without deals (uplift), margin impact (items with cost), per-deal uses and units                                                                                         |

Plans: **starter** = quote_api, item_deals, cart_deals, price_locks, badges, deals_page (+ add-ons flash_sales,
stacking, reporting) = 1 000 mc/h; **pro** = everything (1 600 mc/h). Trial 48 h.

## Generic items and carts

```json
{
	"currency": "EUR",
	"lines": [
		{
			"itemId": "itm_1",
			"variantId": "v_42",
			"quantity": 1,
			"unitAmount": 8900,
			"attributes": { "size": "42" },
			"collections": ["shoes"],
			"brand": "acme"
		}
	],
	"customer": { "id": "cus_1", "segments": ["vip"], "orders": 3 },
	"paymentMethod": "card",
	"deliveryMethod": "courier",
	"shippingAmount": 495,
	"locks": ["pl1.…"]
}
```

Missing line details come from the synced catalog (`PUT /v1/items/{itemId}`, `POST /v1/items:batch`, or the
`item.*`, `price.changed@1` and `inventory.changed@1` events). Money is integer minor units.

## How it works

- **Schedules.** `[startsAt, endsAt)` plus weekly windows in the deal's `timeZone` (else `quote_api.time_zone`).
  `start > end` wraps past midnight and **belongs to the start day** (Friday 18:00–02:00 is active Saturday 01:30).
  Countdowns use the end of the running window (back-to-back windows chain) and "starts …" the next start.
- **Engine.** Item level (stacked deals compound in priority order, or the line's lock) → bundles (on the prices left)
  → cart deals (thresholds after item+bundle discounts or before, `threshold_basis`). Two deals touching the same line
  apply together only if their classes combine. `best_for_customer` searches the compatible combinations (bounded by
  `search_limit`); `priority` admits greedily. Shared caps (stock left, units per order) are allocated in line order.
- **Commit.** `POST /v1/quotes/{id}/commit` claims the quote for one order and counts uses, units and per-customer
  uses with guarded atomic increments (all or nothing → `409 deal_exhausted`); one application per quote and per
  order; `deals.applied@1` (and `deals.exhausted@1`) published. `order.cancelled@1` or `…/release` gives them back once.
- **Price locks.** Tokens `pl1.<claims>.<HMAC>` bound to website, item/variant, currency and (optionally) customer;
  stateless, verified on any instance. Usage and stock limits still apply at commit.
- **Data.** `ss_deals_{deals,items,quotes,applications,counters,customer_usage,audit}` in the merchant DB, `websiteId`
  first in every index, quotes TTL-purged, versioned migrations; export / anonymise via the Portal-signed routes.
- **No background work.** Nothing runs on a timer (no crons, no background tasks, no periodic heartbeat). Quotes
  and price locks are judged against their expiry when used; app-kit sends usage and events after the request that
  queued them.

## API (Mode C)

`openapi.json` documents every operation with examples (generated from the real engine). `sk_` = server key, `pk_` =
browser key (shopper from `SS-Identity`, the website's own login token).

| Operation   | Route                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Deals       | `GET/POST /v1/deals` · `POST /v1/deals:check` · `GET/PATCH/DELETE /v1/deals/{id}` · `POST …/pause` · `…/resume` (sk)         |
| Quotes      | `POST /v1/quotes` (pk/sk, rate limited, metered) · `GET /v1/quotes/{id}` · `POST …/commit` · `POST …/release` (sk)           |
| Catalog     | `GET /v1/items` · `GET/PUT/DELETE /v1/items/{itemId}` · `POST /v1/items:batch` (sk)                                          |
| Offers      | `GET /v1/offers?items=` · `POST /v1/offers:evaluate` (pk/sk)                                                                 |
| Price locks | `POST /v1/price-locks` · `POST /v1/price-locks:verify` (pk/sk)                                                               |
| Deals page  | `GET /v1/deals-page` · `GET /v1/deals-page/{dealId}/items` (pk/sk)                                                           |
| Reports     | `GET /v1/reports?from=&to=` · `GET /v1/reports/deals/{dealId}` (sk)                                                          |
| Standard    | `/v1/entitlement`, `/v1/config`, `/v1/events`, `/v1/strings`, `/healthz`, `/readyz`, `/v1/data:export`, `/v1/data:anonymize` |

Errors are RFC 9457 problems with stable codes (`kind_disabled`, `deal_limit_reached`, `deal_exhausted`,
`quote_expired`, `quote_committed`, `total_mismatch`, `price_lock_expired`, `rate_limited`, …).

**Headless (Mode B).** `headless/badges.js#createBadges({ config, strings, client })` → `actions: { load(items),
refresh, tick, item }`; `headless/dealsPage.js#createDealsPage(…)` → `actions: { load, loadMore, select, loadItems,
tick }`. `badgesClient(api)` / `dealsPageClient(api)` adapt an `@ss/web/element` API client. **Drop-in (Mode A).**
`ui/badges.js#render` (variants `card`, `detail`) and `ui/dealsPage.js#render` (`grid`, `list`), design tokens only.

## Dashboard (SSO)

Overview KPIs, deals list with live state, deal detail with pause/resume (audited), create from JSON, a simulator
(quote a cart against the live deals — nothing stored or metered), settings (link to the Portal). Demo launches show
sandbox deals evaluated with the real engine; impersonation shows the audit banner.

## Develop and certify

```sh
ss dev env > .env.local        # MONGODB_URI (empty = in-memory control store) + a generated CONNECT_SECRET
ss dev                         # local Portal emulator (ss.dev.json)
pnpm dev                       # Next.js on :3000 — or `node serve.js 3000` (plain node:http)
ss dev connect --url http://localhost:3000 --secret <CONNECT_SECRET>   # from .env.local
ss app validate                # manifest, anatomy, import direction, tokens, strings, OpenAPI coverage
ss certify . --url http://localhost:3000
pnpm check                     # format, lint, typecheck, tests with coverage: core, headless, renderers, API on MongoDB, certify
```

`tests/certify.test.js` runs the full `ss certify` suite (every check passes); the system test `e2e/tests/deals-portal.test.js` (monorepo workspace `@ss/e2e`) runs the real
Portal in process: staff bootstrap → Add product (URL + connect secret) → activation → merchant signup → website → credits →
subscription → database connector → weekday-evening deal in Asia/Karachi → quotes outside / inside the overnight
window → price lock honoured after the window closed → commit (uses in the merchant DB) → metered usage → settlement.

## Deploy

1. Deploy this directory on any Node 22 host that runs Next.js (on Vercel: Root Directory = this folder). In the
   monorepo, `next.config.js` sets the workspace root automatically.
2. Set two environment variables: `MONGODB_URI`, the product's own small MongoDB (sessions, caches, usage queue, its
   signing key and generated secrets), and `CONNECT_SECRET` (random, at least 32 characters). Nothing else.
3. Portal → Admin → Apps → **Add product** → the product URL and `CONNECT_SECRET` → **Connect**. The product generates
   its key and pins the Portal; then review and activate it in the Portal. Nothing runs on a timer.
4. Run `ss certify . --url https://<deployment> --secret <CONNECT_SECRET>` against a fresh (unconnected) deployment before listing.

## Changelog

- **Unreleased** — the quote rate limit is app-kit's dynamic route limit (`rateLimit.limit(ctx)` = `quote_api.rate_per_minute`, one shared bucket for quotes, offers and price locks; counted before validation); no scheduled or periodic work at all (no crons, no background tasks, no periodic heartbeat): app-kit sends usage and events after the request that queued them; price locks and quotes are checked against their expiry when used; a TTL index purges old quotes.
- **1.0.0** — first release: ten elements, badges and deals page renderers and headless cores, REST v1, dashboard.
