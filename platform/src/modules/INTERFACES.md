# Module interfaces

Modules call each other only through `ctx.service(name)`. These are the public service functions each module exposes.
All functions are async, take plain objects, return plain objects, and throw `http.js` problems (RFC 9457 codes from
`@ss/contracts` plus the modules' own) on failure. Ids use `@ss/contracts` `createId` prefixes; products are keyed by
their manifest `id` (`productId`). Times on the wire are ISO-8601 UTC; money is integer millicredits.

## identity (`modules/identity`)

Admins, merchants (one login each, emails unique across both through `identity_logins`), sessions, websites and the
tokens of products on websites (PLAN 0.2, 0.4.4). Implements the `sessionActor` port.

- `getMerchant(merchantId)`, `getMerchantRecord(merchantId)` (deleted ones too), `merchantNames(ids)`,
  `billingContacts(merchantId)`, `counts()`, `getAdmin(adminId)`.
- Websites: `getWebsite(websiteId)` → `{ websiteId, merchantId, domain, status: active|removed, createdAt, removedAt }`,
  `websitesByIds(ids)` → `Map`. A website is removed only once its products are removed
  (`commerce.productsOnWebsiteCount`); then both tokens of every product it ever had are revoked, each such product
  gets `website.deleted`, and the domain is free at once.
- `dashboardAdmin(adminId)` → `{ adminId, name, role }` for a current Owner or Support admin; 422 `validation_failed`
  for anyone else, 403 `forbidden` for Finance (feature reports).
- Tokens (`identity_product_tokens`, `_id` = `<websiteId>:<productId>`): `ensureTokens({ merchantId, websiteId,
productId })` creates both tokens on the first add and keeps them afterwards (a re-add restores them). Signed with
  `@ss/protocol` `issueToken` by `ctx.keys.tokenSigner`; the browser token is stored in full, the server token sealed
  with `ctx.secretBox` (AAD website, product, jti). `tokens.reveal`, `tokens.regenerate` (revokes the old `jti` in
  `identity_revocations`, Activity, `token.revoked` notice), `installOf({ merchantId, websiteId })`; the revocations
  route answers `{ tokenIds, cursor }` (one product's revoked ids, by `revokedAt`).
- Every person's dashboard sessions end (`catalog.notifyAll({ type: 'sessions.revoked', subject })`) when a merchant is
  suspended or deleted, an admin is removed or changes role, a password is changed or reset, or a person signs out.
- `revokeTokenIds({ merchantId, websiteId, productId, jtis })` puts token ids on the revocation list (the website
  module's link tokens; the product is told with `token.revoked`). `confirmPerson({ kind, id, body, meta })` asks for a
  fresh confirmation of the signed-in person before a change a stolen session must not make (their password, and a
  code while two-step is on). `mailMerchant({ merchantId, template, data })` e-mails the merchant (false when it cannot
  be sent). When a website is removed, `website.forgetWebsite` deletes its connections and links.
- Merchant status changes call `commerce.onMerchantStatus({ merchantId, status })`, also when the status is already
  the one asked for (a repeat repairs a call that failed); a failure fails the request.

## catalog (`modules/catalog`)

Connected products, launches, notices, websites' Setup sheets and their share links. Implements the `productKeys` and
`productCalled` ports.

- `connect({ url, secret, actor })` (Add product): the connect handshake (`createConnectRequest` with
  `priceListVersion` 0 / `verifyConnectResponse`), `validateManifest` and `validatePriceReport` on the answer, the
  manifest `id` must equal the answered `productId`; stored inactive under the id; an id already connected → 409.
  The answered price list becomes the first accepted one (`commerce.recordPriceList`).
- `reconnect({ productId, url | null, secret, actor })`: same id required (409 otherwise); sends the last accepted
  version; an answered version lower than it → 409; higher → recorded as a price report; equal → nothing to record.
- `setStatus({ productId, status })`, `getProduct(productId)` → `{ productId, name, status, baseUrl, version,
widgetScriptUrl, widgetScriptLoading, docsUrl, websiteSettingsRequires, connectedAt, reconnectedAt }` (addresses from the manifest made absolute
  against the base URL; `widgetScriptLoading` `async` unless the manifest says `blocking`), `listProducts({ status? })`, `productDetail(productId)` (+ `priceListVersion`, `features` of the last accepted
  list, `numbers`), `isActive(productId)`, `directory(productId)` → `{ baseUrl }`.
- `merchantLaunch({ merchantId, websiteId, productId, session, actor })` and `adminLaunch({ productId, websiteId |
null, session, actor })` → `{ url: <baseUrl>/sso?launch=<token>, expiresAt }`: `@ss/protocol` `issueLaunch` with the
  claims of PLAN 0.4.3 (`sessionExpiresAt` = the launching session's expiry; branding and support contact from
  Settings). Merchant launches: the website must have the product (not removed); refused for suspended merchants
  (`merchant_suspended`). Admin launches: Owner or Support only; a website that has the product, or (Owner, checked by
  the route) no website. Activity `product.dashboard_opened`. `consumeLaunch({ productId, jti })` → `{ consumed }`.
- Setup sheets (`setup`, owner request 2026-10-14, `ss.blueprint/1`): `setup.sheet({ merchantId, websiteId, fresh?,
download?, actor })` → `{ sheet, domain }`: every product on the website asked at once for its part
  (`GET <baseUrl>/v1/blueprint?websiteId=`, signed with `@ss/protocol` `signPortalCall` by `ctx.keys.signer`, 5 s
  each); a product that times out, answers 5xx or 4xx, or answers no product blueprint (`@ss/contracts`
  `validateProductBlueprint`) is `{ reachable: false, reason: timeout | unreachable | refused | invalid }`; the Portal
  adds the domain, the status the website's products have (`website.status`, `commerce.productsStatus`), `https://<domain>`
  as the allowed origin, the testing hosts, each product's address (`apiBase`), browser token and script tag and
  `serverToken: { issued: true }` (never a server token). The products as gathered are kept in the
  instance's memory 60 s per website (`fresh` gathers again); Activity `website.setup_opened` or
  `website.setup_downloaded`. The sheet's header (`website.business`: `found`, name, country, time zone) is the
  website's settings in the Portal (`website.document`; `found` once something was saved there), not anything a
  product answers. Every sheet carries the website's business profile (`website.profile`: the advisor's own answers
  in `catalog_setup_profiles`, plus the countries (`region.countriesServed`) and languages (the codes of
  `region.languages`) of the website's settings, the one place for them; null when there is nothing) and, per reachable product, the advisor's view (`core/advisor.js` over
  `@ss/contracts` `adviseFeatures`): `recommended` `[{ feature, on, because, why }]` and `notRecommended`
  `[{ feature, missing, why }]`. `setup.saveProfile({ merchantId, websiteId, profile | null, actor })` → the sheet
  (null removes it; Activity `website.setup_profile_saved`; `countries` and `languages` are refused with 422: they are the
  website's settings). `setup.switchOn({ merchantId, websiteId, productId,
feature, actor })` (Owner, Support) → `{ added, sheet }`: the product (on the website, else 404) is asked to switch
  the feature on with what it needs (`POST <baseUrl>/v1/blueprint/features?websiteId=` `{ features, admin: { id,
name, role } }`, signed, 10 s); it reports the switch like its Features page (`acceptFeatures`, Activity
  `product.features_changed`); a refusal is 422 `catalog_switch_refused` with the product's words, no answer or a
  failure 502 `upstream_error`; then the sheet is gathered again. Share links (`catalog_setup_links`, only the
  SHA-256 of a 256-bit key; 1–30 days, default 7; at most 50 in use per website): `setup.createLink({ merchantId,
websiteId, days, values, install, actor })` → `{ link, url }` (the key only in the URL fragment,
  `/shared-setup#key=`; Activity `website.setup_shared`), `setup.listLinks(…)` (not expired, revoked too),
  `setup.revokeLink(…)` (Activity `website.setup_share_revoked`), `setup.shared({ key })` → the copy without values
  and/or install details as the link says, with `share` (404 for a key never made, expired or revoked; Activity
  `website.setup_share_opened` at most once an hour per link, by the system).
- Notices: `notify(productId, { type, websiteId?, subject? })`, `notifyAll(body)`; each is queued in `catalog_notices`
  (an identical waiting one is not queued twice) and sent right after the request (at once outside one), signed with
  `signNotice` by `ctx.keys.signer`, to `<baseUrl>/.well-known/ss-events`. 2xx drops it; anything else keeps it for
  `deliverNotices(productId)` (the `productCalled` port: oldest first, stops at the first refusal).

## commerce (`modules/commerce`)

Products on websites, the price and feature reports and status responses of PLAN 0.4.12, and credits and billing
(PLAN 0.5).

- Products on websites (`commerce_products`, `_id` = `<websiteId>:<productId>`, status `added | removed`):
  `addProduct({ merchantId, websiteId, productId, actor })` (active connected products not yet on the website;
  `identity.ensureTokens`; switches all off, and a re-add raises `featuresVersion` by one so a product that missed the
  removal resets its own; `recordProductAdded`; Activity `product.added`; `status.changed`),
  `removeProduct(…)` (status removed; `recordProductRemoved`; Activity `product.removed`; `status.changed`; works even
  when the product cannot be reached), `productsForWebsite(merchantId, websiteId)` → cards `{ productId, name, status,
featuresOn, featuresVersion, hourlyCost, dailyCost, addedAt }` (removed excluded), `productOnWebsite(websiteId,
productId)`, `productsOnWebsite(websiteId)`, `productsOnWebsiteCount(websiteId)`,
  `merchantWebsitesWithProduct(merchantId, productId)`.
- Reports: `recordPriceList({ productId, prices })` (validated; version must be higher, 409; stored in
  `commerce_price_lists` with Portal time; Activity `product.prices_changed` as reported by the product, except for the
  first list), `priceListVersion(productId)`, `currentPriceList(productId)`, `acceptFeatures({ productId, websiteId,
body })` (row 3 refusals: unknown key or a key without price or a dependency off 422, never-existed or deleted
  website 404 `website_not_found`, version not higher 409, `identity.dashboardAdmin`; then `recordSwitches` and
  Activity `product.features_changed` with the Portal's name of the admin).
- `statusFor({ productId, websiteId })` → the status response (checks the merchant first; `validUntil` ≤ 5 minutes and
  never after `graceEndsAt`). `websitesOfProduct({ productId, cursor })` → `{ items, cursor }` (removed excluded),
  `productWebsitesView(…)` (+ `featuresOn`, `dailyCost`), `productNumbers(productId)` / `allProductNumbers()` →
  `{ productId, websites, earnedThisMonth, days: [{ day, amount }] × 30 }`.
- `onMerchantStatus({ merchantId, status })`: suspension history (no second entry for a repeat) + `status.changed` to
  the merchant's products. That history alone decides whether the merchant's products are suspended.
- **Money histories** (0.5.7 a, Portal time): price lists, product added / removed, switches, suspended / resumed,
  grace started, stopped. **The money function** (`core/money.js`, pure): `replay`, `billingStateOf`,
  `merchantStatusOf`, `productStatusOf`, `isLowBalance`, `daysLeftOf`, `usageRows`, `dayCharges`.
- **Ledger** (`commerce_ledger`, append-only, hash-chained): `receipt` (+) and `day_charge` (−, one per website ×
  product × UTC day, `day:<websiteId>:<productId>:<day>`). `verifyChain(merchantId)`.
- **Check** `check(merchantId)` (0.5.7): settles, writes complete days, records grace starts and stops once (and sends
  `status.changed` for them), caches the state and sends billing emails once per state. It reads from the settled
  point on only, and never waits more than a second for a busy ledger (it then answers live and writes nothing). Views
  run it:
  `billingSummary`, `usage`, `receiptsOf`, `dayChargesOf`, `billingSummaries`, `attention`, `allReceipts`, `charges`.
  `creditsAddedThisMonth()` sums every receipt of the current UTC month (admin Overview).
  `productsStatus(merchantId)` → the status the merchant's products on websites have now (`active`, `grace`, `stopped`,
  `suspended`; low balance counts as active), for the Setup sheet's `website.status`.
  `addReceipt(…)` (a receipt that ends grace or a stop sends `status.changed`).

## system (`modules/system`)

Settings, the public branding, Activity and the admin Overview (`overview()` → counts, `creditsAddedThisMonth` (every
receipt of the UTC month, summed in the database), `mailConfigured`, per-product numbers `products: [{ productId, name,
status, websites, earnedThisMonth, days }]`, recent Activity). Settings →
Encryption key → Re-seal (`reseal`, Owner) seals every stored secret again with the current `ENCRYPTION_KEY`: the
system store's signing keys and mail password, and `identity.resealSecrets()` (server tokens, two-step secrets), each
counted per part; the answer's `unreadableIn` names the parts with values neither key opens.

## website (`modules/website`)

The website settings: the facts every product of one website shares (`@ss/contracts` `ss.website-settings/1`: business,
brand and theme, region and Format, pages and legal texts, team), kept once here and delivered to every product on the
website (settings-ownership design, steps 2–4).

- `get({ merchantId, websiteId })` → `{ settings, readiness, website: { websiteId, domain } }`: the document (version 0 and empty until the first save)
  and, per product on the website, what its manifest `websiteSettings.requires` still finds empty
  (`[{ productId, name, requires, missing }]`). The website must be the merchant's and active, else 404.
- `save({ merchantId, websiteId, section, version, value, actor, requestId, ip })` → `{ settings, readiness }`:
  replaces one section (`business`, `brand`, `region`, `pages`, `team`). `version` must be the one the person read (409
  `conflict` otherwise); the section is tidied (`tidyWebsiteSection`) and the whole document checked
  (`validateWebsiteSettings`, 422 with JSON Pointer paths); a save that changes nothing writes nothing. A save raises the
  version by one, writes Activity `website.settings_saved` (`after: { section, version, changed: [field names], values }`;
  `values` only for brand, region and pages, small before/after pairs) and queues `website.settings_changed` (`what:
'settings'`) for every product on the website; a product that cannot be reached never fails the save.
- `changes({ merchantId, websiteId, viewer })` → `{ items: [{ at, section, version, changed, who }] }`: Recent changes,
  newest first, field names only; an admin is shown to a merchant under the Branding name.
- `document(websiteId)` → the saved document (an empty one, version 0, until the first save), for the Portal's own parts
  (not scoped to a merchant: the caller has checked the website): the Setup sheet's header and the advisor's countries and
  languages.
- `versionOf(websiteId)` → the save counter (0: none yet), which the status answer carries as `settingsVersion`.
- `forProduct({ productId, websiteId, since })` → `{ version, settings }`: `settings` is the document when `version >
since`, else null. Only for an active website that has the product (404 `website_not_found` otherwise).
- Rights: `website_settings.read` and `.write` for the merchant (own websites), Owner and Support; Finance none. Only a
  signed-in session writes: no `/v1/product/*` route does.

### Connections and links (settings-ownership steps 6 and 7)

One MongoDB connection and one S3-compatible storage connection per website, entered once here (Website settings ›
Data and files), and the keys between the website's products (Between your products). The sealed values never leave in
a console answer: a person sees only `set` and how each product's own test of it went.

- `connectionsView({ merchantId, websiteId })` → `{ version, database: { set, setAt }, storage: { set, setAt, publicBaseUrl? }, products:
[{ productId, name, database: { name, overridden, state } | null, storage: { folder, required, state } | null }],
links: [{ caller, callee, state: on|idle|off, scopes: [{ scope, name, description }], delivered }] }` (`state` of a
  connection: `not_set`, `waiting`, `connected`, `test_failed`). The routes add `can: { write }`.
- `saveConnection({ merchantId, websiteId, name, value, names?, actor, requestId, ip })`, `removeConnection(…)`:
  `name` is `database` or `storage`; the value is checked (a MongoDB string; a bucket with its region and keys, and optionally the bucket's public https address `publicBaseUrl`, kept
  as a plain copy next to the sealed value and delivered inside `storage`), sealed
  with `ctx.secretBox` (AAD website, name and the value's own counter) and kept; the version rises by one; Activity
  `website.connection_saved` / `website.connection_removed` (never a value); every product on the website that needs it
  gets a `website.settings_changed` notice (`what: 'connections'`) and the merchant an e-mail (`connection_changed`). `names`
  (`{ productId: databaseName }`) is the Owner's override of a product's database name (default `ss_<productId>`).
  The routes (`PUT …/connections/:name`, `POST …/connections/:name/remove`) need a fresh password confirmation.
- `connectionsForProduct({ productId, websiteId })` → `{ version, database?, storage?, links: { out, in } }`:
  `GET /v1/product/websites/:websiteId/connections`, signed by the product; only what its manifest `needs`, with its
  own database name and storage folder. Fetches that carry secrets are limited to 6 an hour per product and website
  (429) and each is logged (`website.connections_delivered`). `reportConnectionHealth({ productId, websiteId, name,
version, ok, message? })` is the product's report of its own test (`PUT …/connections/:name/health`); the Portal never
  opens the merchant's database or bucket.
- `connectionsVersionOf(websiteId)` → the one counter of connections and links, carried by the status answer as
  `connectionsVersion` (a product fetches again when it is ahead of the copy it holds).
- Links: `recomputeLinks(websiteId)` (called when a product is added or removed and when features are accepted) works out
  every link from the manifests' `links.needs` and `links.offers` and the features that are on: a link's scopes are the
  union of the scopes offered by the callee that the caller needs while the needing features are on (no features listed:
  always). A link with nothing to grant is `idle` (its key stays, with no scopes). `regenerateLink`, `switchLink`
  (`POST …/links/:callee/:caller/regenerate|switch`, password confirmation) revoke the old key; removing a product or the
  website revokes and deletes its links. The key is a signed `link` token (`@ss/protocol`: `kind: link`, `caller`, the
  callee as `productId`, the website; no scopes inside): the callee asks the Portal's grant, kept in its own database.
- `forgetWebsite({ merchantId, websiteId })` and `resealSecrets()` (Settings → Encryption key → Re-seal now counts the
  website connections and the link tokens too).
- Rights: `connections.read` and `connections.write` for the merchant (own websites), Owner and Support; Finance none.
  No `/v1/product/*` route writes a connection or a link, so a stolen product key or server token changes nothing.

## Product API routes (`/v1/product/*`, `auth: 'product'`)

| Route                                                          | Module   |
| -------------------------------------------------------------- | -------- |
| `PUT /v1/product/prices`                                       | commerce |
| `PUT /v1/product/websites/:websiteId/features`                 | commerce |
| `GET /v1/product/websites/:websiteId/status`                   | commerce |
| `GET /v1/product/websites/:websiteId/settings`                 | website  |
| `GET /v1/product/websites/:websiteId/connections`              | website  |
| `PUT /v1/product/websites/:websiteId/connections/:name/health` | website  |
| `GET /v1/product/websites?cursor=`                             | catalog  |
| `GET /v1/product/revocations?since=`                           | identity |
| `GET /v1/product/directory`                                    | catalog  |
| `GET /v1/product/directory/:productId`                         | catalog  |
| `POST /v1/product/launch/consume`                              | catalog  |

Console routes (`/v1/merchants/...`, `/v1/admin/...`, `/v1/me`, `/v1/auth/...`) belong to the module owning the entity.
The Setup sheet routes are the catalog's (it calls the products): `GET /v1/merchants/:merchantId/websites/:websiteId/setup`
(`?fresh=1`, `?download=1`), `GET|POST …/setup/links`, `DELETE …/setup/links/:linkId` (merchant: own; Owner and
Support: `tokens.manage`), and the public `POST /v1/setup/shared { key }` (30 per minute per address; `X-Robots-Tag:
noindex, nofollow`, `Referrer-Policy: no-referrer`).
