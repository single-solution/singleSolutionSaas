# Notifications

Sends WhatsApp, email, SMS, browser push, staff push and outgoing webhooks for every product and for the merchant's
own server, through the merchant's own provider keys (PLAN.md 0.8.5). Feature keys are in `manifest.json`, the public
docs at `/docs`.

## Environment

Three variables, and one optional while the encryption key is changed (`.env.example`; nothing else is read):

| Variable                  | What it is                                                                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MONGODB_URI`             | this product's own database (never a merchant database)                                                                                                                            |
| `CONNECT_SECRET`          | random, at least 32 characters; typed once into Portal → Products → Add product                                                                                                    |
| `ENCRYPTION_KEY`          | random, at least 32 characters, different for each deployable: seals the Connections' secrets and the real words of waiting sensitive messages                                     |
| `ENCRYPTION_KEY_PREVIOUS` | optional, only while `ENCRYPTION_KEY` is changed: the old key, so sealed values keep opening; removed once the dashboard's Re-seal (Prices → Encryption key, Owner) says it can be |

## Local development

Each deployable has its own port, so all run at once: the Portal 3000, Accounts 3001, Notifications 3002, Chat 3003,
Payments 3004, Ecommerce 3005, Growth 3006. This product runs on **3002**.

1. One local MongoDB for everything (keep it running): `pnpm --filter @ss/platform db:local` (kept in
   `platform/.mongo-data`) or `db:memory` (lost on stop). Start the Portal as its README says.
2. `products/notifications/.env.local` (git-ignored), each secret random and different (make one with
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`):

   ```bash
   MONGODB_URI=mongodb://127.0.0.1:27999/ss_notifications?replicaSet=testset
   CONNECT_SECRET=<random>
   ENCRYPTION_KEY=<random>
   ```

3. `pnpm dev` → http://localhost:3002. In the Portal (http://localhost:3000): Products → Add product with
   `http://localhost:3002` and the `CONNECT_SECRET`, then Set active.

Under `next dev` (`NODE_ENV=development`) the product may call `http://localhost` and `127.0.0.1` (the Portal and the
other products) and use a MongoDB there, for example a merchant database
`mongodb://127.0.0.1:27999/?replicaSet=testset` entered in the Portal (Website settings › Data and files). A deployed product (`NODE_ENV=production`) never
does: only public https addresses and TLS databases.

## Deploy

1. Create a Vercel project with the root directory `products/notifications` and set the three variables for Production only.
2. Deploy, then in the Portal: Products → **Add product** with its address and `CONNECT_SECRET`, then **Set active**.

## Scripts

`pnpm dev` and `pnpm build` regenerate `openapi.json` and `server/widget-script.js` first; `pnpm check` runs format, lint,
typecheck and tests with coverage; `pnpm validate` runs `ss app validate`.
