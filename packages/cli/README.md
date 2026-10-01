# @ss/cli (`ss`)

Developer tooling for SSPS v1 products (PLAN Part E §14, F.7). JavaScript ESM, functional, no dependencies beyond the
`@ss/*` core packages (the emulator's in-memory client database uses the workspace dev dependency
`mongodb-memory-server`, loaded lazily).

| Command                                                                                                                       | What it does                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ss app init <dir> --kind service\|pack --slug <slug> --name <name> [--minimal]`                                              | generates a project from `templates/shared` + `templates/<kind>`; `--minimal` (service only) leaves out the `notes` sample                                                                                                    |
| `ss app validate [dir] [--json]`                                                                                              | manifest (local `$ref`s bundled) schema + semantics, anatomy, module refs/exports, import direction, DOM-free cores, no colour literals in `ui/`, string keys/placeholders, OpenAPI coverage, package wiring, budget estimate |
| `ss dev`                                                                                                                      | local Portal emulator: JWKS, `/v1/product/*`, website keys, fixtures from `ss.dev.json`, admin API for the subcommands below                                                                                                  |
| `ss dev env \| register \| launch \| keys \| emit \| entitlements \| subscription \| resource \| identity \| settle \| state` | dev values, registration handshake, launch URLs (all kinds), pk_/sk_ keys, signed event injection, entitlement switches, identity-issuer approval, hourly settlement simulation                                               |
| `ss certify [dir] --url <product>`                                                                                            | certification suite against a running product (pass/fail table + `ss-certify-report.json`)                                                                                                                                    |

Exit codes: `0` ok, `1` failed validation/certification or command error, `2` usage error.

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
pnpm vitest run packages/cli --coverage --coverage.include='packages/cli/src/**'
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
renderer, API handlers, event consumer, repository, purge job, feature/event schemas and their tests) and overlays
`templates/minimal/service`: a product needs at least one element, so it ships one placeholder Mode C element
`status` (`GET /v1/status`, a `greeting` config feature, `x-ss-certify`), no database requirement, no events, and
`adapters/privacy.js` handlers that answer empty exports. The project passes `ss app validate`, its own
`node --test` suite and `ss certify` (POST replay, pagination and event delivery are skipped: nothing to exercise).
The full template's README explains how to remove the sample by hand. Every Next.js route file of the template
exports `OPTIONS` (CORS preflight reaches app-kit) and `_lib/product.js` passes Next's `after` to `toNextRoute`.

`test/product-e2e.test.js` generates a service product, links `@ss/*` to the workspace packages, serves it with the
template's `serve.js` and requires every certification check to pass against the real `@ss/app-kit` (and certifies a
`--minimal` project the same way).
