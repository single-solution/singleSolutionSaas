# Reviews & Ratings (`reviews`)

An SSPS v1 **service product** (PLAN Part D §15, Part E). Merchants collect reviews from **verified buyers** after
completed orders, ask for them with timed requests and reminders through their own messaging provider, moderate them
with rules, show them with drop-in or headless widgets, and publish Product **JSON-LD** built only from approved reviews
— plus questions & answers, CSV import from other platforms and analytics. **All review data lives in the merchant's own
MongoDB** and photos in the merchant's own bucket (both connected in the Portal); this deployment keeps only caches,
queues and website ids.

Built on `@ss/app-kit` (shared-secret Portal connect, SSO launches, website keys, entitlements with offline grace, bring-your-own
identity, events, usage, client-owned data, connectors) and `@ss/rules` (moderation conditions). Business rules live only
in `core/` (pure) and `headless/`. Ported from ibrahimMobiles: the review model and its one-review-per-order-item
guard, text sanitation, public reviewer names, moderation with replies, the exact approved-review rollup and the
AggregateRating / Review structured-data nodes — generalised (no region, language, currency or scale assumptions).

## Elements

Every element is switchable per website and priced in millicredits per hour; every setting is a feature with a schema,
a default and plan bounds (`x-plan`) in `schemas/<element>.features.json` — nothing is hard-coded.

| Element           | Modes   | Price /h | What it does                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------- | ------- | -------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collection`      | C       |      300 | Who may review (`verified_buyers` · `identified` · `anyone`), review requests opened by `order.completed@1` (sent at once with `send_on_completion`, open `review_window_days`), signed review links, one review per order item (or per item), public name format, daily per-customer limit, website time zone. Metered: **`review`** (5 mc each; starter 300 / pro 3 000 included)                        |
| `request_flow`    | C       |      200 | Request flow, run when an order completes (no timers; also on demand from the API or dashboard): sends the request and the due reminders (`reminders` = days after the first send) through the merchant's **messaging connector** on the first channel with a contact (email / SMS / WhatsApp), quiet hours in the website zone, retries with back-off, template ids + rendered text; requires `messaging` |
| `moderation`      | C       |      200 | Content checks (merchant's blocked words in any script, links, minimum length → queue or reject), then rules@1 rules in order (approve / reject / queue, reason codes), default action; unverified reviews never auto-approve unless allowed; manual queue, rejection reasons, public merchant replies                                                                                                     |
| `content`         | C       |      100 | Rating scale (3–10), title and text limits, author name length, attribute ratings (e.g. quality, value, fit with low/high labels)                                                                                                                                                                                                                                                                          |
| `photos`          | C       |      100 | Presigned uploads straight to the merchant's **storage connector** (jpeg/png/webp, size and count limits, HEAD-verified on attach), presigned or public view links; requires `storage`                                                                                                                                                                                                                     |
| `display`         | A, B, C |      200 | Summary (average, count, distribution, attribute averages), list with sorting, filters (rating, verified, photos) and keyset pagination, stars for product lists, the write-a-review form; default renderer (`stars` / `summary` / `list`), headless core, Loader stub view                                                                                                                                |
| `structured_data` | C       |      100 | `GET /v1/structured-data/{itemId}` → schema.org `Product` with `AggregateRating` and `Review` nodes from approved reviews only (minimum count, how many, which), brand                                                                                                                                                                                                                                     |
| `qna`             | C       |      200 | Questions per item (identified or anyone), merchant answers, customer answers (verified buyers or identified), moderation of both, limits                                                                                                                                                                                                                                                                  |
| `import`          | C       |      100 | RFC 4180 CSV import with mapped column names, per-row validation, dry run, duplicates skipped by `external_id`, imported as approved or through moderation                                                                                                                                                                                                                                                 |
| `analytics`       | C       |      100 | Submitted / approved / rejected over time (day / week / month in the website zone), average rating, verified and photo shares, request conversion, decision and reply times, top items                                                                                                                                                                                                                     |

Plans: **starter** = collection, moderation, content, display, structured_data (+ add-ons request_flow, photos, qna,
import, analytics); **pro** = everything. Trial 48 h.

**Events.** Consumes `order.completed@1` (opens the review request: the customer is the order's `customer.subject`,
`customer.customerId`, `customerId` or the customer actor — every key may later identify the buyer — and the items are
the completion's `lines`, else those of the earlier `order.placed@1`), `order.placed@1` (snapshot), `order.cancelled@1`
(closes the request) and `order.refunded@1` (removes the refunded items; all of them without lines). Publishes
`reviews.submitted@1` and `reviews.approved@1` (with the item's new count and average; schemas in `schemas/events/`).

**Customer identity.** Browser (`pk_`) routes take the customer from `SS-Identity`, the website's own login token
verified offline by app-kit from the issuer in the signed entitlement (`identity: 'optional'`), or from a **review link
token** (`rl1.…`, HMAC over website + request + expiry) carried by request messages, so buyers can review without
signing in. `sk_` callers act for the merchant (they may name the customer and order; their reviews are verified only
when a request backs them).

## How it works

- **Verified purchase = an open review request.** One request per order (id derived from the order, upserted), listing
  its items. A review is verified when an open request of that customer contains the item and the window has not
  passed; the item is then marked reviewed and the request completes when every item is.
- **Exactly once.** A review's id derives from the Idempotency-Key, so a retried submission converges on one document;
  the usage record (`review:<id>`) and the events (`submitted:<id>`, `approved:<id>`) derive from it. The one-review-per
  key (`customer|item|order`) is a unique index; imports dedupe on `external_id`. A request message carries the
  provider idempotency key `review-request:<id>:<n>`; deliveries are claimed by compare-and-set on `nextAt` with a lease.
- **Rollups are exact.** After every change that touches approved reviews the item's rollup is recomputed with
  aggregates over the approved reviews (per rating and scale, attribute sums, photo and verified counts) and stored on
  the item, so widgets, stars and JSON-LD never scan reviews. Each review keeps the scale it was given on; summaries
  normalise to the current `content.rating_scale`.
- **Data.** Collections `ss_reviews_{reviews,items,requests,orders,photos,questions,audit}` in the merchant database,
  `websiteId` first in every index, created lazily; TTL retention for requests and orders (`P730D`); pending photo
  slots are stale after `P30D` and swept on the next upload or from the dashboard (object and slot deleted), with a TTL a week later as a
  backstop; versioned migrations; export/anonymise through the Portal-signed standard routes (anonymising keeps
  the rating, removes author, text, photos and contact).

## API (Mode C)

`openapi.json` (OpenAPI 3.1) documents every operation with examples. Highlights (`sk_` = server key, `pk_` = browser
key):

| Area            | Routes                                                                                                                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reviews         | `GET /v1/reviews` (pk: approved, public; sk: every status; filters `itemId`, `rating`, `verified`, `photos`, `status`, `customerId`; `sort`; `include=summary`; cursor) · `POST /v1/reviews` · `GET /v1/reviews/{id}` · `DELETE /v1/reviews/{id}` |
| Requests        | `GET /v1/review-requests` (pk + identity: what I can review) · `POST /v1/review-requests` · `GET /v1/review-requests/{id}` · `…/link` · `…/cancel` · `POST /v1/review-requests:open` `{ token }`                                                  |
| Request flow    | `GET /v1/request-flow` · `POST /v1/request-flow:run`                                                                                                                                                                                              |
| Moderation      | `GET /v1/moderation` (queue + counts) · `POST /v1/moderation/{id}/approve` · `…/reject` `{ reason }` · `…/reply` · `DELETE …/reply` · `POST /v1/moderation:check`                                                                                 |
| Content, photos | `GET /v1/review-form` · `POST /v1/review-photos` (presigned PUT) · `GET /v1/review-photos/{id}`                                                                                                                                                   |
| Display         | `GET /v1/ratings?itemIds=` (stars) · `GET /v1/ratings/{itemId}` (summary + display settings) · `GET /v1/elements/display/view` (Loader stub)                                                                                                      |
| Structured data | `GET /v1/structured-data/{itemId}?name=&url=&image=&sku=` → `application/ld+json`                                                                                                                                                                 |
| Q&A             | `GET/POST /v1/questions` · `GET /v1/questions/{id}` · `POST /v1/questions/{id}/answers` · `…/publish` · `…/reject` · `…/answers/{answerId}/publish` and `…/reject`                                                                                |
| Import          | `POST /v1/imports` `{ csv, dryRun? }` (≤ 8 MiB)                                                                                                                                                                                                   |
| Analytics       | `GET /v1/analytics?from=&to=&bucket=`                                                                                                                                                                                                             |
| Standard        | `/v1/entitlement`, `/v1/config`, `/v1/events`, `/v1/strings`, `/healthz`, `/readyz`, `/v1/data:export`, `/v1/data:anonymize`                                                                                                                      |

Errors are RFC 9457 problems with stable codes (`not_verified`, `already_reviewed`, `review_limit`, `invalid_token`,
`request_closed`, `not_pending`, `photo_invalid`, `storage_unavailable`, `name_required`, `identity_required`, …).
Public reads (`pk_`) are cacheable (`display.cache_seconds`, `structured_data.cache_seconds`).

**Headless (Mode B).** `headless/reviews.js#createReviews({ config, strings, client, emit })` with the `@ss/web/element`
API client → `{ state, actions: { load, setSort, setFilter, loadMore, loadStars, openForm, closeForm, submit },
subscribe, validate, strings, t, countText, destroy }`; `validate` uses the same core validation as the API with the
limits from `GET /v1/review-form`. **Drop-in (Mode A).** `ui/reviews.js#render({ state, actions, strings, theme: {
variant: 'stars' | 'summary' | 'list' }, slots, dom })`, design tokens only, ≤ 14 KB declared.

## Dashboard (SSO)

Opened from the Portal (`/sso?launch=` → `ss_session`): overview KPIs, the moderation queue (pending / published /
rejected) with approve, reject with a reason and public replies, questions to publish, reject or answer, and settings
(link to the subscription's configuration in the Portal — the product never stores merchant configuration). Merchants
also get **Send due requests now** (`POST /v1/dashboard/request-flow:run`) and **Clean up photo uploads**
(`POST /v1/dashboard/photos:sweep`) on the overview. Every action is audited with the merchant or staff actor; demo launches show sandbox reviews moderated by the real core.

## Develop and certify

```sh
ss dev env > .env.local        # MONGODB_URI (empty = in-memory control store) + a generated CONNECT_SECRET
ss dev                         # local Portal emulator (ss.dev.json)
pnpm dev                       # Next.js on :3000 — or `node serve.js 3000` (plain node:http)
ss dev connect --url http://localhost:3000 --secret <CONNECT_SECRET>   # from .env.local
ss dev emit order.completed --website web_devwebsite01
ss app validate                # manifest, anatomy, import direction, tokens, strings, OpenAPI coverage
ss certify . --url http://localhost:3000   # restart the product first (fresh token)
pnpm check                     # format, lint, typecheck, tests with coverage: core, headless, renderer, API on MongoDB, certify
```

The suite includes `tests/certify.test.js` (the full `ss certify` suite, every check must pass). The system test
`e2e/tests/reviews-portal.test.js` (monorepo workspace `@ss/e2e`) runs the product against the real Portal in process (staff bootstrap → Add product (URL + connect secret) → activation → merchant
signup → website + its identity issuer → credits → starter subscription → database connector → `order.completed@1`
through the Event Hub → review request in the merchant DB → the verified customer reviews with the `pk_` key and their
own login token → auto-approved by the default rule → summary and JSON-LD reflect it → `review` usage → hourly
settlement).

## Deploy

1. Deploy this directory on any Node 22 host that runs Next.js (on Vercel: Root Directory = this folder). In the
   monorepo, `next.config.js` sets the workspace root automatically.
2. Set two environment variables: `MONGODB_URI`, the product's own small MongoDB (sessions, caches, usage queue, its
   signing key and generated secrets), and `CONNECT_SECRET` (random, at least 32 characters). Nothing else.
3. Portal → Admin → Apps → **Add product** → the product URL and `CONNECT_SECRET` → **Connect**. The product generates
   its key and pins the Portal; then review and activate it in the Portal. Nothing runs on a timer.
4. Run `ss certify . --url https://<deployment> --secret <CONNECT_SECRET>` against a fresh (unconnected) deployment before listing.

## Notes and limits

- **Photos are stored as uploaded.** Without image dependencies the product cannot re-encode images or strip EXIF
  metadata (location, device). Uploads are restricted to `image/jpeg`, `image/png` and `image/webp`; the presigned PUT
  signs `content-type` and `content-length` (the bucket refuses another type or size, so the body must be exactly the
  declared `size`), and a HEAD request re-checks type and size when the review is submitted (for stores that do not
  enforce signed headers); stored keys are relative to the product's area of the bucket (`objectKey` is the full key), and photos stay private in the merchant's bucket (presigned view
  links) unless a public base URL is configured. Merchants who need EXIF stripping should process uploads in their
  bucket (e.g. a storage event function) or set a bucket lifecycle rule; tell shoppers that photos are published as-is.
  Pending upload slots are stale after `retention.photos` (they can no longer be attached); their objects and slots
  are deleted (app-kit `sweepStaleUploads`) on the website's next upload (≤ 25) or with **Clean up photo uploads**
  (≤ 100), and a TTL index on `purgeAt` removes forgotten slot records. Slots created before this release are migrated
  lazily (`photo_stale_dates`).
- **No scheduled work.** There are no crons, background passes or polling. A review request is sent when its order
  completes (`collection.send_on_completion`, with `request_flow` on); that run also sends the website's other due
  requests, reminders and retries (bounded by `request_flow.max_per_run`). A request delay ("ask N days after
  delivery") would need a timer, so there is none: reminders, retries and requests held by quiet hours go out with
  the website's next completed order, `POST /v1/request-flow:run` or **Send due requests now**. Requests past
  `expiresAt` read as expired everywhere and are marked so when touched.
- Incentives for reviews (coupons, points) are left to other products listening to `reviews.approved@1`.

## Changelog

- **Unreleased** — event-driven: no cron and no background work. `collection.request_delay_hours` is replaced by
  `collection.send_on_completion` (requests are sent when the order completes); due reminders and retries go out with
  the next completion or on demand (API, dashboard); stale photo slots are swept on the next upload or from the
  dashboard.
- **1.0.0** — first release: ten elements, display renderer and headless core, REST v1, dashboard, request flow.
