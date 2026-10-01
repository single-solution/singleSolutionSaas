# Grade & Condition System — developer guide

Use the drop-in blocks (Mode A), build your own UI on the headless cores (Mode B), or call the API (Mode C). The same
settings, rules, entitlements and events apply in all three.

## 1. Define your ladder

In the Portal, open the subscription and edit **Tiers → Tiers**. Each tier has a stable `key` (used by the API,
mappings, filters and checklists) and display fields. Examples:

| Use                 | Tiers (best first)                                    |
| ------------------- | ----------------------------------------------------- |
| Refurbished devices | `new`, `excellent`, `good`, `fair`                    |
| Pre-owned fashion   | `new_with_tags`, `like_new`, `gently_used`, `vintage` |
| Produce             | `extra`, `class_i`, `class_ii`                        |
| Hotel rooms         | `deluxe`, `superior`, `standard`                      |
| Service levels      | `platinum`, `gold`, `silver`                          |

Colours: set `token` to one of your design tokens (`--ss-color-success`) or `color` to a hex value; the token wins.
`applies_when` (rules@1) limits a tier to some catalog items, e.g. `'phones' in item.collections`.

## 2. Attach tiers to items

- **From your catalog**: send `item.created@1` / `item.updated@1` with an attribute named like `catalog_attribute`
  (default `tier`) on the item or on variants, e.g. `variants: [{ variantId: 'v1', attributes: { tier: 'Excellent' } }]`.
- **By API** (sk_):

```http
POST /v1/tier-assignments
Idempotency-Key: 6a1f…
Authorization: Bearer sk_live_…

{ "itemId": "erp:4711", "variantId": "blue-128", "tier": "excellent" }
```

`POST /v1/tier-assignments:batch` takes up to 100. Individually graded units (a serial, a lot, a room):

```http
POST /v1/units
{ "itemId": "erp:4711", "serial": "SN-0001", "tier": "good" }
```

## 3. Show them

Drop-in (Loader placement) or headless:

```js
// headless/tiers.js of this product (shipped in its UI bundle; copy it into your own build for a custom UI)
const badges = createTierBadges({ strings, client }); // client: @ss/web/element createElementApi with your pk_ key
await badges.actions.load({ itemId: 'erp:4711', variantId: 'blue-128' });
badges.subscribe((state) => paint(state.current)); // { label, color: 'var(--ss-color-success)', style, ariaLabel }
```

| Element      | Headless factory         | Renderer variants            | Main reads                                                                |
| ------------ | ------------------------ | ---------------------------- | ------------------------------------------------------------------------- |
| `tiers`      | `createTierBadges`       | `badge`, `list`, `legend`    | `GET /v1/tiers`, `GET /v1/items/{itemId}`, `GET /v1/items?ids=`           |
| `showcase`   | `createShowcase`         | `cards`, `compare`, `single` | `GET /v1/showcase?tier=&itemId=`                                          |
| `filters`    | `createTierFilter`       | `chips`, `list`              | `GET /v1/tier-filters?collection=`, `GET /v1/tier-filters/items?tier=a,b` |
| `warranty`   | `createWarranty`         | `inline`, `terms`, `table`   | `GET /v1/warranty`, `GET /v1/warranty/{tier}`, `?format=text`             |
| `mapping`    | `createConditions`       | `statement`, `table`         | `GET /v1/condition-mappings/items/{itemId}`                               |
| `inspection` | `createInspectionReport` | `report`, `summary`          | `GET /v1/inspection-reports/{token}`                                      |

The filter writes its selection to `state.queryValue` (`new,good`) under `state.param` and emits
`filters.changed`; your listing reacts to it or uses `actions.apply()` / `state.itemIds`. `POST /v1/tier-filters:sort`
orders any item ids by tier.

## 4. Structured data and feeds

`GET /v1/condition-mappings/items/{itemId}` returns, per variant and tier, the value in every vocabulary and `offer`
properties to merge into your Offer JSON-LD (`{ "itemCondition": "https://schema.org/UsedCondition" }`). Feed builders
page `GET /v1/condition-mappings/feed?vocabulary=shopping_feed` (sk_). Edit or add vocabularies under **Mapping →
External vocabularies**; values outside a vocabulary's `allowed` list are replaced by its fallback and listed as
problems in the dashboard.

## 5. Inspect units

1. `GET /v1/checklists` (sk_) — what to check.
2. `POST /v1/inspections { unitId, results: [{ item, value, note? }] }` — a draft with its weighted score and suggested
   tier (thresholds under **Inspection → Score → suggested tier**; a failed critical item caps the tier).
3. Photos: `POST /v1/inspections/{id}/photos { item, contentType, size }` → PUT the file to `upload.url` with exactly
   `upload.headers` (type and length are signed) before the link expires.
4. `PATCH /v1/inspections/{id} { results?, complete: true, tier? }` — completes when required answers and photos are
   present; the unit takes the suggested tier (or the one you name) and `grades.unit_inspected@1` is published.
5. `POST /v1/units/{id}/report-link` → `{ token, url }` to share with the buyer; your report page renders the drop-in
   `inspection` block with that token.

## Errors

RFC 9457 problems with stable codes: `validation_failed` (with `errors[]`), `tier_unknown`, `tier_not_applicable`,
`unit_limit`, `serial_taken`, `checklist_missing`, `inspection_completed`, `inspection_incomplete` (with the missing
answers and photos), `photo_limit`, `not_inspected`, `storage_unavailable`, `element_disabled`, `not_found`.
