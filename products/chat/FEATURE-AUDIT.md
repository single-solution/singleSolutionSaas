# Chat — deep feature audit (planning only)

**Depth:** manifest · 44 settings schemas · `adapters/lists.js` (17 lists) · connections · widgets/perms · dashboard categories · route `feature:` gates.  
**Do not implement from this file until the simplify pass is scheduled.**

| | Today | Target |
| --- | --- | --- |
| Features | **44** | **~11–12** |
| Widgets | 4 | 4 |
| Permissions | 5 | 5 |
| Lists | 17 (tied to features) | same lists, fewer parent features |

---

## 1. Short: remove / demote / merge / keep / add

### Remove as peer features (become settings or lists under a parent)

| Remove feature key | Goes under | What moves |
| --- | --- | --- |
| `guest_chat` | **Chat** | `messageLimit`, `contactCapture` → who/limit settings |
| `signed_in_chat` | **Chat** | `claimByPhone`; requires Accounts / `pages.signIn` |
| `typing_receipts` | **Chat** | `showTyping`, `showSeen` |
| `attachments` | **Chat** | `visitorUploads` + list `upload_types` + storage connection when on |
| `ratings` | **Chat** | kind, labels, askWhen, askComment |
| `transcripts` | **Chat** or **Inbox** | email transcript (Notifications link) |
| `proactive_idle` | **Proactive** or **Chat** | idleMinutes, oncePer, hideOnMobile |
| `proactive_pages` | **Proactive** / **Chat** | list `page_rules` |
| `proactive_exit` | **Proactive** / **Chat** | exit-intent rule type |
| `custom_fields` | **Chat** / **Leads** | list `custom_fields` |
| `ai_backup` | **AI replies** | connection `ai_backup` only (empty schema today) |
| `ai_instructions` | **AI replies** | `instructions` (+ setup-step) |
| `fallback_answers` | **AI replies** | `budgetWords` + list `fallback_answers` |
| `ai_caps` | **AI replies** | daily/monthly tokens |
| `ai_cost_alerts` | **AI replies** | needs caps + staff alerts / Notifications |
| `language_lock` | **AI replies** | allowedLanguages, markers, … |
| `shop_context` | **AI** or **Shop assistant** | empty schema — prompt context flag |
| `knowledge_pages` | **Knowledge** | page-source of knowledge (routes exist) |
| `knowledge_editor` | **Knowledge** | widget + `knowledge.edit` — not a merchant “product” toggle |
| `product_cards` | **Shop assistant** | UI for search results |
| `shop_search` | **Shop assistant** | tool on |
| `shop_deals` | **Shop assistant** | tool on |
| `shop_top` | **Shop assistant** | tool on |
| `shop_my_orders` | **Shop assistant** | tool on (needs signed-in who) |
| `track_shipment` | **Shop assistant** | tool on |
| `assignment` | **Inbox** | `autoAssign` + list `teams` |
| `presence_queue` | **Inbox** | maxChats, queuePosition |
| `internal_notes` | **Inbox** | mode |
| `saved_replies` | **Inbox** | list (empty schema) |
| `context_panel` | **Inbox** | desk chrome |
| `ai_summary` | **Inbox** | instructions; needs AI |
| `staff_alerts` | **Inbox** | adminUrl, frequency, … |
| `visitor_alerts` | **Inbox** | frequency, channels |

### Keep as features

| Keep | Why |
| --- | --- |
| **Chat** (rename `visitor_chat`) | Shell: widget, visitor API, list `page_types`, chrome settings |
| **AI replies** | Real optional; connection `ai` |
| **Knowledge** | Data + staff editor |
| **Webhook tools** | List `tools` + tool signing secret |
| **Book-a-slot** | Settings + lists `booking_questions` / `booking_services` |
| **Shop assistant** (new umbrella) | Ecommerce-linked tools (merged keys above) |
| **Leads & flows** | Settings + list `flows` |
| **Inbox** | Widget + perms + lists tags/topics/priorities |
| **Handoff** | Real AI↔human; lists `office_hours`, `office_exceptions` |
| **Moderation** | Policy + list `redaction_patterns` |
| **Reports** | Widget + perm |
| **Import** | Migration |

### Add (structure only — no new product domain)

| Add | Where |
| --- | --- |
| Settings block **Who can chat** | Chat configure |
| Settings block **Proactive** (or one feature) | Chat |
| Checklist **Shop tools** | Shop assistant |
| Feature-flag migration map | old key → new parent + setting |

---

## 2. Deep per-feature (evidence)

| Key | Settings props | Lists | Conn / widget / perm | Verdict |
| --- | --- | --- | --- | --- |
| `visitor_chat` | 8 chrome | `page_types` | widget `chat` | **KEEP→Chat** |
| `guest_chat` | 2 | — | route guest paths | **DEMOTE** who/limit |
| `signed_in_chat` | 1 | — | Accounts | **DEMOTE** who |
| `ai_replies` | 8 | — | conn `ai` | **KEEP** |
| `ai_backup` | ∅ | — | conn `ai_backup` | **DEMOTE** |
| `ai_instructions` | 1 | — | setup-step | **DEMOTE** |
| `fallback_answers` | 1 | `fallback_answers` | — | **DEMOTE** |
| `ai_caps` | 2 | — | — | **DEMOTE** |
| `ai_cost_alerts` | ∅ | — | Notifications | **DEMOTE** |
| `language_lock` | 4 | — | region.language | **DEMOTE** |
| `knowledge_base` | ∅ | (KB data) | routes | **KEEP→Knowledge** |
| `knowledge_pages` | ∅ | — | routes | **MERGE** Knowledge |
| `knowledge_editor` | ∅ | — | widget + perm | **MERGE** Knowledge |
| `webhook_tools` | ∅ | `tools` | secret | **KEEP** |
| `book_slot` | 3 | booking_* | — | **KEEP** |
| `shop_*` (5) + `product_cards` | ∅ | — | Ecommerce links | **MERGE** Shop assistant |
| `shop_context` | ∅ | — | — | **DEMOTE** |
| `proactive_*` (3) | idle has 3; pages∅ | `page_rules` | — | **MERGE** Proactive/Chat |
| `leads_flows` | 3 | `flows` | routes | **KEEP** |
| `custom_fields` | ∅ | `custom_fields` | — | **DEMOTE** |
| `attachments` | 1 | `upload_types` | storage | **DEMOTE** Chat |
| `typing_receipts` | 2 | — | — | **DEMOTE** |
| `ratings` | 4 | — | routes | **DEMOTE** |
| `transcripts` | ∅ | — | Notifications | **DEMOTE** |
| `inbox` | 3 | tags, topics, priorities | widget + 3 perms | **KEEP** |
| `handoff` | 6 | office_hours, exceptions | routes | **KEEP** |
| `assignment` | 1 | `teams` | — | **DEMOTE** Inbox |
| `presence_queue` | 2 | — | routes | **DEMOTE** Inbox |
| `internal_notes` | 1 | — | routes | **DEMOTE** Inbox |
| `saved_replies` | ∅ | (replies data) | routes | **DEMOTE** Inbox |
| `context_panel` | ∅ | — | Ecommerce optional | **DEMOTE** Inbox |
| `ai_summary` | 1 | — | routes | **DEMOTE** Inbox |
| `staff_alerts` | 4 | — | Notifications | **DEMOTE** Inbox |
| `visitor_alerts` | 2 | — | Notifications | **DEMOTE** Inbox |
| `moderation` | 6 | `redaction_patterns` | — | **KEEP** |
| `reports` | ∅ | — | widget + perm | **KEEP** |
| `import` | ∅ | — | ss-import | **KEEP** |

---

## 3. Target feature set (~12)

1. Chat · 2. AI replies · 3. Knowledge · 4. Webhook tools · 5. Book-a-slot · 6. Shop assistant · 7. Leads & flows · 8. Inbox · 9. Handoff · 10. Moderation · 11. Reports · 12. Import  
(+ optional: Proactive as #13 vs settings under Chat)

---

## 4. Work order (later) + migration risks

1. Who/limit (`guest`+`signed_in`→Chat) — **highest value**; rewrite “no one starts” rule; migrate `featuresOn` on websites.  
2. Chrome demotions (typing, attachments, ratings, transcripts).  
3. Proactive trio → one.  
4. AI subfeatures → AI replies settings + keep connections.  
5. Knowledge merge; Shop assistant merge; Inbox demotions.  
6. Docs / recommendFor / Setup tags.

**Risks:** existing websites with only `guest_chat` on; Ecommerce link features; permission strings unchanged; list `feature:` field in `LISTS` must retarget parents; e2e + unit matrices assume old keys.

**Open questions:** (a) Handoff KEEP vs Inbox subsection? (b) Proactive own feature vs Chat settings? (c) Shop assistant one feature vs tool checklist under AI?

---

*End deep Chat audit.*
