# Order Manager — developer guide

## Receive orders (Mode C, `sk_`)

`POST /v1/inbound-orders` with our canonical order (money in integer minor units of `currency`):

```json
{
	"externalId": "A-1001",
	"currency": "EUR",
	"lang": "en",
	"customer": { "customerId": "cus_1", "email": "ada@example.com", "name": "Ada" },
	"shipping": { "name": "Ada", "line1": "1 Main St", "city": "Springfield", "country": "…" },
	"payment": { "method": "cod" },
	"lines": [
		{ "itemId": "itm_1", "sku": "LAMP-1", "title": "Desk lamp", "quantity": 1, "unitAmount": 4500, "warranty": { "days": 365 } }
	],
	"taxLines": [{ "label": "VAT", "rate": "20%", "amount": 750 }],
	"adjustments": [{ "label": "Points redeemed", "amount": -200 }]
}
```

Or send your own checkout's JSON with `?mapping=<key>` (settings: `inbound_api.mappings`, dot paths, minor or decimal
money). The same `externalId` is never stored twice. Tax lines and warranty are copied as given: no tax rule, country
or currency is assumed.

## Move orders

`POST /v1/orders/{id}/transitions { status, reason?, note? }`. The matrix (`lifecycle.transitions`) says who may move
(`staff`, `api`, `customer`, `system`), which checks apply (`serials`, `tracking`, `dispatch_video`, `full_refund`,
`paid_in_full`, `return_reason`) and which catalogued event is published. The default matrix only lets a dispatched
order be delivered or returned. Revenue statuses (`revenue: true`) are the one definition of a sale everywhere.

Auto-expiry (`expire_after_hours` > 0) needs no timer: an order whose status expired is moved to `expire_to` (with its
events and customer message) the moment any read reaches it — your server, the customer or the dashboard — and never
counts as open after its deadline. Undelivered events and customer message retries are sent when the order is next
read; the dashboard's "Process due now" handles every due order of the website at once.

Fulfilment: `PATCH /v1/orders/{id}/fulfilment`; serials: `PUT /v1/orders/{id}/serials`; payments and refunds:
`POST /v1/orders/{id}/payments|refunds`; bulk: `POST /v1/order-batches`, `GET /v1/order-exports`,
`POST /v1/order-imports`; documents: `GET /v1/orders/{id}/invoice`, `/v1/packing-slips?ids=`, `/v1/pick-lists?ids=`.

## Customers (Mode B / A, `pk_` + `SS-Identity`)

- `headless/orderTracker.js#createOrderTracker` (lifecycle): `load`, `loadMore`, `select`, `cancel`, `close`.
- `headless/tracking.js#createTracking` (fulfilment): `setNumber`, `setContact`, `lookup` (no login needed).
- `headless/receipt.js#createReceipt` (invoices): `load(orderId)` → `{ title, html }`.

Each has a token-only renderer in `ui/`. Customer updates go out through your messaging connector; set
`customer_updates.delivery: "event"` to hand them to a messaging product instead (it reads the text at
`GET /v1/customer-updates/{id}` with the `sk_` key).
