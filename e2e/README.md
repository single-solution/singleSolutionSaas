# @ss/e2e — system tests

Tests that need two or more deployables: every product against the **real** Portal, in process, on one
MongoMemoryReplSet. Each test bootstraps staff (password + TOTP), connects the product through Admin → Apps → Add product
(product URL + connect secret), activates it, signs a merchant up, adds a website, credits and a subscription, connects the merchant's
resources and drives the product's own flow through the Event Hub, then checks usage and hourly settlement.

| Test                              | Product(s)                                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `tests/alerts-portal.test.js`     | `@ss/product-alerts`                                                                                  |
| `tests/chatbot-portal.test.js`    | `@ss/product-chatbot`                                                                                 |
| `tests/coupons-portal.test.js`    | `@ss/product-coupons`                                                                                 |
| `tests/deals-portal.test.js`      | `@ss/product-deals`                                                                                   |
| `tests/loyalty-portal.test.js`    | `@ss/product-loyalty`                                                                                 |
| `tests/reviews-portal.test.js`    | `@ss/product-reviews`                                                                                 |
| `tests/signups-portal.test.js`    | `@ss/product-signups` + `@ss/product-loyalty` (bring-your-own identity)                               |
| `tests/storefront-portal.test.js` | `@ss/product-storefront` (element pack: signed upload, compile, budget, the loader running in a page) |

They use only public entry points: `@ss/platform/testing` (`createPortal`, the module factories, `loadConfig`,
`totpCode`, `closeMongoClients`) and each product's `./serve` export (`startServer`, `loadManifest`, `ROOT`; element packs: `./pack` with `loadManifest`, `packAssets`). This
workspace is private and is never deployed; it has no source of its own, so coverage is measured by each unit's own
run, not here.

```sh
pnpm --filter @ss/e2e check   # from the root; or `pnpm check` in this folder
```

The products are served over https on localhost with a throw-away certificate (`openssl` must be on the PATH; the
tests are skipped without it).
