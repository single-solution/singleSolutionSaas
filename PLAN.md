# Single Solution — architecture & build specification

Private platform. Derived from live code. Anything may be deleted. This is the binding design for restructuring: **secure by default, easy to learn, reliable under failure, adaptable without Portal rewrites, and polished in motion** — not a pile of screens.

---

## What I learned

Every claim names a file that was opened.

1. **Platform.** Portal (`platform/`) plus separately hosted products. Control plane in the Portal; business data in merchant DBs inside products (`platform/README.md`, `README.md`, `packages/app-kit/README.md`).
2. **Sign-in.** One `/login`: email/password (+ optional 2FA). Admins → `/admin`; merchants → `/overview` (`platform/app/(console)/_views/login.js`, `platform/src/modules/identity/routes.js`, `platform/app/(console)/_lib/server.js`). Product dashboards: one-time launch JWT → `/sso` (`packages/protocol/src/launch.js`, `packages/app-kit/src/dashboard.js`). Site staff: Accounts sign-in + 15‑minute tickets (`packages/app-kit/src/kit-routes.js`, `packages/protocol/src/tickets.js`).
3. **Product.** `manifest.json`: id, name, version, endpoints, widgets, features (+ settings schemas), permissions, optional needs/links (`packages/contracts/src/schemas/manifest.js`).
4. **Where truth lives.** Website facts & sealed connections: Portal (`platform/src/modules/website/`). Feature switches, product settings, texts: product dashboard API (`packages/app-kit/src/dashboard.js`). Live records: product APIs + admin widgets (`packages/app-kit/src/staff.js`).
5. **New product, no Portal page.** Connect → place → card + launch + blueprint (`platform/src/modules/catalog/`, `platform/src/console/views/website-page.js`, `platform/src/modules/catalog/setup.js`). Sidebars never list product ids (`platform/src/console/views/shell.js`, `platform/src/console/admin/views/shell.js`).
6. **Outsiders.** Authors: published `@ss/*` + `ss app init` (`packages/cli/README.md`). Site builders: docs/OpenAPI + one website’s tokens. Migration: `ss-import` (`packages/importer/README.md`). Reviewers: shared-setup link, no secrets. Never the whole monorepo.

---

## Design bars (fail the plan if any break)

| Bar                   | Meaning                                                                                                                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Secure**            | Every deny is a server check. Sessions are single-purpose. Secrets never on everyday UI. Stolen credential blast radius is traced and closed.                                                                                      |
| **Easy to learn**     | Three mental models only (below). Same shell, same verbs, same next-action pattern everywhere. No second navigation language per product.                                                                                          |
| **Reliable**          | Idempotent writes, single-use launches, offline status grace already in kit, sealed secrets with reseal, rate limits on secret delivery. Fail closed.                                                                              |
| **Adaptable**         | Screens and menus come from placement + manifest. No hardcoded product names in Portal nav.                                                                                                                                        |
| **Simple navigation** | Shallow tree. One job per screen. List ∥ detail. Drawers for rare/dangerous. Never a scroll of unrelated jobs.                                                                                                                     |
| **Motion**            | Frame stays still; content transitions. Progress bar while navigating. Respect `prefers-reduced-motion`. Use the existing kit (`packages/ui/src/motion.js`, `packages/ui/src/AppShell.js`) — do not invent a second motion system. |

---

## Architecture in one page

```
┌─────────────────────────────────────────────────────────────┐
│  PORTAL (control plane)                                     │
│  people · websites · placement · credits · website settings │
│  sealed connections · launches · tokens · setup blueprints  │
└───────────────┬─────────────────────────────┬───────────────┘
                │ signed protocol             │ launch SSO
                ▼                             ▼
┌───────────────────────────┐   ┌─────────────────────────────┐
│  PRODUCT (capability)     │   │  CONFIGURE dashboard        │
│  API · widgets · docs     │   │  settings / texts / setup   │
│  merchant DB collections  │   │  never live ops             │
└─────────────┬─────────────┘   └─────────────────────────────┘
              │ ticket + staff sign-in
              ▼
┌───────────────────────────┐
│  OPERATE (admin widgets)  │
│  inbox · orders · desks   │
│  live records only        │
└───────────────────────────┘
```

**Three mental models (teach these; nothing else):**

1. **Portal** — “Who we are, which websites, what’s placed, money, shared website facts.”
2. **Configure** — “How this product behaves on this website.” Opened from Portal via launch.
3. **Operate** — “Today’s work on live records.” Staff on the merchant site, ticket-scoped widgets.

If a screen does not clearly belong to one model, split or delete it.

**Trust boundaries (non-negotiable):**

| Boundary                  | Mechanism (code)                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| Portal ↔ product          | Connect handshake, notices, portal calls, client assertions (`packages/protocol/`)         |
| Browser ↔ product         | Browser token + exact origin (`packages/protocol/src/tokens.js`)                           |
| Merchant server ↔ product | Server token; config/PII needs `SS-Sign-In` + permission (`packages/app-kit/src/staff.js`) |
| Staff widget ↔ product    | Ticket: origin-bound, 15m, permission list (`packages/protocol/src/tickets.js`)            |
| Human ↔ dashboard         | Launch JWT consumed once → HttpOnly configure cookie (`packages/app-kit/src/dashboard.js`) |

A credential minted for one boundary **must not** authorize another. Tests enforce this, not UI hiding.

---

## 1. What the product is, and how a new product plugs in

**Single Solution** is a private multi-tenant control plane plus independently deployed products. Merchants and platform operators use the Portal. Each product is a capability (identity, shop, chat, …) with its own deployable, database, API, widgets, and configure dashboard.

**Plug-in path (the only way products appear):**

1. Author with published `@ss/*` and `ss app init` — not by cloning this monorepo (`packages/cli/README.md`).
2. Valid `manifest.json`; `ss app validate` green (`packages/contracts/src/schemas/manifest.js`).
3. Deploy; Owner connects URL + `CONNECT_SECRET` → starts `inactive`; set `active` (`platform/src/modules/catalog/service.js`).
4. Place on a website → tokens minted, links computed, connections delivered only while placement is `added` **and** catalog is active (`platform/src/modules/website/connections.js` — harden catalog-active gate).
5. Merchant sees a product **row** (not a Portal route). **Open** → launch → configure dashboard. Setup sheet aggregates `GET /v1/blueprint`.

**Adaptability rule:** Portal never gains a menu item or page named after a product. Product UI is declared by the product (manifest features/widgets + dashboard tabs from `@ss/ui/dashboard`).

---

## 2. People, sessions, and power

### People

| Person            | Signs in with                                                                                      | Lands                   | May do                                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Platform operator | Portal email/password (+2FA); roles `owner` / `support` / `finance` (`platform/src/infra/rbac.js`) | `/admin`                | Run the platform. Finance: money only — **never** product launches (`adminLaunch` in `platform/src/modules/catalog/service.js`). |
| Merchant          | Portal email/password                                                                              | `/overview`             | Own websites, website settings, billing, open **configure**, install **ceremony**.                                               |
| Site staff        | Accounts on the merchant site                                                                      | Site admin UI / widgets | **Operate** live records within role permissions. Never Portal.                                                                  |
| Visitor           | Browser token (± shopper sign-in)                                                                  | Merchant site           | Visitor APIs/widgets only.                                                                                                       |
| Product runtime   | Assertion after connect                                                                            | —                       | Status, reports, fetch settings/connections for placed+active only.                                                              |

### Sessions (single purpose)

| Session                              | Configure behavior          | Edit live records              | Portal setup | Mints                            |
| ------------------------------------ | --------------------------- | ------------------------------ | ------------ | -------------------------------- |
| Portal admin cookie                  | Only after configure launch | No                             | By role      | Configure launch (owner/support) |
| Portal merchant cookie               | Only after configure launch | No                             | Own sites    | Configure launch                 |
| **Configure** cookie (dashboard SSO) | Yes                         | **No**                         | No           | Nothing                          |
| Staff ticket                         | No                          | Yes (listed perms, 15m)        | No           | Nothing                          |
| Server token alone                   | No                          | Only explicit non-staff routes | No           | Nothing                          |
| Browser token                        | No                          | No                             | No           | Nothing                          |

### Fixes vs today’s code

1. **Rename colliding `owner`.** ✅ Dashboard sessions use `portal_owner` / `portal_support`; Accounts staff “Owner” stays separate.
2. **Configure ≠ operate.** ✅ Every product dashboard is setup-only; `routes.configure` + kit cross-credential tests; live ops in admin widgets.
3. **Merchant never switches features.** ✅ Feature reports / advisor Switch on are Owner/Support only.
4. **Placement write rights.** ✅ Merchants lack `products_on_websites.write`; UI `can.manage` gates Add/Remove.
5. **Tighten `allows()`.** ✅ Fail-closed without ticket/staff.
6. **Catalog inactive ⇒ no secrets.** ✅ `forProduct` requires placement `added` and catalog active.

---

## 3. Navigation & UX (easy, shallow, animated)

### Learn in sixty seconds

**Merchant:** Overview → Websites → (pick site) → products on this site → Open configure / Setup / Settings / Install.  
**Admin:** Overview → Merchants or Products or Finance — same website surface as merchant when drilling in.  
**Staff:** Sign in on the site → admin widgets for the job. No Portal tour required.

Same verbs everywhere: **Open**, **Set up**, **Settings**, **Install**, **Remove** (⋯). No product-specific Portal jargon.

### Navigation structure

```
Portal shell (AppShell — stays mounted)
├── Primary nav: few items, role-filtered          [merchant: Overview · Websites · Usage · Account]
│                                                 [admin: Overview · Merchants · Products · Billing · …]
├── Context switcher (website / merchant) in footer
└── Main pane
    ├── List column ∥ detail (when picking records)
    └── Page: header (crumbs, status, primary action, ⋯) + one job body
         ├── Drawer: create / rare / dangerous
         └── Dialog: typed or password confirm
```

Product configure uses the same shell language via `@ss/ui/dashboard` (Overview · Settings · Texts · Developers; Owner globals separate).

**Depth rule:** new URL only when the **job** changes (home → settings section → setup → install ceremony → configure launch). In-page tabs/sections for the same job. Legacy deep links may redirect to a section on the one page (`platform/src/console/website-parts.js`) — do not grow a tab maze.

### One job per screen (website redesign)

| Screen             | Job                        | On screen                             | Closed until asked              |
| ------------------ | -------------------------- | ------------------------------------- | ------------------------------- |
| Website home       | See products & status      | Rows: name, status, cost, **Open**, ⋯ | Install, remove, usage charts   |
| Setup              | Decide what to turn on     | Advisor + blueprint actions           | Raw JSON unless Download        |
| Settings /:section | Edit one shared fact group | Form + save bar                       | Other sections (inner nav only) |
| Install ceremony   | Get credentials once       | Snippet + tokens after step-up        | —                               |
| Configure Overview | Is this product ready?     | Checklist + next step                 | Settings forms                  |
| Configure Settings | Change behavior            | Feature settings                      | Secrets plaintext               |
| Operate widget     | Work one queue/list        | List ∥ record                         | Portal chrome                   |

**Delete** today’s website mega-scroll (status + product cards with install blocks + timeline + usage) as the default home (`platform/src/console/views/website-page.js`).

### Motion & transitions (use the kit — raise the bar)

Grounded in `packages/ui/src/motion.js` and `packages/ui/src/AppShell.js`:

| Moment                    | Behavior                                                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route change              | Shell fixed; `PageTransition` / View Transition on content; `NavigationProgress` top bar (`platform/src/console/navigation.js` + `useNavigationProgress`) |
| Section swap in dashboard | `SwapTransition` — no full remount flash                                                                                                                  |
| Nav current item          | Sliding pill **before** the page arrives (perceived speed)                                                                                                |
| Drawer / dialog           | `usePresence` enter/exit; trap focus; Esc closes                                                                                                          |
| Buttons / rows            | `ss-motion ss-press` press feedback; pending spinner in fixed slot (`PendingHint`)                                                                        |
| List selection            | Highlight slides to row (`ListColumn`)                                                                                                                    |
| Reduced motion            | Instant unmount / no exit wait (`usePresence`)                                                                                                            |

**Do not:** bounce, parallax stacks, decorative particle motion, or a second animation library. **Do:** 150–200 ms ease, consistent `--ss-motion` tokens, skeleton → content crossfade so the app feels continuous and calm.

### Reliability UX

- Optimistic UI only where the server is idempotent; otherwise button loading until settle (`packages/ui` Button patterns).
- Toasts for outcomes; inline field errors for validation; never silent failure.
- Dangerous actions: password (+2FA) confirm already used for tokens/connections — same pattern for launch and regenerate (`platform/src/console/views/website.js`, website routes `confirm`).

---

## 4. Current surfaces inventory

### Merchant (`platform/app/(console)/[...path]/page.js`)

| Path                              | Decision                                            |
| --------------------------------- | --------------------------------------------------- |
| `/login`, password/email flows    | **Keep**                                            |
| `/overview`                       | **Keep** — attention only                           |
| `/websites`                       | **Keep** — list ∥ pick                              |
| `/websites/:id`                   | **Redesign** — product rows; fold install/usage off |
| `/websites/:id/settings/:section` | **Keep**                                            |
| `/websites/:id/setup`             | **Keep**                                            |
| `/credits`, `/credits/receipts`   | **Keep**                                            |
| `/account`                        | **Keep**                                            |
| `/shared-setup`                   | **Keep**                                            |

### Admin (`platform/app/(admin)/admin/[[...path]]/page.js`)

| Path                                                                    | Decision                                   |
| ----------------------------------------------------------------------- | ------------------------------------------ |
| Home, merchants, products, finance, admins, settings, activity, account | **Keep** jobs                              |
| Merchant website drill-in                                               | **Same redesign** as merchant website      |
| Sidebar                                                                 | Platform jobs only — **never** product ids |

### Product configure (`products/*/app/dashboard/`)

| Product                                                    | Decision                                                                                                              |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| accounts, notifications, chat, payments, ecommerce, growth | **Keep** configure tabs; **move** any live ops to widgets; kit tests forbid business mutations from configure session |

### Protocol spine — **keep**

Connect, notices, tickets, blueprint, widget.js, SSO (`packages/app-kit/README.md`, `packages/protocol/README.md`).

---

## 5. Outsiders — smallest artifact + gate

| Outsider       | Receives                                   | Accept                                  | Reject                                |
| -------------- | ------------------------------------------ | --------------------------------------- | ------------------------------------- |
| Product author | `@ss/*` + `ss app init` template           | `ss app validate` + connect OK          | Monorepo clone as onboarding          |
| Site developer | `/docs`, OpenAPI, one browser/server token | Token verifies for website×product×kind | Portal/product source; other sites    |
| Client/agency  | Shared-setup link                          | Unexpired; secrets stripped             | Tokens, connection values             |
| Migration op   | `ss-import` + mapping + env tokens         | Dry-run + verify                        | Platform/product source; admin login  |
| Staff          | Accounts user + ticket                     | Website-scoped sign-in + perms          | Portal; configure launch; other sites |

---

## 6. Security architecture

### Layers

1. **Transport & cookies** — HTTPS; HttpOnly Secure SameSite session cookies; CSRF origin checks on Portal mutating routes.
2. **RBAC** — `can(actor, permission, resource)` on every Portal route (`platform/src/infra/rbac.js`). Hide controls to match; **never** as the only control.
3. **Protocol typing** — Launch ≠ ticket ≠ browser token ≠ server token ≠ notice (`typ` separation in `packages/protocol/README.md`).
4. **Least privilege sessions** — table in §2; cross-mint forbidden.
5. **Secret handling** — sealed at rest (`ENCRYPTION_KEY`); reveal/regenerate after step-up; rate-limited delivery to products; no secrets in blueprints or shared-setup.
6. **Placement + catalog gate** — unplaced or inactive product → no connection/settings secrets.

### Stolen credential matrix

| Stolen                     | Residual power                    | Close                                                          |
| -------------------------- | --------------------------------- | -------------------------------------------------------------- |
| Portal cookie              | Act as that person                | Short TTL, rolling, step-up for launch & token ceremony        |
| Configure cookie           | Change settings/texts/connections | No live-record routes; no ticket mint; rename roles            |
| Staff ticket               | Widget APIs 15m                   | Origin + `tid` revocation; Portal ignores tickets              |
| Server token               | Server routes                     | Staff required for config/PII; fix `allows()`                  |
| Browser token              | Visitor APIs from domain          | Keep origin allowlist; off everyday UI                         |
| Connect secret / assertion | Impersonate product               | Never re-display; reconnect to rotate; inactive blocks fetches |
| Launch JWT                 | One SSO if unconsumed             | Keep single-use consume                                        |
| `ENCRYPTION_KEY`           | Open sealed material              | Reseal ceremony only; never everyday UI                        |

---

## 7. Build order (shippable increments)

Each increment is releasable; security/session split first.

1. **Session & rights hardening** — ✅ role rename (`portal_owner` / `portal_support`); configure≠operate; `allows()` fail-closed; catalog-inactive on delivery; cross-credential refuse tests.
2. **Website navigation redesign** — ✅ one-job home; Install ceremony; drawers; motion via existing `PageTransition` / progress (no new motion stack).
3. **Product configure purge** — ✅ dashboards settings-only; `routes.configure` + kit regression (configure session cannot mint tickets / hit live routes).
4. **Outsider packaging clarity** — ✅ `ss app init` docs; monorepo is not onboarding; importer stays separate.
5. **Polish pass** — ✅ empty states with next action; e2e launch password step-up + Install reveal ceremony (motion kept; reduced-motion already in kit).

**Then new products:** manifest → connect → place → launch/blueprint only — covered by `e2e/tests/plug-in-path.test.js`. Portal menus never list product ids.

---

## 8. Read log

### Opened

`README.md`, `platform/README.md`, `platform/src/infra/rbac.js`, catalog/commerce/website/identity modules and routes, `platform/src/console/views/website-page.js`, `website.js`, merchant/admin shells & route tables, `packages/contracts` manifest + README, `packages/protocol` README + tokens/launch/tickets, `packages/app-kit` README + `dashboard.js` + `staff.js`, `packages/cli` + template README, `packages/importer/README.md`, `packages/ui/README.md` + `dashboard.js` + `motion.js` + `AppShell.js`, `platform/src/console/navigation.js`, accounts/ecommerce dashboard entrypoints.

### Not opened (deliberately)

Prior PLAN drafts as design authority; exhaustive product `server/` trees; e2e suites; `packages/net` / `packages/config` internals.

---

_End of specification._
