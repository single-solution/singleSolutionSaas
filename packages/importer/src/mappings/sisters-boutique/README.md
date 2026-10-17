# Sisters Boutique mapping (`sisters-boutique`)

`ss-import read --mapping sisters-boutique` (this folder; PLAN 0.8.10 Migration, "Per store" SB;
owner go of 2026-10-14) reads SB's MongoDB as its Mongoose models keep it (`packages/db/src/models` at 8f809d8) into
Accounts and Ecommerce, and SB's settings for Accounts, Ecommerce, Notifications, Payments and Growth. SB has no chat,
reviews, returns, stock alerts, wishlists or analytics collection, so nothing goes to Chat or Growth records.
`fixture.js` holds SB-shaped sample records with fake values (`sbSource`) covering every
kind and the edge cases below; the tests read them through the mapping, send and verify them, and run every record,
setting and list through the products' own import checks, settings schemas and list checks (read from this repository).

**What is read** (find only, `_id` order): `settings` (only the `store.*` rows, the SEO rows SB reads and the
`integration.staffNotifyEmail`, `adminSiteUrl` and `awsS3PublicUrlBase` rows; never a row holding a password, token or
key), `users`, `customers`, `membershiprequests`, `activityentries`, `sizecharts`, `categories`, `brands`, `attributes`,
`seosurfaces`, `products`, `offers`, `orders` and `loyaltyaccounts`. Not read: `otpcodes` (sign-in codes, Migration "Not
imported") and every other `integration.*` row.

**How each kind comes in**

| SB                                        | Product                                   | Rules                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (code)                                    | Accounts `roles` `member`                 | the premium member role: no permissions, rank 800, phone + password only, always remembered 30 days, rolling sessions                                                                                                                                                                                                                                                                                                                           |
| `customers` with a password or `isMember` | Accounts `users` `usr_<customer hex>`     | bcrypt hash kept (A1); role `member` (`roleSince` = `memberSince`) or `customer` (a password without membership); phone E.164 and verified when a password was set (SA-1); `identity: phone`; addresses (the street is the first line, else the area, else the city; one default)                                                                                                                                                               |
| `users` (staff)                           | Accounts `users` `usr_<hex>`              | bcrypt hash, verified email, `identity: email`; role kept (Accounts has the same ready-made roles), `isSuperAdmin` → `owner`, unknown → `support_staff`; inactive → blocked; the phone kept (A16) unless a member has it or it is not a number                                                                                                                                                                                                  |
| `membershiprequests`                      | Accounts `requests` `rrq_<hex>` + `users` | pending, invited (SB's `expired` too: Accounts judges the expiry; none given → expired at its invitation), completed (its member's user), declined; each invited phone that is not a member's gets one invited `member` user (id from a hash, never the phone)                                                                                                                                                                                  |
| `activityentries`                         | Accounts `copies` `act_<hex>`             | action `<resource type>.<action>`, target the record's new id (else SB's id, else the type), actor the staff user (else anonymous) (IMP-30)                                                                                                                                                                                                                                                                                                     |
| `sizecharts` + SB's built-in chart        | Ecommerce `size_charts`                   | columns and rows (values of the chart's columns only, as text; `-` keys kept, CA-16); the built-in "Standard Women's Size Guide" becomes a chart and `size_charts.defaultChartId` (SF-3)                                                                                                                                                                                                                                                        |
| `categories`                              | Ecommerce `categories`                    | inactive → `hidden` (PL-12); content, icon, SEO, FAQs, default size chart                                                                                                                                                                                                                                                                                                                                                                       |
| `brands`                                  | Ecommerce `brands`                        | one per slug (SB keeps one per category set; Ecommerce's brand slugs are unique per website): the categories of its active records, active when one is                                                                                                                                                                                                                                                                                          |
| `attributes`                              | Ecommerce `attributes`                    | one per SB record, the definition for its category (E45), on variants, choices; `attribute` visibility → always (IMP-46); `multiple` when a variant holds several values                                                                                                                                                                                                                                                                        |
| `seosurfaces`                             | Ecommerce `landings`                      | the copy SB shows (overrides first), `indexable: auto` (SG-30); a brand no longer there leaves it out                                                                                                                                                                                                                                                                                                                                           |
| `products`                                | Ecommerce `products`                      | archived, active, or a draft when hidden or without variants (CA-2); photos as storage keys (the address's path) with their smaller copies, size and blur; video (YouTube or https address, else a file key); variants in paisa with stock, sold out and warranty; attribute values by attribute id (stale keys cleared, IMP-28; a product-only value keeps its label, SF-5); attribute setup; SEO addresses made https or a site path (IMP-39) |
| `offers`                                  | Ecommerce `deals`                         | see "Offers" below                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `customers`                               | Ecommerce `customers` `cus_<hex>`         | one per E.164 phone (+92): duplicates merge (the member's record wins; notes and "seen" markers joined; the first day kept), and their orders and points follow (CU-6)                                                                                                                                                                                                                                                                          |
| `orders`                                  | Ecommerce `orders` `ord_<hex>`            | see "Orders" below                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `loyaltyaccounts`                         | Ecommerce `loyalty`                       | lots rebuilt oldest first: earn, bonus and positive adjustments credit; redeem, expire and negative adjustments debit (a reversal from its order's lot first); SB's give-backs and reversals become `refund` and `reverse` entries; one correcting entry where SB's stored balance differs (IMP-5); merged customers' accounts join                                                                                                             |

**Offers** (as SB's `offerEvaluator.ts` applies them): an offer with item conditions is an item deal (`target: items`,
`allowPoints: true`, PR-5): its scenarios (an `or` group of `and` groups) become condition groups (`match: any`), slugs
and SB ids becoming ids; an attribute slug kept in several categories names each of its records; an empty scenario is
dropped (it matches nothing in SB; an empty group would match everything); the minimum quantity stays; cart totals and
payment methods are dropped (SB ignores them for item offers). An offer with only cart-total and payment conditions is a
checkout offer (`target: cart`, cart total in paisa, `bank-transfer` → `bank_transfer`, `card` → `online`, its points
flag kept). Weekdays and hours stay; the end minute counts (`timeTo` one minute later); `sort` = `sortOrder` and
`priority` = the creation day (newer first, as SB orders them); `usageLimit` ≤ 0 is no limit (IMP-34). Switched off:
hours that end before they start (SB never runs them, D5, PR-16), offers without conditions and checkout offers whose
amount is not on the cart total (SB never applies them). Left out (counted by `read` as "left out"): buy X get Y (SB never
applies it), and rule shapes a deal cannot hold (a cart total at most, nested shapes the editor does not write,
different price ranges per scenario, more than 10 groups, IMP-12). `DEAL_HOURS_SHIFT_MINUTES` (0) becomes 300 once SB's
server clock is confirmed as UTC, so deals run at the same real time in Asia/Karachi (PR-14).

**Orders**: numbers kept (`IM-<year>-<4 digits>`); statuses keep their keys, with their roles in the `order_flow` list
(plus an `awaiting-confirmation` no SB order enters); money × 100; SB's stored discount (offers and the member
discount) and points make its total, so the discount `subtotal − (total − delivery − fee)` is spread over the lines by
their amounts (IMP-10) and the points' value is part of it; a payment entry by the status rule ("Imported": bank transfer
and card at the first `confirmed` entry, cash on delivery at the last `delivered` one, none for a canceled or free
order) and a refund entry for a refunded one (IMP-13); `deliveredAt` from the last `delivered` entry (IMP-9); the
idempotency key, else `import:<hex>` (IMP-23); stock held while SB holds it, never on a released order; points credited
once delivered, reversed when a delivered order was canceled or refunded, given back once canceled, refunded or
returned (IMP-49); the staff "seen" markers (owner quirk 7); each line's category and brand from its product (IMP-17); the
dispatch video (http made https); a timeline that does not end at the order's status gets a closing entry.

**Settings** (`settings.js`): every setting of every feature SB has on (`FEATURES`), SB's saved row else its code
default (`packages/shared/src/storeSettings.ts`, the line in a comment), written explicitly (RT-15): Format (whole
rupees, `Rs`, `en`, shop times), phone +92 / trunk 0, members invite-only (`phone_password.signUp: false`), passwords
8–128 with a letter and a digit, the owner's lock answer (`networkLimit` 8, `maxAttempts` 20, `lockMinutes` 1), no
shopper messages and no card (D5), bank transfer by hand and cash on delivery with its fee, free delivery over the
threshold, the totals rules (`total_half_up`, `first`, `one_after_items`, `after_item_deals`, `cart_offer`,
`goods_after_discounts`), loyalty (1 point = Rs 1, earned on the total at placement, guests too, `returnPoints: keep`),
staff alerts, SEO, the Google feed, landing pages, the payments' bank details and Growth's tags, robots and notice bar;
lists `order_flow`, `role_prices` (the member discount), `couriers` and `delivery_zones` (one zone for every place: Pickup, and the flat fee as the Standard rate free over the threshold). `PENDING` lists the
settings written before their PLAN item is built (E39): until then the products refuse them as "No such setting".

**Entered by hand** (the per-store table, `send --settings <file>`): the feature switches (`FEATURES`, and `import`);
the website's settings in the Portal (Website settings: business facts, brand, region and format, pages, alert team; set once
for every product, so the plan writes none of them: `PORTAL_BY_HAND` lists SB's values, such as country PK, currency PKR,
calling code +92, `timeZone: Asia/Karachi`, the Format and the alert team); the website's database and storage in the Portal
(Website settings › Data and files; `PORTAL_CONNECTIONS_BY_HAND`: one string and one bucket for every product); every secret; and, when SB has no saved row for them
(`BY_HAND`), the values only its deployment holds: `catalog.mediaBaseUrl` (`AWS_S3_PUBLIC_URL_BASE`),
`staff_alerts.adminUrl` (`ADMIN_SITE_URL`), and the public site address for `staff_links.setupPageUrl` and
`robots_verification.sitemaps`. After E47 is built: `loyalty.memberFlag: first_order`
together with each customer's flag from SB's `isLoyaltyMember` (left out until both exist, so no customer loses their
points). After E46: guests' saved addresses (SB keeps them on the customer; until then only members' addresses move).

**Refused, and why** (each shows in the dry run or in `read`'s counts):

- SB's setup links: Accounts' links carry their record id, so an invited person needs a new link (D6, A3).
- Text over a product limit is refused, never cut (IMP-31): names over 120 (customers, members; SB allows 160), staff
  names over 120 (SB 200), address areas over 100, address labels over 40, deal names over 120, deal slugs over 80, badges
  over 40, deal SEO titles over 120, activity labels over 200.
- A member phone two SB customers share in different forms: Ecommerce merges them; Accounts keeps one user per phone and
  refuses the second member.
- Photo addresses: keys are their paths, shown from `catalog.mediaBaseUrl`; photos on another host (Vercel Blob,
  Unsplash, Pexels) need copying into the bucket first (Migration step 4, not built): check the hosts on the live copy.
- An order whose customer is gone, a courier order without an address, totals that do not add up.

**Doubts to settle on the live copy**: whether SB's offers ever overlap (`lineChoice: first` against priority by
creation day: offers made the same day with the same `sortOrder` may rank differently); SB's member discount is not kept
apart from offers in its orders (`roleDiscount` 0, invoices show it as offers); the staff alert list (product and
marketing managers by email, the others through `orders.read`); SB's free-shipping item offers count as Ecommerce's one
checkout-level deal; SB's moves the order flow cannot hold yet (delivered → canceled, dispatched → refunded, between
closed statuses: E40, not in the go).
