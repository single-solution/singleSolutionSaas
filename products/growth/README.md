# Growth

Tracking, consent, own analytics and site-wide SEO for a merchant's site (PLAN.md 0.8.9): pixels and tags loaded only
after consent, a consent banner with Google Consent Mode v2, anonymous first-party analytics in the merchant's own
database, the shop funnel, searches, 404s, Web Vitals, robots.txt and verification tags, IndexNow, an SEO checklist and
a notice bar. Feature keys are in `manifest.json`, the public docs at `/docs`.

## Environment

Exactly three variables (`.env.example`; nothing else is read):

| Variable         | What it is                                                                      |
| ---------------- | ------------------------------------------------------------------------------- |
| `MONGODB_URI`    | this product's own database (never a merchant database)                         |
| `CONNECT_SECRET` | random, at least 32 characters; typed once into Portal → Products → Add product |
| `ENCRYPTION_KEY` | random, at least 32 characters, different for each deployable                   |

## Deploy

1. Create a Vercel project with the root directory `products/growth` and set the three variables for Production only.
2. Deploy, then in the Portal: Products → **Add product** with its address and `CONNECT_SECRET`, then **Set active**.
3. Merchants add the page script in the page head before Ecommerce's, serve `/robots.txt`, the verification tags and
   `/<key>.txt` from the routes in `/docs`, and let their database user create indexes (a TTL index).

## Scripts

`pnpm dev` and `pnpm build` regenerate `openapi.json` and `server/widget-script.js` first; `pnpm check` runs format, lint,
typecheck and tests with coverage; `pnpm validate` runs `ss app validate`.
