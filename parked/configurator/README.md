# Configurator Builder (`configurator`)

SSPS v1 service product: an option / variant configurator for anything configurable — clothing sizes and colours,
phone storage and colour, furniture, service packages or a SaaS plan builder. Shoppers always land on a **valid,
priced** combination. Ported from the ibrahimMobiles PDP variant selector (attribute pools, closest-match
resolution, URL sync of the selection) and made generic: nothing in it is store-, country-, currency- or
language-specific.

All data (configurators, catalog snapshots) lives in the **merchant's own database** (`data.forWebsite`, collections
`ss_configurator_*`); the product stores no personal data.

## Elements and pricing

Hourly prices are millicredits per hour (price book `2026-10-01`).

| Element        | What                                                                                     | Modes   | Price                                                        |
| -------------- | ---------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------ |
| `schema`       | option groups, required/defaults, rules@1 dependencies and exclusions, combinations      | C       | 100 / h                                                      |
| `resolver`     | pure closest-match resolution: changed pick wins, stock prefer / require / ignore        | B       | 150 / h                                                      |
| `price_deltas` | base / combination price, option deltas, unit prices, rules@1 delta rules, rounding      | B, C    | 100 / h                                                      |
| `url_sync`     | selection ↔ query parameters, names, prefix, defaults, history, canonical                | B, C    | 0                                                            |
| `widget`       | drop-in selector: pills, dropdowns, swatches; ARIA radio groups, keyboard, visible focus | A, B, C | 150 / h                                                      |
| `api`          | `POST /v1/evaluations`: resolve + price + URL in one call (pk\_ and sk\_)                | C       | 50 / h + 1 per 100 evaluations (starter 10 000 / h included) |

Plans: **starter** (schema, resolver, url_sync, widget, api; price_deltas as an add-on) and **pro** (everything,
larger limits, 100 000 evaluations / h included). Every setting is a feature in `schemas/<element>.features.json`.

## API (Mode C, `openapi.json`)

| Route                                                | Key       | Element      |
| ---------------------------------------------------- | --------- | ------------ |
| `GET/POST /v1/configurators`, `POST :check`          | sk        | schema       |
| `GET/PATCH/DELETE /v1/configurators/:id` (id or key) | pk\* / sk | schema       |
| `GET /v1/catalog-items[/:itemId]`                    | sk        | schema       |
| `POST /v1/evaluations`                               | pk / sk   | api          |
| `POST /v1/quotes`                                    | pk / sk   | price_deltas |
| `POST /v1/url-params:build`, `:parse`                | pk / sk   | url_sync     |
| `GET /v1/widgets/:configurator?search=`              | pk / sk   | widget       |
| `/v1/dashboard/*` (SSO session)                      | session   | schema       |

\* browser keys read only published configurators, as a concrete public view (stock as in / out of stock).

## Events

- **Publishes** `configurator.published@1` (`schemas/events/`) when a configurator is published or republished.
- **Consumes** `item.created@1`, `item.updated@1`, `item.deleted@1` and `inventory.changed@1` (optional catalog link,
  feature `schema.catalog_link`): snapshots and stock figures are stored in the merchant's database; only events from
  the merchant's servers are trusted (customer / anonymous actors and `pk_` site events are ignored); older figures
  never overwrite newer ones; app-kit dedupes on the event id.

## Layout

```
core/       pure: schema.js (validate + normalise), compile.js, resolve.js (the resolver), pricing.js, catalog.js,
            urlSync.js, rules.js (rules@1), validate.js, views.js, money.js, config.js, limits.js
headless/   configurator.js (widget, Mode B over the API), resolver.js (local resolver), priceDeltas.js, urlSync.js
ui/         configurator.js (Mode A renderer + `update` keeping focus), token-only styles
api/        routes.js, service.js, events.js, settings.js, dashboard.js, samples.js, session.js
adapters/   platform.js (app-kit product), db.js (repositories, indexes)
app/        Next.js wiring and the merchant dashboard (overview, editor, live preview, catalog link, rules, settings)
```

## Environment

`MONGODB_URI` and `CONNECT_SECRET` (see `.env.example`): the product's own control database and the connect secret.
The Portal connection (made from Portal → Admin → Apps → Add product), the product's signing key and its generated secrets live there. No crons.

## Commands

```bash
pnpm --filter @ss/product-configurator check      # format, lint, typecheck, tests with coverage
pnpm --filter @ss/product-configurator validate   # ss app validate
pnpm --filter @ss/product-configurator build      # next build
```

The resolver's guarantees are proven by property tests (`tests/resolver.property.test.js`, fast-check) against a
brute-force oracle: always a valid combination or a clear problem only when none exists, the closest one, in stock
whenever an equally close one is, deterministic. See `docs/guide.md` for the schema reference.
