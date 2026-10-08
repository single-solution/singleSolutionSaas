# Ecommerce

The Single Solution product that is the whole shop of the merchant's own website (PLAN.md 0.8.8, step 10): catalog,
variants and stock, grades and serials, digital goods and bookings, cart and checkout, orders with the merchant's own
statuses, delivery zones, couriers and courier APIs, taxes, coupons, deals, loyalty, bundles, returns and warranty,
reviews, wishlist, alerts, compare, invoices, CSV, bulk actions, reports, catalog SEO, feeds, AI copy and llms.txt.
Every product, order and customer record lives in the merchant's own database and media in the merchant's own storage.
Shoppers sign in with Accounts, payments go through Payments and messages through Notifications, each with its server
token pasted into Connections. Built on `@ss/app-kit`.

## Features

| Key              | What it does                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `catalog`        | Products, nested categories with SEO text, brands, attributes, media in the merchant's storage, search, filters |
| `variants`       | Options (size, colour …); each variant has its own price, stock and SKU                                         |
| `multi_location` | Stock per location; orders take stock from the first location that has it                                       |
| `grades_serials` | Condition grades with return and warranty days; serial numbers (IMEI …) captured per unit when packing          |
| `digital_goods`  | Downloads and licence keys given once the order is paid                                                         |
| `bookings`       | Services in simple slots: a duration, weekly hours, no double booking                                           |
| `checkout`       | Cart, checkout, orders with merchant-defined statuses and moves, couriers with tracking links, customers        |
| `cod`            | Cash on delivery: confirmation, largest order value, optional advance, blocklist, returned-parcel flag          |
| `delivery_zones` | Fees by city or area, free over an amount, delivery days, store pickup                                          |
| `courier_apis`   | Book shipments and read their status with the courier's API and the merchant's keys (one generic adapter)       |
| `taxes`          | A percentage per category or region; prices shown with or without tax                                           |
| `coupons`        | Codes for a percentage or fixed amount off, with limits, dates and conditions                                   |
| `deals`          | Automatic offers on products, categories or brands                                                              |
| `loyalty`        | Points earned on delivered orders, redeemed at checkout, with expiry and history                                |
| `bundles`        | Bundles and buy X get Y in the cart                                                                             |
| `reviews`        | Ratings and reviews after delivery, with moderation                                                             |
| `wishlist`       | Signed-in shoppers save products                                                                                |
| `alerts`         | Back-in-stock and price-drop alerts through Notifications                                                       |
| `compare`        | Products side by side                                                                                           |
| `returns`        | Return and warranty claims with windows per item and grade, photos, approval, refunds, restock exactly once     |
| `invoices`       | Invoices and packing slips with serials per line                                                                |
| `csv`            | Import and export products and stock, export orders                                                             |
| `bulk_actions`   | Change many products at once; move many orders at once                                                          |
| `reports`        | Sales by product, category, brand and city, stock age, return rate, margin                                      |
| `seo`            | Meta tags and structured data for products and categories, sitemaps                                             |
| `feeds`          | Product feeds (XML, CSV) for shopping and social catalogues                                                     |
| `ai_copy`        | Product descriptions and meta text suggested with the merchant's OpenAI-compatible key, never saved on its own  |
| `llms_txt`       | An llms.txt of the catalog for AI assistants                                                                    |

Stock, offer uses, loyalty points and booked slots change in one database transaction when an order is placed
(`adapters/ledger.js`). Shoppers browse and fill the cart (kept in their browser) as guests; ordering, reviews,
wishlists, alerts and returns need an Accounts sign-in. An order paid online or by bank transfer is marked paid only
after Payments confirms it for the order's exact amount and currency. There is no background work: delayed work (a
waiting payment rechecked, an unconfirmed order cancelled, alerts sent) runs when the website is used or the order read.

For Growth (PLAN 0.8.9) the shopper widgets dispatch window events, not cancelable, that Growth's page script listens
for (`core/growth-events.js`; no Growth token): `ss:view_item` (the product page shows a product), `ss:add_to_cart`
(each line added: product page, wishlist, `addToCart()` and the `ss-ecommerce:add-to-cart` event), `ss:begin_checkout`
(the first Place order press in the cart widget) and `ss:purchase` (the order placed). The detail is
`{ currency, value, items }`, plus `orderId` and `orderNumber` on `ss:purchase`, whose value is the order total; items
are `{ id, variantId, name, price, quantity }`, money in minor units.

## Layout (PLAN 0.4.13)

| Folder      | What it holds                                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `core/`     | pure logic: the record shapes, money, the order flow and its roles, delivery, taxes, promotions, loyalty, snippets                                                                         |
| `api/`      | routes of each part (catalog, checkout, orders, promotions, extras, SEO and lookups), the shop service, the docs                                                                           |
| `adapters/` | the kit wiring (`product.js`), the ledger (the only code that moves stock, offers, points and slots), the merchant database stores, the list settings, the courier API and the AI provider |
| `ui/`       | widgets: product grid, product page, cart, my orders, wishlist, compare (visitor); catalog, orders, promotions and customers admin (tickets)                                               |
| `app/`      | Next.js: the API function and the dashboard (Overview · Features · Settings · Connections · Developers)                                                                                    |
| `strings/`  | every word of the widgets (Settings → Texts)                                                                                                                                               |
| `schemas/`  | each feature's settings schema                                                                                                                                                             |
| `tests/`    | Vitest with fakes for Accounts, Payments, Notifications, storage, the courier, AI and the website; MongoDB, jsdom                                                                          |
| `docs/`     | the public docs' texts, served at `/docs`                                                                                                                                                  |

## Environment and deploying

Exactly three variables (`.env.example`): `MONGODB_URI` (this product's own database), `CONNECT_SECRET` and
`ENCRYPTION_KEY` (each random, at least 32 characters). Deploy with the Vercel project root `products/ecommerce`, set
the three variables for Production and deploy. Then connect it in the Portal: Products → Add product, with its address
and `CONNECT_SECRET`, and set it Active. For each website, paste the Accounts, Payments and Notifications server tokens
of that website into the dashboard's Connections, with the merchant's database, storage and, when used, courier and AI
keys.

## Addresses merchants set

| Where               | What                                                                                                                                                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Couriers            | none: Ecommerce calls the courier's API (booking and tracking); tracking links come from templates                                                                                                                                                         |
| Payment gateways    | none here: gateways are set up in Payments                                                                                                                                                                                                                 |
| Storage CORS        | allow `PUT` (and `GET`) from the website's origin and the admin page's origin, for presigned uploads                                                                                                                                                       |
| The merchant's site | serves from the API with the server token (snippets in `/docs`): `GET /v1/seo/sitemap.xml`, `GET /v1/seo/products/:ref`, `GET /v1/seo/categories/:ref`, `GET /v1/feeds/products.xml`, `GET /v1/feeds/products.csv`, `GET /v1/llms.txt`, `GET /v1/policies` |

## Scripts

`pnpm dev` / `pnpm build` (both regenerate `openapi.json` and `api/widget-script.js` first) / `pnpm start`,
`pnpm check` (format, lint, typecheck, tests with coverage) and `pnpm validate` (`ss app validate`).
