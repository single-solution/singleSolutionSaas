# Ecommerce

The whole shop of a merchant's own website (PLAN.md 0.8.8): catalog, variants and stock, cart and checkout, orders,
delivery and couriers, taxes, promotions, loyalty, returns, reviews, wishlist, alerts, invoices, CSV, reports, catalog
SEO, feeds and llms.txt. Shoppers order as guests or signed in with Accounts, payments go through Payments and messages
through Notifications, each with its server token pasted into Connections. Feature keys are in `manifest.json`, the
public docs at `/docs`.

## Environment

Three variables, and one optional while the encryption key is changed (`.env.example`; nothing else is read):

| Variable                  | What it is                                                                                                                                                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MONGODB_URI`             | this product's own database (never a merchant database)                                                                                                                                                                                                               |
| `CONNECT_SECRET`          | random, at least 32 characters; typed once into Portal → Products → Add product                                                                                                                                                                                       |
| `ENCRYPTION_KEY`          | random, at least 32 characters, different for each deployable: seals the Connections' secrets (the merchant database address, the storage keys, the Accounts, Payments, Notifications and Growth tokens, the courier and AI keys) and each website's deal-lock secret |
| `ENCRYPTION_KEY_PREVIOUS` | optional, only while `ENCRYPTION_KEY` is changed: the old key, so sealed values keep opening; removed once the dashboard's Re-seal (Prices → Encryption key, Owner) says it can be                                                                                    |

## Deploy

1. Create a Vercel project with the root directory `products/ecommerce` and set the three variables for Production only
   (and `ENCRYPTION_KEY_PREVIOUS` only while the key is changed).
2. Deploy, then in the Portal: Products → **Add product** with its address and `CONNECT_SECRET`, then **Set active**.
3. For each website, the merchant pastes the Accounts, Payments and Notifications server tokens into Connections, and
   lets their storage's CORS allow `PUT` (and `GET`) from the website's and the admin page's origins.
4. The merchant's site serves the sitemap, feeds, llms.txt and policies from the server-token routes (snippets in
   `/docs`).

## API

Every route is in `openapi.json` and in `/docs`. Besides the shop's own routes, the merchant's server reaches the kit's
settings API (features, settings, texts, theme, Format, connections, and the lists `order_flow`, `couriers`,
`delivery_zones`, `tax_rules`, `grades`, `item_types`, `booking_hours` and `role_prices` at `/v1/lists/:list`), the activity log
(`/v1/activity`) and counts of the main lists (`/v1/orders`, `/v1/products`, `/v1/customers`, `/v1/reviews` and
`/v1/returns`, each with `/count` and `/counts?by=`, and ticket twins under `/v1/admin/`). Server-token calls may name
the acting staff member with the `SS-Actor-*` headers, and the shopper routes (`/v1/shop/…`) also take the server token
with `SS-Sign-In` and `SS-Visitor-IP`.

## Scripts

`pnpm dev` and `pnpm build` regenerate `openapi.json` and `server/widget-script.js` first; `pnpm check` runs format, lint,
typecheck and tests with coverage; `pnpm validate` runs `ss app validate`.

## Import — catalog

With the `import` feature on, the merchant's server token sends the catalog with `ss-import` (PLAN.md 0.8.10
Migration): `POST /v1/import/<collection>?dryRun=1` takes NDJSON of the stored shapes of `core/model.js` with their
ids (`<prefix>_<24 hex digits>`), times as ISO-8601 text and money in minor units. Every collection is found by `id`;
`POST /v1/import/<collection>/prune` takes `{ keep: [ids] }`. Send them in this order, as each one names records of the
ones before it:

| Collection    | Id      | Names (must be imported first)                                                          |
| ------------- | ------- | --------------------------------------------------------------------------------------- |
| `size_charts` | `szc_`  |                                                                                         |
| `categories`  | `cat_`  | `sizeChartId`; `parentId` may come later (finish places it)                             |
| `brands`      | `brd_`  | `categoryIds`, `sizeChartId`                                                            |
| `attributes`  | `att_`  | `categoryIds`, visibility brands and grades (an attribute it depends on may come later) |
| `landings`    | `lnd_`  | `categoryId`, `brandId`, `grade`                                                        |
| `products`    | `prd_`  | categories, brand, attributes, size chart, grades; variants `var_…`                     |
| `serials`     | `ser_`  | `productId` + `variantId`                                                               |
| `deals`       | `deal_` | scope products, categories and brands                                                   |
| `bundles`     | `bnd_`  | items and scopes                                                                        |

Taken as given: ids, `createdAt`, `publishedAt` (else `createdAt` for an active product), `used`, `sold` and `rating`
(finish derives them again only from imported order lines and reviews: a product with none keeps the given numbers),
`previousSlugs`, stock (no stock is held) and storage keys of any folder with their `type` and `size` (`''` and `0` when
left out; a video file is `video/mp4` or `video/webm`). A product with `variants: []` is stored as a draft (it goes on
sale once it has a variant). Refused, each by its path: fields the record type does not have (a mapping mistake shows
in the dry run), `websiteId` and `merchantId`, values the shop derives (`path` of a category; `price`, `priceMax`,
`inStock`, `stockState` and `grades` of a product), text over a limit (never cut), references to records not imported,
times in the future, and slugs, SKUs, variant ids, serial numbers, deal slugs and landing combinations another record
holds (in the database or earlier in the same call). With Multi-location stock a variant gives `locations` (its
`stock` is their sum). Units (`serials`) belong to products whose item type numbers them: save the `item_types` list
first (`PUT /v1/lists/item_types`; a category or a product names its type by `typeKey`, as `numbered` below). A unit
`in_stock` or `faulty` belongs to no order; a `sold` one names its `orderId`.

A product may carry `feedGroupId` and a variant `feedId`: the item group and item ids the earlier shop's product feed
used (1 to 50 letters, digits, `.`, `_` or `-`), which the feeds then send, so shopping catalogs keep listing the same
items; only an import sets them and edits keep them.

Smallest records (one per line in a file):

```json
{"id":"szc_000000000000000000000001","name":"Garden gloves","unit":"cm","columns":[{"key":"palm-width","label":"Palm width"}],"rows":[{"size":"m","label":"M","values":{"palm-width":"9"}}]}
{"id":"cat_000000000000000000000001","slug":"home-garden","name":"Home and garden","parentId":null}
{"id":"brd_000000000000000000000001","slug":"northwind","name":"Northwind","categoryIds":["cat_000000000000000000000001"]}
{"id":"att_000000000000000000000001","slug":"color","name":"Color","type":"choice","on":"variant","choices":[{"value":"blue","label":"Blue"}]}
{"id":"lnd_000000000000000000000001","categoryId":"cat_000000000000000000000001","brandId":"brd_000000000000000000000001","grade":null,"h1":"Northwind home and garden"}
{"id":"prd_000000000000000000000001","slug":"ceramic-mug","name":"Ceramic mug","status":"active","typeKey":"numbered","categoryIds":["cat_000000000000000000000001"],"brandId":"brd_000000000000000000000001","media":[{"key":"uploads/mug.webp","type":"image/webp","size":5000,"alt":"Ceramic mug"}],"variants":[{"id":"var_000000000000000000000001","sku":"MUG-BLUE","price":1200,"stock":3,"attributes":{"att_000000000000000000000001":"blue"}}],"sold":12,"rating":{"average":4.5,"count":2},"createdAt":"2023-04-01T08:00:00.000Z"}
{"id":"ser_000000000000000000000001","productId":"prd_000000000000000000000001","variantId":"var_000000000000000000000001","serial":"SN 0001","status":"in_stock"}
{"id":"deal_000000000000000000000001","name":"Summer","type":"percent","value":10,"scope":{"productIds":["prd_000000000000000000000001"]},"startsAt":"2024-06-01T00:00:00.000Z","limit":100,"used":37,"slug":"summer"}
{"id":"bnd_000000000000000000000001","name":"Two mugs","type":"bundle","items":[{"productId":"prd_000000000000000000000001","quantity":2}],"price":2000,"used":4}
```

`POST /v1/import/finish` (the catalog's steps run first) places every category under its parents and derives each
product's price, highest price, stock state and grades again, writing only what changed. It is paged: one call works on
at most 200 records and answers `more` and `next`; while `more` is true, call again with `?after=<next>` (`ss-import
send` does, and adds the numbers of every call up). Each call answers `categoriesChecked`, `categoriesChanged`,
`productsChecked` and `productsChanged`, and the calls that reach the categories add `categoryProblems: { orphans,
cycles, tooDeep }` (at most 20 ids per list; `{ tooMany: true }` above 5,000 categories: no path derived). `GET
/v1/import/status` adds the sums `products`, `products.active`, `products.draft`, `variants`, `variants.active`,
`stock.units`, `serials.in_stock`, `serials.sold`, `serials.faulty`, `deals.used` and `bundles.used`. Imports and finish
send no message, event, alert or IndexNow call.

Storage keys after the import: a product, a variant or a deal keeps the keys it holds whatever their folder when staff
edit it (variant photos, photo sizes, the video, the deal banner); only new keys must be under the record's folder.

## Import — shoppers and orders

After the catalog, the same routes take the shoppers and their orders (PLAN.md 0.8.10 Migration, order step 6), in
this order, then `POST /v1/import/finish`:

| Collection  | Found by          | Names (imported first)                                    |
| ----------- | ----------------- | --------------------------------------------------------- |
| `customers` | `id` (`cus_`)     | `userId` (the Accounts user; none for a guest)            |
| `orders`    | `id` (`ord_`)     | `customer.customerId`, products and variants of its lines |
| `loyalty`   | `customerId`      | the customer, the orders of its lots and history          |
| `reviews`   | `id` (`rev_`)     | product, order and order line                             |
| `returns`   | `id` (`ret_`)     | order and its lines                                       |
| `alerts`    | `id` (`alr_`)     | product and variant                                       |
| `wishlists` | `userId` (`usr_`) | products                                                  |

The checks are the product's own, in import mode (`core/imports-orders.js`): ids, numbers and past times are taken as
given; fields the record type does not have (with `websiteId` and `merchantId`) and text over a limit are refused by
path (never cut). Customers: phones as E.164, or national numbers with the website's calling code (the
`checkout.defaultCallingCode` setting, else the business.json country's; refused when there is neither), a guest has a
name and a phone (one guest per phone), a block has its reason; `orderCount`, `rtoCount`, `lastOrderAt` and
`phoneDigits` are ignored (0 until finish). Orders: `number` in the website's form (`checkout.numberPattern`:
`<numberPrefix><at least numberDigits digits>`, or `<numberPrefix><year>-<at least numberDigits digits>`); `status` a key of the `order_flow` list, `role` the flow's (derived; a different one is
refused); the last history entry moves to `status`; `deliveredAt` given for delivered and returned orders, refused on
ones never delivered; each line's `total` is unit price × quantity − discount (+ tax when prices exclude tax) and the
totals add up as checkout adds them (lines + delivery + fee), in the shop's currency; `payment.paid` and `refunded` are
the sums of `payments` and `refunds` (derived, refused when different) and `payment.state` is the one they give (a paid
order has its payment entries); `stockHeld` (never true on a canceled or returned order) and `promotions.released`
are given (`pointsCredited` too when points were earned); `idempotencyKey` is `import:<id>` when missing, `createdAt`
the placement time. Loyalty: lots and history as given; `balance` (unexpired lots), `lifetimeEarned` (earn entries)
and `version` are derived. Alerts are never due (`dueAt` is refused). Nothing is sent, emitted or alerted, and no stock,
slot, offer use or point moves.

Smallest records (the default order flow and number form, prefix `''`, 6 digits, USD):

```json
{"id":"cus_000000000000000000000001","userId":"usr_000000000000000000000001","name":"Ayla Shopper","email":"ayla@example.com","phone":"+15550002222"}
{"id":"ord_000000000000000000000001","number":"000001","customer":{"userId":"usr_000000000000000000000001","customerId":"cus_000000000000000000000001","name":"Ayla Shopper","email":"ayla@example.com","phone":"+15550002222"},"address":null,"delivery":{"method":"pickup","fee":0},"lines":[{"id":"oln_000000000000000000000001","productId":"prd_000000000000000000000001","variantId":"var_000000000000000000000001","name":"Ceramic mug","unitPrice":1200,"quantity":1,"discount":0,"total":1200}],"totals":{"subtotal":1200,"discount":0,"delivery":0,"tax":0,"total":1200,"currency":"USD","taxIncluded":true},"promotions":{"released":false,"pointsEarned":12,"pointsCredited":true},"payment":{"method":"cod","state":"paid","paid":1200},"payments":[{"id":"opy_000000000000000000000001","method":"cash","amount":1200,"note":"Imported","at":"2026-03-04T12:00:00Z"}],"status":"delivered","history":[{"at":"2026-03-01T09:00:00Z","from":null,"to":"confirmed","by":"shopper"},{"at":"2026-03-04T12:00:00Z","from":"confirmed","to":"delivered","by":"Staff"}],"stockHeld":true,"placedAt":"2026-03-01T09:00:00Z","deliveredAt":"2026-03-04T12:00:00Z"}
{"customerId":"cus_000000000000000000000001","userId":"usr_000000000000000000000001","lots":[{"id":"lot_000000000000000000000001","points":12,"left":12,"earnedAt":"2026-03-04T12:00:00Z","expiresAt":null,"orderId":"ord_000000000000000000000001","kind":"earn"}],"history":[{"at":"2026-03-04T12:00:00Z","kind":"earn","points":12,"orderId":"ord_000000000000000000000001","note":"000001"}]}
{"id":"rev_000000000000000000000001","productId":"prd_000000000000000000000001","userId":"usr_000000000000000000000001","orderId":"ord_000000000000000000000001","lineId":"oln_000000000000000000000001","name":"Ayla S.","rating":5,"title":"Lovely","body":"Keeps my coffee hot.","status":"approved","createdAt":"2026-03-10T00:00:00Z"}
{"id":"ret_000000000000000000000001","reference":"R-000001","orderId":"ord_000000000000000000000001","orderNumber":"000001","userId":"usr_000000000000000000000001","kind":"return","lines":[{"lineId":"oln_000000000000000000000001","quantity":1}],"reason":"Arrived chipped","status":"requested","history":[{"at":"2026-03-06T00:00:00Z","status":"requested","by":"shopper","note":""}]}
{"id":"alr_000000000000000000000001","kind":"back_in_stock","productId":"prd_000000000000000000000001","variantId":null,"userId":"usr_000000000000000000000001","email":"ayla@example.com","status":"waiting"}
{"userId":"usr_000000000000000000000001","productIds":["prd_000000000000000000000001"]}
```

Finish (after the catalog's steps, in the same pages of at most 200 records, `?after=<next>` while `more`; writing only
what changed, so a second run changes nothing) counts each customer's orders, RTO packages and last order; sets loyalty
balances and lifetime points; sets products' `sold` (units of delivered orders) where the product has imported order
lines and `rating` (approved reviews) where it has imported reviews, and keeps the given numbers where there is nothing
to derive; marks `sold` with their order and line the serials that lines of orders still holding them list (not
canceled, returned or refunded before delivery, nor put back by a claim); and moves the order counter of the
website's number form (the running one, or each year's) up to the highest number used, so the next order gets the
number after. It answers
`customersUpdated`, `loyaltyUpdated`, `productsSoldRatingUpdated`, `serialsSold`, `serialsMissing` (listed on a line, no
serial record), `serialsOnOtherOrders` and `countersSet`. `GET /v1/import/status` adds `orders.<status>.count`,
`orders.<status>.total`, `customers`, `loyalty.points` (the sum of balances), `reviews` and `returns`.
