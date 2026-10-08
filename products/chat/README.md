# Chat

Chat on a merchant's own website and admin (PLAN.md 0.8.3): the visitor chat widget, AI replies with the merchant's own
provider key, knowledge, webhook tools and booking, guests and Accounts sign-ins, handoff, the inbox, leads and flows,
attachments, ratings, transcripts, staff alerts, moderation, reports and Ecommerce's shop tools. Feature keys are in
`manifest.json`, the public docs at `/docs`.

## Environment

Exactly three variables (`.env.example`; nothing else is read):

| Variable         | What it is                                                                      |
| ---------------- | ------------------------------------------------------------------------------- |
| `MONGODB_URI`    | this product's own database (never a merchant database)                         |
| `CONNECT_SECRET` | random, at least 32 characters; typed once into Portal → Products → Add product |
| `ENCRYPTION_KEY` | random, at least 32 characters, different for each deployable                   |

## Deploy

1. Create a Vercel project with the root directory `products/chat` and set the three variables for Production only.
2. Deploy, then in the Portal: Products → **Add product** with its address and `CONNECT_SECRET`, then **Set active**.

## Scripts

`pnpm dev` and `pnpm build` regenerate `openapi.json` and `api/widget-script.js` first; `pnpm check` runs format, lint,
typecheck and tests with coverage; `pnpm validate` runs `ss app validate`.
