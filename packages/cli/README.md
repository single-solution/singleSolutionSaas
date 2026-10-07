# @ss/cli (`ss`)

Developer tooling for SSPS v1 products (PLAN Part E §14, F.7). JavaScript ESM, functional, no dependencies beyond the
`@ss/*` core packages and esbuild (loaded on demand by `ss pack build`).

| Command                                                                          | What it does                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ss app init <dir> --kind service\|pack --slug <slug> --name <name> [--minimal]` | generates a project from `templates/shared` + `templates/<kind>`; `--minimal` (service only) leaves out the `notes` sample; a service gets a generated `CONNECT_SECRET` in `.env.local`                                                                          |
| `ss app validate [dir] [--json]`                                                 | manifest (local `$ref`s bundled) schema + semantics, anatomy, module refs/exports, import direction, DOM-free cores, no colour literals in `ui/`, string keys/placeholders/slices, OpenAPI coverage, package wiring, server shape, no `vercel.json` crons (F.19) |
| `ss app assets [dir] [--check]`                                                  | generates `app/_lib/assets.js` (manifest, feature schemas and strings as static imports for the Next.js server build); `--check` fails when it is out of date                                                                                                    |
| `ss pack build [dir] [--out <dir>] [--json]`                                     | bundles the manifest's `headless` / `renderer` modules (minified ESM + shared chunks), the catalogs and the `ss-pack-bundle@1` descriptor into `dist/pack`                                                                                                       |

Exit codes: `0` ok, `1` failed validation or command error, `2` usage error.

## Pack build (F.18)

`ss pack build` works the same for an element pack and for a service product's widgets (its Mode A elements). It
bundles every module the manifest names (`headless` / `renderer`, `file.js#export`) with esbuild — minified ES modules
for browsers, code-split shared code in `chunks/<name>-<hash>.js`, each entry at its own path — adds the string
catalogs (`strings/<lang>.json` and legacy per-element files, compact JSON), hashes every asset and writes
`dist/pack/` (`descriptor.json`: `{ format: 'ss-pack-bundle@1', manifest (features inline), assets: [{ path, sha256,
size, contentType }] }` plus the asset files). The descriptor is unsigned.

Upload the folder in the Portal Admin Console: **Upload pack version** (packs) or **Upload widgets** (a connected
service product whose manifest has Mode A elements). The console posts `descriptor.json` to `POST /v1/admin/packs` and
then `PUT`s every missing asset.

Programmatic: `@ss/cli/pack` — `buildPack(dir)`, `descriptorOf(pack)`, `writePack(pack, out)`, `bundleModules`,
`moduleEntries`, `stringAssets`, `assetOf`, `loadManifest` (also re-exported from `@ss/cli`).

## Validate

`ss app validate` scans sources only — never build output (`dist/`, `.ss-pack-out/`) — so minified identifiers never
fool the `t('…')` check, and `strings.slice` reports keys an element renders outside its `stringKeys` (and every
sibling's). `headless/` may import `@ss/web/element` (the DOM-free element runtime) and nothing else from `@ss/web`.
Package wiring (`package.dependency`, `package.devDependency`, `package.script`) expects the scripts `dev`, `build`,
`start`, `check`, `test`, `lint`, `typecheck`, `format:check`, `validate` for a service product and `check`, `test`,
`lint`, `typecheck`, `format:check`, `validate` for a pack. No import or stylesheet reference may leave the project
(`imports.outside`, every file including `tests/` and `app/`), and `vercel.json` declares no crons (`vercel.crons`).

## Templates

Every generated project is self-sufficient: its tooling config comes from `@ss/config` (`eslint.config.js`,
`tsconfig.json` extending `@ss/config/tsconfig.base.json`, `vitest.config.js` with the coverage thresholds, the
`prettier` key) and it has its own `check`, `test`, `lint`, `typecheck` and `format:check` scripts. `@ss/*` ranges
default to `workspace:^` (`--sdk-version` for a project outside the monorepo). Outside a pnpm workspace,
`templates/standalone` adds what a repository of its own needs (`pnpm-workspace.yaml` with the allowed build scripts,
`.nvmrc`). A service product exports `./platform` (`adapters/platform.js`, `createPlatform`) and `./routes`
(`api/routes.js`, `buildRoutes`) so a test harness can compose it with app-kit's `createRequestHandler`. The template
has no scheduled work: app-kit sends usage and events after requests, and the notes sample's soft-deleted notes are
removed by a MongoDB TTL index (`purge_ttl`). Every Next.js route file exports `OPTIONS` (CORS preflight reaches
app-kit) and `_lib/product.js` passes Next's `after` to `toNextRoute`.

**`ss app init --minimal`** (service products) leaves out the `notes` sample (`NOTES_SAMPLE_FILES`: core, headless,
renderer, API handlers, event consumer, repository, feature/event schemas and their tests) and overlays
`templates/minimal/service`: a product needs at least one element, so it ships one placeholder Mode C element
`status` (`GET /v1/status`, a `greeting` config feature), no database requirement and no events. The project passes
`ss app validate` and its own Vitest suite (with the coverage thresholds). The full template's README explains how to
remove the sample by hand.

## Testing

```sh
pnpm check   # in this folder: format, lint, typecheck, vitest with coverage (from the root: pnpm --filter @ss/cli check)
```

`src/bin.js` (process wiring only) is excluded with a `/* v8 ignore start/stop */` block; everything else is tested
through `main()` with injected io. `test/init.test.js` generates every template and runs its own test suite.
