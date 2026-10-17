# Payments

Online payments with the merchant's own gateway keys (PLAN.md 0.8.7): Stripe, PayPal, PayFast (South Africa), PayFast
(Pakistan), JazzCash (Pakistan), Easypaisa (Pakistan), Rapid Gateway (Pakistan), up to five custom gateways of the merchant's own and the merchant's manual payment
methods (bank transfer, cash and the like, with proof of payment); payment links, the payment API, subscriptions and refunds. Payers always pay on the gateway's own page, so card details
never reach Payments. Feature keys are in `manifest.json`, the public docs at `/docs`.

## Environment

Three variables, and one optional while the encryption key is changed (`.env.example`; nothing else is read):

| Variable                  | What it is                                                                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MONGODB_URI`             | this product's own database (never a merchant database)                                                                                                                            |
| `CONNECT_SECRET`          | random, at least 32 characters; typed once into Portal → Products → Add product                                                                                                    |
| `ENCRYPTION_KEY`          | random, at least 32 characters, different for each deployable: seals the gateways' keys and the other Connections                                                                  |
| `ENCRYPTION_KEY_PREVIOUS` | optional, only while `ENCRYPTION_KEY` is changed: the old key, so sealed values keep opening; removed once the dashboard's Re-seal (Prices → Encryption key, Owner) says it can be |

## Local development

Each deployable has its own port, so all run at once: the Portal 3000, Accounts 3001, Notifications 3002, Chat 3003,
Payments 3004, Ecommerce 3005, Growth 3006. This product runs on **3004**.

1. One local MongoDB for everything (keep it running): `pnpm --filter @ss/platform db:local` (kept in
   `platform/.mongo-data`) or `db:memory` (lost on stop). Start the Portal as its README says.
2. `products/payments/.env.local` (git-ignored), each secret random and different (make one with
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`):

   ```bash
   MONGODB_URI=mongodb://127.0.0.1:27999/ss_payments?replicaSet=testset
   CONNECT_SECRET=<random>
   ENCRYPTION_KEY=<random>
   ```

3. `pnpm dev` → http://localhost:3004. In the Portal (http://localhost:3000): Products → Add product with
   `http://localhost:3004` and the `CONNECT_SECRET`, then Set active.

Under `next dev` (`NODE_ENV=development`) the product may call `http://localhost` and `127.0.0.1` (the Portal and the
other products) and use a MongoDB there, for example a merchant database
`mongodb://127.0.0.1:27999/?replicaSet=testset` entered in the Portal (Website settings › Data and files). A deployed product (`NODE_ENV=production`) never
does: only public https addresses and TLS databases.

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
| Custom        | notice `<base>/v1/gateways/generic/<key>/<websiteId>` (sent per payment as `notify_url`)                          |
| Manual method | none; storage CORS allows `PUT` from `<base>` for proof uploads                                                   |

## API

Routes are listed in `/docs` and `openapi.json` (generated from `server/routes.js`). Besides the payment, link,
subscription and pay-button routes, Payments serves `GET /v1/manual-methods` (the manual methods as payers see them), `GET /v1/payments/count` and `/v1/payments/counts?by=state|gateway`
(and their ticket twins under `/v1/admin/payments/`), and the payment events on the kit's mechanism: `GET /v1/events`,
`/v1/events/count` and `/v1/events/counts` (PLAN.md 0.8.10 K4, K5). The kit adds its own routes for the merchant's
server (settings, texts, connections, activity log; the staff member's signed-in `SS-Sign-In` is needed and names them). The look and the Format are the Portal's (Website settings): the kit reads them and refuses a save (409 `managed_by_portal`).

## Scripts

`pnpm dev` and `pnpm build` regenerate `openapi.json` and `server/widget-script.js` first; `pnpm check` runs format, lint,
typecheck and tests with coverage; `pnpm validate` runs `ss app validate`.
