# Notifications — deep feature audit (planning only)

**Depth:** 12 features · settings · provider connections · push VAPID shared · dashboard lists (fallback chains, quiet hours, template settings, webhooks) · widgets all gated on `send_api` or push · categories fake keys `templates`/`delivery_log`.

| | Today | Target |
| --- | --- | --- |
| Features | **12** | **~7–8** |
| Widgets | 5 | 5 |
| Permissions | 4 | remap parents |

---

## 1. Short: remove / demote / merge / keep / add

### Remove as peer features

| Remove | Goes under | Moves |
| --- | --- | --- |
| `quiet_hours` | **Sending policy** | list/card quiet windows (already in dashboard lists UI) |
| `send_limits` | **Sending policy** | perHour, perDay, counts |
| `fallback` | **Sending policy** | fallback_chains list UI |
| `delayed_send` | **Sending policy** or Send API | schedule-on-send |
| `multi_language` | **Templates** | per-language template versions |
| `browser_push` + `staff_push` | **Push** (merge) | shared VAPID; audience toggles visitors/staff |

### Keep

| Keep | Why |
| --- | --- |
| **Email / SMS / WhatsApp** | Real channels + own provider conn — do **not** merge into one blob |
| **Push** (merged) | One pipe, two audiences |
| **Webhooks** | Outbound + signing secret |
| **Send API / Staff tools** | Programmatic send — **fix gating** of templates/log |

### Add / fix

| Add / fix | Where |
| --- | --- |
| **Sending policy** settings section | Configure (not a billed feature) |
| Templates + delivery log when **any channel** on | Un-gate from `send_api` |
| Fake category keys → real sections | `templates`, `delivery_log` |

---

## 2. Deep per-feature

| Key | Settings | Lists / UI | Conn / widget / perm | Verdict |
| --- | --- | --- | --- | --- |
| `whatsapp` | templateLanguage | — | conn whatsapp | **KEEP** channel |
| `email` | ∅ | — | conn email | **KEEP** |
| `sms` | ∅ | — | conn sms | **KEEP** |
| `browser_push` | ∅ | — | VAPID; widget push_permission | **MERGE→Push** |
| `staff_push` | ∅ | — | VAPID; staff widget; push.subscribe | **MERGE→Push** |
| `webhooks` | ∅ | webhook URLs | webhook_secret | **KEEP** |
| `fallback` | ∅ | fallback_chains card | — | **DEMOTE** policy |
| `quiet_hours` | ∅ | quiet_hours card | — | **DEMOTE** policy |
| `send_limits` | 3 | — | — | **DEMOTE** policy |
| `delayed_send` | ∅ | — | — | **DEMOTE** policy |
| `multi_language` | ∅ | template versions | — | **DEMOTE** templates |
| `send_api` | ∅ | — | **3 widgets** + log.read, templates.edit, messages.send | **KEEP** but **ungate** templates/log |

**Smell:** turning Email on without `send_api` leaves no template editor — merchant cannot operate the channel they bought.

**Configure vs operate:** delivery log / send message are live ops → widgets/tickets (already widgets); ensure dashboard does not duplicate live send under configure cookie (PLAN C).

---

## 3. Target (~7–8)

Email · SMS · WhatsApp · Push · Webhooks · Send API (staff/API) · (+ channels UI)

Policy = settings always available when ≥1 channel on.

---

## 4. Work order + risks

1. Demote 5 policy features → settings/lists (flags migrate to settings defaults on).  
2. Merge push; retarget VAPID `neededBy`.  
3. Re-gate widgets: templates/log ↔ any channel; send_message ↔ Send API.  
4. Docs.

**Risks:** websites with only policy features on; Accounts/Chat links that assume Notifications channels; permission feature parents.

**Open:** is Send API ever off while channels on? Prefer Send API = “server may call send” optional; desk always with channel.

---

*End deep Notifications audit.*
