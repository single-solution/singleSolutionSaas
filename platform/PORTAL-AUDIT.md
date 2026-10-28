# Portal — deep surface audit (planning only)

**Depth:** merchant + admin consoles · website parts · settings sections · modules (identity, catalog, commerce, website, system) · compared to PLAN §1 UI contract and §6 simplicity bar.  
**Not a product manifest** — Portal has pages and jobs, not feature keys. Same test: _own job vs setting/ceremony of one thing?_

|                      | Today                                                 | Target                                                     |
| -------------------- | ----------------------------------------------------- | ---------------------------------------------------------- |
| Merchant primary nav | 4                                                     | 4 + Docs out-link                                          |
| Admin primary nav    | 7 (role-filtered)                                     | same                                                       |
| Website peer pages   | home + install + setup + usage + changes + settings×7 | **home + setup + settings×7** (install/usage/changes gone) |
| New surfaces         | —                                                     | Share pack · Docs hub (public)                             |

---

## 1. Short: remove / demote / keep / add

### Remove (peer pages / ceremony)

| Remove                                      | Goes under                                                        |
| ------------------------------------------- | ----------------------------------------------------------------- |
| `/websites/:id/install`                     | **Share with developer** (pack) + optional break-glass under pack |
| `/websites/:id/usage`                       | **Credits** (`/credits`) and/or light peek on website home        |
| `/websites/:id/changes`                     | **Settings** activity / secondary (not a peer app)                |
| Install as home secondary that buries Setup | Reorder: Share + Settings + Setup on front                        |

### Keep

| Keep                                                                            | Notes                                                                   |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Merchant: Overview · Websites · Credits · Account                               | Small copy/next-action only                                             |
| Admin: Overview · Merchants · Products · Billing · Admins · Settings · Activity | No rebuild                                                              |
| Admin **Products**                                                              | Global connect only — clarify copy                                      |
| Website **Settings** sections                                                   | business, brand, region, pages, team, connections, links — long form OK |
| Website **Setup** sheet                                                         | Addressable; entry from front; export/share secondary                   |
| Login / 2FA / account                                                           | Unchanged                                                               |
| Same `WebsitePageView` for merchant + admin                                     | Rights differ                                                           |

### Add

| Add                                  | Where                                |
| ------------------------------------ | ------------------------------------ |
| **Share with developer** (pack)      | Website home; step-up = **OTP**      |
| **Add product** for merchants        | Website home (server rights)         |
| **Docs hub** (public)                | Portal public routes / docs host     |
| Docs link in shells                  | Footer/help                          |
| Redirects                            | old install/usage/changes → home     |
| **OTP step-up** (not password again) | Open / pack / critical — PLAN **A5** |

### Do **not** rebuild (non-goals)

Admin Merchants/Billing/Admins/Activity full redesign · new design system · Portal as logged-in docs · product names in sidebar.

---

## 2. Deep by surface

### Merchant console

| Surface             | Today                                                          | Verdict                                   |
| ------------------- | -------------------------------------------------------------- | ----------------------------------------- |
| Overview            | Attention / next actions                                       | **KEEP** — small tighten                  |
| Websites list       | List ∥ detail                                                  | **KEEP**                                  |
| Website home        | Product rows; Open; secondary Settings/Install/Setup→⋯; no Add | **REBUILD** (§1)                          |
| Website install     | Tokens per product                                             | **REMOVE** → pack                         |
| Website usage       | Per-site usage chart                                           | **REMOVE** → credits/peek                 |
| Website changes     | Settings timeline                                              | **REMOVE** → settings secondary           |
| Website setup       | Advisor + JSON export/share                                    | **KEEP** page; demote as handoff          |
| Website settings ×7 | Long forms                                                     | **KEEP**                                  |
| Credits             | Billing/usage                                                  | **KEEP**                                  |
| Account             | Profile/security                                               | **KEEP**                                  |
| Shared-setup        | Public no-secret share                                         | **KEEP** (agency); pack is secret handoff |

### Admin console

| Surface                      | Today                                                | Verdict                          |
| ---------------------------- | ---------------------------------------------------- | -------------------------------- |
| Overview                     | Platform attention                                   | **KEEP**                         |
| Merchants                    | List + detail                                        | **KEEP**                         |
| Merchant website drill-in    | Same WebsitePageView + Add/Remove                    | **Same rebuild** as merchant     |
| Products                     | Connect URL + secret, active/inactive, Open as admin | **KEEP** + copy “global catalog” |
| Billing / Finance            | Money; no launch/tokens                              | **KEEP**                         |
| Admins / Settings / Activity | Portal ops                                           | **KEEP**                         |
| Account                      | —                                                    | **KEEP**                         |

### Control-plane modules (backend — keep; UX consumes them)

| Module   | Owns                                              | UX note                             |
| -------- | ------------------------------------------------- | ----------------------------------- |
| identity | sessions, tokens, launches, websites as resources | pack API lives here / beside tokens |
| catalog  | connect, blueprints, setup links                  | feeds Docs hub index                |
| commerce | credits, usage, placement charges                 | usage page folds into this story    |
| website  | settings, connections, placement                  | settings sections stay              |
| system   | keys, mail, boot                                  | unchanged                           |

---

## 3. Portal vs product audits

| Layer                                       | Planned in                                            |
| ------------------------------------------- | ----------------------------------------------------- |
| Portal IA / website front / pack / Docs hub | This file + PLAN §1 + build **A/B**                   |
| Product feature simplify (Chat…Growth)      | `products/*/FEATURE-AUDIT.md` + PLAN §6 + build **E** |
| Protocol-true / LIVE_OPS                    | PLAN build **C**                                      |

Portal is **not** “feature keys to demote” — it is **pages and handoffs**. Same simplicity bar, different shape.

---

## 4. Work order (Portal) — already PLAN A/B

1. **A1** Website front-first + redirects
2. **A2** Developer pack + e2e
3. **A3** Merchant placement
4. **A4** Chrome / Docs link / copy
5. **A5** Step-up OTP (Open, pack, critical) — not password re-entry
6. **B** Docs hub

Product **E** can run after A2 (builders unblocked) or in parallel on Chat who/limit — do not block Portal A on finishing all six product merges.

---

## 5. Open questions

(a) Setup sheet keep forever vs fold advisor into home strip only? Prefer keep URL.  
(b) Website usage peek on home vs credits-only? Prefer light peek + credits.  
(c) Docs hub on Portal origin vs docs subdomain? Prefer stable public URL; Portal can host.

---

_End deep Portal audit._
