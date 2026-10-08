# Growth

The Single Solution product for a merchant site's tracking, consent, own analytics and site-wide SEO (PLAN.md 0.8.9,
step 11): the merchant's tracking pixels and tags loaded only after consent, a consent banner with Google Consent Mode
v2, anonymous first-party analytics in the merchant's own database, the shop funnel from browser events, searches,
404s and Web Vitals, robots.txt and verification tags, IndexNow, an SEO checklist and a notice bar. Catalog SEO stays in
Ecommerce. Built on `@ss/app-kit`.

## Features

| Key                   | What it does                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| `meta_pixel`          | The merchant's Meta pixel after marketing consent; the shop events as ViewContent, AddToCart, … Purchase        |
| `google_tags`         | GA4 (after analytics consent), Google Ads with a purchase conversion and Tag Manager; Consent Mode v2           |
| `tiktok_pixel`        | The merchant's TikTok pixel after marketing consent; the shop events                                            |
| `custom_scripts`      | Scripts the merchant pastes, added once the visitor consents to their category (analytics or marketing)         |
| `consent_banner`      | The banner (necessary, analytics, marketing); the choice stays in the visitor's browser                         |
| `visitor_analytics`   | Visits, page views, sources, devices, countries; retention and privacy settings; the analytics dashboard widget |
| `conversion_funnel`   | Records `ss:view_item` → `ss:add_to_cart` → `ss:begin_checkout` → `ss:purchase` and revenue (needs analytics)   |
| `searches_404s`       | Site searches (query parameters or `SSGrowth.search()`) and pages not found (needs analytics)                   |
| `web_vitals`          | LCP, INP, CLS, FCP and TTFB from real visitors (needs analytics)                                                |
| `robots_verification` | robots.txt (rules and sitemaps) and the Google, Bing and Meta verification tags, served for the site to include |
| `indexnow`            | Submits the merchant's page addresses to IndexNow with their key, on request (widget or API)                    |
| `seo_checklist`       | Reads the merchant's pages on request and lists what to fix, with steps                                         |
| `notice_bar`          | An announcement bar with the merchant's text, link and dates (checked on use)                                   |

The page script is the product's `widget.js` with the browser token. It listens for the browser events Ecommerce's
shopper widgets dispatch (`ss:view_item`, `ss:add_to_cart`, `ss:begin_checkout`, `ss:purchase`; money in minor units
with a currency), records them and passes them to the loaded pixels: there is no server path between products. Analytics
are anonymous (no IP, user agent, cookie or cross-site id; the country from the host's request header) and, by default,
recorded only after analytics consent. Raw events go to `ss_growth_events` with a TTL index on `expiresAt` (13 months by
default); daily totals go to `ss_growth_daily` as `$inc` upserts and are kept forever. Nothing runs on a timer.

## Layout (PLAN 0.4.13)

| Folder      | What it holds                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/`     | pure logic: event checks and daily totals, the analytics report, consent, pixel events, tag ids, SEO, snippets                                                                  |
| `api/`      | routes (collect, analytics, robots and verification, IndexNow, SEO checklist), the docs                                                                                         |
| `adapters/` | the kit wiring (`product.js`), the merchant database (`store.js`), reading pages and IndexNow through `@ss/net`                                                                 |
| `ui/`       | the page script (consent, tags, analytics, Web Vitals) and the widgets: `consent_banner` and `notice_bar` (visitor), `analytics_dashboard` and `seo_checklist` (admin, tickets) |
| `app/`      | Next.js: the API function and the dashboard (Overview · Features · Settings · Connections · Developers)                                                                         |
| `strings/`  | every word of the widgets (Settings → Texts), the consent words and the SEO fix steps included                                                                                  |
| `schemas/`  | each feature's settings schema                                                                                                                                                  |
| `tests/`    | Vitest on the kit's fake Portal with faked web pages and IndexNow (no real network call), MongoDB, jsdom                                                                        |
| `docs/`     | the public docs' texts, served at `/docs`                                                                                                                                       |

## Environment and deploying

Exactly three variables (`.env.example`): `MONGODB_URI` (this product's own database), `CONNECT_SECRET` and
`ENCRYPTION_KEY` (each random, at least 32 characters). Deploy with the Vercel project root `products/growth`, set the
three variables for Production, then connect it in the Portal: Products → Add product, with its address and
`CONNECT_SECRET`, then set it Active.

## Scripts

`pnpm dev` / `pnpm build` (both regenerate `openapi.json` and `api/widget-script.js` first) / `pnpm start`,
`pnpm check` (format, lint, typecheck, tests with coverage) and `pnpm validate` (`ss app validate`).
