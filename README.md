# Single Solution — developer guide

Single Solution is a **Portal** plus six separately hosted **products** (Accounts, Ecommerce, Chat, Notifications,
Payments, Growth). Each product offers an API plus ready-made widgets and has its own setup dashboard. The Portal is
where our admins manage merchants, websites, products on websites, tokens and credits, and where merchants see their
websites, tokens, install code, usage and credits and open product dashboards.

This file covers how to build. `PLAN.md` Part 0 is the binding plan: what is built and why.

## Repository

| Folder      | What it is                                                                                                         | Deployed?                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| `platform/` | The **Portal**: merchant console, admin console (`/admin`), API                                                    | Yes, one deployment           |
| `products/` | The **products**: `notifications`, `accounts`, `chat`, `payments`, `ecommerce` and `growth` (PLAN 0.12 steps 6–11) | Yes, one deployment each      |
| `packages/` | The **shared kit** used by the Portal and the products (published packages)                                        | No, built into the apps above |
| `e2e/`      | **System tests**: products against the real Portal (`@ss/e2e`)                                                     | No                            |

### Each folder is its own repository

Everything lives in one repository for now, but every **unit** — `platform/`, each `products/*`, each `packages/*`
— is built as if it were a repository of its own, so it can be split out later with no code change beyond swapping
`workspace:^` ranges for published versions.

- A unit never imports another unit by path. It depends on it as a package listed in its own `package.json`
  (`workspace:^`). Test helpers other units need are public exports (`@ss/app-kit/testing`, `@ss/contracts/testing`,
  `@ss/ui/testing`, `@ss/platform/testing`, the `@ss/cli` API).
- A unit has its own tooling config built from `@ss/config`, its own scripts (`check`, `test`, `lint`, `typecheck`,
  `format`, `format:check`; `dev`/`build`/`start` for deployables, `validate` for products), its own README,
  `.gitignore` and, for deployables, `.env.example` and `vercel.json`. Its coverage thresholds (90 % lines, 90 %
  functions, 85 % branches) are met by its own tests.
- Tests that need two or more deployables live in `e2e/`.
- Packages are published as written (JavaScript with JSDoc); `prepack` writes `.d.ts` files from the JSDoc.
- The root only orchestrates: workspace scripts, CI and the docs.

## Shared kit

| Package            | What it holds                                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `@ss/protocol`     | Signing: browser and server tokens, tickets, launches, notices, client assertions and the connect handshake                              |
| `@ss/contracts`    | The product manifest, settings schemas, the Portal ↔ product shapes, business.json, problem codes and ids                                |
| `@ss/app-kit`      | Everything a product needs: connect, status cache, notices, reports, tokens, tickets, settings, connections, dashboard API, widget mount |
| `@ss/entitlements` | Money units (millicredits), UTC hours and hashing used by the Portal's ledger                                                            |
| `@ss/net`          | Safe outbound calls to addresses a merchant or admin entered                                                                             |
| `@ss/ui`           | Console and dashboard components (light and dark)                                                                                        |
| `@ss/web`          | Small browser helpers a product may bundle into its own `widget.js`                                                                      |
| `@ss/rules`        | The `rules@1` expression language, optional inside a product                                                                             |
| `@ss/cli`          | `ss app init`, `ss app validate`, `ss app assets`                                                                                        |
| `@ss/config`       | Shared ESLint, TypeScript, Prettier and Vitest config                                                                                    |

## Setup

Needs Node 22+ (`.nvmrc`) and pnpm 11.

```bash
pnpm install
pnpm check
```

`pnpm check` checks the root files' format, then runs every unit's own `check` (format, lint, typecheck and tests with
coverage) one after another. It must pass before every commit, and CI runs it per unit. Tests start their own
in-memory MongoDB, so they need no database.

| Command (from the root)                      | What it runs                                                         |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `pnpm check`                                 | the root files' format check, then every unit's `check`              |
| `pnpm --filter <unit> check`                 | one unit, e.g. `pnpm --filter @ss/app-kit check`                     |
| `pnpm test` / `pnpm lint` / `pnpm typecheck` | that step in every unit                                              |
| `pnpm format` / `pnpm format:check`          | Prettier in every unit and on the root files                         |
| `pnpm test:all`                              | every unit's tests in one Vitest run (projects), sharing one MongoDB |
| `pnpm validate`                              | `ss app validate` in every product                                   |

Run the Portal locally (from `platform/`):

```bash
pnpm db:memory
pnpm env:dev > .env.local && pnpm dev
```

The Portal runs on http://localhost:4000. Open http://localhost:4000/login and create the first admin (name, e-mail,
password): you become the Owner.

## Building a product

```bash
pnpm exec ss app init products/<id> --id <id> --name "<Name>"
pnpm exec ss app validate products/<id>
```

`ss app init` generates the product standard of PLAN 0.4.13: `core/` (pure logic), `api/` (routes), `adapters/`
(merchant database, providers, the Portal), `ui/` (widgets), `app/` (the dashboard), `strings/` (English texts),
`schemas/` (settings schemas), `tests/` and `docs/`, plus `manifest.json`, `openapi.json` and a `.env.example` listing
exactly `MONGODB_URI`, `CONNECT_SECRET` and `ENCRYPTION_KEY`. Imports go from api to core or adapters, from adapters
to core and from ui to core, never the reverse; `ss app validate` enforces this. Every API route belongs to exactly one
feature and works only while that feature is on. Products start with every feature at price 0 and off; an Owner sets
prices in the product's Prices screen.

## How we write code

- **JavaScript (ESM), typed with JSDoc and checked by TypeScript** (`tsc --checkJs --strict`). No `.ts` files.
- **Functional and simple**: functions and plain objects only (no classes, `this` or inheritance; lint enforces
  this); factories `createX({ deps })` with injected db, clock, randomness and fetch; inputs never changed; logic pure
  in `core/`, I/O at the edges.
- Expected failures are values: RFC 9457 problems with a stable code. Throw only for bugs.
- No `console`: use the injected logger, which redacts secrets.
- **Nothing hardcoded**: texts in `strings/` (every widget word is editable per website), settings in `schemas/`,
  colours from the theme, secrets from environment variables. No country, currency, language or time zone is
  assumed: business basics come from the website's `business.json`, the rest from the product's settings.

## Security rules

1. **Merchants bring their own resources.** Business data lives only in the merchant's own database, connected in each
   product's Connections. Connection values are encrypted with the product's `ENCRYPTION_KEY` and never returned.
2. **Every request is verified.** Browser tokens work only from `https://<exact domain>` and localhost; server tokens
   are refused when sent with an Origin header; tickets work only from the origin they were made for. Notices from the
   Portal are signed.
3. **Features are enforced on the server**: a route of a feature that is off answers 403 `feature_off`.
4. **Outbound calls** to any address a merchant or admin entered go through `@ss/net`.
5. **Secrets** live only in environment variables and encrypted fields, never in git, logs or responses.
6. **Money** is integer millicredits (1 credit = 1000); only the Portal's clock counts.

## Fast and light

- **Nothing runs on its own**: no crons, timers or background loops. Work happens inside, or right after, the request
  that caused it. Products keep each website's status for at most 5 minutes; the Portal settles a merchant when a
  product fetches a status or a Portal page shows that merchant.
- Anything with an expiry is judged when read; data that can simply disappear gets a MongoDB TTL index.

## Testing

- Vitest, coverage 90 % lines and functions and 85 % branches per unit.
- Test `core/` with plain inputs and outputs; test `api/` through the real handler with the kit's fake Portal
  (`@ss/app-kit/testing`) and the in-memory MongoDB.
- `e2e/` checks the Portal ↔ product contract against the real Portal with a test product generated by
  `ss app init` (`e2e/fixtures/`).

## Deploying (any Node 22 host + MongoDB Atlas)

Deploying is done by the owner. Each deployable has its own database and its own environment variables (PLAN 0.11),
set for Production only; preview deployments never use the production database.

| Deployable   | Variables                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| Portal       | `MONGODB_URI`, `PORTAL_URL` (its final https address), `ENCRYPTION_KEY` (≥ 32 random characters)      |
| Each product | `MONGODB_URI`, `CONNECT_SECRET` (≥ 32 random characters), `ENCRYPTION_KEY` (≥ 32, different for each) |

1. Deploy the Portal (Vercel root `platform/`), open `/login` and create the first Owner straight away.
2. Deploy a product (Vercel root `products/<id>`), then in the Portal: Products → **Add product** with the product's
   URL and its `CONNECT_SECRET`, then **Set active**.
3. Add a merchant, a website and the product on the website; the merchant copies the install code and tokens from
   the website's **Install and tokens** tab.

Changing `PORTAL_URL` means reconnecting every product (Products → Reconnect).
