# Catalog & PIM (`catalog`)

SSPS v1 **service product**: headless item data for any website — physical goods, services, digital products,
rentals or anything else. It follows the Product Standard (PLAN Part E): the manifest is the single source of truth,
business logic lives in `core/` (pure) and `headless/` (DOM-free), and `@ss/app-kit` implements the App Protocol
(registration, launches, website keys, entitlements with offline grace, events, usage, data guard).

All catalog data lives in the **merchant's own database** (`ss_catalog_*` collections through `data.forWebsite`); files
stay in the merchant's storage or the Files product. The product's control database holds only kit caches, queues and
the website ids the sweep job visits.

## Elements and pricing

Prices are millicredits per hour (1 credit = 1000).

| Element         | What                                                                                                 | Modes   | Price                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------- |
| `items`         | items with merchant-defined types, statuses, custom fields, translations, SEO, scheduled publishing  | A, B, C | 300 (limit `items.max_items`)                                  |
| `variants`      | variant matrix: dimensions, option pools, uniqueness, price / compare-at / private cost, SKU, stock  | A, B, C | 150                                                            |
| `attributes`    | attribute definitions, options with units, filters and facet counts, card position, collection scope | A, B, C | 100                                                            |
| `collections`   | collections tree: depth limit, order, marketing copy, SEO, visibility cascade                        | A, B, C | 100                                                            |
| `brands`        | brand registry with logos and collection scoping                                                     | A, B, C | 0                                                              |
| `media`         | images and videos by URL or storage key, size ladder (srcset), alt templates                         | A, B, C | 0                                                              |
| `media_uploads` | optional presigned uploads to the merchant's bucket (storage connector)                              | C       | 50                                                             |
| `import_export` | CSV export, template, import with mapping, dry-run diff and conflict policy                          | C       | 150                                                            |
| `feeds`         | tokened, cacheable shopping / marketing feeds from settings-driven mapping                           | C       | 150                                                            |
| `api`           | sk\_ server access (writes switch, cost exposure, read / write rates)                                | C       | 100 + metered `request` (1 per 100; 100 000 / 1 000 000 incl.) |

Plans: **starter** (items, variants, attributes, collections, brands, media, api; add-ons media_uploads, import_export,
feeds) and **pro** (everything, higher bounds).

## Events

- Publishes the standard `item.created@1`, `item.updated@1` (with `changed`), `item.deleted@1`, `inventory.changed@1`
  and `price.changed@1` (`@ss/contracts` schemas). Every change pushes its events onto the item document in the same
  atomic write (a transactional outbox), then publishes them through the kit's durable outbox; the sweep job
  republishes anything a crash left behind with the same idempotency keys. The private cost is never published.
- Consumes `order.placed@1` (takes stock once per order, or converts the order's stock reservation),
  `order.cancelled@1` (gives it back) and `order.refunded@1` (gives refunded lines back when
  `variants.restock_on_refund` is on).

## Keys

`pk_` keys read public data only — public items inside their publication window, visible collections and brands, public
custom fields, stock as a state (`in_stock`, `low_stock`, `sold_out`, `backorder`) unless `variants.show_quantity` —
with `Cache-Control: public`. They never see cost. `sk_` keys need the `api` element; every sk\_ request is metered.

## Layout

```
manifest.json, openapi.json, schemas/*.features.json, strings/en.json
core/       items, variants, attributes, collections, brands, media, fields, money, csv, importing, feeds, events, views, query
headless/   items, variants (option picker), filters, collections, brands, gallery — Mode B cores
ui/         default renderers of the six UI elements (Mode A)
adapters/   db (repositories + indexes), tokens (feed tokens, ids), registry, platform (environment → app-kit)
api/        routes, catalog (write pipeline + outbox), items, variants, taxonomy, media, transfer, feeds, dashboard, events
jobs/       sweep (GET /cron/sweep)
app/        Next.js wiring and the dashboard (overview, items, item detail with stock, import & export, feeds, settings)
```

## Environment

See `.env.example`: the app-kit variables plus `CATALOG_FEED_SECRET` (optional, feed-token HMAC secret) and
`CRON_SECRET` (the sweep cron, every 5 minutes in `vercel.json`).

## Commands

```bash
pnpm check      # format, lint, typecheck, tests with coverage (90/90/85)
pnpm validate   # ss app validate (0 warnings)
pnpm build      # next build
pnpm portal     # ss dev (Portal emulator) and, in another terminal, pnpm dev
```

## Notes and limits

- Smart (rule-based) collections, price lists per segment, multi-location stock and external-system connectors from
  PLAN Part D §6 are not in this version.
- `q` on `GET /v1/items` is word-prefix matching on title, SKUs and tags; ranking and typo tolerance belong to Site
  Search.
- SKUs unique across the catalog are checked before each write, not by a unique index (the rule is a setting).
