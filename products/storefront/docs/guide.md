# Storefront Blocks — developer guide

## Drop-in (Mode A)

Subscribe the website in the Portal and switch on the blocks you want. The Loader mounts each block where its
`placement` says; the defaults look for a slot element, so add one where a block should appear:

```html
<div data-ss-slot="filters"></div>
<div data-ss-slot="grid"></div>
<script type="application/json" id="ss-items">
	[{ "id": "itm_1", "title": "Desk lamp", "url": "/items/desk-lamp", "price": 4500, "currency": "EUR", "brand": "Lumo" }]
</script>
```

Other slots: `cards`, `search`, `hero`, `trending`, `categories`, `brands`, `deals`, `footer`. The notice bar is
prepended to `<body>`, the tab bar appended (phones and tablets), the theme applied on load. Every placement field
(paths, selectors and position, page types, devices, schedule, frequency, audience) is editable per website.

Progressive enhancement: if your server already renders the first page of a listing with page links, point the grid's
placement at that container with `position: "replace"`; crawlers keep your HTML, visitors get the enhanced grid.

## Your own UI (Mode B)

```js
import { createGrid } from '@ss/product-storefront/headless/grid.js';

const grid = createGrid({ config: { page_size: 24, filter_keys: ['brand'] }, strings });
grid.subscribe((state) => draw(state)); // state.items (card view models), state.links (crawlable page links), …
await grid.actions.start({ search: location.search, data: myItems });
const next = await grid.actions.loadMore(); // next.value.search → history.replaceState
```

Every core has the same shape: `state()`, `actions` (resolve to `{ ok, value } | { ok: false, problem }`, never
throw), `subscribe`, `validate`, `strings`, `t`, `destroy`. `fetch` and `now` can be injected. `headless/format.js`
formats minor units (`formatMoney(4500, 'EUR', 'de-DE')`), `headless/theme.js` exports `themeCss(config)` for inlining
the tokens in your page head.

## Data contracts

Items (any shape, through `fields`): `id`, `title`, `url`, `image`, `price` and `compareAtPrice` in integer minor
units (or `{ amount, currency }`), `currency` (ISO 4217), `brand`, `badges`, `attributes` (`{ key: value | [values] }`),
`variants` (`[{ price, attributes, inventory }]`; chips cycle per variant), `collections`, `inStock`, `rank`,
`createdAt`.

Catalog list (assumed public read API, `pk_` key): `GET /v1/items?limit=&page=|cursor=&sort=&q=&filter[<facet>]=a,b&filter[price_min]=&filter[price_max]=`
→ `{ items, next | nextCursor, total?, facets?: [{ key, values: [{ value, count }], range?: { min, max } }] }`.
Site Search: `GET /v1/search?q=&limit=` → `{ items | results }`. Deals: `GET /v1/deals-page?limit=&cursor=` (Deals'
documented response).
