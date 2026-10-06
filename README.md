# Single Solution — developer guide

Single Solution is a **Portal** plus independent **products** (micro-apps). Client websites use the products through
a drop-in UI, a headless UI or a plain HTTP API. Each product is a separate app with its own hosting and deploy.
The Portal handles merchants, websites, credits, keys and billing. Products handle the features.

This file covers how to build. `PLAN.md` covers what is built and why.

## Repository

| Folder      | What it is                                                               | Deployed?                     |
| ----------- | ------------------------------------------------------------------------ | ----------------------------- |
| `platform/` | The **Portal**: merchant console, admin console (`/admin`), API          | Yes, one Vercel project       |
| `products/` | The **products** we sell (`chatbot`, `coupons`, `loyalty`, …)            | Yes, one Vercel project each  |
| `packages/` | **Shared code** used by the Portal and the products (published packages) | No, built into the apps above |
| `e2e/`      | **System tests**: every product against the real Portal (`@ss/e2e`)      | No                            |

### Each folder is its own repository

Everything lives in one repository for now, but every **unit** — `platform/`, each `products/*`, each `packages/*`
— is built as if it were a repository of its own, so it can be split out later with no code changes beyond swapping
`workspace:^` ranges for published versions (`pnpm publish` does that for packages).

- A unit never imports another unit by path. It depends on it as a package (`@ss/ui`, `@ss/cli`,
  `@ss/platform/testing`, …) listed in its own `package.json` with a `workspace:^` range. Test helpers that other
  units need are public exports (`@ss/contracts/testing`, `@ss/ui/testing`, the `@ss/cli` API).
- A unit has its own tooling config built from `@ss/config` (`eslint.config.js`, `tsconfig.json`,
  `vitest.config.js`, the `prettier` key), its own scripts (`check`, `test`, `lint`, `typecheck`, `format:check`;
  `dev`/`build`/`start` for deployables), its own README, `.gitignore` and, for deployables, `.env.example` and
  `vercel.json`. Its coverage thresholds are met by its own tests.
- Tests that need two or more deployables (a product against the real Portal) live in `e2e/`, never in a unit.
- `ss app validate` refuses a product import or stylesheet reference that leaves the product folder
  (`imports.outside`), and checks the package wiring.
- Packages are published as written (JavaScript with JSDoc). `pnpm pack` / `pnpm publish` first run `prepack`
  (`build:types`: `tsc` writes `.d.ts` files from the JSDoc into `types/`), and `publishConfig.exports` adds the
  `types` condition, so a consumer outside the monorepo type-checks against the published package. In the monorepo
  the sources are read directly.
- The root only orchestrates: workspace scripts, CI and the docs.

To split a unit: copy its folder into a new repository, replace each `workspace:^` with the published version, add
the repository files the root provides today (`.nvmrc`, a `pnpm-workspace.yaml` with the `allowBuilds` list, a CI
workflow), then `pnpm install && pnpm check` (and `pnpm build` for a deployable).

Shared packages:

| Package            | Use it for                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `@ss/app-kit`      | **Every product is built on this.** Portal connection, keys, billing, client resources, events |
| `@ss/contracts`    | The shared formats: manifest, entitlement document, events, error problems                     |
| `@ss/cli` (`ss`)   | Create, run locally, validate and certify a product                                            |
| `@ss/web`          | The script a client website adds to load products on its pages                                 |
| `@ss/ui`           | Shared React components and theme                                                              |
| `@ss/entitlements` | Works out what a website may use (plans, elements, features, limits)                           |
| `@ss/rules`        | The small condition language (`rules@1`) used in settings                                      |
| `@ss/protocol`     | Signing and verifying keys, requests, launches and events                                      |
| `@ss/net`          | Safe outbound HTTP (blocks private networks, pins DNS)                                         |
| `@ss/config`       | The shared tooling: ESLint, TypeScript, Prettier and Vitest presets, the test MongoDB setup    |

Each folder has its own `README.md` with its reference. `packages/app-kit/API.md` is the binding product API.

## Setup

Needs Node 22+ (`.nvmrc`) and pnpm 11. Each deployable has a `.env.example` listing its variables.

```bash
pnpm install
```

```bash
pnpm check
```

`pnpm check` checks the root files' format, then runs every unit's own `check` (format, lint, typecheck and tests with
coverage) one after another. It must pass before every commit, and CI runs it per unit. Tests start their own
in-memory MongoDB, so they need no database.

| Command (from the root)                      | What it runs                                                         |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `pnpm check`                                 | the root files' format check, then every unit's `check`              |
| `pnpm --filter <unit> check`                 | one unit, e.g. `pnpm --filter @ss/product-loyalty check`             |
| `pnpm test` / `pnpm lint` / `pnpm typecheck` | that step in every unit                                              |
| `pnpm format` / `pnpm format:check`          | Prettier in every unit and on the root files                         |
| `pnpm test:all`                              | every unit's tests in one Vitest run (projects), sharing one MongoDB |
| `pnpm validate`                              | `ss app validate` in every product                                   |

Inside a unit's folder the same scripts run that unit alone (`pnpm check`, `pnpm test`, …).

Run the Portal locally (from `platform/`):

```bash
pnpm db:memory
```

```bash
pnpm env:dev > .env.local && pnpm dev
```

The Portal runs on http://localhost:4000. Create the first admin with `pnpm admin:bootstrap you@example.com`. It
prints a one-time password-setup link, and two-factor sign-in is required.

## Building a product

```bash
pnpm exec ss app init products/my-app --kind service --slug my_app --name "My App"
```

Add `--minimal` to start without the sample feature. In the product folder, create the local environment once:

```bash
pnpm exec ss dev env > .env.local
```

Then run these two in separate terminals:

```bash
pnpm portal
```

```bash
pnpm dev
```

`pnpm portal` runs a fake Portal (`ss dev`) on port 4400 with the merchants, websites and plans from `ss.dev.json`.
`pnpm dev` runs the product on port 3000. Use `ss dev launch`, `ss dev keys` and `ss dev emit` to sign in, get website
keys and send events.

Before a product ships:

```bash
pnpm exec ss app validate products/my-app
```

```bash
pnpm exec ss certify products/my-app --url http://localhost:3000
```

An element pack (or a service product's UI bundle) is built and published with:

```bash
pnpm exec ss pack build products/my-pack
```

```bash
pnpm exec ss pack publish products/my-pack --portal https://portal.example --token sst_… --key @dev-key.json --activate
```

`build` bundles the manifest's modules (minified ES modules, shared chunks), the string catalogs and the signed-bundle
descriptor into `dist/pack`; `publish` signs it and uploads it with a staff API token (`POST /v1/admin/api-tokens`).

Validate checks the files: manifest, layout, imports, strings and API docs. Certify checks the running product:
keys, website binding, switching elements off, idempotency, events and offline grace. A product that fails certify is
not registered.

### Product layout

```
manifest.json    what the product is: elements, features, plans, prices (credits per hour), events, resources
openapi.json     the HTTP API (every route documented)
schemas/         one *.features.json per element: its settings and their limits
strings/         all user-facing text, per language (en.json first; elements slice it with stringKeys). No text in code.
core/            pure logic: plain functions, data in, data out. No I/O, no DOM, no network.
adapters/        the only code that talks to the outside: database, AI, messaging, storage, Portal
api/             routes: read input, call core, use adapters, return a result
headless/        UI logic without the DOM, for merchants who build their own UI
ui/              drop-in UI that renders headless/ with the website's theme
app/             thin Next.js wiring only (routes call app-kit)
jobs/            the daily cron route and background work after requests (cleanup, retries)
tests/           Vitest tests, including certify (the Portal end-to-end test lives in e2e/)
eslint.config.js, tsconfig.json, vitest.config.js   tooling, built from @ss/config
docs/guide.md    short guide for developers using the product
```

Imports only go one way: `app → api → core/adapters`, and `ui → headless → core`. `core/` imports nothing with side
effects. `ss app validate` enforces this.

## How we write code

**Language: JavaScript (ESM), typed with JSDoc and checked by TypeScript (`tsc --checkJs --strict`).** This gives the
safety of TypeScript with no build step. Files run as written, stack traces match the source, and there is nothing to
compile. Use `.js` files with JSDoc types; do not add `.ts` files.

**Functional and simple.**

- Functions and plain objects only. No classes, `this` or inheritance (lint enforces this).
- Build things with factories: `createX({ deps })` returns an object of functions. Pass dependencies in (db, clock,
  random, fetch) and never import them as globals. This makes everything testable without mocks.
- Do not change inputs. Return new values instead (`no-param-reassign`, `prefer-const`).
- Keep logic pure in `core/`, and push I/O to the edges (`adapters/`, `api/`).
- Expected failures are values, not exceptions. Return a result or an RFC 9457 problem with
  `problem(code, detail)`. Throw only for bugs.
- Small files, small functions, clear names. Write a comment only when the _why_ is not obvious.
- No `console`. Use the injected logger, which redacts secrets.
- Add a dependency only when it removes real work. Prefer Node built-ins (`crypto`, `fetch`, `URL`).

**Nothing hardcoded.**

- Text goes in `strings/`.
- Prices, limits and switches go in `manifest.json` and `schemas/`.
- Colours come from theme tokens (`--ss-*`).
- URLs and secrets come from environment variables.
- No country, currency, language or time zone is assumed. Use the website's settings from the entitlement document.

## Security rules

1. **Clients bring their own resources.** Products never hold client data or credentials. They get the client's
   database, storage, AI or messaging connection from app-kit (`data.forWebsite`, `connectors`), only when needed and
   only for a short time.
2. **Every request is verified.**
   - Website keys (`pk_` for browsers, `sk_` for servers) are verified offline by app-kit and only work on their own
     domain.
   - Portal calls are signed requests.
   - Never accept a key, website id or customer id from the request body without app-kit checking it.
3. **Elements and features are enforced on the server.** app-kit reads the signed entitlement document. An element
   that is switched off answers 403 in every mode, whatever the UI does.
4. **Outbound calls** go through `product.outbound.fetch` (`@ss/net`). It blocks internal addresses and DNS
   rebinding.
5. **Validate all input** with the schemas, and cap sizes. Never build queries from raw input.
6. **Secrets** live only in environment variables, never in git, logs or responses. `.env*` files are git-ignored.
7. **Money** is integer millicredits (1 credit = 1000). Usage is reported per started hour and is idempotent. Never
   use floats for money.

## Fast and light

- Keep the browser UI small. The Loader has size budgets per element (`budget.js`) and per product's shared chunks
  (`budget.shared`); `ss app validate` measures them exactly as the Portal does (minified, bundled, gzip) and warns
  when one is exceeded or padded.
- Prefer static and cacheable responses. API responses that hold private data are `no-store`.
- Do not poll. Use events (`events.publish`, consumed through `/.well-known/ss-events`) and short-lived caches.
- Run slow work after the response, with `after()`, or in `jobs/`. Usage and events are flushed automatically.
- Crons run once a day (free tier). Work that must happen sooner runs after requests with
  `product.background.every(name, intervalMs, fn, { per: 'website' })`, and anything with an expiry is checked when
  read.
- Use one indexed query rather than many. Every query must have an index declared in `adapters/db.js`.

## Testing

- Vitest, with coverage targets of 90% lines and functions and 85% branches, met by each unit on its own
  (`defineUnitConfig` in `@ss/config/vitest`).
- Test `core/` with plain inputs and outputs. Test `api/` through the real HTTP handler with app-kit's fake Portal
  (`@ss/app-kit/testing`) and the in-memory MongoDB (`mongo: true` in the unit's `vitest.config.js`).
- Every product keeps its `tests/certify.test.js` (through `@ss/cli`) passing, and has a system test against the real
  Portal in `e2e/tests/<product>-portal.test.js` (it imports `@ss/platform/testing` and the product's `./serve`).

```bash
pnpm --filter @ss/product-my-app test
```

```bash
pnpm --filter @ss/e2e test
```

## Deploying (Vercel Hobby + MongoDB Atlas M0, $0)

Everything runs on free tiers: **Vercel Hobby** for the Portal and every service product, and **one MongoDB Atlas M0**
cluster shared by all of them. One GitHub repository feeds many Vercel projects. Each project uses one folder as its
**Root Directory**:

| Vercel project          | Root Directory                        | What it is                                                                                                                                |
| ----------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Portal                  | `platform`                            | Merchant console, admin console, API, website script delivery                                                                             |
| One per service product | `products/<name>`                     | aftersales, alerts, catalog, chatbot, checkout, configurator, coupons, deals, grades, loyalty, orders, reviews, search, signups, wishlist |
| —                       | `products/pdp`, `products/storefront` | **Not deployed.** These are element packs, published into the Portal with `ss pack publish` (step 5)                                      |

**How it works on free tiers** (PLAN F.19):

- **Crons are daily catch-ups.** Hobby runs a cron at most once a day, so each deployable has one daily cron in its
  `vercel.json` (the Portal's `/api/cron/daily` settles, drains the queue, checks connectors, reconciles, refreshes
  manifests and verifies the audit log, each step time-boxed and resumed the next day).
- **Real-time work happens on requests.** Event deliveries are attempted right after they are ingested; queued jobs,
  settlement and product sweeps (expiring holds, retries, dispatch, crawls) run after ordinary requests, throttled by a
  lease so busy sites do not repeat them; anything that expires is treated as expired when read. A quiet site simply
  waits for its next request or the daily cron.
- **Small connection pools.** About 15 deployments share M0's ~500 connections, so pools are 5 per instance (Portal
  `MONGODB_MAX_POOL_SIZE`, products `SS_PRODUCT_DB_MAX_POOL_SIZE`) and clients are reused across requests.
- Vercel's Hobby terms are for non-commercial use; moving to a paid plan or another Node 22 host later needs no code
  change.

### 1. Atlas

Create **one M0 cluster** (it is a replica set, so transactions work). Give every deployable its own database and its
own database user, so a leak in one product cannot read another: `ss_portal` for the Portal, and `ss_<product>` (for
example `ss_chatbot`) for each product's small control database. Client data never goes here; merchants connect their
own databases in the Portal. Under **Network Access** allow `0.0.0.0/0` (Vercel functions have no fixed IPs; every
user has its own password and only its own database).

### 2. Storage for the Portal's delivery files

Website scripts and pack files are stored in an S3-compatible bucket (Cloudflare R2, AWS S3, …). Create one bucket
and an access key limited to it.

### 3. Portal project

1. In Vercel: **Add New → Project** → import the repository → **Root Directory `platform`**. Leave "Include files
   outside the root directory" on; Vercel detects Next.js and pnpm.
2. Generate secrets locally and copy them into the project's environment variables (Production):

   ```bash
   cd platform && pnpm env:dev
   ```

   Then change, for production:
   - `PORTAL_ENV=production`
   - `PORTAL_URL=https://portal.<your-domain>`
   - `MONGODB_URI=` the Atlas URI for `ss_portal`
   - `PLATFORM_ASSET_STORAGE=` JSON of the bucket from step 2:
     `{"endpoint":"https://…","region":"auto","bucket":"…","accessKeyId":"…","secretAccessKey":"…"}`
   - `PREVIEW_ORIGIN=https://preview.<another-domain>` (recommended; point that domain at the same project)
   - `PLATFORM_SMTP_URL` and `PLATFORM_MAIL_FROM` for sign-up and password e-mails
   - `LOG_LEVEL=info`, and delete `OUTBOUND_DEV_ALLOW_HOSTS`

   The full list is in `platform/.env.example`.

3. Deploy, then add the domain `portal.<your-domain>`.
4. Prepare the database and create the first admin, from your machine with the production values in
   `platform/.env.local`:

   ```bash
   cd platform && pnpm db:indexes && pnpm db:migrate && pnpm admin:bootstrap you@example.com
   ```

   The last command prints a one-time password link. Open it, set a password, and enrol two-factor sign-in.

### 4. Each service product

For every folder in the table above:

1. Vercel: **Add New → Project** → same repository → **Root Directory `products/<name>`**.
2. Generate the product's keys locally:

   ```bash
   pnpm exec ss dev env --portal-url https://portal.<your-domain>
   ```

   Copy `SS_PORTAL_URL`, `SS_APP_SIGNING_KEY` and `SS_REGISTRATION_TOKEN_HASH` into the project's environment
   variables. Keep the **registration token** printed in the first comment line somewhere safe for step 4; it must
   not go into Vercel.

3. Also set `SS_PRODUCT_DB_URI` (its Atlas database from step 1), `SS_LOG_LEVEL=info`, `CRON_SECRET` (any random
   string of 32+ characters; Vercel sends it to the daily cron), and the product's own variables from
   `products/<name>/.env.example`.
4. Deploy and add a domain, for example `chatbot.apps.<your-domain>`.
5. Portal → **Admin → Apps → Register**: enter the product URL and paste the registration token. The Portal checks
   the product proves it holds the key, then lists it. Activate it, and merchants can subscribe.

### 5. Element packs (pdp, storefront)

Packs have no server; their files are uploaded into the Portal and served from it. Create a staff API token
(`POST /v1/admin/api-tokens` while signed in as an admin), then:

```bash
pnpm exec ss pack publish products/pdp --portal https://portal.<your-domain> --token sst_… --activate
```

Repeat for `products/storefront`.

### After launch

- Vercel only rebuilds the projects whose folder or `@ss/*` dependencies changed in a push.
- After a deploy that changes Portal data, run `pnpm db:indexes && pnpm db:migrate` in `platform` again.
- Nothing is Vercel-specific: any Node 22 host that runs `next start` with the same variables and calls each
  deployable's daily cron route with `Authorization: Bearer $CRON_SECRET` works.
