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
  ended grace period into stopped, and keeps the last status for 24 hours while the Portal cannot be reached.
- **Notices** — `POST /.well-known/ss-events`: `status.changed` (the status is fetched again right after the answer; a
  `removed` status turns the website's switches off, so a re-add starts with every feature off), `token.revoked`,
  `sessions.revoked`, `website.deleted`.
- **Reports** — price reports (Prices screen, and once after a deploy that changed the feature list) and feature
  reports (Features screen); switches are saved only after the Portal accepts.
- **Settings** — one value per website × setting with global defaults and schema defaults; widget texts with the same
  placeholders as the English text; the theme (colours, font, radius, mode, custom CSS); the Format (locale, currency
  display, whole units, times). Every change goes to Recent changes.
- **The merchant's server** (PLAN 0.8.10 K1–K4, K9) — the settings API (`/v1/features`, `/v1/settings`, `/v1/texts`,
  `/v1/theme`, `/v1/format`, `/v1/lists`, `/v1/connections`) with a merchant's rights; the acting user named by
  `SS-Actor-*` headers; visitor calls with the server token (`SS-Visitor-IP`, their own rate window); counts of lists
  (`countHandlers`); the activity log (`GET /v1/activity`).
- **Events, staff alerts and imports** (K5, K6, K10) — events kept 30 days and forwarded through Notifications; staff
  alerts to recipients, Accounts staff with a permission and the assignee; checked, idempotent NDJSON import routes.
- **Format and time zone** (K7, K8) — `formatMoney`, `formatDate` and the calendar helpers from `@ss/contracts`, fed by
  the website's Format and its business.json time zone (`product.format(websiteId)`, the widget config).
- **Connections** — the merchant's database, storage, provider keys and pasted tokens, encrypted with a key derived
  from `ENCRYPTION_KEY`, write-only, tested live when saved. `callProduct` calls another product with a pasted token.
- **Merchant database** — guarded access (`websiteId` on every query, no cross-collection stages, inserts stamped
  with `websiteId` and `merchantId`; Atlas Search only as a first `$search` whose compound filter pins the website) to
  collections `ss_<product id>_<name>`.
- **business.json**, **data rights** (`POST /v1/data-rights/export|delete`), the **activity log** with copies to
  Accounts, **Recent changes**.
- **Product dashboard** — `GET /sso?launch=` sessions, the switcher, roles and the dashboard API every product's
  `app/` pages call.
- **Widgets** — the product serves one public `widget.js` (the same bytes for every website). With the page's
  `data-token` it fetches the website's widget config (`GET /v1/widget/config`, browser token; admin widgets
  `GET /v1/widget/admin/config` with a ticket): texts, theme, custom CSS, switched-on features and the product's
  widget settings. `@ss/app-kit/widget` mounts a widget into an open Shadow DOM with the theme and custom CSS.
- **Testing** — `@ss/app-kit/testing` has a fake Portal, Accounts and Notifications doubles, an in-process network and
  the memory store.

There is no background work: everything runs inside a request or right after it (Next.js `after`). The kit has no
health or status endpoints.

## Environment

Exactly three variables (PLAN 0.11): `MONGODB_URI` (the product database), `CONNECT_SECRET` and `ENCRYPTION_KEY` (each
at least 32 characters). `configFromEnv()` reads them and returns problems that name the variable, never its value; a
product with problems answers every route with 503.

## Wiring a product into Next.js

The product's Next.js app has two functions: the catch-all route below (every kit and product route, reached through
rewrites of `/.well-known/*`, `/sso`, `/widget.js`, `/docs` and `/v1/*` to `/api/*`) and the dashboard page, which
calls the dashboard API from the browser.

```js
// app/api/[...path]/route.js
import { after } from 'next/server';
import { configFromEnv, createProduct, toNextRoute } from '@ss/app-kit';
import manifest from '../../../manifest.json' with { type: 'json' };
import strings from '../../../strings/en.json' with { type: 'json' };
import { routes } from '../../../api/routes.js';

const { config, problems } = configFromEnv();
const product = createProduct({ manifest, strings, config, problems });
export const { GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS } = toNextRoute(product.handler(routes), { after });
```

## Checks

`pnpm check` runs Prettier, ESLint, `tsc --checkJs --strict` and the tests with coverage (90 % lines and functions,
85 % branches). MongoDB tests use the shared in-memory replica set (`@ss/config` `mongo: true`); widget tests run in
jsdom.
