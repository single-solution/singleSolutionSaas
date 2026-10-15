# @ss/app-kit

The kit every product is built on (PLAN.md Part 0: 0.4, 0.4.12, 0.8.1). One `createProduct` call wires everything a
product must do the same way as every other product; the product adds its own routes, widgets and dashboard pages.
The exact API is in [API.md](./API.md).

## What the kit does

- **Connection** — answers the Portal's signed connect handshake at `POST /.well-known/ss-connect`, pins the Portal URL
  and keys, keeps its own address and product key, and answers its manifest and price list.
- **Tokens and tickets** — verifies browser tokens (only from `https://<exact domain>` or a local origin, CORS for that
  origin) and server tokens (refused with an Origin header) offline against the Portal keys and the revocation list;
  issues 15-minute tickets bound to one origin for admin widgets (`POST /v1/tickets`).
- **Status** — fetches the status of the product on each website when a request needs it (cached until `validUntil`,
  at most 5 minutes, together with the revocation list), obeys it (`product_unavailable` with a reason), turns an
  ended grace period into stopped, and keeps the last status (and revocation list) for 6 hours while the Portal
  cannot be reached (offline grace).
- **Notices** — `POST /.well-known/ss-events`: `status.changed` (the status is fetched again right after the answer; a
  `removed` status turns the website's switches off, so a re-add starts with every feature off; a `featuresVersion`
  above the switches' own, a re-add the product missed while it could not be reached, turns them off too),
  `token.revoked`, `sessions.revoked`, `website.deleted`.
- **Reports** — price reports (Prices screen, and once after a deploy that changed the feature list) and feature
  reports (Features screen); switches are saved only after the Portal accepts.
- **Settings** — one value per website × setting with global defaults and schema defaults; widget texts with the same
  placeholders as the English text; the theme (colors, font, radius, mode, custom CSS); the Format (locale, currency
  display, whole units, times). Every change goes to Recent changes; a website's change also to its activity log
  (`settings.changed`, by who changed it).
- **The merchant's server** (PLAN 0.8.10 K1–K4, K9) — the settings API (`/v1/features`, `/v1/settings`, `/v1/texts`,
  `/v1/theme`, `/v1/format`, `/v1/lists`, `/v1/connections`; 3,000 reads per minute per route and 60 writes per
  minute per website) with a merchant's rights; the acting user named by
  `SS-Actor-*` headers; visitor calls with the server token (`SS-Visitor-IP`, their own rate window); counts of lists
  (`countHandlers`); the activity log (`GET /v1/activity`; `activityFilter` for a product's own copies of entries).
  The product dashboard edits the same lists (`GET|PUT /v1/dashboard/websites/:websiteId/lists/:list`) with the same
  rules.
- **Events, staff alerts and imports** (K5, K6, K10) — events kept 30 days and forwarded through Notifications; staff
  alerts to recipients, Accounts staff with a permission (or `all_staff`: every staff member with the alert's own
  permission) and the assignee; checked, idempotent NDJSON import routes, which the kit serves (feature `import`)
  when the product passes `imports`.
- **Default message templates** (parity P1) — the product declares the messages it sends through Notifications with
  their US-English default words (`schemas/messages.json`, checked with the contract at start); the kit attaches them
  to every send to Notifications, which uses them while the website has no template of its own, and serves them at
  `GET /v1/message-defaults` for Notifications' dashboard. A message's long values (`longValues`, for example a chat
  transcript) are named on every send of it, so Notifications takes them up to 50,000 characters each. A send with an
  undeclared key made per case (for example per status) and a declared `fallbackTemplate` carries the fallback
  message's defaults and long values. WhatsApp never has a default (it sends only templates approved at Meta).
- **Format and time zone** (K7, K8) — `formatMoney`, `formatDate` and the calendar helpers from `@ss/contracts`, fed by
  the website's Format and its business.json time zone (`product.format(websiteId)`, the widget config).
- **Connections** — the merchant's database, storage, provider keys and pasted tokens, encrypted with a key derived
  from `ENCRYPTION_KEY`, write-only, tested live when saved. `callProduct` calls another product with a pasted token.
- **Sealing and Re-seal** — every stored secret uses the one format of `@ss/protocol` (`ss2.<keyId>.…`; the key id
  names the key that sealed it). While the owner changes `ENCRYPTION_KEY`, the old key is `ENCRYPTION_KEY_PREVIOUS`
  and values open with either; the Owner's Re-seal (`POST /v1/dashboard/reseal`) seals Connections, the product key,
  the ticket key and the product's own secrets (`hooks.resealProduct`, `hooks.resealWebsite`) again with the new key.
  `createSealer` gives a product the same sealer for its own secrets. The product key and the ticket key are kept
  sealed (K-21; their public keys readable); keys kept in clear before are sealed on their next use.
- **Merchant database** — guarded access (`websiteId` on every query, no cross-collection stages, inserts stamped
  with `websiteId` and `merchantId`; Atlas Search only as a first `$search` whose compound filter pins the website) to
  collections `ss_<product id>_<name>`; the product's declared indexes are the truth (a changed or retired index of a
  collection it declares indexes for is replaced on a database's first use per instance, no record is changed).
- **business.json**, **data rights** (`POST /v1/data-rights/export|delete`), the **activity log** with copies to
  Accounts, **Recent changes**.
- **Product dashboard** — `GET /sso?launch=` sessions, the switcher, roles and the dashboard API every product's
  `app/` pages call.
- **Setup sheet** — `GET /v1/blueprint?websiteId=`, a call the Portal signs (`auth: 'portal'`): the product's part of
  the website's Setup sheet (`ss.blueprint/1`): features with their business profile tags (`recommendFor`) and their
  settings and lists while on, connections state only, widgets with readiness, staff permissions, events, the Overview
  checklist, docs, the product's `hooks.blueprint` summaries and what the website builds per feature on (the `build`
  option). No secret can leave (connection values are never read into it; a setting holding one shows only
  `set: true`, any other string holding one becomes `[hidden]`). With the `openapi` option the kit also serves the product's `GET /openapi.json`. The advisor's Switch on
  (`POST /v1/blueprint/features`, also a Portal call) switches features on, with what they need, for an Owner or
  Support admin through the usual feature report.
- **Widgets** — the product serves one public `widget.js` (the same bytes for every website). With the page's
  `data-token` it fetches the website's widget config (`GET /v1/widget/config`, browser token; admin widgets
  `GET /v1/widget/admin/config` with a ticket): texts, theme, custom CSS, switched-on features, the widgets whose
  feature is on and the product's widget settings. `@ss/app-kit/widget` mounts a widget into an open Shadow DOM with the theme and custom CSS, and
  holds what every widget builds with: the element builder, JSON calls, the admin widgets' ticket and calls, and the
  admin blocks (badges, dots, value grids, list and detail, the More menu, dialogs with typed confirmation).
- **Public docs** — `renderDocsPage` writes a product's whole `/docs` page around its own sections: the title, intro
  and localhost note, the kit's sections for the merchant's server, business.json and the API reference from
  `openapi.json`; `docsFeatureSections` writes one section per feature (its words, what it needs, what the website
  builds, its widgets and routes); `docsParagraph`, `docsBlock`, `docsList` and `docsRouteTable` write the rest.
- **Start-up** — `createProductBase(options)` builds the store, the outbound policy and `send` as `createProduct` does,
  for the product's own adapters (list settings, AI, gateways, providers) before it calls `createProduct`.
- **Shared helpers** — Format helpers come from `@ss/contracts/format` (server and widgets), HTML escaping from
  `@ss/contracts/text` `escapeHtml`; `verifyIdentityToken` checks a sign-in token offline.
- **Logging** — `createLogger()` writes JSON lines to standard output, which the host keeps: every request (method,
  path, status, time), a failed route (500, with its route and request id), a misconfiguration (503, naming the
  variables) and the kit's warnings. Members named like credentials, signed tokens and the user part of addresses are
  redacted. Each product's `route.js` passes it (below); without it nothing is logged.
- **Testing** — `@ss/app-kit/testing` has a fake Portal, an Accounts double, an in-process network,
  the memory store and `apiChecker`, which checks every answer a product's tests see against its `schemas/api.json`
  and the kit's own routes (`src/kit-api.json`), so the API descriptions cannot drift from the code.

There is no background work: everything runs inside a request or right after it (Next.js `after`). The kit has no
health or status endpoints.

## Environment

Exactly three variables (PLAN 0.11): `MONGODB_URI` (the product database), `CONNECT_SECRET` and `ENCRYPTION_KEY` (each
at least 32 characters), plus `ENCRYPTION_KEY_PREVIOUS`, set only while the owner changes `ENCRYPTION_KEY` (the old
key; removed after the Owner's Re-seal). `configFromEnv()` reads them and returns problems that name the variable,
never its value; a product with problems answers every route with 503.

## Wiring a product into Next.js

The product's Next.js app has two functions: the catch-all route below (every kit and product route, reached through
rewrites of `/.well-known/*`, `/sso`, `/widget.js`, `/docs`, `/openapi.json` and `/v1/*` to `/api/*`) and the
dashboard page, which calls the dashboard API from the browser. `adapters/product.js` makes the product
(`createProduct` with its manifest, texts, settings and hooks) and `server/routes.js` its routes, as `ss app init`
writes them.

```js
// app/api/[...path]/route.js
import { after } from 'next/server.js';
import { configFromEnv, createLogger, toNextRoute } from '@ss/app-kit';
import { createProductInstance } from '../../../adapters/product.js';
import { createRoutes } from '../../../server/routes.js';

// a missing or invalid variable is named (never its value) and every route answers 503 until it is fixed
const { config, problems } = configFromEnv();
// JSON lines in the host's logs (a failed route, a misconfiguration, the kit's warnings), secrets redacted
const product = createProductInstance({ config, problems, logger: createLogger() });

export const dynamic = 'force-dynamic';
export const { GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS } = toNextRoute(product.handler(createRoutes(product)), { after });
```

The dashboard page gets its security headers from `next.config.js` (`@ss/app-kit/headers`): it refuses every frame
(`X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`) and gets the Portal's other static
headers (HTTPS only, no type sniffing, referrer, permissions and opener policies).

```js
// next.config.js
import { dashboardHeaders } from '@ss/app-kit/headers';

const config = { /* … */ headers: async () => dashboardHeaders() };
```

## Checks

`pnpm check` runs Prettier, ESLint, `tsc --checkJs --strict` and the tests with coverage (90 % lines and functions,
85 % branches). MongoDB tests use the shared in-memory replica set (`@ss/config` `mongo: true`); widget tests run in
jsdom.
