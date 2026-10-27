# Portal (`@ss/platform`)

Where our admins (Owner, Support, Finance) manage merchants, their websites, the products on each website and credits,
and where merchants see their websites, tokens, usage and credits and open each product's dashboard (see `PLAN.md`).
Each website has a **Setup** page (merchant, Owner, Support): its Setup sheet (`ss.blueprint/1`) with
every product's features, settings, connections state, widgets, install snippets, staff permissions, events, to-dos,
what the website builds and docs, gathered from the products on request, as a page and as JSON (Download, Copy), and
read-only share links for a client or a developer (`/shared-setup#key=…`, 1–30 days, revocable, never secrets). Its
setup advisor recommends features from the website's short business profile (what it sells, how shoppers pay,
delivery, sign-in, chat, messages, marketing, offers, each with the merchant's own answers where the options cannot list
everything; moving, tax at checkout, countries, languages) by the `recommendFor` tags of each product's features (only
what the profile asks for), points out features that are on but not called for, and lets Owner and Support switch a
recommended feature on with one click. Each website also has **Website settings** (merchant: own websites; Owner and Support: any; never Finance): the facts every product of the website shares — business, brand and theme, region and Format, domains, pages and legal texts, team and alerts — set once and delivered to every product on the website (a version in the status answer, a `website.settings_changed` notice, a pull at `GET /v1/product/websites/:websiteId/settings`), each change an Activity entry. It holds control-plane records only; business data lives in each merchant's own database, inside the
products. Next.js 16, React 19, MongoDB. The modules and their services are described in `src/modules/README.md` and
`src/modules/INTERFACES.md`.

## Environment

Exactly three variables, plus one optional during a key change and an optional log level (see `.env.example`),
validated at start (only names are reported, never values):

| Variable                  | What it is                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MONGODB_URI`             | the Portal's own database (`ss_portal`; never a merchant database; production and preview never share one)                                       |
| `PORTAL_URL`              | the Portal's final address (https in production, no path): email links, token, launch and notice issuer, CSRF origin, products pin it            |
| `ENCRYPTION_KEY`          | random, at least 32 characters: seals the stored secrets (mail password, two-step secrets, server tokens, signing keys)                          |
| `ENCRYPTION_KEY_PREVIOUS` | optional, only while `ENCRYPTION_KEY` is changed: the old key, so stored secrets keep opening; removed after Settings → Encryption key → Re-seal |
| `LOG_LEVEL`               | optional: `debug`, `info`, `warn`, `error` or `silent` (default `info`; `debug` in development)                                                  |

Signing keys and the session and idempotency secrets are generated on first start into the Portal's own database; the
signing keys are kept sealed with `ENCRYPTION_KEY` (their public keys readable).
Outside production the Portal may reach products on `localhost`, `127.0.0.1` and `::1` over plain http.

## Deploy

1. Create a Vercel project (or any Node 22 host running Next.js) with the root directory `platform` and set the three
   variables for Production only.
2. Deploy, open `<PORTAL_URL>/login` at once and create the first admin (name, email, password): you become the Owner.
3. Connect each product in Products → **Add product**. Changing `PORTAL_URL` later means reconnecting every product.

Indexes are applied on the first request after a deploy; there is nothing to schedule or run by hand.

## Local development

```bash
pnpm --filter @ss/platform db:local       # terminal 1: MongoDB replica set on port 27999, data kept in platform/.mongo-data
                                          # (or db:memory: in memory, lost on stop)
cd platform && node scripts/dev-env.js > .env.local  # MONGODB_URI, PORTAL_URL, ENCRYPTION_KEY
pnpm dev                                  # http://localhost:3000, then open /login and create the first admin
```

Every deployable has its own port, so all run at once: the Portal 3000, Accounts 3001, Notifications 3002, Chat 3003,
Payments 3004, Ecommerce 3005, Growth 3006 (each product's README has its own "Local development" part). The products
use the same MongoDB with their own database names. Under `next dev` the products may call each other on `localhost`
and use a local merchant database; in production none of that is ever allowed.

`pnpm check` runs format, lint, typecheck and tests with coverage; `pnpm build` runs `next build`. System tests that run
the products against this Portal live in `e2e/` and use `@ss/platform/testing`.
