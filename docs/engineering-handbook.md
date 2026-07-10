# Engineering handbook

Project-specific patterns contributors must follow. Universal rules live in the workspace rulebook; this file records **how this repo implements them**.

## API handler sequence (platform)

File: `lib/api/router.ts`

1. Parse route + method
2. Assign `X-Request-ID` via `lib/logging/requestContext.ts`
3. Rate limit (`lib/api/rateLimit.ts` + Redis)
4. Authenticate session (`lib/api/auth.ts`) or internal bearer
5. Validate body/query with Zod schemas from `lib/env.ts`
6. Call service layer (`lib/services/*`)
7. Return via `lib/api/responses.ts` helpers (`jsonOk`, `jsonError`)
8. Log errors through `lib/logging/logger.ts` with redaction

Cron routes use `lib/api/cronHandler.ts` + `lib/api/cronAuth.ts` instead of session auth.

## API handler sequence (product)

Mirror under `products/ecommerceChatBot/app/api/*`:

- Widget routes: product token or embed session bearer + CORS (`lib/api/cors.ts`)
- Admin routes: admin session cookie (`lib/admin/session.ts`)
- Internal routes: `INTERNAL_API_SECRET` constant-time compare
- Crons: shared cron handler pattern

## Caching and invalidation

| Data | Layer | Invalidation |
| --- | --- | --- |
| Token verification | Redis entitlement cache (product) | TTL ~short; subscription/token revoke |
| Rate limits | Redis sliding window | TTL per window |
| Mongoose connections | Process-global + tenant LRU (128) | Eviction by LRU; disconnect resets |
| Environment | Module cache (`loadEnvironment`) | Process restart |

No CDN caching on authenticated API responses (`Cache-Control: no-store`).

## Client/server boundary

- Portal browser client: `lib/api/client.ts` (never imports server-only modules)
- Product widget: public embed session only; secrets stay server-side
- `import "server-only"` on encryption, audit, tenant cleanup services

## Money / usage / quota

- Authoritative counters: `productusages` on platform
- Idempotency: `productusageevents.idempotencyKey` unique index
- Product enqueues via `UsageOutbox` when platform unreachable
- Quota denial still records event with `denied: true`

## Commerce-adjacent patterns

- Subscription lifecycle: `lib/services/subscriptionLifecycle.service.ts` — all status changes go through `transitionSubscription`
- Tenant binding: `lib/services/tenantBinding.service.ts` — single authority for `dataDbName`
- Product bridge: `lib/services/productBridge.ts` — outbound URL validation before fetch

## Config secrets

- Encrypt on save: `lib/security/configEncryption.ts`
- Mask on read: `lib/services/productConfig.service.ts`
- Deliver decrypted to product only in verification response assembly

## Outbox processors

Shared utilities: `lib/outbox/outboxShared.ts`

- `OUTBOX_BATCH_LIMIT`, lease TTL, exponential backoff
- `sanitizeOutboxError` strips credential-like substrings

## Migrations

- Location: `scripts/*.mjs`
- Convention: dry-run default, `--apply` writes, JSON summary, batch limits
- npm scripts in root `package.json` only (product has no migration scripts)

## OpenAPI

- Contract: `contracts/openapi.yaml`
- Validate: `npm run validate:openapi`
- Update contract in same PR as route shape changes

## Observability

- Always attach request id to logs/responses
- Never log raw tokens, SMTP passwords, or encryption keys
- `writeAuditLogSafe` for cron/system actors

## Testing policy (this remediation)

Integration gate runs lint, typecheck, build, OpenAPI lint, and `npm audit --audit-level=high`. Unit/e2e tests are out of scope for this pass.

## File references for new features

| Domain | Start here |
| --- | --- |
| Merchant team | `lib/services/merchantWorkflow.service.ts` |
| Subscription lifecycle | `lib/services/subscriptionLifecycle.service.ts` |
| Token issue/rotate | `lib/services/product.service.ts` |
| SSO | `lib/services/dashboardSso.service.ts` |
| Embed session | `products/ecommerceChatBot/lib/embed/session.ts` |
| Messages dual-read | `products/ecommerceChatBot/lib/chat/messageStorage.ts` |
| Tenant models | `products/ecommerceChatBot/lib/db/tenant.ts` |
