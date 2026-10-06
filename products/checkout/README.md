# Cart & Checkout (`checkout`)

An SSPS v1 **service product** (PLAN Part D §11, Appendix A.6, Part E). Carts, the checkout form, manual payments, a
payment-gateway interface (preview), offers and loyalty through those products, an atomic idempotent placement and a
success page — for **any** website (shop, services, digital goods), through a drop-in UI, a headless core or the API
only. **All cart and order data lives in the merchant's own MongoDB** (connected in the Portal); this deployment keeps
only caches, queues and website ids.

Ported from ibrahimMobiles (`apps/web` cart / checkout, `lib/orders/placement.ts`, `packages/shared/src/checkout`,
`codSafety.ts`, `inventory.ts`, `orderExpiry.ts`) and made generic: no country, currency, phone format or language is
assumed — the form is data, money is integer minor units of the website's currency (Portal → Website settings), and
every text is in `strings/`. The review lessons A10 (success page follows the real method / delivery, timing texts are
settings), A12 (COD confirmation step that expires, COD counted in the open-order cap, COD max value and advance,
blocklist), A21 (stock goes back only for orders not completed), A22 (payments and refunds recorded on the order) and
A26 (area and recipient phone in the address, saved-address picker) are built in.

## Elements

Every element is switchable per website and priced in millicredits per hour; every setting is a feature with a schema,
a default and plan bounds (`x-plan`) in `schemas/<element>.features.json`. Every element has all three modes: drop-in
renderer (`ui/`), headless core (`headless/`) and Mode C API (`openapi.json`).

| Element           | Price /h             | What it does                                                                                                                                                |
| ----------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cart`            | 200                  | Carts priced on the server from items your server posts (`PUT /v1/items`) or the Catalog product mirrors; caps, reconciliation, notes, guest merge, events  |
| `checkout_form`   | 150                  | Contact / address / custom fields as data: per-country address formats, postal templates, phone patterns, autocomplete, labels; delivery methods; addresses |
| `place_order`     | 250 + `order` 5 mc   | Atomic, idempotent placement: re-pricing, stock in a transaction (compensated steps without a replica set), offer / point reservations, holds, numbering    |
| `payment_manual`  | 150                  | Bank transfer, cash on delivery (surcharge, min / max, advance, confirmation), pay at pickup — each with rules@1 availability; open-order cap               |
| `payment_proofs`  | 50                   | Transfer proofs straight to the merchant's storage (presigned PUT, signed type and exact length), verified on completion                                    |
| `payment_gateway` | 100 + `payment` 2 mc | **Preview.** Provider-adapter interface on app-kit's payments connector with the merchant's own credentials; ships the `test` adapter only                  |
| `offer_apply`     | 0                    | Coupons (validate / reserve / redeem API) and Deals (quote / commit API), with the products' stacking flags and a precedence setting                        |
| `loyalty_redeem`  | 0                    | Loyalty points (redemption quote / redeem / release API) for signed-in shoppers                                                                             |
| `success_page`    | 0                    | Next steps by method, payment status and delivery kind, the merchant's timing texts, bank details, proof upload, shopper cancel                             |
| `policies_notice` | 0                    | Links to the merchant's policies (or Content documents through a URL template), required consents stored with their version on the order                    |
| `signin_gate`     | 0                    | Identity (SS-Identity, e.g. the Signups product) never / always / for COD / above a total — enforced at placement                                           |

Plans: **starter** = everything except `payment_proofs` and `payment_gateway` (add-ons; 750 mc/h, 300 orders a month
included); **pro** = all but the gateway preview (add-on), 3 000 orders included. Trial 48 h.

**Events.** Publishes `order.placed@1`, `order.paid@1` (gateway or recorded payments), `order.cancelled@1` (shopper,
merchant or expiry), `cart.updated@1`, and `checkout.cart_abandoned@1`, `checkout.payment_proof_submitted@1`,
`checkout.order_confirmed@1` (schemas in `schemas/events/`). Consumes `order.paid|completed|cancelled|refunded@1` (the
Order Manager's lifecycle) and `item.created|updated|deleted@1`, `price.changed@1`, `inventory.changed@1` (Catalog).

**Other products** are called only through their public APIs, server to server, through app-kit `outbound.fetch`, with
base URLs from the settings and the merchant's own `sk_` key (Dashboard → Settings, sealed in their database).

## Security

- Prices and totals are always recomputed on the server; `expectedTotal` only detects stale clients (409 `total_changed`).
- Placement needs an `Idempotency-Key`; the order id derives from it and a unique index closes parallel submissions.
- Stock: conditional `$inc` (`available >= quantity`) and the order insert in one transaction of the merchant's database;
  on a standalone server the steps run in sequence and exactly the completed ones are given back.
- Browser keys take the shopper only from `SS-Identity`; guests reach their order with its access token (stored hashed).
- Proofs never pass through this product; the bucket enforces the signed type and length.
- Gateway return URLs must be https on the website's domain; webhooks are verified by the adapter with the merchant's secret.

## Develop

```sh
ss dev env > .env.local        # DATABASE_URI (empty = in-memory control store) + a generated CONNECT_SECRET
pnpm portal               # Portal emulator on :4400 (ss.dev.json)
pnpm dev                  # product on :3000 (or node serve.js 3000)
```

```sh
pnpm check                # format, lint, typecheck, tests with coverage
pnpm validate             # ss app validate
```

Environment: `DATABASE_URI` and `CONNECT_SECRET` (`.env.example`); the sealing key of merchants' integration keys is generated and kept
in the control database. Nothing runs on a timer (no crons, no
background loops): an expired hold is cancelled when the order is read, listed or confirmed (and released when a
placement needs the stock); a cart is reported abandoned when the merchant's server reads it; the dashboard's "Process
expired now" button (`POST /v1/dashboard/expiry:run`) does both for the website at once. Guest carts disappear through a
TTL index. See `jobs/README.md`.

See `docs/guide.md` for the integration guide.
