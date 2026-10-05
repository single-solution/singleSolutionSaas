# Site Search (`search`)

SSPS v1 service product: a search index in the merchant's own database, served by MongoDB Atlas Search when the
database supports it (product-managed index) or by a portable engine, filled from Catalog events, crawls and the API.
Guide for website developers: [docs/guide.md](docs/guide.md). API: [openapi.json](openapi.json).

## Elements and pricing (millicredits per hour)

| Element       | Modes | Hourly | What it does                                                                                     |
| ------------- | ----- | ------ | ------------------------------------------------------------------------------------------------ |
| `index`       | C     | 200    | documents of merchant-defined types; search (`pk_`/`sk_`); limit + daily indexing quota; metered |
| `sources`     | C     | 100    | Catalog `item.*@1` events, scheduled JSON / sitemap crawls, `sk_` document upserts               |
| `ranking`     | C     | 50     | field boosts, synonyms, typo tolerance, prefix, match mode, document boost, pinned results       |
| `suggestions` | B, C  | 50     | popular queries (minimum count), completions, recent documents, browser-only history             |
| `overlay`     | A, B  | 100    | ARIA combobox search dialog / inline box, keyboard, debounced, theme tokens only                 |
| `analytics`   | C     | 50     | aggregated daily query counts, zero results, clicks — no personal data                           |

Metered: `query` — 1 millicredit per 100 searches; 50 000 a month included in Starter, 500 000 in Pro. Starter has
every element but analytics (add-on); Pro has all, with higher bounds.

## Layout

- `core/` — text analysis, document types, indexing, query planning, the portable engine's scoring, the Atlas
  `$search` builder, results, analytics, sources, catalog mapping, suggestions (pure).
- `adapters/` — repositories over `data.forWebsite` (`db.js`), Atlas Search driver access (`atlas.js`), platform.
- `api/` — services (documents, engines, search, sources, dashboard) and the route table.
- `headless/` — `createOverlay`, `createSuggestions`. `ui/` — the overlay renderer.
- `jobs/sweep.js` — `GET /cron/sweep` (crawl steps, Atlas state, vocabulary cleanup).

## Environment

See `.env.example`: the app-kit variables and `CRON_SECRET` (≥ 16 characters) for the sweep.

## Notes

- **Atlas access (GAP):** app-kit's guarded collection refuses pipelines that do not start with `$match`, and has no
  search-index management. `adapters/atlas.js` reaches the driver collection behind the guarded one and enforces the
  tenant rule itself (`websiteId` inside `$search` and in the following `$match`, checked before every run).
- Tests: `pnpm check` (Vitest on the in-memory MongoDB). Atlas Search does not run there: its builder is tested as pure
  functions and the shared engine suite runs the real pipelines through a small `$search` simulator
  (`tests/atlas-sim.js`).
