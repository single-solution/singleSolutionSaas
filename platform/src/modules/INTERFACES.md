# Module interfaces

Modules call each other only through `ctx.service(name)`. These are the public service functions each module exposes.
All functions are async, take plain objects, return plain objects, and throw `http.js` problems (RFC 9457 codes from
`@ss/contracts` plus the modules' own) on failure. Ids use `@ss/contracts` `createId` prefixes; products are keyed by
their manifest `id` (`productId`). Times on the wire are ISO-8601 UTC; money is integer millicredits.

## identity (`modules/identity`)

Admins, merchants (one login each, e-mails unique across both through `identity_logins`), sessions, websites and the
tokens of products on websites (PLAN 0.2, 0.4.4). Implements the `sessionActor` port.

- `getMerchant(merchantId)`, `getMerchantRecord(merchantId)` (deleted ones too), `merchantNames(ids)`,
  `billingContacts(merchantId)`, `counts()`, `getAdmin(adminId)`, `suspendMerchant`, `resumeMerchant`.
- Websites: `getWebsite(websiteId)` → `{ websiteId, merchantId, domain, status: active|removed, createdAt, removedAt }`,
  `listWebsites(merchantId)` (active), `websitesByIds(ids)` → `Map`, `createWebsite`, `removeWebsite` (only once its
  products are removed: `commerce.productsOnWebsiteCount`; then both tokens of every product it ever had are revoked,
  each such product gets `website.deleted`, the domain is free at once).
- `dashboardAdmin(adminId)` → `{ adminId, name, role }` for a current Owner or Support admin; 422 `validation_failed`
  for anyone else, 403 `forbidden` for Finance (feature reports).
- Tokens (`identity_product_tokens`, `_id` = `<websiteId>:<productId>`): `ensureTokens({ merchantId, websiteId,
productId })` creates both tokens on the first add and keeps them afterwards (a re-add restores them). Signed with
  `@ss/protocol` `issueToken` by `ctx.keys.tokenSigner`; the browser token is stored in full, the server token sealed
  with `ctx.secretBox` (AAD website, product, jti). `tokens.reveal`, `tokens.regenerate` (revokes the old `jti` in
  `identity_revocations`, Activity, `token.revoked` notice), `installOf({ merchantId, websiteId })`,
  `revocationsSince({ productId, since })` → `{ tokenIds, cursor }` (one product's revoked ids, by `revokedAt`).
- Every person's dashboard sessions end (`catalog.notifyAll({ type: 'sessions.revoked', subject })`) when a merchant is
  suspended or deleted, an admin is removed or changes role, a password is changed or reset, or a person signs out.
- Merchant status changes call `commerce.onMerchantStatus({ merchantId, status })`.

## catalog (`modules/catalog`)

Connected products, launches, notices. Implements the `productKeys` and `productCalled` ports.

- `connect({ url, secret, actor })` (Add product): the connect handshake (`createConnectRequest` with
  `priceListVersion` 0 / `verifyConnectResponse`), `validateManifest` and `validatePriceReport` on the answer, the
  manifest `id` must equal the answered `productId`; stored inactive under the id; an id already connected → 409.
  The answered price list becomes the first accepted one (`commerce.recordPriceList`).
- `reconnect({ productId, url | null, secret, actor })`: same id required (409 otherwise); sends the last accepted
  version; an answered version lower than it → 409; higher → recorded as a price report; equal → nothing to record.
- `setStatus({ productId, status })`, `getProduct(productId)` → `{ productId, name, status, baseUrl, version,
widgetScriptUrl, docsUrl, connectedAt, reconnectedAt }` (addresses from the manifest made absolute against the base
  URL), `listProducts({ status? })`, `productDetail(productId)` (+ `priceListVersion`, `features` of the last accepted
  list, `numbers`), `isActive(productId)`, `directory(productId)` → `{ baseUrl }`.
- `merchantLaunch({ merchantId, websiteId, productId, session, actor })` and `adminLaunch({ productId, websiteId |
null, session, actor })` → `{ url: <baseUrl>/sso?launch=<token>, expiresAt }`: `@ss/protocol` `issueLaunch` with the
  claims of PLAN 0.4.3 (`sessionExpiresAt` = the launching session's expiry; branding and support contact from
  Settings). Merchant launches: the website must have the product (not removed); refused for suspended merchants
  (`merchant_suspended`). Admin launches: Owner or Support only; a website that has the product, or (Owner, checked by
  the route) no website. Activity `product.dashboard_opened`. `consumeLaunch({ productId, jti })` → `{ consumed }`.
- Notices: `notify(productId, { type, websiteId?, subject? })`, `notifyAll(body)`; each is queued in `catalog_notices`
  (an identical waiting one is not queued twice) and sent right after the request (at once outside one), signed with
  `signNotice` by `ctx.keys.signer`, to `<baseUrl>/.well-known/ss-events`. 2xx drops it; anything else keeps it for
  `deliverNotices(productId)` (the `productCalled` port: oldest first, stops at the first refusal).

## commerce (`modules/commerce`)

Products on websites, the price and feature reports and status responses of PLAN 0.4.12, and credits and billing
(PLAN 0.5).

- Products on websites (`commerce_products`, `_id` = `<websiteId>:<productId>`, status `added | removed`):
  `addProduct({ merchantId, websiteId, productId, actor })` (active connected products not yet on the website;
  `identity.ensureTokens`; switches all off; `recordProductAdded`; Activity `product.added`; `status.changed`),
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
- `onMerchantStatus({ merchantId, status })`: suspension history + `status.changed` to the merchant's products.
- **Money histories** (0.5.7 a, Portal time): price lists, product added / removed, switches, suspended / resumed,
  grace started, stopped. **The money function** (`core/money.js`, pure): `replay`, `billingStateOf`,
  `merchantStatusOf`, `productStatusOf`, `isLowBalance`, `daysLeftOf`, `usageRows`, `dayCharges`.
- **Ledger** (`commerce_ledger`, append-only, hash-chained): `receipt` (+) and `day_charge` (−, one per website ×
  product × UTC day, `day:<websiteId>:<productId>:<day>`). `verifyChain(merchantId)`.
- **Check** `check(merchantId)` (0.5.7): settles, writes complete days, records grace starts and stops once (and sends
  `status.changed` for them), caches the state and sends billing e-mails once per state. Views run it:
  `billingSummary`, `usage`, `receiptsOf`, `dayChargesOf`, `billingSummaries`, `attention`, `allReceipts`, `charges`.
  `addReceipt(…)` (a receipt that ends grace or a stop sends `status.changed`).

## system (`modules/system`)

Settings, the public branding, Activity and the admin Overview (`overview()` → counts, `mailConfigured`, per-product
numbers `products: [{ productId, name, status, websites, earnedThisMonth, days }]`, recent Activity).

## Product API routes (`/v1/product/*`, `auth: 'product'`)

| Route                                          | Module   |
| ---------------------------------------------- | -------- |
| `PUT /v1/product/prices`                       | commerce |
| `PUT /v1/product/websites/:websiteId/features` | commerce |
| `GET /v1/product/websites/:websiteId/status`   | commerce |
| `GET /v1/product/websites?cursor=`             | catalog  |
| `GET /v1/product/revocations?since=`           | identity |
| `GET /v1/product/directory/:productId`         | catalog  |
| `POST /v1/product/launch/consume`              | catalog  |

Console routes (`/v1/merchants/...`, `/v1/admin/...`, `/v1/me`, `/v1/auth/...`) belong to the module owning the entity.
