# Payments

Online payments with the merchant's own gateway keys (PLAN.md 0.8.7): Stripe, PayPal, PayFast (South Africa), PayFast
(Pakistan), JazzCash, Easypaisa, Rapid Gateway, bank transfer and a generic adapter; payment links, the payment API,
subscriptions and refunds. Payers always pay on the gateway's own page, so card details never reach Payments. Feature
keys are in `manifest.json`, the public docs at `/docs`.

## Environment

Exactly three variables (`.env.example`; nothing else is read):

| Variable         | What it is                                                                      |
| ---------------- | ------------------------------------------------------------------------------- |
| `MONGODB_URI`    | this product's own database (never a merchant database)                         |
| `CONNECT_SECRET` | random, at least 32 characters; typed once into Portal → Products → Add product |
| `ENCRYPTION_KEY` | random, at least 32 characters, different for each deployable                   |

## Deploy

1. Create a Vercel project with the root directory `products/payments` and set the three variables for Production only.
2. Deploy, then in the Portal: Products → **Add product** with its address and `CONNECT_SECRET`, then **Set active**.
3. Merchants register these addresses with their gateways (`<base>` is this product's address):

| Gateway       | Address                                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------- |
| Stripe        | webhook endpoint `<base>/v1/gateways/stripe/<websiteId>`                                                          |
| PayPal        | webhook `<base>/v1/gateways/paypal/<websiteId>` (its id goes into the PayPal connection)                          |
| PayFast (ZA)  | none: `notify_url` `<base>/v1/gateways/payfast/<websiteId>` is sent with every payment                            |
| PayFast (PK)  | none: `CHECKOUT_URL` `<base>/v1/gateways/payfast_pk/<websiteId>` is sent with every payment                       |
| JazzCash      | return URL `<base>/return/jazzcash/<websiteId>/<paymentId>` (sent per payment; whitelist `<base>`)                |
| Easypaisa     | postBack URL `<base>/return/easypaisa/<websiteId>/<paymentId>` (sent per payment; whitelist `<base>`)             |
| Rapid Gateway | webhook `<base>/v1/gateways/rapid/<websiteId>` (also sent per payment; its secret goes into the Rapid connection) |
| Generic       | notice `<base>/v1/gateways/generic/<websiteId>` (sent per payment as `notify_url`)                                |
| Bank transfer | none; storage CORS allows `PUT` from `<base>` for proof uploads                                                   |

## API

Routes are listed in `/docs` and `openapi.json` (generated from `server/routes.js`). Besides the payment, link,
subscription and pay-button routes, Payments serves `GET /v1/payments/count` and `/v1/payments/counts?by=state|gateway`
(and their ticket twins under `/v1/admin/payments/`), and the payment events on the kit's mechanism: `GET /v1/events`,
`/v1/events/count` and `/v1/events/counts` (PLAN.md 0.8.10 K4, K5). The kit adds its own routes for the merchant's
server (settings, texts, theme, Format, connections, activity log; `SS-Actor-*` headers name the acting member of staff).

## Scripts

`pnpm dev` and `pnpm build` regenerate `openapi.json` and `server/widget-script.js` first; `pnpm check` runs format, lint,
typecheck and tests with coverage; `pnpm validate` runs `ss app validate`.
