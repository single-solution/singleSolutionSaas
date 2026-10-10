# @ss/importer (`ss-import`)

The read side of the store conversion (PLAN.md 0.8.10, Migration and importers). A command-line tool, **never
deployed**, that moves a store's records into the products:

1. `ss-import read` reads a store database **read only** (MongoDB `find`, a secondary preferred) and writes, to a local
   folder, one NDJSON file per mapping step (records in the product's own shape, oldest first), `idmap.json` (every
   source document → the record id it became; merged documents point at the record they joined) and `manifest.json`
   (what was read, in import order).
2. `ss-import send` posts the files to each product's import routes with the website's server token
   (`POST /v1/import/<collection>`, `?dryRun=1` first), cut into calls of at most 1,000 records and 4 MB
   (`@ss/contracts` `IMPORT_LIMITS`), then `POST /v1/import/finish` (derived values) after a real run. Failed records
   are reported with their file line. Re-runs are safe: the products upsert by the given ids.
3. `ss-import verify` compares the records read with `GET /v1/import/status` and the mapping's count routes (K4).

The write side lives in each product: its `import` feature and the kit's import routes (PLAN 0.8.10 K10). Nothing
writes `ss_*` collections from outside, and nothing runs in the background.

```sh
SS_IMPORT_SOURCE_URI='mongodb+srv://…/store' ss-import read --mapping <name> --out ./import-out
SS_IMPORT_TOKEN_NOTES='…' ss-import send --dir ./import-out --product notes=https://notes.example.com --dry-run
SS_IMPORT_TOKEN_NOTES='…' ss-import send --dir ./import-out --product notes=https://notes.example.com
SS_IMPORT_TOKEN_NOTES='…' ss-import verify --dir ./import-out --product notes=https://notes.example.com
```

Secrets never go on the command line: the store database's address comes from `SS_IMPORT_SOURCE_URI` (or `--source`)
and each product's server token from `SS_IMPORT_TOKEN_<PRODUCT ID>`. The output folder holds store data: keep it out of
the repository (`import-out/` is ignored) and delete it after the cut-over.

## Mappings

A mapping (`defineMapping`) names, for one schema family of store databases, the steps in import order. Each step reads
one source collection into one product's import collection:

| Member       | Meaning                                                                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `product`    | the product id (`accounts`, `ecommerce`, `chat`, `growth`, …)                                                                                |
| `collection` | the product's import collection (`POST /v1/import/<collection>`)                                                                             |
| `source`     | the source collection (read only), with an optional `filter`                                                                                 |
| `prefix`     | the id prefix; ids are `<prefix>_<the source ObjectId's 24 hex digits>`, so links map without a lookup                                       |
| `mergeKey`   | optional: documents with the same key become one record (the oldest keeps its id; the others go to the map)                                  |
| `map`        | `(doc, { id, ref }) → record \| null`: the record in the product's own shape; `ref(source, id)` gives the id an earlier step gave a document |
| `countPath`  | optional: a count route of the product that `verify` also compares                                                                           |

Store names appear only in mappings (PLAN 0.13). Phase 5 adds the one mapping of the store schema family and the
cut-over steps; until then the only mapping is **`fixture`** (`@ss/importer/fixture`): a small store-like `feedback`
collection (a duplicate that merges, a hidden document that is not read, an empty one that is left out) mapped into the
e2e test product Notes. The e2e suite dry-runs it against the real kit (`e2e/tests/import.test.js`).

## Checks

`pnpm check` runs Prettier, ESLint, `tsc --checkJs --strict` and the tests with coverage (90 % lines and functions, 85 %
branches) on the shared in-memory MongoDB.
