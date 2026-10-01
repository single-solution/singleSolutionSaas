# Product Detail Page (`pdp`) — element pack

SSPS v1 **element pack** (PLAN Part D §9, Appendix A.4): composable detail-page blocks for any website — a shop, a
marketplace listing, a course, a property, a service. Front-end only: no server, no database, no API of its own. The
Portal compiles the enabled elements into each website's Loader bundle; developers can drive the same headless cores
from their own UI (Mode B).

The pack never needs our Catalog product: every element reads the item **from the page itself** (`data-ss-item-*`
attributes, `<meta>` tags, an inline JSON blob — the stub v2 page context) or from **a public JSON source** the
merchant configures. See [docs/guide.md](docs/guide.md) for the page contract and every option.

## Elements

| Element              | What                                                                                                | Price (millicredits/h) | `budget.js` |
| -------------------- | --------------------------------------------------------------------------------------------------- | ---------------------: | ----------: |
| `gallery`            | images and videos: carousel / grid / stacked, thumbnails, zoom, keyboard, swipe, alt-text templates |                    100 |       18 KB |
| `price_block`        | price, compare-at price, savings, availability, taxes/financing copy, per-variant updates           |                      0 |       11 KB |
| `structured_data`    | schema.org `Product` + `Offer` JSON-LD, field and condition mapping, optional `item.viewed@1`       |                      0 |        9 KB |
| `configurator_embed` | hosts the Configurator product's `widget` when it is active                                         |                      0 |        2 KB |
| `deal_pill`          | hosts the Deal System's `badges` when it is active                                                  |                      0 |        2 KB |
| `grade_showcase`     | hosts the Grade System's `showcase` when it is active                                               |                      0 |        2 KB |
| `reviews_block`      | hosts the Reviews product's `display` when it is active                                             |                      0 |        2 KB |
| `alerts_block`       | hosts the Alerts product's `capture` when it is active                                              |                      0 |        2 KB |
| `related`            | related items rail / grid (as given, same brand, same category), page data or a JSON list           |                    100 |       11 KB |
| `faq`                | per-item and manual questions with `FAQPage` JSON-LD                                                |                    100 |       11 KB |
| `sticky_buy_bar`     | mobile CTA bar by rule; presses the page's own buy button                                           |                    100 |       13 KB |
| `share`              | share sheet, copy link, network share links (UTM optional)                                          |                      0 |       12 KB |
| `hosted_page`        | a composed detail page on a sub-path with metadata and slots for the other elements                 |                    300 |       13 KB |

Plan `standard`: `gallery`, `price_block`, `structured_data` on; every other element is an add-on. Trial: 48 h.

`budget.js` is what `ss app validate` estimates from the renderer's source closure (unminified). What a browser really
downloads is far less: the pack build bundles the modules with code splitting, so each element's entry is 0.5–3 KB
gzip and the shared core (~9 KB gzip) loads once per page for all elements (`tests/pack.test.js` asserts both).

## Layout

| Path            | Purpose                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| `manifest.json` | SSPS manifest (kind `pack`, modes A/B, `events.publish:item.viewed@1` scope)                                       |
| `core/`         | pure rules: item model, page-snapshot parsing, money/alt text, JSON-LD, routes, related, share, sticky             |
| `headless/`     | Mode B cores: `createGallery`, `createPriceBlock`, … → `{ state, actions, subscribe, validate, strings, destroy }` |
| `ui/`           | Mode A renderers `render({ state, actions, strings, dom })` (+ `update` keeping focus), token-only `styles`        |
| `schemas/`      | one feature schema per element (flag / limit / config, plan bounds, placement defaults)                            |
| `strings/`      | one catalog per element (`<key>.en.json`, the delivered copy) and their union `en.json`                            |
| `pack.js`       | the pack build: manifest with features inlined, esbuild bundle (entries + shared chunks), descriptor               |
| `tests/`        | Vitest + jsdom: core, headless, renderers, the real `@ss/web` Loader, pack/budgets, certification                  |

## Commands

```sh
pnpm check       # format, lint, typecheck, tests with coverage (thresholds 90/90/85)
pnpm validate    # ss app validate (0 errors, 0 warnings)
pnpm certify     # ss certify (static pack certification)
pnpm build       # node pack.js → dist/: every asset + descriptor.json (unsigned)
```

## Publishing

`pnpm build` writes the assets and the unsigned `ss-pack-bundle@1` descriptor. Sign the descriptor with the developer
key (`@ss/protocol` `signBundle`), `POST /v1/admin/packs` `{ descriptor, signature, publicJwk }` (first upload pins the
key), then `PUT /v1/admin/packs/<appId>/versions/<n>/assets/<path>` for every asset and activate the app. The system
test `e2e/tests/pdp-portal.test.js` does exactly this against the real Portal and checks the compiled website bundle.

## Events

- Element UI events through the Loader (`<key>.<verb>@1`): `gallery.image_changed`, `gallery.zoom_opened`,
  `price_block.variant_applied`, `related.clicked`, `faq.opened`, `sticky_buy_bar.clicked`, `sticky_buy_bar.dismissed`,
  `share.shared`, `<embed>.embedded`, `<key>.source_failed`, plus the Loader's `<key>.shown@1`.
- Standard `item.viewed@1` (opt-in, `structured_data.track_item_viewed`) through the Loader's public `SS.track`.
- Packs have no event endpoint, so they consume nothing from the Event Hub; variant changes arrive in the browser
  through `SS.on(<update_event>)`.
