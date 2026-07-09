# Single Solution Portal

Company portal for **Single Solution** to manage merchants and register SaaS products. One application, one login page: platform admins and merchants sign in here.

**This repo does not host SaaS products.** Products (for example AI chat) are separate apps/repos. They integrate with this portal via product access tokens and internal verification endpoints.

## Documentation

- [Setup](docs/setup.md)
- [Architecture](docs/architecture.md)

## Surfaces

Routes are unified and role-aware (no separate `/admin` or `/merchant` prefixes); what each role sees is restricted by permission.

| Route | Who | Purpose |
|-------|-----|---------|
| `/login` | Everyone | Shared sign-in |
| `/accept-invite` | Invited users | Set a password from a one-time invite link |
| `/` | All signed-in users | Role-aware dashboard. Admin: platform KPIs, merchants list, onboarding. Merchant: spend, sites overview, activity |
| `/merchants/{id}` | Platform admin | One merchant: its sites, per-site products, activity |
| `/merchants/{id}/sites/{siteId}` | Platform admin | Product control plane for one site; conversations parent |
| `/products` | Platform admin | Register products, define plans, scopes, and quotas; activate/deactivate |
| `/sites` | Merchant users | List and create their sites |
| `/sites/{siteId}` | Merchant users | Product control plane for one site: plans, tokens, usage, billing; conversations parent |
| `/settings` | All signed-in users | Account settings: update name, change password (admins can also change email) |

## Domain

1. **Users** - platform admins and merchant accounts (email + password, session cookie).
2. **Merchants** - tenants; slug is globally unique. Each merchant can be assigned multiple products. There is no organization concept.
3. **Sites** - deployments under a merchant (name + primary domain); slug unique within the merchant. Every merchant gets a "Default site" at onboarding.
4. **Products** - catalog of isolated SaaS products, registered and managed by platform admins. Each product defines its own plans, access scopes, and per-metric quotas. Products remain fully isolated (own repo, own database); the platform only manages access, usage, and billing.
5. **Subscriptions** - one per (merchant + product + site): the selected plan, `active`/`suspended` status, and optional scope/quota overrides. A single product can run on many sites, each on its own plan. A site with no subscription for a product sees it as `unassigned`.
6. **Product access tokens** - issued per (site + product); shown once at creation. A token both proves entitlement and is the runtime credential the product application verifies. Token scopes are captured from the plan at issue time.
7. **Product usage** - monthly aggregate per (site + product + metric). Products report usage events to the platform; the platform meters against plan quotas and shows the estimated monthly cost.
8. **Audit logs** - merchant-scoped actions (product plan changes, token issue/revoke, site changes).

## Products (access, usage, billing)

Products are isolated: they live in separate apps with their own databases and are never imported by the portal. The portal is the control plane.

**Roles**

This is a **hybrid control plane**: platform admins own all product configuration and provisioning; merchants get read-only visibility into their stats, keys, and billing. Advanced product operations happen inside the product's own admin dashboard, reached by an admin SSO deep-link.

| Action | Platform admin | Merchant (owner/admin) | Merchant (member) |
|--------|----------------|------------------------|-------------------|
| Onboard merchants | Yes | No | No |
| Create sites | Yes | Yes | No |
| Register product / edit plans / activate | Yes | No | No |
| Assign or change a product's plan on a site | Yes | No | No |
| Suspend / resume a product on a site | Yes | No | No |
| Issue / revoke access tokens | Yes | No | No |
| View and copy access keys | Yes | Yes | Yes |
| View usage and billing estimate | Yes | Yes | Yes |
| Read product conversations (agent inbox) | Yes | Yes | Yes |
| Reply to product conversations | Yes | Yes | No |
| Edit / publish product config (defaults + per-site) | Yes | No | No |
| Enforce a default across all sites | Yes | No | No |
| Preview draft config / run test harness | Yes | No | No |
| Open product's advanced dashboard (SSO) | Yes | No | No |

**Rules**

- A plan must be assigned (`planCode` set) and the subscription `active` before tokens can be issued.
- Suspending a subscription or revoking a token stops the product from verifying immediately.
- Token scopes are frozen from the plan at issue time; changing the plan later does not rewrite existing tokens.
- **Every token carries an embed-domain allowlist.** The product token is a publishable key that lives in the merchant's page, so it is bound to specific domains. A token with **no** domains is blocked from every origin (secure by default); domains support exact hosts (`shop.com`) and wildcards (`*.shop.com`). Domains are set at issue time and cannot be edited — reissue to change them.
- Usage is aggregated per calendar month (`YYYY-MM`, UTC). A metric is over quota when `used > limit`; metrics with no plan quota are always within quota.
- Estimated cost is the plan's `priceMonthly` in the plan currency (metering-only; no payment provider yet).

**Agent inbox**

- Merchants read and reply to a product's customer conversations at `/sites/{siteId}/products/{slug}/conversations` (admins use the equivalent `/merchants/{id}/sites/{siteId}/products/{slug}/conversations` path).
- The portal never touches the product's database. It calls the product's internal conversation endpoints over HTTP using `INTERNAL_API_SECRET`, addressing the product at its catalog `baseUrl`. A product with no `baseUrl` set cannot surface conversations.
- Conversations are scoped by `siteId`: the portal only ever requests the threads for that site. Replies post as an `agent` message, pause the product's assistant (a human has taken over), and increment the visitor's unread counter.

## Product configuration

Each product declares a **config schema** (sections of typed fields), pulled into the catalog when an admin runs "Test connection" on the product. The portal renders a generic editor from that schema, so a new product needs no bespoke portal UI. **Only platform admins edit config.** Config exists at two scopes, both with a `draft` and a `published` copy:

- **Product defaults** (one per product): baseline values every site inherits. Edited on the product page (`/products/{slug}`).
- **Per-site overrides** (per subscription): a site's own values, edited on the admin site view. A site only stores fields it actually overrides; everything else **inherits** the product default.

- **Field types:** `string`, `text`, `number`, `boolean`, `select`, `color`, `url`, `secret`, `list`. Sections have a `kind` of `settings`, `connection`, or `integration`.
- **Draft → publish:** admins edit the draft; the product only ever reads the **published** copy. "Publish" copies draft to published, bumps `version`, and writes an audit log. An "Unpublished changes" badge shows when draft differs from published.
- **Inheritance & precedence** (per field): enforced product default > per-site value > product default > schema default. In the site editor each field shows **Inherited**, **Overridden** (with a **Reset** to drop the override), or **Enforced by product**.
- **Enforce:** an admin can enforce a product default so no site can override it (the field is locked across all sites). This replaces the old per-field merchant lock.
- **Delivery is pull-based:** the effective (defaults folded under site overrides) published values ride along in the token verification response the product already calls, so publishing propagates within the product's short verification cache window. There is no push.
- **Secrets are write-only:** `secret` fields are never returned to the browser (masked as `{ set }`). Saving an empty secret keeps the stored value; only a non-empty entry replaces it. Real secret values are delivered to the product only over the server-to-server verification channel. **Note:** secrets are not yet encrypted at rest (follow-up).

**Live preview & test harness** (admin only):

- **Preview:** the portal mints a short-lived signed preview token (15 min) and embeds the product at `{{baseUrl}}/embed?preview={{token}}` in an iframe. The product fetches the **draft** (defaults folded) config for that token and renders an appearance-only preview (no chat is sent or stored). Requires the product to have a `baseUrl`.
- **Harness:** products declare `testActions`; the portal proxies a dry-run to the product's `POST /api/internal/test` with the action, sample input, and the site's draft config, and shows the result. Nothing is persisted. For the chatbot, `assistant-reply` previews the automated reply for a sample customer message.

Only **basic** settings live in the portal (chatbot: enabled, assistant name, welcome, theme). Advanced automation (auto-reply rules, handoff/fallback, escalation keywords) and webhook connections live in the product's own admin dashboard (see below).

## Advanced product dashboard (admin SSO)

Deep product operations run inside the product itself, reached by an admin-only single sign-on deep-link from the product page ("Open advanced dashboard"):

- **SSO handshake:** the portal mints a ~2-minute HS256 token (signed with `INTERNAL_API_SECRET`, scope `admin-dashboard`) and opens `{{baseUrl}}/admin/sso?token=...`. The product verifies it and sets a short-lived (~8h) httpOnly admin session cookie, then redirects into `/admin`. No product-side password exists; the dashboard is reachable only via the portal.
- **Site switcher:** the product lists its subscribed sites via the platform's internal `product-sites` endpoint and scopes every view to the selected `siteId`.
- **Chatbot dashboard areas:** Overview + analytics (volume, status mix, average first response), Conversation moderation (search/filter, thread view, agent reply, resolve/reopen, mute/unmute assistant), Assistant tuning (advanced automation stored in the product), Webhook diagnostics (delivery logs + send-test), and a read-only raw data browser (visitors, conversations, messages).
- **Webhooks:** the chatbot fires signed webhooks (`X-Chatbot-Signature`, HMAC-SHA256) on new conversations and customer messages, logging every attempt for the diagnostics view. The webhook URL/secret are managed in the product dashboard, not the portal.

## Merchant onboarding

There is no public sign-up. A platform admin creates each merchant from the dashboard (`/`). Admins never set or see a merchant password; the merchant sets their own via a one-time invite link.

- **One step creates** the owner **user** (email + name, `status: "invited"`, no password), the **merchant** (linked by an `owner` membership), and a **Default site**, plus a one-time invite token (SHA-256 hashed at rest, 7-day expiry).
- **Invite delivery:** the portal emails the owner a set-password link (`/accept-invite?token=...`) via SMTP. *Conditional:* if SMTP or `APP_URL` is not configured, creation still succeeds and the admin gets a copyable one-time link to relay manually.
- **Resend:** while a merchant's owner is still `invited`, the admin sees a **Pending** badge and an **Invite** action that issues a fresh token, re-sends the email, and copies the new link. Issuing a new token invalidates the previous one.
- The merchant opens the link, sets a password (min 8 chars), which activates the account (`status: "active"`), bumps `sessionVersion`, clears the token, and signs them in.
- **Rule:** invited users cannot sign in until they accept; the invite token is single-use and rejected once expired or consumed.
- **Rule:** the merchant slug is auto-generated from the name and made globally unique (a numeric suffix is appended on clash) — it is never entered by the admin. Site slugs are auto-generated and unique within the merchant.
- **Rule:** owner email is globally unique — a clash returns 409.

## Embedding the widget (merchant sites)

Merchants add one line to their site:

```html
<script src="https://YOUR-PRODUCT-HOST/embed.js" data-product-token="pk_live_xxx" async></script>
```

- `embed.js` injects a floating iframe (`/embed?token=...`) hosted by the product; the widget resizes the frame between the launcher bubble and open panel so it never blocks clicks on the host page.
- **Framing is gated per token:** the embedding site's host (from the iframe `Referer`) must be in the token's allowed domains, so a stolen token cannot be framed on an unlisted site. Fails closed in production when the host is missing or not allowed.
- React sites may instead mount the component directly; those calls are cross-origin and are gated by the same domain allowlist via `Origin`/CORS.

## Product integration (internal endpoints)

Product applications authenticate server-to-server with `Authorization: Bearer {INTERNAL_API_SECRET}`.

| Endpoint | Purpose |
|----------|---------|
| `POST /api/internal/product-tokens/verifications` | Verify a product access token; returns merchant, site, plan, effective scopes, quotas, current usage, `withinQuota`, and the site's **published** `config` |
| `POST /api/internal/product-usage` | Report usage; body `{ token }` or `{ siteId, productSlug }` plus `{ metric, quantity }`; increments the current month and returns the new total and `withinQuota` |
| `POST /api/internal/product-config` | Resolve **draft** config (defaults folded) for a valid preview token (`{ previewToken }`); returns `{ siteId, productSlug, config }`. Used only by the product's preview page |
| `GET /api/internal/product-sites?slug=` | List sites subscribed to a product (`[{ siteId, name, merchantName }]`) for the product dashboard's site switcher |

For the agent inbox, preview, harness, dashboard schema sync, and SSO site switcher the direction reverses: the portal calls the **product's** endpoints (same `INTERNAL_API_SECRET`) at its catalog `baseUrl` — `GET /api/internal/conversations`, `GET /api/internal/conversations/{id}`, `POST /api/internal/conversations/{id}/messages` (all scoped by `siteId`), `GET /api/internal/config-schema` (schema sync), and `POST /api/internal/test` (dry-run harness). The admin SSO deep-link is a browser redirect to the product's `GET /admin/sso`, not a server-to-server call.

## Bootstrap

On first API request, if the users collection is empty and `BOOTSTRAP_ADMIN_EMAIL` + `BOOTSTRAP_ADMIN_PASSWORD` are set, a platform admin user is created.

## Migration

Legacy organization-model data is migrated to the merchant + site model with `npm run migrate:merchants` (see `scripts/migrate-to-merchants-sites.mjs`). It renames collections/fields, creates one default site per merchant, backfills `siteId`, and remaps chatbot conversations. It is idempotent.

## Limits

| Item | Limit |
|------|-------|
| Merchant slug | 2-80 chars, lowercase kebab-case, globally unique |
| Site slug | 2-80 chars, unique per merchant |
| Session | 7 days, httpOnly cookie |
| Product / plan / scope code | 2-80 chars, lowercase kebab-case |
| Plan scopes / quotas | up to 50 scopes, 30 quotas per plan |
| Product access token name | 1-80 chars |
| Usage report quantity | 1 to 1,000,000 per event |
