# Product configure dashboard — UX audit (planning only)

**Scope:** `@ss/ui` ProductDashboard (every product’s Open → configure). Shared shell: Overview · Settings · Texts · Developers · Owner Defaults · **Prices**.  
**Pain (owner):** scattered, boring, card-heavy; Settings = wall of feature rows; Prices = spreadsheet of micro-prices; easy to feel confused and “frightened.” Same §6 rule: structure must match how a person thinks.

|                   | Today                                        | Target                                                                                            |
| ----------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Settings nav      | **One row per feature** (Chat = 44)          | **One row per capability** (~10–12 after feature audits) + optional groups                        |
| Prices            | One price per feature key                    | One price per **kept** capability (same merge); no micro-feature price grid                       |
| Feature page body | All settings cards stacked with equal weight | **Calm open sections** — always visible fields in order; **never** click-to-expand a single field |
| Tabs              | 4 + 2 Owner                                  | Keep tabs; **re-role** Settings/Prices content                                                    |

Feature-key merges (`FEATURE-AUDIT.md`) and this UX pass are **one story**: fewer capabilities → calmer nav; layout must still not card-spam.

---

## 1. Short: remove / demote / keep / add

### Remove / stop doing

| Stop                                                       | Why                                    | Goes to                                                                                                                          |
| ---------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Treating every feature key as a **sidebar destination**    | 35–44 rows = inventory, not a product  | Capability list only (post-audit keys)                                                                                           |
| **Prices** as editable grid of every micro-feature         | Boring, scary, irrelevant to merchants | Owner prices **capabilities**; demoted features inherit parent price (0 extra)                                                   |
| Dumping **all** schema fields + lists as equal noisy cards | No hierarchy → fatigue                 | One scroll of **open** sections (label + fields); lists as their own full section — not buried                                   |
| **Click-to-expand / accordion for one field**              | UX disaster — feels broken and cheap   | **Forbidden.** If a field exists, show it. Long jobs get their own capability page or a real sub-page, not a disclosure triangle |
| Fake category chips that mix real + phantom keys           | Accounts/Growth invent non-features    | Categories = real capability groups only                                                                                         |
| Merchant seeing locked switches + prices on every row      | Noise                                  | Merchant: **what’s on** + configure those; switches Owner/Support only (already partly true) — hide price chrome for merchants   |

### Keep

| Keep                                    | Notes                                                               |
| --------------------------------------- | ------------------------------------------------------------------- |
| Overview first                          | Needs you, setup steps, cost summary — strengthen as the calm front |
| Settings / Texts / Developers tabs      | Jobs are real                                                       |
| Owner Defaults + Prices tabs            | Owner-only; simplify Prices content                                 |
| Switch + confirm with cost              | Keep for capability on/off                                          |
| Portal website settings via ManagedNote | Don’t duplicate brand/format here                                   |

### Add

| Add                                   | Where                                                              |
| ------------------------------------- | ------------------------------------------------------------------ |
| **Capabilities** mindset in Settings  | Short list: name, on/off, one-line job, “Configure”                |
| **Configure** view per on capability  | Settings for that job only — not 44 peers                          |
| Price at capability grain             | After feature merges                                               |
| Empty/off state: one calm explanation | Not a wall of grey rows                                            |
| Open section hierarchy                | Spacing, headings, order — **not** fold/expand                     |
| Real sub-page only if long            | e.g. list editor as its own `#` view — full page, not an accordion |

---

## 2. Today’s shape (evidence)

| Piece        | File                            | Behavior                                                                                  |
| ------------ | ------------------------------- | ----------------------------------------------------------------------------------------- |
| Shell tabs   | `dashboard.js`                  | overview, settings, texts, developers, defaults, prices                                   |
| Settings     | `dashboard-tabs.js` SettingsTab | **Every** feature = `SectionsPage` row (switch, price, change count); body = all settings |
| Features UI  | `dashboard-features.js`         | Folded into Settings (no Features tab) — still one row each                               |
| Prices       | PricesTab                       | Categories × **every** feature hourly credits; one Save bar                               |
| Categories   | product `categories.js`         | Groups rows; Chat has 7 groups still holding 44 keys                                      |
| Lists/extras | product `lists.js` / extras     | Heavy cards under a feature                                                               |

Folding Features→Settings was a step; it did **not** reduce cognitive load — it put the inventory **inside** Settings.

---

## 3. Target configure IA

```
Overview     → next actions only (front)
Settings     → Capabilities (few) → open one → its settings
Texts        → copy for on surfaces (can filter by on)
Developers   → connections + snippets (unchanged job)
Defaults     → Owner templates (unchanged job)
Prices       → Owner: capability prices only (short list)
```

**Capability row (Settings list):** name · one sentence · on/off (admin) · status · not a price spreadsheet in the row for merchants.

**Capability page:**

1. What it does (short)
2. Settings in a clear vertical order (groups as **open** headings — all fields visible)
3. Big lists → own list row/page in the capability’s section list (full view), **not** expand-one-field
4. No sibling feature wall
5. **No accordion / “Advanced ▾” that hides a lonely field**

---

## 4. Tie to product feature audits

| Without feature merge | With merge only             | With merge + this UX                         |
| --------------------- | --------------------------- | -------------------------------------------- |
| 44 scary rows         | ~12 rows still card-stacked | ~12 calm capabilities + progressive settings |
| 44 prices             | ~12 prices                  | ~12 prices, readable                         |

Do **E** (feature merge) and **F** (this dashboard UX) together for Chat first so merchants never see “44→12 but still a boring wall.”

---

## 5. Work order (later — build **F**)

1. Spec capability-oriented Settings list in `@ss/ui` (API can stay feature-keyed until merges land).
2. PricesTab: only billable capability keys; demoted keys price 0 / folded.
3. Settings body: open section order (use `x-ui.group` / order). **Do not** use `x-ui.advanced` as click-to-reveal; prefer reorder or a separate full sub-page for rare blocks.
4. Categories: only post-audit groups; delete phantom keys.
5. Overview: one primary next step, less tile clutter.
6. Visual pass: less Card-for-Card’s-sake; open Page sections (still `@ss/ui` only).

**Non-goal / ban:** accordion, collapse, “show advanced”, expand-to-edit-one-field.

**Risks:** merchants bookmark `#feature-…` hashes; Owner price migration; list editors as full sub-views.

**Open:** Should Pricing move to Portal later? Out of scope for F — keep short Owner Prices list.

---

_End dashboard UX audit._
