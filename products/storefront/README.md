# Storefront Blocks (`storefront`)

An SSPS v1 **element pack** (PLAN Part D §10, Appendix A.5, Part E): listing and layout blocks for any website — a
shop, an app's marketing site, a services or a content site. There is no backend: the Portal stores the pack's signed
browser modules and the Loader mounts them on the merchant's pages (Mode A); developers can build their own UI on the
same headless cores (Mode B). No data is stored anywhere by the pack.

Ported and generalised from the ibrahimMobiles storefront (`apps/web`): product cards with rotating attribute chips
and the shared staggered ticker, the listing grid with crawlable pagination, URL-synced filters with disjunctive
counts, the hero with its image/video policy (no background video on Save-Data or slow connections, poster instead),
the trending band, category and brand cards, the notice bar, the mobile tab bar and the footer. Nothing about a store,
country, currency, language or category is assumed: data comes through a field map, money is integer minor units
formatted with `Intl`, copy comes from the string catalog and content from configuration.

## Elements

Every element is switchable and priced (millicredits per hour); every setting is a feature with a default and plan
bounds in `schemas/<element>.features.json`, including a `placement` feature (the shared placement v1: paths,
selectors, devices, schedule, frequency and dismiss memory, audience).

| Element          | Price /h | Budget (KB) | What it does                                                                                                                                                         |
| ---------------- | -------: | ----------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grid`           |      200 |           4 | Item listing driven by the URL query; real `<a href="?page=N">` links (rel prev/next), enhanced to infinite scroll or "load more"; sort; live result count           |
| `cards`          |      100 |           1 | A section of item cards (collection, order, count) with rotating attribute chips, badges, sold-out and compare-at prices; grid or rail                               |
| `filters`        |      150 |           4 | Facets (values, range, toggle; single or multi) with disjunctive counts, price range in the currency's own digits, active chips; sidebar, sheet (modal) or top bar   |
| `search_overlay` |        0 |           4 | Search dialog: `/` hotkey, combobox + listbox, arrow keys, Enter to the active result or the website's results page; Site Search, Catalog or local data              |
| `hero`           |      100 |           3 | Headline and calls to action (strings, per language), LCP image (mobile source, high priority), background video only when allowed, pause button; reserved height    |
| `trending_band`  |      100 |           1 | Trending or featured items (rank, featured flag, newest, manual ids): a card strip or a slow marquee of names (static with reduced motion)                           |
| `category_cards` |        0 |           1 | Navigation cards to categories (configured, JSON file or page data)                                                                                                  |
| `brand_cards`    |        0 |           1 | Navigation cards to brands with logos                                                                                                                                |
| `deals_page`     |        0 |           3 | Live deals with badge, time left and item previews from the Deals product's public `GET /v1/deals-page` (or a JSON file / page data); "load more" over its cursor    |
| `notice_bar`     |        0 |           1 | Dismissible announcement; schedule, audience and dismiss memory through the placement (`frequency.dismissMemory`, default 7 days)                                    |
| `mobile_tab_bar` |        0 |           1 | Bottom navigation below 768 px: icons, translatable labels, `aria-current`, safe-area aware, keeps room at the end of the page                                       |
| `contact_footer` |        0 |           1 | Contacts (phone and WhatsApp links for any numbering plan, e-mail, address), opening hours, social and policy links                                                  |
| `theme`          |        0 |           2 | Design tokens, fonts and motion as `--ss-*` CSS custom properties (CSSOM, CSP-safe) plus a web font; `themeCss()` gives the same `:root{…}` rule for server inlining |

Budgets are honest (F.18): `ss pack build` bundles the modules as minified ES modules with shared chunks, and each
`budget.js` is the gzip size of the element's own entry modules, measured exactly as the Portal measures it
(`@ss/contracts/budget`); the code the elements share (cards, listing, sources, the DOM helpers) is declared once as
`budget.shared` (21 KB) and counted once per website. `ss app validate` warns when an element outgrows or pads its
budget, and `tests/pack.test.js` checks the build. Plans: **starter** switches on theme, grid, cards, notice bar and contact footer (300 mc/h), with filters,
search, category/brand cards, tab bar and deals page as add-ons; **pro** switches on theme, grid, filters, hero and
notice bar (450 mc/h) with every other block as an add-on. The default sets, with the shared chunks, fit the Portal's 60 KB website
budget next to the Loader (≈ 15 KB); enabling more is up to the merchant, and the Portal refuses a compile that would exceed
the budget (the live bundle stays).

## Data sources

Data never needs the Catalog product. Per element (`source`):

- `page` — the website embeds its items: `<script type="application/json" id="ss-items">[…]</script>` (id configurable).
- `json` — a public JSON file (`source_url`, https or a path on the site): an array or `{ items | data | results }`.
- `api` — a Single Solution product's public read API: Catalog `GET /v1/items`, Site Search `GET /v1/search`, Deals
  `GET /v1/deals-page`. The manifest declares them (`reads: catalog, search, deals`, F.18); the Loader passes each
  element an API client per product that is active on the website, bound to its base URL and the website's `pk_` key,
  so no URL or key is configured (`source_product` picks another of the three). A developer building their own UI
  passes `clients: { catalog: createElementApi({ baseUrl, key }) }` (`@ss/web/element`). Catalog's own shape is mapped
  as it is: `brand { id, slug, name }`, `collectionIds`, variant `options`, `availability` / `purchasable`, `nextCursor`
  in cursor mode, and no badges or rank (a rank strategy keeps the API's `sort=trending` order).

The field map (`fields`) maps any JSON to the item model with `|` alternatives and dotted paths; the defaults read
common names and the `@ss/contracts` item snapshot (`itemId`, variants with `price` and `inventory`). Requests send no
cookies, time out after 8 s and refuse bodies over 2 MB; at most 2 000 items per source.

## SEO and accessibility

- The grid always renders crawlable page links; every page and every filter combination is a plain URL
  (`?brand=a,b&min=1000&sort=price_asc&page=2`; `param_prefix` for two listings on one page). Filters and grid stay in
  step through the URL only (`popstate` and an `ss:query` event), never by talking to each other.
- Landmarks and labels on every root (region, navigation, search, contentinfo), keyboard operation everywhere, focus
  kept across re-renders, modal sheet and search dialog with Escape and a Tab trap, focus moved to the first new card
  after "load more", live regions for counts and errors, 44 px targets, reserved space (aspect ratios, hero heights).
- Reduced motion: no chip cycling, no marquee, no background video, zero-length transitions (`theme`).
- Text is always a text node; links and media URLs are checked in `core/` (no `javascript:`/`data:`, no protocol-relative).

## Layout

```
manifest.json, schemas/      elements, prices, budgets, plans; feature schemas (generated forms in the Portal)
strings/<lang>.json          the catalogs (en first); the Portal slices each element's keys (`stringKeys`) per language
core/                        pure: items + field map, query/URL + facets, cards + chips, media policy, theme, nav, deals
headless/                    Mode B cores: createGrid, createFilters, … → state, actions, subscribe, validate, strings, destroy
ui/                          Mode A renderers: render({ state, actions, strings, dom, slots, reducedMotion }) + styles (tokens only)
ui/entries/                  renderer entries that rename an element's stylesheet export to `styles`
pack.js                      `ss pack build` of this folder: inline manifest, built assets (sha256, size), descriptor
tests/                       Vitest: core, headless, renderers in jsdom, the built modules, ss certify
```

```sh
pnpm build        # ss pack build: minified modules + shared chunks + catalogs + descriptor.json in dist/pack
pnpm check        # format, lint, typecheck, tests with coverage (90/90/85)
pnpm validate     # ss app validate (0 problems)
pnpm certify      # static certification for packs
```

Publishing: `pnpm publish:pack -- --portal <url> --token <sst_…> --key @dev-key.json` (`ss pack publish`) builds,
signs the `ss-pack-bundle@1` descriptor with the developer key and uploads it and every asset to the Portal admin pack
API with a staff API token; the system test `e2e/tests/storefront-portal.test.js` does the same against the real
Portal.

## Events

UI events only, through the Loader (`<element>.<verb>`): `<element>.action@1` (catalogued `{ action }`: `load_more`,
`filter`, `price`, `clear`, `result`, `search`, `cta`, `secondary_cta`, `tab_<key>`) and `notice_bar.dismissed` (starts
the placement's dismiss memory), plus the Loader's own `<element>.shown@1`. A pack has no backend, so it consumes no
events and publishes no domain events.
