# @ss/cli (`ss`)

Developer tooling for Single Solution products (PLAN.md Part 0: 0.4.13 product standard, 0.11 environment, 0.10
splittable units). JavaScript ESM, functional; it depends on `@ss/contracts` (manifest checks), `@ss/app-kit` (the
widget entry, bundled when a product has not installed it yet) and esbuild (the widget bundle).

| Command                                                                                   | What it does                                                                                                                                               |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ss app init <dir> --id <id> --name <name> [--base-url <origin>] [--sdk-version <range>]` | generates a product in the 0.4.13 layout with the sample feature `notes`, then its generated files and a git-ignored `.env.local` with development secrets |
| `ss app validate [dir] [--json]`                                                          | checks the product standard (below)                                                                                                                        |
| `ss app assets [dir] [--check]`                                                           | generates `openapi.json` from the routes and `api/widget-script.js` from `ui/`; `--check` fails when either is out of date                                 |

Exit codes: `0` ok, `1` failed validation or command error, `2` usage error. `--base-url` defaults to
`http://localhost:3000` (the manifest's `endpoints.base` until the product has its address).

## The generated product

`templates/product` (plus `templates/standalone` outside a pnpm workspace: `pnpm-workspace.yaml`, `.nvmrc`), with the
placeholders `{{id}}`, `{{name}}`, `{{global}}` (`SS<Product>`), `{{baseUrl}}` and `{{sdkVersion}}`:

- `manifest.json` (0.4.13: id, name, version, endpoints, widgetScriptUrl, docsUrl, features with a settings `$ref` into
  `schemas/`, permissions, widgets), `openapi.json` (generated), `.env.example` with exactly `MONGODB_URI`,
  `CONNECT_SECRET`, `ENCRYPTION_KEY`, `vercel.json` without crons, `.gitignore` (`.env*` except `.env.example`),
  `.prettierignore`, `eslint.config.js` / `tsconfig.json` / `vitest.config.js` from `@ss/config`, `next.config.js`
  (rewrites of `/.well-known/*`, `/sso`, `/widget.js`, `/docs`, `/v1/*` to the API function), `postcss.config.mjs`.
- `core/` (note checks, widget names), `api/` (routes, the `/docs` page, the generated widget bundle), `adapters/`
  (`product.js`: the kit wiring; `notes-store.js`: the merchant database), `ui/` (the visitor widget `note_form` and the
  admin widget `inbox` on `@ss/app-kit/widget`, mounted only into `data-ss-<id>` elements), `app/` (two functions:
  `app/api/[...path]/route.js` and the dashboard page `app/dashboard/page.js` on `@ss/ui`, texts in
  `app/dashboard/texts.js`), `strings/en.json`, `schemas/`, `tests/` (Vitest on the kit's fake Portal and a test
  MongoDB, coverage 90/90/85), `docs/guide.json`.
- `package.json`: private, UNLICENSED, `@ss/*` at `workspace:^` (or `--sdk-version`), scripts `check`, `test`, `lint`,
  `typecheck`, `format`, `format:check`, `dev`, `build`, `start`, `validate`, and two entries for system tests:
  `./product` (`createProductInstance(options)`, plus `manifest` and `strings`) and `./routes` (`createRoutes(product)`):
  `product.handler(createRoutes(product), { after })`.

The widget bundle: `ui/entry.js` and its imports are bundled by esbuild (IIFE, minified, browser) into
`api/widget-script.js`, which exports the string `WIDGET_SCRIPT`; the public `/widget.js` route (auth `none`) serves
it, the same for every website. With `data-token` the script fetches the website's widget config from the kit
(`GET /v1/widget/config`; admin widgets `GET /v1/widget/admin/config` with a ticket). The dashboard's Back to Portal and
"Manage tokens in the Portal" links use `portalUrl` from `GET /v1/dashboard/session`.

## Validate

| Rule                                                                                        | Checks                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anatomy.missing`                                                                           | the nine folders and the files every product has                                                                                                                                                                                              |
| `manifest.*`                                                                                | `manifest.json` with its `$ref`s bundled, against `@ss/contracts` `validateManifest`                                                                                                                                                          |
| `routes.dynamic`, `routes.auth`, `routes.feature`, `routes.permission`                      | every `defineRoute` in `api/` has literal method, path and auth; browser, server and ticket routes belong to a manifest feature (or permission)                                                                                               |
| `routes.widget-script`, `routes.docs`                                                       | a path `widgetScriptUrl` and a path `docsUrl` are public `GET` routes (auth `none`)                                                                                                                                                           |
| `strings.file`, `strings.invalid`, `strings.placeholders`, `strings.unknown-key`            | `strings/en.json` is the only text file, flat texts, well-formed `{placeholders}`, every `t('key')` exists                                                                                                                                    |
| `env.example`, `vercel.crons`                                                               | exactly the three variables; no crons                                                                                                                                                                                                         |
| `imports.direction`, `imports.package`, `imports.unresolved`, `imports.outside`, `core.dom` | api → core, adapters; adapters → core; ui → core (+ `@ss/app-kit/widget`); app → api, adapters, core, strings; JSON data from strings/, schemas/, docs/, root for api, adapters and app; nothing leaves the project; core/ has no DOM globals |
| `package.dependency`, `package.devDependency`, `package.script`, `package.missing`          | `@ss/app-kit`, `@ss/cli`, `@ss/config`, the standard scripts, and every imported package listed                                                                                                                                               |
| `server.entries`, `server.tracing`                                                          | at most two server functions (the API route and the dashboard page), no `outputFileTracingIncludes`                                                                                                                                           |
| `assets.openapi`, `assets.widget`                                                           | `openapi.json` (compared as JSON) and `api/widget-script.js` match the sources                                                                                                                                                                |

`--json` prints `{ ok, dir, manifest, problems: [{ severity, rule, file, line?, pointer?, message }], summary }`.

## Testing

```sh
pnpm check   # format, lint, typecheck, vitest with coverage (from the root: pnpm --filter @ss/cli check)
```

`src/bin.js` (process wiring only) is excluded; everything else is tested through `main()` with injected io.
`test/init.test.js` generates a product, validates it and runs its own test suite with the coverage thresholds.
