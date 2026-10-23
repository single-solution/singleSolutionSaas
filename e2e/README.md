# System tests (`@ss/e2e`)

Tests that need two or more deployables: each product against the **real** Portal, in process, on one
MongoMemoryReplSet. They use only public entry points (`@ss/platform/testing`, `@ss/app-kit`, `@ss/app-kit/testing`,
`@ss/protocol`, `@ss/contracts`, `@ss/importer` and `@ss/importer/fixture`, each product's `./product` and `./routes`,
and the widget entries `@ss/product-accounts/widget` and `@ss/product-growth/page-script`). This workspace is private,
never deployed and has no environment variables.

`tests/helpers.js` (`startSystem({ unit })`) starts the Portal with its real modules and a product on the real kit, each
on its own database, wired through one in-process fetch router; one clock drives both.

`fixtures/notes` is the test product exactly as `ss app init --id notes --name Notes --base-url https://notes.test`
writes it, plus a test-only `import` feature (its routes, settings, record check, guide and build texts, its
`recommendFor` tag and API description). It is used by the contract tests (connect, tokens, reports, statuses,
tickets, dashboard launches with password step-up, Install/reveal ceremony, the full plug-in path
(`plug-in-path.test.js`: connect → place → launch → blueprint), notices, websites and data rights). It is not a
workspace package: its `package.json` is the generated one, and this workspace checks it.
`pnpm check` here formats and lints it, type-checks its `core/`, `server/`, `adapters/`, `ui/` and `tests/`, runs its
own tests with the system tests, and runs `ss app validate` on it (which includes `ss app assets --check`). Its
dashboard (`app/`) is linted but not type-checked here (Next.js is not a dependency of this workspace), as the CLI does
for its product template. `tests/notes-fixture.test.js` runs the real `ss app init` and fails when the two differ by
anything but the import feature: after a change to the CLI's template, apply the same change here and run
`pnpm exec ss app assets fixtures/notes`.

The product tests (`accounts`, `chat`, `ecommerce`, `growth`, `notifications`, `payments`) run each shipped product
against the Portal and the products it works with.

The migration kit (PLAN 0.8.10) has its own tests: `settings-api` (a settings round trip per product through
the server token, with an acting user), `server-calls` (visitor calls from the merchant's server in their own rate
window, counts equal to list lengths) and `import` (`ss-import` of the importer's small fixture into Notes, whose
test-only `import` feature mounts the kit's import routes, and of the example shop into Accounts, Ecommerce, Chat and
Growth: dry run, real run, verify, the products' own reads, a re-run that changes nothing, and a prune); the product tests add a staff name on an order move and on
a chat reply, counts of the main lists and kit events forwarded by Notifications. Feature tests go further for some
products, for example `accounts-sign-in` (imported password hashes, phone and password, staff sign-in codes, role
requests and guards) and `growth-options` (every Growth option of 0.8.10 set through the settings API, then the real
page script in jsdom).

```sh
pnpm --filter @ss/e2e check   # from the root; or `pnpm check` in this folder
```
