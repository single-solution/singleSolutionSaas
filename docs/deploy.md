# Deployment (Vercel)

The platform and the `ecommerceChatBot` product are **two separate Next.js apps in one repository**. Deploy them as **two Vercel projects** pointing at the same repo with different **Root Directories**.

## Prerequisites

- MongoDB Atlas cluster reachable from Vercel (Network Access: `0.0.0.0/0` or Vercel egress ranges)
- Upstash Redis database (REST API enabled)
- GitHub repository connected to Vercel
- Generated secrets: `JWT_SECRET`, `INTERNAL_API_SECRET`, `SSO_SIGNING_SECRET`, `PREVIEW_SIGNING_SECRET`, `EMBED_SIGNING_SECRET`, `CRON_SECRET`, config encryption key

## Projects

| Project | Root directory | `vercel.json` |
| --- | --- | --- |
| Platform (portal) | `.` | Root `vercel.json` (3 crons) |
| Chatbot product | `products/ecommerceChatBot` | Product `vercel.json` (3 crons) |

Framework: Next.js. Node: **20.x**.

## Environment variables — platform project

| Variable | Required | Notes |
| --- | --- | --- |
| `MONGODB_URI` | Yes | Atlas SRV string |
| `MONGODB_PLATFORM_DB` | No | Default `platform` |
| `JWT_SECRET` | Yes | 32+ random chars |
| `INTERNAL_API_SECRET` | Yes | **Must match product** |
| `SSO_SIGNING_SECRET` | Yes | **Must match product** |
| `PREVIEW_SIGNING_SECRET` | Yes | Preview iframe tokens |
| `EMBED_SIGNING_SECRET` | Yes | **Must match product** |
| `APP_URL` | Yes | Platform public URL |
| `UPSTASH_REDIS_REST_URL` | Yes | Upstash REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Yes | Upstash REST token |
| `CRON_SECRET` | Yes | `openssl rand -hex 24` |
| `CONFIG_ENCRYPTION_KEYS` | Yes | JSON `{"v1":"<base64-32-byte-key>"}` |
| `CONFIG_ENCRYPTION_ACTIVE_KEY_ID` | Yes | e.g. `v1` |
| `LOG_LEVEL` | No | `info` recommended in prod |
| `ERROR_TRACKING_DSN` | No | Optional |
| `BOOTSTRAP_ADMIN_EMAIL` | First run | Seed admin |
| `BOOTSTRAP_ADMIN_PASSWORD` | First run | Seed password |
| `SMTP_*` / `EMAIL_*` | No | Invite/recovery email |
| `ECOMMERCE_CHATBOT_PUBLIC_URL` | Recommended | Product URL for demo link |

## Environment variables — product project

| Variable | Required | Notes |
| --- | --- | --- |
| `MONGODB_URI` | Yes | Same cluster |
| `MONGODB_CHATBOT_DB` | No | Default `chatbot` |
| `PLATFORM_API_URL` | Yes | Platform public URL |
| `INTERNAL_API_SECRET` | Yes | **Must match platform** |
| `SSO_SIGNING_SECRET` | Yes | **Must match platform** |
| `EMBED_SIGNING_SECRET` | Yes | **Must match platform** |
| `UPSTASH_REDIS_REST_URL` | Yes | Same Upstash DB recommended |
| `UPSTASH_REDIS_REST_TOKEN` | Yes | |
| `CRON_SECRET` | Yes | **Must match platform** |
| `LOG_LEVEL` | No | |
| `ERROR_TRACKING_DSN` | No | |
| `DEMO_DATA_RETENTION_DAYS` | No | Default 30 |
| `PUBLIC_DEMO_PRODUCT_TOKEN` | Recommended | From `scripts/seed-demo.mjs` |
| `PRODUCT_CATALOG_SLUG` | No | Default `ecommerce-chatbot` |

> Mismatched `INTERNAL_API_SECRET`, `SSO_SIGNING_SECRET`, `EMBED_SIGNING_SECRET`, or `CRON_SECRET` breaks verification, SSO, embed sessions, and crons.

## Deploy steps

1. Import **platform** project, root `.`, add env vars, deploy. Note URL.
2. Import **product** project, root `products/ecommerceChatBot`, set `PLATFORM_API_URL` to platform URL, matching shared secrets, deploy. Note URL.
3. Update platform `APP_URL` and `ECOMMERCE_CHATBOT_PUBLIC_URL`; redeploy platform.
4. Update product catalog **Base URL** to product URL; run **Test connection**.

## Post-deploy wiring

1. Sign in as bootstrap admin.
2. Register chatbot; set Base URL to product deployment.
3. Test connection and sync config schema.
4. Set product defaults; publish config.
5. Create merchant, assign product on site (provisions tenant DB + token).
6. Embed on merchant site with `embed.js` and domain-bound token.
7. Open **advanced dashboard** via SSO to configure webhooks/automation.
8. Seed demo token for `/public-demo` if needed.

## Cron jobs (automatic on Vercel)

Platform:

| Schedule | Route |
| --- | --- |
| `*/5 * * * *` | `/api/crons/email-outbox` |
| `0 3 * * *` | `/api/crons/subscription-reconciliations` |
| `30 4 * * *` | `/api/crons/tenant-databases` |

Product:

| Schedule | Route |
| --- | --- |
| `*/5 * * * *` | `/api/crons/webhook-outbox` |
| `*/5 * * * *` | `/api/crons/usage-outbox` |
| `0 5 * * *` | `/api/crons/demo-cleanups` |

Vercel sends `Authorization: Bearer {CRON_SECRET}` automatically when `CRON_SECRET` is set.

## Migrations on production

Run from operator machine with production `.env` (never commit):

```bash
npm run migrate:config-secrets
npm run migrate:config-secrets -- --apply

npm run migrate:conversation-messages
npm run migrate:conversation-messages -- --apply

npm run reconcile:subscriptions
npm run reconcile:subscriptions -- --apply
```

Review JSON counts each dry-run. Repeat `--apply` until batch remainder is zero.

## Encryption key rotation

1. Generate new key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
2. Add to `CONFIG_ENCRYPTION_KEYS` JSON (keep old keys for decrypt).
3. Set `CONFIG_ENCRYPTION_ACTIVE_KEY_ID` to new id.
4. Redeploy platform.
5. Run `npm run migrate:config-secrets -- --apply` until all documents re-encrypted.
6. After verification, remove retired key id from JSON (only when no envelopes reference it).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| 401 on internal API | Align `INTERNAL_API_SECRET` |
| SSO redirect then 401 | Align `SSO_SIGNING_SECRET`; check clock skew |
| Widget works once then fails | Embed session expired (30 min); check `EMBED_SIGNING_SECRET` |
| Cron never runs | Confirm `CRON_SECRET` set; check Vercel cron logs |
| Health 503 redis | Upstash URL/token wrong or DB paused |
| Health 503 platform (product) | `PLATFORM_API_URL` wrong or platform down |
| Config secrets unreadable | Missing old key in `CONFIG_ENCRYPTION_KEYS` after rotation |
| Tenant data not isolated | Re-assign product to reprovision `dataDbName` |

## Custom domains

Add per Vercel project. Update `APP_URL`, `PLATFORM_API_URL`, product catalog Base URL, token allowed domains, and demo seed domain allowlist.

## Limits

- Serverless instances reset in-process caches; Redis is required for consistent rate limits.
- HTTPS enables `secure` cookies for sessions and admin SSO.
- Archived tenant DBs delete after 30-day retention via cron — plan backups before offboarding.
