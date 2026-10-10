# Ecommerce

The whole shop of a merchant's own website (PLAN.md 0.8.8): catalog, variants and stock, cart and checkout, orders,
delivery and couriers, taxes, promotions, loyalty, returns, reviews, wishlist, alerts, invoices, CSV, reports, catalog
SEO, feeds and llms.txt. Shoppers sign in with Accounts, payments go through Payments and messages through
Notifications, each with its server token pasted into Connections. Feature keys are in `manifest.json`, the public docs
at `/docs`.

## Environment

Exactly three variables (`.env.example`; nothing else is read):

| Variable         | What it is                                                                      |
| ---------------- | ------------------------------------------------------------------------------- |
| `MONGODB_URI`    | this product's own database (never a merchant database)                         |
| `CONNECT_SECRET` | random, at least 32 characters; typed once into Portal → Products → Add product |
| `ENCRYPTION_KEY` | random, at least 32 characters, different for each deployable                   |

## Deploy

1. Create a Vercel project with the root directory `products/ecommerce` and set the three variables for Production only.
2. Deploy, then in the Portal: Products → **Add product** with its address and `CONNECT_SECRET`, then **Set active**.
3. For each website, the merchant pastes the Accounts, Payments and Notifications server tokens into Connections, and
   lets their storage's CORS allow `PUT` (and `GET`) from the website's and the admin page's origins.
4. The merchant's site serves the sitemap, feeds, llms.txt and policies from the server-token routes (snippets in
   `/docs`).

## API

Every route is in `openapi.json` and in `/docs`. Besides the shop's own routes, the merchant's server reaches the kit's
settings API (features, settings, texts, theme, Format, connections, and the lists `order_flow`, `couriers`,
`delivery_zones`, `tax_rules`, `grades` and `booking_hours` at `/v1/lists/:list`), the activity log (`/v1/activity`) and
counts of the main lists (`/v1/orders`, `/v1/products`, `/v1/customers`, `/v1/reviews` and `/v1/returns`, each with
`/count` and `/counts?by=`, and ticket twins under `/v1/admin/`). Server-token calls may name the acting staff member
with the `SS-Actor-*` headers, and the shopper routes (`/v1/shop/…`) also take the server token with `SS-Sign-In` and
`SS-Visitor-IP`.

## Scripts

`pnpm dev` and `pnpm build` regenerate `openapi.json` and `server/widget-script.js` first; `pnpm check` runs format, lint,
typecheck and tests with coverage; `pnpm validate` runs `ss app validate`.
