# @ss/app-kit API

Three entries: `@ss/app-kit` (server), `@ss/app-kit/widget` (browser, no Node.js imports) and `@ss/app-kit/testing`.

## `@ss/app-kit`

| Export                                                                                                    | What it is                                                                                                 |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `configFromEnv(env?) → { config, problems }`                                                              | reads `MONGODB_URI`, `CONNECT_SECRET`, `ENCRYPTION_KEY`; problems name the variable, never its value       |
| `createProduct(options) → product`                                                                        | wires the kit (below)                                                                                      |
| `defineRoute(definition) → route`                                                                         | checks and freezes a route definition (below)                                                              |
| `ok(body, { status?, headers? })`                                                                         | JSON answer (default 200); handlers may also return a plain value (200), `undefined` (204) or a `Response` |
| `created(body, { location?, headers? })`                                                                  | 201                                                                                                        |
| `noContent()`                                                                                             | 204                                                                                                        |
| `problem(code, detail?, { errors?, headers?, extensions? })`                                              | RFC 9457 problem with a stable code from `@ss/contracts` or `problemCodes`; return or throw it             |
| `paginate({ cursor?, limit?, url? }, { defaultLimit?, maxLimit? })`                                       | cursor pagination: `{ limit, after, fetchLimit, page(items, keyOf?), link(next), respond(items, keyOf?) }` |
| `toNextRoute(handler, { after?, stripPrefix? })`                                                          | `{ GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS }` for a Next.js catch-all route; strips `/api`            |
| `createLogger({ level?, write?, now?, fields? })`, `noopLogger`                                           | JSON-lines logger; credential-like fields are redacted                                                     |
| `createMongoStore({ db, prefix?, now? })`                                                                 | the product database store on MongoDB (collections `kit_*`)                                                |
| `createMemoryStore({ now? })`                                                                             | the same store in memory (development and tests)                                                           |
| `formatText(text, values?)`                                                                               | fills `{placeholders}` of a widget text (plain text)                                                       |
| `actorOf(ctx, fallback)`, `parseActor(headers)`, `ACTOR_HEADERS`                                          | who acts: the ticket's user, else the `SS-Actor-*` user of a server-token call (K2), else `fallback`       |
| `countHandlers({ source, by })` → `{ count, counts }`                                                     | handlers of a list's `/count` and `/counts?by=` routes (K4; `COUNT_CAP`, `MAX_GROUPS`, `COUNT_TIMEOUT_MS`) |
| `formatMoney`, `formatDate`, `zonedParts`, `zonedDay`, `zonedDayStart`, `DEFAULT_FORMAT`, `IMPORT_LIMITS` | from `@ss/contracts` (K7, K8, K10)                                                                         |
| `KIT_GUIDE`                                                                                               | the docs sections about the kit's server routes, for each product's `/docs`                                |

### `createProduct(options)`

| Option                                    | Meaning                                                                                                                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest`                                | `manifest.json` (checked with `@ss/contracts` `validateManifest`; `id` is the product id)                                                                                                                                       |
| `strings`                                 | English widget texts, `strings/en.json` (`{ key: text }`)                                                                                                                                                                       |
| `config`                                  | `configFromEnv().config`                                                                                                                                                                                                        |
| `problems`                                | `configFromEnv().problems`: when any, every route answers 503 `unavailable` with `problems`                                                                                                                                     |
| `store`                                   | product database store; default `createMongoStore` on `config.mongodbUri`                                                                                                                                                       |
| `fetch`                                   | Portal calls (default `globalThis.fetch`)                                                                                                                                                                                       |
| `now`, `randomBytes`, `logger`, `nodeEnv` | clock, randomness, logger, environment name                                                                                                                                                                                     |
| `outbound`                                | `@ss/net` policy options for addresses merchants enter (`allowHosts` ignored in production)                                                                                                                                     |
| `outboundSend`                            | replaces `@ss/net` `safeFetch` for those calls (tests)                                                                                                                                                                          |
| `problemCodes`                            | the product's own problem codes `{ code: { status, title } }`                                                                                                                                                                   |
| `hooks`                                   | `{ exportUser?(ctx, user) → records, deleteUser?(ctx, user) → { deleted, anonymised }, widgetConfig?(ctx) → settings }` (data rights; the widgets' settings, never secrets)                                                     |
| `connections`                             | `{ <name>: { label, neededBy: [featureKeys], kind: 'database' \| 'storage' \| 'secret' \| 'token', productId?, secretField?, test?(value, { websiteId, send }) → { ok, message? } } }`; a `database` connection is always there |
| `data`                                    | `{ indexes?, createClient? }`: merchant database indexes (created on a website's first use per instance)                                                                                                                        |
| `lists`                                   | `{ <name>: { feature, title, get(websiteId), save(websiteId, value) → { ok, value } \| { ok: false, errors } } }`: list settings the settings API serves (K1)                                                                   |
| `events`                                  | `true` when the product publishes events (K5): `ss_<product>_events` (TTL 30 days), forwarded through Notifications                                                                                                             |
| `imports`                                 | `{ collections: { <name>: { check(record, ctx) → { ok, value } \| { ok: false, errors }, collection? } }, finish?(ctx) }` (K10)                                                                                                 |

The returned `product`:

| Member                                                                                                                               | What it does                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest`, `problems`                                                                                                               | the manifest; configuration problems                                                                                                                                                                            |
| `handler(routes, { after? }) → (Request) => Promise<Response>`                                                                       | every kit route plus the product's routes                                                                                                                                                                       |
| `serving(websiteId) → { ok: true, status } \| { ok: false, problem }`                                                                | the status check every website route runs                                                                                                                                                                       |
| `featuresOn(websiteId) → string[]`                                                                                                   | switched-on feature keys                                                                                                                                                                                        |
| `reportPrices({ prices: { key: millicreditsPerHour }, actor })`                                                                      | price report (version = accepted + 1), saved only after a 2xx                                                                                                                                                   |
| `reportFeatures({ websiteId, on, actor: { id, name } })`                                                                             | feature report (version = `featuresVersion + 1`), switches saved only after a 2xx                                                                                                                               |
| `settings.values(websiteId, feature)`, `settings.texts(websiteId)`, `settings.theme(websiteId)`                                      | resolved values for product code and widgets                                                                                                                                                                    |
| `connections.value(websiteId, name)`                                                                                                 | the decrypted value (server side only; never return or log it)                                                                                                                                                  |
| `connections.storage(websiteId, name?)`                                                                                              | S3-compatible storage (`presignPut`, `presignGet`, `headObject`, `deleteObject`, `fullKey`) or null                                                                                                             |
| `callProduct(websiteId, productId, path, { method?, body?, headers? })`                                                              | calls another product with its pasted server token: `{ ok: true, status, body }` or `{ ok: false, reason: 'not_connected' \| 'refused' \| 'unavailable' \| 'unreachable' \| 'failed' }`                         |
| `data.forWebsite(websiteId, { merchantId? })`                                                                                        | guarded merchant database: `{ websiteId, prefix, collection(name), ensureIndexes(defs), transaction(fn) }`                                                                                                      |
| `business(websiteId)`                                                                                                                | business.json copy with defaults (`name` = domain, `timeZone` UTC)                                                                                                                                              |
| `activity.record(ctx, { actor: { kind, id, name?, role? }, action, target, label?, detail? }, { copy? })`                            | activity log entry in the merchant database, copied to Accounts after the request (`copy: false` keeps it local)                                                                                                |
| `format(websiteId)` → `{ format, timeZone, money(amount, currency), date(value, style?) }`                                           | the Format and business time zone, with formatters for text the server makes (K7, K8)                                                                                                                           |
| `events.emit(ctx, type, data)`, `events.list`, `events.count`, `events.counts`                                                       | record an event (`<product>.<type>`; forwarded after the request) and the handlers of `GET /v1/events` and its counts (K5)                                                                                      |
| `staffAlerts.send(ctx, { feature, event, values, assignee? })`                                                                       | alert the merchant's staff through Notifications, template `<product>.staff_<event>` (K6)                                                                                                                       |
| `imports.upsert`, `imports.finish`, `imports.status`                                                                                 | the handlers of `POST /v1/import/:collection?dryRun=1`, `POST /v1/import/finish` and `GET /v1/import/status` (K10)                                                                                              |
| `recentChanges.record({ websiteId \| null, who: { kind, id, name, role? }, what, detail })`, `recentChanges.list(websiteId \| null)` | Recent changes                                                                                                                                                                                                  |
| `identity.verify({ websiteId, token, connection })`                                                                                  | verifies a merchant's own sign-in token against the issuer kept in a connection `{ issuer, jwksUrl, audience?, subjectClaim?, emailClaim?, phoneClaim? }`                                                       |
| `accounts.verify({ websiteId, token })`                                                                                              | an Accounts sign-in of the website, verified offline with the keys fetched through the pasted Accounts token: `{ ok: true, user: { id, email?, phone?, name?, role?, permissions? } }` or `{ ok: false, code }` |
| `address()`                                                                                                                          | this product's own address (the base URL it was connected with), or null before connect                                                                                                                         |
| `close()`                                                                                                                            | closes pooled merchant database connections                                                                                                                                                                     |

### Route definitions

`defineRoute({ method, path, auth, feature?, permission?, database?, idempotent?, rateLimit?, rawBody?, maxBodyBytes?,
roles?, handler })`

- `auth`: `browser` (browser token in `Authorization: Bearer`; Origin required and allowed; CORS for it, which also allows the
  `SS-Sign-In`, `SS-Guest` and `SS-Order-Key` headers; without an Origin, the server token: a visitor call from the
  merchant's server with `SS-Visitor-IP`, required on writes, in its own window of 3,000 requests per minute per route
  per website plus the per-visitor limits), `server` (server token; refused with an Origin header; no CORS; optional
  `SS-Actor-*` headers name the acting user, 400 `invalid_actor` when malformed), `ticket` (ticket bound to the
  request's Origin; CORS for it), `dashboard` (session cookie), `none`.
- `feature` (browser, server, ticket): 403 `feature_off` while off; a list works while any of them is on; ticket routes
  default to their permission's feature.
- `permission` (ticket): the ticket must carry it.
- `database` (browser, server, ticket; default true): 403 `database_not_connected` until the `database` connection is
  saved.
- `idempotent`: a repeated `Idempotency-Key` for the same website and route within 24 hours answers 409
  `duplicate_request`.
- `rateLimit`: `{ limit, windowSeconds, per?: 'website' | 'visitor', bucket? }` or a list of them (code constants);
  routes with the same `bucket` share a counter.
- `roles` (dashboard): `merchant`, `owner`, `support` (default all).

Every website route also checks the status: 403 `product_unavailable` with `reason` (stopped, suspended, removed), 503
`portal_unreachable` after 24 hours without the Portal, and 401 `invalid_token` for every token or ticket failure.

`ctx` (handler argument): `request`, `requestId`, `method`, `path`, `params`, `query`, `searchParams`, `headers`,
`idempotencyKey`, `body`, `rawBody`, `origin`, `websiteId`, `merchantId`, `status`, `token`, `ticket`, `actor` (K2),
`visitor` (`{ server, ip }`, K3), `clientIp`, `session`, `after(task)`, `data()` (the guarded merchant database), `log`.

### Routes the kit serves

| Route                                                                                                                                                     | Auth                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `POST /.well-known/ss-connect`                                                                                                                            | connect HMAC (none)                              |
| `POST /.well-known/ss-events`                                                                                                                             | Portal signature (none)                          |
| `POST /v1/tickets` `{ user: { id, name, email }, permissions, origin }` → `{ ticket, expiresAt }`                                                         | server                                           |
| `GET /v1/permissions` → `{ permissions: [{ key, name, feature }] }` (for Accounts roles)                                                                  | server (no database)                             |
| `POST /v1/data-rights/export` / `delete` `{ user: { id?, email?, phone? } }`                                                                              | server (database)                                |
| `GET /v1/widget/config` → `{ texts, theme, customCss, format, timeZone, features, settings }` (`features`: switched on; `settings`: `hooks.widgetConfig`) | browser (database, no feature)                   |
| `GET /v1/features`, `GET /v1/settings`, `PUT\|DELETE /v1/settings/:feature.:setting` (`{ value }`)                                                        | server (no database; K1)                         |
| `GET /v1/texts`, `PUT\|DELETE /v1/texts/:key`, `GET\|PUT /v1/theme`, `GET\|PUT /v1/format`, `GET\|PUT /v1/lists/:list` (`{ value }`)                      | server (no database; K1)                         |
| `GET /v1/connections`, `PUT\|DELETE /v1/connections/:name`, `POST /v1/connections/:name/test` (writes: 60 per minute per website)                         | server (no database; K1)                         |
| `GET /v1/activity?actor=&action=&target=&q=&from=&to=&cursor=&limit=`, `GET /v1/activity/count`, `GET /v1/activity/counts?by=`                            | server (database; K9)                            |
| `GET /v1/widget/admin/config` → the same, for admin widgets                                                                                               | ticket (database, no feature)                    |
| `GET /sso?launch=` → 303 to `<dashboard>?websiteId=<id>` or `?view=defaults`, `ss_session` cookie                                                         | none                                             |
| `GET /v1/dashboard/session` → `{ who, portalUrl, branding, support, expiresAt, switcher }`                                                                | dashboard                                        |
| `GET /v1/dashboard/websites/:websiteId/overview`                                                                                                          | dashboard                                        |
| `GET\|PUT …/features` (PUT `{ on }`: Owner, Support)                                                                                                      | dashboard                                        |
| `GET …/settings`, `PUT\|DELETE …/settings/:feature.:setting` (`{ value }`)                                                                                | dashboard (merchants: switched-on features only) |
| `GET …/texts`, `PUT\|DELETE …/texts/:key`                                                                                                                 | dashboard                                        |
| `GET\|PUT …/theme` (fields; `null` resets one)                                                                                                            | dashboard                                        |
| `GET\|PUT …/format` (fields; `null` resets one)                                                                                                           | dashboard                                        |
| `GET …/connections`, `PUT\|DELETE …/connections/:name`, `POST …/connections/:name/test`                                                                   | dashboard                                        |
| `POST …/business/refresh`                                                                                                                                 | dashboard                                        |
| `GET /v1/dashboard/defaults`, `PUT /v1/dashboard/defaults/:key` (`<feature>.<setting>`, `text.<key>`, `theme`, `format`; `{ value }`, `null` removes)     | dashboard, Owner                                 |
| `GET\|PUT /v1/dashboard/prices` (`{ prices: { key: millicreditsPerHour } }`)                                                                              | dashboard, Owner                                 |

Dashboard writes are refused unless their Origin is the product's own address; dashboard and `/sso` answers carry
`X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`.

## `@ss/app-kit/widget`

| Export                                                                                                                        | What it is                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `mountWidget({ host, theme?, css?, customCss?, render }) → { root, shadow, update({ theme?, customCss? }), unmount() }`       | open Shadow DOM with the theme variables, product CSS and custom CSS          |
| `themeCss(theme)`                                                                                                             | the `:host` rule: `--ss-color-<name>`, `--ss-font-family`, `--ss-radius`      |
| `formatText(text, values?)`                                                                                                   | fills `{placeholders}`                                                        |
| `formatMoney(amount, currency, format, viewer)`, `formatDate(value, format, { timeZone, style, viewer })`, `viewerOf(window)` | the kit's one formatter with the widget config's `format` and `timeZone` (K7) |

The host gets `data-ss-mode="light" | "dark"` (`auto` follows the device).

## `@ss/app-kit/testing`

| Export                                        | What it is                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------------- |
| `createFakePortal({ url?, now?, pageSize? })` | the Portal side of PLAN 0.4.12 (async)                                                  |
| `createAccountsDouble({ url? })`              | receives activity copies; serves keys and users with a permission; calls data rights    |
| `createNotificationsDouble({ url? })`         | takes events (`POST /v1/events`) and messages (`POST /v1/messages/<channel>`)           |
| `createNetwork(handlers)`                     | `{ fetch, send }` routing to in-process handlers by origin (`send` fits `outboundSend`) |
| `createMemoryStore({ now? })`                 | the memory store                                                                        |

Fake Portal members: `url`, `jwks`, `handle(request)`, `fetch`, `setReachable(bool)`, `connect({ handler, baseUrl,
secret, priceListVersion? })`, `addProduct({ productId, baseUrl })`, `addWebsite({ domain, websiteId?, merchantId?,
merchantName?, status?, graceEndsAt?, todayMillicredits? })`, `setStatus(websiteId, patch)`, `deleteWebsite(websiteId)`,
`features(websiteId, productId)`, `addAdmin({ id, name, role })`, `issueToken({ websiteId, productId, kind })`,
`revoke(jti)`, `issueLaunch({ productId, kind, websiteId?, role?, adminId?, adminName?, sessionExpiresAt? })`,
`signNotice(body)`, `sendNotice(productId, body)`, `prices(productId)`, `priceReports`, `featureReports`, `calls`.

Accounts double (`createAccountsDouble({ url?, now? })`) members: `url`, `handle(request)` (activity copies, `GET /v1/websites/:websiteId/keys`, `GET /v1/users?permission=&blocked=`), `copies`, `signIn({ websiteId, sub, ttlSeconds?, …claims })`, `setFailing(bool)`, `setUsers(list)`, `userReads`, `exportUser({ handler, baseUrl, token,
user })`, `deleteUser(…)`.

Notifications double (`createNotificationsDouble({ url? })`) members: `url`, `handle(request)`, `events`
(`{ token, key, body }`; a repeated `Idempotency-Key` answers 409), `messages` (`{ token, channel, body }`),
`setFailing(bool)`.
