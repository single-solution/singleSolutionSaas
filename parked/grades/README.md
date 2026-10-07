# Grade & Condition System (`grades`)

An SSPS v1 **service product** (PLAN Part D §8, Appendix A.3, Part E) that also ships drop-in blocks. A merchant
defines a ladder of quality tiers and attaches them to items, variants and individually graded units: condition grades
for used or refurbished goods, pre-owned fashion, produce classes, hotel room classes or service levels — nothing about
any trade is built in. Tiers show as badges, an explainer showcase and listing filters, carry a warranty, map to the
condition values of structured data, shopping feeds and marketplaces, and units can be inspected against checklists
with photos and a shareable report.

**All grading data lives in the merchant's own MongoDB** (`ss_grades_*`) and inspection photos in the merchant's own
bucket (both connected in the Portal); this deployment keeps only caches and queues. Built on `@ss/app-kit` and
`@ss/rules` (applicability, visibility and checklist conditions). Business rules live only in `core/` (pure) and
`headless/`.

Ported from ibrahimMobiles and generalised: the per-category grade model (label, notes, colour, video, active flag)
became a merchant ladder with rules@1 applicability instead of a category key; the grade badge and the per-grade
showcase (notes, warranty, inspection video) became the `tiers` and `showcase` blocks; warranty days per variant became
warranty terms per tier with period wording from the string catalog; and the hard-coded keyword heuristic that turned
grade names into schema.org `itemCondition` and Merchant feed `condition` became **merchant-editable vocabularies**
shipped as data (feature defaults), so structured data and feeds read the same table.

## Elements

Every element is switchable per website and priced in millicredits per hour; every setting is a feature with a schema,
a default and plan bounds (`x-plan`) in `schemas/<element>.features.json`. Every element supports all three modes:
drop-in renderer (`ui/`), headless core (`headless/`) and HTTP API (`openapi.json`).

| Element      | Price /h | What it does                                                                                                                                                                                                                                                                                                                                                    |
| ------------ | -------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tiers`      |      200 | The ladder (key, label, short label, notes, order, hex colour or design token, icon, rules@1 `applies_when`, shown/hidden; count limit per plan: starter 6, pro 20), default tier, badge style, the catalog attribute that names tiers, and the tier of items, variants and graded units (serials, lots, rooms…; limit per item). Badge / list / legend blocks. |
| `showcase`   |      100 | Explainer per tier (headline, copy, bullets, video link, images) merged with the ladder and the warranty period; layouts `cards`, `compare`, `single` (tabs).                                                                                                                                                                                                   |
| `filters`    |        0 | Tier options of a listing with counts per collection, hide-empty, rules@1 `visible_when`, option cap, single or multi select, URL parameter name, matching item ids, ordering items by tier.                                                                                                                                                                    |
| `warranty`   |        0 | Days of cover, text templates (`{days}`, `{period}`, `{tier}`) and exclusions per tier, defaults, "month" length, printable terms (`?format=text`).                                                                                                                                                                                                             |
| `mapping`    |        0 | Vocabularies (key, name, target structured_data / feed / marketplace / other, property, allowed values, fallback, tier → value, displayed) with schema.org `itemCondition` and a shopping-feed `condition` as editable defaults; per-item Offer properties, feed rows, problems for the dashboard, a condition statement block.                                 |
| `inspection` |      300 | Checklists (pass/fail, 0–max score and note items, weights, required and critical items, required photos, per-tier and rules@1 applicability), score → suggested tier thresholds, photos straight to the merchant's **storage connector**, a shareable report link per unit and the report block. Requires `storage`.                                           |

Plans: **starter** = tiers, filters, warranty, mapping (+ add-ons showcase, inspection); **pro** = everything. Trial
48 h. Product-level resource: `database`; `inspection` also needs `storage`.

## Integration

- **Catalog events.** Consumes the standard `item.created@1`, `item.updated@1` and `item.deleted@1`
  (`events.subscribe:item.*`): the item snapshot (title, brand, status, collections, attributes, variant ids) is kept
  for applicability rules and per-collection filters, and when the item or a variant carries the configured
  `catalog_attribute` (default `tier`) with a tier key or label, the tier is assigned (`source: catalog`). Manual
  assignments are never overwritten by the catalog; catalog assignments follow it; deleted items leave filters, badges
  and mappings.
- **Standalone.** Every API takes any external item id (`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`); no catalog is needed.
  Applicability rules are checked only for items the catalog described.
- **Publishes** `grades.tier_assigned@1` (item, variant or unit; tier null = removed; source api / dashboard / catalog
  / inspection) and `grades.unit_inspected@1` (score, suggested and final tier). Schemas in `schemas/events/`.

## Inspection photos and reports

`POST /v1/inspections/{id}/photos { item, contentType, size }` answers a presigned PUT into the merchant's bucket
(`inspections/<inspection>/<photo>` under the website's prefix) in which **`content-type` and `content-length` are
signed headers**, so the bucket accepts exactly the declared type and size. Completing an inspection HEAD-checks each
pending photo (exists, same size and type) before it counts towards `photos_required`. A slot that was never
confirmed is stale one day after its upload link expires (`staleAt`): it no longer counts, and the website's next new
photo slot (up to 25 stale slots) or the dashboard's "Clean up stale photos" button (`POST /v1/dashboard/photos:sweep`)
deletes its object from the merchant's bucket (when it was uploaded) and the slot (app-kit `sweepStaleUploads`); a TTL
index on the record a week later is only a backstop. Nothing runs on a timer. `POST /v1/units/{id}/report-link` issues a random 256-bit `grr_…` token (only its SHA-256 is
stored with the unit; a new link replaces the old one, `DELETE` revokes it) and, with `report_url_template`, the link to
the merchant's own page that renders the drop-in report. `GET /v1/inspection-reports/{token}` (pk_, rate limited,
`no-store`) returns the buyer-facing report with presigned (or public-base) photo links.

## Keys

`sk_` (servers, inspection apps, feed builders) reads and changes everything. `pk_` (browsers of the bound domain) reads
public data only: tier definitions, item tiers, showcase, filters, warranty, conditions and token-gated reports. The
sk_-only collection GETs are marked `x-ss-key-kind: "sk"` in `openapi.json`. `POST /v1/units`, `POST /v1/inspections`
and `POST /v1/inspections/{id}/photos` honour an optional `Idempotency-Key`: a retry with the same key returns the record
made first.

## Run

```bash
cp .env.example .env.local   # MONGODB_URI (empty = in-memory control store) + a random CONNECT_SECRET (32+ characters)
pnpm dev                     # the product (port 3000); connect it from Portal Admin → Apps → Add product
```

```bash
pnpm --filter @ss/product-grades check
```

```bash
pnpm --filter @ss/product-grades validate
```

Environment: `MONGODB_URI` and `CONNECT_SECRET` (`.env.example`); the Portal connection, the key and the secrets live in that
database. There are no crons and no background work: work runs on the request or event that causes it, and anything a
merchant must start sits behind a dashboard button.

## Dashboard

SSO from the Portal (`/sso?launch=` → `/dashboard`): overview (graded items, units, inspections, per-tier counts),
tiers & mapping (the ladder with colours and warranty, the vocabulary table with its problems), units & inspections
(re-grade a unit, create a report link; audited; clean up stale photo slots) and settings (a link to the Portal, where settings are edited with
locks, versions and rollback). Merchant and admin (staff) launches are supported.

See `docs/guide.md` for the developer guide.
