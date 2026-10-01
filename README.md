# Single Solution — developer guide

Single Solution is a **Portal** plus independent **products** (micro-apps). Client websites use the products through
a drop-in UI, a headless UI or a plain HTTP API. Each product is a separate app with its own hosting and deploy.
The Portal handles merchants, websites, credits, keys and billing. Products handle the features.

This file covers how to build. `PLAN.md` covers what is built and why.

## Repository

| Folder      | What it is                                                      | Deployed?                     |
| ----------- | --------------------------------------------------------------- | ----------------------------- |
| `platform/` | The **Portal**: merchant console, admin console (`/admin`), API | Yes, one Vercel project       |
| `products/` | The **products** we sell (`chatbot`, `coupons`, `loyalty`, …)   | Yes, one Vercel project each  |
| `packages/` | **Shared code** used by the Portal and the products             | No, built into the apps above |

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

Each folder has its own `README.md` with its reference. `packages/app-kit/API.md` is the binding product API.

## Setup

Needs Node 22+ (`.nvmrc`) and pnpm 11. Each deployable has a `.env.example` listing its variables.

```bash
pnpm install
```

```bash
pnpm check
```

`pnpm check` runs format, lint, typecheck and every test. It must pass before every commit, and CI runs it too.
Tests start their own in-memory MongoDB, so they need no database.

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

Validate checks the files: manifest, layout, imports, strings and API docs. Certify checks the running product:
keys, website binding, switching elements off, idempotency, events and offline grace. A product that fails certify is
not registered.

### Product layout

```
manifest.json    what the product is: elements, features, plans, prices (credits per hour), events, resources
openapi.json     the HTTP API (every route documented)
schemas/         one *.features.json per element: its settings and their limits
strings/         all user-facing text, per language (en.json first). No text in code.
core/            pure logic: plain functions, data in, data out. No I/O, no DOM, no network.
adapters/        the only code that talks to the outside: database, AI, messaging, storage, Portal
api/             routes: read input, call core, use adapters, return a result
headless/        UI logic without the DOM, for merchants who build their own UI
ui/              drop-in UI that renders headless/ with the website's theme
app/             thin Next.js wiring only (routes call app-kit)
jobs/            scheduled work (cleanup, retries)
tests/           Vitest tests; every product includes certify and Portal end-to-end tests
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

- Keep the browser UI small. The Loader has size budgets per product, and `ss app validate` estimates them.
- Prefer static and cacheable responses. API responses that hold private data are `no-store`.
- Do not poll. Use events (`events.publish`, consumed through `/.well-known/ss-events`) and short-lived caches.
- Run slow work after the response, with `after()`, or in `jobs/`. Usage and events are flushed automatically.
- Use one indexed query rather than many. Every query must have an index declared in `adapters/db.js`.

## Testing

- Vitest, with coverage targets of 90% lines and functions and 85% branches.
- Test `core/` with plain inputs and outputs. Test `api/` through the real HTTP handler with app-kit's fake Portal
  (`@ss/app-kit/testing`) and the in-memory MongoDB.
- Every product keeps its `certify.test.js` and `portal-e2e.test.js` (product against the real Portal) passing.

```bash
pnpm vitest run products/my-app
```

## Deploying

- Every deployable (`platform/` and each `products/*`) is its own Vercel project, with that folder as the root
  directory and its own MongoDB Atlas database.
- Crons are declared in each folder's `vercel.json`.
- Nothing is Vercel-specific: any Node 22 host that runs `next start` works.
- Set the environment variables listed in each folder's README. Run `pnpm db:indexes` and `pnpm db:migrate` on the
  Portal after deploys that change data.
- An admin registers a new product in the Portal (Admin → Apps). The product shows a one-time registration token
  bound to the Portal URL. Paste it once, and the two sides then trust each other's signed keys.
