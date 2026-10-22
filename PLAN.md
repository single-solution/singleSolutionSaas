# Single Solution — Master Engineering, Architecture & UI/UX Specification

**Date:** October 22, 2026  
**Branch:** `main` (all other branches merged and deleted; workspace typechecks cleanly across all 16 packages)  
**Purpose:** Complete, file-by-file engineering and design audit + execution specification for the developer. All legacy notes (`HANDOFF.md`, `CLAUDE.md`, `audit/`) have been removed. This document is the single source of truth.

---

## 0. Core Product Rules (Non-Negotiable)

1. **What Single Solution Is:**
   - A modular, multi-product SaaS platform where a merchant brings their own website and attaches our products (**Accounts, Ecommerce, Chat, Notifications, Payments, Growth**, and future verticals like **Bookings**) via lightweight `<script>` widgets and `/v1` APIs.
   - **The Portal is the account and website control center—never a shop.** The Portal never shows a product catalog, shopping cart, orders list, customer list, or chat inbox. Everyday business operations happen on the merchant's own website and admin via our widgets.
2. **What Is Permanently Out of Scope (Do Not Build, Delete Where Present):**
   - **No multi-language switching or per-language catalogs.** A website has one set of widget texts written in whatever language the merchant wants.
   - **No multi-currency selling.** One currency per website.
   - **No subscriptions or stored-value gift cards.**
   - **No third-party chat inbox channels** (no WhatsApp/Instagram/Messenger/SMS-to-inbox chat; WhatsApp and SMS are only for outbound notifications and OTPs via Notifications).
   - **No CSV/Shopify/WooCommerce self-serve store importer in the UI** (`@ss/importer` stays a CLI tool for internal store cut-overs only).
   - **No pasted tokens between our products.** When two of our products are on the same website, the Portal links them automatically with scoped keys.
3. **One Website = Primary Domain + Subdomains (`www` and custom subdomains):**
   - `shop.com`, `www.shop.com`, `book.shop.com`, and `admin.shop.com` belong to **one** website record, sharing the same `websiteId`, products, database, credits, and browser token. Only a different root domain (`other.com`) is a separate website.
4. **Hosting:**
   - Runs on Vercel Hobby + MongoDB Atlas M0 today (no background timers or crons required; work runs on request or `after()`). Moving to AWS is for later scale—do not re-architect for AWS now.

---

## 1. Dead Code, Rejected Features & Whole Subsystems to Delete First

Before touching any UI polish, delete the code that should not exist. Keeping it forces the developer to maintain dead schemas, routes, and tests.

### 1.1 Delete the "Setup Sheet / Business Profile Advisor / Shared Blueprint" Subsystem (~3,000 lines)

- **What it is today:** A giant questionnaire (_"What do you sell? How do shoppers pay? Are you moving?"_) that computes recommendation tags (`pays.online+countries.za`), scores all 99 features as `recommended` or `ruled_out`, exports a `ss.blueprint/1` JSON file, and creates expiring public share links (`/shared-setup`).
- **Why it must go:** It duplicates the Portal Website page and every product's Overview checklist, and adds a second place where features are explained and switched on.
- **Files & code to delete:**
   - `platform/src/console/views/setup.js` (1,160 lines) and `platform/test/console/setup-page.test.js`
   - `platform/src/modules/catalog/setup.js` (456 lines) and `platform/src/modules/catalog/core/setup.js` (215 lines)
   - `packages/contracts/src/profile.js` (310 lines) and `packages/contracts/src/schemas/blueprint.js`
   - `packages/app-kit/src/blueprint.js` (445 lines)
   - Remove `/shared-setup` from `PUBLIC_PATHS` and `websiteSetup`, `setup`, `setupLinks`, `setupProfile`, `setupFeatures`, `setupLink`, `sharedSetup` from `platform/src/console/paths.js` and `platform/src/console/admin/paths.js`.
   - Remove `recommendFor` arrays from `products/*/manifest.json` and `blueprint` hooks from `products/*/adapters/product.js`.
- **What replaces it:** When an admin adds a product to a website (or opens a product with 0 features on), show 3–4 one-click **Starter Presets** (e.g., _Standard Physical Shop_, _Used/Graded Electronics Shop_, _Digital & Services_) that turn on the right feature switches immediately.

### 1.2 Delete Multi-Language & Multi-Currency Leftovers Across All Units

- **Portal Website Settings (`packages/contracts/src/website-settings.js` & `platform/src/console/views/website-settings-sections.js`):**
   - Remove `region.languages` (list of 20 languages), `region.currencies` (list of 20 currencies), `region.countriesServed` (list of 250 countries), and `region.format.currencySymbols` (20-row currency symbol map drawer).
   - Keep only single values: `region.country`, `region.timeZone`, `region.currency`, `region.language` (single locale tag for formatting), `region.units`, and `region.phone.callingCode`.
- **Notifications (`products/notifications/`):**
   - Delete feature `multi_language` from `products/notifications/manifest.json`, `products/notifications/schemas/multi_language.settings.json`, and `products/notifications/app/dashboard/categories.js`.
   - Simplify `StopKeywordsCard` in `products/notifications/app/dashboard/lists.js` to a single list of stop words for the website instead of per-language rows.
- **Chat (`products/chat/`):**
   - Delete feature `language_lock` from `products/chat/manifest.json`, `products/chat/schemas/language_lock.settings.json`, and `products/chat/app/dashboard/categories.js`.
   - In `products/chat/app/dashboard/settings.js` (`FallbackAnswers`), remove per-language fallback answer variants.

### 1.3 Delete `subscriptions` from Payments

- Subscriptions are out of scope.
- **Files to delete/clean:**
   - Remove feature `subscriptions`, permissions `subscriptions.read` / `subscriptions.cancel`, and widget `subscriptions_admin` from `products/payments/manifest.json`.
   - Delete `products/payments/schemas/subscriptions.settings.json` and `products/payments/ui/subscriptions-admin.js`.
   - Remove `subscriptions` from `products/payments/app/dashboard/categories.js` and server routes.

### 1.4 Delete `store_details` from Ecommerce

- `products/ecommerce/schemas/store_details.settings.json` is an empty object `{}`.
- `products/ecommerce/app/dashboard/store-details.js` only renders a read-only card telling the user to go back to the Portal.
- **Fix:** Delete `store_details` from `products/ecommerce/manifest.json`, delete `products/ecommerce/schemas/store_details.settings.json`, delete `products/ecommerce/app/dashboard/store-details.js`, and remove `{ title: 'Your store', features: ['store_details'] }` from `products/ecommerce/app/dashboard/categories.js`.

### 1.5 Hide Internal Plumbing & Migration Switches from Product Feature Sidebars

- Today, internal APIs and CLI migration routes are exposed as billable/toggleable features in the Settings sidebar:
   - Ecommerce: `events`, `import`
   - Accounts: `activity_copies`, `import`
   - Growth: `import`
   - Notifications: `send_api`
   - Payments: `payment_api`
- **Fix:**
   - `payment_api`, `send_api`, `events`, and `activity_copies` should be built-in baseline behavior whenever the product is active on a website (not separate feature switches a merchant sees in Settings).
   - `import` (`POST /v1/import/...`) is for the `@ss/importer` CLI during store migration; keep it as an admin-only switch in the Portal Website card's `⋯` menu (_"Enable migration import"_), never a row in the merchant's product Settings sidebar.

### 1.6 Delete Unused Components & Exports in `@ss/ui`

- The following exports in `packages/ui/src/index.js` have **zero usages** across `platform/` and `products/*` (or are explicitly banned by `packages/ui/test/kit-only.test.js`):
   - `Disclosure` (`blocks.js`) — banned by `kit-only.test.js`.
   - `PillTabs` (`blocks.js` and `SchemaForm.js`) — banned by `kit-only.test.js`, and `SchemaForm` is called with `tabs={false}` everywhere.
   - `Grid` and `Col` (`blocks.js`) — unused anywhere in `platform/` or `products/*`.
   - `Masonry`, `LockedState`, `SoftBreaks` (`display.js`) — unused in `platform/` and `products/*`.
   - `Paged` component (`paged.js`) — unused (only `usePaged` hook is used).
   - `useHashSection` (`blocks.js`) — unused (`dashboard-page.js` uses `useViewHash`).
   - `ToastOnce` (`Toast.js`), `DrawerSkeleton` (`skeletons.js`), `AppFrame` and `Pane` aliases (`index.js`) — unused.
- **Fix:** Delete these dead components and their dead tests so `@ss/ui` only contains live components.

---

## 2. Cross-Product Contradictions & Duplicate Screens to Merge

### 2.1 Merge the Two Duplicate Payment-Method Editors (Ecommerce vs. Payments)

- **What is wrong today:**
   - `products/ecommerce/app/dashboard/payment-methods.js` defines a full editor for `payment_methods` (`pay_first`, `on_delivery`, `at_pickup`, fees, max order value, bank account rows `Label: value`, and proof upload).
   - `products/payments/app/dashboard/methods.js` defines **another** full editor for `manual_methods` (`pay_first`, `on_delivery`, `at_pickup`, bank account rows, and proof upload).
   - Worse, Ecommerce asks the user whether a `pay_first` method goes through Payments _"whose manual method of the same key holds its accounts"_—forcing the human to create the method in both dashboards and match their keys by hand!
- **How to fix it:**
   - Configure ways to pay **once**.
   - If **Ecommerce** is the merchant's shop checkout, Ecommerce's `PaymentMethodsEditor` is the single place where the merchant sets up Cash on Delivery, Bank Transfer (with bank account rows & proof upload), Pay at Pickup, and Online Gateway payment (which automatically uses whatever gateways are active in Payments over the Portal link).
   - Remove `manual_payments` from Payments' dashboard when Ecommerce is used, or have Ecommerce read `methods.read` from Payments automatically so bank accounts are never entered twice.

### 2.2 Merge the Two Legal / Policy Editors (Portal vs. Ecommerce)

- **What is wrong today:**
   - `platform/src/console/views/website-settings-sections.js` (`PagesSection`, lines 991–1086) has a 20,000-character legal document CMS (`documents`, `signIn`, `privacy`).
   - `products/ecommerce/app/dashboard/lists.js` (`PoliciesEditor`) has another policies editor for checkout.
- **How to fix it:**
   - Delete `documents`, `signIn`, and `privacy` from `PagesSection` in `website-settings-sections.js` and `packages/contracts/src/website-settings.js`.
   - Keep `PoliciesEditor` in Ecommerce for checkout policy snippets, and let Accounts Consents link to URLs on the merchant's website.

### 2.3 Unify the Three Opening-Hours & Holiday Editors (Portal vs. Chat vs. Ecommerce Bookings)

- **What is wrong today:**
   - Portal Website Settings → Business (`HoursEditor` in `website-settings-sections.js`) edits weekly hours + 200 holiday exceptions.
   - Chat Settings → Handoff (`OfficeHoursEditor` and `OfficeExceptionsEditor` in `products/chat/app/dashboard/settings.js`) edits weekly hours + holiday exceptions again.
   - Ecommerce Settings → Bookings (`BookingSchedulesEditor` in `products/ecommerce/app/dashboard/lists.js`) edits weekly hours + exceptions a third time.
- **How to fix it:**
   - Set business hours and holidays **once** in Portal Website Settings → Business.
   - Chat Handoff uses the website's business hours automatically (with one toggle: _"Use website business hours"_ default `true`, showing custom hours only if switched off).
   - Ecommerce Bookings defaults its schedule to the website's business hours unless a specific service/resource overrides them.

### 2.4 Unify Staff Alert Recipients (Portal vs. Products)

- **What is wrong today:**
   - Portal Website Settings → `TeamSection` (`website-settings-sections.js` lines 1094–1230) manages up to 50 staff alert recipients (`name`, `email`, `phone`), `phoneChannel` (`sms` / `whatsapp`), and `staffPush`.
   - Ecommerce (`staff_alerts.settings.json`), Chat (`staff_alerts.settings.json`), and Accounts also ask who to alert and how.
- **How to fix it:**
   - The Portal Website Settings → Team list is the single address book for staff alerts. Products read it from Website Settings; product settings only choose **which events** trigger an alert and the **admin URL template** (`https://admin.shop.com/orders/{id}`).

### 2.5 Make Extra Hosts (`www` and Subdomains) Actually Work End-to-End

- **What is wrong today:**
   - `pages.hosts` is saved in `packages/contracts/src/website-settings.js`, and `packages/ui/src/overview.js` labels it `'extra host names'`.
   - Yet `originAllowed({ origin, domain })` in `packages/protocol/src/tokens.js` (line 128) checks `canonical === https://${normalizeDomain(domain)}` and its comment says _"No subdomains"_. Any visitor widget on `https://www.shop.com` or `https://book.shop.com` is **refused with 403**!
- **How to fix it:**
   - When a website is created with primary domain `shop.com`, automatically allow `https://shop.com` and `https://www.shop.com`.
   - Allow the user to add subdomains (`*.shop.com`, e.g., `book.shop.com`, `admin.shop.com`) on the Website page. Claim each host in the Portal's `domains` collection so no two websites can claim the same host.
   - Include `hosts: string[]` in the Portal's Status response (`GET /v1/product/websites/:websiteId/status`) and update `originAllowed({ origin, domain, hosts })` in `packages/protocol/src/tokens.js` and `packages/app-kit/src/http/handler.js` to accept `domain`, `www.${domain}`, and every host in `hosts`.

### 2.6 Move `ss:purchase` Analytics Verification to the Server or Deduplicate by Order ID

- **What is wrong today:**
   - Growth learns about purchases only from the browser `CustomEvent('ss:purchase')` dispatched by `products/ecommerce/ui/cart.js` before redirecting to the payment gateway (`line 18: "before the payment page or the success page"`).
   - That means: (a) an online order that is abandoned on the payment gateway page still fires `ss:purchase` in the browser before it is paid, and (b) if the browser tab closes during a gateway redirect, a real paid order never fires!
- **How to fix it:**
   - Fire `ss:purchase` only when the order is confirmed/paid (on the thank-you/success view with the `orderId` deduplicated), or forward confirmed order totals from Ecommerce to Growth over a Portal link.

---

## 3. Replace "Database Inspector" UI with Human Interactions

### 3.1 Eliminate `IdTags` (Never Make a Human Type `cat_01h...`, `att_01h...`, or `usr_01h...`)

- **What is wrong today:**
   - Because of an old plan rule (_"dashboards never show business data"_), the product dashboards were forbidden from reading category names, custom field names, or customer names.
   - As a result, `IdTags` in `products/ecommerce/app/dashboard/lists.js` (lines 84–129) forces the user to type raw 30-character Crockford Base32 IDs (`cat_01h...`, `att_01h...`) as tags in:
      1. `products/ecommerce/app/dashboard/item-types.js` (typing `att_...` field IDs for product fields, variant fields, and unit fields).
      2. `products/ecommerce/app/dashboard/grades.js` (typing `cat_...` category IDs for primary category and allowed categories).
      3. `products/ecommerce/app/dashboard/lists.js` (`TaxRulesEditor` and `RolePricesEditor` typing `cat_...` category IDs).
      4. `products/ecommerce/ui/promotions-admin.js` (line 58: typing a raw `userId` or `customerId` string to look up a loyalty account because accounts are not listed or searchable by name/phone/email).
- **How to fix it:**
   - Add lightweight dashboard lookup endpoints (`/v1/dashboard/websites/:websiteId/lookups/categories`, `/fields`, `/item-types`) that return `[{ id, name, slug }]` from the merchant database when connected.
   - Replace `IdTags` in `item-types.js`, `grades.js`, `TaxRulesEditor`, and `RolePricesEditor` with `ChoicePicker` showing the human category/field names.
   - In `promotions-admin.js` (`loyaltyTab`), replace the raw `userId` input with a customer search box (by name, phone, or email) and a paginated list of loyalty accounts.

### 3.2 Stop Spawning 7 Browser Tabs to Configure 1 Website

- **What is wrong today:**
   - To set up one website, the user starts in the Portal (`/websites/:id`), clicks into 8 sub-pages of Website Settings, and then clicks **"Open dashboard"** on 6 product cards—which calls `POST .../launch` and opens **6 separate browser tabs** (`localhost:3001` through `3006`), each with its own `Overview`, `Settings`, `Texts`, and `Developers` tabs.
- **How to fix it:**
   - Make the **Website Page (`/websites/:id`)** in the Portal the true home of the website:
      - Top bar: Domain + Subdomains (`www`, `book.`, etc.), Status pill, Daily credit spend, and `Add product`.
      - **Tools on this Website** (Shop, Chat, Accounts, Payments, Messages, Growth): each card shows a clear green `Working` badge or the **exact one thing missing** (e.g., _"Needs database connection"_, _"Needs Stripe key"_, _"Turn on at least one feature"_), with a direct action button that opens that setting.
      - Collapse the 7 Website Settings sub-pages (`Business`, `Brand and look`, `Region and format`, `Domains, pages and legal`, `Team and alerts`, `Data and files`, `Between your products`) into **3 clean tabs/sections on the Website page**:
         1. **Business & Region** (Name, contact, address, hours, country, currency, time zone, hosts, team alert recipients)
         2. **Brand & Look** (Logo, icon, accent color, light/dark mode)
         3. **Data & Connections** (Database URI, Storage bucket, AI key, and automatic product links)

### 3.3 Stop Requiring Password + 2FA on Every Single Click in Connections

- **What is wrong today:**
   - In `platform/src/console/views/website-connections.js` (lines 113–133), saving the database asks for password + 2FA. Saving storage asks for password + 2FA. Saving the AI key asks for password + 2FA. Toggling a link asks for password + 2FA. Setting up one website's connections forces the user to type their password and 6-digit authenticator code **four times in two minutes**.
- **How to fix it:**
   - Implement a **15-minute `sudo` window** on the Portal session: once the user confirms their password (and 2FA if enabled), record `sudoUntil = now + 15 * 60 * 1000` on the session. For the next 15 minutes, sensitive actions on that session proceed without re-prompting for the password.

### 3.4 Provide One Unified Merchant Admin Widget (`data-ss-admin`)

- **What is wrong today:**
   - For a merchant's staff to run their site, the merchant has to mount **11 separate admin widgets** across their pages and wire ticket endpoints for each product separately:
      - Ecommerce: `catalog_admin`, `orders_admin`, `promotions_admin`, `customers_admin`
      - Chat: `inbox`, `knowledge_editor`, `reports`
      - Accounts: `users_admin`, `roles_admin`, `activity_admin`
      - Growth: `analytics_dashboard`, `seo_checklist`, `redirects_admin`
      - Notifications: `delivery_log`, `template_editor`, `send_message`
      - Payments: `payments_admin`, `links_admin`
- **How to fix it:**
   - Keep the individual widgets for merchants who want to embed a single panel, **and** provide a unified workspace script/mount so a merchant can place one `<div data-ss-workspace>` on their `/admin` page and get a clean sidebar with **Orders, Products, Customers, Promotions, Chat Inbox, Analytics, Users, and Messages** in one cohesive interface.

---

## 4. Screen-by-Screen Form & UX Simplification

### 4.1 Portal: Brand & Look (`platform/src/console/views/website-settings-sections.js`, lines 489–618)

- **What is wrong today:**
   - Asks the user to paste **6 raw `https://` URLs** (`logo`, `logoDark`, `icon`, `favicon`, `faviconDark`, `shareImage`) with no file upload button.
   - Has a 24-row key/value color editor (`color1: #2471e7`) where the user has to invent token names.
- **How to fix it:**
   - Show **Logo**, **Icon / Favicon**, **Accent Color** (swatch + hex input + contrast badge), **Theme Mode** (`Light`, `Dark`, `Auto`), and **Corner Radius** (`Sharp`, `Rounded`, `Pill` presets or slider).
   - Put `Dark Logo`, `Share Image`, `Font Family`, and `Custom CSS` inside an optional **More styling options** group.
   - Delete the arbitrary 24-row `theme.colors` key/value map editor—replace it with named optional color pickers (`Background`, `Text`, `Border`) only if the user overrides the defaults.

### 4.2 Portal: Region & Format (`website-settings-sections.js`, lines 645–932)

- **What is wrong today:**
   - 6 separate cards + 2 drawers (`symbols` and `regions`) with 18 controls: `country`, `timeZone`, `language`, `languages`, `countriesServed`, `currency`, `currencies`, `weight`, `size`, `locale`, `currencyDisplay`, `wholeUnits`, `times`, `currencySymbols` drawer, `callingCode`, `trunkPrefix`, `phoneCountries`, `address.required`, `address.regions` drawer.
- **How to fix it:**
   - When the user picks **Country**, automatically fill **Time zone**, **Currency**, **Calling code**, **Weight/Size units**, and **Locale** from a country defaults map.
   - Show **1 primary card** with: Country, Time zone, Currency (with `Show symbol / code` and `Hide decimals` inline), Default calling code, and Units (`kg/cm` vs `lb/in`).
   - Move `Required address fields` and `Custom delivery regions/states` to an optional section below. Delete `languages`, `currencies`, `countriesServed`, and `currencySymbols`.

### 4.3 Ecommerce: Sidebar & Feature Sprawl (`products/ecommerce/app/dashboard/categories.js` & `settings.js`)

- **What is wrong today:**
   - 33 feature switches + 6 `top: true` extra sub-pages injected by `checkout` (`Payment methods`, `Order flow`, `Reasons and files`, `Couriers`, `Policies`, `Segments`) = **39 items in the Settings sidebar**.
- **How to fix it:**
   - Do not inject 6 loose `top: true` items into the sidebar. Keep `Payment methods`, `Order flow`, `Couriers`, `Policies`, and `Reasons` as clean sub-tabs/sections inside `Orders and checkout` (or `Delivery`).
   - Move `Customer segments` (`SegmentsEditor`) into the `customers_admin` widget where staff actually filter customers by segment.
   - For a new website, show the core shop features (`Catalog`, `Variants`, `Cart and checkout`, `Delivery zones`, `Taxes`, `Coupons`, `Deals`) first, and group niche vertical features (`Grades and serials`, `Measured sales`, `Bookings`, `Digital goods`, `Role pricing`, `llms.txt`) under **Specialized Selling Modes** so a normal store is never overwhelmed.

### 4.4 Ecommerce: Order Flow Editor (`products/ecommerce/app/dashboard/flow-editor.js`)

- **What is wrong today:**
   - Exposes a raw state-machine matrix: for every status, the user has to configure `StatusRole`, `whoChoices` (`staff`, `staff_shopper`, `shopper`, `system`), `MOVE_PERMISSIONS` (`orders.manage`, `orders.refund`), `moveOptionSpecs`, and `MOVE_NEEDS` checkboxes for every transition arrow (`from → to`).
- **How to fix it:**
   - Default to the standard visual pipeline: **Placed → Confirmed → Packed → Shipped → Delivered** (plus **Canceled** & **Returned**).
   - On each step card, show only what a human cares about: Step Label, _"Send customer message on this step"_, _"Require tracking info before Shipped"_, and _"Allow customer to cancel before Packed"_.
   - Put raw transition matrix rules (`permission`, `moveOptionSpecs`, custom intermediate statuses) behind an **"Customize workflow rules"** toggle.

### 4.5 Ecommerce: Condition Grades Editor (`products/ecommerce/app/dashboard/grades.js`, 593 lines)

- **What is wrong today:**
   - Editing a condition grade (e.g., "Refurbished - Excellent") opens a drawer with **25+ inputs**: Name, Key, Condition, Return days, Warranty days, Color swatch, Offered checkbox, Description (1,200 chars), Condition video (file key or YouTube ID), Definition Category ID, Allowed Category IDs, Allowed Item Type keys, 12 Bullet points with **raw icon name strings**, Glossary SEO title, Glossary SEO description, Glossary text, and 20 FAQs.
- **How to fix it:**
   - A grade drawer needs **6 fields**: Name (e.g., _Grade A_), Condition (_New / Refurbished / Used_), Warranty days, Return window days, Badge color, and Short description.
   - If the merchant wants bullet points, let them type simple bullet lines (no raw icon name strings). Remove the 20-FAQ / SEO glossary page builder from the grade drawer.

### 4.6 Product Dashboards: Texts Tab (`packages/ui/src/dashboard-tabs.js` & `dashboard-settings.js`)

- **What is wrong today:**
   - Ecommerce has ~590 widget text strings. Clicking a widget group renders hundreds of `<Input>` boxes at once, with labels generated by splitting dot-keys (`grid.sort.price_asc` → `"Grid › Sort › Price asc"`).
- **How to fix it:**
   - Group texts by the **visible part of the widget** (e.g., _Buttons & Actions_, _Headings & Labels_, _Error Messages_), paginate or virtualize each group to at most 25 fields on screen, and add a **"Changed only"** filter chip so a merchant can immediately see and reset the words they customized.

---

## 5. Animations, Transitions, Layout & CSS Bugs to Fix

Every one of these bugs was verified directly in `packages/ui/src/` and `packages/app-kit/src/widget/`:

1. **Double / Nested `animate-ss-enter` on Every Dashboard Tab (`packages/ui/src/Page.js` line 204 + `packages/ui/src/dashboard-page.js` line 459):**
   - `Page` wraps its body in `<div key={...} className="... animate-ss-enter">`.
   - `SectionsPage` (`dashboard-page.js` line 459) **also** puts `animate-ss-enter` on every `<div id="section-...">` inside `Page`.
   - **Bug:** On initial mount, both parent and child run `ss-enter` (`opacity: 0; translate: 0 4px`) at the same time—doubling the vertical shift to `8px` and multiplying opacity (`0.5 * 0.5 = 0.25`), making text look washed out and laggy.
   - **Fix:** Remove `animate-ss-enter` from `Page.js` line 204 when `SectionsPage` handles section transitions, or only animate the inner section swap.

2. **Re-triggering Enter Animation & Losing Scroll Position on Hidden Views (`packages/ui/src/dashboard-page.js` lines 450–462):**
   - `SectionsPage` keeps visited sections mounted in `seen` and hides inactive ones with `hidden={section.id !== active}` (`display: none`) while leaving `className="... animate-ss-enter"` on the element.
   - **Bug:** Switching from Section A → Section B → Section A removes `display: none`, which forces the browser to replay the `220ms` keyframe animation from `opacity: 0` and resets the scroll container to the top.
   - **Fix:** Only apply `animate-ss-enter` on the active view container or use a fast `120ms` opacity cross-fade without `display: none` keyframe replay, and save/restore `scrollTop` per section ID in `SectionsPage`.

3. **Website Page Remounts and Refetches on Every Sub-Page Click (`platform/src/console/views/website-page.js` lines 229–232 & 529):**
   - Line 529 sets `bodyKey={own === null ? websiteId : part}`. Clicking between `settings/business`, `settings/brand`, and `settings/region` changes `bodyKey`, which unmounts the entire body and replays the page enter animation on every section click.
   - Lines 229–232 set `const onPage = own === null && !error && !gone;` and pass `onPage ? api.usage(...) : null` into `useOnce`. Because `useOnce` (`platform/src/console/views/website.js`) resets `state` to `null` whenever `path` changes from a string to `null` and back, navigating from Website Overview → Website Settings → Website Overview **wipes out the loaded usage chart and tokens and flashes loading skeletons again**!
   - **Fix:** Keep `useOnce` cache keyed by URL path so returning to Overview is instant with zero skeleton flash, and set `bodyKey={websiteId}` so switching settings sub-sections does not remount the whole page frame.

4. **Sliding Highlight Pill (`ListColumn`, `InnerNav`, `AppShell`) Misaligns on Resize or Font Load (`packages/ui/src/ListColumn.js` lines 132–147, `InnerNav.js` lines 91–106, `AppShell.js` lines 140–160):**
   - All three calculate `box.style.height = "${row.offsetHeight}px"` and `box.style.transform = "translateY(${row.offsetTop}px)"` inside `useLayoutEffect` with no `ResizeObserver`. If a row wraps or the pane resizes, the highlight pill sits at the wrong Y offset.
   - **Fix:** Attach a `ResizeObserver` to the active row and list container in `ListColumn`, `InnerNav`, and `AppShell` (or use CSS background on `[aria-selected="true"]` / `[aria-current="page"]` with View Transitions).

5. **`ss-press` (`scale: 0.98`) Shrinks Wide List Rows Horizontally (`packages/ui/src/theme.css` line 372 & `Row.js` line 117):**
   - Applying `scale: 0.98` on `:active` to a 320px-wide `Row` or a wide button shrinks its width by ~6–10px, pulling the left and right edges inward on every click.
   - **Fix:** Use `scale: 0.98` only on compact buttons (`Button`, `IconButton`, `chip`). On full-width `Row` items, use background-color tinting (`active:bg-surface-3`) instead of scaling the row box.

6. **Widget Dialogs & Drawers Snap Closed in 0ms (`packages/app-kit/src/widget/admin.js` & `admin-css.js`):**
   - Opening a widget dialog/drawer plays `ss-pop` / `ss-side`, but closing it calls `overlay.remove()` immediately with no exit animation.
   - **Fix:** Add a `data-closing` attribute with `120ms` fade/slide-out keyframes in `ADMIN_KIT_CSS` and wait for `animationend` (when `prefers-reduced-motion` is not set) before calling `overlay.remove()`.

7. **Widget Primary Button Hover Uses `filter: brightness(1.1)` (`packages/app-kit/src/widget/controls-css.js` line 147):**
   - `brightness(1.1)` washes out light merchant brand colors and makes text contrast fail WCAG AA.
   - **Fix:** Use `color-mix(in srgb, var(--ss-color-accent, #2226f7) 88%, #000000)` (in light mode) and `88%, #ffffff` (in dark mode) just like `@ss/ui` does.

8. **iOS Safari Auto-Zoom on Widget Inputs (`packages/app-kit/src/widget/controls-css.js` line 48):**
   - Widget inputs use `font: inherit`. If the host website sets body font size to `14px` (`0.875rem`), iOS Safari zooms the viewport in whenever a shopper taps an input in Sign-in, Cart, or Chat!
   - **Fix:** Set `font-size: max(16px, 1em)` on inputs, selects, and textareas inside mobile viewports (`@media (max-width: 639px)`) in `CONTROLS_CSS`.

9. **Number Inputs Change Value by Accident When Scrolling the Page (`packages/ui/src/fields.js` & `controls-css.js`):**
   - Scrolling down a long Settings page with the mouse cursor over an `<input type="number">` fires the browser's wheel increment/decrement and silently dirts the form!
   - **Fix:** In `packages/ui/src/fields.js` (`Input`) and `packages/app-kit/src/widget/controls.js`, blur or ignore `wheel` events on `input[type="number"]` (`onWheel={(e) => e.currentTarget.blur()}`).

---

## 6. Visitor & Admin Widget Upgrades

1. **One-Time Code (OTP / 2FA) Input (`platform/src/console/views/sign-in.js` & `products/accounts/ui/sign-in.js`):**
   - Build a shared 6-box visual OTP input backed by **one real `<input autocomplete="one-time-code" inputmode="numeric">`** so iOS/Android SMS autofill, paste (stripping spaces/dashes like `123-456`), Backspace, and auto-submit on the last digit all work seamlessly.
2. **Shopper Cart & Checkout Widget (`products/ecommerce/ui/cart.js`):**
   - Split the long single-column stack (`linesBox`, `couponBox`, `pointsBox`, `deliveryBox`, `address`, `paymentBox`, `fields`, `guest`, `note`, `policies`, `totalsBox`) into a clean **2-column desktop / sticky-summary mobile layout**:
      - Left column: Cart items → Delivery & Address → Payment method.
      - Right column (sticky on desktop, collapsible bar on mobile): Order summary, Coupon toggle (_"Have a promo code?"_ link that expands the input instead of showing an open box to everyone), Loyalty points toggle, and the primary **Place Order** button.
3. **Visitor Chat Mobile Keyboard Handling (`products/chat/ui/chat.js` & `styles.js`):**
   - On phones with `fullScreenOnMobile`, use `100dvh` (`height: 100dvh`) so the mobile browser toolbar and virtual keyboard never cover the message composer box.

---

## 7. Remaining Security Fixes to Complete

From the security audit, ensure these remaining items are closed:

1. **Chat & Notifications Untrusted Guest Emails:** Guests who type an unverified email address in Chat must not trigger outbound transcripts or alerts to arbitrary external addresses, and `linkValues` in Notifications must only allow links pointing to the website's own allowed hosts.
2. **PayFast Pakistan Server Verification (`products/payments`):** Confirm the paid amount server-to-server before marking a PayFast PK payment verified.
3. **Client IP Trust (`packages/net` & `packages/app-kit`):** Only trust `x-real-ip` / `x-forwarded-for` when running behind Vercel (`process.env.VERCEL === '1'`) or a configured proxy.

---

## 8. Ordered Execution Plan for the Developer

Run the work in these 6 phases. After each phase, run `pnpm check` in the touched packages so `main` stays green.

- **Phase 1 — Delete Dead Subsystems & Rejected Features:**
   1. Delete Setup Sheet / Blueprint / Business Profile Advisor (`setup.js`, `profile.js`, `blueprint.js`, `/shared-setup`, `recommendFor`).
   2. Delete multi-language & multi-currency lists (`region.languages`, `region.currencies`, `region.countriesServed`, `currencySymbols`, Notifications `multi_language`, Chat `language_lock`).
   3. Delete `subscriptions` from Payments and `store_details` from Ecommerce.
   4. Hide internal plumbing (`import`, `events`, `activity_copies`, `send_api`, `payment_api`) from merchant Settings sidebars.
   5. Delete unused `@ss/ui` exports (`Disclosure`, `PillTabs`, `Grid`, `Col`, `Masonry`, `LockedState`, `SoftBreaks`, `Paged`, `useHashSection`, `ToastOnce`, `DrawerSkeleton`).
- **Phase 2 — Fix Domains/Subdomains & Merge Cross-Product Duplicates:**
   1. Wire `pages.hosts` and `www.` into `@ss/protocol` `originAllowed` and the Portal Status response so `www` and subdomains work with one browser token.
   2. Merge Payment Methods between Ecommerce and Payments so manual methods/bank accounts are configured once.
   3. Remove the Portal Legal Document CMS (`documents`, `signIn`, `privacy` in `PagesSection`).
   4. Make Chat Handoff and Ecommerce Bookings inherit `business.hours` from the Portal by default.
   5. Make Products read staff alert recipients from the Portal's `team.recipients`.
- **Phase 3 — Replace Raw ID Inputs (`IdTags`) with Human Pickers:**
   1. Add dashboard lookup routes for categories, attributes/fields, and item types.
   2. Replace `IdTags` in `item-types.js`, `grades.js`, `TaxRulesEditor`, and `RolePricesEditor` with searchable human-name pickers.
   3. Replace the raw `userId` input in `promotions-admin.js` (Loyalty) with a searchable customer list.
- **Phase 4 — Simplify Portal & Product Forms:**
   1. Collapse the 8 Portal Website Settings sections into **3 tabs** (_Business & Region_, _Brand & Look_, _Data & Connections_) directly on the Website page.
   2. Add a 15-minute `sudo` session window in the Portal so Connections don't ask for password + 2FA on every click.
   3. Simplify Brand & Look (1 logo, 1 icon, 1 accent color, mode), Region & Format (auto-fill from country), Order Flow Editor (visual pipeline by default), Condition Grades Editor (6 core fields), and Ecommerce Settings sidebar (fold the 6 `top: true` checkout extras into clean groups).
- **Phase 5 — Fix Animations, Transitions, Scroll & CSS Bugs (`@ss/ui` & `@ss/app-kit`):**
   1. Fix double `animate-ss-enter` between `Page.js` and `dashboard-page.js`.
   2. Fix `SectionsPage` re-animating and losing scroll position when switching back to a visited section.
   3. Fix `website-page.js` `useOnce` cache reset and `bodyKey` remounting when switching between Overview and Settings.
   4. Add `ResizeObserver` to `ListColumn`, `InnerNav`, and `AppShell` sliding highlights.
   5. Remove horizontal `scale(0.98)` shrinkage on wide `Row` items; add exit animations to widget dialogs; fix widget button hover contrast; enforce `16px` mobile input font size in widgets; disable mouse-wheel changes on `<input type="number">`.
- **Phase 6 — Upgrade Visitor & Admin Widgets + Final Security Items:**
   1. Add the 6-box single-input OTP control to Portal and Accounts sign-in.
   2. Upgrade Ecommerce Cart/Checkout to a 2-column sticky-summary layout with collapsible promo code.
   3. Add the unified merchant admin workspace mount (`data-ss-workspace`).
   4. Complete the 3 remaining security items (Chat/Notifications guest email & link host checks, PayFast PK server inquiry, proxy header check).
