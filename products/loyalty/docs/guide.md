# Loyalty & Rewards — developer guide

## Three ways to use the wallet

- **Mode A (drop-in):** the Loader mounts `ui/wallet.js#render` with the website's design tokens (`badge` or `panel`
  variant, slots `before`, `after`, `empty`).
- **Mode B (headless):** `headless/wallet.js#createWallet({ config, strings, client, emit })` gives an immutable
  `state()` (balance text, tier and progress, expiring points, history), `actions.load()` / `actions.loadMore()`,
  `subscribe`, `validate`, `t` and `formatPoints`. Wrap it with the `@ss/web` adapters (`createUseElement(React)`).
- **Mode C (API):** your server mints a wallet token for the signed-in customer (`POST /v1/wallet-tokens` with the
  `sk_` key); the browser calls `GET /v1/wallet` with the `pk_` key and `SS-Identity: <token>`.

## Checkout integration

```text
POST /v1/redemptions:quote  { customerId, amount, currency, discount? }   → maxPoints, maxValue, allowed/reason
POST /v1/redemptions        { customerId, points, amount, currency, reference? }  (Idempotency-Key) → redemption
POST /v1/redemptions/{id}/confirm { orderId }   once the order exists (cancellations then return the points)
POST /v1/redemptions/{id}/release               when the checkout is abandoned (points return to their lots)
```

Send `order.placed@1` (with `customerId`, lines and amounts) and `order.completed@1` / `order.cancelled@1` /
`order.refunded@1` to the Portal Event Hub; the product earns and reverses points exactly once per order.

## Earn rule conditions

Conditions use rules@1 (`@ss/rules`). Context: `event` (`type`, `data`, `occurredAt`), `order` (`total`, `subtotal`,
`discount`, `shipping`, `tax`, `units`, `eligibleAmount`, `eligibleUnits`, `lines[]`, `currency`), `customer` (`id`,
`orders`, `balance`, `lifetimeEarned`, `lifetimeSpend`, `joinedAt`, `tier`), `tier` (`key`, `multiplier`) and `now`
(website time zone). Examples:

```text
order.total >= 5000 and customer.orders == 0
any(order.lines, it.sku like 'SHOE-*')
between(now, '18:00', '22:00')
```

Turning `earn_rules` off disables the whole product for the website (every other element depends on it).
