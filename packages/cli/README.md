# @ss/cli (`ss`)

Developer tooling for SSPS v1 products (PLAN Part E §14, F.7). JavaScript ESM, functional, no dependencies beyond the
`@ss/*` core packages (the emulator's in-memory client database uses the optional peer dependency
`mongodb-memory-server`, loaded lazily).

| Command                                                                                                                      | What it does                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ss app init <dir> --kind service\|pack --slug <slug> --name <name> [--minimal]`                                             | generates a project from `templates/shared` + `templates/<kind>`; `--minimal` (service only) leaves out the `notes` sample; a service gets a generated `CONNECT_SECRET` in `.env.local`                                                                                                                            |
| `ss app validate [dir] [--json]`                                                                                             | manifest (local `$ref`s bundled) schema + semantics, anatomy, module refs/exports, import direction, DOM-free cores, no colour literals in `ui/`, string keys/placeholders, OpenAPI coverage, package wiring, budgets measured like the Portal (F.18), no `vercel.json` crons (F.19)                               |
| `ss pack build [dir] [--out <dir>] [--json]`                                                                                 | bundles the manifest modules (minified ESM + shared chunks), catalogs and the `ss-pack-bundle@1` descriptor into `dist/pack`                                                                                                                                                                                       |
| `ss pack publish [dir] --portal <url> [--token <sst_…>] [--key <kid:seed\|@file>] [--activate]`                              | signs the descriptor and uploads it and every asset to the Portal admin pack API with a staff API token                                                                                                                                                                                                            |
| `ss dev`                                                                                                                     | local Portal emulator: JWKS, `/v1/product/*`, website keys, fixtures from `ss.dev.json`, admin API for the subcommands below                                                                                                                                                                                       |
| `ss dev env \| connect \| launch \| keys \| emit \| entitlements \| subscription \| resource \| identity \| settle \| state` | the product env (`MONGODB_URI` and a generated `CONNECT_SECRET`), connecting a running product (`connect --url <product> --secret <s>`, default env `CONNECT_SECRET`), launch URLs (all kinds), pk_/sk_ keys, signed event injection, entitlement switches, identity-issuer approval, hourly settlement simulation |
| `ss certify [dir] --url <product> [--secret <s>]`                                                                            | certification suite against a running, unconnected product: connects it with its secret (`--secret`, env `CONNECT_SECRET` or the project's `.env.local`; checks `connection.rejects-wrong-secret`, `connection.connect`, `connection.reconnect`), then pass/fail table + `ss-certify-report.json`                  |

Exit codes: `0` ok, `1` failed validation/certification or command error, `2` usage error.

## Pack build and publish (F.18)

```sh
ss pack build [dir] [--out <dir>] [--json]
ss pack publish [dir] --portal <url> [--token <sst_…>] [--key <kid:seed | @file>] [--activate]
```

- **build** bundles every module the manifest names (`headless` / `renderer`, `file.js#export`) with esbuild —
  minified ES modules for browsers, code-split shared code in `chunks/<name>-<hash>.js`, each entry at its own path —
  adds the string catalogs (`strings/<lang>.json` and legacy per-element files, compact JSON), hashes every asset and
  writes `dist/pack/` (`descriptor.json`: `{ format: 'ss-pack-bundle@1', manifest (features inline), assets: [{ path,
sha256, size, contentType }] }`). It prints each element's measured size and the shared chunks.
- **publish** builds, signs the descriptor with the developer key (`@ss/protocol` `signBundle`), `POST /v1/admin/packs`
  `{ descriptor, signature, publicJwk }`, `PUT /v1/admin/packs/:appId/versions/:version/assets/<path>` per asset and,
  with `--activate`, activates the app. It authenticates with a **staff API token** (`sst_…`, minted by
  `POST /v1/admin/api-tokens`). Environment fallbacks: `PORTAL_URL`, `ADMIN_TOKEN`, `PACK_SIGNING_KEY`.
- Programmatic: `@ss/cli/pack` — `buildPack(dir)`, `descriptorOf(pack)`, `measurePack(pack)`, `writePack(pack, out)`,
  `publishPack({ pack, portalUrl, token, signingKey, fetch, activate })`, `bundleModules`, `moduleEntries`,
  `elementModules`, `loadManifest` (also re-exported from `@ss/cli`).

## Budgets in `ss app validate` (F.18)

Validate builds the Mode A elements exactly like `ss pack build` and measures them with `@ss/contracts/budget`, the
function the Portal's compiler uses: `budget.estimate` (an element's own entry modules exceed `budget.js`),
`budget.padded` (a declaration above the measured KB rounded up plus a quarter, at least 1 KB), `budget.shared` (shared
chunks undeclared or above `budget.shared`), `budget.build` (the modules cannot be bundled). It scans sources only —
never build output (`dist/`, `.ss-pack-out/`) — so minified identifiers never fool the `t('…')` check, and
`strings.slice` reports keys an element renders outside its `stringKeys` (and every sibling's).

## Portal product API (emulated)

Exactly the wire formats of PLAN.md F.9 (client assertion, `aud` = the Portal URL): entitlements `{ document }`,
revocations `{ keyIds, cursor }`, usage `{ records }` + `Idempotency-Key` → `{ results }`, launch consume `{ consumed }`,
events `{ events: [...] }`, resources `{ kind, descriptor: { uri, dbName }, expiresAt }`, heartbeat, keys/rotate, and
identity-issuer requests (`PUT /v1/product/websites/:websiteId/identity` → 202 `{ status: 'pending', request }`, or 200
`{ status: 'active', issuer }` once `ss dev identity --website <id> --decision approve` made it the issuer; the approved
issuer, with its JWKS fetched once at approval, goes into the website's entitlement documents).
Portal → product calls are signed with `@ss/protocol` `signRequest`; admin changes are delivered as control events
(`entitlement.changed@1`, `key.revoked@1`, `resource.changed@1`, `subscription.*@1`).

## Testing

```sh
pnpm check   # in this folder: format, lint, typecheck, vitest with coverage (from the root: pnpm --filter @ss/cli check)
```

`src/bin.js` (process wiring only) is excluded with a `/* v8 ignore start/stop */` block; everything else is tested
through `main()` with injected io. `test/helpers/fake-product.js` is a minimal product built on `@ss/protocol`; the
certification tests run the suite against it and against deliberately broken variants.

Certification of website keys: every resource with a documented `GET /v1/<resource>` must answer a `pk_` key from
the bound domain with 200 or a 401/403 problem, identically on a repeat; a `GET` marked `"x-ss-key-kind": "sk"` in
`openapi.json` must refuse `pk_`. Consumed globs (`custom.*`, `order.*@1`) are certified with a concrete matching
type. `ss app validate` lets `headless/` import `@ss/web/element` (the DOM-free element runtime) and nothing else from
`@ss/web`.
**Certification resource.** The key, gating, idempotency, pagination, control-event and offline-grace checks run
against one resource. A product chooses it by setting `"x-ss-certify": true` on the collection path `/v1/<resource>`
in `openapi.json` (on the path item or on one of its operations); the resource must be in the `api.resources` of a
Mode C element, and the first such element is the one switched off and on. Without a mark the first resource of the
first Mode C element with `api.resources` is used (as before). Several marked paths, or a mark on any other path, fail
the `certify.target` check, which otherwise reports the chosen resource. Idempotency replay and pagination use that
path's `POST` request example and are skipped without one.

**Event samples.** `src/emulator/events.js` has a valid sample `data` for every catalogued event type
(`EVENT_CATALOGUE`: standard incl. `item.*`, `inventory.changed@1`, `price.changed@1`, order lifecycle, control and
loader events) plus the catalogued element UI verbs (`<element>.shown@1`, `<element>.action@1`): hand-tuned samples
(`HAND_TUNED`) where realism matters, else generated from the data schema by `sampleFromSchema` (required members,
types, `enum`/`const`, formats, bounds, patterns via candidate strings). `ss dev emit` and certification use them, so
any consumed catalogued type (or glob) is deliverable. Platform-scoped types are built with `scope: 'platform'` and no
`websiteId`; element UI events name their element in `context.element`. `test/events.test.js` validates every sample
with `@ss/contracts` `validateEvent`.

**`ss app init --minimal`** (service products) leaves out the `notes` sample (`NOTES_SAMPLE_FILES`: core, headless,
renderer, API handlers, event consumer, repository, feature/event schemas and their tests) and overlays
`templates/minimal/service`: a product needs at least one element, so it ships one placeholder Mode C element
`status` (`GET /v1/status`, a `greeting` config feature, `x-ss-certify`), no database requirement, no events, and
`adapters/privacy.js` handlers that answer empty exports. The project passes `ss app validate`, its own
Vitest suite (with the coverage thresholds) and `ss certify` (POST replay, pagination and event delivery are skipped: nothing to exercise).
The full template's README explains how to remove the sample by hand.

Every generated project is self-sufficient: its tooling config comes from `@ss/config` (`eslint.config.js`,
`tsconfig.json` extending `@ss/config/tsconfig.base.json`, `vitest.config.js` with the coverage thresholds, the
`prettier` key) and it has its own `check`, `test`, `lint`, `typecheck` and `format:check` scripts. `@ss/*` ranges
default to `workspace:^` (`--sdk-version` for a project outside the monorepo). Outside a pnpm workspace,
`templates/standalone` adds what a repository of its own needs (`pnpm-workspace.yaml` with the allowed build scripts,
`.nvmrc`). `ss app validate` checks this wiring (`package.dependency`, `package.devDependency`, `package.script`) and
that no import or stylesheet reference leaves the project (`imports.outside`, every file including `tests/` and
`app/`), and that `vercel.json` declares no crons (`vercel.crons`, PLAN F.19: event-driven only). The template has
no scheduled work: app-kit sends usage and events after requests, and the notes sample's soft-deleted notes are
removed by a MongoDB TTL index (`purge_ttl`). Every Next.js route file of the template
exports `OPTIONS` (CORS preflight reaches app-kit) and `_lib/product.js` passes Next's `after` to `toNextRoute`.

`test/product-e2e.test.js` generates a service product, links `@ss/*` to the packages this package resolves (its own
dev dependencies), serves it with the
template's `serve.js` and requires every certification check to pass against the real `@ss/app-kit` (and certifies a
`--minimal` project the same way).
