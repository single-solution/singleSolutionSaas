# Ecommerce — deep feature audit (planning only)

**Depth:** **35 features** · settings schemas (some heavy: checkout 19 props, loyalty 14, returns 13, seo 15) · 11 widgets · 16 permissions · storage + AI connections · categories · `store_details` = Portal mirror only.

|             | Today  | Target                           |
| ----------- | ------ | -------------------------------- |
| Features    | **35** | **~18–22**                       |
| Widgets     | 11     | 11                               |
| Permissions | 16     | 16 (remap parents where demoted) |

Largest product — many features are **real** (catalog, checkout, loyalty). Debt is catalog **modes**, shopper **chrome**, admin **tools** sold as peers, and **store_details** as a fake product.

---

## 1. Short: remove / demote / merge / keep / add

### Remove as peer features

| Remove           | Goes under                             | Moves                                                                                           |
| ---------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `store_details`  | **Always on** with shop (or Catalog)   | Public `/v1/shop/store` from Portal website settings — **no merchant toggle**; not a capability |
| `variants`       | **Catalog**                            | variant model on when catalog sells options                                                     |
| `size_charts`    | **Catalog**                            | charts list + defaultChartId                                                                    |
| `multi_location` | **Catalog**                            | stock-per-location mode                                                                         |
| `grades_serials` | **Catalog**                            | condition grades / units                                                                        |
| `measured_sales` | **Catalog** + checkout                 | decimal units                                                                                   |
| `wishlist`       | **Shopper extras** or Catalog settings | widget wishlist                                                                                 |
| `compare`        | **Shopper extras**                     | widget compare                                                                                  |
| `alerts`         | **Shopper extras**                     | back-in-stock / price-drop; Notifications                                                       |
| `csv`            | **Admin tools**                        | import/export                                                                                   |
| `bulk_actions`   | **Admin tools**                        | bulk edit + perms                                                                               |
| `events`         | **Admin tools** / integrations         | event API + forward                                                                             |
| `staff_alerts`   | **Checkout** / Orders desk             | Notifications; team.recipients                                                                  |
| `llms_txt`       | **SEO**                                | llms.txt settings                                                                               |
| `landing_pages`  | **SEO**                                | depends on seo today — fold as SEO subsection                                                   |
| `role_pricing`   | **Offers** / Checkout                  | Accounts roles % off — setting under pricing                                                    |
| `courier_apis`   | **Delivery**                           | under delivery_zones or Delivery feature                                                        |

### Keep as real features

| Keep                                    | Why                                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Catalog**                             | Core; widgets product_*; catalog.edit; storage                                                            |
| **Checkout** (cart & orders)            | Core; cart, my_orders, orders_admin; many order perms                                                     |
| **Digital goods**                       | Distinct fulfillment                                                                                      |
| **Bookings / services**                 | Distinct fulfillment                                                                                      |
| **Delivery zones**                      | Fulfillment geography (+ absorb courier or keep thin)                                                     |
| **Taxes**                               | Fiscal                                                                                                    |
| **Coupons / Deals / Bundles / Loyalty** | Offer capabilities (+ promotions_admin) — KEEP as four or merge to **Promotions** with types (**REVIEW**) |
| **Reviews**                             | Moderation + shopper                                                                                      |
| **Returns**                             | Claims workflow + returns.manage                                                                          |
| **Invoices**                            | Docs generation                                                                                           |
| **SEO**                                 | Patterns + absorb landing/llms                                                                            |
| **Feeds**                               | Google/Meta catalogs                                                                                      |
| **AI copy**                             | conn `ai`                                                                                                 |
| **Reports**                             | reports.read                                                                                              |
| **Import**                              | migration                                                                                                 |

### Add

| Add                                       | Where                                                       |
| ----------------------------------------- | ----------------------------------------------------------- |
| **Catalog options** settings block        | variants, locations, grades, size charts, measured          |
| **Shopper extras** (optional one feature) | wishlist, compare, alerts — or three settings under Catalog |
| **Admin tools** bundle                    | csv, bulk, events (or always-on with catalog)               |
| Kill `store_details` toggle               | routes always available when Ecommerce placed               |

---

## 2. Deep by category

### Your store

| Key             | Evidence                                                                          | Verdict                            |
| --------------- | --------------------------------------------------------------------------------- | ---------------------------------- |
| `store_details` | Reads Portal website settings only; GET shop/store + business-json; **no own DB** | **REMOVE feature** — always-on API |

### Products

| Key              | Settings / notes                           | Verdict            |
| ---------------- | ------------------------------------------ | ------------------ |
| `catalog`        | 10 props; ~7 route areas; storage; widgets | **KEEP**           |
| `variants`       | ∅ schema; depends catalog                  | **DEMOTE** Catalog |
| `size_charts`    | defaultChartId                             | **DEMOTE** Catalog |
| `multi_location` | ∅                                          | **DEMOTE** Catalog |
| `grades_serials` | ∅                                          | **DEMOTE** Catalog |
| `digital_goods`  | downloadLimit; storage; depends checkout   | **KEEP**           |
| `bookings`       | leadMinutes, daysAhead                     | **KEEP**           |
| `measured_sales` | ∅; catalog+checkout                        | **DEMOTE** Catalog |

### Orders and checkout

| Key              | Settings / notes                                                   | Verdict                          |
| ---------------- | ------------------------------------------------------------------ | -------------------------------- |
| `checkout`       | **19** props; guests, numbers, payment window; cart/orders widgets | **KEEP**                         |
| `delivery_zones` | 8 props pickup/delivery                                            | **KEEP**                         |
| `courier_apis`   | courier string + keys                                              | **DEMOTE→Delivery** or thin KEEP |
| `taxes`          | pricesIncludeTax + rules                                           | **KEEP**                         |
| `invoices`       | 6 props                                                            | **KEEP**                         |
| `returns`        | **13** props; returns.manage                                       | **KEEP**                         |

### Offers

| Key            | Notes                 | Verdict                       |
| -------------- | --------------------- | ----------------------------- |
| `coupons`      | promotions_admin      | **KEEP** (or Promotions type) |
| `deals`        | 7 props; heavy routes | **KEEP**                      |
| `loyalty`      | **14** props          | **KEEP**                      |
| `bundles`      | —                     | **KEEP**                      |
| `role_pricing` | Accounts link         | **DEMOTE** pricing settings   |

### Shopper

| Key        | Notes                                 | Verdict           |
| ---------- | ------------------------------------- | ----------------- |
| `reviews`  | moderation; widget path via customers | **KEEP**          |
| `wishlist` | widget                                | **DEMOTE** extras |
| `alerts`   | channels; Notifications               | **DEMOTE** extras |
| `compare`  | widget                                | **DEMOTE** extras |

### Search / SEO

| Key             | Notes                        | Verdict       |
| --------------- | ---------------------------- | ------------- |
| `seo`           | **15** props                 | **KEEP**      |
| `landing_pages` | 12 props; depends seo        | **MERGE→SEO** |
| `feeds`         | 10 props                     | **KEEP**      |
| `ai_copy`       | tone/language/words; AI conn | **KEEP**      |
| `llms_txt`      | 4 props                      | **MERGE→SEO** |

### Admin

| Key            | Notes                           | Verdict                    |
| -------------- | ------------------------------- | -------------------------- |
| `staff_alerts` | events, adminUrl; Notifications | **DEMOTE** Checkout/Orders |
| `reports`      | widget/perm                     | **KEEP**                   |
| `events`       | API/forward                     | **DEMOTE** Admin tools     |
| `csv`          | delimiter; csv.run              | **DEMOTE** Admin tools     |
| `bulk_actions` | bulk.run, data.delete_all       | **DEMOTE** Admin tools     |
| `import`       | ss-import                       | **KEEP**                   |

---

## 3. Target shape (~20)

**Core:** Catalog · Checkout · Digital goods · Bookings · Delivery · Taxes · Returns · Invoices  
**Offers:** Coupons · Deals · Bundles · Loyalty _(or one Promotions — open)_  
**Shopper:** Reviews · _(extras as settings)_  
**Marketing:** SEO · Feeds · AI copy  
**Ops:** Reports · Import · _(admin tools settings)_

---

## 4. Work order + risks

1. **Remove `store_details` feature gate** — always expose store/business-json when product placed.
2. Catalog options demotion (variants, locations, grades, size, measured).
3. Shopper extras + admin tools demotions.
4. SEO absorb landing + llms.
5. Decide Promotions merge vs four offer features.
6. staff_alerts / role_pricing / courier fold.

**Risks:** high — 35 keys in `featuresOn`, 16 perms’ `feature` parents, 11 widgets’ feature arrays, Chat shop_* links, Growth/Payments links, importer mappings, huge e2e. Migrate flags carefully (OR old child keys → parent on).

**Open questions:**  
(a) One **Promotions** vs keep coupons/deals/bundles/loyalty separate for pricing?  
(b) Wishlist/compare/alerts — one **Shopper extras** feature or pure settings?  
(c) Courier APIs worth own feature for key management?

---

_End deep Ecommerce audit._
