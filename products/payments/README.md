# Payments

The Single Solution product that takes online payments for the merchant's customers with the merchant's own gateway
keys (PLAN.md 0.8.7, step 9): Stripe, PayPal, PayFast, JazzCash, Easypaisa, manual bank transfer and a generic adapter;
payment links, the merchant payment API, gateway-managed subscriptions and full and partial refunds. Payers always pay on
the gateway's own page or form: card details never reach Payments. Built on `@ss/app-kit`.

## Features

| Key               | What it does                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `stripe`          | Stripe Checkout (redirect), refunds through the Refunds API, Stripe subscriptions; signed webhooks         |
| `paypal`          | PayPal Orders v2 (approve, then captured server to server), refunds, PayPal subscriptions; verified hooks  |
| `payfast`         | PayFast's page (signed form), ITN checked by signature, amount and PayFast's validate call; API refunds    |
| `jazzcash`        | JazzCash hosted checkout (page redirection 1.1), `pp_SecureHash` both ways; refunds recorded               |
| `easypaisa`       | Easypay hosted checkout (two steps), confirmed with the inquire-transaction API; refunds recorded          |
| `bank_transfer`   | The merchant's bank details, an optional proof upload to the merchant's storage, confirmed by the merchant |
| `generic_gateway` | Any other gateway: signed checkout fields, signed notice, optional refund address                          |
| `payment_links`   | Reusable links for any amount (fixed or entered by the payer), the hosted link page, the pay button        |
| `payment_api`     | Create, list, read and verify payments; the event list; the Payments admin widget                          |
| `subscriptions`   | Gateway-managed subscriptions (Stripe, PayPal), mirrored; the Subscriptions admin widget                   |
| `refunds`         | Full and partial refunds by API or the Payments admin widget, recorded in the payment's history            |

A payment becomes paid only after its gateway confirmed it (a signed notice, or Payments asking the gateway server to
server) for its exact amount and currency. `POST /v1/payments/:id/verify` tells the merchant's server (or Ecommerce)
whether a payment of this website was paid for exactly the amount it expects. There is no background work: a pending
payment is asked of its gateway again when it is read (at most every 30 seconds), and payment events are sent to the
merchant through Notifications (`POST /v1/events` with the pasted Notifications token, signed there with the merchant's
webhook secret) right after requests for that website, retried on later ones (5 attempts).

## Layout (PLAN 0.4.13)

| Folder      | What it holds                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------- |
| `core/`     | pure logic: money (minor units, currencies), gateways and their currencies, payment rules and views, snippets        |
| `api/`      | routes, the payments service, the hosted pages (link page, pay page, bank details, results), the docs                |
| `adapters/` | the kit wiring (`product.js`), the gateway adapters behind one interface (`gateways/`), the merchant database        |
| `ui/`       | widgets: `pay_button` (visitor), `payments_admin` and `subscriptions_admin` (admin, tickets)                         |
| `app/`      | Next.js: the API function and the dashboard (Overview · Features · Settings · Connections · Developers)              |
| `strings/`  | every word of the widgets and the hosted pages (Settings → Texts)                                                    |
| `schemas/`  | each feature's settings schema (bank details and proof upload for `bank_transfer`)                                   |
| `tests/`    | Vitest on the kit's fake Portal with fake gateways, storage and Notifications (no real network call), MongoDB, jsdom |
| `docs/`     | the public docs' texts, served at `/docs`                                                                            |

## Addresses merchants register with gateways

| Gateway       | Address                                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| Stripe        | webhook endpoint `<base>/v1/gateways/stripe/<websiteId>`                                              |
| PayPal        | webhook `<base>/v1/gateways/paypal/<websiteId>` (its id goes into the PayPal connection)              |
| PayFast       | none: `notify_url` `<base>/v1/gateways/payfast/<websiteId>` is sent with every payment                |
| JazzCash      | return URL `<base>/return/jazzcash/<websiteId>/<paymentId>` (sent per payment; whitelist `<base>`)    |
| Easypaisa     | postBack URL `<base>/return/easypaisa/<websiteId>/<paymentId>` (sent per payment; whitelist `<base>`) |
| Generic       | notice `<base>/v1/gateways/generic/<websiteId>` (sent per payment as `notify_url`)                    |
| Bank transfer | none; storage CORS allows `PUT` from `<base>` for proof uploads                                       |

## Environment and deploying

Exactly three variables (`.env.example`): `MONGODB_URI` (this product's own database), `CONNECT_SECRET` and
`ENCRYPTION_KEY` (each random, at least 32 characters). Deploy with the Vercel project root `products/payments`, set the
three variables for Production, then connect it in the Portal: Products → Add product, with its address and
`CONNECT_SECRET`, then set it Active.

## Scripts

`pnpm dev` / `pnpm build` (both regenerate `openapi.json` and `api/widget-script.js` first) / `pnpm start`,
`pnpm check` (format, lint, typecheck, tests with coverage) and `pnpm validate` (`ss app validate`).
