# Portal + products — security surface audit (planning only)

**Scope:** identity, sessions, CSRF, RBAC, step-up, product tokens/tickets, staff-on-site, show-vs-hide, `@ss/net` SSRF, rate/payload limits, import abuse, gaps vs PLAN **A5** / **C**.  
**Not done here:** product runtime code changes. Paths are concrete; “UI hides” never replaces “server denies.”

**Related:** `PLAN.md` §7–§8, §10 A5/C · `platform/PORTAL-AUDIT.md` (UX) · `packages/app-kit/API.md` (kit contract).

---

## 0. Verdict (one screen)

| Area                                                     | State                                                                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Portal cookie auth + CSRF + throttle                     | **Strong** — keep                                                                                  |
| Admin RBAC (`can()` + route `permission`)                | **Strong** — Finance/Support gaps intentional                                                      |
| Step-up today                                            | **Password (+ OTP if 2FA)** — wrong UX; stolen-session bar OK; **PLAN A5 → OTP**                   |
| Product tokens / sealed secrets / inactive gate          | **Strong** — do not regress                                                                        |
| `allows()` fail-closed / configure≠operate (kit + tests) | **Strong in kit**; **LIVE_OPS denylist incomplete (C1)**                                           |
| Merchant placement write                                 | **Gap (A3)** — merchants lack `products_on_websites.write`                                         |
| Docs / pack / Share                                      | Share sheet never returns server token; pack + OTP step-up **planned (A2/A5)**                     |
| `@ss/net` outbound                                       | **Strong SSRF posture**                                                                            |
| Thin / honesty gaps                                      | Password step-up UX · LIVE_OPS list · merchant write · OTP-required path for merchants without 2FA |

---

## 1. Portal identity — threat → control

| Threat                       | Control (where)                                                                                                                                                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Password guessing / stuffing | `createLoginThrottle` — 5 fails / 15m → lock (doubles to 24h); 50 fails / IP / 15m. HMAC’d ids. `platform/src/infra/auth.js` `DEFAULT_THROTTLE` · wired in `platform/src/portal.js` · used by `proveLogin` / `signIn` in `platform/src/modules/identity/accounts.js`            |
| Auth endpoint flood          | `AUTH_LIMIT` = 60/min on sign-in, 2FA, first-admin, forgot/reset, etc. `platform/src/modules/identity/routes.js`                                                                                                                                                                |
| Stolen session cookie        | HttpOnly + SameSite=Lax (+ Secure / `__Host-` when secure). `serializeCookie` in `platform/src/infra/auth.js`. Mutations need CSRF (`checkCsrf` + same-origin). Critical ops need **fresh confirm** (`accounts.confirm` → password + code if TOTP).                             |
| CSRF from evil site          | `checkCsrf` in `platform/src/infra/auth.js`; applied for cookie auth in `platform/src/infra/http.js` (~L615). Safe methods skip; mutations need `Sec-Fetch-Site: same-origin` and/or matching `Origin`. Combined with JSON-only bodies.                                         |
| Session fixation / long life | New session on sign-in; lifetime = Settings → Security → `sessionHours` → `config.sessionMs` (`platform/src/infra/config.js`). Password change / reset **revokes all** sessions (`sessions.revokeAll`). Sign-out revokes cookie + product dashboard sessions (`sessionsEnded`). |
| Admin/merchant confusion     | Separate cookie names by kind (`sessionCookieName(kind)`). One sign-in page; email → login kind. `signIn` in `accounts.js`.                                                                                                                                                     |
| First Owner race             | `POST /v1/auth/first-admin` only while `admins.count === 0`; unique `firstAdmin: true` index (`platform/src/modules/identity/schema.js`); lock around insert (`accounts.js` first-admin path). Rate-limited public.                                                             |
| Invite / setup link abuse    | Single-use setup tokens; merchant TTL 72h, admin 24h (`SETUP_TTL_MS` in `platform/src/modules/identity/core/tokens.js`). Suspended merchant setup refused.                                                                                                                      |
| Password reset enum          | `forgotPassword` always returns `reset_sent`; mail only if active login with password (`accounts.js`). Reset token 30m, single-use; revokes sessions.                                                                                                                           |
| 2FA bypass                   | TOTP sealed; step burned via conditional `lastStep` update (`checkSecondFactor` in `platform/src/modules/identity/repo.js`). Recovery codes hashed + pulled one-shot. Challenge path: `POST /v1/auth/sign-in/two-step`.                                                         |
| Require 2FA for admins       | Actor flag `twoStepRequired`; non-exempt routes → `two_step_required` (`sessionAuth` in `platform/src/infra/authenticators.js`).                                                                                                                                                |
| Suspended merchant           | Cannot sign in (`merchant_suspended`); setup/reset gated on `status === 'active'`.                                                                                                                                                                                              |
| Last Owner removed           | `keepAnOwner` in `platform/src/modules/identity/admins.js`.                                                                                                                                                                                                                     |
| Oversized bodies / hang      | Default `maxBodyBytes` 1 MiB (`http.js` / config); many routes tighter (catalog launch 1–8 KiB, website connections 4 KiB, system mail 400 KiB, commerce up to 256 KiB). `readBody` refuses over cap → `payload_too_large`.                                                     |
| Cross-tenant DB read/write   | `buildOps` merchant filter/guard (`platform/src/infra/db.js`); modules cannot touch foreign collections (`createPortal` composition).                                                                                                                                           |

### Admin vs merchant (identity plane)

|           | Admin                                    | Merchant                            |
| --------- | ---------------------------------------- | ----------------------------------- |
| Cookie    | admin session                            | merchant session                    |
| Roles     | `owner` \| `support` \| `finance`        | none (own `merchantId` only)        |
| Bootstrap | first-admin → Owner                      | Owner creates merchant + setup link |
| 2FA       | optional / can be required platform-wide | optional                            |
| Consoles  | `/admin/*`                               | merchant console                    |

---

## 2. Step-up today vs planned OTP (**A5**)

### Today (code)

| Mechanism                            | Behavior                                                                                                               | Paths                                                                                                                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accounts.confirm` / `confirmPerson` | Current **password** + TOTP/recovery **if** two-step on; failures hit login throttle                                   | `accounts.js` `confirm` / `proveLogin` · `identity/service.js` `confirmPerson` · `identity/routes.js` `confirmed` / `confirmedBody` · catalog/website `confirm` helpers |
| UI                                   | `PasswordConfirmDialog` always shows password; code when `showCode`                                                    | `packages/ui/src/PasswordConfirm.js` · `platform/src/console/views/confirm-change.js` · website token reveal/regenerate · connections · launch                          |
| Used for                             | Launch dashboard, reveal/regenerate **server** token, connection writes, admin invite/role/critical identity ops, etc. | catalog `routes.js`, website `routes.js`, identity routes                                                                                                               |

**Stolen session today:** without password (and OTP if enabled), attacker cannot open product configure launch, reveal server token, or mutate connections. Bar is real; UX trains password re-entry everywhere (**PLAN bans this as normal step-up**).

### Target (**PLAN §8 / A5**) — _planned, not implemented as primary_

| Action                                                                                                  | Step-up                                                                                   |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Open product configure · Share pack · reveal/regenerate server tokens · other critical Portal mutations | **OTP** (authenticator / recovery) — **not** password again                               |
| Sign-in                                                                                                 | Password (+ OTP if 2FA) — unchanged                                                       |
| Change password / enable 2FA                                                                            | May still require password **there**                                                      |
| Admins                                                                                                  | OTP-only dialogs for Open/critical (assume/require 2FA)                                   |
| Merchants without 2FA                                                                                   | Prompt to enable 2FA (or one-shot email OTP) — **do not** keep password-as-normal-step-up |

Acceptance: A2 pack + A5 e2e; server rejects pack/launch/critical without valid step-up proof.

---

## 3. RBAC — `can()`, Finance, UI vs server

**Source of truth:** `platform/src/infra/rbac.js` (`PERMISSIONS`, `ROLE_PERMISSIONS`, `MERCHANT_PERMISSIONS`, `can` / `permissionsFor`). Comment: _hiding a button is never enough_ — API checks every request (`http.js` `authorize` / route `permission`).

### Access matrix (Portal)

| Permission                                                                               | Owner     | Support | Finance | Merchant (own)                      |
| ---------------------------------------------------------------------------------------- | --------- | ------- | ------- | ----------------------------------- |
| overview / activity read                                                                 | ✓         | ✓       | ✓       | ✓                                   |
| merchants write / suspend / setup_link                                                   | ✓         | ✓       | —       | —                                   |
| merchants delete / two_step.turn_off / admins.manage / portal_settings / products.manage | ✓         | —       | —       | —                                   |
| websites write                                                                           | ✓         | ✓       | —       | —                                   |
| products_on_websites write                                                               | ✓         | ✓       | —       | **— today** (PLAN **A3** adds)      |
| tokens.manage (see install / browser tokens / whether server can be shown)               | ✓         | ✓       | —       | ✓                                   |
| tokens.reveal (clear server token / regenerate)                                          | ✓         | —       | —       | ✓                                   |
| dashboards.open (launch)                                                                 | ✓         | ✓       | —       | ✓                                   |
| products.read (catalog list for Add)                                                     | ✓         | ✓       | —       | —                                   |
| credits.add                                                                              | ✓         | —       | ✓       | —                                   |
| billing.read                                                                             | ✓         | ✓       | ✓       | ✓ (own; amounts shaped in commerce) |
| website_settings / connections read+write                                                | ✓         | ✓       | —       | ✓                                   |
| connections: **never return secret values** to console                                   | all roles |         |         |                                     |

**Finance restrictions (intentional):** no launch, no tokens, no connections write, no website settings write, no merchant mutate — only overview/activity, merchants/websites/products **read**, credits add, billing read. Launch routes require `dashboards.open` → Finance denied at API even if UI mis-renders.

**Support:** can manage tokens _tab_ and launch, **cannot** `tokens.reveal` (Owner/merchant only after confirm).

**UI hide vs server deny:**

| Layer                                               | Role                                                    |
| --------------------------------------------------- | ------------------------------------------------------- |
| `adminCan` (`platform/src/console/admin/rights.js`) | Menus/buttons/loaders (e.g. manage products on website) |
| Route `permission` + `c.authorize`                  | **Authoritative**                                       |
| Product `allows` / `checkStaff`                     | Authoritative on product servers                        |

---

## 4. Product side — tokens, tickets, allows, configure≠operate, catalog-inactive

### Browser vs server tokens

| Kind                | Storage / show                                                                                                                                  | Auth use                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Browser**         | Issued in clear for install snippets; public on site                                                                                            | Widget / visitor APIs (`auth: 'browser'`) — not staff configure            |
| **Server**          | Sealed with `secretBox` + AAD (`websiteId`, `productId`, `jti`, `purpose: 'server_token'`) in `platform/src/modules/identity/product-tokens.js` | Merchant server ↔ product; alone **cannot** change config (kit staff gate) |
| Reveal / regenerate | `tokens.reveal` + step-up confirm; Support lacks reveal                                                                                         | identity routes ~L401+                                                     |

Revocations: jtis in revocations collection; protocol `verifyToken` + `isRevoked`.

### Tickets (staff operate)

- Issue: `packages/protocol/src/tickets.js` — 15m TTL (`TICKET_TTL_SECONDS = 900`), binds `productId`, `websiteId`, user, **https/local origin**, permission list, `tid` (token id).
- Minted with **server** token on `POST /v1/tickets` — **not** with dashboard/configure cookie (`packages/app-kit/test/cross-credential.test.js`).
- Consume: ticket auth on operate routes; `allows(ctx, perm)` checks ticket.permissions.

### `allows()` fail-closed

```js
// packages/app-kit/src/staff.js
allows(ctx, permission) → ticket.permissions | staff.can | **false**
```

Bare server token ⇒ deny. Server routes must declare exactly one of `permission` | `staff: true` | `runtime: true` (`defineRoute` in `packages/app-kit/src/http/routes.js`). Documented in `packages/app-kit/API.md`.

### Configure ≠ operate

| Credential                   | Configure                                     | Live records                                                |
| ---------------------------- | --------------------------------------------- | ----------------------------------------------------------- |
| Portal cookie                | After launch + step-up → **dashboard** cookie | No                                                          |
| Dashboard / configure cookie | Yes (`/v1/dashboard/…`)                       | **No** (401 on ticket/inbox/notes — cross-credential tests) |
| Staff ticket                 | No                                            | Yes (listed perms, 15m)                                     |
| Server token alone           | No                                            | Only `runtime: true` routes                                 |
| Browser token                | No                                            | No                                                          |

**LIVE_OPS validate (C1 — done):** `packages/cli/src/validate/index.js` rejects `auth: 'dashboard'` paths whose segments include operate nouns (`orders`, `inbox`, `conversations`, `claims`, `campaigns`, `shipments`, `refunds`, `customers`, `payments`, `subscriptions`, `users`, `members`, `checkouts`, `carts`, `leads`, `subscribers`, `disputes`, `payouts`, `transactions`, `delivery`, …). **C2:** Notifications send + delivery log refuse the configure cookie (unit deny). **C3:** kit `API.md` matches fail-closed `allows()`.

### Catalog-inactive gate

- Connect starts **inactive** (`catalog/service.js`).
- Add to website refuses inactive (`commerce/.../products.js` `productActive`).
- Product fetch of connections with secrets: placement `added` + website active + **`product.status === 'active'`** else same 404 as missing (`connections.js` `forProduct` ~L632–634). Comment: _placement alone is not enough_.
- Rate: `FETCHES_PER_HOUR = 6` per product×website; `PRODUCT_FETCHES_PER_HOUR = 1200` per product (`connections.js`).

---

## 5. Staff on merchant site (Accounts roles + tickets)

| Concern               | Control                                                                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who is staff          | Accounts roles/permissions (`products/accounts/core/roles.js`); kit adds `settings.manage`, `connections.manage`, `audit.read` (`KIT_PERMISSIONS`)          |
| Calling product APIs  | Server token **+** `SS-Sign-In` (Accounts identity JWT); `checkStaff` verifies website audience / session / role (`staff.js`, Accounts `verifyStaffSignIn`) |
| Actor spoofing        | Old `SS-Actor-*` headers **ignored**; actor = verified sign-in subject                                                                                      |
| Cross-website sign-in | Audience = websiteId; wrong site → `invalid_sign_in` / audience                                                                                             |
| Ticket path           | Merchant’s own page: server mints ticket after checking _their_ session; ticket origin must match admin page origin                                         |
| Role `*`              | Owner-equivalent on that product                                                                                                                            |
| Two-step on roles     | Accounts can require 2FA per role (UI `roles-admin.js`) — product-side, not Portal RBAC                                                                     |

Portal admins are **not** site staff; they launch configure via Portal launch token, not Accounts tickets.

---

## 6. Show vs hide matrix

| Secret / material                       | Shown in console?                                                                 | How revealed                                                       | Never                                             |
| --------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------- |
| Session cookie                          | No (HttpOnly)                                                                     | —                                                                  | JS                                                |
| Password / passwordHash                 | Never                                                                             | —                                                                  | Presenters                                        |
| TOTP secret                             | Only during enroll confirm                                                        | `/v1/me/two-step/*`                                                | After confirm; sealed at rest                     |
| Recovery codes                          | Once at enable                                                                    | confirm response                                                   | Re-list plaintext                                 |
| Server product token                    | Hidden by default                                                                 | Owner/merchant + step-up reveal/regenerate                         | Support; Finance; list endpoints; blueprint       |
| Browser product token                   | Yes (install)                                                                     | Install / setup sheet                                              | — (public by design)                              |
| Website DB/storage/AI connection values | Status only in console (`connectionsView` / `can.write`)                          | Delivered to **product** via signed product API when active+placed | Console GET never returns plaintext               |
| Link tokens between products            | Same sealed delivery model                                                        | Product connections fetch                                          | Console                                           |
| Connect secret (Add product)            | Once at connect (Owner)                                                           | connect response; not re-listed                                    | Idempotent reconnect careful (`catalog` comments) |
| Encryption keys / signing keys          | Env / system                                                                      | Settings reseal flows                                              | API bodies                                        |
| Blueprint / Setup sheet                 | Settings: `set: true` instead of value if secret; lists run through `hideSecrets` | `packages/app-kit/src/blueprint.js`                                | Secret strings in summaries                       |
| Shared setup link                       | Optional values + install (browser tokens); **server token = issued flag only**   | Fragment key `#key=` (not logged); POST body                       | Server token plaintext (`catalog/setup.js`)       |
| Developer pack (planned A2)             | Pack file after OTP step-up                                                       | —                                                                  | Docs hub must not carry tokens (PLAN §8)          |
| Mail SMTP password                      | Sealed in system settings                                                         | Opened in-process for send                                         | Console list                                      |

---

## 7. Abuse scenarios → required control

| Scenario                                                         | Required control (present or gap)                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stolen Portal cookie**                                         | CSRF blocks cross-site POST; cannot launch/reveal/change connections without password(+OTP). **Gap:** password step-up phishing UX; A5 OTP strengthens “something you have.” Session lifetime / revoke-all on password change.                                                                                                                                 |
| **Stolen browser token**                                         | Widget/visitor surface only; no staff, no tickets, no connections. Rotate via regenerate if needed.                                                                                                                                                                                                                                                            |
| **Stolen server token**                                          | Runtime routes only if marked `runtime`; configure needs staff sign-in; tickets need attacker to also control staff identity or mint with stolen server **from allowed origin flows**. Revoke jti / regenerate. Cross-website: token bound to websiteId+productId.                                                                                             |
| **Stolen ticket**                                                | 15m TTL; origin-bound; permission subset; website+product bound. Short window.                                                                                                                                                                                                                                                                                 |
| **Stolen Accounts staff sign-in JWT**                            | Session checks + expiry; product verifies iss/aud/jwks; password change ends sessions (`endedByPassword`).                                                                                                                                                                                                                                                     |
| **Cross-website**                                                | Tokens/tickets/sign-ins carry websiteId; tenant DB guards; connections `forProduct` checks placement.                                                                                                                                                                                                                                                          |
| **SSRF** (Portal → product URL, connections probe, setup gather) | `@ss/net` `safeFetch` + `checkUrl`/`checkHost`/`classifyAddress`: block private/metadata/loopback/link-local/CGNAT/…; https required unless allowlisted; DNS rebinding via `guardedLookup`; redirects same-origin only; timeout + `maxBytes`. `packages/net/src/{policy,fetch,address,lookup}.js`. Production Portal: empty allowHosts for connections policy. |
| **DoS / hang**                                                   | Body caps; route rate limits (fail closed to local window if store fails — `http.js`); login throttle; connection fetch caps; setup gather timeout 5s / answer 512 KiB (`setup.js`); net timeouts.                                                                                                                                                             |
| **Import abuse**                                                 | `ss-import` is **ops CLI**, not a deployed Portal surface (PLAN ban: deploying `ss-import`). Abuse = whoever has env + network to product import endpoints. Mitigate: don’t expose import HTTP publicly; batch finish limits in `packages/importer/src/send.js`; treat credentials like server tokens.                                                         |
| **First-admin after Owners exist**                               | Refused (`conflict`); unique index.                                                                                                                                                                                                                                                                                                                            |
| **Share link leak**                                              | No server token; optional omit values/install; revoke; key only in fragment; open audit throttled 1/h.                                                                                                                                                                                                                                                         |
| **Inactive product still placed**                                | Secrets not delivered; add-product blocked for new placements.                                                                                                                                                                                                                                                                                                 |

---

## 8. Access matrix (who can what) — condensed

| Actor                 | Portal configure launch | Reveal server token   | Connections write          | Add product on site | Global connect | Credits  | Site staff operate   |
| --------------------- | ----------------------- | --------------------- | -------------------------- | ------------------- | -------------- | -------- | -------------------- |
| Owner admin           | ✓ + step-up             | ✓ + step-up           | ✓ + step-up                | ✓                   | ✓              | ✓        | via launch only      |
| Support               | ✓ + step-up             | —                     | ✓ + step-up                | ✓                   | —              | —        | via launch           |
| Finance               | —                       | —                     | —                          | —                   | —              | ✓ add    | —                    |
| Merchant              | ✓ + step-up             | ✓ + step-up           | ✓ + step-up                | **planned A3**      | —              | read own | —                    |
| Site staff (Accounts) | —                       | —                     | via product APIs + sign-in | —                   | —              | —        | tickets / SS-Sign-In |
| Developer             | —                       | pack after A2/A5      | —                          | —                   | —              | —        | —                    |
| Product (assertion)   | protocol routes         | receives sealed opens | N/A                        | N/A                 | N/A            | N/A      | N/A                  |

---

## 9. Beginner checklist (must not miss)

1. **Never trust UI hide** — every mutation has route `permission` or product `allows`/`checkStaff`.
2. **Cookie mutations** — Origin / Sec-Fetch-Site; no CSRF token by design (`checkCsrf`).
3. **Step-up** — today password(+OTP); plan OTP-only for Open/pack/critical (**A5**); still reject without proof server-side.
4. **Server token ≠ god mode** — configure needs staff; `allows` false without ticket/staff; `runtime` only when explicit.
5. **Configure cookie ≠ operate** — no tickets/inbox from dashboard session (tests in `cross-credential.test.js`).
6. **Inactive catalog** — no secret delivery even if placement row exists.
7. **Finance** — no launch, no tokens, no connections; verify with API not only nav.
8. **Support** — no `tokens.reveal`.
9. **Secrets in blueprint/share** — `set: true` / `hideSecrets`; share never includes server token string.
10.   **Outbound** — only through `@ss/net` policies; no raw `fetch` to merchant-controlled URLs.
11.   **Throttle + body caps** — auth and connection fetches are limited; don’t “fix by removing limits.”
12.   **Merchant write placement** — not shipped yet (**A3**); don’t document as done.
13.   **Docs hub** — public, no tokens (PLAN).
14.   **Import** — offline/ops only; not a Portal feature.
15.   **Reseal** — encryption key rotation reseals server tokens + TOTP (`product-tokens` / `accounts.resealTwoStep`).

---

## 10. Gaps to fix (tie to PLAN)

| Gap                                    | Evidence                                                                                                                                                                                                                                                                                                                 | PLAN                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| Password re-entry as normal step-up    | `accounts.confirm` + `PasswordConfirmDialog`                                                                                                                                                                                                                                                                             | **A5** (ban in §11)           |
| Merchant cannot place products         | `MERCHANT_PERMISSIONS` omits `products_on_websites.write`; commerce routes require it                                                                                                                                                                                                                                    | **A3**                        |
| Developer pack + one OTP step-up       | Pack API/button not the security baseline yet                                                                                                                                                                                                                                                                            | **A2** + **A5**               |
| LIVE_OPS segment list incomplete       | Fixed short list in `packages/cli/src/validate/index.js`                                                                                                                                                                                                                                                                 | **C1**                        |
| Notifications operate-on-configure     | Called out explicitly                                                                                                                                                                                                                                                                                                    | **C2**                        |
| Kit docs drift risk                    | API.md currently states fail-closed; keep honest as routes evolve                                                                                                                                                                                                                                                        | **C3**                        |
| Merchants without 2FA on critical path | Today falls back to password; target = force 2FA / email OTP                                                                                                                                                                                                                                                             | **A5**                        |
| Thin automated coverage hotspots       | Strong: `platform/test/auth.test.js`, `errors-rbac.test.js`, `rights.test.js`, `http.test.js`, kit `cross-credential.test.js`. Weaker relative to surface: end-to-end OTP step-up (doesn’t exist yet), full LIVE_OPS matrix per product, Finance negative e2e for every token/launch URL, share-link secret non-leak e2e | Quality §9 + A5/C acceptances |
| Docs / copy “lies”                     | Install-as-home / Setup-only ceremony (PORTAL-AUDIT) — UX honesty, not auth bypass; still confuses threat model (“where are tokens?”)                                                                                                                                                                                    | **A1/A4**                     |

---

## 11. Already strong — do not regress

From code + PLAN §7 “Shipped”:

- Typed credentials (browser / server / link / ticket / launch / dashboard) with kind checks in `@ss/protocol`
- Configure ≠ operate enforced in kit route rules + cross-credential tests
- `allows()` fail-closed (never bare server token)
- Catalog-inactive + placement gates on secret delivery
- Launch / token reveal / connection writes behind fresh confirmation
- Finance / Support token RBAC split (`tokens.manage` vs `tokens.reveal`; Finance no launch)
- CSRF + SameSite=Lax HttpOnly cookies + JSON-only bodies
- Login throttle (account + IP) with hashed identifiers
- Sealed secrets (`secretBox` AAD) for server tokens, connections, TOTP
- `@ss/net` SSRF defenses (address classification, lookup guard, redirect policy, size/time limits)
- Tenant repository guards; module collection ownership
- Share setup: fragment key, no server token, revoke, audit
- Session revoke-all on password reset/change; suspended merchant lockout
- Rate-limit store failure → local counting (deny open-relay), not “allow all”

---

## 12. Key file index

| Topic                                           | Path                                                |
| ----------------------------------------------- | --------------------------------------------------- |
| Portal composition                              | `platform/src/portal.js`                            |
| Sessions, cookies, TOTP helpers, throttle, CSRF | `platform/src/infra/auth.js`                        |
| HTTP authz, body, CSRF apply, rate limit        | `platform/src/infra/http.js`                        |
| RBAC                                            | `platform/src/infra/rbac.js`                        |
| Session authenticator / 2FA required            | `platform/src/infra/authenticators.js`              |
| Accounts / confirm / reset / first admin        | `platform/src/modules/identity/accounts.js`         |
| Identity routes                                 | `platform/src/modules/identity/routes.js`           |
| Product tokens                                  | `platform/src/modules/identity/product-tokens.js`   |
| Catalog launch / inactive                       | `platform/src/modules/catalog/{routes,service}.js`  |
| Connections + inactive + fetch caps             | `platform/src/modules/website/connections.js`       |
| Setup / share                                   | `platform/src/modules/catalog/setup.js`             |
| Staff / allows                                  | `packages/app-kit/src/staff.js`                     |
| Route auth rules                                | `packages/app-kit/src/http/routes.js`               |
| Blueprint hide                                  | `packages/app-kit/src/blueprint.js`                 |
| Tickets / tokens protocol                       | `packages/protocol/src/{tickets,tokens}.js`         |
| SSRF                                            | `packages/net/src/{fetch,policy,address,lookup}.js` |
| LIVE_OPS validate                               | `packages/cli/src/validate/index.js`                |
| Password step-up UI                             | `packages/ui/src/PasswordConfirm.js`                |
| PLAN security / A5 / C                          | `PLAN.md` §8, §10                                   |

---

_Planning audit only — no runtime code changed for this document._
