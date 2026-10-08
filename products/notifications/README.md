# Notifications

Sends WhatsApp, e-mail, SMS, browser push, staff push and outgoing webhooks for every product and for the merchant's
own server, through the merchant's own provider keys (PLAN.md 0.8.5). Feature keys are in `manifest.json`, the public
docs at `/docs`.

## Environment

Exactly three variables (`.env.example`; nothing else is read):

| Variable         | What it is                                                                      |
| ---------------- | ------------------------------------------------------------------------------- |
| `MONGODB_URI`    | this product's own database (never a merchant database)                         |
| `CONNECT_SECRET` | random, at least 32 characters; typed once into Portal → Products → Add product |
| `ENCRYPTION_KEY` | random, at least 32 characters, different for each deployable                   |

## Deploy

1. Create a Vercel project with the root directory `products/notifications` and set the three variables for Production only.
2. Deploy, then in the Portal: Products → **Add product** with its address and `CONNECT_SECRET`, then **Set active**.

## Scripts

`pnpm dev` and `pnpm build` regenerate `openapi.json` and `api/widget-script.js` first; `pnpm check` runs format, lint,
typecheck and tests with coverage; `pnpm validate` runs `ss app validate`.
