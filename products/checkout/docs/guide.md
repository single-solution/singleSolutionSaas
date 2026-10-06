# Cart & Checkout — developer guide

Every call takes a website key: `pk_` from the browser (bound to your domain; the shopper comes from `SS-Identity`,
your login's token) or `sk_` from your server. Money is integer minor units of your website's currency (set it in the
Portal: Website → Overview → Website settings). Full reference: `openapi.json`.

## 1. Items

Checkout prices lines only from item records it knows — never from the browser.

- Without the Catalog product, your server posts items: `PUT /v1/items/{itemId}` (`sk_`) with `title`, `currency`
  and `variants: [{ variantId, price, available }]` (`available: null` = stock not tracked).
- With the Catalog product, its `item.*`, `price.changed@1` and `inventory.changed@1` events keep the mirror current;
  set `cart.item_source = catalog` (and `cart.catalog_url` + the integration key) to look items up live too.

## 2. Cart

`POST /v1/carts` → `{ id }` (keep the id: it is the guest's access), `POST /v1/carts/{id}/lines`
`{ itemId, variantId?, quantity }`, `PATCH|DELETE /v1/carts/{id}/lines/{lineId}`, `POST /v1/carts/{id}/reconcile`
(price / stock changes, reported in `changes`), `POST /v1/carts/{id}/merge` after sign-in (with `SS-Identity`).

## 3. Checkout

- `GET /v1/checkout-form?country=XX` — the form for the country (fields, order, required, labels, autocomplete,
  delivery methods). `POST /v1/checkout-form:validate` checks values with the placement rules.
- `POST /v1/quotes` `{ cartId, deliveryMethod, paymentMethod, codes, loyaltyPoints, country }` — the server's totals and
  the availability of every payment method.
- `POST /v1/orders` with an `Idempotency-Key` header: `{ cartId | lines, country?, contact, address?, custom?,
deliveryMethod, pickupLocation?, paymentMethod, codes?, loyaltyPoints?, consents?, saveAddress?, note?,
expectedTotal? }`. Server keys may add `customer: { subject, email, phone }`. The response carries `accessToken` for
  guests — keep it with the order on the success page; never put it in a URL.

Starting status: bank transfer and COD with an advance → `pending_payment` (held `payment_manual.bank_hold_hours`);
COD → `awaiting_confirmation` (confirm with `POST /v1/orders/{id}/confirm`, else it expires after
`cod_confirmation_hours`); pay at pickup → `pending_payment` until collected. With `place_order.expiry_owner = checkout`
an order whose hold passed is expired from that moment: it is cancelled (stock released) as soon as it is read, listed or
confirmed, it no longer counts towards the open-order cap, and a placement short of stock releases expired holds first;
orders nobody touches are cancelled by the sweep that runs after requests (every few minutes per website) and by the
daily cron catch-up. `order.cancelled@1` gives codes and points back.

## 4. After placement

- `POST /v1/success-views` `{ orderId, token }` (guests) or `GET /v1/success-views/{orderId}` — next steps.
- `POST /v1/payment-proofs` `{ orderId, token, contentType, size, reference? }` → PUT the file to `upload.url` with
  exactly `upload.headers`, then `POST /v1/payment-proofs/{proofId}/complete`.
- `POST /v1/orders/{id}/payments` (`sk_`) records a payment; `POST /v1/orders/{id}/cancel` cancels.
- Gateway (preview): `POST /v1/payments` `{ orderId, token, returnUrl }` → follow `redirectUrl`; on return
  `POST /v1/payments/{paymentId}/refresh`. Provider webhooks: `POST /webhooks/payments/{websiteId}`.

## 5. Your other products

Set the base URLs in the settings (`offer_apply.coupons_url`, `offer_apply.deals_url`, `loyalty_redeem.loyalty_url`,
`cart.catalog_url`) and the `sk_` key once in Dashboard → Settings (or `PUT /v1/integrations/key`). Checkout calls the
Coupons, Deals, Loyalty and Catalog APIs server to server; when one does not answer, quotes go on without it
(`warnings`) and placement refuses with `integration_unavailable` rather than guessing.

## Modes A and B

Each element has a headless core (`headless/<element>.js`, e.g. `createCart({ config, strings, client, emit })` →
`{ state, actions, subscribe, validate, strings, destroy }`) and a default renderer (`ui/<element>.js#render`) on the
website's design tokens. `client` is the element's Mode C client (`@ss/web/element` `createElementApi`).
