# Portal (`@ss/platform`)

Where our admins (Owner, Support, Finance) manage merchants, their websites, the products on each website and credits,
and where merchants see their websites, tokens, install code, usage and credits and open each product's dashboard
(PLAN.md Part 0). It holds control-plane records only; business data lives in each merchant's own database, inside the
products. Next.js 16, React 19, MongoDB. The modules and their services are described in `src/modules/README.md` and
`src/modules/INTERFACES.md`.

## Environment

Exactly three variables (PLAN 0.11, `.env.example`), validated at start (only names are reported, never values):

| Variable         | What it is                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `MONGODB_URI`    | the Portal's own database (`ss_portal`; never a merchant database; production and preview never share one)                             |
| `PORTAL_URL`     | the Portal's final address (https in production, no path): e-mail links, token, launch and notice issuer, CSRF origin, products pin it |
| `ENCRYPTION_KEY` | random, at least 32 characters: seals the stored secrets (mail password, two-step secrets, server tokens)                              |

Signing keys and the session and idempotency secrets are generated on first start into the Portal's own database.
Outside production the Portal may reach products on `localhost`, `127.0.0.1` and `::1` over plain http.

## Deploy

1. Create a Vercel project (or any Node 22 host running Next.js) with the root directory `platform` and set the three
   variables for Production only.
2. Deploy, open `<PORTAL_URL>/login` at once and create the first admin (name, e-mail, password): you become the Owner.
3. Connect each product in Products → **Add product**. Changing `PORTAL_URL` later means reconnecting every product.

Indexes are applied on the first request after a deploy; there is nothing to schedule or run by hand.

## Local development

```bash
pnpm --filter @ss/platform db:memory      # terminal 1: in-memory MongoDB replica set on port 27999
cd platform && pnpm env:dev > .env.local  # NODE_ENV, MONGODB_URI, PORTAL_URL, ENCRYPTION_KEY
pnpm dev                                  # http://localhost:4000, then open /login and create the first admin
```

`pnpm check` runs format, lint, typecheck and tests with coverage; `pnpm build` runs `next build`. System tests that run
the products against this Portal live in `e2e/` and use `@ss/platform/testing`.
