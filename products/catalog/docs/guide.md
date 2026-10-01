# Catalog & PIM — developer guide

## Three ways to use it

- **Mode A (drop-in):** the Loader mounts `ui/items.js` (`grid` / `list`), `ui/variants.js` (`buttons` / `selects`),
  `ui/filters.js` (`sidebar` / `bar`), `ui/collections.js` (`tree` / `cards`), `ui/brands.js` (`logos` / `list`) and
  `ui/gallery.js` (`gallery` / `strip`) with the website's design tokens (slots `before`, `after`, and `empty` for
  items). Without a UI bundle the Loader's element stub calls `GET /v1/elements/<element>/view?ctx=` (text-only view
  models; `itemId` from the page context for variants and media).
- **Mode B (headless):** `createItems`, `createVariantPicker`, `createFilters`, `createCollections`, `createBrands`,
  `createGallery` (`headless/*.js`) take `{ config, strings, client, emit }` with
  `createElementApi({ baseUrl, key: 'pk_…' })` from `@ss/web/element`. Connect filters to the listing with
  `items.actions.setFacets(filters.actions.selection())`. The variant picker always lands on a real variant: selecting a
  value with no exact match picks the closest purchasable one.
- **Mode C (API):** `openapi.json`. Browsers use `pk_` (public reads), your server `sk_` (everything; needs the `api`
  element).

## Modelling any catalog

Everything that differs between websites is a setting in the Portal:

- `items.item_types` — what you sell (`kind`: physical, digital, service, rental, other) and which custom fields each
  type uses; `items.custom_fields` — typed fields (text, number, date, select, …) validated on every write; public ones
  are returned to browsers.
- `items.statuses` — your statuses, each mapped to the standard `draft` / `active` / `archived` (what events carry)
  and marked public or not. `publishAt` / `unpublishAt` schedule visibility; the sweep job publishes `item.updated@1`
  (`changed: ["published"]`) when a window opens or closes.
- `items.currency` (or the website currency from the Portal; per item with `items.item_currency`). Prices are integer
  **minor units** in the API and events, major units ("12.50") in CSV files.
- `items.languages` — `translations: { de: { title, summary, description, seo } }`; read with `?lang=de`.

Variants: declare variant-option attributes (`variantOption: true`), set an item's dimensions with `options: ["size",
"color"]` and optionally restrict them per item with `optionPool`. `variants.uniqueness` decides whether option
combinations and / or SKUs must be unique within an item; `variants.unique_sku_across_items` across the catalog. A
single-variant item can be created with `price`, `sku`, `quantity` at item level.

## Stock

- `POST /v1/variants/{id}/stock { delta | quantity, expectedQuantity?, reason? }` adjusts stock.
- `POST /v1/stock-reservations { lines: [{ variantId | sku, quantity }], orderId? }` takes stock for a checkout: all
  lines or none (`insufficient_stock`). Send `order.placed@1` with the same `orderId` to convert it; otherwise it is
  released after `variants.reservation_ttl_minutes`.
- Without a reservation, `order.placed@1` takes the stock (lines matched by `variantId`, `sku`, or the single variant
  of `itemId`), once per order; `order.cancelled@1` gives it back. Overselling is recorded (negative stock).

## Listing (`GET /v1/items`)

Filters: `filter[collectionId]` (with sub-collections), `filter[brandId]`, `filter[brand]` (slugs), `filter[type]`,
`filter[tag]`, `filter[inStock]`, `filter[priceMin]` / `filter[priceMax]` (aliases `filter[price_min]` /
`filter[price_max]`), facets `filter[attr.<key>]=a,b` (or `filter[<key>]`), `q` (word prefixes of title, SKUs, tags).
Sorts: `newest`, `oldest`, `title`, `price_asc`, `price_desc`, `updated` (public: `items.sorts`). Pages: `cursor`
(default) or `page` (then `next` and `total`). `include=facets` adds facet counts and the price range; `include=total`
the count. Public items carry card fields `price`, `compareAtPrice` and `image`.

## Media

Reference media by `url` (https; `media.allowed_hosts`) or by `key` in your storage (served under
`media.storage_base_url`, or as short signed links when Media uploads is on). With Media uploads,
`POST /v1/media-uploads { contentType, contentLength }` returns a presigned `PUT`; upload, then
`POST /v1/media { itemId, key }`. `media.url_template` (`{url}?w={width}`) and `media.ladder` produce `srcset`.

## Import and export

`GET /v1/exports` (one row per variant, `import_export.columns`), `GET /v1/exports:template`. Import:
`POST /v1/imports { csv, mapping? }` is a dry run (diff per item, row errors, `versions`); apply with
`{ csv, dryRun: false, expectedVersions: <versions> }`. Items changed since the dry run follow `conflictPolicy`
(`skip`, `overwrite`, `fail`). Rows are grouped by `item_id` / `item_slug`; variant rows match by `variant_id` or
`sku`; blank cells leave values unchanged; `image_urls` adds media by URL.

## Feeds

Define feeds in `feeds.feeds` (`google_xml`, `csv`, `tsv`, `json`; optional collection / brand scope and field
`mapping` — sources are item fields, `attr.<key>`, `custom.<key>` (public fields), `option.<key>`, `{templates}` and
`=constants`; cost is not a source). `GET /v1/feeds` lists their tokened public URLs (`/feeds/<token>`); the bodies are
`Cache-Control: public` for `feeds.cache_seconds` with a strong ETag. Map your condition values (e.g. grades) with
`feeds.condition_source` and `feeds.condition_map`. Raise `feeds.token_version` to revoke every link.
