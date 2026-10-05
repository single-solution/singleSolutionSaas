# After-sales (`aftersales`)

SSPS v1 **service product** for return, warranty, exchange and refund-request claims on anything a website sells —
goods, rentals, services or subscriptions. Claim types, reasons, windows, evidence, statuses and transitions are all
data (feature schemas); every element is switchable and priced on its own and works in all three modes. All client
data lives in the merchant's own database (`ss_aftersales_*` via `data.forWebsite`), photos in the merchant's own bucket
and notifications go through the merchant's own messaging connector.

## Elements and pricing (millicredits per hour)

| Element           | What                                                                                                | Modes   | Price         | Resources |
| ----------------- | --------------------------------------------------------------------------------------------------- | ------- | ------------- | --------- |
| `claims`          | purchases (events or API), types, reasons, windows (type, grade, snapshot, rules@1), the claim form | A, B, C | 300           | —         |
| `photos`          | evidence photos: presigned uploads with signed content length, HEAD-checked                         | C       | 100 + 2/photo | storage   |
| `queue`           | statuses and transitions as data, notes, assignment, SLA due time, history                          | C       | 200           | —         |
| `refunds`         | capped full/partial refunds with method and reference, published as `order.refunded@1`              | C       | 200           | —         |
| `restock`         | per-line restock exactly once, only once received; `inventory.changed@1` or record-only             | C       | 100           | —         |
| `serial_registry` | units by serial across orders; staff lookup and a public warranty lookup                            | A, B, C | 100           | —         |
| `messages`        | the customer–staff conversation; notifications of messages, status changes and new claims           | C       | 100           | messaging |

Plans: `starter` = claims + queue (other elements as add-ons); `pro` = everything. Product-level resource: `database`.

## Events

- **Consumes:** `order.placed@1` (snapshot), `order.delivered@1` / `order.completed@1` (window start; configurable in
  `claims.window_start_events`), `order.paid@1`, `order.cancelled@1`, `order.refunded@1` (refunds made elsewhere),
  `orders.*@1` (the Orders product: serials and enrichment), `grades.tier_assigned@1` (grade windows),
  `inventory.changed@1` (on-hand level for restock events). Events this product published itself are skipped.
- **Publishes:** `aftersales.claim_submitted@1`, `aftersales.claim_status_changed@1` (schemas in `schemas/events/`),
  `order.refunded@1` (the Orders ledger), `inventory.changed@1` (restocked units).

Every integration is optional: without Orders, register purchases with `POST /v1/purchases`; without Catalog, keep
`restock.target = record`.

## Layout

| Path            | Purpose                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------- |
| `manifest.json` | elements, prices, plans, events, scopes, resources                                          |
| `openapi.json`  | Mode C API (`/v1/purchases` is the `x-ss-certify` resource)                                 |
| `schemas/`      | one `*.features.json` per element and the product event schemas                             |
| `core/`         | pure rules: windows, eligibility, claims, refunds cap, restock plan, validation, views      |
| `headless/`     | Mode B cores: `createClaims` (claim form, guest access, conversation), `createSerialLookup` |
| `ui/`           | Mode A renderers built on the headless cores, design tokens only                            |
| `api/`          | routes, service, event consumers, settings, dashboard data                                  |
| `adapters/`     | repositories (merchant DB), claim tokens, platform wiring, personal-data declaration        |
| `app/`          | Next.js wiring and the merchant dashboard (overview, queue, serials, settings)              |
| `tests/`        | unit, API (fake Portal + in-memory MongoDB), headless/renderer and certification tests      |

## Environment

The app-kit variables (`SS_PORTAL_URL`, `SS_APP_ID`, `SS_APP_SIGNING_KEY`, `SS_REGISTRATION_TOKEN_HASH`,
`SS_PRODUCT_DB_URI`, `SS_LOG_LEVEL`, `SS_OUTBOUND_ALLOW_HOSTS`) and optionally `AFTERSALES_TOKEN_SECRET` (≥ 32
characters; guest claim tokens — derived from the signing key when unset). See `.env.example`.

## Commands

```sh
pnpm check      # format, lint, typecheck, tests with coverage
pnpm validate   # ss app validate
pnpm build      # Next.js build
pnpm dev        # product on :3000 (pnpm portal runs the ss dev Portal emulator)
```

The system test against the real Portal is `e2e/tests/aftersales-portal.test.js`.
