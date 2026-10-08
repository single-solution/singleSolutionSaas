# Accounts

Sign-up and sign-in for a merchant's users on their own website and admin (PLAN.md 0.8.6): phone and e-mail codes,
e-mail and password, Google, Apple and Facebook, roles and permissions, custom profile fields, two-step sign-in,
sessions, data rights and copies of every product's activity log. Messages go through Notifications (pasted token).
Feature keys are in `manifest.json`, the public docs at `/docs`.

## Environment

Exactly three variables (`.env.example`; nothing else is read):

| Variable         | What it is                                                                      |
| ---------------- | ------------------------------------------------------------------------------- |
| `MONGODB_URI`    | this product's own database (never a merchant database)                         |
| `CONNECT_SECRET` | random, at least 32 characters; typed once into Portal → Products → Add product |
| `ENCRYPTION_KEY` | random, at least 32 characters, different for each deployable                   |

## Deploy

1. Create a Vercel project with the root directory `products/accounts` and set the three variables for Production only.
2. Deploy, then in the Portal: Products → **Add product** with its address and `CONNECT_SECRET`, then **Set active**.
3. Merchants register `<address>/oauth/<google|apple|facebook>/callback` with their sign-in providers.

## Scripts

`pnpm dev` and `pnpm build` regenerate `openapi.json` and `api/widget-script.js` first; `pnpm check` runs format, lint,
typecheck and tests with coverage; `pnpm validate` runs `ss app validate`.
