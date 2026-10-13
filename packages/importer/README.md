# @ss/importer (`ss-import`)

The read side of the store conversion (PLAN.md 0.8.10, Migration and importers). A command-line tool, **never
deployed**, that moves a store's records into the products:

1. `ss-import read` reads a store database **read only** (MongoDB `find`, a secondary preferred) and writes, to a local
   folder, one NDJSON file per target (a product's import collection: the records of every step into it, merged,
   oldest first), `idmap.json` (every source document → the key of the record it became; merged documents point at
   the record they joined), `settings.json` (the website's settings, when the mapping reads them) and `manifest.json`
   (what was read, in import order, with the verification sums).
2. `ss-import send` first writes the settings and lists (`settings.json`, then the per-store settings table given with
   `--settings <file>`) through each product's settings API (K1: `PUT /v1/format`, `/v1/settings/<feature>.<key>`,
   `/v1/lists/<list>`; every value explicitly, RT-15; a 429 waits and tries again), then posts the files to each
   product's import routes with the website's server token (`POST /v1/import/<collection>`, `?dryRun=1` first), cut
   into calls of at most 1,000 records and 4 MB (`@ss/contracts` `IMPORT_LIMITS`). In a real run each product's
   `POST /v1/import/finish` (derived values) follows its last file, so the products finish in import order (Accounts,
   then Ecommerce's catalog and orders, Chat, Growth); a finish that works in batches (Chat: 100 conversations a call)
   answers `more` with `next`, and `send` calls it again with `?after=<next>` until it is done. A dry run writes
   nothing and lists every refused record (file and line), every refused setting and the settings that would change
   (from what, and where the current value comes from). With `--prune` (the final pass, IMP-22) each target also sends
   the keys of all its records, sorted and cut into ranges of at most 1,000, to `POST /v1/import/<collection>/prune`:
   records an earlier import wrote that the store has deleted since are removed (only records an import wrote, never
   the merchant's own). `--only <product>.<collection>` sends some targets (pre-imports before the freeze). Re-runs are
   safe: the products find records by their keys and replace them.
3. `ss-import verify` compares the records read with `GET /v1/import/status` (records an import wrote), the mapping's
   count routes (K4), and the sums the steps added up (order totals per status, stock units, points balances …) with
   the product's verification totals.

The write side lives in each product: its `import` feature and the kit's import routes (PLAN 0.8.10 K10). Nothing
writes `ss_*` collections from outside, and nothing runs in the background.

```sh
SS_IMPORT_SOURCE_URI='mongodb+srv://…/store' ss-import read --mapping <name> --out ./import-out
SS_IMPORT_TOKEN_ECOMMERCE='…' ss-import send --dir ./import-out --product ecommerce=https://shop.example.com \
  --settings ./settings-table.json --dry-run
SS_IMPORT_TOKEN_ECOMMERCE='…' ss-import send --dir ./import-out --product ecommerce=https://shop.example.com \
  --settings ./settings-table.json --prune
SS_IMPORT_TOKEN_ECOMMERCE='…' ss-import verify --dir ./import-out --product ecommerce=https://shop.example.com
```

Secrets never go on the command line: the store database's address comes from `SS_IMPORT_SOURCE_URI` (or `--source`)
and each product's server token from `SS_IMPORT_TOKEN_<PRODUCT ID>`. The output folder holds store data: keep it out of
the repository (`import-out/` is ignored) and delete it after the cut-over.

## Mappings

A mapping (`defineMapping`) names, for one schema family of store databases, the steps in import order. Each step reads
one source collection into one product's import collection (a target); several steps may feed one target:

| Member       | Meaning                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `product`    | the product id (`accounts`, `ecommerce`, `chat`, `growth`, …)                                                            |
| `collection` | the product's import collection (`POST /v1/import/<collection>`)                                                         |
| `source`     | the source collection (read only), with an optional `filter`                                                             |
| `prefix`     | the id prefix; ids are `<prefix>_<the source ObjectId's 24 hex digits>`, so links map without a lookup                   |
| `key`        | optional: the fields the product finds the records by (default `['id']`; `['customerId']`, `['day', 'part']` …)          |
| `map`        | `(doc, ctx) → record \| record[] \| null`: the record (or records: one-to-many) in the product's own shape, with its key |
| `mergeKey`   | optional `(doc, record) → key`: records with the same key, across every step of the target, become one                   |
| `merge`      | optional `(kept, next, ctx) → record`: combines them (default: the oldest stays); the result may take `next`'s key       |
| `lookups`    | optional `{ table: (record, doc) → key(s) }`: later steps find the record with `ctx.lookup(table, key)` (slugs → ids)    |
| `sums`       | optional `(record) → { name: number }`: what the record adds to the product's verification totals                        |
| `countPath`  | optional: a count route of the product that `verify` also compares                                                       |

`ctx.id(prefix, sourceId)` gives a deterministic id, `ctx.ref(source, sourceId)` the key an earlier step gave a
document (merges followed). A mapping may also read the website's settings (`settings(db)` → `{ <product>: { format,
settings: { '<feature>.<key>': value }, lists } }`).

Store names appear only in mappings (PLAN 0.13). The store mapping comes with the cut-over of each store, when the owner
says so; until then the mappings are test mappings (`@ss/importer/fixture`), both imported by the e2e suite through the
real products (`e2e/tests/import.test.js`):

- **`fixture`**: a small store-like `feedback` collection (a duplicate that merges, a hidden document that is not read,
  an empty one that is left out) mapped into the e2e test product Notes.
- **`example-shop`** (`src/fixture/shop.js`): a neutral example shop as an older shop system kept it (ObjectIds,
  dollars, phones typed nationally, slugs instead of ids, a guest saved twice, loyalty transactions, chats with their
  messages inside, daily analytics) mapped into Accounts (a role, staff and a member with bcrypt hashes), Ecommerce (a
  size chart, categories, a brand, an attribute, products with variants, a deal, customers merged by phone, orders with
  payment entries by the status rule, a loyalty account rebuilt from its transactions, a review, a return, an alert and
  a wishlist), Chat (staff, the guest's old cookie as a hash, a conversation and its messages) and Growth (two days of
  totals), with the website's settings (order number prefix, currency, image base) and the verification sums.

A first dry run into an empty website checks each record on its own: a record that names records of an earlier file
(a category's size chart, a product's brand, a message's conversation) or that needs a setting the run writes first
(the order number's prefix) is listed as refused until the real run has written them; a dry run after the first real
run checks everything.

## Checks

`pnpm check` runs Prettier, ESLint, `tsc --checkJs --strict` and the tests with coverage (90 % lines and functions, 85 %
branches) on the shared in-memory MongoDB.
