# Specification

Merchants keep their own website and hosting. This platform is the backend they attach: Accounts, Ecommerce, Chat, Notifications, Payments, Growth. A new store and a later conversion use the same product. A conversion is a command-line mapping in `packages/importer`, not a Portal screen. One store-specific mapping already lives under `packages/importer/src/mappings/`. It stays a mapping. It does not become a page, a preset, or a named product.

Four qualities, in this order: hard to attack, easy to operate, flexible per website, and reliable when one part fails. A small leak blocks a screen even when the layout is right. Assume a hostile visitor, a leaked script on the merchant site, a buggy or malicious product, and a stolen password.

This document is the build spec. Every screen below was opened. A claim that is only in a file comment, and not in the code under it, is marked as a comment.

Start with phase 1 and the three screens in the next section. The tables of Settings rows are the cleanup that follows those screens. They are not the design.

## The three screens

These replace the current website page (`platform/src/console/views/website-page.js`), the public share page (`SharedSetup` in `platform/src/console/views/setup.js`), and the orders widget (`products/ecommerce/ui/orders-admin.js` and `admin-order.js`). Build these. Do not add a fourth home.

### Website

One page. The merchant lands here. An admin opens the same page from a merchant.

**Header.** Domain. One status: Working, or the single thing wrong (no database, a product stopped, credits stopped). Daily cost. Primary button: **Share**. Secondary: **Shop** and **Access**. The more menu: Visit, Copy domain, Reveal server token, and, for an admin, Add product and Remove website.

**Body.** One card per product. The card shows the product name, Working or the one missing thing, and the daily cost. **Open setup** is a small button on the card. It opens that product's dashboard. It is not how the merchant runs the shop. An admin can remove the product from the card menu.

**Empty.** No cards. An admin gets Add product. A merchant sees one line: a platform admin adds products. No welcome essay, no chart, no checklist.

**Not on this page.** The spend chart, the usage table, recent changes, the settings version, the install block, the script tag, the browser token, and the Setup sheet. Spend lives on Usage and credits. The script lives on the share page. Reveal server token asks for the password and shows the token once, for the merchant to put in the site's server. It is not painted on the page.

**Shop.** One page, not seven. The sections are on the page, not separate addresses.

- Name, email, phone, WhatsApp.
- Address, in a drawer. Hours, in a drawer.
- Logo, favicon, accent color, light / dark / auto.
- Country. Choosing it fills an empty time zone, currency, calling code, and units. Language is one field. Currency display and whole units stay.
- Extra hosts, the sign-in path, the privacy path.
- Who gets alerts: name, email, phone. SMS or WhatsApp. Staff push.

**Access.** A different page, because it holds secrets. Database, storage, AI key, and which products may call each other. One password covers the whole visit, not a password on every card. The help text says a storage folder is a prefix, not a lock.

### Share

A public page. No Portal menu. The developer, or an AI, opens the link and builds from this page alone.

**In order, nothing else.**

1. Shop name and domain. When the link expires.
2. The script tag, with a Copy button.
3. The origins that may use it, including localhost, on one line.
4. Storefront. For each product that is on: the visitor elements to paste, then that product's docs.
5. Staff. For each product that is on: the staff elements to paste, then the ticket call the site's server makes. The server token is not on this page. The line says to read `SS_SERVER_TOKEN` from the server environment.
6. A line for each product that will not run, and why.

**Actions.** Copy as instructions, for an AI. Download is secondary and contains the same text, not the raw sheet. No profile, no recommendations, no settings dumped as JSON, no permission keys, no event names, no product version, no "generated at".

**Creating the link,** from Share on the website page. Days, 1 to 30, default 7. Include settings is off. The kit itself is always in the link. The merchant sees the URL once and can revoke it later from the same Share drawer.

### Orders

Staff never open the Portal. This is the first staff screen, mounted on the merchant's site as `orders_admin`. It already exists as a list and a detail. Build it so the first view is the job, and the rest stays behind one control.

**List.** Search. Status chips using the shop's status labels, with counts. Rows: order number, customer, status, total, when. A checkbox is for bulk work, not the first thing the eye hits. More filters stays closed: stage, payment, dates, tag, not opened by me, refund still due. The code already puts those in a closed `details` in `orders-admin.js`. Keep them there.

**One order.** The number and the status. The primary button is the next step (pack, ship, deliver). If the order is waiting for money, the button beside it is Record payment. If money is still held after cancel, it is Refund. Everything else is in the more menu: address, staff note, invoice, packing slip, cancel, delete. Cancel and delete ask the person to type the order number.

**Selected orders.** Move, packing slips, pick list. Export CSV stays in the list's more menu. A failed move names the order number, not the raw id.

**Returns.** A second section on the same widget, only when returns is on. It is not a Portal page and not a Settings row the staff hunts for.

## 1. Product and the three places people work

Five kinds of person. Three places.

| Person | Place | What they do |
| --- | --- | --- |
| Platform admin | Portal `/admin` | Merchants, credits, connecting products, seeing what is broken. Owner, Support, or Finance. |
| Merchant owner | Portal `/` | Website facts, credits, and the handoff to their developer. Not daily orders. |
| Merchant staff | The merchant's own website | Day-to-day work for one website, through one widget mount per job. No Portal login. |
| Merchant's web developer | A share link, then the merchant site | No Portal login and no product source. They get a share kit. |
| External product developer | Their own repo plus `@ss/cli` and `@ss/app-kit` | No Portal access and no other product's code. They get a standalone SDK and a local sandbox. |

There is no composed staff admin. Each product's `ui/widget.js` starts its own widgets. Staff work only where the merchant's developer placed a host element.

### The one next click

**Admin, after sign-in.** Land on `/admin`. The page is `platform/src/console/admin/views/overview.js`, loaded by `platform/app/(admin)/admin/_views/home.js`. The next click is the first row under **Needs you** (mail not set, an inactive product, or a merchant low, in grace, or stopped). If the platform is still new, the next click is the first undone step of the setup checklist on that same page (connect a product, set one active, add a merchant, add a website). **Add merchant** is the header action when the role may write merchants. Do not send them to a second home.

**Merchant owner, after sign-in.** Land on `/websites`. The page is `platform/src/console/views/websites.js` (`WebsitesView` / `WebsiteView`), loaded by `platform/app/(console)/_views/websites.js` and `websites-websiteId.js`. The next click is the website already open beside the list (the first website on a wide screen). On a phone the list is alone; the next click is the first website row. With no website yet, the page is the welcome in `websites.js`: support contact only. The owner cannot add a website. An admin does, from the merchant page. Do not send the owner to Overview, a product dashboard, or the Setup sheet as a home.

**Staff, on the merchant site.** There is no Portal URL. The next click is the control on the page the merchant's developer built, which mounts the admin widgets for that job (orders, inbox, catalog, and the rest listed in section 2). Do not add a Portal staff home. The code has no such page, and this spec does not invent one.

Sign-in is one page, `/login`, for admins and merchants (`platform/src/console/views/sign-in.js`). Admins then go to `/admin`. Merchants then go to `/overview` today (`homeOf` in `sign-in.js`, and `redirectIfSignedIn` in `platform/app/(console)/_lib/server.js`). Change that landing to `/websites` in the same two functions. `/admin/login` already redirects to `/login`.

### What each place is for

**Portal, merchant.** Operate the website as a business: shared facts, connections, credits, account, and a handoff. The owner may open a product dashboard (setup only) and may see install tokens. The owner may not add or remove a product or the website. `can` in `websites.js` is `{ manage: false, removeWebsite: false, tokens: true, open: true, settings: true }`.

**Portal, admin.** Operate the platform. The same website page (`platform/src/console/views/website-page.js`) is rendered by `platform/src/console/admin/views/website.js` with the admin's rights from `platform/src/infra/rbac.js`. Add and remove products, remove the website, open dashboards, and read settings follow those rights. Finance does not get tokens, dashboards, settings, or connections.

**Product dashboard.** One app per product, opened from Portal with a single-use launch URL (`openDashboard` in `platform/src/console/views/common.js`). Each `products/*/app/dashboard/page.js` says the page is setup only and shows no orders, products, customers, or conversations. Tabs, in `packages/ui/src/dashboard.js`: Overview, Settings, Texts, Developers, and for an Owner only Defaults and Prices. Merchants see feature switches read-only. Owner and Support switch features. This is where a product is turned on and worded. It is not where staff work.

**Widgets.** One public `widget.js` per product, the same bytes for every website. `data-token` is the browser token and starts visitor widgets. `admin({ getTicket })` starts staff widgets into elements the developer placed. Nothing renders while the product is stopped, the feature is off, or the merchant database is not connected.

## 2. Current pages

Routes that are not in the tables 404. Both consoles are one `page.js` each. `force-dynamic` on both.

### Merchant routes

File: `platform/app/(console)/[...path]/page.js`. Frame: `platform/app/(console)/layout.js` → `platform/app/(console)/_lib/frame.js` → `platform/src/console/views/shell.js`. Loading: `platform/app/(console)/[...path]/loading.js` → `platform/src/console/views/loading.js`.

Menu (`shell.js`): Overview, Websites, Usage and credits (dot when low, in grace, or stopped), Account. Sidebar footer: credit balance linking to Usage and credits, and the first support channel. Account menu items in this file: My account, Sign out. Public paths render with no frame.

| Path | Renders | Kind |
| --- | --- | --- |
| `/login` | `sign-in.js` `SignInView` | public |
| `/forgot-password` | `ForgotPasswordView` | public |
| `/reset-password` | `ResetPasswordView` | public |
| `/set-password` | `SetPasswordView` | public |
| `/confirm-email` | `ConfirmEmailView` | public |
| `/shared-setup` | `setup.js` `SharedSetupView` | public |
| `/overview` | `websites.js` `OverviewView` | page (fade/slide) |
| `/websites` | `websites.js` `WebsitesView` | screen |
| `/websites/:websiteId` and `…/:part` and `…/:part/:sub` | `websites.js` `WebsiteView` | screen |
| `/credits` | `credits.js` `CreditsView` | screen |
| `/credits/receipts` | redirect to `/credits#receipts` | — |
| `/account` | `account.js` `AccountView` | screen |
| `/account/:part` | redirect to `/account#part`, or 404 | — |

Website parts (`platform/src/console/website-parts.js`): empty path is the page; `products/:productId`, `install`, `usage`, `changes` scroll the same page; `settings` and `settings/:section` and `setup` are their own addresses. Settings sections, in order: `business`, `brand`, `region`, `pages`, `team`, `connections`, `links`.

### Admin routes

File: `platform/app/(admin)/admin/[[...path]]/page.js`. Frame: `platform/app/(admin)/admin/layout.js` → `AdminShell` in `platform/src/console/admin/views/shell.js`. Titles get a `· Admin` suffix. Loading: `platform/app/(admin)/admin/[[...path]]/loading.js`.

Menu, filtered by `adminCan` (`platform/src/infra/rbac.js`): Operate — Overview (`overview.read`), Merchants (`merchants.read`), Products (`products.manage`). Money — Credits and billing (`billing.read`), with a count of merchants that need attention. Portal — Admins (`admins.manage`), Settings (`portal_settings.write`), Activity (`activity.read`). While Settings requires two-step and this admin has not set it up, the menu is empty and the frame shows only two-step setup (`TwoStepSetup`).

| Path | Renders |
| --- | --- |
| `/admin` | `overview.js` `OverviewView` |
| `/admin/login` | redirect to `/login` |
| `/admin/merchants` | `merchants.js` `MerchantsView` (list, first merchant open on a wide screen) |
| `/admin/merchants/:merchantId` | same view, that merchant |
| `/admin/merchants/:merchantId/:part` | redirect; parts `websites`, `credits`, `details`, `activity` |
| `/admin/merchants/:merchantId/websites/:websiteId` and deeper | `website.js` `AdminWebsiteView` → shared `WebsitePageView` |
| `/admin/products` | `products.js` `ProductsView` |
| `/admin/products/:productId` | same view, that product |
| `/admin/products/:productId/:part` | redirect to a hash; parts `websites`, `features`, `connection` |
| `/admin/finance` | `finance.js` Needs attention |
| `/admin/finance/receipts` | receipts |
| `/admin/finance/charges` | charges |
| `/admin/activity` | `activity.js` `ActivityView` |
| `/admin/admins` | `admins.js` `AdminsView` |
| `/admin/admins/:adminId` | same view, that admin |
| `/admin/admins/:adminId/:part` | redirect to a hash |
| `/admin/settings` | `settings.js` `SettingsView` |
| `/admin/settings/:part` | redirect to `/admin/settings#part` |
| `/admin/account` | `account.js` `MyAccountView` |
| `/admin/account/:part` | redirect to a hash |

### Shared chrome

Root layout `platform/app/layout.js`: Figtree and Bricolage Grotesque, `lang="en-US"`, theme script before paint, robots `noindex`. Page titles use the branding name.

Errors: `PageProblem` in `platform/src/console/views/common.js`. Not found, forbidden (admin copy says the role does not include the area), load failed, and a Sign in button on 401. Admin pages use `AdminProblem`, which sends Back to Merchants.

Loading skeleton `loading.js` `shapeOf` still describes several of these screens as tables. Merchants, Websites, Products, and Admins are list-and-detail, not tables. The skeleton jumps when the page arrives.

Date filters `platform/src/console/views/range.js`: the From and To fields are `hidden` until the `md` breakpoint. Period presets still work on a phone. Custom dates do not.

`scrollIntoView({ behavior: 'smooth' })` runs with no reduced-motion check in `credits.js` and `account-page.js`. `website-page.js` scrolls to a section with the default instant behavior, also with no reduced-motion check.

### `/login` — everyone

File: `platform/src/console/views/sign-in.js`. Who: admin or merchant. While no admin exists, the page is Create admin (name, email, password of at least 12 characters) and posts `/v1/auth/first-admin`. Otherwise: email, password, Forgot password. Notices: session expired, password reset, email confirmed. Suspended merchant: a danger callout with the support line, and the form stays. Two-step step: 6-digit code or a recovery code, Verify, and a switch between the two. `next` is accepted only as a same-site path of that console (`homeOf`). Empty: the form. Loading: the submit button. Error: field errors and `FormError`. Keyboard: labels, `autoComplete`, `autoFocus` on email and on the code. No motion beyond the button. Required.

### `/forgot-password`, `/reset-password`, `/set-password`, `/confirm-email`

Same file. Forgot: email, then a success callout that does not say whether the account exists. Reset and set-password read `#token` once (`takeFragmentToken` in `client.js`) and strip the fragment. Missing token: danger callout. Set-password checks the token, shows the email read-only, asks a name when the person is an invited admin, then signs them in. Confirm-email posts the token and sends them to `/login?notice=email`. Loading: a spinner. Required for account recovery and invites.

### `/shared-setup` — merchant's developer

File: `platform/src/console/views/setup.js` `SharedSetupView`. Public, unframed, `noindex`. The key is `#key=`, removed from the address, then kept in `sessionStorage` under `ss-shared-setup-key` so a reload still opens it. Posted as JSON to `/v1/setup/shared`. Missing or 404: an error page. Loading: the page skeleton. Ready: the sheet (read-only) plus Download JSON and Copy JSON. No profile editor, no Switch on, no share-link manager. Required as the developer's copy. It is not a Portal home.

The sheet (`SheetBody`) shows, per product: checklist, summaries, features and setting values (or a hidden-values line), connections as state only, widget keys and kinds, install snippet and browser token when the link included them, build notes, staff permission keys, event names, API base, guide and OpenAPI links. Raw keys are on this page. A human developer needs the snippet and the docs links. They do not need permission keys and event names as the primary text.

### `/overview` — merchant

File: `platform/src/console/views/websites.js` `OverviewView`. Who: merchant owner. Greeting, counts, Needs you (website with no product; product with no feature on, with Open), then balance, days left, daily spend, spent this month, a 30-day spend chart, a row per product with Open, recent activity, and the latest receipts. No websites: the welcome, support contact, no button. Loading: route skeleton. Error: `PageProblem`. Open posts the launch URL and opens a new tab. The chart, the website rows, the activity, and the receipts are the same facts as Websites, Usage and credits, and Account. This page is not required once Websites is the home.

### `/websites` and `/websites/:id` — merchant

Files: `websites.js` (`WebsitesScreen`) and `platform/src/console/views/website-page.js`. Who: merchant owner. List: search, status chips when more than one status is present, daily cost, and the one trouble line (no product, stopped, grace, or no feature on). Wide screen opens the first website on `/websites`. Phone shows the list only until a row is chosen. Missing website: the list stays and the page says the website is gone.

The website page header: domain, status pill, daily cost, product count, Visit website, Copy domain. **Website settings** and **Setup sheet** are the secondary actions. Body, all open: Status and spend (numbers and a 30-day chart), Products (status, Open dashboard, install block when tokens load), Recent changes, Usage details (table, chart already drawn above). Empty products: "no products" with no add button. Tokens loading: skeleton. Tokens or usage failed: a danger callout. Settings failed: the changes card shows the problem. A bad part, or a product id that is not on the website: an error in the page. Permission: the merchant `can` above. Add product and Remove are not rendered.

Install block (`platform/src/console/views/website.js` `InstallBlock`): widget script tag (browser token inside it), browser token in a code block, server token hidden until Reveal or Copy, Regenerate. Reveal, copy, and regenerate ask for the password and, when two-step is on, a code. Regenerate also asks the person to type the product name. If the sealed token cannot be opened, the block says to regenerate. The browser token is shown in full to anyone who can open the page. That includes a stolen merchant session that has not yet been asked for the password: the password step covers the server token only.

Old addresses `products/:id`, `install`, `usage`, and `changes` only scroll. They are not separate screens.

### Website settings — merchant and admin

State: `platform/src/console/views/website-settings.js`. Form shell: `website-settings-form.js` (`useSectionForm`, floating `SaveBar`, read-only callout, stale-version reload). Sections: `website-settings-sections.js` and `website-connections.js`.

Who: a person with `website_settings.read`. Write follows `can.write` from the API. Connections and links follow `connections.read` / `connections.write` and are hidden from the inner nav when the connections payload is null (Finance). A save sends `{ version, value }`. 409 offers Reload. 422 stays on the fields.

**Business.** Identity: name (required), tagline, other names. Legal: legal name, tax number, business type. Contact: email, phone, WhatsApp, more phones. Address drawer: country, line1, line2, area, city, region, postal code. Hours drawer: a window per weekday plus dated exceptions. Social links. Empty address and empty hours show "none".

**Brand and look.** Six picture URLs (logo, dark logo, icon, favicon, dark favicon, share image). Mode light/dark/auto, font family, radius 0–24, custom CSS textarea, named colors, a preview. Pictures are URLs, not uploads.

**Region and format.** Country, time zone (suggestion list), language, extra languages (type-to-add, no preset list), countries served. Currency, extra currencies. Weight and size units. Format: locale, currency as code or symbol, whole units, times as viewer or business, currency symbols drawer, money and date preview. Phone: calling code, trunk prefix, phone countries. Address rules: which parts are required, region-name lists per country.

Choosing a country (`chooseCountry`) fills the calling code and the units only when those are still empty. Imperial units for US, LR, and MM; otherwise kg and cm. It does not set time zone, currency, locale, or language. That is a bug. A person who picks a country still has an empty time zone and currency until they type them.

**Domains, pages and legal.** Extra hosts, sign-in path, privacy path. Legal documents: add privacy, add terms, or a blank document. Each document is a key, a title, and a **text body** in a drawer (`TextArea`, 14 rows). This is a legal-document editor inside Portal. Empty: "no documents".

**Team and alerts.** Recipients (name, email, phone; up to 50). Phone channel none / SMS / WhatsApp. Staff push switch. Support email and support phone. A recipient needs an email or a phone. Empty: "no people".

**Data and files.** One database URI (password field), one storage connection (endpoint, region, bucket, access key, secret, prefix, public base URL, path-style switch), one AI key (provider, key, model, and base URL when the provider is "compatible"). Save and Remove ask for the password again. After save the page shows only that a value is set, plus the public base URL, AI provider, model, and base URL. Per product: database name, folder, AI yes/no, and test state. Empty products: "no products". The form does not show a secret again.

**Between your products.** Rows "X may use Y", scopes, whether the key was delivered, on/off/idle. Switch and Regenerate ask for the password. Nobody can paste a token. Empty: no links.

Recent changes are a timeline on the website page, not a separate screen. The changes route only scrolls there.

### `/websites/:id/setup` — merchant and admin

File: `setup.js` `SetupView`, inside `website-page.js`. Who: a person with `tokens.manage` (merchant; admin Owner and Support). Finance does not get the sheet (`loadAdminWebsite` skips it). Header: Download, Copy JSON, Refresh. Body: website facts (domain, status, whether business settings exist, allowed origins, testing origins, server-token line), business profile, recommendations, one panel per product (the same raw keys as the shared page), and share links.

Profile drawer: every choice question, optional "other" text, yes/no for moving and taxes. Countries and languages are not edited here; the drawer links to Region. Save puts `/setup/profile`.

Recommendations: features the profile calls for that are off, and features that are on although the profile does not call for them. **Switch on** is passed as `canSwitch` with no role check in `AdminWebsiteView` (the prop is the literal `true`). The merchant view does not pass it, so merchants do not see the action. The API still has to accept the call. Switching on is billed; the note says so.

Share links: days 1–30, include setting values, include install snippet and browser token. The URL is shown once. Revoke on an active link. The link is the developer handoff. The questionnaire and Switch on are a second way to configure the same website the settings page and the product dashboards already configure.

### `/credits` — merchant

File: `platform/src/console/views/credits.js`. Who: merchant. Header facts: balance, days left, daily spend, spent this month, and a status pill. Toolbar: search, period, website, and the date fields (hidden on a phone). Sections: a spend chart and a usage table (day, website, product, feature, hours, credits); receipts as rows (method, reference, amount, time) with their own search. Empty usage and empty receipts have empty states. Usage can fail while billing still shows (`usageProblem`). `/credits/receipts` only scrolls to receipts. Required. The chart repeats the Overview chart and the website-page chart.

Billing states and the banner live in `platform/src/console/views/billing.js`: low balance and grace are warnings, stopped is danger, not dismissible, with the support line. Days left shows the grace end, the stop time, or a day count.

### `/account` — merchant

Files: `account.js`, `account-page.js`, `login-settings.js`. Who: merchant. One page, sections Details, Sign-in, Two-step, Activity. `/account/sign-in` and the other part URLs redirect to a hash and then smooth-scroll.

Details: business name, owner name, phone, country, address. Save patches `/v1/me`. Sign-in: change email (password, and a code when two-step is on; the new address must confirm), change password (ends other sessions; the short-password sentence in `PasswordPanel` is a hardcoded English string, not the shared copy). Two-step: password to start, QR, secret, 6-digit confirm, 10 recovery codes shown once behind a checkbox. Turn off and new codes ask for password and a code. Activity: own rows, Show more. Empty activity: empty state. Required.

The same sign-in, two-step, and activity blocks are the admin My account page.

### `/admin` — platform admin

File: `overview.js`. Who: an admin with `overview.read`. Greeting, Needs you, setup checklist while any of product / active product / merchant / website is missing, credits earned this month, credits added this month, a chart summed from product day series, the first merchants with balance, connected products, recent activity. **Add merchant** when `merchants.write`. **Add credits** on a needs row when `credits.add`. **Open as admin** on a product when `products.manage` (launch with `websiteId: null`, Defaults). Empty merchants and empty products have their own empty states and the same actions. Error: `AdminProblem`. The products card's "view all" control uses the merchants label (`ADMIN.viewMerchants`). Required as the admin home.

### `/admin/merchants` and one merchant

File: `merchants.js`. Who: `merchants.read`. List: search (name, email, or domain), chips All / Active / Suspended / Setup pending, cursor pages of 50, balance, last sign-in. Bulk Suspend, Resume, and Resend setup link when the role allows them. Phone hides the detail until a row is chosen.

Merchant page, all sections open: Websites (domain, product count, daily cost, link to the website page; menu: open, settings, setup sheet, by right), Credits (`MerchantCredits` in `finance.js`: balance numbers, receipts, day-charge table), Details (owner, email, phone, country, address, created, last sign-in, two-step, password set or setup pending), Activity (table, Show more, row opens a drawer of before/after). Header: Add credits (`credits.add`), Edit (`merchants.write`), Add website (`websites.write`). More: usage of all websites, open in Activity, suspend or resume, resend or copy setup link while setup is pending, turn off two-step, delete (blocked while any website remains; password and typed name). Edit drawer: the same merchant fields as Account, email locked after the password is set. Add merchant: name, owner, email, phone, country, address; the setup link is mailed. Empty list: empty state and Add merchant. A row can say "1 product" with the word hardcoded in English. Required.

### Admin website page

File: `platform/src/console/admin/views/website.js`. Same `WebsitePageView`. Rights: `products_on_websites.write` (add and remove products), `websites.write` (remove the website, only when it has no products, typed domain), `tokens.manage` (install block and Setup), `dashboards.open`, `website_settings.read`. Launch uses the admin launch route with the website id. Breadcrumbs: Merchants, merchant name, domain. Add product lists active connected products not already on the site. Required for connecting products. It is the same screen the merchant sees, with more buttons.

### `/admin/products` and one product

File: `products.js`. Who: `products.manage` (Owner). Support does not get this menu entry (`products.manage` is Owner-only in `rbac.js`). The screen's `owner` flag is that same permission, so the connect, activate, and reconnect actions are Owner-only. List filter chips are local state; they do not write the query string the loader already understands.

Product page: Websites using it (30-day earnings chart, merchant name, features on, daily cost, Show more), Features and prices (name, description, what it needs, per hour, per day), Connection (base URL, connected and reconnected times, **product id in monospace**, version, price-list version, widget script URL, docs URL). Actions: Open as admin, set active or inactive, copy address, reconnect (URL optional, secret required). Add product: URL and connect secret; a new product is inactive until set active. Empty: empty state and Add. The id, base URL, and widget URL are internal plumbing on a human page. Required for connecting a product. The earnings chart is another copy of the credits chart.

### `/admin/finance`, `/receipts`, `/charges`

File: `finance.js`. Who: `billing.read` (Owner, Support, Finance). Add credits is `credits.add` (Owner and Finance). Support can read and cannot add.

Needs attention: merchants low, in grace, or stopped, with Add credits. Empty: a check empty state. Receipts: search, merchant, method, period, date fields; a row links to the merchant's credits section. Charges: group by day, merchant, or product; a day chart when grouped by day. Add credits: pick merchant, then credits (whole number), amount paid, method, reference, then a confirm step that repeats the new balance and says the receipt is permanent. One idempotency key per open drawer. Success reloads the whole page. Required. Manual top-up is the only way credits are added.

`MerchantCredits` repeats receipts and day charges on the merchant page. It does not draw a chart.

### `/admin/activity`

File: `activity.js`, table from `login-settings.js` `ActivityTable`. Who: `activity.read`. Filters: merchant, admin (only if `admins.manage`), period, dates. A row opens a drawer with before/after, including raw field names and JSON values cut at 80 characters. Names in a row filter the list. Empty: empty state. Load more failure: a callout above the table. Required for Owners and Support. Finance has `activity.read` too.

### `/admin/admins` and one admin

File: `admins.js`. Who: `admins.manage` (Owner). List search and role chips are local. Invite: email (the label is the hardcoded word "Email"), role Owner / Support / Finance as radio cards, Invite or Copy invite link, both after the Owner's password. An invited admin can resend, copy the link, or correct the email. Another admin: change role, turn off two-step, remove. You cannot do those to yourself. Details show email, role, two-step, last sign-in, created, and a list of what the role may do. Activity is the same table. List status text includes the hardcoded English "Two-step on · N codes" and "Two-step off". Required for Owners.

### `/admin/settings`

File: `settings.js`. Who: Owner (`portal_settings.write`). The file comment says one save bar for the whole page. The code gives **each card its own `SaveBar`**. Parts, all on one page: Branding (name, accent color, logo file checked against `LOGO_TYPES` and `LOGO_MAX_BYTES`, sent as base64 JSON, not a multipart upload; remove logo), Support (channels: type email/phone/link, label, value; reorder and remove), Mail (host, port, user, password, sender name, sender address, secure; Send test; Turn off), Security (session hours, require two-step for admins, and Re-seal stored secrets), Billing rules (grace days, low-balance days, with the bounds the API returns). Re-seal has a hardcoded English fallback "Re-sealing…". Password already stored is not shown. Mail not configured is also a Needs you row on Overview. Required.

### `/admin/account`

File: `platform/src/console/admin/views/account.js`. Who: any admin, from the account menu, unless two-step is blocking the frame. Name, role badge, then the shared email, password, two-step, and own activity. Required.

### Product dashboards

Each page is only this:

```js
<ProductDashboard manifest={manifest} texts={TEXTS} categories={CATEGORIES} tabs={TABS} />
```

Shared shell: `packages/ui/src/dashboard.js`. Session `GET /v1/dashboard/session`. No session yet: a skeleton. 401: signed-out callout. Other failure: the problem. No website picked and the tab needs one: empty state and the website switcher. Admins see `merchant / domain` in the switcher and a "viewing as admin" note. Footer: docs (`/docs`, new tab) and Back to Portal. Tabs that moved: `features` opens Settings, `connections` opens Developers. An Owner with no website lands on Defaults. Everyone else lands on Overview. Section changes use `history.pushState` and a cross-fade (`SwapTransition`). I did not open that motion component.

Settings (`packages/ui/src/dashboard-tabs.js`, read through `SettingsPanel`): every feature, grouped by the product's `categories.js`, with a switch for Owner and Support. Switching one off switches off features that need it, after a confirmation that shows the new hourly cost. A feature that is off explains itself. A merchant is told to ask support. One save bar for the feature's settings. The product may add list editors under a feature.

I did not open every feature schema, so this spec does not repeat a field count. What is on each dashboard, from the files opened:

**Accounts** — `products/accounts/app/dashboard/`. Categories: sign-in methods, sign-up and access, profiles and privacy, staff and connections, migration (`import`). Tabs add custom fields, consent list, social sign-in key forms, and developer snippets (offline verify, widgets, tickets, return addresses, message templates). Overview counts custom fields when that feature is on.

**Ecommerce** — categories from store details through catalog, checkout, offers, shopper features, SEO, admin tools, and `import`. Settings extras (`settings.js`): store details; item types; booking schedules; grades and unit states; payment methods, order flow, reasons and files, couriers, **policies (key, title, text)**, segments; delivery zones; tax rules; review questions; claim kinds and statuses; role prices. A catalog search set to Atlas shows a callout and a docs link. Overview adds payments-link, notifications-link, Atlas index, staff-alert recipients, admin URL, and hand-paid methods with no instructions. Developers add visitor, API, add-to-cart event, admin, ticket, site routes, search index JSON, and storage CORS snippets, plus courier connection forms. Database, storage, and the AI key are called out as the Portal's.

**Chat** — categories from the widget through inbox, AI, knowledge, tools, proactive, safety, and `import`. Overview asks for a booking URL while Book a slot is on. Rules: visitor chat with nobody allowed to start, or nobody to answer. Developers: backup AI form. Database, storage, and the main AI key are the Portal's.

**Notifications** — categories: channels (including templates, email, SMS, WhatsApp, push, webhooks), sending rules (including **quiet hours**), delivery log. Settings add template editor, webhook URLs, topics, template settings, fallback channels, **quiet hours** (days, from, until, channels), and stop keywords. Overview counts templates and asks for a webhook URL when that feature is on and the list is empty. Developers: send API, template keys, widget, ticket, signature check, reply addresses, and provider forms for email, SMS, and WhatsApp.

**Payments** — categories: ways to pay (manual, Stripe, PayPal, PayFast, PayFast PK, JazzCash, EasyPaisa, Rapid, generic) and selling tools (links, subscriptions, refunds, payment API). Settings add the **manual methods** editor. Overview counts ready gateways and names manual methods payers cannot see yet, and storage missing when a method takes a proof. Developers: create and verify snippets, gateway callback URLs, webhook snippet, links, refunds, methods, subscriptions, widgets, ticket, and per-gateway key forms.

**Growth** — categories: tags and pixels (including custom scripts and consent), analytics, search engines, notice bar, `import`. Overview counts tags that still have no id or script. Developers: page script, shop events, API, snippets. I did not open Growth's settings notice body.

Prices and Defaults are the shared Owner tabs. I did not open their field components past the exports in `dashboard.js`.

### Widgets — staff and visitors

There is no page that mounts these together. Each `ui/entry.js` calls `startWidget` once, with `document.currentScript` so `data-token` is that tag.

| Product | Visitor, with `data-token` | Staff, `admin({ getTicket })`, one host each |
| --- | --- | --- |
| Accounts `ui/widget.js` | `sign_in`, `my_account`, `role_request`. Also finishes magic links and social handoff. `SSAccounts.getSignIn`, `user`, `signOut`. | `users_admin`, `roles_admin`, `activity_admin` |
| Ecommerce `ui/widget.js` | `product_grid`, `product_page`, `cart`, `my_orders`, `wishlist`, `compare`, `alerts_stop`. `identify`, `addToCart`, cart count. Retries a 409 `in_progress` place-order with the same idempotency key. | `catalog_admin`, `orders_admin`, `promotions_admin`, `customers_admin` |
| Chat `ui/widget.js` | Injects its own `chat` host unless the path is hidden. `identify`, `setPage`, `open`, `close`, unread. | `inbox`, `knowledge_editor`, `reports` |
| Notifications `ui/widget.js` | `push_permission` | `delivery_log`, `template_editor`, `send_message`, `staff_push_permission` |
| Payments `ui/widget.js` | `pay_button` (`data-link` or `data-payment`) | `payments_admin`, `links_admin`. `subscriptions_admin` is removed with the subscriptions feature (section 9). |
| Growth `ui/widget.js` | Consent banner and notice bar (placed host, or one the script creates), tags, analytics, shop events. No `data-token` means no visitor half. | `analytics_dashboard`, `seo_checklist`, `redirects` |

Staff widgets ask the product for a 15-minute ticket (`packages/protocol/src/tickets.js`): one staff user, one website, one origin, a permission list. The ticket is checked against the request Origin. Regenerating the server token ends tickets made with it. I did not open the individual admin widget files (`orders-admin.js`, `inbox.js`, and the rest). Their mounts are the list above.

### Servers the screens call

Console reads go through `platform/src/console/api.js` (in-process, the request's cookies, GET only). Console writes go through `platform/src/console/client.js` (`fetch` same origin, JSON, `Idempotency-Key` on POST). A 401 sends the browser to `/login?expired=1`, except a wrong password on a confirm call (`apiConfirm`).

Paths are listed in `platform/src/console/paths.js` and `platform/src/console/admin/paths.js`. Loaders: `platform/src/console/loaders.js`, `platform/src/console/admin/loaders.js`. A failed required read becomes `{ ok: false }`. Optional reads become empty.

## 3. What is extra

Delete or stop linking these. Do not delete a route that is the only place a required job happens.

### Routes that should die

| Route | File that renders it | Why |
| --- | --- | --- |
| `/overview` as a home | `platform/app/(console)/_views/overview.js` → `OverviewView` in `websites.js` | Same websites, spend, activity, and receipts as Websites, Credits, and Account. Redirect `/overview` to `/websites` and take it out of the menu in `shell.js`. |
| `/credits/receipts` | `platform/app/(console)/_views/credits-receipts.js` | Already a redirect. Receipts are a section of `/credits`. |
| `/account/:part` | `platform/app/(console)/_views/account-part.js` | Already a redirect to a hash. The page is one URL. |
| `/admin/login` | `platform/app/(admin)/admin/_views/login.js` | Already a redirect to `/login`. |
| `/admin/account/:part` | `account-part.js` under admin `_views` | Redirect to a hash. |
| `/admin/admins/:adminId/:part` | `admins-adminId-part.js` | Redirect to a hash. |
| `/admin/products/:productId/:part` | `products-productId-part.js` | Redirect to a hash. The product page is already one page. |
| `/admin/merchants/:merchantId/:part` except the website URL | `merchants-merchantId-part.js` | Redirect. Websites, credits, details, and activity are sections of the merchant page. |
| `/admin/settings/:part` | `settings-part.js` | Redirect to a hash. |
| `/websites/:id/products/:productId`, `/install`, `/usage`, `/changes` | `websites-websiteId.js` → `WebsitePageView` | Not pages. They scroll the website page. Keep them as redirects to `/websites/:id#…` or drop them. |
| The same four parts under `/admin/merchants/:merchantId/websites/:websiteId/…` | `merchants-merchantId-websites-websiteId.js` → `AdminWebsiteView` | Same scroll aliases. |
| `/websites/:id/setup` and the admin copy | `website-page.js` rendering `SetupView` in `setup.js` | Not a job of its own. Share is a drawer on the website page. The developer uses `/shared-setup`. |

Keep `/websites/:id`, the two settings pages (facts, and access), `/credits`, `/account`, `/login` and the emailed-link pages, `/shared-setup`, and every admin list that is a real job (merchants, one merchant, one website, products, finance, activity, admins, settings, account).

### Screens that should stop configuring

The owner's Setup page (`SetupView` in `setup.js`, opened from `website-page.js`) is the wrong screen: a profile, a feature switcher, and a dump of every product setting. It goes away. Feature switches stay on the product dashboard. The public `/shared-setup` page stays, and it becomes the kit in section 10, not a read-only copy of that sheet.

Do not add a staff Portal, a CSV import screen, or a conversion wizard. Import is a product feature key and a CLI (`packages/importer/README.md`). Ecommerce, Payments, and Growth widgets already download CSV from the widgets that have a `save` helper. That is enough.

### One fact, two editors

| Fact | Where it is edited | What to keep |
| --- | --- | --- |
| How a shopper pays | Ecommerce `PaymentMethodsEditor` (`products/ecommerce/app/dashboard/settings.js`, list `payment_methods`) and Payments `MethodsEditor` (`products/payments/app/dashboard/tabs.js`, list `manual_methods`) plus the gateway features in `products/payments/app/dashboard/categories.js` | One manual-method list, on Payments, next to the gateways. Ecommerce checkout reads that list. Do not keep two method editors. |
| When the shop is open, and when not to send | Portal hours drawer (`website-settings-sections.js` `HoursEditor`) and Notifications `QuietHoursCard` (`products/notifications/app/dashboard/lists.js`: days, from, until, channels) | Opening hours stay on the website. Quiet hours stay a Notifications list, but the empty quiet-hours row should start from the website's hours instead of a second clock the owner invents. Booking schedules in Ecommerce are a different fact (appointment slots) and stay. |
| Legal text | Portal document body (`PagesSection` textarea) and Ecommerce `PoliciesEditor` (`lists.js`: key, title, text) | The shopper-facing policy body lives in Ecommerce policies, which the shop already renders. Portal keeps the path fields (`privacy`, `signIn`, hosts), not a second body editor. |
| Who gets staff alerts | Portal Team recipients, support email, and support phone (`TeamSection`) and Ecommerce `staff_alerts.recipients` (read in `products/ecommerce/app/dashboard/tabs.js`) | The website team is the list. A product asks for a permission, not a second address book. The kit already sends staff alerts to that team (`packages/app-kit/README.md`). |
| Contact email and phone | Business contact (email, phone, WhatsApp, more phones) and Team support email and phone, on the same website settings document | One contact block on Business. Team keeps recipients and the SMS / WhatsApp / push choice. |

Credit charts repeat the same series: merchant Overview, the website page, Usage and credits, admin Overview, the product page, and finance Charges when grouped by day. Keep the chart on Usage and credits and on admin finance Charges. Remove it from the website page as well as from merchant Overview (that page goes away), the admin Overview, and the product page. The website page's job is the site and its products, not a second credits report (section 10).

## 4. Target information architecture

No new top-level page. The tree is the routes that remain.

**Admin.** `/admin` (Needs you). From a needs row: the merchant, the product, or Settings → Mail. `/admin/merchants` → one merchant (websites, credits, details, activity) → one website (status, products, changes, usage; settings and the handoff are actions). `/admin/products` → one product (who uses it, features, connection). `/admin/finance` (attention, receipts, charges as sections of one page; the two extra paths can stay as aliases). `/admin/activity`, `/admin/admins`, `/admin/settings`, `/admin/account` stay in the menu for the roles that have them.

**Merchant.** `/websites` → the open website. The page shows the site and its products (`website-page.js`). Header actions: Website (one facts page) and Access (connections and links). Share opens the create-link drawer on this page. There is no Setup destination. `/credits`. `/account`. The website switcher in the shell already goes to `/websites/:id` or back to `/websites`.

**Staff.** On the merchant site, one host per widget key in section 2. The developer's share kit shows the host snippet. The developer places the hosts. Staff sign in through the Accounts widget on that site and the page calls `admin({ getTicket })`. Portal never sees them.

**Developer handoff.** The owner or an admin creates a share link from the website page. The developer opens `/shared-setup` and sees the kit in section 10. They do not need a Portal user. Setting values are off unless the owner includes them. The kit is the page, not an optional snippet.

**Product developer.** `ss app init` (`packages/cli/README.md`) writes a product that depends on `@ss/app-kit` and `@ss/cli`, with a fake Portal in `@ss/app-kit/testing` and a test MongoDB. They never import Portal source. Connect to a real Portal later with the product URL and `CONNECT_SECRET` (the Add product drawer).

## 5. Forms, components, and motion

Fix these in the files named. Do not add a component library.

1. **Country fills the region.** In `chooseCountry` (`website-settings-sections.js`), set time zone and currency from the country when they are still empty, the same way calling code and units are set. Keep the suggestion lists so a person can override them. Do not invent a second country list; `countryChoices()` is already the list.
2. **One contact block.** Remove support email and support phone from `TeamSection`. Business already has email and phone.
3. **Legal body leaves Portal.** `PagesSection` keeps hosts, sign-in path, and privacy path. The document textarea goes away once Ecommerce policies are the body. Until that list is what the shop renders, do not delete the textarea in a way that drops saved text; move the saved body into the policies list.
4. **One pay-method editor.** Payments keeps manual methods and gateways. Ecommerce's `PaymentMethodsEditor` becomes a view of that list, or it is removed after the shop reads the Payments list. Hand-paid instructions stay on the Payments method.
5. **Quiet hours default.** `QuietHoursCard` blank row is `21:00`–`08:00` every day. When the website has opening hours, the blank row should be the closed hours of those days. The owner can still edit it.
6. **Support must not see Reveal.** `InstallBlock` always renders Reveal, Copy, and Regenerate. Reveal and regenerate require `tokens.reveal` (`platform/src/modules/identity/routes.js`). Support has `tokens.manage` and not `tokens.reveal` (`rbac.js`). Pass a reveal flag into `InstallBlock` and hide those buttons for Support. The browser token can stay visible to people with `tokens.manage`; it is already public on the merchant site once installed.
7. **Raw ids off the human page.** Product connection (`products.js`): show name, status, address as a copy action, and docs as a link. Do not print the product id or the widget URL as the row's content. The shared kit (section 10) does not lead with a checklist, permission keys, event names, or widget keys. Those stay out of the screen. A downloadable JSON copy may still carry them.
8. **Date fields on a phone.** `DateFields` in `range.js` drops `hidden md:flex`, or the period menu gains a custom range that works at the phone width.
9. **Motion.** `scrollIntoView({ behavior: 'smooth' })` in `credits.js` and `account-page.js` uses `auto` when `prefers-reduced-motion: reduce` matches. The website-page section scroll does the same if it ever animates.
10. **Skeleton matches the page.** `shapeOf` in `loading.js` uses a list skeleton for `/websites`, `/admin/merchants`, `/admin/products`, and `/admin/admins`, not a table.
11. **One save bar, or an honest comment.** `settings.js` either uses one bar that saves dirty cards in order, as the comment says, or the comment is changed. Today each card saves alone, which is acceptable if the comment stops promising one bar.
12. **Copy.** Replace the hardcoded English in `PasswordPanel` (`login-settings.js`), the invite Email label and two-step status (`admins.js`), the "product" count (`merchants.js`), the products "view all" label (`overview.js`), and the re-seal fallback (`settings.js`) with the existing text tables.
13. **Admin website Switch on.** `AdminWebsiteView` passes `canSwitch` as `true` for every admin who can open the sheet. After Switch on leaves this page (section 3), delete the prop. Until then, pass it only when the role may switch features (Owner and Support), not as a literal.

Empty, loading, error, and permission behavior to preserve: welcome with no websites and no add button; empty states already on lists; `PageProblem` / `AdminProblem`; read-only settings callout; connection password step; two-step wall in the admin frame; Finance seeing merchants and money and not tokens or settings.

## 6. Security boundaries

Real in the code I opened, versus only claimed.

### Real today

- **Sessions.** Opaque 256-bit tokens, stored as HMAC, lifetime from Settings → Security. Cookie `HttpOnly; SameSite=Lax; Path=/`, `Secure` and `__Host-` when the cookie is secure (`platform/src/infra/auth.js` `serializeCookie`, `sessionCookieName`). Admin cookie is separate from the merchant cookie (admin paths comment: `__Host-ss_admin`). Two-step required for admins blocks every route except the setup routes (`authenticators.js` `sessionAuth`).
- **Passwords.** scrypt, dummy verify for unknown accounts, 12-character minimum on the sign-in screens. Email change, password change, two-step, token reveal, connections, invites, role changes, and merchant delete ask for the password again (`ConfirmChange`, `apiConfirm`).
- **CSRF.** Mutations need `Sec-Fetch-Site: same-origin` and an `Origin` equal to the Portal origin. A mutation with neither header is refused (`checkCsrf`). JSON bodies only.
- **Rights.** `can()` in `rbac.js` is what the API checks. Product actors get no Portal permission from that table. Finance cannot write merchants, websites, products, tokens, settings, or connections, and cannot open dashboards. Hiding a button is not the check. The Support reveal buttons are the case where the button and the check disagree.
- **Tokens.** Browser token stored in full. Server token sealed with `ENCRYPTION_KEY` and an AAD of website, product, and `jti` (`product-tokens.js`). Reveal and regenerate audit, and regenerate revokes the old id and notifies the product. Removing a website revokes its tokens. A token sealed under a lost key cannot be shown.
- **Connections, console side.** No console route returns the database URI, the storage secret, or the AI key (`connections.js` `view`). Writes need `connections.write` and a fresh password. Values are sealed. The public base URL and the AI provider, model, and base URL are stored in the clear on purpose.
- **Connections, product side.** `GET /v1/product/websites/:websiteId/connections` (`website/routes.js`, auth `product`) calls `forProduct`. A product that is on an active website and whose manifest needs a database receives `{ uri, dbName }`. The URI is the string the merchant typed, checked with `isSafeMongoUri`, not a user created for that product. `dbName` defaults to `databaseNameFor(productId)`. An Owner may store another name per product (`save` rejects `names` unless the actor is an Owner). Storage receives the bucket, region, access key, and secret. The AI key is sent only when `needs.ai` is true. Link tokens go out with the same response. Delivery is rate-limited (6 secret fetches per product per website per hour, 1200 per product across websites), audited as `website.connections_delivered`, and not cached (`cache-control: no-store`). A product cannot write connections through `/v1/product/*`. It can report health.
- **What that product can do with the URI.** Anything the URI's database user can do. The Portal does not open the database and does not narrow the user. A prefix folder is a convention (`storageFolderFor`), not a bucket policy. A buggy or hostile product that needs the database receives the merchant's connection string. A stolen product key can pull it until the rate limit.
- **Tickets.** 15 minutes, bound to origin, staff user, website, and permissions (`packages/protocol/src/tickets.js`). Wrong origin fails as `invalid_token`.
- **Webhooks.** `packages/protocol/src/webhooks.js`: `t` and `v1` HMAC of `t.body`, 300-second window, constant-time compare. This is the signature helper. I did not open each product's webhook route.
- **Page CSP.** Nonce, `strict-dynamic`, no objects, no framing (`platform/src/infra/security-headers.js`). API responses are `default-src 'none'`. Development allows `unsafe-eval` and inline styles.
- **Share links.** Key in the fragment, then `sessionStorage`. Values and the install snippet are optional. The server never sees the fragment (`takeFragmentToken`).
- **Credits.** Receipts are the only top-up (`billing.js`). They are not edited or reversed. Replay (`platform/src/modules/commerce/core/money.js`): while the merchant is not suspended and spend is still running, balance at or below zero starts grace for `graceDays`; when that end is reached, the products stop. A receipt that lifts the balance above zero clears grace and a stop. Entering low balance, grace, or stopped sends one email. The merchant banner matches those states. The check runs when a Portal page loads the merchant or a product fetches status. It is not on a timer. If nothing asks, the status stays where the last check left it.
- **Logo upload.** Type and size checked, body is base64 in JSON (`settings.js`). Brand pictures on the website are URLs, not uploads.
- **Custom CSS and custom scripts.** Brand `customCss` is saved on the website and the widget config includes `customCss` (each `widget.js` config typedef). Growth has a `custom_scripts` feature. Both run in the merchant page's origin. A person who can write brand settings or Growth scripts can run script-like content in the widgets. That is real, and it is the "leaked script" case.

### Claimed, or only half true

- **"A stolen session cannot change connections or tokens."** True for those writes, because they ask for the password. False for reading the browser token, the setup JSON, and website settings: a stolen session still GETs those.
- **"Each product gets its own database."** The name is per product. The credentials are not. The header of `connections.js` says this plainly, including the Owner override "for a store that must keep a single database."
- **"Finance never sees tokens."** The API hides them. The install UI does not know about `tokens.reveal`, so Support sees buttons the API rejects.
- **"One save bar on Settings."** Comment only. Each card has its own bar.
- **"The theme is in the account menu."** `shell.js` and `AdminShell` comments say the account menu includes the theme. The `accountItems` arrays in those files are My account (unless two-step is blocking) and Sign out. I did not open `AppShell`, so I do not claim the theme is missing from the frame; it is not in these item lists.
- **Kit README statements** about staff checks, offline grace, and import routes are in `packages/app-kit/README.md`. I did not open `staff.js` or the status cache. Treat them as the kit's contract for product developers, and verify them in those files before relying on a number (5 minutes, 6 hours, 3,000 reads).

### Developer boundaries

**Merchant developer, zero Portal access.** They can build the shop from the share sheet and from each product's `/docs` and `schemas/api.json` (`packages/cli/README.md`): browser-token calls, server-token calls their server makes, and ticket calls for staff widgets. The sheet's snippet is the script tag. `SSAccounts`, `SSEcommerce`, `SSChat`, `SSNotifications`, `SSPayments`, and `SSGrowth` are the page APIs in the `widget.js` files. They cannot read another product's source and they cannot open Portal.

**Product developer, zero Portal source.** `ss app init` generates the 0.4.13 layout, `ss app validate` checks it, tests run against `@ss/app-kit/testing`'s fake Portal. The product ships two server functions (the API route and the dashboard page) and one public `widget.js`. Environment: `MONGODB_URI`, `CONNECT_SECRET`, `ENCRYPTION_KEY`, and `ENCRYPTION_KEY_PREVIOUS` only while re-sealing. They connect by giving an admin the product URL and the connect secret.

## 7. Ordered build phases

Each phase is shippable. Do not start a later phase by adding a page. A security hole in section 12 blocks the phase it sits in. Do not ship the share page, the install block, or Access while any item there is still open. Phone layout and motion do not outrank it.

### Phase 1 — One next click

Close section 12 first. Then:

- Merchant sign-in lands on `/websites` (`sign-in.js` `homeOf`, `server.js` `redirectIfSignedIn`).
- Menu in `shell.js`: Websites, Usage and credits, Account. `/overview` redirects to `/websites`.
- Admin home stays `/admin`. The first Needs you action is the obvious button; fix the products card so its view-all label is the products label.
- Delete the redirect-only view files in section 3 after the redirects, if any remain, live in the route tables for one release. Scroll aliases become hashes.
- Staff: no Portal change. A share link opens `/shared-setup` (`SharedSetupView` in `setup.js`). That screen is the kit in section 10, including one staff host per widget that is on. It is not the Setup sheet's install block.

Done when an admin's first click is a needs row, a merchant's first click is their website, and a staff member's first click is a widget on the merchant site.

### Phase 2 — Build the three screens

Build **The three screens** above. The row tables in section 9 are what those screens leave out. Do not start by hiding rows inside the old pages.

- Website page, Shop, and Access, as specified. Country sets an empty time zone and currency.
- Share page and the Share drawer. The owner's Setup page is gone. `/shared-setup` is the kit, not the old sheet.
- Orders list and detail, as specified. Payment methods are edited once, on Payments. Ecommerce checkout reads that list.
- Quiet-hours blank row follows the shop's closed hours. Staff alerts use the Shop team list. Portal legal documents are removed after their text is in Ecommerce policies.

### Phase 3 — Forms, phones, motion

- Date fields usable without the `md` breakpoint.
- Reduced motion on the smooth scrolls.
- List skeletons for list pages.
- Settings save-bar comment matches the code, or one bar saves the dirty cards.
- Hardcoded English strings in section 5 use the text tables.
- Human pages stop leading with product ids, widget keys, permission keys, and event names. Those are section 12. They are removed in phase 1, not with the motion work.
- Delete the unused `@ss/ui` exports in section 13. Keep `PillTabs`, `SeoPreview`, `Stepper`, `NextStep`, `ThemeMenu`, `ThemeToggle`, and `CountUp`.
- A number field does not change when the wheel rolls over it, in `packages/ui/src/fields.js` and `packages/app-kit/src/widget/controls.js`.
- `SchemaForm` never shows `JsonField` to a merchant.

### Phase 4 — Credentials a product can actually use

This is not last. Phase 1 does not ship a share link or a product connection until these are true. The screen work in phases 2 and 3 does not wait on it, and it does not wait on them.

- `forProduct` keeps returning a database name and a folder. The URI it returns must not be a cluster-wide user shared with every product. Deliver a name and a secret that can see only `dbName`, or document the operator rule as a hard requirement on the connection string the merchant pastes and reject a string whose user is not limited to that database. The Owner per-product database name stays, and it is still only a name.
- Storage delivery stays the bucket credentials the merchant pasted. The product's folder is a prefix. Say that in the Data and files help so the merchant does not think the prefix is a security boundary.
- `CreateLinkDialog` in `setup.js` defaults `values` to off. The kit (script, hosts, ticket step, docs, OpenAPI) is the shared page, not the `install` switch. Setting dumps stay off unless the owner includes them. Do not default the kit itself to off.
- `sharedCopy` (`platform/src/modules/catalog/core/setup.js`) and `hideSecrets` (`packages/app-kit/src/blueprint.js`) must not put a server token, a database URI, or a storage secret on the share sheet. Today a connection string shorter than 8 characters is not treated as a secret (`SECRET_MIN_LENGTH`). That hole closes. `forProduct` (`platform/src/modules/website/connections.js`) must not hand out a URI or a storage secret that can open another website.
- Credits: no new payment integration. Keep manual receipts. The live path is already low balance, then grace, then stop, when a check runs. Phase 4 does not add a scheduler unless a website can sit with balance at zero and no Portal page and no product status fetch for longer than the banner can wait. If that gap is real in production, the smallest fix is to run the existing `runCheck` when a product serves a shopper, which the file already says happens on status fetch. Do not add a second ledger.

Out of scope: multi-language catalogs, multi-currency selling, subscriptions (remove the existing Payments feature, routes, and `subscriptions_admin`; do not build another), gift cards, a third-party inbox, a CSV importer in Portal, a staff Portal, a page for the store-specific importer mapping.

## 8. Read log

### Opened

Routes and frames: `platform/app/(console)/[...path]/page.js`, `platform/app/(admin)/admin/[[...path]]/page.js`, both `layout.js`, both `loading.js`, `platform/app/layout.js`, `platform/app/(console)/_lib/frame.js`, `platform/app/(console)/_lib/server.js`, `platform/app/(admin)/_lib/frame.js`, `platform/app/(admin)/_lib/server.js`, `platform/app/_lib/server.js`, every file in `platform/app/(console)/_views/` and `platform/app/(admin)/admin/_views/`.

Console: `paths.js`, `admin/paths.js`, `navigation.js`, `website-parts.js`, `admin/rights.js`, `loaders.js`, `admin/loaders.js`, `client.js`, `api.js`, `link.js`, `views/shell.js`, `admin/views/shell.js`, `views/websites.js`, `views/website-page.js`, `views/website.js`, `admin/views/website.js`, `views/website-settings.js`, `views/website-settings-form.js`, `views/website-settings-sections.js`, `views/website-connections.js`, `views/setup.js`, `views/credits.js`, `views/billing.js`, `views/account.js`, `views/account-page.js`, `views/sign-in.js`, `views/login-settings.js`, `views/common.js`, `views/loading.js`, `views/frame-footer.js`, `views/frame-billing.js`, `views/confirm-change.js`, `views/brand.js`, `views/paging.js`, `views/range.js`, `admin/views/overview.js`, `admin/views/common.js`, `admin/views/merchants.js`, `admin/views/products.js`, `admin/views/finance.js`, `admin/views/settings.js`, `admin/views/admins.js`, `admin/views/activity.js`, `admin/views/account.js`.

Dashboards and widgets: `packages/ui/src/dashboard.js`, `packages/ui/src/dashboard-tabs.js` (through `SettingsPanel`), all six `products/*/app/dashboard/page.js`, all six `categories.js`, all six `tabs.js`, `products/ecommerce/app/dashboard/settings.js`, `products/ecommerce/app/dashboard/lists.js` (policies editor and the file header; not every list editor), `products/notifications/app/dashboard/lists.js` (quiet hours), all six `products/*/ui/widget.js`, `products/accounts/ui/entry.js`, `products/ecommerce/ui/entry.js`.

Servers and kits: `platform/src/infra/rbac.js`, `platform/src/infra/auth.js` (passwords, cookies, `checkCsrf`; TOTP helpers were in the same file), `platform/src/infra/security-headers.js`, `platform/src/infra/authenticators.js` (the `sessionAuth` span), `platform/src/modules/identity/product-tokens.js`, `platform/src/modules/identity/routes.js` (token routes), `platform/src/modules/website/connections.js`, `platform/src/modules/website/routes.js` (from the settings routes through the product settings route), `platform/src/modules/website/links.js` (the `createLinks` span), `platform/src/modules/website/service.js` (the `createWebsiteService` span), `platform/src/modules/commerce/services/billing.js` (header, `runCheck`, mail, and the grace grep), `platform/src/modules/commerce/core/ledger.js`, `platform/src/modules/commerce/core/money.js` (the replay loop from the receipt case through the return), `packages/protocol/src/webhooks.js`, `packages/protocol/src/tickets.js`, `packages/cli/README.md`, `packages/app-kit/README.md`, `packages/importer/README.md`, `packages/importer/src/mappings/sisters-boutique/index.js` (header and mapping name only).

### Not opened

Do not treat these as specified. `packages/ui` `AppShell`, `Page`, and `SwapTransition`. Feature JSON schemas and gateway connection forms. Product `server/` routes, manifests, and `staff.js`. `proxy.js`. Identity service beyond the token routes. The rest of `money.js` outside the replay loop. E2E tests. The body of the store-specific importer steps. Growth `settings.js` notice text. `packages/net` `isSafeMongoUri` (only its call site was opened). The settings rows in section 9 are the sidebar keys in `categories.js` and the extra editors in Ecommerce `settings.js`, not every schema property inside a feature.

This pass also opened `packages/ui/src/dashboard-tabs.js` from `SettingsPanel` through `PricesTab`, `packages/ui/src/dashboard-settings.js` `TextFields` and `textSections`, `products/ecommerce/app/dashboard/payment-methods.js`, `flow-editor.js`, `grades.js` (`GradeFields`, `BulletsField`, `GradesEditor`), `lists.js` `ZonesEditor` and `RatesPart`, and the `mount*` function at the top of each staff widget named in section 9.

The earlier draft's count of 152 settings rows was not re-counted. It is not a requirement.

This pass opened `products/ecommerce/app/dashboard/store-details.js`, `products/ecommerce/schemas/store_details.settings.json`, `products/ecommerce/schemas/events.settings.json`, `products/ecommerce/server/order-events.js` (the `s.has('events')` checks), `products/notifications/schemas/multi_language.settings.json`, `products/notifications/schemas/send_api.settings.json`, `products/notifications/server/sending.js` (the `pickVersion` call), `products/payments/schemas/subscriptions.settings.json`, `products/payments/schemas/payment_api.settings.json`, `products/payments/schemas/api.json` (the `/v1/subscriptions` paths), `products/payments/adapters/gateways/paypal.js` (the subscription calls), `products/chat/schemas/language_lock.settings.json`, `packages/net/src/mongo.js` `isSafeMongoUri`, `packages/net/src/policy.js` (the outbound rules through `allowHostsFor`), and `platform/proxy.js`.

Still not opened: `packages/ui` `AppShell` body, `Page`, and `SwapTransition`. Gateway connection forms. Product `server/` routes other than `order-events.js` and the subscription paths in `api.json`. Manifests other than the feature keys already named. `staff.js`. Identity service beyond the token routes. The rest of `money.js` outside the replay loop. E2E tests. The body of the store-specific importer steps. Growth `settings.js`. The bodies of the staff widgets below the `mount*` line. `BrandingCard` and `SupportCard` in `platform/src/console/admin/views/settings.js` past their function names. Every `x-ui` property inside feature schemas other than the widget names searched in this pass.

## 9. Complexity still on screen

The row verdicts below still apply. Section 10 changes which screen they live on, and phases 1, 2, and 4 change with it. This section does not add a page.

**Settings list.** Each key below is one row in that product's Settings sidebar (`categories.js`). Ecommerce also adds the editors in `products/ecommerce/app/dashboard/settings.js`. Three verdicts:

- **Keep** — the row stays visible so a website can be set up without hunting.
- **Hide until the feature is on** — a merchant does not see the row while the feature is off. Owner and Support still see it, because they are the ones who switch features (`packages/ui/src/dashboard-tabs.js` `SettingsTab`). The data and the server feature stay.
- **Delete** — remove the row from Settings. Do not remove a server route that the CLI or a widget still calls.

`import` on Accounts, Chat, Ecommerce, and Growth is **delete**. Import stays a command-line mapping (`packages/importer`). It is not a Settings row. Ecommerce `csv` is **delete** for the same reason: a CSV importer is not a Settings screen. Widgets that already download a file keep doing that from the widget.

### Accounts — `products/accounts/app/dashboard/categories.js`

| Row | Verdict |
| --- | --- |
| `email_password` | Keep |
| `phone_password`, `email_code`, `phone_code`, `google`, `apple`, `facebook` | Hide until the feature is on |
| `passwords` | Hide until `email_password` or `phone_password` is on. It is a shared section, not its own product. |
| `phone` | Hide until `phone_password` or `phone_code` is on |
| `approval`, `role_requests`, `two_step`, `risk_checks` | Hide until the feature is on |
| `roles` | Keep |
| `custom_fields`, `consents`, `data_rights` | Hide until the feature is on |
| `profile` | Keep |
| `staff_links` | Keep |
| `orders_tab`, `activity_copies` | Hide until the feature is on. Orders day-to-day stay in the Ecommerce `orders_admin` mount. |
| `import` | Delete |

### Chat — `products/chat/app/dashboard/categories.js`

| Row | Verdict |
| --- | --- |
| `visitor_chat` | Keep |
| `guest_chat`, `signed_in_chat` | Keep. The dashboard already warns when visitor chat is on and neither is on (`products/chat/app/dashboard/tabs.js`). |
| `attachments`, `typing_receipts`, `ratings`, `transcripts` | Hide until the feature is on |
| `inbox` | Keep |
| `handoff`, `assignment`, `presence_queue`, `saved_replies`, `internal_notes`, `context_panel`, `ai_summary`, `staff_alerts`, `visitor_alerts` | Hide until the feature is on |
| `ai_replies` | Keep |
| `ai_instructions`, `fallback_answers`, `ai_backup`, `ai_caps`, `ai_cost_alerts`, `shop_context` | Hide until the feature is on |
| `language_lock` | Delete the Settings row. `products/chat/schemas/language_lock.settings.json` takes its list from `region.languages`, and section 9 hides that list. One `region.language` remains. Chat does not get a second language list. Remove the detection branch in `products/chat/server/reply.js` with the row. |
| `knowledge_base`, `knowledge_pages`, `knowledge_editor` | Hide until the feature is on |
| `webhook_tools`, `book_slot`, `shop_search`, `shop_deals`, `shop_top`, `shop_my_orders`, `track_shipment`, `product_cards` | Hide until the feature is on |
| `proactive_idle`, `proactive_pages`, `proactive_exit`, `leads_flows`, `custom_fields` | Hide until the feature is on |
| `moderation`, `reports` | Hide until the feature is on |
| `import` | Delete |

### Ecommerce categories — `products/ecommerce/app/dashboard/categories.js`

| Row | Verdict |
| --- | --- |
| `store_details` | Delete as a Settings row. `products/ecommerce/schemas/store_details.settings.json` is an empty object. `products/ecommerce/app/dashboard/store-details.js` only prints Portal facts and a link back to Website settings. Keep `GET /v1/shop/store` and `GET /v1/shop/store/business-json`. |
| `catalog` | Keep |
| `variants`, `size_charts`, `multi_location`, `grades_serials`, `digital_goods`, `bookings`, `measured_sales` | Hide until the feature is on |
| `checkout` | Keep |
| `delivery_zones`, `courier_apis`, `taxes`, `invoices`, `returns` | Hide until the feature is on |
| `coupons`, `deals`, `bundles`, `loyalty`, `role_pricing` | Hide until the feature is on |
| `reviews`, `wishlist`, `alerts`, `compare` | Hide until the feature is on |
| `seo` | Keep |
| `landing_pages`, `feeds`, `llms_txt`, `ai_copy` | Hide until the feature is on |
| `staff_alerts`, `reports`, `bulk_actions` | Hide until the feature is on |
| `events` | Delete the Settings row. `products/ecommerce/schemas/events.settings.json` has no fields. `products/ecommerce/server/order-events.js` only checks `s.has('events')` before it publishes. Publishing stays on when Ecommerce is on. |
| `csv` | Delete |
| `import` | Delete |

### Ecommerce extra editors — `products/ecommerce/app/dashboard/settings.js`

These sit under a feature. A feature that is off is not the place to edit them. `off={false}` is passed into these editors today, so they do not show an off state of their own.

| Row | Verdict |
| --- | --- |
| `store_details` | Delete. Same card as the category row above. |
| `catalog` → item types | Hide until `catalog` is on |
| `bookings` → booking schedules | Hide until `bookings` is on |
| `grades_serials` → grades, unit states | Hide until `grades_serials` is on |
| `checkout` → payment methods | Delete as an editor. Phase 2 keeps one manual-method list, on Payments. |
| `checkout` → order flow | Hide until `checkout` is on |
| `checkout` → reasons and files (cancel reasons, delivery-failure reasons, attachment kinds) | Hide until `checkout` is on |
| `checkout` → couriers | Hide until `checkout` is on |
| `checkout` → policies | Hide until `checkout` is on. This is the policy body. The Portal document editor is the copy that goes (below). |
| `checkout` → segments | Hide until `checkout` is on |
| `delivery_zones` → zones | Hide until `delivery_zones` is on |
| `taxes` → tax rules | Hide until `taxes` is on |
| `reviews` → review questions | Hide until `reviews` is on |
| `returns` → claim kinds, claim statuses | Hide until `returns` is on |
| `role_pricing` → role prices | Hide until `role_pricing` is on |

### Growth — `products/growth/app/dashboard/categories.js`

| Row | Verdict |
| --- | --- |
| `google_tags`, `meta_pixel`, `tiktok_pixel`, `custom_scripts` | Hide until the feature is on |
| `consent_banner` | Keep |
| `tags`, `pixels` | Hide until a tag or pixel feature is on. They are shared sections, not extra products. |
| `visitor_analytics`, `conversion_funnel`, `searches_404s`, `web_vitals` | Hide until the feature is on |
| `robots_verification`, `seo_checklist`, `indexnow`, `redirects` | Hide until the feature is on |
| `notice_bar` | Hide until the feature is on |
| `import` | Delete |

### Notifications — `products/notifications/app/dashboard/categories.js`

| Row | Verdict |
| --- | --- |
| `templates` | Keep |
| `email` | Keep |
| `sms`, `whatsapp`, `browser_push`, `staff_push`, `webhooks` | Hide until the feature is on |
| `quiet_hours` | Hide until the feature is on. Phase 2 still defaults a blank row from the website's opening hours. |
| `send_limits`, `fallback`, `delayed_send` | Hide until the feature is on |
| `multi_language` | Delete the Settings row. `products/notifications/schemas/multi_language.settings.json` has no fields. The switch only changes `pickVersion` in `products/notifications/server/sending.js`. One website language stays on Region. Template language versions are not a merchant row. |
| `send_api` | Delete the Settings row. `products/notifications/schemas/send_api.settings.json` has no fields. Sending by API stays available when Notifications is on. It is not a form. |
| `delivery_log` | Hide until the feature is on. Staff read the log in the `delivery_log` widget, not as a second Settings form. |

### Payments — `products/payments/app/dashboard/categories.js`

| Row | Verdict |
| --- | --- |
| `manual_payments` | Keep. This is the pay-method editor phase 2 keeps. |
| `stripe`, `paypal`, `payfast`, `payfast_pk`, `jazzcash`, `easypaisa`, `rapid`, `generic_gateway` | Hide until the feature is on |
| `payment_links`, `refunds` | Hide until the feature is on |
| `subscriptions` | Delete the Settings row and `subscriptions_admin`. `products/payments/schemas/subscriptions.settings.json` has no fields. PayPal still has subscription calls in `products/payments/adapters/gateways/paypal.js`, and `products/payments/schemas/api.json` still has `/v1/subscriptions`. Those routes and the widget are the feature, and this product does not sell subscriptions. Remove the routes, the widget, and the PayPal subscription calls together. Do not leave a switch with no form. |
| `payment_api` | Hide until the feature is on. Unlike the empty schemas above, `products/payments/schemas/payment_api.settings.json` has real fields: checkout expiry, method order, and preferred method. |

### Website settings — `platform/src/console/views/website-settings-sections.js`

Only fields that copy another editor, or lists a normal website does not fill. Everything else in Business, Brand, Region, Pages, and Team stays.

| Field | Verdict |
| --- | --- |
| Business `otherNames` | Hide. One business name is the field. |
| Business `phones` (label + number rows) | Hide. One phone field is enough. WhatsApp stays a single field. |
| Brand picture URLs other than `logo` and `favicon` (`logoDark`, `icon`, `faviconDark`, `shareImage`) | Hide |
| Brand `theme.colors` rows other than `accent` | Hide. The preview reads `colors.accent`. The editor still invents names (`color1`) up to 24 rows (`BrandSection`, line 568). |
| Brand `theme.fontFamily` | Hide. It is a raw CSS font string (`BrandSection`, line 536). |
| Brand `theme.radius` | Hide the raw 0–24 number. One corner control is enough if the preview stays. |
| Brand `theme.mode` | Keep. Light, dark, or auto. |
| Brand `theme.customCss` | Delete from the merchant form (section 12). |
| Region `languages` (the extra list) | Hide. One `language` field stays. Multi-language catalogs stay out of scope. |
| Region `currencies` (the extra list) | Hide. One `currency` field stays. Multi-currency selling stays out of scope. |
| Region `countriesServed` | Hide |
| Region `format.currencySymbols` | Hide |
| Region `address.regions` (country + name lines) | Hide |
| Region `phone.countries` | Hide |
| Pages `documents` key, title, and text body | Delete from Portal. Ecommerce policies (`settings.js` → `PoliciesEditor`) are the body. Pages keeps hosts, the sign-in path, and the privacy path. |
| Team `support.email` and `support.phone` | Delete. Business already has email and phone. Team keeps recipients, the SMS / WhatsApp choice, and staff push. |

Opening hours stay on Business. They are not a copy of Notifications quiet hours.

### Fields a person should not see

**Texts** (`packages/ui/src/dashboard-tabs.js` `TextsTab`, `packages/ui/src/dashboard-settings.js` `TextFields`). Each text is a field whose label is the English and whose help is the key split into words (`grid.sort.price_asc` becomes "Grid › Sort › Price asc"). The raw key is the input `name` and is included in the search string in `TextsPanel`. Do not show the raw key. The English label and the plain-language help stay.

**Payment methods** (`products/ecommerce/app/dashboard/payment-methods.js`). The row is deleted as an editor. If any read-only view remains, hide `key` and the account `currency` (the shop has one currency on Region). Keep name, kind, note, fee, max order, delivery, pickup, instructions, and account label plus `Label: value` lines. Pay-later advance and returned-package fields stay only when the kind is pay-later. `via` stays only to say whether a pay-first method uses Payments.

**Order flow** (`products/ecommerce/app/dashboard/flow-editor.js`). Hide the status `key` and the move `permission` select (`MOVE_PERMISSIONS`). Keep the staff label, the shopper label, the shopper line per payment method, notify, staff alert, who (staff or shopper), what the move needs, and the trigger and start selects. Do not offer `system` as a who-choice on the form. The reset-to-default button stays.

**Grades** (`products/ecommerce/app/dashboard/grades.js`). Hide `key` (the field and the key printed as the row's value), `categoryId`, the `categoryIds` and `typeKeys` id tags, the bullet `icon` name, and the free-text `color` box. Keep the label, condition, return time and unit, warranty time and unit, the color picker, active, description, video, summary, bullet text, and the grade page's SEO title, description, body, and questions. Those SEO fields are the grade's own page, not the Portal legal body.

**Zones** (`products/ecommerce/app/dashboard/lists.js` `ZonesEditor`, `RatesPart`). Hide the zone `key` and the rate `key`. Keep the zone name, the place lists (countries, regions, cities, areas, postcodes), and for each rate the name, delivery or pickup, price, free-over, min and max days, the weight or value condition, and pickup locations.

### Staff mounts

The separate mounts are the product. Do not add a Portal staff home, and do not add a shell that merges products.

Each `products/*/ui/widget.js` starts staff widgets only inside elements the merchant's developer placed (`data-ss-<product>="<key>"`), and only while that key is in the admin config. Each `mount*` function renders into the `host` it is given:

| Product | Mounts | File |
| --- | --- | --- |
| Accounts | `users_admin`, `roles_admin`, `activity_admin` | `products/accounts/ui/widget.js` → `users-admin.js`, `roles-admin.js`, `activity-admin.js` |
| Ecommerce | `catalog_admin`, `orders_admin`, `promotions_admin`, `customers_admin` | `products/ecommerce/ui/widget.js` |
| Chat | `inbox`, `knowledge_editor`, `reports` | `products/chat/ui/widget.js` |
| Notifications | `delivery_log`, `template_editor`, `send_message`, `staff_push_permission` | `products/notifications/ui/widget.js` |
| Payments | `payments_admin`, `links_admin` | `products/payments/ui/widget.js`. `subscriptions_admin` comes out with the subscriptions row above. |
| Growth | `analytics_dashboard`, `seo_checklist`, `redirects` | `products/growth/ui/widget.js` |

Two Ecommerce mounts already group their own job inside that one host. `mountOrdersAdmin` (`products/ecommerce/ui/orders-admin.js`) shows orders and, when returns is on, returns. `mountCatalogAdmin` (`products/ecommerce/ui/catalog-admin.js`) shows the catalog sections whose feature is on. That is as composed as the product gets. A person who does two jobs gets two hosts on a page of the merchant's site, placed by the developer. Portal does not become that page.

## 10. What the screens should be

This judges the screens in the files named here. Phases 1, 2, and 4 change where this section disagrees with them. No new product.

### Shared kit

`/shared-setup` stays. `SharedSetupView` in `platform/src/console/views/setup.js` is the only screen a merchant's developer can open, and they have no Portal login. A panel on the website page would hide the kit behind that login. The owner creates the link from `website-page.js`. They do not send the developer into `SetupView`.

One screen, in this order:

1. The shop's name and domain, one line.
2. The script tag, once.
3. The origins that may call it, including the testing origins, one line. A local storefront fails without that.
4. Storefront. For each product that is on: the visitor hosts to paste, then that product's docs link.
5. Staff page. For each product that is on: the staff hosts to paste, then the one ticket call (`admin({ getTicket })`). Ecommerce already writes that call in `products/ecommerce/app/dashboard/tabs.js` (`Developers`), and the shared page never shows it.
6. One line per product that will not run (stopped, or a connection the widget needs is missing). Not the owner's checklist.

Download JSON stays a secondary action for someone who wants the machine copy. It is not the page.

Noise on `SheetBody` / `ProductPanel`, which `SharedSetup` renders today:

- The business profile and the recommendations. That is an advisor for the owner. Countries and languages already point at Website settings. Feature switches already live on the product dashboard.
- Every on-feature's settings and lists, and the shared settings groups. Those are Website settings and the product Settings tab, printed again. `valueText` even dumps objects as JSON.
- The off-feature list, widget keys, staff permission keys, event names, the API base, the product version, when the sheet was made, and the "server token issued" line.
- Allowed origins and testing origins belong as the one line in step 3, not as a status card next to a generated-at time.
- The owner checklist. That is Portal work. The developer needs the one "not ready" line.

Missing, so they cannot build both pages from this screen today: pasteable staff hosts, and the ticket call. The visitor snippet is already in `product.install` when the link includes install. The staff half is only inside the dashboard Developers tab, which they cannot open.

### Parent and child

A separate page is justified only when the parent would become a different job.

**Website** — `platform/src/console/views/website-page.js`. The parent is the site: domain, status, daily cost, product count, and one card per product (name, what is on, Open). Actions: Visit, Website, Access, Share. Add and remove stay for an admin.

These leave the parent. They are other jobs:

- The open install block (script, browser token, server token) is the kit. Reveal stays a menu action on the card, behind the password, not a form painted on the page.
- The spend chart and the usage table are Usage and credits.
- Recent changes is a settings log. The version number in the header is the same log, and a merchant does not need it on the site.

**Website settings.** Business, Brand, Region, Pages, and Team in `website-settings-sections.js` are one job: what the shop is. One page. Address, hours, and a document stay drawers on that page. Data and files and Between your products in `website-connections.js` are a different job: secrets and which product may call which. That is the Access page. Seven sections in the inner nav of `website-page.js` make the logo and the database password look like the same task.

**Product dashboard** — `packages/ui/src/dashboard.js`, tabs in `packages/ui/src/dashboard-tabs.js`. The parent tab is Overview: what is on, what it costs, what is missing. Settings is the forms for features that are on. That is the same setup job, split so the form is not the status page. Texts is a different job (the words, not the behavior) and stays a tab. Defaults and Prices are a different job (every website, owner only) and stay tabs. The Developers tab is not a merchant job. Its snippets are the kit. Connection forms an owner fills, such as the courier forms wired in `products/ecommerce/app/dashboard/tabs.js`, stay on Settings under the feature.

Ecommerce `products/ecommerce/app/dashboard/settings.js` hangs six editors off checkout (payment methods, order flow, reasons, couriers, policies, segments), each with `top: true`. Order flow stays a section of Settings while checkout is on. It is how checkout behaves, and promoting it to a tab or a Portal page would be a new job the dashboard already refused (the page shows no orders). Payment methods do not stay. They repeat Payments.

### What a normal merchant never sees

- The Setup page: profile drawer, recommendations, per-product setting dumps, origins, keys, events (`SetupView` and `ProductPanel` in `setup.js`).
- The Developers tab (`dashboard.js`, `dashboard-tabs.js`), including the Ecommerce snippet list in `products/ecommerce/app/dashboard/tabs.js`.
- Defaults and Prices. The shell already hides those tabs unless the viewer is an owner.
- Feature rows that are off. Section 9. Owner and Support still see them.
- The install block, the usage table, and the spend chart on `website-page.js`.
- A settings version in the website header.
- The lists and second copies in section 9: extra languages and currencies, color names, other names, extra phones, the Portal legal-document body, team support email and phone, Ecommerce payment methods, order-flow keys and permission keys, grade keys and id tags, zone and rate keys, and the raw text key on the Texts tab.
- Between your products does not sit beside Brand. It is on Access, for the day someone connects a product, not on the everyday facts page.

## 11. What an outsider is given

The Portal is a separate product. These three people do not get its source. An AI will often do the building. Each one gets a different packet. Do not mix them.

### Product author

They create a product the Portal can connect. No Portal login and no Portal source.

**Given.** `ss app init` (`packages/cli/src/init.js`, `packages/cli/src/cli.js`) writes a product from `packages/cli/templates/product`: the folders `core/`, `server/`, `adapters/`, `ui/`, `app/`, `strings/`, `schemas/`, `tests/`, `docs/`, a sample feature `notes`, one API route, one dashboard page, `openapi.json`, `server/widget-script.js`, and a git-ignored `.env.local` with development secrets. Outside a pnpm workspace it also writes the standalone repo files. Dependencies are `@ss/app-kit`, `@ss/cli`, and `@ss/config`. The contract the Portal will enforce is `@ss/contracts` `validateManifest`. Tests run against `createFakePortal` in `packages/app-kit/src/testing.js` (connect, status, website settings, launches, notices), plus `createAccountsDouble`, `createNetwork`, `apiChecker`, and `createMemoryStore`. That fake Portal is the Portal they are allowed to see.

**Can build.** A product another team connects by URL and connect secret: manifest, routes, widgets, dashboard, docs, and OpenAPI. They cannot build Portal screens, merchants, or credits.

**Missing when an AI's product would be refused.** `ss app validate` (`packages/cli/src/validate/index.js`) rejects it. The usual gaps: a folder or file in `ANATOMY` missing; `manifest.json` failing `validateManifest`; a browser, server, or ticket route that is not tied to a manifest feature; the widget script or the docs route not public; `strings/en.json` not the only text file, a bad `{placeholder}`, or a `t('key')` with no string; `.env.example` listing anything besides `MONGODB_URI`, `CONNECT_SECRET`, `ENCRYPTION_KEY`, and optional `ENCRYPTION_KEY_PREVIOUS`; a cron in `vercel.json`; an import that points the wrong way, leaves the product, or uses the DOM from `core/`; a package import that is not a dependency; a third server function; `openapi.json` or `server/widget-script.js` older than the source; `schemas/api.json` invalid, naming a route that does not exist, or missing a browser, server, or ticket route. The Portal's connect handshake (`platform/src/modules/catalog/service.js`) runs `validateManifest` and `validatePriceReport` again and refuses a secret shorter than 32 characters, an answer that does not verify, or a product id that does not match the manifest. An AI that skips the local check fails there too.

**Check.** `ss app validate` exits 0. The generated script is `pnpm validate`, which runs that command. A product is accepted only when it exits 0. Exit 1 rejects it.

### Website builder

They build the merchant's website, usually with an AI. No Portal login and no product source.

**Given.** Only the share kit: `/shared-setup`, rendered by `SharedSetupView` in `platform/src/console/views/setup.js`, and the docs, OpenAPI, and widget script that kit points at (`docs.guide`, `docs.openapi`, `install.scriptUrl` on the product blueprint in `packages/app-kit/src/blueprint.js`). The owner creates the link from the website page. The builder never opens `SetupView`.

**Must contain, in this order, so the generated site works.**

1. Shop name and domain.
2. One script tag (`widgetScriptTag` in `platform/src/modules/catalog/core/setup.js`), with this website's browser token. That token may be in the kit.
3. Origins that accept it: `https://` the domain, plus the testing hosts `localhost`, `*.localhost`, `127.0.0.1`, `[::1]` (`TESTING_HOSTS` in the same file).
4. Visitor widgets that are on: the host element for each, then the docs link for that product.
5. Staff widgets that are on: the host element for each, then the ticket call the site's server makes. The shape is already written for Ecommerce in `products/ecommerce/app/dashboard/tabs.js`. It is not on `SharedSetupView` today.
6. Server calls: the OpenAPI URL and the rule that those calls send the server token with no `Origin` (`packages/app-kit/src/guide.js`). The token itself is not in the kit. The merchant reveals it on the website page and puts it in the site's server environment. The AI reads that environment variable. It does not read Portal.
7. One line when a product will not run (stopped, or a needed connection is not connected). Not the owner's checklist.

**On that screen today, and the builder should not have to read it.** `SheetBody` and `ProductPanel` in `setup.js`: the business profile and recommendations, every feature's settings and lists (`valueText` prints objects as JSON), shared settings, the off-feature list, widget keys, permission keys, event names, the API base, the product version, when the sheet was generated, the "server token issued" sentence, and the owner checklist. `sharedCopy` still sends those when the link is created. `parseShareLink` defaults `values` and `install` to true, so the values are included unless someone turns them off.

**Check.** The Portal marks the visitor script installed only after a browser-token request from the real domain, never from a local origin and never from the server (`packages/app-kit/src/http/handler.js`). `installed` is true when that `lastSeenAt` is within 7 days (`WIDGET_SEEN_MS` in `packages/app-kit/src/dashboard.js`). The site is not live while any on product with a visitor widget has `install.installed !== true`. The Portal does not check staff hosts or server calls. Those are accepted only when the page contains the hosts from step 5 and the server calls use the environment variable from step 6, not a token pasted into the repo.

### Merchant

They do not build. They use `platform/src/console/views/website-page.js` and the settings it opens.

**Stays in front.** Domain, status, daily cost, how many products, and one card per product (name, what is on, Open). Actions: Visit, the facts page (Business, Brand, Region, Pages, Team), Access (database, storage, AI key, and which product may call which), and Share. An admin still adds and removes products here. Reveal of this website's server token stays a menu action on the card, for the merchant to place in the site's server environment. It is not shown on the page, and it is not copied into the share link.

**Moves into the website-builder kit.** The open install block (script tag and browser token), the Developers tab snippets, and everything `SetupView` shows (profile, recommendations, setting dumps, keys, events). The merchant's job ends at Share.

**Check.** The merchant does not run `ss app validate`. They accept the site when the website page shows the products on and the kit reports the visitor script installed, as above.

### Security of the two handoffs

The kit may include this website's browser token, the install snippet, and the public API (docs and OpenAPI). It must not include a server token, a database URI, or a storage secret, including another website's.

**Share link.** `productEntry` in `platform/src/modules/catalog/core/setup.js` puts `browserToken` and the snippet on the sheet and sets `serverToken` to `{ issued: true }` only. The blueprint's connection list is state (`key`, `title`, `state`), not the URI or the storage secret (`packages/app-kit/src/blueprint.js`). That part holds. It fails where a secret is shorter than 8 characters: `secretsIn` drops those strings (`SECRET_MIN_LENGTH`), so `hideSecrets` will not redact them if a setting repeats them. `parseShareLink` also defaults `values` to true, so every other setting value is on the sheet until phase 4 turns that default off.

**Product connect path.** `forProduct` in `platform/src/modules/website/connections.js` returns the merchant's MongoDB URI and the storage object, including `secretAccessKey`, to a product that is on that website and declares that it needs them. The database name is per product. The URI is whatever the merchant pasted. `isSafeMongoUri` in `packages/net/src/mongo.js` checks the host against the outbound policy, refuses unknown URI options, and requires TLS unless the host is allowlisted. It does not look at which databases that user can open. A URI whose user can see more than that database can open another website. That is the break. The connect handshake itself (`catalog/service.js`) does not return those secrets. The delivery after connect does. `platform/proxy.js` only sets the page CSP nonce. It does not inspect tokens or connection strings.

## 12. Security, including the small holes

Hard to attack comes first. A hole that looks small still blocks the screen. None of these wait for phase 3.

| Hole | File | What changes |
| --- | --- | --- |
| Secrets shorter than 8 characters are not secrets. `secretsIn` drops them, so `hideSecrets` will not redact a short key repeated in a setting or a hook. | `packages/app-kit/src/blueprint.js` (`SECRET_MIN_LENGTH`) | Any connection value is a secret, whatever its length. A database URI and a storage secret never appear on a share sheet. |
| A new share link includes setting values and the install snippet unless someone turns them off. `parseShareLink` treats a missing flag as true. | `platform/src/modules/catalog/core/setup.js` | Values default off. The kit is the page. Setting dumps are opt-in. |
| The share key is copied into `sessionStorage` (`ss-shared-setup-key`). A script on the Portal origin can read it and post for the sheet, browser token included. | `setup.js` `sharedKey` | Keep the key in memory for that page load. Do not write it to storage. |
| The browser token is painted on the website page with no password. A stolen merchant session can copy it. The server token is behind a password. The browser token is not. | `website.js` `InstallBlock` | The open install block leaves the merchant page (section 10). The token lives on the share kit, not on a screen a stolen session can scroll. |
| Support sees Reveal, Copy, and Regenerate. The routes require `tokens.reveal`, which Support does not have. | `InstallBlock`, `identity/routes.js`, `rbac.js` | Hide the buttons. A 403 is not a substitute. |
| Brand custom CSS is a textarea and is sent to every widget as `customCss`. | `website-settings-sections.js` `BrandSection`; each `products/*/ui/widget.js` config | A normal merchant does not see this field. It is not applied as raw CSS from that textarea. Growth `custom_scripts` is the same class of hole: script the merchant site will run. It stays off until an Owner turns the feature on, and it is not a default. |
| Activity rows print `before` and `after` with no redaction, cut at 80 characters. | `login-settings.js` `shortValue` / `Changes` | Do not render a value that is a token, a URI, a storage key, or a mail or AI secret. The connection audit already refuses to store those values (`connections.js`). The drawer must not be the place they reappear. |
| Guest order keys sit in `localStorage`. | `products/ecommerce/ui/widget.js` `createOrderKeys` | A script on the merchant site can read them. That matches the leaked-script assumption. The kit must not tell an AI to copy those keys into source. The live-site check rejects a repo that contains a browser token, a server token, a database URI, or a storage secret. |
| Storage is delivered as the merchant's access key and secret. The folder prefix is a string the product is asked to use, not a policy. An Owner may also name another database for one product. | `connections.js` `forProduct`, `dbNameOf` | Phase 4. The prefix help must not call the folder a boundary. The URI's user must not be able to open another website. |
| Download JSON on the shared page is the whole sheet. With install included, that file is the browser token. | `SharedSetup` in `setup.js` | The download is not the primary action. It must follow the same redaction as the page. An AI that saves it into the site repo fails the check above. |

The checks already in the code stay in force and are not loosened to make a screen easier: `checkCsrf`, `tokens.reveal` plus a fresh password, sealed server tokens, connect secret of at least 32 characters, `validateManifest` on connect, and `installed` only after a browser-token call from the real domain (`handler.js`). A local origin does not count as installed. That is intentional. Do not mark a site live from localhost.

## 13. UI kit, forms, and controls

Two kits draw every control. They are not the same components.

**Console kit** — `packages/ui/src/index.js`. React. Used by the Portal and the product dashboards. Fields live in `packages/ui/src/fields.js`: `Input`, `TextArea`, `Select`, `Checkbox`, `Switch`, `RadioGroup`, `SegmentedControl`, `CheckboxGroup`, `ChoicePicker`, `SuggestInput`. Feature settings are not hand-built. `SchemaForm` (`packages/ui/src/SchemaForm.js`) turns each JSON schema into those controls from `x-ui.widget`: `segmented`, `radio`, `select`, `suggest`, `textarea`, `url`, `email`, `tags`, a checkbox group, one-line-per-item, or a raw JSON box when the value is an object the form does not understand. A number is always `<input type="number">`. That input still changes when the pointer wheel rolls over it.

**Widget kit** — `packages/app-kit/src/widget/controls.js` and `admin.js`. Plain DOM, not React. Staff and shopper widgets use `field`, `checkbox`, `radio`, `toggle`, `segmented`, `checkGroup`, `fieldGrid`, `splitView`, `openDialog`, `emptyState`, `errorState`. A widget does not import `@ss/ui`. A fix in one kit does not reach the other. The same job (a text field, a dialog, an empty state) is implemented twice.

**Exports nothing in the Portal or a product imports.** Delete them from `packages/ui/src/index.js` and their tests, unless a later read finds a caller:

| Export | Where it still exists |
| --- | --- |
| `Grid`, `Col` | `packages/ui/src/blocks.js` only. The comment says they are the page grid. No screen uses them. `CardFlow` is the grid that is used. |
| `Disclosure` | Exported, and banned by `packages/ui/test/kit-only.test.js`. |
| `Masonry`, `SoftBreaks`, `LockedState` | `packages/ui/src/display.js` and UI tests. |
| `DrawerSkeleton` | `packages/ui/src/skeletons.js` and `packages/ui/test/skeletons.test.js`. |
| `ToastOnce` | `packages/ui/src/Toast.js`. Screens use `useToast`. |
| `useHashSection` | `packages/ui/src/blocks.js`. `dashboard-page.js` keeps its own hash. The only call is `packages/ui/test/setup.test.js`. |
| `Paged` | `packages/ui/src/paged.js`. Screens use `usePaged`, not the component. |
| `AppFrame`, `Pane` | Aliases of `AppShell` and `ScrollArea` in `index.js`. |

`PillTabs` stays. `SchemaForm.js` renders it. `kit-only.test.js` bans products from importing it, which is correct: products get tabs through `SchemaForm`, not by drawing `PillTabs` themselves. `SeoPreview` stays. `products/ecommerce/app/dashboard/grades.js` renders it. `Stepper` stays. `platform/src/console/views/login-settings.js` uses it. `NextStep`, `ThemeMenu`, and `ThemeToggle` stay. `AppShell.js` and the dashboard use them. `CountUp` stays. `Stat` uses it.

**Brand form, the rest of `BrandSection`.** Section 9 hid the extra pictures and the color names. The same function still shows mode, a font-family string, a radius number, a custom-CSS textarea, a 24-row color editor, and a preview. Mode and the preview stay. Font family, the radius number, custom CSS, and the color-name rows do not.

**Platform settings, `platform/src/console/admin/views/settings.js`.** These are the platform admin's job, not the merchant's. They were missing from the screen list:

| Card | Fields |
| --- | --- |
| Mail | Host, port, user, password, sender name, sender address. Test and remove. |
| Security | Session length in hours. Require two-step for admins. |
| Billing | Grace days. Low-balance days. |
| Encryption | Re-seal stored secrets after a key change. |

Branding and Support are the other two cards in that file (`BrandingCard`, `SupportCard`). Their fields were not read in this pass. Do not invent them.

**What a schema form must not do.** If `SchemaForm` cannot draw a value, it falls through to `JsonField` (line 371). A merchant must never see a JSON box. A setting that reaches that branch is an unfinished form, not a feature. `x-ui.advanced` stays collapsed. Empty-object schemas (`store_details`, `events`, `multi_language`, `send_api`, `subscriptions`) must not become a row just so `SchemaForm` has something to mount.

Phase 3 adds: delete the unused kit exports above, and stop the number input from changing on wheel, in both `packages/ui/src/fields.js` and `packages/app-kit/src/widget/controls.js`.

