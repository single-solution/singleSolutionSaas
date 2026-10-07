# Configurator Builder — developer guide

## 1. Define a configurator

`POST /v1/configurators` (server key; an optional `Idempotency-Key` makes a retry answer 409 `duplicate_request` instead of creating twice). Money is integer minor units of the currency.

```json
{
	"key": "classic-tee",
	"name": "Classic tee",
	"status": "published",
	"groups": [
		{
			"key": "color",
			"label": "Colour",
			"display": "swatches",
			"default": "navy",
			"options": [
				{ "key": "navy", "label": "Navy", "swatch": "#1f2a44" },
				{ "key": "sand", "label": "Sand" }
			]
		},
		{ "key": "size", "label": "Size", "options": [{ "key": "S" }, { "key": "M" }, { "key": "XL", "priceDelta": 200 }] },
		{
			"key": "gift",
			"type": "multi",
			"required": false,
			"options": [
				{ "key": "wrap", "priceDelta": 300 },
				{ "key": "card", "when": "selection.size != 'S'" }
			]
		}
	],
	"rules": [
		{ "id": "no-sand-xl", "when": "selection.color == 'sand' and selection.size == 'XL'", "message": "Sand stops at L." }
	],
	"combinations": [
		{ "id": "tee-navy-s", "sku": "TEE-NV-S", "options": { "color": "navy", "size": "S" }, "stock": 4 },
		{ "id": "tee-sand-m", "sku": "TEE-SD-M", "options": { "color": "sand", "size": ["M", "L"] }, "stock": 0 }
	],
	"pricing": {
		"base": 1900,
		"rules": [{ "id": "bulk", "when": "quantity >= 10", "percent": -1000 }],
		"rounding": { "mode": "nearest", "increment": 100, "ending": 99 }
	}
}
```

| Field                             | Meaning                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `groups[].type`                   | `single` (default), `multi` (`minSelect`/`maxSelect`), `range` (`min`/`max`/`step`, `unitPrice`), `text` (`maxLength`)    |
| `groups[].required`, `default`    | required groups are filled (default, else the best option) unless `resolver.partial = keep`                               |
| `groups[].when`, `options[].when` | rules@1 dependencies: the group applies / the option is offered only when true                                            |
| `rules[].when`                    | rules@1 exclusions: a combination is not allowed when true                                                                |
| `combinations`                    | optional variant matrix over single-choice groups (a list = any of those options), `stock`, absolute `price`, `available` |
| `options[]`                       | `label`, `description`, `swatch` (#hex), `image` (https), `hidden`, `priceDelta`, `stock`, `popularity`                   |
| `pricing`                         | `base`, `currency` (else the item's / the website's), `rules` (`amount` or `percent` basis points), `rounding`            |
| `source`                          | `{ "type": "catalog", "itemId": "…" }`: options, combinations, prices and stock from catalog events                       |

Conditions read `selection.<group key>` (string / list / number / text, `null` when empty) and `quantity`, with the
whole rules@1 library (`in`, `len`, `any`, `dateParts(now)`, …). Check them with `POST /v1/configurators:check` or the
dashboard's rule checker. `PATCH /v1/configurators/:id` replaces top-level fields and needs the current `version`.

## 2. Resolve, price and sync the URL

`POST /v1/evaluations` with `{ configurator, selection, changed, quantity, search }` (browser or server key):

- `selection` is partial and may be invalid; `changed` is the group the shopper just picked — its value wins.
- The answer is the closest valid combination: `selection`, `exact`, `adjusted` (what changed and why: `conflict`,
  `out_of_stock`, `not_applicable`, `unknown_option`, …), `filled`, `missing`, `combination` (`id`, `sku`, `inStock`),
  per-option `states` (`selected`, `available`, `out_of_stock`, `conflict`), `price` (with `price_deltas`), `url`
  (with `url_sync`: the new `search` keeping other parameters, the `canonical` query, `history` mode) and `notify`
  (out-of-stock hook for a back-in-stock form).
- No valid combination: 422 `no_valid_combination` (`exhaustive: true` when every combination was checked);
  `resolver.fallback = reject`: 422 `selection_invalid` with the closest `suggestion`.

`POST /v1/quotes` prices a selection exactly as given (422 `selection_invalid` / `selection_incomplete` otherwise) —
use it at add-to-cart. `POST /v1/url-params:build|parse` converts selections and query strings.

## 3. Drop-in widget and headless cores

- **Mode A**: place the `widget` element with the Loader (`ui/configurator.js`, variants `pills`, `dropdowns`,
  `swatches`, slots `before`, `after`, `summary`). Single-choice groups are ARIA radio groups (arrow keys, Home / End,
  Space / Enter), multi-choice groups are checkbox buttons, dropdowns native selects; focus stays on the same option
  across updates. It emits `widget.changed` and `widget.notify_requested`.
- **Mode B**: `createConfigurator({ config, strings, client, configurator, url })` (`client.widget`,
  `client.evaluate`; `url = { read, write }`), `createResolver` (the resolver in the page on the public view from
  `GET /v1/configurators/:id`), `createPriceDeltas`, `createUrlSync` — all DOM-free, `state / actions / subscribe /
validate / strings / destroy`.

## 4. Catalog link (optional)

With `schema.catalog_link` on, the product stores `item.created|updated|deleted@1` and `inventory.changed@1` from your
servers. A configurator with `"source": { "type": "catalog", "itemId": "…" }` takes its single-choice groups' options
from the variants' attributes (`attribute`, default the group key; declared options act as the pool and give labels,
order and swatches), every variant becomes a combination with its SKU, price and stock (summed over locations). Inspect
what arrived with `GET /v1/catalog-items/:itemId`. Without catalog events the configurator works standalone.

Configuration comes only from the signed entitlement document; turning an element off answers 403
`element_disabled` in every mode.
