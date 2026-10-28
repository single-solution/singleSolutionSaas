# Growth — deep feature audit (planning only)

**Depth:** 15 features · all settings schemas · `core/lists.js` (goals, funnels, consent_categories, announcements, conversion_actions, verification_tags, seo_ignored) · 5 widgets · 5 perms · **no** sealed connections (pixel IDs live in settings) · categories fake keys `tags`/`pixels` · route gates (analytics/redirects heavy).

|             | Today  | Target                      |
| ----------- | ------ | --------------------------- |
| Features    | **15** | **~10–11**                  |
| Widgets     | 5      | 5                           |
| Permissions | 5      | 5 (remap if parents change) |
| Connections | none   | keep (IDs in settings)      |

---

## 1. Short: remove / demote / merge / keep / add

### Remove as peer features

| Remove              | Goes under                                    | Moves                                                             |
| ------------------- | --------------------------------------------- | ----------------------------------------------------------------- |
| `conversion_funnel` | **Visitor analytics**                         | lists `goals`, `funnels` (already feature-tied here)              |
| `searches_404s`     | **Visitor analytics**                         | `searchParams`                                                    |
| `web_vitals`        | **Visitor analytics** (and/or Google tags)    | `toGa4`; first-party store when analytics on                      |
| `indexnow`          | **SEO tools** with checklist **or** keep thin | key, keyPath; perm `indexnow.submit`; widget shares seo_checklist |

### Keep

| Keep                            | Why                                                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Meta / Google / TikTok** tags | Real ad pipes + IDs + list `conversion_actions` (any of three) — like Payments gateways / Notifications channels |
| **Custom scripts**              | Runs merchant JS; perm `scripts.manage`; list consent_categories scripts field                                   |
| **Consent banner**              | Compliance widget; `pages.privacy`; list `consent_categories`                                                    |
| **Visitor analytics**           | First-party DB + analytics_dashboard; absorb funnel/searches/vitals                                              |
| **robots & verification**       | robots.txt + verification settings + list `verification_tags`                                                    |
| **SEO checklist**               | Live scan widget; list `seo_ignored`                                                                             |
| **Redirects**                   | Rules + redirects widget; many routes                                                                            |
| **Notice bar**                  | Widget + list `announcements`                                                                                    |
| **Import**                      | Migration of daily totals                                                                                        |

### Add / fix

| Add / fix                          | Where                                                  |
| ---------------------------------- | ------------------------------------------------------ |
| One **Ads & tags** screen          | toggles for Meta/Google/TikTok/scripts (keys may stay) |
| Fake category keys `tags`/`pixels` | real sections under Ads                                |
| Decide IndexNow                    | fold into SEO checklist feature vs KEEP                |

---

## 2. Deep per-feature

| Key                   | Settings props                                         | Lists                                           | Widget / perm / routes                               | Verdict                              |
| --------------------- | ------------------------------------------------------ | ----------------------------------------------- | ---------------------------------------------------- | ------------------------------------ |
| `meta_pixel`          | pixelId                                                | conversion_actions (shared), consent_categories | —                                                    | **KEEP** channel                     |
| `google_tags`         | ga4Id, adsId, gtmId, ga4ViaGtm                         | same                                            | —                                                    | **KEEP**                             |
| `tiktok_pixel`        | pixelId                                                | same                                            | —                                                    | **KEEP**                             |
| `custom_scripts`      | ∅                                                      | consent_categories (scripts field)              | scripts.manage                                       | **KEEP**                             |
| `consent_banner`      | position, askAgainMonths                               | consent_categories                              | widget consent_banner; requires privacy              | **KEEP**                             |
| `visitor_analytics`   | detail, retentionMonths, requireConsent, recordCountry | —                                               | analytics_dashboard; analytics.read; ~5 route hits   | **KEEP**                             |
| `conversion_funnel`   | ∅                                                      | goals, funnels                                  | depends analytics; ~5 route hits                     | **DEMOTE→analytics**                 |
| `searches_404s`       | searchParams                                           | —                                               | depends analytics                                    | **DEMOTE→analytics**                 |
| `web_vitals`          | toGa4                                                  | —                                               | can pair GA4 without first-party store               | **DEMOTE→analytics** (+ flag for GA) |
| `robots_verification` | **11** props                                           | verification_tags                               | ~2 routes                                            | **KEEP**                             |
| `indexnow`            | key, keyPath                                           | —                                               | indexnow.submit; seo_checklist widget OR             | **MERGE→SEO** or thin KEEP           |
| `seo_checklist`       | paths                                                  | seo_ignored                                     | seo_checklist widget; seo.check                      | **KEEP**                             |
| `redirects`           | ∅ (rules in product data)                              | —                                               | redirects widget; redirects.edit; **~11** route hits | **KEEP**                             |
| `notice_bar`          | enabled                                                | announcements                                   | notice_bar widget                                    | **KEEP**                             |
| `import`              | ∅                                                      | —                                               | ss-import                                            | **KEEP**                             |

**Lists detail**

| List               | Feature field today             | After demote        |
| ------------------ | ------------------------------- | ------------------- |
| goals, funnels     | `conversion_funnel`             | `visitor_analytics` |
| consent_categories | banner **or** any pixel/scripts | unchanged idea      |
| announcements      | `notice_bar`                    | unchanged           |
| conversion_actions | any of three pixels             | unchanged           |
| verification_tags  | `robots_verification`           | unchanged           |
| seo_ignored        | `seo_checklist`                 | unchanged           |

**Not over-merge:** Meta/Google/TikTok stay separate toggles (different IDs, recommendFor, consent). Same class as email/SMS/WhatsApp — not guest/visitor.

**Smell:** categories invent `tags`/`pixels` non-features — finish as UI sections.  
**Smell:** `web_vitals` has no `dependsOn` but copy says first-party needs analytics — settings model should encode that.

---

## 3. Target (~10–11)

Meta pixel · Google tags · TikTok pixel · Custom scripts · Consent banner · **Visitor analytics** (incl. goals/funnels/searches/vitals) · robots & verification · SEO checklist (+ IndexNow) · Redirects · Notice bar · Import

---

## 4. Work order + risks

1. Demote conversion_funnel, searches_404s, web_vitals → analytics settings; retarget list `feature` for goals/funnels.
2. Fold or keep IndexNow under SEO checklist (update perm parent + widget feature array).
3. Ads UI polish; kill fake category keys.
4. Docs / recommendFor.

**Risks:** medium — analytics child flags on existing sites; Chat/Ecommerce don’t hard-depend on Growth feature keys as much as shop tools; IndexNow API offered to other products via `links.offers` (`indexnow.submit`) — keep scope even if feature key moves.

**Open questions:**  
(a) IndexNow KEEP for link-offer clarity vs fold into checklist? Prefer fold + keep offer scope.  
(b) Custom scripts under Consent only (no peer feature)? Prefer KEEP — security-sensitive + Owner permission.

---

_End deep Growth audit._
