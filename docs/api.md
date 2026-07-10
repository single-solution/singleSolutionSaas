# API overview

The platform portal and ecommerce chatbot product share one OpenAPI contract at [`contracts/openapi.yaml`](../contracts/openapi.yaml). That file is the source of truth for route shapes across browser clients, internal product bridges, Vercel cron jobs, and health probes.

## Deployables

| Deployable | Base path | Contract tag prefix |
| ---------- | --------- | ------------------- |
| Platform portal | `/api/*` | `Platform` |
| Ecommerce chatbot product | `/api/*` on the product host | `Product` |

## Authentication surfaces

| Surface | Mechanism | Used by |
| ------- | --------- | ------- |
| Session cookie | `portal_session` JWT cookie | Portal UI |
| Internal bearer | `Authorization: Bearer {INTERNAL_API_SECRET}` | Product bridge, chatbot server |
| Cron bearer | `Authorization: Bearer {CRON_SECRET}` | Vercel scheduled jobs only |
| Product access token | Publishable widget token in body/query | Widget, embed, demo |
| SSO exchange code | One-time code exchanged server-side | Product admin SSO |
| Preview token | Signed preview token in body | Embed preview |

## Response conventions

- Success responses return domain JSON directly unless noted in the contract.
- Errors use `{ "error": "message" }` with semantic HTTP status codes.
- Every API response includes `X-Request-ID` for correlation.
- Authenticated responses use `Cache-Control: no-store`.
- Public health endpoints use `Cache-Control: public, max-age=60`.

## Cron jobs

Platform (`vercel.json` at repo root):

| Schedule | Route | Purpose |
| -------- | ----- | ------- |
| Every 5 minutes | `POST /api/crons/email-outbox` | Deliver queued invite/recovery email |
| Daily 03:00 UTC | `POST /api/crons/subscription-reconciliations` | Repair subscription drift |
| Daily 04:30 UTC | `POST /api/crons/tenant-databases` | Drop archived tenant DBs after retention |

Product (`products/ecommerceChatBot/vercel.json`):

| Schedule | Route | Purpose |
| -------- | ----- | ------- |
| Every 5 minutes | `POST /api/crons/webhook-outbox` | Deliver tenant webhook outbox batches |
| Every 5 minutes | `POST /api/crons/usage-outbox` | Mirror usage to platform |
| Daily 05:00 UTC | `POST /api/crons/demo-cleanups` | Purge stale public demo tenant data |

All cron routes fail closed without an exact `Bearer CRON_SECRET` match.

## Health

| Deployable | Route | Checks |
| ---------- | ----- | ------ |
| Platform | `GET /api/health` | Mongo ping, Redis ping |
| Product | `GET /api/health` | Mongo ping, Redis ping, platform reachability |

Unhealthy dependencies return HTTP 503 with per-check status and timestamp.

## Contract maintenance

- API route changes must update `contracts/openapi.yaml` in the same change.
- Breaking changes require a version bump or documented deprecation window in the contract `info` section.
