# Growth

Tracking, consent, own analytics and site-wide SEO for a merchant's site (PLAN.md 0.8.9): pixels and tags loaded only
after consent, a consent banner with Google Consent Mode v2, anonymous first-party analytics in the merchant's own
database, the merchant's goals and funnels (the shop funnel to start with), searches, 404s, Web Vitals, robots.txt and verification tags, IndexNow, an SEO checklist,
redirects and a notice bar. Feature keys are in `manifest.json`, the public docs at `/docs`.

More options (PLAN.md 0.8.10 G1–G7) are settings with safe defaults: tags without a consent step and
GA4 inside Tag Manager, search and contact pixel events with product or variant ids, detailed analytics with sessions,
the AI crawlers to block and Yandex verification, the IndexNow key file path and Web Vitals to GA4. robots.txt keeps internal search results out of crawling by default; a shop adds its sorted and filtered lists and
private pages with the online store preset (G12), with names the merchant matches to the storefront. Merchant lists
(`core/lists.js`, `GET|PUT /v1/lists/:list`): goals, funnels, consent categories, announcements (the notice bar's; `GET /v1/notice` answers the one showing), conversion actions,
more verification tags and ignored SEO findings.

## SEO checklist

The `seo_checklist` feature is the live website's SEO health report (SEO audit §3.2 B), run when staff ask (the
`seo_checklist` admin widget with `seo.check`, or `POST /v1/seo/checks` with the server token), never on a timer.

- One run reads robots.txt, the sitemap it names (else `/sitemap.xml`; of an index, its first 3 files), the home page
  and the checklist's pages (or the paths asked for), the old paths of up to 3 redirect rules and an address the site
  does not have (a removed product's from the 404 log when one is known, else a made-up one); a full run (no paths) adds
  sample pages from the sitemap (a product, a category, a landing or listing page, a glossary page), told apart by their
  structured data. With Web Vitals (and Visitor analytics, which keeps them) or Searches and 404s on it also reads
  the daily totals (28 days of vitals, 90 days of 404s). Reads (`adapters/web.js`, through `@ss/net`) never follow a
  redirect, run 4 at a time, each at most 8 s and 2 MB (a sitemap file 16 MB), the whole run at most 25 s.
- Each check (`core/seo-checks.js`; reading HTML, JSON-LD, robots.txt rules and sitemaps in `core/seo-scan.js`) is
  pass, warn or fail with a finding code; the answer adds the title, reason and fix from the widget texts
  (`seo.check.<id>.title`, `.<finding>`, `.fix`) and the page's Google Rich Results Test link.
- The last full run is kept in `ss_growth_seo_reports` (one document per website): `GET /v1/seo/report` answers it, the
  widget opens on it (and runs again when it is a day old), and a full run within 5 minutes answers it (`cached: true`)
  without reading the site. 10 runs an hour per website.

## Redirects

The `redirects` feature keeps up to 5,000 rules per website in the merchant database (`ss_growth_redirects`, one per
old path): `{ from, match: exact | prefix | wildcard, to, code: 301 | 302 | 307 | 308 | 410, note }`. Paths are normalized the same way for rules
and requests (one leading slash, no trailing slash except `/`, letters in one Unicode form (NFC), percent-encoded, letter
case kept); rules match the path only and pass the visitor's query string on; a prefix rule keeps the rest of the path.
Every change is checked against the whole set in one transaction: one rule per path, no loops, no chains (a request
never passes two rules).

- The website's server reads them with the server token: `GET /v1/redirects/match?path=` (the rule and its `location`,
  or 204) or, for edge middleware, `GET /v1/redirects/all` with an ETag and `Cache-Control: private, max-age=300`; a 304
  costs one read of `ss_growth_redirect_versions` (a new random version on every change), never of the rules.
- Staff use the `redirects` admin widget (`redirects.edit`) or the server-token twins: list with counts, create, change,
  delete, suggestions from the 404 log, CSV export and CSV import with a dry run. Every change goes to the activity log.

## Import

The `import` feature (price 0; our admins switch it on for a migration and off after it) takes daily totals rebuilt
from another system's analytics, from `ss-import` with the server token only (PLAN.md 0.8.10 K10, G8). Nothing is sent
and no raw events are made.

- `POST /v1/import/totals?dryRun=1` takes NDJSON (at most 1,000 records or 4 MB per call), one day per record:
  `{ "day": "YYYY-MM-DD", "part": 0, "totals": { "<metric>": { "<key>": { "c": <count>, "s": <sum> } } } }`, the day in
  the business time zone and the keys as readable text (Growth escapes them). Each metric must be one Growth counts
  (`visits` and `page_views` with the key `""`, `page`, `source`, `device`, `country`, `event` (an event name), `page_match` (a page pattern), `revenue`, `search`,
  `vital` and the rest), with keys of the form Growth writes, a whole count of 0 or more and a finite sum (only
  `revenue`, `duration`, `vital_value` and `vital_page` keep sums). Unknown fields are refused by name.
- A day is one document of the daily totals, found by `day` and `part`: a re-imported day replaces it, so totals Growth
  recorded live for that day before the import are replaced too.
- `POST /v1/import/totals/prune` with `{ "keep": [{ "day", "part" }, …] }` removes imported days the source no longer
  has (days counted live are never removed); `POST /v1/import/finish` has nothing to derive; `GET /v1/import/status`
  answers the counts and the sums `ss-import verify` compares (`days`, `visits`, `page_views`). The analytics report
  reads imported days like any other.

## Environment

Three variables, and one optional while the encryption key is changed (`.env.example`; nothing else is read):

| Variable                  | What it is                                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MONGODB_URI`             | this product's own database (never a merchant database)                                                                                                                                                            |
| `CONNECT_SECRET`          | random, at least 32 characters; typed once into Portal → Products → Add product                                                                                                                                    |
| `ENCRYPTION_KEY`          | random, at least 32 characters, different for each deployable: seals the Connections' secrets (the merchant database address and the link keys to other products, both from the Portal) and the product's own keys |
| `ENCRYPTION_KEY_PREVIOUS` | optional, only while `ENCRYPTION_KEY` is changed: the old key, so sealed values keep opening; removed once the dashboard's Re-seal (Prices → Encryption key, Owner) says it can be                                 |

## Local development

Each deployable has its own port, so all run at once: the Portal 3000, Accounts 3001, Notifications 3002, Chat 3003,
Payments 3004, Ecommerce 3005, Growth 3006. This product runs on **3006**.

1. One local MongoDB for everything (keep it running): `pnpm --filter @ss/platform db:local` (kept in
   `platform/.mongo-data`) or `db:memory` (lost on stop). Start the Portal as its README says.
2. `products/growth/.env.local` (git-ignored), each secret random and different (make one with
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`):

   ```bash
   MONGODB_URI=mongodb://127.0.0.1:27999/ss_growth?replicaSet=testset
   CONNECT_SECRET=<random>
   ENCRYPTION_KEY=<random>
   ```

3. `pnpm dev` → http://localhost:3006. In the Portal (http://localhost:3000): Products → Add product with
   `http://localhost:3006` and the `CONNECT_SECRET`, then Set active.

Under `next dev` (`NODE_ENV=development`) the product may call `http://localhost` and `127.0.0.1` (the Portal and the
other products) and use a MongoDB there, for example a merchant database
`mongodb://127.0.0.1:27999/?replicaSet=testset` entered in the Portal (Website settings › Data and files). A deployed product (`NODE_ENV=production`) never
does: only public https addresses and TLS databases.

## Deploy

1. Create a Vercel project with the root directory `products/growth` and set the three variables for Production only.
2. Deploy, then in the Portal: Products → **Add product** with its address and `CONNECT_SECRET`, then **Set active**.
3. Merchants add the page script in the page head before Ecommerce's, serve `/robots.txt`, the verification tags and
   the IndexNow key file (`/<key>.txt` or their own path) from the routes in `/docs`, and let their database user create
   indexes (a TTL index).

## Scripts

`pnpm dev` and `pnpm build` regenerate `openapi.json` and `server/widget-script.js` first; `pnpm check` runs format, lint,
typecheck and tests with coverage; `pnpm validate` runs `ss app validate`.
