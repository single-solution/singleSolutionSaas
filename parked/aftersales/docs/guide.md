# After-sales — developer guide

## Purchases

A claim is always against a **purchase**. Purchases come from the order events (`order.placed@1` gives lines and
customer, the first of `claims.window_start_events` — by default `order.delivered@1` or `order.completed@1` — opens the
windows) or from your server:

```http
POST /v1/purchases            (sk_, optional Idempotency-Key)
{ "orderId": "ord_1", "number": "1001", "customer": { "customerId": "cus_1", "email": "a@example.com" },
  "currency": "USD", "lines": [{ "itemId": "itm_1", "quantity": 1, "unitAmount": 2500, "itemType": "rental",
  "grade": "excellent", "warrantyDays": 365, "serials": ["SN-1"] }], "deliveredAt": "2026-10-01T10:00:00Z" }
```

`itemType`, `grade` and `warrantyDays` are optional snapshots that windows can use. `deliveredAt: null` registers a
purchase that is not delivered yet.

## Windows

Per claim type (`claims.types`), the window in days from delivery is: the first matching **window rule** (rules@1 over
`line`, `purchase`, `customer` — e.g. `line.itemType == 'rental'`), else the line's `warrantyDays` snapshot (types
with `use_snapshot_days`), else the grade's days (`claims.grade_windows`, grades from `grades.tier_assigned@1` or the
snapshot; types with `use_grade_windows`), else `window_days`. 0 days = not claimable. Units already claimed (unless the
claim was rejected) or refunded elsewhere are not claimable again.

## Customers and guests (Mode A/B/C)

- Signed-in customers: a `pk_` key plus `SS-Identity` (your website's own login token). They see only purchases and
  claims whose customer id or subject is theirs: `GET /v1/purchases`, `GET /v1/claims`, `POST /v1/claims`.
- Guests: `POST /v1/claim-access { number, email | phone }` returns a claim token for that one purchase; send it as
  `token` in the JSON body of `POST /v1/claims`, `POST /v1/claim-photos`, `POST /v1/messages` and
  `POST /v1/claims:view`.
- Photos: `POST /v1/claim-photos { contentType, size }` returns a presigned PUT (type and length are signed); upload the
  file, then pass the photo id in `photoIds`. The object is HEAD-checked before it is attached.
- Drop-in: the `claims` element (`headless/claims.js#createClaims`, `ui/claims.js#render`, variants `full`, `form`,
  `list`) and the `serial_registry` warranty lookup.

## Staff (sk_ or the dashboard)

`GET /v1/queue`, `POST /v1/queue/{id}/transition|notes|assign`, `POST /v1/refunds`, `POST /v1/restocks`,
`POST /v1/serials`, `GET /v1/serials/{serial}`, `POST /v1/messages`. Transitions follow `queue.transitions`; refunds are
allowed in `refunds.allowed_statuses`, capped by the claimed lines (or the purchase) and published as
`order.refunded@1`; restock is allowed only in `restock.allowed_statuses` (by default once received) and each line is
decided once.

Configuration comes only from the signed entitlement document (`schemas/*.features.json`); a switched-off element
answers 403 `element_disabled` in every mode.
