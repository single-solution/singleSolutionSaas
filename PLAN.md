# Single Solution — binding plan

**Status:** binding for the whole monorepo. Private product — anything may be deleted.  
**This plan wins** over unit READMEs until they are updated.

---

## How to use this plan (read first if you are new)

1. Read **§0 Story** — who does what.
2. Read **§1 Don’t miss** — checklist of every workstream so nothing is forgotten.
3. Read **§2 UI contract** — what Portal screens change (and how much).
4. Before coding a letter (**A–F**), open the audit linked in **§10** and tick that letter’s acceptance list.
5. Never invent peer apps, mode-features, or accordion settings — see **§11 Bans**.

| If you are…                                | Start here                                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| New to the repo                            | §0 → §3 map → §4 architecture → §13 docs index                                               |
| Building Portal UX                         | §2 + `platform/PORTAL-AUDIT.md` → build **A/B**                                              |
| Simplifying a product                      | that product’s `FEATURE-AUDIT.md` → **E** (with **F** on Chat first)                         |
| Changing configure UI                      | `packages/ui/DASHBOARD-AUDIT.md` → **F**                                                     |
| Touching security / login / staff / tokens | **§8 + `platform/SECURITY-AUDIT.md` first** — never invent credentials or skip server denies |

**Implemented yet?** Audits and this plan = **design authority**. Code still has peer apps, old feature keys, and dense Settings until A–F land. Do not treat success criteria as already true in production.

---

## 0. Story (plain)

| Who                         | Job                                                                                                | Never                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **Admin (Owner / Support)** | Connect products **once** to the platform. Help any merchant. Money/ops by role.                   | Give Portal logins to site developers |
| **Merchant**                | Log in → **websites** → put **products** on a site → **Open** configure → **Share with developer** | Invent tokens; need Install ceremony  |
| **Developer / AI**          | **Developer pack** + **Docs hub** → build the storefront                                           | Portal login; monorepo clone          |
| **Finance**                 | Money only                                                                                         | Launch, pack, tokens                  |
| **Site staff**              | Operate on the live site (tickets/widgets)                                                         | Portal; configure launch              |

**Docs** = one **public** Docs hub (all catalog products, even not placed).  
**Portal** = control plane only — not a docs site, not a developer desk.  
**Products** that pass `ss app validate` + connect + place **just work** — no hacks.

Everyday merchant path after A/B:

`Login → Websites → [site] → Add products → Open → Share with developer`

---

## 1. Don’t miss (master checklist)

Every row is planned. Skip none when claiming “done.”

| #   | Workstream                                                    | Where detail lives                | Build                    |
| --- | ------------------------------------------------------------- | --------------------------------- | ------------------------ |
| 1   | Website front-first (kill Install/Usage/Changes peers)        | §2, `platform/PORTAL-AUDIT.md`    | **A1**                   |
| 2   | Developer pack (step-up → one file)                           | §2 pack shape                     | **A2**                   |
| 3   | Merchant can Add/Remove products on own sites                 | §7                                | **A3**                   |
| 4   | Docs link in shells; copy cleanup                             | §2                                | **A4**                   |
| 5   | Step-up = **OTP**, not password again and again               | §8 Step-up                        | **A5**                   |
| 6   | Public Docs hub + pack `docsHubUrl`                           | §5                                | **B**                    |
| 7   | LIVE_OPS / configure≠operate honesty                          | §8, kit/cli                       | **C**                    |
| 8   | Store migration (`ss-import`) after pack exists               | importer READMEs                  | **D**                    |
| 9   | Product feature simplify (all six audited)                    | `products/*/FEATURE-AUDIT.md`     | **E**                    |
| 10  | Configure dashboard calm UX (no accordion)                    | `packages/ui/DASHBOARD-AUDIT.md`  | **F**                    |
| 11  | **Security (login, staff, show/hide, abuse)** — most critical | §8 + `platform/SECURITY-AUDIT.md` | **always + S checklist** |
| 12  | Quality on touched units                                      | §9                                | always                   |

**Sequence you must not scramble**

1. **A (incl. A5 OTP) → B** first (Portal + builders unblocked; step-up not password spam).
2. **E + F together on Chat** (merges without a still-scary Settings wall).
3. Roll **E+F** to other products.
4. **D** only after **A2**.
5. **C** can parallel A/B (no merchant UI).

---

## 2. UI change contract (Portal)

### How much change?

| Area                                                     | Size                   | Meaning                    |
| -------------------------------------------------------- | ---------------------- | -------------------------- |
| Sidebars                                                 | **Small**              | Same items + Docs out-link |
| Overview / Credits / Account / admin Merchants·Billing·… | **None–small**         | Keep                       |
| Admin Products                                           | **Small**              | Label: global catalog only |
| **Website page** (merchant + admin)                      | **Large**              | Main rebuild               |
| Install / Usage / Changes pages                          | **Removed**            | Redirect                   |
| Setup sheet                                              | **Medium**             | Keep URL; entry from front |
| Share pack                                               | **New**                | Step-up                    |
| Docs hub                                                 | **New**                | Public                     |
| Configure dashboards                                     | **Large later (F)**    | With E                     |
| Site operate widgets                                     | **None** (Portal wave) | Stay on site               |

### Merchant website home AFTER

1. Domain + facts (cost, product count).
2. **Add product** (active catalog).
3. **Share with developer**, **Settings**, **Docs**.
4. Product rows: **Open**, ⋯ Remove.
5. Thin next-action strip if needed.
6. **No** Install/Usage/Changes peer strip.

### Admin

Same website component as merchant. **Products** = connect deployables globally. Finance = money only.

### Developer pack shape

```text
docsHubUrl
domain
products[]: { id, name, docs, openapi, widget, browserToken, serverToken, featuresOn }
```

### Unchanged on purpose (do not “improve” in A/B)

Login/2FA · credits mechanics · admin merchants/billing redesign · operate widgets · module boundaries · typed credentials · step-up for secrets.

---

## 3. Design bars (fail the plan if broken)

| Bar                           | Fail if…                                                       |
| ----------------------------- | -------------------------------------------------------------- |
| Builder-never-Portal          | Builder needs Portal login or Install page                     |
| One docs home                 | Must know six product URLs or place first to learn             |
| Two-level products            | Third scattered “product app” in Portal                        |
| Protocol-true                 | Hacks after validate + connect + place                         |
| Front-first website           | Peer Install/Usage/Changes return; Share/Add in ⋯ only         |
| Same website IA               | Admin website is a different product                           |
| Simple in context             | Mode/chrome/who sold as peer features/pages (§6)               |
| Calm configure                | Accordion / expand-one-field; Settings = micro-feature wall    |
| Secure                        | Pack/launch/reveal without step-up; cross-credential shortcuts |
| No product ids in primary nav | Sidebar grows Chat / Shop / …                                  |

---

## 4. Repository map

| Path                                                                    | Role              | Deployed? |
| ----------------------------------------------------------------------- | ----------------- | --------- |
| `platform/`                                                             | Portal + Docs hub | Yes       |
| `products/accounts\|notifications\|chat\|payments\|ecommerce\|growth`   | Six products      | Yes each  |
| `packages/protocol\|contracts\|app-kit\|ui\|net\|cli\|config\|importer` | Shared / CLI      | Library   |
| `e2e/`                                                                  | System tests      | No        |
| `PLAN.md`                                                               | This document     | —         |

**Ports:** Portal `3000`; Accounts `3001`; Notifications `3002`; Chat `3003`; Payments `3004`; Ecommerce `3005`; Growth `3006`.

**New products:** `ss app init` **outside** this monorepo — never clone this tree to start one.

---

## 5. Architecture

```
PORTAL (login)                    DOCS HUB (public)
websites · placement · credits    all products · guides
Share pack · Open configure       no secrets
        │                                  ▲
        │ protocol                         │ guides from products
        ▼                                  │
PRODUCT ── configure (settings only)
        │
        ▼
OPERATE on merchant site (tickets + widgets)
```

**Credentials:** launch ≠ ticket ≠ browser ≠ server ≠ notice — never cross-authorize.  
**Secrets:** unplaced or catalog-inactive → no connection/settings secrets.  
**Plug-in:** validate → deploy → Owner connects globally → place on website → Share pack → Docs hub.

### Platform modules

`identity` · `catalog` · `commerce` · `website` · `system` — no cross-imports; `ctx.service` only.

### Website routes

| Path                                    | Decision               |
| --------------------------------------- | ---------------------- |
| `/websites/:id`                         | Rebuild front          |
| `/websites/:id/settings/…`              | Keep (long)            |
| `/websites/:id/setup`                   | Keep; entry from front |
| `/websites/:id/install\|usage\|changes` | Redirect away          |
| Docs hub (public)                       | Add                    |
| `/shared-setup`                         | Keep (no secrets)      |

### Env (Portal)

`MONGODB_URI`, `PORTAL_URL`, `ENCRYPTION_KEY`, optional `ENCRYPTION_KEY_PREVIOUS`, `LOG_LEVEL`.

---

## 6. Simplicity + audits (products & configure)

**Test before adding a feature, page, or nav item:**  
_Own capability, or “how Chat / this site works”?_ → Second = **setting** (or rule row), not a peer.

| Smell                            | Put it where        |
| -------------------------------- | ------------------- |
| Who / guest / signed-in / limits | Settings            |
| Chrome (typing, launcher)        | Settings            |
| Three variants of one job        | One feature + rules |
| Install/Usage/Changes            | One website front   |
| Builder docs                     | Docs hub            |

**A feature earns a switch** only if it is a real optional capability (Inbox, AI, gateways, …) — not “guest mode.”

### Audit index (binding input — read before E/F/A)

| Area            | Doc                                       | Counts / notes                      |
| --------------- | ----------------------------------------- | ----------------------------------- |
| Portal surfaces | `platform/PORTAL-AUDIT.md`                | Peer pages → home; pack; Docs       |
| Configure UI    | `packages/ui/DASHBOARD-AUDIT.md`          | Calm capabilities; **no accordion** |
| Chat            | `products/chat/FEATURE-AUDIT.md`          | 44 → ~11–12                         |
| Accounts        | `products/accounts/FEATURE-AUDIT.md`      | 19 → ~9–11 (methods → Sign-in)      |
| Notifications   | `products/notifications/FEATURE-AUDIT.md` | 12 → ~7–8                           |
| Payments        | `products/payments/FEATURE-AUDIT.md`      | 13 → ~12                            |
| Ecommerce       | `products/ecommerce/FEATURE-AUDIT.md`     | 35 → ~18–22                         |
| Growth          | `products/growth/FEATURE-AUDIT.md`        | 15 → ~10–11                         |

Each product audit has **remove → where** tables. Do not merge by memory — follow the file.

### Configure dashboard (F) — must not overlook

- Settings = **capabilities**, not 44 rows.
- Prices = **capability** grain (Owner).
- Fields: **all visible** in open sections.
- **Banned:** accordion / click-to-expand one field.
- Long lists = **full sub-page**, not a fold.

---

## 7. People & sessions

| Person          | Portal?      | Gets                                        |
| --------------- | ------------ | ------------------------------------------- |
| Owner / Support | Yes `/admin` | Catalog + any website                       |
| Finance         | Yes          | Money only                                  |
| Merchant        | Yes          | Own sites, **Add product**, Open, **Share** |
| Developer / AI  | **No**       | Pack + Docs hub                             |
| Site staff      | No           | Tickets on site                             |
| Migration op    | No           | `ss-import` + env                           |

| Session            | Configure              | Live records                   |
| ------------------ | ---------------------- | ------------------------------ |
| Portal cookie      | After launch + step-up | No                             |
| Configure cookie   | Yes                    | **No**                         |
| Staff ticket       | No                     | Yes (15m, listed perms)        |
| Server token alone | No                     | Only explicit non-staff routes |
| Browser token      | No                     | No                             |

**Shipped — do not regress:** typed credentials; configure≠operate (kit); `allows()` fail-closed; catalog-inactive gate; launch/token step-up; Finance/Support token RBAC.

**Rights change:** merchants **may** place products on own websites; Owner still owns **global** connect only.

---

## 8. Security (most critical — do not skim)

**Full audit (binding):** `platform/SECURITY-AUDIT.md` — login, signup, sessions, CSRF, RBAC, staff, show/hide, abuse (hack / hang / break), gaps **A5/C/A3**, and a 15-point beginner checklist.  
**Rule:** UI hide is never enough. Every deny is a **server** check. If you change auth, tokens, staff, or secrets, read that file first and add/keep tests.

### Already strong — do not regress

| Control                          | Meaning                                              |
| -------------------------------- | ---------------------------------------------------- |
| Typed credentials                | launch ≠ ticket ≠ browser ≠ server ≠ notice          |
| Configure ≠ operate              | Dashboard cookie cannot mint tickets / hit live ops  |
| `allows()` fail-closed           | Bare server token never implies staff                |
| Catalog-inactive + placement     | No secret delivery if inactive or unplaced           |
| CSRF + HttpOnly SameSite cookies | Cookie mutations need same-origin                    |
| Login throttle                   | Account + IP lockouts                                |
| Sealed secrets                   | Server tokens, connections, TOTP at rest             |
| Finance / Support splits         | Finance: no launch/tokens; Support: no server reveal |
| `@ss/net` SSRF                   | No raw fetch to merchant URLs                        |
| Share setup                      | Never includes server token plaintext                |

### Step-up — **A5** (OTP, not password spam)

| Action                                                                                 | Step-up                          |
| -------------------------------------------------------------------------------------- | -------------------------------- |
| Open configure · Share pack · reveal/regenerate server token · critical Portal changes | **OTP only**                     |
| Sign-in                                                                                | Password (+ OTP if 2FA)          |
| Change password / enable 2FA                                                           | May still use password **there** |

Admins: no password field on Open/critical dialogs. Merchants without 2FA: enable 2FA (or email OTP) — **not** password-again as normal path. Server rejects without valid step-up proof.

### Show vs hide (cheat sheet)

| Material                                           | Show?                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| Session cookie, password hashes, TOTP after enroll | **Never**                                                          |
| Server product token                               | Hidden; reveal after OTP (Owner/merchant only)                     |
| Browser token                                      | Yes (public by design for widgets)                                 |
| Connection secrets (DB/AI/storage)                 | Status in Portal; plaintext only to **product** when active+placed |
| Blueprint / Docs hub / agency share                | **No** secrets / no server token                                   |
| Developer pack                                     | After OTP only                                                     |

### Who can what (cheat sheet)

| Actor      | Open configure | Reveal server token | Place products on site | Global connect | Money               |
| ---------- | -------------- | ------------------- | ---------------------- | -------------- | ------------------- |
| Owner      | ✓ + OTP        | ✓ + OTP             | ✓                      | ✓              | ✓                   |
| Support    | ✓ + OTP        | —                   | ✓                      | —              | —                   |
| Finance    | —              | —                   | —                      | —              | ✓                   |
| Merchant   | ✓ + OTP        | ✓ + OTP             | ✓ (**A3**)             | —              | own read            |
| Site staff | —              | —                   | —                      | —              | — (tickets on site) |
| Developer  | —              | via pack after OTP  | —                      | —              | —                   |

### Abuse — what we defend (see audit for paths)

| Attack / break               | Control                                                   |
| ---------------------------- | --------------------------------------------------------- |
| Hacked password / stuffing   | Throttle + lockout; 2FA                                   |
| Stolen Portal cookie         | CSRF; OTP for launch/pack/secrets                         |
| Stolen browser token         | Visitor surface only                                      |
| Stolen server token          | No configure; revoke/regenerate; website-bound            |
| Stolen ticket                | 15m + origin + permission list                            |
| Cross-website                | websiteId on tokens/tickets/DB guards                     |
| SSRF / hang product URL      | `@ss/net` + timeouts + body caps                          |
| Hang auth / APIs             | Rate limits; fail closed to local throttle if store fails |
| Import abuse                 | CLI/ops only — never deploy `ss-import`                   |
| Operate via configure cookie | Kit tests + LIVE_OPS validate (**C1** complete the list)  |

### Security gates before you merge (S)

| Done? | Check                                                                        |
| ----- | ---------------------------------------------------------------------------- |
| ☐     | Read `platform/SECURITY-AUDIT.md` §9 beginner checklist                      |
| ☐     | New/changed routes: `permission` or product `allows` / auth mode declared    |
| ☐     | No secret in blueprint, Docs hub, share link, or logs                        |
| ☐     | Finance still cannot launch/reveal (if you touched admin rights)             |
| ☐     | Configure cookie still cannot hit live ops (if you touched dashboard routes) |
| ☐     | Rate limit / body cap present on new public or auth endpoints                |
| ☐     | Step-up proof required for launch/pack/reveal/critical (OTP after A5)        |
| ☐     | e2e or unit covers the deny path — not only the happy path                   |

---

## 9. Quality

- Per-unit: `pnpm check` (format, lint, typecheck, coverage **90/90/85**).
- Products: `pnpm validate` (`ss app validate`).
- E2E: connect, place, tokens, tickets, launch, plug-in path; **add** pack, Docs hub, merchant placement, capability Settings when those ship.
- Notes fixture drift-guarded.

---

## 10. Build order + acceptance (tick when done)

### A — Portal website & handoff

| Done? | ID  | Work                                                | Accept when                                        |
| ----- | --- | --------------------------------------------------- | -------------------------------------------------- |
| ☑     | A1  | Website front-first; redirect install/usage/changes | Merchant/admin use one home; old URLs redirect     |
| ☑     | A2  | Developer pack API + button + e2e                   | One **OTP** step-up → pack; e2e green              |
| ☑     | A3  | Merchant placement rights + Add product             | Merchant adds/removes on own site; server enforces |
| ☑     | A4  | Docs link; kill Install-as-home copy                | No Setup-only-in-⋯; Docs visible                   |
| ☑     | A5  | Step-up OTP (not password re-entry)                 | Open/pack/critical = OTP; e2e updated; see §8      |

### B — Docs hub

| Done? | ID  | Work                                     | Accept when                          |
| ----- | --- | ---------------------------------------- | ------------------------------------ |
| ☑     | B1  | Public hub index (active catalog)        | No login; unplaced products readable |
| ☑     | B2  | Guides/OpenAPI aggregated or linked      | Stable URLs for AI/dev               |
| ☑     | B3  | Pack includes `docsHubUrl`; console Docs | Pack + UI point at hub               |

### C — Protocol-true

| Done? | ID    | Work                                               | Accept when                               |
| ----- | ----- | -------------------------------------------------- | ----------------------------------------- |
| ☐     | C1    | LIVE_OPS denylist complete                         | Validate rejects operate-on-configure     |
| ☐     | C2    | Notifications configure audit                      | Delivery not on configure cookie          |
| ☐     | C3    | Kit API.md honest                                  | Matches fail-closed `allows()`            |
| ☐     | **S** | Security gate on every auth/token/staff/secrets PR | `SECURITY-AUDIT.md` §9 + §8 S ticks above |

### D — Migration (after A2)

| Done? | ID    | Work                               | Accept when            |
| ----- | ----- | ---------------------------------- | ---------------------- |
| ☐     | D1–D2 | SB checklist + dry-run/send/verify | Owner go               |
| ☐     | D3–D4 | Ibrahim / Chandni mappings         | When green-lit         |
| ☐     | D5    | Storefronts from pack + Docs only  | No Portal for builders |

### E — Product features (per audit file)

| Done? | Product       | First slice                                 | Accept when                     |
| ----- | ------------- | ------------------------------------------- | ------------------------------- |
| ☐     | Chat          | Who/limit (guest+signed-in → Chat settings) | Audit § work order; tests green |
| ☐     | Chat          | Rest of Chat audit                          | ~11–12 capabilities             |
| ☐     | Accounts      | Methods → Sign-in                           | Per audit                       |
| ☐     | Notifications | Policy demote + Push merge                  | Per audit                       |
| ☐     | Payments      | Refunds demote                              | Per audit                       |
| ☐     | Ecommerce     | store_details + catalog options             | Per audit                       |
| ☐     | Growth        | Analytics children demote                   | Per audit                       |

### F — Configure dashboard UX (with E on Chat)

| Done? | ID  | Work                                       | Accept when                         |
| ----- | --- | ------------------------------------------ | ----------------------------------- |
| ☐     | F1  | Capability-oriented Settings list          | Not one row per micro-feature       |
| ☐     | F2  | Prices at capability grain                 | Short Owner list                    |
| ☐     | F3  | Open section settings (all fields visible) | **No** accordion / expand-one-field |
| ☐     | F4  | Long lists = full sub-page                 | Not a fold                          |
| ☐     | F5  | Overview quieter                           | One clear next step                 |

---

## 11. Bans (do not ship)

- Second design system alongside `@ss/ui` (Unite lives in `theme.css` only)
- Developers reading docs inside logged-in Portal
- Docs gated on placement
- Install / Usage / Changes as peer apps
- New mode/chrome/who peer features when a setting would do
- **Accordion / click-to-expand a single settings field**
- **Password re-entry** as the normal step-up for Open / pack / critical changes (use **OTP** — §8 A5)
- Product names in Portal primary nav
- One token for all products
- Merchants connecting deployables globally
- Onboarding authors via monorepo clone
- Deploying `ss-import`
- Claiming A–F done without that letter’s acceptance ticks

---

## 12. Done when (whole program)

- [ ] Merchant: site → products → Open → Share **without** Install/Usage/Changes pages
- [ ] Admin: Products = global; website = same rebuilt home
- [ ] Developer: pack + Docs hub only; zero Portal
- [ ] Docs hub shows products not yet on the site
- [ ] Chat (then others): capabilities match audits; Settings/Prices calm (F)
- [ ] Validate-clean product: connect + place works in e2e without hacks
- [ ] Security: A5 OTP step-up; C1 LIVE_OPS complete; denies for Finance/Support/stolen-credential cases still green
- [ ] `SECURITY-AUDIT.md` beginner checklist still true
- [ ] Touched units: `pnpm check` / validate / e2e green

---

## 13. Where detail lives

| Need                                | Open                                      |
| ----------------------------------- | ----------------------------------------- |
| This plan                           | `PLAN.md`                                 |
| Workspace setup                     | `README.md`                               |
| Portal UX audit                     | `platform/PORTAL-AUDIT.md`                |
| **Security (login, staff, abuse)**  | **`platform/SECURITY-AUDIT.md`**          |
| Portal env / modules                | `platform/README.md`, `src/modules/`      |
| Configure dashboard audit           | `packages/ui/DASHBOARD-AUDIT.md`          |
| Product feature audits              | `products/<id>/FEATURE-AUDIT.md`          |
| Product runtime / docs source       | `products/<id>/`, guides, OpenAPI         |
| Kit / protocol / CLI / import / e2e | package READMEs under `packages/`, `e2e/` |

---

## 14. First day on the job (suggested)

1. `pnpm install` · read root `README.md` · skim §0–§2 here.
2. Skim `platform/PORTAL-AUDIT.md`, `platform/SECURITY-AUDIT.md` (at least §0 + §9), and one `FEATURE-AUDIT.md` (Chat).
3. Run `pnpm --filter @ss/platform check` (or a small unit) so tooling works.
4. Pick **A1** or ask which letter is active — do not start E on Ecommerce while A1 is open unless told.
5. Every PR: name the letter (A1…F5 / **S**), link the audit section, tick acceptance; **security-touching PRs must tick §8 S**.
6. If unsure whether something is secret or who may see it → **SECURITY-AUDIT** show/hide + access matrices, not guesswork.

---

_End of plan. If it is not in §1 or §10, ask before building it. If it touches login, staff, tokens, or secrets — §8 and `SECURITY-AUDIT.md` are mandatory._
