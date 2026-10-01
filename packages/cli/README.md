# @ss/cli (`ss`)

Developer tooling for SSPS v1 products (PLAN Part E §14, F.7). JavaScript ESM, functional, no dependencies beyond the
`@ss/*` core packages (the emulator's in-memory client database uses the workspace dev dependency
`mongodb-memory-server`, loaded lazily).

| Command                                                                                                           | What it does                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ss app init <dir> --kind service\|pack --slug <slug> --name <name>`                                              | generates a project from `templates/shared` + `templates/<kind>`                                                                                                                                                              |
| `ss app validate [dir] [--json]`                                                                                  | manifest (local `$ref`s bundled) schema + semantics, anatomy, module refs/exports, import direction, DOM-free cores, no colour literals in `ui/`, string keys/placeholders, OpenAPI coverage, package wiring, budget estimate |
| `ss dev`                                                                                                          | local Portal emulator: JWKS, `/v1/product/*`, website keys, fixtures from `ss.dev.json`, admin API for the subcommands below                                                                                                  |
| `ss dev env \| register \| launch \| keys \| emit \| entitlements \| subscription \| resource \| settle \| state` | dev values, registration handshake, launch URLs (all kinds), pk_/sk_ keys, signed event injection, entitlement switches, hourly settlement simulation                                                                         |
| `ss certify [dir] --url <product>`                                                                                | certification suite against a running product (pass/fail table + `ss-certify-report.json`)                                                                                                                                    |

Exit codes: `0` ok, `1` failed validation/certification or command error, `2` usage error.

## Portal product API (emulated)

Exactly the wire formats of PLAN.md F.9 (client assertion, `aud` = the Portal URL): entitlements `{ document }`,
revocations `{ keyIds, cursor }`, usage `{ records }` + `Idempotency-Key` → `{ results }`, launch consume `{ consumed }`,
events `{ events: [...] }`, resources `{ kind, descriptor: { uri, dbName }, expiresAt }`, heartbeat, keys/rotate.
Portal → product calls are signed with `@ss/protocol` `signRequest`; admin changes are delivered as control events
(`entitlement.changed@1`, `key.revoked@1`, `resource.changed@1`, `subscription.*@1`).

## Testing

```sh
pnpm vitest run packages/cli --coverage --coverage.include='packages/cli/src/**'
```

`src/bin.js` (process wiring only) is excluded with a `/* v8 ignore start/stop */` block; everything else is tested
through `main()` with injected io. `test/helpers/fake-product.js` is a minimal product built on `@ss/protocol`; the
certification tests run the suite against it and against deliberately broken variants.
`test/product-e2e.test.js` generates a service product, links `@ss/*` to the workspace packages, serves it with the
template's `serve.js` and requires every certification check to pass against the real `@ss/app-kit`.
