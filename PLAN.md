# Single Solution — Platform Plan (single source of truth)

|                  |                                                                                                                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**       | Direction approved · pre-implementation · greenfield (existing `singleSolutionSaas` code retired; UI look and ideas carry over)                                                                                         |
| **Date**         | 2026-10-01 · Owner: Bilal (single-solution)                                                                                                                                                                             |
| **Deliverables** | **A. Control plane** (Portal) · **B. Delivery plane** (Loader, Edge Injection, hosted pages, preview) · **C. Products** (independent) · **D. Contracts & kit**                                                          |
| **Hosting**      | Vercel Hobby + MongoDB Atlas M0 ($0, F.19), one project/database per deployable; no vendor-specific code                                                                                                                |
| **Language**     | JavaScript (ESM), functional, JSDoc-typed, `tsc --checkJs --strict` in CI                                                                                                                                               |
| **This file**    | The only planning document. Sections 1–16 + Appendices A–C = platform plan · **Part D** = product specifications (every element and what can be modified) · **Part E** = the Product Standard every product must follow |

---

## 1. What we are building, and why it wins

**One line.** A website adds a domain, switches on the elements it wants, and they appear on the site within seconds — fast, on-brand, configurable to the field, billed by the hour per element, without the site's developer touching code.

The previous plans described a marketplace of apps behind a billing portal. That is table stakes. The product wins on eight things competitors don't do together:

| #   | Differentiator                              | What it means                                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **One Loader per website**                  | A single tiny `<script>` (or nothing at all, see #2). The platform **compiles a per-website bundle** of exactly the enabled elements + their signed config and serves it from the edge. One request, cached globally, no per-product scripts, no config round-trips.                                                                                    |
| 2   | **Edge Injection (zero-code integration)**  | Point the domain through the platform edge (optional). Elements, SEO fixes, structured data, redirects, hosted pages and widgets are injected into the site's HTML at the edge. Works for sites the merchant cannot modify or whose developer is gone.                                                                                                  |
| 3   | **"Try it on your site" preview**           | Before subscribing, the merchant sees _their own live site_ rendered through the preview proxy with the element injected. Demo on a sample store is the fallback, not the pitch.                                                                                                                                                                        |
| 4   | **Website Graph**                           | One per-website data model (customers, items, orders, events, files) owned by the merchant. Products read/write the same graph through scoped contracts, so loyalty, chat, reviews and analytics agree on who the customer is and what happened — without integrating with each other. Bring-your-own identity: the site's existing login federates in. |
| 5   | **Elements, not apps**                      | The unit merchants see, switch, configure and pay for is the element (a gallery, a coupon engine, an AI reply, a sitemap). Products are just how elements are built and shipped. Two product kinds: **service products** (own backend) and **element packs** (pure front-end, no server — served by the Loader).                                        |
| 6   | **Performance and design as constraints**   | Every element declares a weight budget and uses the website's design tokens. The platform refuses combinations that break the site's budget and shows Core Web Vitals impact before enabling. Elements look native, not bolted on.                                                                                                                      |
| 7   | **AI operator in the console**              | "Give 2 % points on completed orders, expire after 12 months, message customers in their language." The assistant edits configuration through the same schemas, explains the effect on cost, audits SEO, drafts campaigns — with a diff and an undo, never silently.                                                                                    |
| 8   | **Transparent, safe money, sovereign data** | Live meter (credits/hour now, projected month), budgets and caps per website, hourly idempotent settlement, statements that reconcile to the credit. **All client data lives in the client's own database and storage; all providers run on the client's own keys** (§1a).                                                                              |

Everything below exists to make those eight true while staying **fast, secure, reliable, standalone and consumable**.

## 1a. Ownership model: clients bring everything, we bring the methods

We do **not** provide storage, hosting, databases, AI, messaging or payment capacity to clients. We provide the software (products, elements, methods) and the control plane. Every client resource is the client's own, connected with the client's own credentials:

| Resource                                                                          | Who provides                     | How it's connected                                                                                                                                            |
| --------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Website hosting                                                                   | client                           | untouched; we integrate via Loader script, Edge Injection (their DNS) or API                                                                                  |
| **Database for all product and data-plane data** (Graph, events, product records) | client (their own MongoDB/Atlas) | connection string per merchant (or per website) registered in the Portal; products open connections to _that_ database; all documents still carry `websiteId` |
| Object storage (files, media)                                                     | client (their S3/R2/GCS bucket)  | credentials registered; products sign uploads directly to it                                                                                                  |
| AI providers                                                                      | client's own API keys            | AI connector uses the client's key; we meter our usage units, they pay the provider                                                                           |
| Messaging providers (WhatsApp/SMS/email)                                          | client's own accounts            | connector with their credentials                                                                                                                              |
| Payment gateways                                                                  | client's own merchant accounts   | gateway adapters with their keys                                                                                                                              |
| Analytics/tag accounts                                                            | client's own                     | ids/keys in config                                                                                                                                            |

Consequences (binding):

- **Two data domains.** _Control plane_ data (accounts, websites, subscriptions, entitlements, credits, ledger, audit, keys, delivery metadata) lives in our database. _Data plane_ content (Graph, events payloads, product data, files, messages, AI logs) lives **only** in the client's resources. If a client leaves, their data is already theirs; we hold nothing but control-plane records.
- **Shared services become connectors.** Messaging, AI, Storage and Payments are adapter layers that execute with the client's credentials; metering counts our method usage for credits, never resells capacity.
- **Credentials custody.** Client credentials are stored envelope-encrypted per merchant in the Secrets module, used only at runtime by products the client enabled, never shown back, rotatable, and revocable in one click (which immediately stops every product for that resource). Customer-managed keys are a later option.
- **Onboarding gate.** A product that stores data cannot be enabled for a website until the merchant's database connection passes the **connection check** (reachability, least-privilege role, index creation rights, size/plan sanity). Same for storage/provider connectors the product requires. The Portal shows exactly what is missing.
- **Per-client schema management.** Products own their collections _inside the client's database_ under a product prefix, with `schemaVersion` on every document and lazy, idempotent migrations on connect; the app-kit provides connection caching per merchant with pool limits suited to serverless.
- **Element packs** with state (e.g. wishlist) store through the Graph API, which writes to the client's database.
- **Isolation stays.** Even inside a client's own database, every query carries `websiteId`; a merchant with several websites may use one database with website-scoped collections or one database per website.

---

## 2. Experience walkthroughs

**Merchant with a site built by someone else.** Sign up → type `shop.example.com` → the platform fetches the homepage and shows it with a chat launcher and a review block injected (preview proxy) → "Enable" → choose Edge Injection (DNS record shown) or Loader (one script tag to send to the developer) → elements are live; every option is editable in place with a live preview; the meter shows 3.4 credits/hour.

**Developer integrating deeply.** Website keys (test + live) → `npm i @ss/web` → `ss.track('order.placed', …)`; products react (points, messages, alerts) with no product-specific integration → server SDK for headless use (checkout API, entitlements) → delivery logs and replay in the console.

**Product developer (us or third party).** `ss app init` → manifest with elements, prices, schemas → local Portal emulator with fake merchants and websites → contract tests → register with a one-time token → review → listed. Element packs need no backend at all: build UI elements, publish the pack, the Loader serves them.

**Platform staff.** Review manifest diffs, certify products (automated checks + manual), add credits, book on behalf, override/lock any field, open any product as admin scoped to a merchant/website, impersonate time-boxed, watch fleet health, replay dead letters, run reconciliation.

---

## 3. Architecture: five planes

```
 ┌──────────────── Control plane (Portal) ─────────────────┐   identity · catalog · entitlements · credits · config · audit
 ├──────────────── Delivery plane ──────────────────────────┤   Loader compiler · edge injection · hosted pages · preview proxy · CDN
 ├──────────────── Data plane (Website Graph + Event Hub) ──┤   per-website graph · events · files · consent · identity federation
 ├──────────────── Runtime plane (Products) ────────────────┤   service products (own repo/deploy/DB) · element packs (static)
 └──────────────── Intelligence plane ──────────────────────┘   AI Gateway · console operator · audits · content
```

Coupling between planes is only through **signed contracts** (§8). Every plane is a separate deployable (or set of them); the control plane's modules are separately extractable.

ADRs (kept as a numbered list here; each becomes a section when implementation starts): 001 planes & contract-only coupling · 002 per-website compiled Loader bundles · 003 edge injection as optional integration mode · 004 Website Graph as shared data model with scoped access · 005 elements as unit of switching/pricing · 006 signed offline entitlements · 007 hourly idempotent settlement · 008 JS functional core · 009 one deployable = one Vercel project + one Atlas DB · 010 public-key App Protocol.

---

## 4. Delivery plane

### 4.1 Loader (compiled per website)

- On any change (element enabled, config saved, product version accepted) the compiler produces a **website bundle**: element code from element packs + service-product client stubs + signed config document → immutable versioned artefact on the CDN (`/w/<websiteId>/<version>/loader.js`), with an alias `/w/<websiteId>/loader.js` that flips atomically.
- Budget check at compile time (§6.3). Only enabled elements are included; nothing loads for disabled ones.
- Runtime: one script, `defer`, < 15 KB core; elements lazy-mount by page conditions declared in config (path, selector, event); consent-aware; CSP-friendly (nonce or hash published per version).
- Rollback = flip alias to previous version. Preview = alias per environment (`test`).

### 4.2 Edge Injection (optional, zero-code)

- Merchant points DNS at the platform edge (CNAME); the edge proxies to the origin and **rewrites HTML on the fly**: injects the Loader, SEO metadata and structured data, canonical/redirect rules, hosted pages under merchant paths (`/policies/*`, `/sitemap.xml`, `/checkout`), cache headers. TLS issued automatically.
- Guardrails: per-rule enable/disable, dry-run diff view, bypass header for the site developer, instant off switch, origin health checks, no caching of authenticated pages by default.
- Implemented as edge functions with rules compiled from configuration; portable to Cloudflare Workers/Vercel Edge/Deno.

### 4.3 Hosted pages

Products may publish server-rendered pages (checkout, account, policies, PDP) that appear under the merchant's domain via Edge Injection, or under `pages.<platform>/<domain>/…` with a `<link rel=canonical>` when injection is off.

### 4.4 Preview proxy

Renders the merchant's public page through a sandboxed proxy with the candidate bundle injected, watermarked, non-indexable, never cached, rate-limited, only for domains the merchant has added. Used by the catalog ("Try on your site"), the config editor (live preview) and the AI operator (before/after).

### 4.5 Performance

CDN caching with immutable versions, Brotli, edge compute for injection, per-website bundles ≤ declared budget, RUM (Core Web Vitals) collected by the Loader and shown per element.

---

## 5. Data plane: Website Graph, Event Hub, identity federation

### 5.1 Website Graph

Per website, merchant-owned, schema-versioned entities: **Customer** (identities: email/phone/external id; consent; attributes; tags), **Item** (id, type, attributes, variants, media refs, price), **Order/Transaction** (lines, amounts, status), **Session/Visit**, **File**, **Event** (timeline). Products declare **scopes** (`graph.customer.read`, `graph.order.write`, …) in their manifest; merchants approve scopes on subscribe; every access is audited. The graph is populated by events, by product writes, and by imports/connectors (CSV, storefront platforms later).

### 5.2 Event Hub

Standard events v1 (`customer.*`, `page.viewed`, `item.viewed`, `cart.updated`, `order.*`, `inventory.changed`, `price.changed`, `file.uploaded`, `custom.*`) plus product events. Immutable, deduplicated by `(websiteId, idempotencyKey)`, fanned out to subscribed products with signed, retried deliveries, DLQ, replay and per-website delivery logs. Schemas in `@ss/contracts` (`type@v`).

### 5.3 Bring-your-own identity

A website can register its own issuer (JWKS URL or shared secret). Tokens from the site's login are accepted by the Loader and products as the end-customer identity (mapped into the Graph). Our Signups product is optional, not required.

### 5.4 Files & consent

Files are graph nodes backed by Storage; consent categories are graph attributes evaluated by the Loader before any element loads a tag or collects data.

---

## 6. Runtime plane: products and elements

### 6.1 Two product kinds

| Kind                | Has                                                  | Deployed as                                                                     | Examples                                               |
| ------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **Service product** | backend, own DB, dashboard, REST, jobs, hosted pages | own repo → own Vercel project + Atlas DB                                        | Chatbot, Checkout, Order Manager, SEO Suite            |
| **Element pack**    | front-end elements only, config schemas, no server   | published static bundle, served by the Loader; state lives in the Graph via SDK | PDP blocks, Storefront blocks, Notice bar, Wishlist UI |

Both are independent, both are registered, reviewed and priced the same way. A service product may also ship an element pack for its UI.

### 6.2 Elements

Switchable, individually priced (per hour and/or per use), field-level configurable (typed features: flag/quota/limit/rate/config with JSON Schema), optional dependencies within the product, declared surfaces (Loader element, REST, hosted page, dashboard screen, console extension), declared weight budget and Graph scopes.

### 6.3 Certification pipeline (automated + review)

Contract tests · isolation tests · performance budget (JS weight, no layout shift, lazy mount) · accessibility checks · security scan (deps, secrets, CSP compliance) · sandbox demo present · admin-launch support · graceful degradation test (Portal offline). Levels: **Listed** (passes automation) → **Certified** (manual review) → **Featured**.

### 6.4 Independence rules

No product imports another; no product reads another's database; cooperation only via the Graph and Event Hub; every product must run with the Portal unreachable (cached entitlements).

---

## 7. Commercial model

- **Unit**: subscription = website × product; inside it, elements on/off.
- **Price**: from the product's versioned price book only — element hourly price (0 allowed), metered units with included quotas and overage, optional product base; plans are optional presets with feature bounds. Subscriptions pin the accepted price-book version.
- **Settlement**: per started hour, one ledger entry per subscription per hour bucket with a unique `periodKey`; batch-resumable; computed when read (F.19, no cron); reconciliation (admin operation) compares expected vs settled hours and alerts on drift.
- **Credits**: merchant-level, append-only ledger in integer credits, cached balance verified nightly; staff add credits (offline payment); gateways later add deposits only; credits shown only.
- **Safety**: live meter, projected month, budgets/caps per website and merchant, low-balance alerts in hours-remaining, balance ≤ 0 pauses everything, paused time never billed, auto-resume on top-up, trials as adjustments.
- **Bundles & promotions**: Portal-defined discounts as adjustments; products stay independent.

---

## 8. Contracts & kit

> Binding rules for every product are in Part E (Product Standard, below). Product depth is in Part D (Product Specifications, below).

- **App Protocol**: shared-secret connect (`POST <product>/.well-known/ss-connect`, HMAC with the product's `CONNECT_SECRET`, pinned Portal URL and product base URL) → per-app Ed25519 keys; SSO launches (EdDSA JWT, 60 s, single-use; kinds `merchant | demo | admin(scope) | impersonate | partner | developer`); product→Portal calls via client-assertion JWT with replay store; Portal→product signed events; pull-with-cache authoritative.
- **Entitlement document**: signed, versioned; elements on/off, features, config, domain binding, `validUntil`; verified offline.
- **Website keys**: `pk_` (domain-locked, browser) and `sk_` (server), scoped, signed, offline-verifiable, revocable; test-mode twins.
- **Manifest**: product kind, elements (price, budget, scopes, surfaces, dependencies), features/schemas, plans, price book, events, capabilities, `trialHours`.
- **Event & Graph schemas**: versioned in `@ss/contracts`.
- **API standards**: OpenAPI 3.1, `/v1`, idempotency keys, cursor pagination, uniform error envelope, rate-limit and deprecation headers.
- **Kit**: `@ss/app-kit` (Node, functional): registration, launch/key verification, origin checks, signed client, entitlement cache, usage reporter, event verification, Graph client, shared-service clients, scheduler, audit, health. `@ss/web` (browser): events, identity federation, element runtime API. `@ss/cli`: `init | validate | dev (emulator) | register | certify`.

---

## 9. Control plane modules (Portal)

Identity & Access (staff 2FA, merchants, website-scoped RBAC, partners, developers, sessions, keys) · Catalog & Lifecycle (apps, manifest versions/diffs/approval, environments, certification, rollouts, deprecation) · Commerce (subscriptions, elements, precedence & locks, entitlement docs, usage/quotas, ledger, settlement, caps, statements) · Configuration (schemas, templates, environments, versions, rollback, scheduled changes, dry-run) · Delivery (compiler, aliases, injection rules, preview) · Data (Graph, Event Hub, consent, federation) · Shared services (Messaging, AI Gateway, Storage, Secrets, Scheduler, Notifications) · Observability & Audit · Consoles (Merchant, Admin, Partner, Developer, Marketplace/Docs). Each module owns its collections, exposes an API, and has stated invariants .

**Precedence** (entitlements and configuration alike): product default → plan default → platform policy → merchant default → website override (≤ plan max) → admin override (may exceed, may lock) → runtime state.

---

## 10. Intelligence plane

- **AI Gateway**: provider adapters, platform or merchant keys, budgets, metering, redaction, logging policy — the only way products call LLMs.
- **Console operator**: converts natural-language requests into configuration diffs validated against schemas, shows cost impact via the meter, applies with undo; runs audits (SEO, performance, conversion) and proposes changes; drafts copy and campaigns; never acts without an explicit apply.
- **Product intelligence**: products expose "insights" endpoints (e.g. chat topics, coupon impact) aggregated in the merchant console.

---

## 11. Security architecture

Threat model (to be expanded in this file before M1) (assets, adversaries incl. compromised product and injected edge). Controls: Ed25519 signatures and JWKS with `kid`; single-use launches; replay stores; identity only from crypto; data-access guards requiring tenant keys; isolation suites in CI; keys hashed at rest and shown once; envelope-encrypted secrets with rotation; scrypt/argon2id passwords; mandatory staff 2FA; progressive lockouts; shared-store rate limits; CSP with per-version nonces/hashes for the Loader; strict CORS; CSRF on console writes; product scopes and per-product DB users; edge injection guardrails (allow-listed rules, bypass, dry-run, instant off); dependency/secret scanning; audit immutability; data export/anonymisation; encrypted backups.

---

## 12. Reliability, performance, data

**SLOs**: Portal API 99.9 % availability, p95 < 200 ms; Loader availability 99.99 % (CDN); entitlement freshness ≤ 5 min; event fan-out p95 < 30 s; settlement within 10 min of the hour; product runtime unaffected by Portal outage.

**Failure behaviour**: Portal down → Loader keeps serving last compiled bundle, products use cached entitlements, usage queues locally; Atlas degraded → writes 503 with retry-after, jobs resume from cursors; product down → flagged, merchants notified, injection rule for that element auto-disabled; provider down → queued/retried, product degrades; queue backlog → drain, DLQ, replay.

**Capacity**: 100k websites, 1M events/day, 10k subscriptions settled hourly, bundles compiled within 10 s of a change.

**Data**: per-module collections with tenant keys, `schemaVersion`; append-only ledger/audit/events; indexes declared and synced by script; versioned migrations with dry-run; retention per data type; rollups for analytics; export/anonymise propagated to products. DR: encrypted daily backups, 30-day retention, quarterly restore drill, RPO 24 h (1 h on Atlas continuous backup), RTO 4 h.

---

## 13. Engineering system & hosting

- **Repos**: `platform` (control + delivery + data + intelligence planes as modules), `contracts`, `app-kit`, `web-sdk`, `cli`, `product-template`, `element-pack-template`, one repo per product.
- **Standards**: JS ESM functional core with JSDoc + `checkJs --strict`; adapters injected; ESLint/Prettier; conventional commits; ADRs.
- **Testing**: unit + property (idempotency, precedence, settlement) → adapter (`mongodb-memory-server`) → contract → isolation → Playwright (consoles, product dashboards, Loader on a sample site, injection on a sample origin) → load (settlement, fan-out, compile).
- **CI/CD**: per PR all suites + preview deploy + scans; main → production with migration gate; products deploy independently; Portal keeps N-1 contract compatibility.
- **Hosting**: one Vercel project per deployable; one Atlas DB/user per deployable (one shared M0 cluster, F.19); no crons or background processing (F.19): work runs on the request or event that causes it, time-based state on read, maintenance as admin/merchant buttons; Atlas-backed queues with leases; edge functions for injection/preview; CDN for bundles; Dockerfiles + compose as the portability proof.
- **Porting from ibrahimMobiles**: logic and tests only; constants → element features with schemas and bounds; store data → Graph/Event contracts; providers → shared-service adapters; per-website keys everywhere.

---

## 14. Roadmap

| Milestone                                         | Scope                                                                                                                                                                                                                                       | Exit                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **M0 Specs** (1 wk)                               | ADRs 001–010, protocol, entitlement/element model, Graph & event schemas, manifest schema, data model, OpenAPI skeleton, threat model, delivery-plane design, hosting topology                                                              | sign-off                                           |
| **M1 Contracts, kit, emulator** (2 wks)           | `@ss/contracts`, `@ss/app-kit`, `@ss/web`, CLI with Portal emulator, product + element-pack templates                                                                                                                                       | template products pass contract tests locally      |
| **M2 Control plane** (5 wks)                      | Identity, Catalog/Lifecycle, Commerce, Configuration, Observability, Admin + Merchant consoles, isolation suite, CI, Docker                                                                                                                 | security/isolation green; OpenAPI published        |
| **M3 Delivery + data planes** (4 wks)             | Loader compiler + CDN, preview proxy ("try on your site"), Website Graph v1, Event Hub v1, identity federation, Notifications; Loyalty reference product + one element pack                                                                 | first merchant live via Loader in < 10 min         |
| **M4 Launch set** (4 wks)                         | In priority order: **Chatbot, Coupons, Loyalty, Signups & Identity, Deals, Reviews, Alerts** (+ Consent & Tags pack, Notice/Storefront basics pack). Chosen for merchant value, small data footprint, and independence from a store backend | listed & certified                                 |
| **M5 Edge Injection + commerce products** (6 wks) | Edge injection with guardrails, hosted pages; Catalog, Configurator, Grades, PDP pack, Storefront pack, Checkout, Order Manager, After-sales, Search                                                                                        | zero-code site live; sample store on products only |
| **M6 Intelligence + visibility** (4 wks)          | AI Gateway, console operator, SEO Suite, Analytics, Consent, Content, Files, Automation, Reports, Ops Monitor                                                                                                                               | operator applies audited diffs                     |
| **M7 Partners, developers, marketplace** (3 wks)  | Partner & Developer consoles, certification UI, marketplace, docs site, WordPress plugin, deposit-request flow                                                                                                                              | third-party product certified end-to-end           |
| **M8 Scale**                                      | sovereign mode (BYO DB), white-label, gateways, revenue share, locales, status page, load tests                                                                                                                                             | —                                                  |

---

## 15. Risks

| Risk                          | Mitigation                                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Edge injection breaking sites | opt-in, dry-run diffs, per-rule switches, bypass header, auto-disable on origin errors, never cache authenticated pages |
| Loader weight creep           | hard budgets per element and per website; compile-time refusal; RUM feedback                                            |
| Contract churn                | semver, N-1 compatibility, contract tests in every product CI                                                           |
| Settlement errors             | pure core, property tests, reconciliation, merchant-visible statements                                                  |
| Scope                         | elements ship incrementally; each product defines a launch element set                                                  |
| Third-party quality           | certification pipeline, scopes, revocation, health SLOs                                                                 |

---

## 16. Decisions log

**Launch set (decided 2026-10-01):** Chatbot → Coupons → Loyalty → Signups & Identity → Deals → Reviews → Alerts, plus the Consent & Tags and basic Storefront packs. Reasoning: highest demand for any website type, no dependency on a store backend, smallest data footprint, fastest to certify; the commerce set follows once the Loader, Graph and Event Hub are proven.

Greenfield · **clients bring their own database, storage, AI/messaging/payment keys; we provide methods only (§1a)** · four deliverables (control, delivery, products, contracts) · elements as unit of switching/pricing · hourly idempotent settlement from product price books only · merchant credits added by staff, shown only · website = domain, globally unique, no verification, hard-bound · self-service signup, subscribe with ≥ 1 h credits · demo after signup, plus "try on your site" preview · shared-secret connect + pinned URLs → key trust · admin has full powers incl. scoped SSO and impersonation · international, English default, nothing regional in code · initial products ported from ibrahimMobiles and generalised, store repos untouched · JS ESM functional · Vercel Hobby + Atlas M0 (F.19), one project/DB per deployable, portable.

---

## Appendix A — Initial product catalog (elements, configurability, pricing)

> Full product depth is in Part D. This appendix is the pricing summary only.

Kinds: products marked _pack_ are element packs (no backend); others are service products. PDP, Storefront Blocks, Wishlist UI, Consent banner and Content pages ship as packs; Chatbot, Checkout, Order Manager, SEO Suite, Files, Messaging, Auth, Loyalty, Reviews, Alerts, Catalog, Configurator, Grades, Search, Analytics, Automation, Reports, Ops are service products (several also ship a pack for their UI).

Columns: **Element** · what it is · **configurable** (every field is editable per website; only highlights listed) · **pricing** (H = hourly add-on, M = metered, 0 = free element).

### Category: Commerce

#### A.1 Catalog & PIM (`catalog`) — headless item data for any store

| Element                                                 | What                                  | Configurable                                                           | Pricing        |
| ------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------- | -------------- |
| `items`                                                 | items with media, description, status | fields, custom fields, statuses, scheduled publish                     | H + L items    |
| `variants`                                              | variant matrix per item               | uniqueness rules, option pools, price/qty per variant, private cost    | H              |
| `attributes`                                            | attribute definitions & options       | types, options, filter visibility, card position, per-collection scope | H              |
| `collections`                                           | categories/collections tree           | depth, marketing copy, visibility cascade                              | H              |
| `brands`                                                | brand registry                        | scoping per collection, logos                                          | 0              |
| `media`                                                 | images/videos per item via Files      | count limits, ladder, alt templates                                    | 0 (uses Files) |
| `import_export`                                         | CSV templates, dry-run bulk updates   | columns, validation, conflict policy                                   | H              |
| `feeds`                                                 | shopping/marketing feeds              | field mapping, condition mapping, tokened URLs                         | H              |
| `api`                                                   | REST read/write                       | scopes, rate (R)                                                       | M requests     |
| Events: `item.*`, `inventory.changed`, `price.changed`. |

#### A.2 Configurator Builder (`configurator`) — option/variant configurator for anything configurable

| Element        | What                                         | Configurable                                           | Pricing       |
| -------------- | -------------------------------------------- | ------------------------------------------------------ | ------------- |
| `schema`       | option groups, dependencies, exclusions      | groups, order, required, defaults                      | H             |
| `resolver`     | picks a valid combination from partial input | closest-match strategy, fallbacks, in-stock preference | H             |
| `price_deltas` | price per option/combination                 | delta rules, rounding                                  | H             |
| `url_sync`     | selection ↔ URL params                       | param names, canonical rules                           | 0             |
| `widget`       | embeddable selector UI                       | layout (pills/dropdowns/swatches), copy, theme         | H             |
| `api`          | evaluate/resolve endpoint                    | rate (R)                                               | M evaluations |

#### A.3 Grade & Condition System (`grades`) — condition tiers for used/refurbished or any quality tiers

| Element      | What                                               | Configurable                      | Pricing |
| ------------ | -------------------------------------------------- | --------------------------------- | ------- |
| `tiers`      | tiers with badge, colour, notes                    | count (L), labels, colours, order | H       |
| `showcase`   | tier explainer block with video/images             | media, copy per tier              | H       |
| `filters`    | tier filter on listings                            | visibility rules                  | 0       |
| `warranty`   | warranty text/days per tier                        | days, text templates              | 0       |
| `mapping`    | tier → external condition (feeds, structured data) | mapping table                     | 0       |
| `inspection` | inspection checklist/report per unit               | checklist items, required photos  | H       |

#### A.4 Product Detail Page (`pdp`) — composable detail page or embeddable blocks

| Element              | What                                    | Configurable                                  | Pricing       |
| -------------------- | --------------------------------------- | --------------------------------------------- | ------------- |
| `gallery`            | responsive gallery, zoom, video         | thumbnails, lazy strategy, priority image     | H             |
| `price_block`        | price, savings, availability            | formats, availability copy                    | 0             |
| `configurator_embed` | uses Configurator product if subscribed | —                                             | 0             |
| `deal_pill`          | active deal hint from Deal System       | placement, copy                               | 0             |
| `grade_showcase`     | uses Grade System                       | placement                                     | 0             |
| `related`            | related items rail                      | strategy (same collection/brand/attrs), count | H             |
| `faq`                | per-item FAQ                            | source (manual/AI), count                     | H             |
| `structured_data`    | Product/Offer JSON-LD                   | field mapping, condition mapping              | 0             |
| `sticky_buy_bar`     | mobile CTA bar                          | show rules                                    | H             |
| `share`              | share buttons                           | channels                                      | 0             |
| `reviews_block`      | uses Reviews product                    | placement                                     | 0             |
| `alerts_block`       | uses Alerts product                     | placement                                     | 0             |
| `hosted_page`        | Portal-rendered page on a subpath       | route pattern, metadata                       | H + M renders |

#### A.5 Storefront Blocks (`storefront`) — listing and layout blocks for any site

| Element                          | What                                        | Configurable                                  | Pricing        |
| -------------------------------- | ------------------------------------------- | --------------------------------------------- | -------------- |
| `grid`                           | item grid with infinite scroll / pagination | page size, sort options, crawlable pagination | H              |
| `cards`                          | item cards with rotating attribute chips    | fields shown, chip cycling, badges            | H              |
| `filters`                        | facets/filters with URL sync                | facet list, layout (sidebar/sheet), counts    | H              |
| `search_overlay`                 | uses Site Search                            | placement                                     | 0              |
| `hero`                           | hero with media (image/video policies)      | media rules incl. data-saver, headline, CTA   | H              |
| `trending_band`                  | trending/featured items strip               | source, count                                 | H              |
| `category_cards` / `brand_cards` | navigation cards                            | layout                                        | 0              |
| `deals_page`                     | page listing deals                          | layout                                        | 0 (uses Deals) |
| `notice_bar`                     | dismissible announcement bar                | text, schedule, dismiss memory                | 0              |
| `mobile_tab_bar`                 | bottom navigation                           | tabs, icons                                   | 0              |
| `contact_footer`                 | hours, contacts, socials, policies links    | fields                                        | 0              |
| `theme`                          | tokens, fonts, motion                       | all                                           | 0              |

#### A.6 Cart & Checkout System (`checkout`)

| Element           | What                                                                                          | Configurable                                        | Pricing      |
| ----------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------ |
| `cart`            | cart with reconciliation & guest merge                                                        | max qty/lines, stale handling                       | H            |
| `checkout_form`   | address/contact/delivery/payment steps                                                        | field schema, required fields, labels, autocomplete | H            |
| `payment_manual`  | bank transfer (proof upload) / cash on delivery (surcharge, caps, confirmation step) / pickup | all rules                                           | H            |
| `payment_gateway` | gateway adapters (later)                                                                      | provider                                            | H + M        |
| `offer_apply`     | applies Coupon/Deal products                                                                  | —                                                   | 0            |
| `loyalty_redeem`  | applies Loyalty product                                                                       | —                                                   | 0            |
| `place_order`     | atomic placement (idempotent)                                                                 | reservation policy, expiry hours                    | H + M orders |
| `success_page`    | confirmation with next steps                                                                  | steps by method, SLA text                           | 0            |
| `policies_notice` | links to Content policies                                                                     | which                                               | 0            |
| `signin_gate`     | uses Signups product for identity                                                             | when required                                       | 0            |

#### A.7 Coupon System (`coupons`)

| Element      | What                                    | Configurable                                    | Pricing       |
| ------------ | --------------------------------------- | ----------------------------------------------- | ------------- |
| `codes`      | single/multi-use codes, bulk generation | pattern, count (L), expiry                      | H             |
| `rules`      | who/what/when conditions                | segments, items, totals, first-order, schedules | H             |
| `actions`    | percent/fixed/free-shipping/BXGY        | bounds                                          | 0             |
| `limits`     | per-customer/global usage               | counts, windows                                 | 0             |
| `redeem_api` | validate/redeem endpoint                | rate (R)                                        | M redemptions |
| `reports`    | usage & impact                          | —                                               | 0             |

#### A.8 Deal System (`deals`) — automatic offers (no code)

| Element       | What                                         | Configurable                                             | Pricing  |
| ------------- | -------------------------------------------- | -------------------------------------------------------- | -------- |
| `item_deals`  | automatic item/collection deals              | conditions, actions, schedules (weekday/time, overnight) | H        |
| `cart_deals`  | checkout-wide deals (totals, payment method) | conditions, actions                                      | H        |
| `stacking`    | policy engine                                | single vs stackable classes, loyalty interaction         | 0        |
| `price_locks` | honour shown price for N minutes             | N, stale behaviour                                       | H        |
| `badges`      | badges/pills/countdowns                      | copy, placement                                          | 0        |
| `quote_api`   | evaluate cart/item                           | rate (R)                                                 | M quotes |

#### A.9 Ecommerce Helper — Order Manager (`orders`) — back-office for orders from any checkout (ours or theirs)

| Element            | What                                                    | Configurable                                       | Pricing             |
| ------------------ | ------------------------------------------------------- | -------------------------------------------------- | ------------------- |
| `lifecycle`        | statuses & transitions with side effects                | matrix, customer-cancellable, auto-expiry          | H                   |
| `fulfilment`       | courier list, tracking links, dispatch video            | carriers, URL templates                            | H                   |
| `serials`          | per-unit serial capture with validation                 | patterns (e.g. Luhn ids), required-before-dispatch | H                   |
| `invoices`         | customer & internal invoices/receipts                   | templates, branding, snapshots                     | H + M renders       |
| `print`            | packing slips, pick lists                               | templates                                          | H                   |
| `bulk`             | bulk status, CSV import/export                          | limits                                             | H                   |
| `risk`             | open-order caps, blocklist, RTO flags, COD confirmation | thresholds                                         | H                   |
| `customer_updates` | status messages via Messaging                           | templates per status                               | 0 (M via Messaging) |
| `ledger`           | payments & refunds records                              | methods, partial refunds                           | H                   |
| `inbound_api`      | receive orders from any external checkout               | schema mapping                                     | M orders            |

#### A.10 After-sales (`aftersales`)

`claims` (return/warranty/exchange with windows, evidence, photos), `queue` (statuses, notes), `refunds` (via ledger), `restock`, `serial_registry` (lookup), `messages`. H per element; M photos.

#### A.11 Site Search (`search`)

`index` (documents Q), `sources`, `ranking` (fields/boosts/synonyms), `suggestions` (popular/recent), `overlay` widget, `analytics` (zero-result). H + M queries.

### Category: Engagement & Identity

#### A.12 Chatbot (`chat`)

| Element                                                                        | What                                  | Configurable                                 | Pricing      |
| ------------------------------------------------------------------------------ | ------------------------------------- | -------------------------------------------- | ------------ |
| `widget`                                                                       | website chat launcher & window        | placement, theme, triggers, languages        | H            |
| `ai_replies`                                                                   | LLM replies via AI Gateway            | provider/model, persona, topics, tool rounds | H + M tokens |
| `knowledge`                                                                    | docs/URLs/FAQ sources                 | sources (L), refresh                         | H            |
| `tools`                                                                        | built-in + merchant webhooks tools    | tool list, schemas                           | H            |
| `inbox`                                                                        | human agents, assignment, SLAs, notes | agents (L), hours, canned replies            | H            |
| `handoff`                                                                      | WhatsApp/SMS/email handoff            | channel, template, triggers                  | 0            |
| `attachments`                                                                  | uploads in chat                       | size/types                                   | 0 (Files)    |
| `lead_capture`                                                                 | collect contact when offline          | fields                                       | H            |
| `moderation`                                                                   | PII/leak filters                      | rules                                        | 0            |
| `realtime`                                                                     | polling/push tuning                   | intervals                                    | 0            |
| Events: `chat.*`; consumes `page.viewed`, `customer.*`, `order.*` for lookups. |

#### A.13 Signups & Passwordless Auth (`auth`)

| Element                                           | What                                            | Configurable                                       | Pricing     |
| ------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------- | ----------- |
| `otp`                                             | phone/email OTP                                 | length, expiry, cooldowns, limits (R/Q), providers | H + M sends |
| `magic_link`                                      | email link sign-in                              | expiry                                             | H           |
| `sessions`                                        | JWT sessions verified offline by the site       | lifetime, refresh, revoke-all                      | H           |
| `profile`                                         | profile & addresses storage                     | field schema                                       | H           |
| `account_pages`                                   | hosted/embeddable account UI                    | blocks                                             | H           |
| `widget`                                          | sign-in UI                                      | copy, theme, autofill                              | 0           |
| `fallback`                                        | "continue via chat/WhatsApp" when sending fails | template                                           | 0           |
| Events: `customer.created`, `customer.signed_in`. |

#### A.14 Loyalty & Rewards (`loyalty`)

`earn_rules` (any event → points), `redeem`, `tiers`, `expiry`, `referrals`, `adjustments`, `widgets`, `messages`, `reversal` — H per element; L members; M messages via Messaging.

#### A.15 Reviews & Ratings (`reviews`)

`collection` (verified-only rules, request timing), `moderation`, `photos`, `display` widgets, `structured_data`, `incentives` — H per element; Q reviews; M photos.

#### A.16 Alerts & Waitlists (`alerts`)

`types` (stock/price/availability/custom), `capture` widget, `dispatch` (channels, caps, quiet hours), `triggers` — H; Q subscriptions; M sends.

#### A.17 Wishlist (`wishlist`)

`lists`, `guest_merge`, `share`, `price_drop_hook`, `widgets` — H; L items.

#### A.18 Messaging & Campaigns (`messaging`)

`templates` (per event/channel/language), `transactional` (send API), `outbox` (retries, DLQ), `campaigns` (segments, schedule, throttle, opt-out), `providers` (platform or own), `staff_alerts`, `quiet_hours` — H per element; M messages per channel.

### Category: Visibility & Marketing

#### A.19 SEO Suite (`seo`)

| Element           | What                                                              | Configurable                 | Pricing      |
| ----------------- | ----------------------------------------------------------------- | ---------------------------- | ------------ |
| `health`          | 30+ checks with guided fixes                                      | checks, thresholds, schedule | H            |
| `metadata`        | title/description/canonical/robots rules by page type             | templates, rules             | H            |
| `structured_data` | Organization/LocalBusiness/WebSite/Breadcrumb/Product/FAQ/Article | per page-type mapping        | H            |
| `sitemaps`        | index + chunked sitemaps with images                              | exclusions, lastmod source   | H            |
| `feeds`           | shopping feeds                                                    | mapping                      | H            |
| `indexnow`        | change submissions                                                | key                          | 0            |
| `redirects`       | slug history, host/case normalisation, manager UI                 | rules                        | H            |
| `intent_pages`    | attribute/collection landing pages                                | thresholds, templates        | H            |
| `ai_copy`         | AI descriptions/meta/FAQ with review                              | tone, languages, batch size  | H + M tokens |
| `og_images`       | generated share images                                            | templates                    | M renders    |
| `llms_txt`        | AI-search files                                                   | fields                       | 0            |
| `verification`    | search engine verification tokens                                 | tokens                       | 0            |
| `crawl`           | site crawler for audits                                           | pages (Q), depth             | M pages      |

#### A.20 Analytics & Insights (`analytics`)

`snippet` (page views, vitals, sampling), `server_events` (API), `funnels` (steps by event), `kpis`, `segments`, `rollups` (retention), `alerts` (anomalies), `exports` — H per element; M events.

#### A.21 Consent & Tags (`consent`)

`banner`, `consent_mode`, `tag_loader` (GTM/GA/Meta/TikTok/custom by category), `conversion_events` (standard events → payloads), `records` — H; Q records.

#### A.22 Content & Policies (`content`)

`documents` (policies, terms, FAQs) with tokens, `glossary`, `announcements`, `hosted_pages` (with metadata/JSON-LD), `versions`, `languages` — H; L documents; M renders.

### Category: Operations & Infrastructure

#### A.23 Files, Media & Drive (`files`)

`uploads` (presigned, policies), `images` (variant ladders, placeholders, CDN), `video` (optimiser presets), `drive` (folders, share links, versions, trash), `providers` (platform or own bucket) — H; Q storage/bandwidth; M transformations.

#### A.24 Automation & Scheduler (`automation`)

`rules` (event → conditions → actions), `schedules` (cron), `actions` (message, points, tag, webhook, task), `digests`, `retries` — H; Q runs.

#### A.25 Reports & Exports (`reports`)

`sales_reports` (by dimension), `inventory_reports` (sell-through, stock age), `service_reports` (return rate, SLA), `funnels`, `scheduled_reports`, `exports` — H; R exports.

#### A.26 Ops Monitor (`ops`)

`health_endpoints`, `error_reporting`, `uptime_checks`, `daily_digest`, `audit_viewer` — H; 0 for basics.

#### A.27 Team & Access (provided by the Portal to every product, not sold)

RBAC, 2FA, invites, website-scoped roles, audit log, activity feed.

### Sample bundles (Portal-defined)

`Commerce Suite`, `Growth Suite`, `Visibility Suite`, `Builder Suite` — discounts are ledger adjustments; products stay independent.

---

## Appendix B — Source map (ibrahimMobiles module → product)

| ibrahimMobiles module                                                                                                                 | Product                                         |
| ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| assistant chat, inquiries inbox, guest limits, handoff                                                                                | Chatbot                                         |
| OTP issue/verify, sessions, profile/addresses, account pages                                                                          | Signups & Passwordless Auth                     |
| loyalty ledger, earn/reverse on transitions, expiry, history                                                                          | Loyalty                                         |
| offer evaluator/matching/schedule, cart locks                                                                                         | Coupon System (codes) + Deal System (automatic) |
| reviews, moderation, rating rollups                                                                                                   | Reviews                                         |
| stock/price alerts                                                                                                                    | Alerts & Waitlists                              |
| wishlist                                                                                                                              | Wishlist                                        |
| customer templates, outbox, staff alerts, SMTP                                                                                        | Messaging & Campaigns                           |
| categories/attributes/brands/products/variants, CSV, price rollups                                                                    | Catalog & PIM                                   |
| PDP variant selector, attribute pools, closest match, URL sync                                                                        | Configurator Builder                            |
| grades, badges, showcase, warranty per grade, condition mapping                                                                       | Grade & Condition System                        |
| PDP gallery, related, FAQ, structured data, sticky bar                                                                                | Product Detail Page                             |
| cards, grid, filters, hero, trending, category/brand cards, notice bar, tab bar, footer                                               | Storefront Blocks                               |
| cart, checkout form, manual payments, placement transaction, success page                                                             | Cart & Checkout System                          |
| lifecycle, couriers, serials, invoices, packing slips, bulk, risk caps, payments/refunds ledger                                       | Order Manager                                   |
| returns/warranty claims                                                                                                               | After-sales                                     |
| Atlas Search index, hints, overlay                                                                                                    | Site Search                                     |
| metadata, structured data, sitemaps, feeds, IndexNow, redirects, intent pages, AI copy, OG images, llms.txt, SEO health, verification | SEO Suite                                       |
| telemetry, vitals, dashboards, rollups                                                                                                | Analytics                                       |
| consent banner, tag loading, conversion events                                                                                        | Consent & Tags                                  |
| policies, glossary, notices                                                                                                           | Content & Policies                              |
| presigned uploads, image variants, video optimiser, storage                                                                           | Files, Media & Drive                            |
| cron jobs, digests                                                                                                                    | Automation & Scheduler, Ops Monitor             |
| reports, exports                                                                                                                      | Reports & Exports                               |
| RBAC, 2FA, audit, activity                                                                                                            | Portal-provided Team & Access                   |
| ibrahimMobiles itself is not modified.                                                                                                |

---

## Appendix C — Glossary

**Portal** — control plane. **Product** — independent app delivering one capability set. **Element** — switchable, individually priced part of a product. **Feature** — typed knob inside an element (flag/quota/limit/rate/config). **Subscription** — website × product. **Entitlement document** — signed, versioned effective state of a subscription. **Price book** — versioned pricing declared by a product. **Credits** — prepaid units in the merchant ledger. **Settlement** — idempotent hourly charge per subscription. **Launch** — single-use SSO token. **Event Hub** — standard events ingested once, fanned out to products. **Contract** — versioned schema/API binding Portal and products. **Isolation suite** — automated cross-tenant attack tests.

---

# PART D — PRODUCT SPECIFICATIONS

(Appendix A of Part A is the price/element summary; this part is the depth.) The Portal stays simple: it only knows _elements, features, prices, schemas_. All richness below lives inside the products and is expressed through those four things.

---

### 0a. Three ways to consume every element

Every element can be used as **drop-in UI** (our renderer, themed by the website), as **headless UI** (the merchant's developer renders their own UI on our element core: state, actions, events, validation, strings), or **API only** (REST/SDK, no front-end from us). Same config, rules, entitlements, pricing and events in all three. How products must implement this — and everything else that makes ten independent products behave identically — is Part E, the Product Standard.

### 0. The flexibility model (every product supports all nine levels)

| Level | Name                | What a merchant (or staff, or the AI operator) can change                                                                                                                                                                                              | How it's declared by the product                  |
| ----- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| L0    | **Switch**          | Element on/off per website and environment; scheduled on/off; audience (all / segment / % rollout)                                                                                                                                                     | element `key`, `schedule`, `audience`             |
| L1    | **Configure**       | Every setting is a typed feature (flag/quota/limit/rate/config) with defaults and plan-bounded ranges                                                                                                                                                  | JSON Schema per element                           |
| L2    | **Appearance**      | Website design tokens inherited automatically; per-element overrides; layout variants; density; scoped custom CSS; icon set                                                                                                                            | `theme` schema + `variants[]`                     |
| L3    | **Copy & language** | Every user-facing string editable, per language, with placeholders; tone presets                                                                                                                                                                       | `strings` catalog with `{{placeholders}}`         |
| L4    | **Rules & logic**   | Conditions, segments, formulas and eligibility written in a safe expression language (`when`, `unless`, `score = …`), evaluated in the pure core; visual builder + code view                                                                           | `rules` schema referencing the expression grammar |
| L5    | **Data**            | Custom fields on the product's entities and on Graph entities; custom events; tags; import/export                                                                                                                                                      | `customFields` allowed per entity                 |
| L6    | **Extend**          | Webhooks in/out, custom tools/actions pointing at merchant URLs, sandboxed JS hooks in the Loader (`before/after` element events), slots for merchant HTML                                                                                             | `hooks[]`, `slots[]`, `webhooks[]`                |
| L7    | **Placement**       | Where and when elements render: path patterns, CSS selectors, page types, device, referrer, time, consent state, scroll/idle/exit triggers                                                                                                             | `placement` schema (shared)                       |
| L8    | **Governance**      | Who may change what (website-scoped roles), locks by staff, approval workflow for sensitive changes (pricing rules, payment settings), versions + rollback, **experiments** (A/B variants of any element config with traffic split and success metric) | `governance` metadata, `experiments`              |

**Expression language (shared, tiny, safe).** Boolean and arithmetic over event/entity fields, sets, dates, string ops, and a fixed function library (`inSegment()`, `daysSince()`, `total()`, `has()`, `matches()`), no side effects, time-boxed evaluation, versioned grammar. Used by rules everywhere so merchants learn it once.

**Experiments (shared).** Any element can hold up to N config variants; the Loader/product assigns visitors deterministically; the metric comes from the Event Hub (`order.placed`, `chat.lead_captured`, custom); results shown with confidence; winner can be applied in one click.

---

### 1. Chatbot & Support (`chat`) — service product + element pack

**Purpose.** Answer, sell and support on the website and messaging channels, with AI first and humans when it matters.

#### Elements and what can be modified

| Element         | Configurable (highlights, all L1–L8 apply)                                                                                                                                                                                                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launcher`      | position, offset, size, icon/avatar, label, pulse, mobile tab integration, hide rules (pages, devices), open triggers (delay, scroll %, exit intent, idle, selector click), unread badge                                                                                                                              |
| `window`        | layout (bubble / side panel / full-screen mobile), header (name, avatar, status text), theme overrides, sound, typing indicator, message grouping, attachments UI, emoji, quick replies, persistent history per identity                                                                                              |
| `ai_replies`    | provider/model (via AI Gateway), persona and tone presets, system instructions (editable), languages (auto-detect + allowed list), answer length, citation style, confidence threshold → handoff, forbidden topics, escalation phrases, max tool rounds, token budget per conversation and per month, cost cap alerts |
| `knowledge`     | sources: uploaded files, URLs (crawl depth, refresh), FAQ entries, Graph items (which fields), policies pages; per-source priority; freshness rules; "don't know" behaviour                                                                                                                                           |
| `flows`         | **visual conversation builder**: nodes (message, question, buttons, form, condition, action, AI step, handoff, delay), variables, branching on rules (L4), entry triggers (page, keyword, event), exit actions                                                                                                        |
| `tools`         | built-in (order status, item search, quote offer, book slot, track shipment) with field mapping; **custom tools**: name, description, input schema, merchant webhook URL, auth header, timeout, allowed for AI or flows                                                                                               |
| `inbox`         | agents (count), teams, assignment (round-robin / load / rules), working hours per team, SLA targets and breach alerts, statuses, tags, priorities, canned replies with variables, internal notes, snooze, merge, transfer                                                                                             |
| `channels`      | web widget, WhatsApp, Messenger, Instagram, email-to-inbox, SMS — each with its own hours, greeting, opt-in text (via Messaging Gateway)                                                                                                                                                                              |
| `handoff`       | when (rule), to whom (team), message shown, offline fallback (lead form / WhatsApp link / email), queue position text                                                                                                                                                                                                 |
| `proactive`     | targeted messages by rule (cart value, page, returning visitor), frequency caps, dismissal memory                                                                                                                                                                                                                     |
| `lead_capture`  | fields (schema), required, consent checkbox text, where to send (Graph customer, webhook, email)                                                                                                                                                                                                                      |
| `forms_in_chat` | reusable forms (schema), validation, file uploads                                                                                                                                                                                                                                                                     |
| `product_cards` | show Graph items in chat (fields, image, CTA), add-to-cart action if Checkout present                                                                                                                                                                                                                                 |
| `csat`          | rating scale, when asked, follow-up question, target                                                                                                                                                                                                                                                                  |
| `transcripts`   | retention days, export, send transcript by email                                                                                                                                                                                                                                                                      |
| `moderation`    | PII redaction in/out, leak filter, link allow-list, profanity policy                                                                                                                                                                                                                                                  |
| `analytics`     | topics clustering, resolution rate, handoff rate, CSAT, cost per conversation                                                                                                                                                                                                                                         |

**Integration.** Widget via Loader; REST (`conversations`, `messages`, `bots`); events `chat.*`; Graph scopes `customer.read/write`, `item.read`, `order.read`. **Data.** Conversations, messages, flows, knowledge index, agents. **KPIs.** first-response time, resolution rate, deflection, CSAT, cost/conversation.

---

### 2. Signups & Identity (`auth`) — service product + pack

**Purpose.** Passwordless sign-in and profiles for any site; or federate the site's own login.

| Element         | Configurable                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `otp`           | channels (email / SMS / WhatsApp), code length/alphabet, expiry, resend cooldown, max sends per identity/hour, attempts, per-IP limits, global cap, templates per channel/language, provider selection |
| `magic_link`    | expiry, single-use, redirect rules, template                                                                                                                                                           |
| `social`        | providers (Google, Apple, Facebook…) with merchant's own client ids, scopes, account linking rules                                                                                                     |
| `federation`    | merchant issuer (JWKS/secret), claim mapping to Graph customer, session exchange                                                                                                                       |
| `sessions`      | lifetime, sliding renewal, device list, revoke-all, session version, cookie attributes                                                                                                                 |
| `profile`       | field schema (name, phone, email, addresses, custom fields), required fields, verification badges, avatar via Files                                                                                    |
| `account_pages` | which pages (profile, addresses, orders, wishlist, points, data export, delete account), layout, hosted vs embedded                                                                                    |
| `widget`        | sign-in UI variants (modal / inline / page), steps, copy, autofill, remember device                                                                                                                    |
| `risk`          | new-device notice, unusual-location rule, bot protection hook, disposable-email block list                                                                                                             |
| `consent`       | terms/privacy acceptance capture and versioning                                                                                                                                                        |
| `data_rights`   | self-service export/delete with cooling-off period                                                                                                                                                     |

**Integration.** SDK (`start`, `verify`, JWT verified offline), widget, REST, events `customer.created/signed_in/updated`.

---

### 3. Loyalty & Rewards (`loyalty`) — service product + pack

| Element        | Configurable                                                                                                                                                                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `earn_rules`   | list of rules: trigger event (any Graph event incl. custom) → points formula (expression: fixed, % of amount, per unit, per visit), caps per rule/period, exclusions (items, categories, payment methods, coupons), delay until `order.completed`, multipliers by tier/segment/campaign |
| `redeem`       | conversion rate, min/max per transaction, allowed with coupons?, redeemable products/categories, expiry of redemption codes, partial redemption                                                                                                                                         |
| `tiers`        | names, thresholds (points or spend), window, benefits (multipliers, perks flags, badges, free shipping via Checkout), downgrade rules, tier copy                                                                                                                                        |
| `expiry`       | months, FIFO/LIFO, notice schedule, grace                                                                                                                                                                                                                                               |
| `referrals`    | referrer/referee rewards, code format, landing page, fraud limits, attribution window                                                                                                                                                                                                   |
| `campaigns`    | double-points windows, birthday, streaks, missions (do X get Y)                                                                                                                                                                                                                         |
| `wallet`       | balance, history, expiring soon, statements; widgets (badge, page block, checkout block)                                                                                                                                                                                                |
| `adjustments`  | manual credit/debit, reasons, approval threshold, bulk import                                                                                                                                                                                                                           |
| `messages`     | templates per event/channel/language                                                                                                                                                                                                                                                    |
| `reversal`     | cancel/return/refund behaviour, negative balances policy                                                                                                                                                                                                                                |
| `gamification` | badges, progress bars, leaderboard (opt-in)                                                                                                                                                                                                                                             |

---

### 4. Coupons (`coupons`) — service product

| Element        | Configurable                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `codes`        | pattern/prefix, bulk generation (count, uniqueness), single vs multi-use, per-customer limits, global limits, validity window, auto-apply links (`?coupon=`) |
| `eligibility`  | rules (L4): customer segments, first order, min total, items/categories/brands/attributes, payment/delivery method, country/zone, device, referral source    |
| `actions`      | percent (bounded), fixed, free shipping, BXGY, tiered by quantity/total, gift item                                                                           |
| `stacking`     | with deals, with loyalty, with other coupons (classes)                                                                                                       |
| `distribution` | send via Messaging, embed in campaigns, QR generation, partner codes                                                                                         |
| `abuse`        | velocity limits, one per device, blocklists                                                                                                                  |
| `reporting`    | redemptions, revenue impact, top codes, exports                                                                                                              |

**Integration.** REST (`validate`, `redeem`, `release`), Checkout hook, events `coupon.redeemed`.

---

### 5. Deals & Promotions (`deals`) — service product + pack

| Element       | Configurable                                                                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `item_deals`  | scope (items/collections/attributes), action, schedule (weekday/time windows incl. overnight, date ranges, timezone), priority, quantity limits, per-customer limits |
| `cart_deals`  | thresholds (total/qty), payment/delivery conditions, free shipping, tiered                                                                                           |
| `flash_sales` | countdown, stock-limited, start/end, badge                                                                                                                           |
| `bundles`     | buy-together pricing, mix-and-match rules                                                                                                                            |
| `stacking`    | policy classes, best-offer selection strategy                                                                                                                        |
| `price_locks` | honour displayed price for N minutes, stale behaviour                                                                                                                |
| `display`     | badges, pills, strike-through formats, countdowns, deals page layout, sort                                                                                           |
| `quote_api`   | evaluate item/cart; rate limits                                                                                                                                      |
| `reporting`   | uplift, margin impact (needs cost from Catalog)                                                                                                                      |

---

### 6. Catalog & Product Information (`catalog`) — service product

| Element         | Configurable                                                                                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entity_schema` | item types (e.g. device, garment, course), attribute definitions (type, options, units, validation, filterable, card position, required), custom fields, localisable fields |
| `variants`      | option dimensions, uniqueness, pools per item, per-variant price/qty/cost/SKU/barcode, status                                                                               |
| `collections`   | tree depth, rules-based (smart) collections via expressions, manual ordering, marketing content, SEO fields                                                                 |
| `brands`        | registry, scoping, logos                                                                                                                                                    |
| `media`         | per-item limits, ladder via Files, alt-text templates, video                                                                                                                |
| `inventory`     | multi-location (optional), low-stock thresholds, backorder policy, restock dates                                                                                            |
| `pricing`       | price lists (by segment/currency), scheduled prices, cost (private), rounding                                                                                               |
| `publishing`    | statuses, schedule, visibility cascades, archive                                                                                                                            |
| `import_export` | CSV mapping, dry-run diff, conflict policy, images by URL                                                                                                                   |
| `connectors`    | pull from external systems (later: Shopify/Woo), field mapping, sync cadence                                                                                                |
| `api`           | read/write scopes, rate limits                                                                                                                                              |

---

### 7. Configurator Builder (`configurator`) — service product + pack

**Purpose.** Let users configure any configurable thing (variants, options, add-ons, bundles) and always land on a valid, priced result.

| Element       | Configurable                                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`      | option groups (type: single/multi/range/text/file), order, required, defaults, dependencies and exclusions (rules), hidden options, option images/swatches |
| `resolver`    | closest-match strategy (in-stock first, price, popularity), partial selection behaviour, fallbacks, "notify me" hook to Alerts                             |
| `pricing`     | deltas per option/combination, formulas (L4), currency, quantity breaks                                                                                    |
| `constraints` | stock-aware, compatibility matrices, min/max quantities                                                                                                    |
| `widget`      | layout (pills, dropdowns, swatches, cards, steps/wizard), summary panel, sticky CTA, validation messages, URL sync param names                             |
| `output`      | resulting SKU/variant, quote object for Checkout, share link, PDF summary (optional)                                                                       |
| `analytics`   | abandonment per step, popular combinations                                                                                                                 |

---

### 8. Grade & Condition System (`grades`) — service product + pack

| Element        | Configurable                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------- |
| `tiers`        | names, order, badge style/colour, description, icon, applicability per item type             |
| `criteria`     | inspection checklist per tier (items, pass/fail, photos required), scoring → tier suggestion |
| `warranty`     | days/text per tier, exclusions, printable terms                                              |
| `showcase`     | explainer block (video/images/table compare) placement and copy                              |
| `filters`      | expose tiers as filters, default sort                                                        |
| `mapping`      | tier → external condition values (feeds, structured data, marketplaces)                      |
| `unit_reports` | per-unit inspection report (via serials) visible to buyer                                    |

---

### 9. Product Detail Page (`pdp`) — element pack

| Element              | Configurable                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `gallery`            | layouts (carousel/grid/stacked), zoom, video, 360 (from Files), thumbnails, priority image, lazy strategy, aspect ratios                  |
| `title_block`        | fields order (brand, name, subtitle), badges (deal, grade, new), share                                                                    |
| `price_block`        | formats, savings display, taxes text, per-variant update, financing text (copy only)                                                      |
| `configurator_embed` | uses Configurator; placement                                                                                                              |
| `buy_box`            | quantity limits, CTA copy, secondary CTA (WhatsApp/ask), stock messaging, delivery estimate text rules                                    |
| `sticky_bar`         | mobile/desktop rules, contents                                                                                                            |
| `tabs_or_sections`   | description, specs (attribute groups), warranty, shipping/returns (from Content), FAQ (manual/AI via SEO), reviews (Reviews product), Q&A |
| `related`            | strategy (collection/brand/attribute/manual/AI), count, layout                                                                            |
| `trust`              | badges, policies links, contact strip                                                                                                     |
| `structured_data`    | on/off, mapping                                                                                                                           |
| `layouts`            | desktop/mobile variants, slots for merchant HTML, section order via drag-and-drop                                                         |
| `experiments`        | variants of any section                                                                                                                   |

---

### 10. Storefront Blocks (`storefront`) — element pack

`grid` (page size, sort options, pagination vs infinite, crawlable links), `cards` (fields, badges, chip cycling, hover media, quick-add), `filters` (facet list/order, layout sidebar/sheet/top bar, counts, multi-select, price slider), `search_overlay` (uses Search), `hero` (media rules incl. data-saver, headline/CTA copy per language, schedule), `trending`/`featured` (source rules), `collection_cards`, `brand_cards`, `deals_page`, `notice_bar` (schedule, dismiss memory, audience), `nav` (menus, mega-menu, mobile tab bar), `footer` (columns, contacts, policies, socials, hours), `theme` (tokens, fonts, radius, motion), `layout` (section builder per page type with slots).

---

### 11. Cart & Checkout (`checkout`) — service product + pack

| Element              | Configurable                                                                                                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cart`               | drawer/page, max qty per line/lines, notes, gift options, save-for-later, reconciliation policy (price/stock changes), guest merge, abandoned-cart events                                                             |
| `checkout_flow`      | steps (single-page / multi-step), guest allowed?, identity via Auth or federation, express reorder                                                                                                                    |
| `fields`             | address schema (which fields, required, validation, autocomplete), contact fields, custom fields, per-country overrides (optional)                                                                                    |
| `delivery`           | methods (courier zones, pickup points, scheduled slots), rates (flat/tiered/free thresholds/by rule), ETA text                                                                                                        |
| `payments`           | manual methods (bank transfer with proof upload & reference, cash on delivery with surcharge/caps/confirmation, pickup pay-later), gateway adapters (later) — each with instructions copy, availability rules, limits |
| `pricing`            | rounding, surcharges, taxes/VAT rules (later), currency                                                                                                                                                               |
| `offers_hook`        | apply Coupons/Deals/Loyalty (order of application, stacking policy from those products)                                                                                                                               |
| `place_order`        | idempotency, reservation policy, expiry hours, fraud/risk hooks, order numbering                                                                                                                                      |
| `success`            | steps copy by method, SLA text, tracking links, share/receipt                                                                                                                                                         |
| `policies`           | consent checkboxes, links to Content documents                                                                                                                                                                        |
| `abandonment`        | events for Automation/Messaging                                                                                                                                                                                       |
| `hosted_vs_embedded` | hosted checkout page, embedded blocks, or headless API                                                                                                                                                                |

---

### 12. Order Manager — "Ecommerce Helper" (`orders`) — service product

| Element            | Configurable                                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `intake`           | receive orders from our Checkout or any external system (API/CSV/webhook) with field mapping                                                        |
| `lifecycle`        | status set and names, transition matrix, who may transition, side effects (stock, points, messages), auto-expiry rules, customer-cancellable window |
| `fulfilment`       | carriers (name, tracking URL template, service levels), packing workflow, dispatch video, batch actions                                             |
| `serials`          | capture per unit, validation patterns, required-before-dispatch rules, lookup                                                                       |
| `documents`        | invoices/receipts/packing slips/pick lists — templates (branding, fields, legal text), numbering, PDF                                               |
| `payments_ledger`  | record payments/refunds (methods, references, proofs), partial refunds, reconciliation views                                                        |
| `risk`             | open-order caps, blocklists, RTO counters and thresholds, manual review queue                                                                       |
| `customer_updates` | messages per status via Messaging; tracking page (hosted)                                                                                           |
| `bulk`             | bulk status changes with per-order validation; CSV export/import                                                                                    |
| `views`            | saved filters, columns, SLAs (e.g. confirm within 2 h), alerts                                                                                      |
| `returns_hook`     | hands off to After-sales                                                                                                                            |

---

### 13. After-sales (`aftersales`) — service product + pack

`claim_types` (return/warranty/exchange/repair: windows by rule, evidence, photos), `intake_form` (fields per type), `queue` (statuses/transitions/assignments/SLAs), `decisions` (approve/reject reasons, partial), `logistics` (return labels text, pickup), `resolution` (refund via ledger, replacement order, repair tracking), `restock` (per line), `serial_registry` (warranty lookup page), `messages`, `reporting` (return rate by reason/item).

---

### 14. Site Search (`search`) — service product + pack

`index` (sources: catalog fields with weights, pages, files, custom docs), `ranking` (boosts, synonyms, typo tolerance, pinned results, rules by query), `suggestions` (popular, recent, categories), `overlay` (layout, hotkeys, mobile), `results_page` (filters, sort), `analytics` (queries, zero results, CTR), `api`.

---

### 15. Reviews & Ratings (`reviews`) — service product + pack

`collection` (who, when, incentives), `request_flow` (timing, channel, reminders), `moderation` (auto rules, manual, replies), `content` (title/body limits, photos/videos, attributes ratings e.g. fit), `display` (widgets, sort, filters, summary, Q&A), `structured_data`, `import` (from other platforms), `analytics`.

---

### 16. Alerts & Waitlists (`alerts`) — service product + pack

`types` (stock, price-drop threshold, availability/slots, custom), `capture` (identity fields, consent, rate limits), `dispatch` (channels, templates, caps, quiet hours, batching), `triggers` (events/API/CSV), `waitlist_priority` (FIFO / tier), `analytics`.

---

### 17. Wishlist (`wishlist`) — element pack + Graph storage

`lists` (multiple lists, names), `items` limits, `guest_merge`, `share` (public link, privacy), `price_drop_hook`, `widgets` (heart button placement, page block), `analytics`.

---

### 18. Messaging & Campaigns (`messaging`) — service product

`templates` (per event/channel/language, approval status for WhatsApp templates), `transactional` (send API, priorities), `providers` (platform or own credentials per channel), `outbox` (retries, DLQ, rate pacing), `campaigns` (audience via Graph segments/rules, schedule, throttle, A/B subject/body, links tracking), `preferences` (opt-in/out per channel, quiet hours), `inbound` (replies to Chat inbox), `analytics` (delivery, open/click where available).

---

### 19. SEO Suite (`seo`) — service product (+ edge rules)

`health` (checks list, thresholds, schedule, guided fixes), `metadata` (templates by page type, rules, overrides per URL), `structured_data` (types per page type, mappings), `sitemaps` (types, chunking, images, exclusions), `feeds` (shopping feeds mapping), `redirects` (manager, slug history, host/case rules, import), `intent_pages` (templates, thresholds, generation), `ai_copy` (fields, tone, languages, batch, approval), `og_images` (templates), `llms_txt`, `verification`, `crawl` (audits), `edge_rules` (apply at the edge without site changes), `rank_tracking` (later), `reporting`.

---

### 20. Analytics & Insights (`analytics`) — service product + pack

`collection` (page views, vitals, custom events, sampling), `funnels` (steps by event/rule), `kpis` (definitions via expressions), `segments`, `attribution` (source/medium rules), `dashboards` (widgets, sharing), `alerts` (anomalies), `retention`, `exports`, `privacy` (consent gating, IP policy).

---

### 21. Consent & Tags (`consent`) — element pack

`banner` (layouts, texts per language, categories, granular toggles, re-consent policy), `consent_mode` (Google), `tag_loader` (tags by category, load order, custom scripts), `conversion_events` (event → tag payload mapping), `records` (log, export), `geo_rules` (optional).

---

### 22. Content & Policies (`content`) — service product + pack

`documents` (types, editor with sanitizer policy, tokens from other products), `pages` (hosted pages with layouts/blocks), `glossary`, `announcements`, `faqs`, `versions`, `languages`, `seo_fields`.

---

### 23. Files, Media & Drive (`files`) — service product + pack

`uploads` (types, sizes, folders, direct-to-storage), `images` (ladders, formats, quality, placeholders, focal points), `video` (presets, posters), `drive` (folders, sharing, versions, trash), `providers` (platform or own bucket), `cdn` (custom domain), `quotas`, `usage_reports`.

---

### 24. Automation (`automation`) — service product

`rules` (trigger: any event/schedule/threshold → conditions (L4) → actions), `actions` (message, points, tag, segment add/remove, webhook, create task, pause offer, adjust stock, custom tool), `delays_and_waits`, `sequences` (multi-step journeys), `runs` (logs, retries), `templates` (library of common automations), `limits`.

---

### 25. Reports & Exports (`reports`) — service product

`library` (sales, inventory, service, marketing reports), `builder` (dimensions/measures over Graph and product data), `schedules` (email/WhatsApp delivery), `exports` (CSV/JSON/API), `sharing`, `retention`.

---

### 26. Ops Monitor (`ops`) — service product

`health` (endpoint checks for the site and products), `errors` (client/server error reporting), `uptime`, `digests` (daily/weekly), `alerts` (channels, thresholds), `audit_viewer`.

---

### 27. Team & Access — Portal-provided

Roles, website scoping, invites, 2FA, audit, activity feed, approvals.

---

### 28. Out-of-the-box product ideas (backlog, same model)

Booking & Appointments (slots, resources, deposits) · Forms & Surveys (builder, logic, submissions to Graph) · Pop-ups & Banners (targeting, experiments) · Referral & Affiliate (links, commissions) · Gift cards & Store credit · Subscriptions & Recurring orders · Multi-vendor marketplace tools (vendors, payouts) · Live shopping / video commerce · Product Q&A · Size/fit assistant · Image search · Price intelligence (competitor tracking) · Translations (site localisation) · Accessibility widget · Legal generator (policies from answers) · Digital downloads / licensing · Events & tickets · Donations · Feedback & NPS · Help center / knowledge base · Status page for merchants' own services.

---

### 29. How this stays simple for the Portal

Every capability above is expressed to the Portal as: an element (switch + price), typed features (schemas), rules (shared expression grammar), placement (shared schema), strings (catalog), hooks/webhooks (declared), experiments (shared). The Portal renders forms from schemas and enforces precedence, locks, budgets and pricing. It never learns product-specific logic.

---

# PART E — PRODUCT STANDARD (SSPS v1)

**Purpose.** Ten developers, ten repos, one behaviour. Every product — ours or third-party — is built to this standard so the Portal, the Loader, the SDKs, the docs, the consoles and the certification pipeline work with it without special cases, and so a merchant can consume any product in **three interchangeable ways**: drop-in UI, their own UI on our headless core, or API only.

The standard is enforced, not suggested: the product template generates it, `@ss/app-kit` implements it, `eslint-plugin-ss` lints it, and the certification suite tests it.

---

### 1. Three consumption modes (every element, always)

| Mode               | Who builds the UI                         | What the product must provide                                                                                                                           | Typical user                                          |
| ------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **A. Drop-in**     | We do (default renderer)                  | Element renders via the Loader with the website's design tokens, variants, slots and copy                                                               | Merchant with no developer                            |
| **B. Headless UI** | The merchant's developer                  | The element's **headless core**: state, actions, events, validation, i18n strings — framework-agnostic, plus React/Vue/Svelte adapters; no DOM opinions | Developer wanting a fully custom look                 |
| **C. API only**    | Nobody on the front-end (or a mobile app) | The element's REST/SDK surface with identical semantics; server keys                                                                                    | Headless sites, mobile apps, back-office integrations |

Rules:

- The **same configuration, rules, entitlements, pricing and events** apply in all three modes. Turning an element off disables A, B and C together.
- Mode A is implemented **on top of** Mode B, and Mode B **on top of** Mode C. A product may not add behaviour that only exists in the default renderer.
- Every element declares which modes it supports; **C is mandatory** for any element with state, **B is mandatory** for any element with UI, **A is mandatory** for element packs.

---

### 2. Product anatomy (mandatory layout)

```
product-<slug>/
  manifest.json            # SSPS manifest (schema-validated)
  openapi.json             # generated from routes; must validate and match manifest elements
  core/                    # pure domain: rules, state machines, calculations, validators (no I/O)
  headless/                # element cores: createXxxElement(config) → { state, actions, subscribe, strings }
  ui/                      # default renderers for elements (Mode A), built only on headless/
  api/                     # REST v1 handlers: thin, call core/, use adapters
  adapters/                # db (per-website keyed repos), platform (app-kit clients), providers (via platform services)
  jobs/                    # signed scheduled handlers
  strings/                 # string catalog (en + others), placeholders declared
  schemas/                 # JSON Schemas for element features and custom fields
  tests/                   # unit (core), contract (SSPS suite), e2e
  docs/                    # generated + guides
```

Only `core/` and `headless/` may contain business logic. `ui/` and `api/` are adapters. Lint enforces import direction: `ui → headless → core`, `api → core`, never the reverse. Packages: `core/` may use `@ss/rules` and `@ss/contracts`; `headless/` those plus the DOM-free element runtime `@ss/web/element` (no other `@ss/web` entry); `ui/` `@ss/web` and `@ss/ui`.

---

### 3. Manifest (the single source of truth)

`manifest.json` declares everything the Portal and tooling need; nothing is inferred from code.

```jsonc
{
  "ssps": "1",
  "product": { "slug": "coupons", "name": "Coupons", "kind": "service" | "pack", "version": "1.4.0", "category": "commerce" },
  "endpoints": { "base": "https://…", "dashboard": "/dashboard", "demo": "/demo", "events": "/.well-known/ss-events" },
  "capabilities": { "adminLaunch": true, "sandbox": true, "localEnforcement": ["quota:redeem"], "offlineGrace": "PT24H" },
  "scopes": ["graph.customer.read", "graph.order.read", "events.subscribe:order.*", "messaging.send"],
  "events": { "consumes": ["order.placed@1", "cart.updated@1"], "publishes": ["coupon.redeemed@1"] },
  "elements": [
    {
      "key": "codes",
      "name": "Coupon codes",
      "modes": ["C"],                                   // A/B/C supported
      "price": { "hourly": 1, "metered": [{ "unit": "redemption", "perUnit": 0.01, "included": { "starter": 500 } }] },
      "budget": { "js": 0 },                            // KB for Mode A bundle; 0 = no UI
      "dependsOn": [],
      "features": { "$ref": "schemas/codes.features.json" },
      "strings": "strings/codes.json",
      "placement": false,
      "rules": ["eligibility"],                         // named rule slots using the shared grammar
      "hooks": ["beforeRedeem", "afterRedeem"],
      "customFields": ["coupon"],
      "experiments": true,
      "api": { "resources": ["coupons", "redemptions"] },
      "headless": null,
      "renderer": null
    },
    {
      "key": "apply_box",
      "name": "Coupon apply box",
      "modes": ["A", "B", "C"],
      "price": { "hourly": 0 },
      "budget": { "js": 6 },
      "dependsOn": ["codes"],
      "placement": true,
      "headless": "headless/applyBox.js#createApplyBox",
      "renderer": "ui/applyBox.js#render",
      "variants": ["inline", "collapsible"],
      "slots": ["before", "after", "success"],
      "a11y": { "role": "form", "labels": true }
    }
  ],
  "plans": [ { "code": "starter", "elements": ["codes", "apply_box"], "bounds": { "codes.features.maxActive": 50 } } ],
  "priceBook": { "version": "2026-10-01", "effectiveFrom": "2026-10-01T00:00:00Z" },
  "trialHours": 48
}
```

The Portal validates the manifest against `manifest.schema.json`, imports elements/features/prices, generates configuration forms from the feature schemas, and shows API docs from `openapi.json`. A product cannot be listed if the manifest and the OpenAPI disagree (every element with mode C must have its resources documented).

---

### 4. Element runtime interface (Mode B — headless)

Every UI-bearing element exports a factory with **one shape**:

```js
// headless/<element>.js
export const createApplyBox = ({ config, strings, client, identity, emit }) => ({
  state: () => ({ status: 'idle' | 'loading' | 'ready' | 'error', ... }),   // immutable snapshot
  actions: { setCode, apply, clear },                                       // async, return Result<T, Problem>
  subscribe: (listener) => unsubscribe,                                    // state change notifications
  validate: (input) => Problem[] ,                                          // sync, pure
  strings,                                                                  // resolved for the active language
  destroy: () => void,
});
```

- Framework-agnostic; adapters in `@ss/web/react|vue|svelte` wrap it as hooks/composables (`useApplyBox()`).
- `client` is the element's Mode-C API client (so B is built on C), already scoped with the website key and entitlement.
- `emit` publishes element events (`apply_box.applied`) which flow to analytics/experiments and to merchant hooks.
- No DOM access in `headless/`. Lint enforces it.

**Default renderer (Mode A)** is a pure function of `(state, actions, strings, theme, slots)` returning DOM, mounted by the Loader according to `placement`. It must use design tokens only (no hard-coded colours/fonts), expose `variants`, honour `slots`, meet the a11y rules (§8), and stay under the declared `budget.js`.

---

### 5. API standard (Mode C)

| Topic         | Rule                                                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Base          | `https://<product>/v1/…` ; version in path; `Accept: application/json`                                                                                                                                                               |
| Auth          | `Authorization: Bearer <website key>` (`pk_` for browser-safe reads, `sk_` for server); `X-SS-Website` optional override never trusted over the key's binding; SSO sessions for dashboard routes; app-to-Portal via client-assertion |
| Resources     | plural nouns, kebab-case paths, `id` opaque strings, `websiteId` never in the path (derived from the key)                                                                                                                            |
| Reads         | `GET /v1/<resource>?cursor=&limit=&filter[field]=&sort=` ; cursor pagination; `fields=` sparse selection; `include=` for relations                                                                                                   |
| Writes        | `POST` create, `PATCH` partial update (JSON Merge Patch), `DELETE` soft by default; **`Idempotency-Key` required** on POST that creates or moves state; replay returns the original result                                           |
| Errors        | RFC 9457 problem details: `{ type, title, status, detail, instance, requestId, errors[] }`; stable machine `type` URIs per product                                                                                                   |
| Rate limits   | `RateLimit-Limit/Remaining/Reset` headers; 429 with `Retry-After`                                                                                                                                                                    |
| Versioning    | additive changes only within `/v1`; breaking → `/v2` with `Sunset` and `Deprecation` headers on the old one; N-1 supported for 12 months                                                                                             |
| Webhooks out  | signed (`SS-Signature`, `SS-Timestamp`, `kid`), retried with backoff, event envelope identical to the Event Hub                                                                                                                      |
| Batch         | `POST /v1/<resource>:batch` with per-item results                                                                                                                                                                                    |
| Time & money  | ISO-8601 UTC timestamps; money as integer minor units + currency code                                                                                                                                                                |
| Custom fields | `custom: {}` object on entities that declare `customFields`, validated by merchant-defined schema                                                                                                                                    |
| Docs          | OpenAPI 3.1 generated from code; examples for every operation; SDK generated from the spec                                                                                                                                           |

Every product exposes the **same standard resources** in addition to its own: `GET /v1/entitlement` (what this website has enabled, from cache), `GET /v1/config` (effective config for the element(s) requested), `POST /v1/events` (element/domain events the site wants to push into this product), `GET /v1/strings?lang=`.

---

### 6. Configuration standard

- Every configurable value is a **feature** in an element's feature schema (JSON Schema 2020-12 subset) with `title`, `description`, `default`, bounds, `x-ui` (widget, group, order, help), `x-plan` (per-plan default/max), `x-lock` (lockable), `x-experiment` (variant-able).
- **Strings** live in the string catalog, not in schemas; placeholders declared with types.
- **Rules** use the shared expression grammar (`@ss/contracts/rules`), evaluated in `core/` with the provided evaluator; products never ship their own DSL.
- **Placement** uses the shared placement schema; products never invent their own targeting model.
- **Precedence, locks, versions, experiments** are Portal features; products read only the resolved, signed entitlement document and must not persist merchant config themselves except caches.

---

### 7. Data standard

**Ownership.** Products store data **only in the merchant's own database** (connection provided via the Portal, resolved by `app-kit` as `db = await dataFor(websiteId)`) and files **only in the merchant's own bucket**. Products never persist merchant/customer data in platform-owned storage; the only exceptions are short-lived caches (entitlements, revocations) and queues, which hold no payloads beyond ids. Collections are prefixed `ss_<product>_…` inside the merchant database; a product must create its own indexes idempotently on first connect and run lazy, versioned migrations keyed by `schemaVersion`. Connection pools are cached per merchant with serverless-safe limits (kit-provided). Providers (AI, messaging, storage, payments) are used **only through connectors that execute with the merchant's credentials**; products never hold platform provider keys.

Every stored document: `_id`, `websiteId` (required, indexed first in every compound index), `merchantId`, `env` (`live`|`test`), `createdAt`, `updatedAt`, `schemaVersion`, optional `custom`. Repositories are generated by the template and **reject any query without `websiteId`**. Append-only collections declared as such (no update/delete functions generated). Retention per collection declared in the manifest (`retention: { conversations: "P365D" }`) and enforced by TTL. Export and anonymise handlers are mandatory (`POST /v1/data:export`, `POST /v1/data:anonymize` — Portal-signed).

---

### 8. UI standard (Mode A renderers and dashboards)

Design tokens from the website (colours, type, radius, spacing, motion) via CSS variables; no hard-coded styles. Variants declared in manifest. Slots for merchant HTML. Accessibility: keyboard operable, focus visible, ARIA roles/labels, contrast ≥ 4.5:1 with default tokens, reduced-motion respected, no layout shift on mount (reserve space). i18n: strings from catalog, RTL-safe layouts. Performance: budget enforced at compile; lazy mount by placement; no third-party scripts unless declared. Dashboards (SSO) use `@ss/ui` components for consistency and support `merchant`, `demo`, `admin(scope)` and `impersonate` launch kinds with the standard top bar (context switcher, audit banner).

---

### 9. Events standard

Publish and consume only envelope-conformant events (`@ss/contracts`): `id`, `type@v`, `websiteId`, `env`, `occurredAt`, `idempotencyKey`, `actor`, `data`, `context`. Consumers are idempotent (dedupe on `id`). Element UI events (`<element>.<verb>`) are emitted through the headless `emit` and forwarded by the Loader to analytics/experiments. Product domain events are declared in the manifest with versioned schemas.

---

### 10. Security standard

Offline verification of website keys and entitlement documents (app-kit); origin/domain enforcement on `pk_` traffic; scopes enforced on Graph and shared-service calls; per-product DB user; secrets only via Secrets service; input validation on every boundary with the schemas; output encoding; CSP-compatible renderers (no inline scripts); no PII in logs; audit entries for dashboard actions with actor (including platform admins); rate limits via shared store; graceful degradation when the Portal is unreachable (`offlineGrace`).

---

### 11. Observability standard

Structured JSON logs with `requestId`, `websiteId`, `element`; metrics: request latency, error rate, queue depth, usage reported, cache hit rate; heartbeat with version; error reporting hook; per-website delivery logs for webhooks.

---

### 12. Testing & certification standard

Products ship: unit tests for `core/` and `headless/` (state machines), contract tests from `@ss/certify` (registration, launches of all kinds, key verification, entitlement handling incl. offline, origin enforcement, idempotency, error format, pagination, standard resources, events envelope, data export/anonymise), isolation tests (generated), renderer tests (a11y, tokens only, budget, no CLS), API conformance (OpenAPI lint + example validation), e2e for the demo. Certification runs the same suite in CI and again in the Portal before listing. Levels: Listed → Certified → Featured.

---

### 13. Versioning & lifecycle standard

Semver for the product; manifest `version`; price-book `version` with `effectiveFrom`; breaking manifest changes flagged; `/v1` additive-only; deprecation headers and 12-month N-1; changelog file; migration scripts with dry-run; `Sunset` announcements propagate to merchants through the Portal.

---

### 14. Tooling that makes the standard automatic

- `ss app init --kind service|pack` — generates the anatomy, manifest skeleton, repositories with `websiteId` guards, standard resources, health endpoints, string catalog, tests.
- `ss app validate` — manifest ↔ OpenAPI ↔ code consistency, schema lint, budget estimate.
- `ss dev` — local Portal emulator (fake merchants/websites/entitlements/keys, event injector, launch generator).
- `ss certify` — runs the full certification suite locally.
- `eslint-plugin-ss` — import direction, no DOM in headless, no hard-coded styles, `websiteId` in queries, no literals for configurable values, idempotency on writes.
- `@ss/app-kit`, `@ss/web` (+ framework adapters), `@ss/contracts`, `@ss/ui`, `@ss/certify`.

---

### 15. Definition of Done for any element

1. Manifest entry with modes, price, budget, features schema, strings, placement/rules/hooks as applicable.
2. Mode C resources documented in OpenAPI with examples; idempotent writes; standard errors.
3. Headless core with state/actions/subscribe/validate; framework adapters compile.
4. Default renderer (if A) using tokens, variants, slots, a11y and budget.
5. Feature schema drives a working form in the Portal emulator; precedence and locks respected.
6. Events declared and emitted; consumers idempotent.
7. Tests: unit, contract, isolation, renderer, e2e; certification green.
8. Docs generated; changelog entry.

---

# PART F — IMPLEMENTATION DECISIONS (binding; supersedes earlier wording where they differ)

Recorded as the core packages were built on branch `platform-v1`. Each package's `README.md` is the detailed normative reference; this part is the index of decisions.

## F.1 Money and settlement (`@ss/entitlements`)

- All prices and ledger amounts are **integer millicredits** (1 credit = 1000). Tiny per-unit prices are reduced fractions `{ millicredits, per }`. Every charge rounds down; metered charges are computed on cumulative period usage so hourly amounts sum exactly to the period total.
- **Billing hour:** only complete UTC hours settle. A bucket with _any_ active instant is billed in full, priced at its first active instant (elements and price-book pin read there). Only fully paused/suspended/spend-capped hours are free. Settlement runs after the hour, so a balance can go negative by at most one hour; spend caps use the upcoming hour's cost to pause first.
- **Two ledger entries per hour** when metered usage exists: `${subscriptionId}:${hourISO}` (base + elements) and `${subscriptionId}:${hourISO}:metered`. Zero-amount buckets are still emitted so reconciliation sees every hour.
- Price-book pins apply from `max(pin.at, effectiveFrom)`; buckets without a price book are skipped as `unpriced` and alerted.

## F.2 Entitlement resolution

- **Lock authority** (not list order): website 1 < merchant 2 < product = plan 3 < platform policy 4 < admin 5. The highest-authority lock wins; lower-authority values are excluded and reported. Admin may exceed plan max. Absolute schema bounds bind everyone, admin included. Plan max applies to merchant, website and experiment values; platform policy is not plan-bounded.
- **Plans** are `{ code, name?, description?, elements[], addons?[] }`: `elements` included and on by default, `addons` allowed and off by default, anything else unavailable (`not_in_plan`). Included elements' dependencies must be included; add-ons' dependencies must be in `elements ∪ addons`. No plan ⇒ every element available with product defaults.
- **Per-plan defaults and maxima live only in feature schemas** (`x-plan`). Max semantics: number = value, array = item count, string = length, flag = boolean (`false` = cannot be enabled).
- **Runtime order per element:** state (cancelled › suspended › paused › spend_cap) → `resource_missing` (element `requires` a connector not `connected`) → `rollout` → `dependency` (topological cascade; never auto-enables). A hard-stop quota blocks only that feature, not the element.
- Rollouts here are subscription-level; visitor-level audience/placement belongs to the Loader.
- **Document mapping:** the `@ss/contracts` entitlement document is canonical. `toDocument()` converts resolver output; the Portal assigns an integer `version` and bumps it when `contentHash()` changes; diagnostics stay in the resolver report; cancelled subscriptions get no document (revoked instead).
- `@ss/entitlements` is Node-only (`node:crypto`); browsers receive signed documents, never run the resolver.

## F.3 Contracts (`@ss/contracts`)

- Schema `$id`s are URNs `urn:ss:contracts:v1:<name>` (no hosts). Objects are closed (`additionalProperties: false`); v1 changes are additive and validators ship before producers.
- Money in events/graph: integer minor units; one `currency` per cart/order context, `{ amount, currency }` when standalone.
- **Feature-schema subset:** object root, one `type` per node, no `$ref`/combinators; top-level features need `title` and `default`. Extension keywords: `x-kind` (flag|quota|limit|rate|config), `x-plan`, `x-lock`, `x-experiment` (element must allow experiments), `x-period` (required on quota: hour|day|week|month), `x-hardStop`, `x-unit` (snake_case), `x-per` (required on rate: second|minute|hour), `x-ui` (form hints only).
- Manifest `features` are delivered **inline** to the Portal; `ss app validate` bundles any local refs.
- **Mode rules:** pack ⇒ every element mode A; A ⇒ renderer + `budget.js > 0`; B ⇒ headless core; renderer ⇒ headless + A; UI (renderer/placement/budget) ⇒ B; stateful ⇒ C, satisfied by the element's or a dependency's `api.resources`.
- **Element packs:** no `endpoints`, no admin launch, modes ⊆ {A, B}, no `api.resources`, scopes limited to `graph.*` and `events.publish:*`; stateful pack elements need a `graph.<entity>.write` scope. Packs are published as signed bundles, not via the registration handshake. **Service products** must declare `endpoints.base`, `register`, `events`.
- **Event scopes are mandatory:** every consumed event (an exact `type@v` or a glob such as `custom.*` / `order.*@1`, F.14) is covered by an `events.subscribe:<glob>` scope; published events are in the product namespace (slug with `-` → `_`, e.g. `notice_bar.*`) or a standard event covered by `events.publish:<glob>`. Glob `*` spans dots; a pattern without `@` matches all versions.
- Entitlement document time fields: `issuedAt`, `validFrom`, `validUntil` (ISO-8601 UTC); `resources[].ref` accepts opaque ids only (never connection strings); `dataScope.prefix` ends with `_`; feature keys are `<element>.<featurePath>`.
- Domains: `normaliseDomain` lowercases, punycodes, strips scheme/path/port/trailing dot, rejects IPs (incl. odd forms), `localhost`, single labels and wildcards unless `allowLocal`; public-suffix rejection is an injected predicate.
- Ids: `<prefix>_` + 128 random bits as 26 lowercase Crockford base32 chars.
- Problems follow RFC 9457 with a configurable type base URI (`createProblemFactory({ baseUri })`) and 34 stable codes (`identity_required` and `identity_invalid` added for bring-your-own identity, F.14).
- **Event scopes:** the envelope's optional `scope` is `website` (the default, `websiteId` required) or `platform` (no `websiteId`). Each catalogued type has a fixed scope. `manifest.accepted@1` is platform-scoped, and sentinel website ids are refused.

## F.4 Rules language (`@ss/rules`, `rules@1`)

- Hand-written Pratt parser, no `eval`, programs are plain JSON `{ v: 1, ast }`, re-validated whenever loaded from storage.
- **No regular expressions:** `like`/`ilike` glob (`*`, `?`, `\`), patterns ≤ 256 chars, iterative matcher charged to the step budget. Library: `has, count, sum, min, max, avg, round, floor, ceil, abs, lower, upper, trim, startsWith, endsWith, like, ilike, daysSince, hoursSince, minutesSince, dateParts, between, inSegment, any, all, filter, map, coalesce, len, date, number, string`.
- Durations are milliseconds; date literals without zone are UTC; no implicit type coercion; missing paths → null; null ordering comparisons → false; comparisons cannot chain; `it` reserved for predicates.
- `between(time, 'HH:MM', 'HH:MM', tz)` is a `[start, end)` time-of-day window that wraps past midnight when start > end.
- Products pass the website's timezone as `options.timeZone` (default UTC). **An evaluation error means "did not match."** Context data must be JSON + `Date` (convert DB ids to strings).
- Default limits: length 4000, depth 64, nodes 2000, steps 10000, list 1000, string 10000 — each a distinct error code.

## F.5 Protocol (`@ss/protocol`)

- One JWS path: EdDSA only, `kid` required, a distinct `typ` per token type; `jwk/jku/x5u/x5c/crit/b64/zip` headers refused; token length capped; exact `aud`/`iss`.
- **Key rotation:** JWKS entries may carry `nbf`/`exp`; unknown kids trigger at most one refetch per 30 s; last-known keys survive Portal outages up to `maxStaleMs` (24 h); revocation beats everything; duplicate kids are dropped. **Rotating the Portal key that signs website keys requires re-issuing all website keys.**
- **Launch kinds:** admin must carry a scope (merchant or `all`); demo must not carry `merchantId`; partner needs `partnerId`; developer needs `developerId`; impersonate needs `act.sub ≠ sub`, `merchantId`, and `impExp ≤ 1 h`; only impersonate may carry `act`/`impExp`. Launch claims list `subscriptions`. TTL default 60 s, max 300 s.
- **Website keys:** `pk_`/`sk_` are signed tokens verified offline plus server-side revocation by `keyId`; the prefix must agree with the signed kind and env (no relabelling). Revocation lists refresh ≤ 5 min. The Portal stores only HMAC-SHA-256(key, pepper) and compares in constant time.
- **Origin check:** Origin is authoritative, Referer only when Origin is absent; https only (localhost only in test env); userinfo/whitespace/control chars/backslashes refused; exact host or `.domain` suffix when `allowSubdomains`.
- **Events:** `SS-Signature: v1;kid=<kid>;sig=<b64url>` (up to 4 entries for dual-signing during rotation) over `ss-event.v1.${timestamp}.${sha256hex(body)}`; `SS-Key-Id` is only a hint; replay key `ts|sha256(body)` within tolerance (300 s).
- **Connection (superseding earlier onboarding schemes):** the product holds `CONNECT_SECRET` (≥ 32 chars, set by the deployer; without it connection attempts get 503); the Portal never stores it. Staff enter the product URL and the secret; the Portal sends `POST <url>/.well-known/ss-connect` with `{ portalUrl, jwks, appId, baseUrl, nonce }`, `SS-Connect-Timestamp` and `SS-Connect-Signature` = hex HMAC-SHA256(secret, `ss-connect.v1|<timestamp>|<body>`). The product verifies in constant time (± 5 min, nonce single-use via a TTL record), generates its Ed25519 key if absent, pins the Portal URL and keys and answers `{ appId, nonce, publicJwk, manifest }` signed the same way under `ss-connected.v1`; the Portal verifies it and stores the app with the base URL and key pinned. Connecting again with the right secret replaces the binding (same app for the same URL); to lock a Portal out, change `CONNECT_SECRET` and connect from the right Portal.
- **Replay/nonce stores in production** are one shared atomic TTL store (MongoDB unique `_id` + TTL index) in the control plane.
- **Pack bundle signatures** (`signBundle` / `verifyBundle`) are detached Ed25519 signatures over `ss-pack-bundle.v1.<sha256(canonicalJson(descriptor))>`.
- **Signed manifests:** `/.well-known/ss-app.json` carries `SS-Manifest-Signature`, a JWS with `typ ss-manifest+jws` and payload `{ appId, manifestHash, iat }`, signed with the registered product key. It is cached for 5 minutes and is unsigned before registration. The Portal checks it with `verifyManifest` (default max age 24 h) before importing a refreshed manifest.

## F.7 Browser SDK (`@ss/web`)

- Modules: `client` (events), `element` (headless runtime, Mode B), `renderer` (Mode A helpers), `loader` (`boot`), `audience` (the only importer of `@ss/rules`), `react` (`createUseElement(React)`; React is an optional peer and is never imported). Every browser global is injectable; nothing is hardcoded (events endpoint and element API bases are configuration).
- **Events client:** `type` without `@v` gets `@1`; `idempotencyKey` defaults to the event `id` and is stable across retries; actor is `customer` when a federated token is present (the server resolves who), else `anonymous` + anonymous id. Batches of 20 / 1 s; 408/425/429/5xx and network errors retry with jittered exponential backoff (1 s → 60 s, `Retry-After`, ≤ 8 attempts); other non-2xx drop the batch. Offline queue in localStorage capped at 500 events / 256 kB (oldest dropped). `sendBeacon` on `pagehide`/hidden sends `text/plain` with **body auth** `{ key, identity?, events }` — **the ingest endpoint must accept header and body auth and dedupe on `(websiteId, idempotencyKey)`**. Identity travels as `SS-Identity: <token>`.
- **Consent:** opt-in by default (`defaultConsent: {}`); `necessary` is always granted and covers `customer.* cart.* order.* inventory.* price.* file.*`; everything else is `analytics` unless mapped. Non-consented events are dropped (not buffered); revocation purges queued events; anonymous/session ids persist only with `analytics`.
- **Headless runtime:** instance = `{ key, state, actions, subscribe, validate, strings, destroy, isDestroyed }`; actions never throw (`internal_error`, `destroyed`); `validate` returns field problems `{ path, code, message }`; element API client adds `Idempotency-Key` on POST and returns RFC 9457 problems with a stable `code` (body `code` › last `type` segment › status).
- **Loader:** placement per contracts v1; path `*` = one segment, `**` = any; overnight schedule windows belong to their start day; `maxPerDay` is a rolling 24 h; `dismissMemory` starts when the element emits `<key>.dismissed`; audience evaluation errors or a missing evaluator mean "no match". Elements a bundled entitlement document marks disabled or non-active never mount. Each element is isolated (`onError`, `ss:error`, `loader.element_failed@1`). `boot` is idempotent per website; `window.SS` replays a pre-boot `SS.q` stub. Loader-emitted events: `<key>.shown@1`, `loader.vitals@1` (sampled LCP/CLS/INP + per-element `mountMs`), `loader.element_failed@1` (`{ element, phase, code: <phase>_failed, message }` — never the error text) — all catalogued in `@ss/contracts` (F.14).
- **Budget:** Loader + events client ≈ 12.8 kB gzip (< 15 kB). The rules evaluator (≈ 9.5 kB gzip for precompiled programs, ≈ 12.6 kB with the parser) is bundled only for websites with audience rules and counts against their budget; the compiler should precompile audience source to programs.

## F.6 Repository and tooling

- Monorepo `pnpm` workspace on branch `platform-v1`: `packages/*` (contracts, rules, entitlements, protocol, then app-kit, web SDK, cli, ui), `platform/` (Portal), `products/*` (reference products; each extractable to its own repo).
- JavaScript ESM, functional (ESLint forbids classes and `console`), JSDoc types with `tsc --checkJs --strict --noUncheckedIndexedAccess`, Prettier, Vitest with ≥ 90 % line coverage per package, CI on every push. The shared config is the `@ss/config` package and every unit is splittable (F.17).

## F.8 Developer CLI (`@ss/cli`, bin `ss`)

- **Templates** live in `packages/cli/templates/`: `shared/` (core, headless, ui, strings, schemas, unit tests) overlaid by `service/` or `pack/`; placeholders `{{slug}}`, `{{name}}`, `{{namespace}}`, `{{sdkVersion}}`. The sample element is `notes`. Generated projects pass `ss app validate` and their own Vitest suites with the coverage thresholds (F.17).
- **Conventions enforced by `ss app validate`:** strings are flat keys used through `t('key')` with `{placeholder}`s; `strings/<lang>.json` must match `strings/en.json` placeholders; Mode A renderers receive the DOM as `render({ state, actions, strings, theme, slots, dom })` (no DOM globals anywhere in `core/` or `headless/`); `ui/tokens.*` is the only place colour literals may appear; product event data schemas live at `schemas/events/<type@v>.json`; import policy `core → core`, `headless → core` (+ `@ss/web/element`), `ui → headless`, `api → core|adapters`, `adapters → core`, `jobs → core|adapters`.
- **Portal emulator (`ss dev`)** implements the F.9 wire formats exactly, defaults to `http://localhost:4400`, reads `ss.dev.json`, keeps state in memory (`--state` persists it), and exposes a loopback-only admin API (`/_dev/*`, token in `.ss/dev-session.json`). Products connect with `ss dev connect --url <product> --secret <CONNECT_SECRET>` (the emulator calls the product's `POST /.well-known/ss-connect`). Launch URLs point at the product's standard `GET /sso?launch=`. Portal → product calls (`/v1/data:export|anonymize`) are signed with `signRequest` (audience = appId). Admin changes are pushed as control events (`entitlement.changed@1` with the document, `key.revoked@1`, `resource.changed@1`, `subscription.activated|paused|resumed|cancelled@1`). Entitlement documents live 10 min; the client database comes from `--mongo-uri`/`DEV_MONGODB_URI` or a lazily started MongoMemoryServer (one database per merchant).
- **Certification (`ss certify`)** runs its own emulator on the product's pinned Portal URL (so `ss dev` must be stopped) and needs a fresh, unconnected product process, which it connects itself with the product's `CONNECT_SECRET` (`--secret`, env or `.env.local`; checks `connection.rejects-wrong-secret`, `connection.connect`, `connection.reconnect`). Launches are exchanged at `/sso` and read back from the product's `GET /v1/session` when present. The data-guard and event-effects checks use app-kit's dev probes (`createProduct({ devProbes: true })`, never mounted in production). Control events must take effect immediately (revoked key → 401; element off → 403, on → 200). The service template ships `serve.js` (plain node:http over `createRequestHandler`), and the CLI test suite certifies a freshly generated product with the real kit: 47/47 checks. Key checks (F.14): every documented resource `GET` answers a `pk_` key from the bound domain with 200 or a 401/403 problem, the same on a repeat; a `GET` marked `x-ss-key-kind: "sk"` in `openapi.json` must refuse `pk_`; the event checks use the first deliverable consumed type (a glob maps to a catalogued or `custom.ss_probe@1` type).

## F.9 Product kit (`@ss/app-kit`) and product ↔ Portal wire formats

- **Sessions:** a launch is single-use, so products exchange it at `GET /sso?launch=` for an opaque HttpOnly `ss_session` cookie in the product's own control store; `auth: 'launch'` routes use that session. Impersonation sessions end at `impExp`.
- **Portal → product requests** are signed over `ss-request.v1.${ts}.${METHOD}.${audience=appId}.${canonicalPath}.${sha256(body)}` (`@ss/protocol` `signRequest`/`verifyRequest`), distinct from event signatures (`ss-event.v1.`), so a signed call cannot be replayed to another endpoint, method or product. Canonical path: WHATWG dot-segment resolution, upper-case percent escapes, unreserved escapes decoded, query params sorted by name then value; trailing slash significant. Body-only event signatures are used only for the declared events endpoint.
- **Portal JWKS is persisted** in the product's control store (last good copy) so cold serverless instances can verify during Portal outages; serving remains bounded by `validUntil` + grace and revocation staleness.
- **Revocations fail closed:** if not synced for longer than the offline grace (or never synced while the Portal is down), website keys are refused with 503. Every sync merges revocations stored by other instances.
- **Tenant guard** on client-owned data: `websiteId` equality required (no `$in`), `$where` and cross-collection stages (`$lookup`, `$unionWith`, `$out`, `$merge`, incl. inside `$facet`) blocked; inserts are stamped with `websiteId`, `merchantId`, `env`.
- **Collection prefix** is derived from the manifest slug (`ss_<slug with - → _>_`) and must equal the signed document's `dataScope.prefix`; a mismatch refuses service.
- Audit entries go to the merchant's database (`ss_<slug>_audit`) unless an audit sink is configured. Connection pools are process-wide per descriptor.
- **Wire formats (Portal must implement exactly):**
   - `GET /v1/product/entitlements?websiteId=` → `{ document }` (compact JWS).
   - `GET /v1/product/revocations?since=` → `{ keyIds: [], cursor }`.
   - `POST /v1/product/usage` with `Idempotency-Key` header, body `{ records: [{ websiteId, subscriptionId, unit, quantity, idempotencyKey, occurredAt }] }` → `{ results: [{ idempotencyKey, status: accepted|duplicate|rejected, reason? }] }`.
   - `POST /v1/product/launch/consume` `{ jti }` → `{ consumed: boolean }`.
   - `POST /v1/product/resources/resolve` `{ websiteId, kind }` → `{ kind, descriptor, expiresAt }` where descriptor is: database `{ uri, dbName? }`; storage `{ bucket, region, accessKeyId, secretAccessKey, sessionToken?, endpoint?, forcePathStyle?, prefix? }`; ai / messaging `{ baseUrl, apiKey, provider?, model?, authScheme?, authHeader?, headers?, paths? }`; payments (interface only in v1).
   - `POST /v1/product/heartbeat` `{ version, status, queues? }`; `POST /v1/product/keys/rotate` `{ publicJwk }`; `POST /v1/product/events` (envelope batch).
   - Client-assertion audience and launch issuer = canonical pinned Portal URL.

## F.10 Outbound networking (`@ss/net`)

- There is one SSRF guard for the Portal and the products. `checkUrl` runs before DNS: https only, no userinfo, ports 443/8443, public IP literals, no internal names and no numeric IP spellings. `guardedLookup` runs at connect time: every DNS answer is classified, one refused answer refuses the name, and the socket is pinned to the vetted answers. It is also passed as the MongoDB driver's `lookup`.
- `safeFetch` follows redirects only for GET/HEAD, only to the same origin by default, at most 3 times. One deadline covers the whole call, there is a body cap, and errors are typed (`bad_url`, `ssrf_blocked`, `timeout`, `too_large`, `redirect_refused`, `aborted`, `network`).
- The development allowlist (`allowHosts`) admits exact hosts or IPs. These may be private and may use http. Callers enable the allowlist only outside production; app-kit ignores it when `nodeEnv === 'production'`.
- AWS SigV4 (`signV4` / `presignV4`) lives here and is verified against the AWS vectors.

## F.11 Portal modules (`platform/src/modules/*`; contracts in `INTERFACES.md`)

- **One composition root, isolated modules:** each module owns its collections (`defineCollection`), reaches others only through `ctx.service(name)`, and plugs into infra through routes, jobs, on-demand operations and single-provider ports (`sessionActor`, `appKeys`, `websiteKeyRevoked`, `productCalled`). Merchant-owned records are `tenant: 'merchant'` (every filter pins `merchantId`); ledgers, audit, notes and events are append-only. No client data in Portal collections.
- **identity:** accounts (scrypt, mandatory staff TOTP, login throttle), merchants, teams (merchant roles + website-scoped grants), websites (global domain claims, test twin, 30-day cooldown, staff transfer), website keys (dedicated signer, `sk_` stored as HMAC, revocation list), staff impersonation (one-time token bound to the staff member → merchant session with `via`, ≤ 60 min, audited on both chains), merchant search (`q`: name prefix or member e-mail prefix), append-only staff notes, and **identity issuers** (F.14).
- **catalog:** shared-secret connect (HMAC both ways, pinned URLs and keys), signed manifest refresh (unsigned/invalid → `rejected` version, alerted), manifest diff + staff review, lifecycle, environments (production/staging bases — the delivery target), app keys, launches (admin app-wide needs a superadmin/admin role), merchant "Try demo" (`demo` launch, no scope, listed apps only).
- **commerce:** subscriptions (≥ 1 h of credits, pinned price book, one-time trial credit), element switches, signed documents (version bumps only on a content-hash change; the hash covers the identity section), usage, hash-chained ledger in transactions, settlement on read (F.19), on-demand reconciliation, spend caps; asks delivery to recompile on every version bump or cancellation.
- **config:** immutable override versions per target with compare-and-set materialisation, locks, rollback, templates, scheduled changes, experiments, dry-run previews; values validated against the pinned manifest's feature schemas; commerce resolves precedence.
- **integration:** Event Hub with header and beacon body auth, dedupe on `(websiteId, idempotencyKey)`, fan-out at ingest (payload only inside sealed jobs, DLQ ≤ 7 days, replay), product and control events, delivery to the app's registered environment (F.14), delivery logs and metrics.
- **connectors:** merchant credentials sealed with per-connector AAD, never returned (masked previews), checks with least-privilege rules, rotation with 24 h rollback, `resolve` only for subscribed products whose manifest requires the kind (audited, ≤ 15 min).
- **delivery:** see F.13.

## F.12 Consoles

- **Merchant Console** (`/` — `app/(console)` over `src/console`) and **Admin Console** (`/admin` — `app/(admin)` over `src/console/admin`): Next.js App Router pages are thin adapters; every read and action is a public `/v1/*` call (server components call `portal.handle` in-process with the request's cookies, browsers `fetch` the same routes). Pages have loading, empty and error states; destructive actions use typed confirmation; navigation is filtered by RBAC.
- Website pages share one header with the live/test twin switch and tabs: Overview, Products, Usage & spend, Keys, Resources, Deliveries, **Identity** (the website's identity issuer, F.14). Staff impersonation shows a banner on every page.
- UI comes only from `@ss/ui` (tokens, forms generated from feature schemas, tables, dialogs); no inline business rules in views beyond form mapping.

## F.13 Delivery plane (`delivery` module)

- **Artefacts** (our software, platform asset storage, never client data): pack assets `packs/<appId>/<version>/<path>` (bytes must equal the signed descriptor's sha256 and size; js/mjs/css/json/svg/png/woff2 with per-type caps); website bundles `w/<websiteId>/<env>/<version>/loader.js` + `manifest.json` (`ss-website-bundle@1`: sri sha384, sha256, sizes, budget report, CSP sources, elements, warnings). `version` = first 16 hex of SHA-256 of the bundle (deterministic); the alias flips by compare-and-set on the compile request counter, so bursts coalesce and an older compile never wins.
- **Serving:** `/w/<websiteId>/loader.js` (alias, 60 s + stale-while-revalidate), `/w/<websiteId>/<version>/…` and `/w/packs/…` immutable; one `pk_` key per website (`events.write elements.read`) issued by the system actor.
- **Budgets:** Loader gzip + Σ element `budget.js` + Σ product `budget.shared` (F.18) ≤ the website budget (a fixed 60 KB) and no element may ship more gzip bytes than it declares (measured as F.18 describes); a refusal (`delivery_budget_exceeded`, offenders listed) keeps the current alias.
- **Service-product elements** run through the product's signed UI bundle when it has one (F.16), else the element stub `ss-element-stub@1` (now `@2`, F.16; no product code in the bundle): the stub calls `GET <base>/v1/elements/<key>/view` and `POST …/actions/<action>` with the website's `pk_` (+ `SS-Identity` when federated); view models are text only (`title ≤ 200, body ≤ 2000, items ≤ 50, actions ≤ 10`), rendered with the Loader's safe `h()` and design tokens; it emits `<key>.action@1` and exposes `refresh()` / `invoke()`.
- **Preview proxy** (`/p/<token>/<path>`, signed 10-minute sessions): fetches the merchant's public page via `@ss/net` (website origin only, GET, no cookies, HTML ≤ 2 MB), injects the candidate bundle and a ribbon, stores nothing. **Trade-off:** it is served from the Portal origin, so it must be `CSP: sandbox` (opaque origin, no Portal cookies) and the merchant's own scripts do not run — previews are faithful for layout and our elements, not for site behaviour. (A dedicated preview origin was implemented in F.16 and later dropped for simplicity.)

## F.14 First-product learnings (Loyalty)

- **Bring-your-own customer identity (PLAN §5.3):** per website the merchant registers its login's issuer (`{ issuer, jwksUrl | publicJwks[], audience?, claimMap: { subject, email?, phone? } }`; console Website → Identity). The Portal validates it (public signature keys only, Ed25519 / P-256 / RSA ≥ 2048, ≤ 5), fetches a JWKS URL through `@ss/net` (cached, refreshed ≤ hourly, last good keys kept on failure) and puts an optional `identity` section `{ issuer, jwks (inline), audience?, claimMap }` in every signed entitlement document of the website. app-kit `identity.verify(request, { doc, body })` reads `SS-Identity` (or the beacon body `identity`), verifies the JWT offline (EdDSA/ES256/RS256 matched to the key type; no `none`/HMAC/header keys/`crit`; `iss`, `aud` when configured, `exp` required, `nbf`, `iat` required and ≤ 24 h old, 60 s skew) and returns `{ subject, email?, phone?, issuer }`. Route option `identity: 'required' | 'optional'` fills `ctx.identity` (`required` → 401 `identity_required` / `identity_invalid`; `optional` leaves it null with `ctx.identityProblem`). CORS allows `SS-Identity`. Loyalty uses the kit identity and keeps its wallet tokens as the fallback.
- **Richer order events (additive v1):** `order.completed@1`, `order.cancelled@1`, `order.refunded@1` (and `order.placed@1`) accept an optional `customer` identity reference `{ customerId?, subject?, email?, phone? }`; completed/cancelled accept `number`, `customerId`, `currency`, `lines`, `amounts` like `order.placed@1` (`lines`/`amounts` require `currency`); refunded lines gain optional `sku`, `title`, `unitAmount`, `totalAmount` and an optional `amounts` (in `amount.currency`). Loyalty settles a completion that carries its own context.
- **Glob consumes:** `events.consumes` may list globs (`custom.*`, `order.*@1`; a version-less glob matches every version), each covered by an `events.subscribe:` glob; fan-out, the CLI emulator and certification honour them. Loyalty consumes `custom.*` (same earn rules and idempotency as `POST /v1/activities`).
- **Delivery target:** events go to the app's registered environment base (production; staging for `test` websites when registered) + `endpoints.events`, never the manifest's own `endpoints.base`; http only for `OUTBOUND_DEV_ALLOW_HOSTS` outside production.
- **CLI template:** the product singleton is cached on `globalThis` (route handlers and pages are bundled separately in Next.js); `headless/` may import `@ss/web/element` (no other `@ss/web` entry); certification no longer requires the first resource `GET` to be 200 for `pk_` (see F.8).
- **app-kit:** `entitlements.invalidate(websiteId)` forces a Portal fetch on the next read (the cached copy stays as the offline fallback).
- **ESLint** parses ES2025 everywhere (JSON import attributes); no products-only override.
- **Event catalogue:** `<element>.shown@1` (`{ variant? }`), `<element>.action@1` (`{ action, ok? }`) and `loader.element_failed@1` (`{ element, phase?, code, message }`) are catalogued (`ELEMENT_EVENT_DATA`, `LOADER_EVENT_DATA`); other `<element>.<verb>@1` UI events stay size-capped objects. Problem codes `identity_required` and `identity_invalid` are standard.

## F.15 Post-launch kit changes (after the six products)

- **Idempotency privacy (app-kit):** the control store keeps only `{ HMAC key, HMAC fingerprint, status, allowlisted headers, replay: empty|website|none }` (HMAC key derived from the product signing key). Replay bodies live in the merchant's database (`ss_<slug>_idempotency`, unique `(websiteId, key)`, TTL 24 h) via `data.forWebsite`; routes without a website store no body and a replay answers 409 `idempotency_replay_no_body` (never a second run).
- **Cold start:** `keys.verify` awaits the single in-flight revocation sync; concurrent first requests no longer answer 503.
- **Queue delivery:** usage queue and event outbox are sent after requests (superseded by F.19: no timers, no every-Nth-request flush; only the request's own website and what the instance queued). Product crons are not needed for delivery.
- **Durable event outbox:** `portal.publishEvent` writes the envelope to `ss_kit_event_outbox` (id derived from `(websiteId, type, idempotencyKey)`, idempotent), sends at once, retries with backoff, dead-letters Portal `rejected` results / permanent 4xx (7 days); the envelope is dropped once sent. Heartbeat queues gain `eventsPending`/`eventsDead`. Portal `POST /v1/product/events` per-event results (`{ id, status }`) are honoured.
- **Routes:** `rateLimit.limit` may be a (sync/async) function of `ctx`, evaluated after auth, entitlement, JSON body and identity (`Infinity` = no limit, `0` = refuse); `bucket` shares one window between routes. `problem(code, detail, { extensions })` adds RFC 9457 extension members (validated names; standard members and `requestId`/`errors` cannot be redefined). `paginate` accepts compound keyset keys (`keyOf` returns an array, encoded opaquely; `after` is the array). Next routes export `OPTIONS`.
- **`product.outbound.fetch(url, init)`:** the SSRF-guarded `@ss/net` fetch under the product policy, for merchant-chosen URLs (chatbot knowledge pages and webhook tools).
- **Connectors:** built-ins keyed as the Portal resolves them — messaging `generic-http` (alias `http`) and `smtp` (nodemailer, TLS ≥ 1.2 required outside allowlisted dev hosts, host vetted, every send dials an IP from `resolveVetted` with SNI, connect/greeting/socket timeouts). Storage keys are always relative in and out (`fullKey()` for the object key); `presignPut({ key, contentType, contentLength })` signs `content-length` so the bucket enforces the size.
- **Identity:** `identity.verify` returns `{ subject, email?, phone?, issuer, claims }`, `claims` = the full verified payload (deep-frozen).
- **Contracts:** entitlement document `website { timeZone?, language?, currency? }` (Portal fills it; `toDocument` meta `website`); product-level `requires.resources` = always required, element-level kinds gate only their element (`undeclaredResource` retired); standard `item.created|updated|deleted@1` and richer optional `inventory.changed@1` / `price.changed@1`; envelope `context.keyKind?: pk|sk` set only by the Event Hub on delivery (stripped on ingest); website-event actor rule `pk_` → customer|anonymous, `sk_` → anything but product|system (`actorAllowedForKeyKind`). Web SDK: `item.created|updated|deleted` are `necessary`.
- **CLI:** emulator samples for every catalogued event (`sampleFromSchema` + hand-tuned); `ss certify` uses the OpenAPI path marked `x-ss-certify: true` (check `certify.target`), else the first Mode C resource; `ss app init --minimal` generates a service without the notes sample (placeholder element `status`); template routes export `OPTIONS` and pass `after`.
- **Products adopted:** chatbot (dynamic message rate, `outbound.fetch`), deals (shared dynamic quote bucket), signups (`attemptsRemaining` / `retryAfterSeconds` extensions; kit messaging), alerts (kit messaging, `identity.claims` tier, `x-ss-certify`), reviews (signed `content-length`, relative keys); manifests keep only `database` at product level; job crons no longer flush usage.

## F.16 Post-launch Portal changes (from the six new products' platform gaps)

- **Website settings:** websites carry optional `timeZone` (IANA, `Intl`-checked, canonical), `language` (BCP 47) and `currency` (ISO 4217), set for the live/test pair in Website → Overview → Website settings (merchant) or the Admin Console website lookup (staff) through `PATCH /v1/merchants/:m/websites/:w`. Commerce puts the set values in every document's `website` section (via `toDocument` meta) and in the content hash; quota periods use the website time zone.
- **Resources:** product-level `requires.resources` are always required; element-level kinds gate only their element. Commerce stores per-subscription `needs` with each resolution (`resourceNeeds(websiteId)`); connectors `resolve` refuses an element-level kind while every requiring element is off (`element_off`); the console Resources page shows "needed now" vs "needed if you enable …".
- **Event provenance:** the Event Hub strips producer-supplied `context.keyKind`, stamps the verified `pk`/`sk` on ingest (`KEY_KINDS`) and checks actors with `actorAllowedForKeyKind`; product-published events carry no key kind and are marked `context.source: 'product'` + `context.product`.
- **Product-requested identity issuer:** `PUT /v1/product/websites/:websiteId/identity` (product auth, active subscription, manifest `capabilities.identityIssuer: true`) stores a **pending** request; the merchant is notified (mail + console banner + Website → Identity) and approves or rejects; approval makes it the active issuer with `managedBy` the product. Identical requests are idempotent (`active`), so Signups can call it on every start.
- **Key scope vocabulary:** `elements.read`, `events.write`, `<product>.read|write` per listed service product, `<group>.*`; empty = `['elements.read','events.write']`; validated on every issue; the console key form shows checkboxes per product (`GET …/keys/scopes`).
- **Service UI bundles + stub v2:** service products upload their own signed `ss-pack-bundle@1` UI bundle (`POST /v1/product/ui-bundles`, `PUT /v1/product/ui-bundles/:version/assets/*`, signed with a registered product key); once complete it replaces the element stub (Mode A with the product's real headless + renderer, served from `/w/ui/…`). The stub is `ss-element-stub@2`: page context `?ctx=` (`path`, `itemId`, `pageType` from `data-ss-*`) and input `fields` posted with actions; v1 data still runs.
- **Dedicated preview origin:** dropped (F.19 simplification): previews are served from the Portal's own origin under `CSP: sandbox` (opaque origin, scripts by nonce only).
- **Tests:** the test `mongod` runs with the TTL monitor off — documents expire by the injected clock, never by wall time (a TTL pass deleted impersonation tokens whose injected expiry lay in the real past).
- **SMTP descriptors:** implicit TLS only on port 465; other ports STARTTLS.

## F.17 Repository layout: splittable units

- **Units.** `platform/` (the Portal), each `products/*` and each `packages/*` is a unit: built and checked as if it were a repository of its own. The owner keeps one repository for now; splitting a unit later needs no code change beyond replacing `workspace:^` ranges with published versions (`pnpm publish` rewrites them for packages). Acceptance test per unit: copy the folder alone into a fresh repository, depend on the other `@ss/*` packages as published packages, and `pnpm install && pnpm check` (plus `pnpm build` for deployables) pass.
- **No path imports between units.** A unit depends on another only as a package listed in its own `package.json` (`workspace:^`). Cross-unit test helpers are public entries: `@ss/contracts/testing` (fixtures), `@ss/ui/testing` (DOM helpers), the `@ss/cli` API (`runCertification`, `validateProject`, `createDatabaseResolver`), `@ss/web` subpaths for the delivery runtime, `@ss/platform/testing` (the Portal for system tests: `createPortal`, the module list and factories, `loadConfig`, `totpCode`, `closeMongoClients`) and each product's `./serve` (`startServer`, `loadManifest`, `ROOT`). Deep imports of another unit's internals are not allowed; a missing need is added to one of these entries.
- **Shared tooling: `@ss/config`.** `@ss/config/eslint` (functional rules + JSX variant), `tsconfig.base.json`, `prettier.json`, `@ss/config/vitest` (`defineUnitConfig({ dir, include, coverageInclude, coverageExclude, jsx, mongo })`, thresholds 90 / 90 / 85) and `@ss/config/mongo-setup` (one MongoMemoryReplSet per run, TTL monitor off, reference-counted across Vitest projects). Each unit has thin `eslint.config.js`, `tsconfig.json`, `vitest.config.js` and a `prettier` key built from it, with its own coverage scope; the thresholds hold for each unit on its own.
- **Every unit is self-sufficient.** Scripts `check` (format:check → lint → typecheck → test with coverage), `test`, `lint`, `typecheck`, `format`, `format:check`; deployables add `dev`/`build`/`start` (products also `portal`, `validate`, `certify`; the Portal adds `runtime:check` to its `check`). Own README, `.gitignore`, `.prettierignore`; deployables keep `.env.example` and `vercel.json`, are `"private": true` and `"license": "UNLICENSED"`. Packages carry `version`, `exports` (with `./package.json`), `files`, `engines` and `publishConfig` (`access: restricted`, not `private`, so they can be published to the team registry). They publish their JavaScript as written plus `.d.ts` declarations generated from the JSDoc at pack time (`prepack` → `build:types`, `tsconfig.types.json`, output `types/`, git-ignored); `publishConfig.exports` adds the `types` condition to every entry, so a split consumer type-checks against the published packages exactly as the monorepo does against the sources. Package indexes re-export type-bearing modules with `export *` (contracts `types.js`, protocol `keys`/`launch`/`events`/`requests`, net `policy`) so declarations name types through the package entry, never a deep path.
- **System tests: `e2e/` (`@ss/e2e`, private).** Tests needing two or more deployables (each product against the real Portal; Signups + Loyalty identity) live there, not in a unit. They depend on `@ss/platform` and the product packages; products keep their own `certify.test.js` through `@ss/cli`.
- **The root only orchestrates.** `pnpm check` (root files' format, then every unit's `check` in turn), `pnpm test|lint|typecheck|format|format:check` (`pnpm -r`), `pnpm --filter <unit> <script>`, and `pnpm test:all` (Vitest projects: every unit's own config in one run, one shared MongoDB). No root ESLint, TypeScript or Prettier config. CI installs once, then checks each unit in a matrix (`check`, plus `build` for deployables and `ss app validate` for products), runs the e2e workspace and `pnpm audit --prod --audit-level high`.
- **Enforced.** `ss app validate` reports `imports.outside` for any import (every code file, `tests/` and `app/` included) or stylesheet `@import` / `@source` that leaves the product folder, and checks the package wiring (`package.dependency`, `package.devDependency` for `@ss/cli` and `@ss/config`, `package.script` for the scripts above). `ss app init` generates the same shape (config from `@ss/config`, Vitest tests with the thresholds, `@ss/*` at `workspace:^` by default); outside a pnpm workspace it adds `pnpm-workspace.yaml` (allowed build scripts) and `.nvmrc`.

## F.18 Wave-1 platform changes (from the first product wave's platform and tooling gaps)

Every change is additive: existing manifests, bundles, documents and products keep working (migrations noted).
Still later (unchanged, not started): server-rendered hosted pages (§4.3), Edge Injection (§4.2) and usage metering
for packs.

- **Honest bundle budgets.** One measurement for the CLI and the Portal: `@ss/contracts/budget` (Node only)
  `measureBundle({ elements, read, gzip? })` over the **minified, bundled** browser modules (gzip level 9; KB rounded up
  to 0.1). An element's own size is the gzip of its entry modules (headless + renderer); a module that several elements
  name and every chunk reachable through relative imports is **shared** and counted once. `ss app validate` builds the
  elements exactly like `ss pack build` and warns `budget.estimate` (an element ships more than `budget.js`),
  `budget.padded` (a declaration above the measurement rounded up plus a quarter, ≥ 1 KB), `budget.shared` (shared
  chunks undeclared or above `budget.shared`) and `budget.build` (cannot bundle). Every product re-declared its budgets
  from the measurement (≈ ceil(measured × 1.1)); the CLI templates too. Service-product elements delivered through the
  element stub ship no product code, so they take **0 KB** of the website budget (their `budget.js` applies to their UI
  bundle).
- **Website budget (fixed 60 KB, unchanged).** Before, declarations were unminified source
  closures — 2–5× the real gzip — so the 60 KB ceiling held perhaps 20 KB of real element code next to the ≈ 13–15 KB
  Loader. Measured honestly, the same 60 KB now admits ≈ 45 KB of real gzip element code (≈ 35 KB with the audience
  evaluator), which is what a third-party embed should cost at most: about a third of a ~170 KB mobile JS budget, as a
  worst case, since modules load lazily only on pages whose placement matches. A full Storefront (≈ 44 KB declared with its
  shared chunks) plus a full PDP (≈ 37 KB) together exceed it on purpose; a deployment may raise the limit.
- **Shared chunks.** Product-level manifest `budget: { shared }` (KB gzip). The compiler measures, per product, the
  shared modules the delivered elements load and checks: loader + Σ `budget.js` + Σ `budget.shared` (the measured
  size where none is declared, with a `shared_undeclared` warning — so older packs still compile) ≤ the website budget,
  and measured shared ≤ declared (`shared_over_declared`, refused). `manifest.json` reports `budget.sharedKb` and
  `budget.shared[]` (slug, declared, measured, modules) and each element's measured `gzipBytes`.
- **`placement` feature kind.** `x-kind: 'placement'` on a top-level `type: 'object'` feature without `properties`:
  values are validated against the full placement v1 schema (every member: paths, selectors, page types, devices,
  referrers, schedule, consent, triggers, frequency incl. cooldown and dismissMemory, audience) plus its semantic
  checks. `x-placement.members` narrows what an element supports; the plan bound is `x-plan.<plan>.members` (a value
  setting another member exceeds the plan → `plan_max`, the lower layer applies). Contracts (`PLACEMENT_MEMBERS`,
  meta-schema, `validateFeatureConfig`), entitlements (`kind: 'placement'`, member bounds) and `@ss/ui` (`placement`
  widget: structured editor per member + JSON) implement it; the merchant console's Configure tab shows it. PDP and
  Storefront declare their `placement` features with it.
- **Element ids namespaced per product.** Compiled elements carry `product` (slug); the Loader id is
  `<product>:<key>`, so two products may deliver the same key (Storefront and Deals `deals_page`). `SS.elements.get`
  takes the id or, when only one element has it, the bare key; `list()` adds `id` / `product`; element events reach
  `SS.on` as `<key>.<verb>` and `<product>:<key>.<verb>` (the Event Hub keeps `<key>.<verb>`); containers keep
  `data-ss-element="<key>"` and add `data-ss-product` / `data-ss-id`; frequency caps stay keyed by key while unique
  (no reset for existing visitors). The compiler's `conflict` refusal now means one product delivering an id twice.
- **Pack read clients.** Manifest `reads: ['catalog', { product: 'search', scopes: ['search.read'] }]` (default
  scope `<product>.read`). For each read product with an active subscription on the website (https base) the compiler
  adds `reads: { <slug>: <base> }` to the pack's elements and the read scopes to the website's loader `pk_` key
  (re-issued when a scope is missing; the superseded key stays active for cached bundles). The Loader passes
  `clients[<slug>]` (an `@ss/web` element API client bound to that base and the `pk_`) to the element; inactive
  products give no client and a `reads_inactive` warning. Storefront dropped its pasted `source_key`: `api` sources
  read through these clients; public-JSON and page sources stay.
- **Validate scans sources.** Build output is never scanned (`dist/`, `.ss-pack-out/` ignored; packs no longer commit
  bundles); Storefront and PDP ship minified bundles from `ss pack build`. Elements reading the product catalogs are
  checked for their slice (`strings.slice`: a rendered key outside the element's `stringKeys` and every sibling's).
- **Per-language strings.** Products keep `strings/<lang>.json`; element `stringKeys` (exact keys or `prefix*`, default
  `<key>.*`) slices them at compile time. The compiler picks the website's language (`website.language`, also in the
  entitlement document) with fallback chain `en` → `de` → `de-CH`; an element naming a non-language file in `strings`
  keeps the legacy whole-file catalog. Merchants override texts per website, element and language (`*` = every
  language): `GET|PUT /v1/merchants/:m/websites/:w/delivery/strings[/:appId/:element/:language]` (collection
  `delivery_strings`, audited `delivery.strings_updated`, recompiles), console Subscription → Texts. Storefront's and
  PDP's generated `strings/<element>.en.json` are gone.
- **`ss pack build | publish`.** `build` bundles every manifest module ref with esbuild (minified ESM, browser,
  code-split `chunks/`), adds the catalogs, hashes everything and writes `dist/pack/descriptor.json` + assets;
  `publish` signs with `signBundle` and uploads to `POST /v1/admin/packs` + `PUT …/assets/*` (optional `--activate`)
  with a **staff API token**: `POST /v1/admin/api-tokens` (`platform.apps.manage`, ≤ 12 h) mints `sst_<token>`, a
  staff session flagged `api` accepted only as `Authorization: Bearer sst_…` (never as a cookie, no CSRF), listed and
  revocable under `/v1/me/sessions`, unable to mint tokens. Programmatic API `@ss/cli/pack`. PDP and Storefront
  `pack.js` are thin wrappers over it.
- **Optional element resources.** Element `requires.optionalResources`: never `resource_missing`; commerce lists them in
  `resourceNeeds` (`optional: true`, needed while a using element is on), connectors resolve them, consoles show "can
  use". The kit reports the connection: `entitlements.resource(doc, kind) → { status, connected }`. Catalog folded
  `media_uploads` into `media` (storage optional; uploads answer `409 storage_not_connected` without it; its four
  settings are `media` features; plans and the price moved with it — uploads are now part of `media`).
- **Kit:** `sweepStaleUploads` (delete objects of expired presigned uploads per website, bounded, idempotent), used by
  the Grades and Reviews products on the next upload and from a dashboard button (F.19).
- **Products:** Storefront maps Catalog's real `GET /v1/items` (brand object, `collectionIds`, variant `options`,
  `availability` / `purchasable`, `nextCursor`, no badges or rank); Grades serves the stub's
  `POST /v1/elements/<key>/actions/*`; Catalog's SKU uniqueness is race-free (unique partial index on normalised
  `skuKeys` while the setting is on, lazy backfill) and its CSV export uses short-lived signed download links.

## F.19 Event-driven only: no scheduled or background processing

The Portal and every service product run on **Vercel Hobby** with one **MongoDB Atlas M0** cluster, for $0 (a paid host
needs no code change; Vercel's Hobby terms are for non-commercial use). The binding rule: **nothing runs unless
something happens.** There are no crons, no timers, no polling, no periodic or throttled background loops and no queue
drains on a timer. Work happens inside, or right after (`after()`), the request that caused it, and only for the item
that request created or touched. Running nothing costs nothing.

- **No crons anywhere.** No `vercel.json` has `crons`; `ss app validate` refuses any (`vercel.crons`). There is no
  `CRON_SECRET` and no cron route.
- **Portal.** Every request runs in a request scope (`infra/request-scope.js`); `afterResponse(task)` hands work to the
  end of that request. A job a request enqueued runs right after its response, and only that job.
   - **Event Hub:** the ingested event is delivered right after the request. A failed delivery stays queued with its
     next-attempt time and is retried when there is a natural reason: the next delivery to the same product and the
     next time that product calls the Portal (entitlements, usage, heartbeat, any product API; port `productCalled`),
     only that product's due deliveries, a few at a time. Dead-letter rules are kept (attempts spanning ~24 h of
     backoff, or an event older than that window) and staff have "Retry deliveries now" per product.
   - **Mail** is sent inside the request that needs it (no queue).
   - **Billing is computed when read:** charges per started hour settle (idempotent by `periodKey`) before a merchant's
     balance, meter or statement is read (merchant console, admin views), when a product fetches an entitlement
     document or reports usage for one of its websites, and before a subscription change. Spend limits and low-balance
     holds are evaluated at the same moments, so the document a product fetches reflects a hold. A product holding a
     still-valid offline document (10 minutes, plus its cache) may keep serving until it next refreshes it.
   - **Time-based state on read:** scheduled configuration changes apply on the first read of the merchant's
     configuration at or after their time; a rotated key's revocation takes effect by time in the revocation list; a
     deprecated app retires the first time it is read after its sunset; a failed website compile retries when its
     loader is next served.
   - **Connectors** are checked when saved or resolved (if the last check is older than 50 minutes), plus "Test" for
     merchants.
   - **No admin operations or Run buttons:** settlement only on read, connectors on save/resolve, manifests refreshed
     per app by staff, audit chains verified per scope from the audit log. Never on a timer.
- **Products.** app-kit sends the usage and events a request produced right after it; a failed send retries on the
  next request of that product for that website. `product.background.every` and the leases store no longer exist.
  Expiry is judged on read (holds, COD orders, coupon reservations, price locks, loyalty points, alert subscriptions,
  chatbot snoozes, review requests, signup cooling-off); actual cleanup happens when the row is touched, and data
  that can simply disappear uses MongoDB TTL indexes. Work that must be initiated without a customer request is
  triggered by the event that makes it relevant (alerts dispatch on back-in-stock / price-drop events, a search page
  re-crawl on `item.*`, review requests on `order.completed@1` — a delayed send would need a timer, so requests are
  sent on completion) or is a merchant dashboard button ("Crawl now", "Send due now", "Process expired now", …).
- **Connection budget.** One database and one database user per deployable on the one cluster. Mongo clients are
  created once per instance and cached on `globalThis`; pools are small and fixed (Portal 5, products'
  control DB 5, merchant databases 3) and idle merchant pools are closed when the next
  website is served.
- **Templates.** `ss app init` generates `vercel.json` without crons and a `jobs/` folder with only a README; the notes
  sample's soft-deleted notes are removed by a TTL index.
- **Environment and onboarding.** Every deployable runs on any Node 22 host and any domain; nothing reads
  host-specific variables, and the environment holds only database and storage connections (plain strings, neutral
  names). The Portal: `MONGODB_URI`, plus optional `STORAGE_ENDPOINT` / `STORAGE_REGION` (default `auto`) / `STORAGE_BUCKET` /
  `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY` (Cloudflare R2 or any S3-compatible service); its signing keys,
  website-key signing key, encryption key, session secret, key pepper and idempotency secret are generated on first
  start into `platform_system` (insert-if-absent; never shown, no rotation screen). There is no
  setup page and no stored Portal URL: the Portal's address is each request's origin (`Host` plus `X-Forwarded-Proto`
  behind a proxy) — the issuer and audience of the tokens it signs, the base of its links and the CSRF origin; products
  pin it at connect time. While no staff user exists the staff login offers "Choose a password" / "Create admin": the
  visitor becomes the superadmin `admin` (no e-mail; the deployer accepts that the first visitor wins). E-mail, name,
  password and two-factor sign-in (Account → Security) are optional; two-factor is required at sign-in once
  enrolled. Mail is the only admin setting; there is no preview URL setting and no tuning variable (pools, body cap,
  budget and session lifetimes are constants; `X-Forwarded-*` are read as the first hop set them); indexes and migrations apply once per schema version
  under a lock. A product: `MONGODB_URI` and `CONNECT_SECRET` (random, ≥ 32 chars). Staff add it in Admin → Apps → Add product
  (product URL + that secret): the Portal calls the product's `/.well-known/ss-connect` HMAC-signed with the secret
  (never sent, never stored by the Portal); the product generates its key, pins the Portal URL and keys in its control
  database and answers signed the same way; the Portal pins the base URL and key. Product secrets are generated there
  too (`product.secret`). Connecting again with the secret replaces the binding; changing `CONNECT_SECRET` locks the old
  Portal out.
