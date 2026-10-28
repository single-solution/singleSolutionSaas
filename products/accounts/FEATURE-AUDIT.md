# Accounts — deep feature audit (planning only)

**Depth:** 19 features · settings schemas · categories (incl. fake keys `passwords`/`phone`/`profile`) · widgets OR-gating methods · OAuth connections · route gates.

|             | Today  | Target    |
| ----------- | ------ | --------- |
| Features    | **19** | **~9–11** |
| Widgets     | 6      | 6         |
| Permissions | 4      | 4         |

---

## 1. Short: remove / demote / merge / keep / add

### Remove as peer features

| Remove           | Goes under              | Moves                                          |
| ---------------- | ----------------------- | ---------------------------------------------- |
| `phone_code`     | **Sign-in** methods     | `newUserName`; Notifications SMS/WA            |
| `phone_password` | **Sign-in** methods     | signUp, reset; **shared** password rules       |
| `email_password` | **Sign-in** methods     | **shared** password rules (dup of phone today) |
| `email_code`     | **Sign-in** methods     | `websitePerHour`                               |
| `google`         | **Sign-in** methods     | conn Google when method on                     |
| `apple`          | **Sign-in** methods     | conn Apple                                     |
| `facebook`       | **Sign-in** methods     | conn Facebook                                  |
| `risk_checks`    | **Sign-in** security    | disposable, domains, device/network caps       |
| `custom_fields`  | **Profiles** list       | field definitions (empty schema → list)        |
| `staff_links`    | **Roles** / Users admin | setupDays, setupPageUrl                        |
| `orders_tab`     | **My account** setting  | Ecommerce link — not a product                 |

### Keep

| Keep                       | Why                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| **Sign-in** (new umbrella) | Methods checklist + shared password/phone sections (categories already pretend these exist) |
| **Roles**                  | users/roles admin widgets + 3 perms                                                         |
| **Role requests**          | visitor widget + staff flow                                                                 |
| **Approval**               | open / invite / approve policy (**REVIEW:** could be Sign-in settings)                      |
| **Two-step**               | 2FA (**REVIEW:** Roles/Sign-in settings if never sold alone)                                |
| **Consents**               | versioned agreements list                                                                   |
| **Data rights**            | export/erase across products                                                                |
| **Import**                 | migration                                                                                   |
| **Activity copies**        | **REVIEW** — widget `activity_admin`; demote to ops setting or thin KEEP                    |

### Add

| Add                                              | Where                            |
| ------------------------------------------------ | -------------------------------- |
| One **Sign-in** feature + `methods[]`            | manifest                         |
| Shared **password** / **phone channel** settings | replace duplicated schema fields |
| Widget gate: Sign-in && ≥1 method                | `sign_in`, `my_account`          |

---

## 2. Deep per-feature

| Key                         | Settings                  | Conn / widget / perm                            | Verdict                              |
| --------------------------- | ------------------------- | ----------------------------------------------- | ------------------------------------ |
| `phone_code`                | newUserName               | routes; Notifications                           | **MERGE→Sign-in**                    |
| `phone_password`            | 5 incl. password rules    | routes                                          | **MERGE→Sign-in** + shared passwords |
| `email_password`            | minLength, letterAndDigit | routes                                          | **MERGE→Sign-in** + shared passwords |
| `email_code`                | websitePerHour            | routes                                          | **MERGE→Sign-in**                    |
| `google`/`apple`/`facebook` | ∅                         | own OAuth conn; routes                          | **MERGE→Sign-in**                    |
| `roles`                     | ∅ (templates/lists)       | users_admin, roles_admin; users.*, roles.manage | **KEEP**                             |
| `custom_fields`             | ∅                         | routes                                          | **DEMOTE** Profiles                  |
| `two_step`                  | ∅                         | routes                                          | **KEEP** or demote                   |
| `approval`                  | mode, fields, invite*     | routes                                          | **KEEP** or Sign-in settings         |
| `risk_checks`               | 5                         | no dedicated routes in scan                     | **DEMOTE** Sign-in security          |
| `consents`                  | ∅                         | routes                                          | **KEEP**                             |
| `data_rights`               | deleteAfterDays           | routes; cross-product links                     | **KEEP**                             |
| `activity_copies`           | ∅                         | activity_admin; activity.read                   | **REVIEW**                           |
| `orders_tab`                | ∅                         | Ecommerce orders.read.customer                  | **DEMOTE** My account                |
| `staff_links`               | setupDays, setupPageUrl   | routes                                          | **DEMOTE** Roles desk                |
| `role_requests`             | 3                         | widget role_request                             | **KEEP**                             |
| `import`                    | ∅                         | pepper conn optional                            | **KEEP**                             |

**Smell:** categories list `passwords`, `phone`, `profile` as if features — they are not in the manifest. Finish that model.

---

## 3. Target (~10)

Sign-in · Roles · Role requests · Approval · Two-step · Consents · Data rights · Import · (+ Activity copies if kept)

---

## 4. Work order + risks

1. Merge 7 methods → Sign-in; retarget widget OR lists; connection `neededBy` from methods.
2. Unify password rules.
3. Demote risk, custom_fields, staff_links, orders_tab.
4. Decide approval / two_step / activity_copies.
5. Docs / recommendFor.

**Risks:** every website’s `featuresOn` lists method keys; Chat/Ecommerce `recommendFor` and links reference sign-in; Notifications templates for codes; e2e sign-in suites.

**Open:** priced per social method? If yes, keep keys but one UI — prefer one feature for simplicity bar.

---

_End deep Accounts audit._
