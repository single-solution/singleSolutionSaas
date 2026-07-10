# Setup

Two Next.js applications in one repo: **platform portal** (root) and **ecommerce chatbot** (`products/ecommerceChatBot`). No Docker. MongoDB Atlas + Upstash Redis for production-like local testing.

## Prerequisites

| Tool | Version |
| --- | --- |
| Node.js | 20+ |
| npm | latest |
| MongoDB Atlas | cluster with network access for your IP |
| Upstash Redis | optional locally; required for production deploys |

## Install

```bash
git clone <repo-url> singleSolutionSaas
cd singleSolutionSaas
cp .env.example .env
cp products/ecommerceChatBot/.env.example products/ecommerceChatBot/.env
```

Edit both `.env` files. Shared secrets (`INTERNAL_API_SECRET`, `SSO_SIGNING_SECRET`, `EMBED_SIGNING_SECRET`, `CRON_SECRET`) must match across deployables.

```bash
npm install
cd products/ecommerceChatBot && npm install && cd ../..
```

Run locally (two terminals):

```bash
npm run dev
# port 3000

cd products/ecommerceChatBot && npm run dev
# port 3002
```

## Environment variables — platform (`.env`)

| Variable | Required? | Purpose |
| --- | --- | --- |
| `MONGODB_URI` | Yes | MongoDB Atlas connection string |
| `MONGODB_PLATFORM_DB` | No (default `platform`) | Platform database name |
| `JWT_SECRET` | Yes | Session signing (min 32 chars) |
| `INTERNAL_API_SECRET` | Yes | S2S auth (min 16 chars); must match product |
| `SSO_SIGNING_SECRET` | Prod required | Admin SSO cookie signing; must match product |
| `PREVIEW_SIGNING_SECRET` | Prod required | Embed preview tokens |
| `EMBED_SIGNING_SECRET` | Prod required | Platform-side embed helpers; must match product |
| `BOOTSTRAP_ADMIN_EMAIL` | No | First platform admin when users collection empty |
| `BOOTSTRAP_ADMIN_PASSWORD` | No | Bootstrap password (min 8 chars) |
| `APP_URL` | Prod required | Public portal URL for invite/recovery links |
| `UPSTASH_REDIS_REST_URL` | Prod required | Upstash REST endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | Prod required | Upstash REST token |
| `CRON_SECRET` | Prod required | Bearer secret for cron routes (min 16 chars) |
| `LOG_LEVEL` | No | `fatal` / `error` / `warn` / `info` / `debug` |
| `ERROR_TRACKING_DSN` | No | Optional error tracking endpoint |
| `ECOMMERCE_CHATBOT_PUBLIC_URL` | No | Chatbot origin for login demo link |
| `CONFIG_ENCRYPTION_KEYS` | Prod required for secrets | JSON map of key id -> base64 32-byte key |
| `CONFIG_ENCRYPTION_ACTIVE_KEY_ID` | Prod required for secrets | Active key id for new envelopes |
| `SMTP_HOST` | No | SMTP host; unset disables email |
| `SMTP_PORT` | No (default `587`) | SMTP port |
| `SMTP_SECURE` | No | `true` for TLS |
| `SMTP_USER` | No | SMTP username |
| `SMTP_PASSWORD` | No | SMTP password |
| `EMAIL_FROM` | No | Sender address |
| `EMAIL_REPLY_TO` | No | Reply-to address |

### Generate encryption keys

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Set in `.env` (single line JSON):

```
CONFIG_ENCRYPTION_KEYS={"v1":"PASTE_BASE64_KEY_HERE"}
CONFIG_ENCRYPTION_ACTIVE_KEY_ID=v1
```

### Generate cron secret

```bash
openssl rand -hex 24
```

## Environment variables — product (`products/ecommerceChatBot/.env`)

| Variable | Required? | Purpose |
| --- | --- | --- |
| `MONGODB_URI` | Yes | Same Atlas cluster |
| `MONGODB_CHATBOT_DB` | No (default `chatbot`) | Product shared connection database name |
| `PLATFORM_API_URL` | Yes | Platform public URL (e.g. `http://localhost:3000`) |
| `INTERNAL_API_SECRET` | Yes | Must match platform |
| `SSO_SIGNING_SECRET` | Prod required | Must match platform |
| `EMBED_SIGNING_SECRET` | Prod required | Embed visitor session signing |
| `UPSTASH_REDIS_REST_URL` | Prod required | Upstash REST endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | Prod required | Upstash REST token |
| `CRON_SECRET` | Prod required | Must match platform cron auth |
| `LOG_LEVEL` | No | Log verbosity |
| `ERROR_TRACKING_DSN` | No | Optional error tracking |
| `DEMO_DATA_RETENTION_DAYS` | No (default 30) | Public demo tenant cleanup age |
| `PUBLIC_DEMO_PRODUCT_TOKEN` | No | Restricted demo token from seed script |
| `PRODUCT_CATALOG_SLUG` | No (default `ecommerce-chatbot`) | Catalog slug for tenant listing |
| `CHAT_ASSISTANT_ENABLED` | No | Override assistant on/off |
| `CHAT_ASSISTANT_NAME` | No | Override assistant display name |
| `CHAT_WELCOME_MESSAGE` | No | Override welcome message |

## Scripts — platform root

| Command | Purpose |
| --- | --- |
| `npm run dev` | Development server (port 3000) |
| `npm run build` | Production build |
| `npm run start` | Run production build |
| `npm run lint` | ESLint (max warnings zero) |
| `npm run typecheck` | TypeScript check |
| `npm run validate:openapi` | Lint OpenAPI contract |
| `npm run migrate:merchants` | Legacy org -> merchant migration (dry-run) |
| `npm run migrate:config-secrets` | Encrypt config secrets (dry-run) |
| `npm run migrate:conversation-messages` | Backfill Message collection (dry-run) |
| `npm run reconcile:subscriptions` | Repair subscription drift (dry-run) |
| `npm run seed:chatbot-config` | Seed chatbot config schema |

Append `--apply` to migration commands to write changes.

## Migration order and rollback

**Order (greenfield with legacy data):**

1. `npm run migrate:merchants -- --apply` (only if pre-merchant collections exist)
2. `npm run migrate:config-secrets -- --apply` (repeat until `remainingAfterBatch` is 0)
3. `npm run migrate:conversation-messages -- --apply` (repeat per tenant batch)
4. `npm run reconcile:subscriptions -- --apply` (repeat until no remaining batches)

**Rollback notes:**

- Config migration: keep old keys in `CONFIG_ENCRYPTION_KEYS` to decrypt prior envelopes; re-run with previous `CONFIG_ENCRYPTION_ACTIVE_KEY_ID` to re-encrypt.
- Message migration: embedded arrays remain; unset `messagesMigratedAt` on a conversation to revert read path to embedded (Message rows become orphaned but harmless).
- Subscription reconciliation: review `lifecycleHistory` before manual revert; token revocations are not auto-reversed.

**Rule:** Never run `--apply` against production without a dry-run review of JSON output counts.

## API contract

See [`docs/api.md`](./api.md) and [`contracts/openapi.yaml`](../contracts/openapi.yaml).

## First login

1. Set bootstrap credentials in platform `.env`.
2. Start both apps.
3. Open `http://localhost:3000/login`.
4. Sign in as platform admin.
5. Register chatbot product with Base URL `http://localhost:3002`.
6. Run **Test connection & sync config** on the product page.

## Public demo

```bash
node --env-file=.env scripts/seed-demo.mjs
```

Copy the printed token into product `.env` as `PUBLIC_DEMO_PRODUCT_TOKEN`. Set platform `ECOMMERCE_CHATBOT_PUBLIC_URL=http://localhost:3002`.

## Common issues

| Symptom | Fix |
| --- | --- |
| `Invalid environment` on start | Check `.env`; no CRLF in values; `JWT_SECRET` min 32 chars |
| Product 401 on verify | `INTERNAL_API_SECRET` must match exactly on both apps |
| SSO fails in production | Set matching `SSO_SIGNING_SECRET` on both deployables |
| Embed session invalid | Set matching `EMBED_SIGNING_SECRET` on both deployables |
| Rate limits inconsistent locally | Expected without Redis; set Upstash vars for distributed limits |
| Config save 503 | Set `CONFIG_ENCRYPTION_KEYS` and `CONFIG_ENCRYPTION_ACTIVE_KEY_ID` |
| Cron 401 | `CRON_SECRET` must match Authorization bearer |
| `git diff --check` whitespace | Re-save file with LF line endings (notably `tenant.ts`) |

## Production

See [`docs/deploy.md`](./deploy.md) and [`docs/go-live.md`](./go-live.md).
