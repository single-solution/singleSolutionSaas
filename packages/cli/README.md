# @ss/cli (`ss`)

Developer tooling for Single Solution products (PLAN.md Part 0: 0.4.13 product standard, 0.11 environment, 0.10
splittable units). JavaScript ESM, functional; it depends on `@ss/contracts` (manifest checks), `@ss/app-kit` (the
widget entry, bundled when a product has not installed it yet) and esbuild (the widget bundle).

| Command                                                                                   | What it does                                                                                                                                               |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ss app init <dir> --id <id> --name <name> [--base-url <origin>] [--sdk-version <range>]` | generates a product in the 0.4.13 layout with the sample feature `notes`, then its generated files and a git-ignored `.env.local` with development secrets |
| `ss app validate [dir] [--json]`                                                          | checks the product standard (below)                                                                                                                        |
| `ss app assets [dir] [--check]`                                                           | generates `openapi.json` from the routes and `schemas/api.json`, and `server/widget-script.js` from `ui/`; `--check` fails when either is out of date      |

Exit codes: `0` ok, `1` failed validation or command error, `2` usage error. `--base-url` defaults to
`http://localhost:3000` (the manifest's `endpoints.base` until the product has its address).

## The generated product

`templates/product` (plus `templates/standalone` outside a pnpm workspace: `pnpm-workspace.yaml`, `.nvmrc`), with the
placeholders `{{id}}`, `{{name}}`, `{{global}}` (`SS<Product>`), `{{baseUrl}}` and `{{sdkVersion}}`:

- `manifest.json` (0.4.13: id, name, version, endpoints, widgetScriptUrl, docsUrl, features with a settings `$ref` into
  `schemas/` and an example `recommendFor` for the Setup sheet's advisor, permissions, widgets), `openapi.json`
  (generated), `.env.example` with exactly `MONGODB_URI`,
  `CONNECT_SECRET`, `ENCRYPTION_KEY` (and the optional `ENCRYPTION_KEY_PREVIOUS`), `vercel.json` without crons,
  `.gitignore` (`.env*` except `.env.example`), `.prettierignore`, `eslint.config.js` / `tsconfig.json` /
  `vitest.config.js` from `@ss/config`, `next.config.js` (rewrites of `/.well-known/*`, `/sso`, `/widget.js`, `/docs`,
  `/openapi.json`, `/v1/*` to the API function), `postcss.config.mjs`.
- `core/` (note checks, widget names), `server/` (routes, the `/docs` page, the generated widget bundle), `adapters/`
  (`product.js`: the kit wiring, with its part of the website Setup sheet: the `openapi` and `build` options and a
  `blueprint` hook; `notes-store.js`: the merchant database), `ui/` (the visitor widget `note_form` and the
  admin widget `inbox` on `@ss/app-kit/widget`, mounted only into `data-ss-<id>` elements), `app/` (two functions:
  `app/api/[...path]/route.js` and the dashboard page `app/dashboard/page.js` on `@ss/ui`, texts in
  `app/dashboard/texts.js`), `strings/en.json`, `schemas/` (the settings schema and `api.json`, below), `tests/` (Vitest
  on the kit's fake Portal and a test MongoDB, coverage 90/90/85; every answer is checked against `schemas/api.json`),
  `docs/guide.json` (with `build`: what the merchant's website builds per feature).
- `package.json`: private, UNLICENSED, `@ss/*` at `workspace:^` (or `--sdk-version`), scripts `check`, `test`, `lint`,
  `typecheck`, `format`, `format:check`, `dev`, `build`, `start`, `validate`, and two entries for system tests:
  `./product` (`createProductInstance(options)`, plus `manifest` and `strings`) and `./routes` (`createRoutes(product)`):
  `product.handler(createRoutes(product), { after })`.

The widget bundle: `ui/entry.js` and its imports are bundled by esbuild (IIFE, minified, browser) into
`server/widget-script.js`, which exports the string `WIDGET_SCRIPT`; the public `/widget.js` route (auth `none`) serves
it, the same for every website. With `data-token` the script fetches the website's widget config from the kit
(`GET /v1/widget/config`; admin widgets `GET /v1/widget/admin/config` with a ticket). The dashboard's Back to Portal and
"Manage tokens in the Portal" links use `portalUrl` from `GET /v1/dashboard/session`.

## Validate

| Rule                                                                                        | Checks                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anatomy.missing`                                                                           | the nine folders and the files every product has                                                                                                                                                                                                                                    |
| `manifest.*`                                                                                | `manifest.json` with its `$ref`s bundled, against `@ss/contracts` `validateManifest`                                                                                                                                                                                                |
| `routes.dynamic`, `routes.auth`, `routes.feature`, `routes.permission`                      | every `defineRoute` in `server/` has literal method, path and auth; browser, server and ticket routes belong to a manifest feature (or permission)                                                                                                                                  |
| `routes.widget-script`, `routes.docs`                                                       | a path `widgetScriptUrl` and a path `docsUrl` are public `GET` routes (auth `none`)                                                                                                                                                                                                 |
| `strings.file`, `strings.invalid`, `strings.placeholders`, `strings.unknown-key`            | `strings/en.json` is the only text file, flat texts, well-formed `{placeholders}`, every `t('key')` exists                                                                                                                                                                          |
| `env.example`, `vercel.crons`                                                               | exactly the three variables (the optional `ENCRYPTION_KEY_PREVIOUS` allowed); no crons                                                                                                                                                                                              |
| `imports.direction`, `imports.package`, `imports.unresolved`, `imports.outside`, `core.dom` | server → core, adapters; adapters → core; core → `@ss/contracts` only; ui → core (+ `@ss/app-kit/widget`); app → server, adapters, core, strings; JSON data from strings/, schemas/, docs/, root for server, adapters and app; nothing leaves the project; core/ has no DOM globals |
| `package.dependency`, `package.devDependency`, `package.script`, `package.missing`          | `@ss/app-kit`, `@ss/cli`, `@ss/config`, the standard scripts, and every imported package listed                                                                                                                                                                                     |
| `server.entries`, `server.tracing`                                                          | at most two server functions (the API route and the dashboard page), no `outputFileTracingIncludes`                                                                                                                                                                                 |
| `assets.openapi`, `assets.widget`                                                           | `openapi.json` (compared as JSON) and `server/widget-script.js` match the sources                                                                                                                                                                                                   |
| `api.invalid`, `api.unknown`, `api.missing`                                                 | `schemas/api.json` is valid (below); every entry names a browser, server or ticket route of `server/`; every such route has an entry                                                                                                                                                |

`--json` prints `{ ok, dir, manifest, problems: [{ severity, rule, file, line?, pointer?, message }], summary }`.

## API descriptions (`schemas/api.json`)

A merchant's own developer builds the shop's screens on the products' APIs, so every call says exactly what it takes
and answers. `schemas/api.json` is a JSON object keyed `"<METHOD> <path as in defineRoute>"`, one entry for every
browser-token, server-token and ticket route:

```json
{
	"$schemas": {
		"Note": {
			"type": "object",
			"required": ["id", "text"],
			"additionalProperties": false,
			"properties": { "id": { "type": "string" }, "text": { "type": "string", "maxLength": 2000 } }
		}
	},
	"POST /v1/notes": {
		"summary": "Leave a note",
		"description": "A text longer than the maxLength setting answers 422 validation_failed.",
		"body": { "type": "object", "required": ["text"], "properties": { "text": { "type": "string" } } },
		"status": 201,
		"response": { "$ref": "#/components/schemas/Note" }
	},
	"GET /v1/notes/count": { "summary": "Count the notes", "response": { "$ref": "#/components/schemas/Count" } }
}
```

| Member        | What it is                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `summary`     | one line (the docs' route tables show it)                                                                                 |
| `description` | more text: rules, errors worth knowing                                                                                    |
| `query`       | an object schema; each property is a query parameter (`required` lists the required ones)                                 |
| `headers`     | an object schema; each property is a request header the route reads (e.g. `SS-Guest`), `required` lists the required ones |
| `body`        | the JSON request body (`requestBody`, required when the schema requires a member)                                         |
| `response`    | the JSON answer on success; leave it out for a 204                                                                        |
| `status`      | the success status, 200–299 (default 200)                                                                                 |
| `$schemas`    | (top level) shared schemas by name, referenced as `{ "$ref": "#/components/schemas/<Name>" }` → `components.schemas`      |

Schemas use a small JSON Schema subset (`@ss/app-kit/api`): `type` (one, or a list such as `["string", "null"]`),
`properties`, `required`, `additionalProperties`, `items`, `minItems`, `maxItems`, `maxProperties`, `propertyNames`,
`enum`, `const`, `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`, `format` (`date-time`, `date`, `uri` and
`email` are checked), `oneOf`, `anyOf`, `$ref`, and the notes `title`, `description`, `default` and `examples`. The
kit's shared schemas may be referenced too: `Count` and `Counts` (the `/count` and `/counts` routes),
`Connection`, `ActivityEntry`, `Actor`, `Text`, `Theme`, `Format`, `ValueSource`. The kit describes its own routes
(tickets, data rights, permissions, features, settings, texts, theme, Format, lists, connections, activity) in
`@ss/app-kit`'s `src/kit-api.json`; a product does not describe them again.

`ss app assets` merges the descriptions into `openapi.json` (and refuses an invalid `schemas/api.json`); the `/docs` page
renders them with `renderApiReference(openapi)` from `@ss/app-kit`. The product's test helper checks every answer its
`call()` sees, so a description cannot drift from the code:

```js
import { apiChecker } from '@ss/app-kit/testing';
import apiJson from '../schemas/api.json' with { type: 'json' };

const API = apiChecker(apiJson); // throws when schemas/api.json is invalid
// in call(), after each answer:
API.assert({ method, path, status: response.status, body: json }); // throws when a 2xx answer does not fit
```

## Testing

```sh
pnpm check   # format, lint, typecheck, vitest with coverage (from the root: pnpm --filter @ss/cli check)
```

`src/bin.js` (process wiring only) is excluded; everything else is tested through `main()` with injected io.
`test/init.test.js` generates a product, validates it and runs its own test suite with the coverage thresholds.
