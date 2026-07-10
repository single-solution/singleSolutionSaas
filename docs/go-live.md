# Go-live runbook

Pre-launch checklist for the platform portal and ecommerce chatbot product on Vercel.

## 1. Infrastructure

- [ ] MongoDB Atlas production cluster provisioned with backups enabled
- [ ] Atlas Network Access allows Vercel egress
- [ ] Upstash Redis database created (REST API credentials saved)
- [ ] Two Vercel projects created (platform root `.`, product `products/ecommerceChatBot`)

## 2. Secrets (generate fresh; never reuse dev values)

```bash
openssl rand -hex 32          # JWT_SECRET
openssl rand -hex 24          # INTERNAL_API_SECRET, SSO_SIGNING_SECRET, etc.
openssl rand -hex 24          # CRON_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # encryption key
```

| Secret | Platform | Product | Must match |
| --- | --- | --- | --- |
| `INTERNAL_API_SECRET` | Yes | Yes | Yes |
| `SSO_SIGNING_SECRET` | Yes | Yes | Yes |
| `EMBED_SIGNING_SECRET` | Yes | Yes | Yes |
| `CRON_SECRET` | Yes | Yes | Yes |
| `JWT_SECRET` | Yes | No | — |
| `PREVIEW_SIGNING_SECRET` | Yes | No | — |
| `CONFIG_ENCRYPTION_*` | Yes | No | — |

## 3. Deploy

1. Deploy platform with full env table from [`deploy.md`](./deploy.md).
2. Deploy product with `PLATFORM_API_URL` pointing at live platform URL.
3. Redeploy platform with final `APP_URL` and `ECOMMERCE_CHATBOT_PUBLIC_URL`.

## 4. Bootstrap admin

1. Set `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` on platform (first deploy only).
2. Sign in; confirm `/dashboard` loads.
3. Remove bootstrap password from env after first login (optional hardening).

## 5. Product registration

1. Products -> Register `ecommerce-chatbot` (or catalog slug).
2. Base URL = product Vercel URL.
3. **Test connection & sync config** succeeds.
4. Configure product defaults; **Publish**.

## 6. Data migrations (production)

Run dry-run first; capture JSON output.

```bash
npm run migrate:config-secrets
npm run migrate:config-secrets -- --apply

npm run migrate:conversation-messages
npm run migrate:conversation-messages -- --apply

npm run reconcile:subscriptions
npm run reconcile:subscriptions -- --apply
```

Repeat `--apply` until batch remainder fields are zero.

## 7. Smoke tests

| Check | Expected |
| --- | --- |
| `GET /api/health` (platform) | `healthy`, mongo + redis ok |
| `GET /api/health` (product) | `healthy`, mongo + redis + platform ok |
| Create merchant + invite email | Email outbox delivers or copyable link shown |
| Assign chatbot on site | Tenant DB provisioned; token issued |
| Embed on allowed domain | Widget opens; messages send |
| Embed on disallowed domain | Blocked in production |
| Agent inbox reply | Message appears; assistant paused |
| Advanced dashboard SSO | One-time code works; admin cookie set |
| Usage report duplicate idempotency key | Same response; no double count |
| Cron manual trigger | `curl -H "Authorization: Bearer $CRON_SECRET" -X POST .../api/crons/email-outbox` returns 200 |

## 8. Observability

- [ ] `LOG_LEVEL=info` on both projects
- [ ] `ERROR_TRACKING_DSN` set if using external tracking
- [ ] Verify `X-Request-ID` present on API responses
- [ ] Vercel cron execution logs show success after first scheduled run

## 9. Post-launch monitoring (first 48h)

- Email outbox pending count stays near zero
- Usage outbox errors logged without credential leakage
- No spike in 401 on `/api/internal/product-tokens/verifications`
- Subscription reconciliation cron reports zero or expected drift only

## Rollback

- **Bad deploy:** revert Vercel deployment to previous build.
- **Config encryption mistake:** restore prior `CONFIG_ENCRYPTION_KEYS` env and redeploy before re-running migration.
- **Message migration issue:** stop `--apply`; dual-read still serves embedded arrays.
- **Accidental offboarding:** use **Restore merchant** within 30-day retention window.

## Deferred (intentional)

- Payment provider integration (billing is estimate-only)
- Automated DNS TXT domain verification (current check is HTTP reachability)
- Second-pass removal of embedded conversation messages after Message migration verified
