# Coupons — developer guide

## Checkout integration (Mode C, server key)

```text
POST /v1/quotes        { codes, cart }                         → applied / rejected codes, totals (browser-safe too)
POST /v1/reservations  { codes, cart, reference?, orderId? }   (Idempotency-Key) → reservation, held for the TTL
POST /v1/reservations/{id}/attach  { orderId }   once the order exists (order events then find the reservation)
POST /v1/reservations/{id}/redeem  { orderId? }  when the order is paid — or send order.completed@1 to the Event Hub
POST /v1/reservations/{id}/release               when the checkout is abandoned (uses go back)
POST /v1/redemptions   { codes, cart, orderId }  reserve + redeem in one step
```

A cart is generic: `{ currency, lines: [{ lineId?, itemId, variantId?, quantity, unitAmount, attributes?, collections? }],
shipping?, customer?: { id, orderCount, segments, email, country }, paymentMethod?, deliveryMethod?,
context?: { country, device, source, deviceId } }` — integer minor units in one ISO-4217 currency.

Concurrency: every limit (uses per code, per coupon, per customer, per device) is an atomic conditional counter in the
merchant's database. Two checkouts racing for the last use of a code: exactly one reservation is created, the other
gets `409 exhausted`. Unconfirmed reservations expire after `api.reservation_ttl_minutes`: a lapsed reservation is treated as expired
as soon as it is read or touched (its uses go back then), a throttled sweep runs after requests (at most every 5 minutes
per website), and the daily `GET /cron/sweep` catches up.

Order events: `order.completed@1` redeems, `order.cancelled@1` releases (`api.release_on_cancel`), `order.refunded@1`
releases per `api.release_on_refund` (`never`, `full` — refunds summed until they reach the reservation's total —,
`any`).

## Apply box

- **Mode A (drop-in):** `ui/applyBox.js#render({ state, actions, strings, theme: { variant: 'inline' | 'collapsible' },
slots: { before, after, success }, dom })`, design tokens only. Through the Loader's element stub the product serves
  `GET /v1/elements/apply_box/view` and `POST /v1/elements/apply_box/actions/apply` (`{ code, cart }`).
- **Mode B (headless):** `headless/applyBox.js#createApplyBox({ config, strings, client, cart, emit })` →
  `{ state, actions: { setCode, setCart, apply, remove, clear, toggle, applyFromUrl }, subscribe, validate, strings, t,
formatMoney, destroy }`; `client.quote({ codes, cart })` calls `POST /v1/quotes` with the `pk_` key and
  `SS-Identity`.

## Eligibility

Structured conditions (`{ type, operator, value }`, `group` with `and` / `or`) plus an optional rules@1 `when` with the
context `cart` (`currency`, `subtotal`, `quantity`, `shipping`, `lines[]`), `customer` (`id`, `identified`,
`orderCount`, `segments`, `email`, `country`), `paymentMethod`, `deliveryMethod`, `context` (`country`, `device`,
`source`), `coupon` (`id`, `code`) and `now` (website zone). `inSegment('vip')` reads the customer's segments.

```text
cart.subtotal >= 5000 and not inSegment('wholesale')
any(cart.lines, 'socks' in it.collections) and paymentMethod != 'cod'
```

`POST /v1/eligibility:check` diagnoses a condition and, with a cart, evaluates it.
