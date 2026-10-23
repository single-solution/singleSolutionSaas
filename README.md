# Single Solution

A **Portal** plus six separately hosted **products** (Notifications, Accounts, Chat, Payments, Ecommerce, Growth). Each
product offers an API plus ready-made widgets and has its own setup dashboard. `PLAN.md` Part 0 is the binding plan.

| Folder              | What it is                                                                        | Deployed                 |
| ------------------- | --------------------------------------------------------------------------------- | ------------------------ |
| `platform/`         | the Portal (merchant console, admin console at `/admin`, API)                     | yes, one deployment      |
| `products/<id>/`    | the six products                                                                  | yes, one deployment each |
| `packages/`         | the shared kit (`app-kit`, `protocol`, `contracts`, `net`, `ui`, `cli`, `config`) | no, built into the above |
| `packages/importer` | `ss-import`: moves a store's records into the products (PLAN 0.8.10 Migration)    | no, a command-line tool  |
| `e2e/`              | system tests: the products against the real Portal                                | no                       |

Every folder is a unit that builds and checks on its own, so it can be split into its own repository later (PLAN 0.10).
Each deployable's README lists its environment variables and how to deploy it.

## Setup

Needs Node 22 (`.nvmrc`) and pnpm 11.

```bash
pnpm install
pnpm check
```

`pnpm check` checks the root files' format, then runs every unit's own `check` (format, lint, typecheck and tests with
coverage of 90 % lines, 90 % functions and 85 % branches). Tests start their own in-memory MongoDB. CI runs the same per
unit, plus `next build` for deployables and `ss app validate` for products. `pnpm format` writes the format of the
root files and of every unit, `pnpm validate` runs `ss app validate` on every product, and
`pnpm --filter <unit> <script>` runs one unit's script.

## Adding a product (outside this monorepo)

Do **not** clone this repository to start a new product. This tree is the Portal plus the six first-party products.
Start a product with the published CLI — it writes a standalone package (`pnpm-workspace.yaml`, pinned `@ss/*`
versions), not a fork of `products/`:

```bash
npx @ss/cli app init my-product --id my-product --name "My Product"
cd my-product && pnpm install && pnpm check
```

`ss app validate` enforces the product standard (layout, routes, configure ≠ operate). See `packages/cli/README.md`.

## Deploying

The owner deploys. Deploy the Portal first (`platform/README.md`), then each product (`products/<id>/README.md`).
Every deployable has its own database and its variables are set for Production only; preview deployments never use the
production database.
