# Site Search — developer guide

Search for any website: products, articles, docs, listings, pages. The index lives in **your own database** (collections
`ss_search_*`). Every element (`index`, `sources`, `ranking`, `suggestions`, `overlay`, `analytics`) is switched on and
configured in the Portal.

## Engines

- **Atlas Search** — when your database is MongoDB Atlas, the product creates and manages the search index
  `ss_search_v1` on `ss_search_documents` and searches with `$search`. If your database user may not list or create
  search indexes, the dashboard (Overview → Search engine) says so and shows the exact index definition to create in
  Atlas → Search; grant `listSearchIndexes` / `createSearchIndexes` or create it yourself. The index state is checked
  when a search needs it (at most every 10 minutes) and when you press **Re-check** on the dashboard.
- **Portable** — on any MongoDB: an inverted index (the multikey `terms` index), prefix matching on the last word,
  typo tolerance with a bounded edit distance (1 typo from `typo_min_length`, 2 from `typo_two_edits_length`, never
  for numbers), synonyms, field boosts and a document boost. Candidates and results are capped.

`index.engine`: `auto` (Atlas when ready), `atlas` (prefer Atlas) or `portable`. The portable index is always kept up
to date, so the product falls back to it while Atlas is missing, building or failing. Both engines return the same
response.

## Document types

`index.document_types` defines your types and their fields: `searchable`, `prefix` (match as you type), `display`
(returned to browsers) and `private` (server keys only: never matched, suggested or returned with a `pk_` key).

## Search (Mode C)

```http
GET /v1/search?q=linen&limit=8&types=item,page&cursor=…
Authorization: Bearer pk_…        (browser, domain-locked, rate limited per website)
```

```json
{
	"query": "linen",
	"items": [
		{
			"id": "itm_1",
			"type": "item",
			"title": "Linen shirt",
			"description": "",
			"url": "/items/itm_1",
			"image": null,
			"price": 4900,
			"currency": "EUR",
			"fields": { "brand": "Acme" }
		}
	],
	"total": 1,
	"totalIsEstimate": false,
	"hasMore": false,
	"nextCursor": null,
	"engine": "atlas",
	"relaxed": false
}
```

Prices are integer minor units. `relaxed: true` means nothing matched every word, so documents matching some are
shown (`ranking.match_mode` = `all_then_any`). `track=0` keeps a search out of the analytics. Every search is metered
(unit `query`).

**Storefront Blocks** (`search_overlay` with `api_path: /v1/search`) works as is: it sends `q` and `limit` with the
website's `pk_` key and reads `items` (`id`, `title`, `url`, `image`, `price`, `currency`). Field differences from its
assumed contract: there is no `results` alias (Storefront accepts `items`), and `brand`/other display fields are under
`fields` (map them in Storefront's field map, e.g. `brand: "fields.brand"`).

## Filling the index

- **Catalog**: with `sources.catalog_events` on, `item.created@1` / `item.updated@1` / `item.deleted@1` index active
  items as `sources.catalog_type` documents (title, brand, SKUs, attributes, lowest price); the page URL comes from
  `sources.catalog_url_template` (`/items/{itemId}`). Cost is never indexed.
- **Crawls**: `sources.crawl_sources` — a JSON feed (records mapped with field paths `a.b|c`) or a sitemap / sitemap
  index of **your own domain** (https only). A crawl fetches `pages_per_run` pages per step through the SSRF-guarded
  client with a timeout and a size cap; pages with `robots: noindex` are skipped; documents a finished run did not see
  are removed. Nothing runs on a schedule: crawls run when you press **Crawl now** (one source) or **Crawl due
  sources** (every source never crawled, in progress, or whose `every_hours` passed) on the dashboard's Sources page,
  or when your server calls `POST /v1/sources/{key}/crawl` (sk_). One press crawls step after step for up to 10
  seconds; a large sitemap that needs longer is continued by the next press. When a Catalog item event arrives for an
  item whose page (from `sources.catalog_url_template`) a sitemap source indexed, that page is fetched again right
  away (and removed when the item is deleted or the page is gone).
- **API**: `POST /v1/documents` (create or replace; `id` optional), `POST /v1/documents:batch` (≤ 100),
  `DELETE /v1/documents/{id}`, `GET /v1/documents` — `sk_` only, with `sources.api_upserts`.

```js
await fetch('https://search.example.com/v1/documents', {
	method: 'POST',
	headers: { authorization: `Bearer ${SK}`, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
	body: JSON.stringify({ id: 'kb-42', type: 'page', url: '/help/returns', fields: { title: 'Returns', body: '…' } }),
});
```

## Suggestions and the overlay

`GET /v1/suggestions?q=` → `{ popular, completions, recent }`. Popular queries appear only after
`suggestions.popular_min_count` searches. The visitor's own recent searches stay in their browser.

Drop-in (Mode A): place the `overlay` element (variants `modal`, `inline`). Your own UI (Mode B):

```js
import { createOverlay } from '@ss/product-search/headless/overlay.js';

const overlay = createOverlay({ config, strings, client, storage });
overlay.subscribe((state) => draw(state)); // state.options, state.active, state.message, state.href
overlay.actions.setQuery(input.value); // debounced
overlay.actions.move(1); // arrow keys
const next = await overlay.actions.submit(); // { href } to follow or a query that ran
```

## Analytics

`GET /v1/search-analytics?days=30` (sk_): totals, daily counts, top queries and zero-result queries. Only daily counts
per normalised query are stored; queries that look like e-mail addresses, phone or card numbers or links are never
counted. Clicks: `POST /v1/search-clicks { q, id }`.
