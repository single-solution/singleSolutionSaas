# Order Manager — "Ecommerce Helper" (`orders`)

SSPS v1 **service product**: the back office for orders from any checkout — the Checkout product (`order.placed@1`)
or any other one (the inbound API with a schema mapping). Everything is data from the website's settings: the status
set and transition matrix, carriers, serial rules, payment methods, templates. All data, personal data included, lives
in the merchant's own database (`ss_orders_*` collections through app-kit `data.forWebsite`).

## Elements and pricing (millicredits per hour, metered units)

| Element            | What                                                                                       | Price         | Modes |
| ------------------ | ------------------------------------------------------------------------------------------ | ------------- | ----- |
| `lifecycle`        | orders, status matrix as data (checks, events, customer cancel, auto-expiry), timeline     | 200           | A B C |
| `fulfilment`       | carriers + tracking URL templates, service levels, dispatch video, guest tracking lookup   | 100           | A B C |
| `serials`          | serial per unit, rules as data (charset, length, Luhn), unique per order/website, lookup   | 50            | C     |
| `invoices`         | invoices/receipts as printable HTML from the order snapshot, sequential numbers            | 50 + `render` | A B C |
| `print`            | packing slips (serial slots, amount to collect) and pick lists                             | 50            | C     |
| `bulk`             | bulk status changes, CSV export, CSV import of status/tracking with dry run                | 50            | C     |
| `risk`             | open-order cap, blocklist, RTO counters/flags, pay-on-delivery caps/advances, review queue | 100           | C     |
| `customer_updates` | status messages through the merchant's messaging connector (or `orders.customer_update@1`) | 0             | C     |
| `ledger`           | append-only payments and refunds, guarded in the write, reconciliation                     | 100           | C     |
| `inbound_api`      | orders from any checkout (`sk_`, canonical schema or mapping), idempotent per external id  | 0 + `order`   | C     |

Plans: `starter` (everything but `bulk` and `risk`, which are add-ons) and `pro` (all).

## Events

- Publishes the catalogued `order.placed@1` (orders from outside our Checkout), `order.paid@1` (each payment),
  `order.completed@1`, `order.cancelled@1` (transition side effects from the matrix) and `order.refunded@1` (each refund,
  with the refunded lines), plus `orders.status_changed@1` (every move), `orders.serials_recorded@1` (serial captures,
  `{ orderId, serials: [{ serial, lineId, itemId?, variantId?, sku? }] }`, read by After-sales) and
  `orders.customer_update@1` (event delivery
  mode). Events carry identity references (customer id, subject), never contact details.
- Consumes `order.placed@1` (intake from the Checkout, the event's order id kept), `order.paid@1` (payments captured
  elsewhere become ledger entries), `order.refunded@1` (refunds approved elsewhere, e.g. After-sales claims, recorded
  once per event, not republished) and `order.cancelled@1` (mirrored, not republished). Its own publications are
  skipped.
- Delivery publishes the catalogued `order.completed@1` (After-sales opens return windows on it). `order.delivered@1` is
  not in the `@ss/contracts` catalogue, so it is not published (the Portal would refuse it).

## Security

`sk_` keys and dashboard sessions read and change orders. `pk_` keys read public metadata (`/v1/order-statuses`,
`/v1/carriers`), look up tracking by number + contact, and — with a verified `SS-Identity` — the customer's own orders,
cancellation and receipts. Printable views send `Content-Security-Policy: default-src 'none'`.

## Background work

Nothing runs on a timer (no crons, no background loops): an order whose status expired is moved as soon as it is read
(and no longer counts as open), outbox entries a crashed request left behind and due customer message retries are sent
when the order is next read, and the dashboard's "Process due now" (`POST /v1/dashboard/due:run`) handles all of it for
the website at once.

## Develop

```sh
cp .env.example .env.local     # MONGODB_URI (empty = in-memory control store) + a random CONNECT_SECRET (≥ 32 chars)
pnpm dev                       # Next.js on :3000
# local Portal → Admin → Apps → Add product → http://localhost:3000 + the CONNECT_SECRET
pnpm validate                  # ss app validate: manifest, anatomy, import direction, tokens, strings, OpenAPI coverage
pnpm check                     # format, lint, typecheck, tests with coverage: core, headless, renderer, API on MongoDB
ss pack build .                # the order tracker, tracking and receipt widgets (Mode A) → upload dist/pack in the
                               # Portal (app page → Upload widgets)
```

The e2e suite (monorepo workspace `@ss/e2e`) composes this product from its `./platform` and `./routes` exports and runs
it against the real Portal in process.

## Deploy

1. Deploy this directory on any Node 22 host that runs Next.js (on Vercel: Root Directory = this folder). In the
   monorepo, `next.config.js` sets the workspace root automatically.
2. Set two environment variables: `MONGODB_URI`, the product's own small MongoDB (sessions, caches, usage queue, its
   signing key and generated secrets), and `CONNECT_SECRET` (random, at least 32 characters). Nothing else.
3. Portal → Admin → Apps → **Add product** → the product URL and `CONNECT_SECRET` → **Connect**. The product generates
   its key and pins the Portal; then activate it in the Portal.
4. `ss pack build .` and upload `dist/pack` on the app page (**Upload widgets**) so the Mode A widgets are delivered.
