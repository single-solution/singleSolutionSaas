# Single Solution — developer guide

Single Solution is a **Portal** plus independent **products** (micro-apps). Client websites use the products through
a drop-in UI, a headless UI or a plain HTTP API. Each product is a separate app with its own hosting and deploy.
The Portal handles merchants, websites, credits, keys and billing. Products handle the features.

This file covers how to build. `PLAN.md` covers what is built and why.

## Repository

| Folder      | What it is                                                               | Deployed?                     |
| ----------- | ------------------------------------------------------------------------ | ----------------------------- |
| `platform/` | The **Portal**: merchant console, admin console (`/admin`), API          | Yes, one deployment           |
| `products/` | The **products** we sell (`chatbot`, `coupons`, `loyalty`, …)            | Yes, one deployment each      |
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

Needs Node 22+ (`.nvmrc`) and pnpm 11. Each deployable has a short `.env.example`: the Portal needs only its database
and file storage, a product its database and `CONNECT_SECRET`.

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

The Portal runs on http://localhost:4000. Open the staff login, http://localhost:4000/admin/login, and choose a password:
you become the admin (login name `admin`). Keys and secrets are generated in the database on first start.

## Building a product

```bash
pnpm exec ss app init products/my-app --kind service --slug my_app --name "My App"
```

Add `--minimal` to start without the sample feature. A product's settings are its own database (`MONGODB_URI`;
empty in development = in memory) and `CONNECT_SECRET` (`ss dev env` generates one). Run these two in separate terminals:

```bash
pnpm portal
```

```bash
pnpm dev
```

`pnpm portal` runs a fake Portal (`ss dev`) on port 4400 with the merchants, websites and plans from `ss.dev.json`.
`pnpm dev` runs the product on port 3000. Connect them with
`pnpm exec ss dev connect --url http://localhost:3000 --secret <CONNECT_SECRET>`. Use `ss dev launch`, `ss dev keys` and `ss dev emit`
to sign in, get website keys and send events.

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
jobs/            trigger-run handlers (on an event, on read, or from a dashboard button); nothing is scheduled
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
- **Nothing runs on its own** (PLAN F.19): no crons, no timers, no polling, no periodic or throttled background loops.
  Work happens inside, or right after (`after()`), the request or event that caused it, and only for what that request
  touched. Usage and events a request produced are sent right after it; a failed send retries on the next request.
- Anything with an expiry is treated as expired when read and cleaned up when touched; data that can simply disappear
  gets a MongoDB TTL index. Work a merchant must start (a crawl, a catch-up) is a dashboard button.
- Use events (`events.publish`, consumed through `/.well-known/ss-events`) and short-lived caches.
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

## Deploying (any Node 22 host + MongoDB Atlas)

The Portal and every service product run on **any Node 22 host** that runs Next.js (a server with `next build` +
`next start`, a container, or a serverless platform), on any domain. The environment holds only database and storage
connections; every other key and secret is generated inside the apps (a product also gets its `CONNECT_SECRET`). The Portal's
address is simply the one it is opened at. One MongoDB Atlas cluster (M0 works) serves all of them. Each deployable is one folder:

| Deployable              | Folder                                | What it is                                                                                                                                |
| ----------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Portal                  | `platform`                            | Merchant console, admin console, API, website script delivery                                                                             |
| One per service product | `products/<name>`                     | aftersales, alerts, catalog, chatbot, checkout, configurator, coupons, deals, grades, loyalty, orders, reviews, search, signups, wishlist |
| —                       | `products/pdp`, `products/storefront` | **Not deployed.** These are element packs, published into the Portal with `ss pack publish` (step 5)                                      |

On Vercel, for example, create one project per deployable from the same repository with its folder as **Root
Directory**.

**Vercel Hobby limits and how each is met** (measured on `next build`; kept as low as possible, not just under):

- **Functions per deployment (limit 12).** Each product deploys **2**: one route handler (`app/api/[...path]`, which
  `next.config.js` rewrites `/v1/*`, `/healthz`, `/readyz`, `/.well-known/*`, `/sso` and product paths to, URLs
  unchanged) and one dashboard page (`app/dashboard/[[...section]]`); `/` is static and there is no proxy (the route
  handler answers 503 `misconfigured` itself, the dashboard shows the reasons). The **Portal** deploys **5**: the API
  catch-all (also `/w/*`, `/p/*`, `/healthz`, `/readyz`, `/.well-known/jwks.json`), one console page, one admin page,
  `_not-found` and the CSP-nonce proxy. `ss app validate` fails a product with more than 2 server entry points or with
  `outputFileTracingIncludes`; runtime files are bundled through the generated `app/_lib/assets.js` (`prebuild`).
- **Function size (limit 250 MB).** Traced server files per function: products 4.1–4.4 MB, Portal 4.5 MB (API) and
  5.1 MB (each console page); the proxy 1.6 MB. No test, emulator or CLI code is traced.
- **Request body (limit 4.5 MB).** Every body cap is at most 3.9 MB (JSON default 1 MB; CSV/JSON imports 3.9 MB; Portal
  pack uploads 2 MB); photos and files go straight to storage with presigned URLs.
- **Duration.** No `maxDuration` is needed: work after a response is bounded (Portal jobs 8 s, lazy settlement 2 s,
  staff "Retry now" 8 s and 100 deliveries, products one batch per queue and website), outbound calls time out in
  5–15 s, and there are no crons.

**How it works** (PLAN F.19: event-driven only):

- **Nothing to schedule.** No deployable has a cron (`ss app validate` refuses one), no
  `CRON_SECRET`, no timer, no polling and no background loop. Running nothing costs nothing.
- **Work happens when something happens.** An ingested event is delivered right after the request that ingested it; a
  failed delivery is retried when the next event goes to that product or the product next calls the Portal (or staff
  press "Retry now"). Billing is computed when read: a merchant's complete hours settle whenever its balance, meter or
  statement is read, a product fetches an entitlement document or reports usage for one of its websites, or a
  subscription changes — so low-balance and spend-limit holds reach the products' entitlement documents. Products
  treat expiries on read, clean up when rows are touched (or by TTL indexes) and put merchant-started work behind
  dashboard buttons. Connectors are checked when saved or resolved; audit chains are verified per scope from the audit log.
- **Offline documents.** A product holding a still-valid entitlement document (10 minutes, plus its cache) may keep
  serving until it next refreshes it; a hold therefore takes effect within minutes, without any timer.
- **Small connection pools.** About 15 deployments share M0's ~500 connections, so pools are a fixed 5 per instance (Portal
  and products), merchant databases 3, and clients are cached on
  `globalThis` and reused across requests.

### 1. Atlas

Create **one cluster** (a replica set, so transactions work). Give every deployable its own database and its own
database user: `ss_portal` for the Portal, and `ss_<product>` for each product's small control database. Client data
never goes here; merchants connect their own databases in the Portal. Allow your hosts' addresses under **Network
Access** (`0.0.0.0/0` for hosts without fixed IPs; every user has its own password and only its own database).

### 2. Storage for the Portal's delivery files

Website scripts and pack files are stored in an S3-compatible bucket (Cloudflare R2, AWS S3, …). Create one bucket
and an access key limited to it. **Optional to start:** the Portal runs with only `MONGODB_URI`; until the `STORAGE_*`
variables are set, only the website-script and pack routes answer 503.

### 3. Portal

Set `MONGODB_URI` → deploy → open the staff login, `https://<your domain>/admin/login` → **choose a password**. You
are now the admin (login name `admin`); add your e-mail, name and two-factor sign-in whenever you like in **Account
settings**. Do it right after deploying: until an admin exists, whoever opens the staff login first becomes the admin.
Set `NODE_ENV=production` where the host does not set it, and the storage variables when you want website scripts:

| Variable                    | Value                                                                       |
| --------------------------- | --------------------------------------------------------------------------- |
| `MONGODB_URI`               | the Atlas URI for `ss_portal`                                               |
| `STORAGE_ENDPOINT`          | the bucket's S3 endpoint (R2: `https://<account>.r2.cloudflarestorage.com`) |
| `STORAGE_REGION`            | `auto` (the default; the bucket's region on AWS)                            |
| `STORAGE_BUCKET`            | the bucket from step 2                                                      |
| `STORAGE_ACCESS_KEY_ID`     | the bucket's access key                                                     |
| `STORAGE_SECRET_ACCESS_KEY` | its secret                                                                  |

Mail is set later in Admin → Settings. Indexes and migrations run by themselves.

### 4. Each service product

Set `MONGODB_URI` (its Atlas database from step 1) and `CONNECT_SECRET` (a random string of at least 32 characters,
e.g. `openssl rand -hex 32`) and deploy. Then Portal → **Admin → Apps → Add product** → the product URL and that
secret → **Connect**. The product generates its key and pins the Portal; review and activate it in the Portal, and
merchants can subscribe. The **Portal** deployment is unchanged.

### 5. Element packs (pdp, storefront)

Packs have no server; their files are uploaded into the Portal and served from it. Create a staff API token
(`POST /v1/admin/api-tokens` while signed in as an admin), then:

```bash
pnpm exec ss pack publish products/pdp --portal https://portal.<your-domain> --token sst_… --activate
```

Repeat for `products/storefront`.

### After launch

- Indexes and migrations apply themselves on the first request after a deploy. Moving a product or
  reconnecting: Add product again with its URL and `CONNECT_SECRET` (same URL = same app). To lock a Portal out,
  change `CONNECT_SECRET` and connect again from the right Portal.
- There is no cron or worker to set up anywhere, on any host.
