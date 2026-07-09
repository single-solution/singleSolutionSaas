# Deployment (Vercel)

The platform and the `ecommerceChatBot` product are **two separate Next.js apps in one repository**. Deploy them as **two Vercel projects** pointing at the same repo with different **Root Directories**.

## Prerequisites

- A MongoDB Atlas cluster reachable from Vercel. In Atlas → Network Access, allow Vercel: add `0.0.0.0/0` (any IP) for a quick start, or the documented Vercel egress ranges for a tighter setup.
- This repository pushed to GitHub (done: connected to your GitHub account).
- A Vercel account connected to that GitHub account.

## Projects

| Project | Root directory | Framework | Node |
|--------|----------------|-----------|------|
| Platform (portal) | `.` (repo root) | Next.js | 20.x |
| Chatbot product | `products/ecommerceChatBot` | Next.js | 20.x |

Vercel auto-detects Next.js; no `vercel.json` is required. Just set the Root Directory per project when importing.

## Environment variables

Set these in each Vercel project (Settings → Environment Variables), for the Production (and Preview) environments.

### Platform project

| Variable | Required | Value / notes |
|----------|----------|---------------|
| `MONGODB_URI` | Yes | Atlas SRV connection string |
| `MONGODB_PLATFORM_DB` | No | Defaults to `platform` |
| `JWT_SECRET` | Yes | Random string, 32+ chars (session signing) |
| `INTERNAL_API_SECRET` | Yes | Random string. **Must be identical** in the product project |
| `APP_URL` | Yes | The platform's public URL, e.g. `https://YOUR-PLATFORM.vercel.app` (used in invite links) |
| `BOOTSTRAP_ADMIN_EMAIL` | First run | Seeds the first admin when the users collection is empty |
| `BOOTSTRAP_ADMIN_PASSWORD` | First run | Seed admin password |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASSWORD` | No | For invite emails. Unset = portal shows a copyable invite link instead |
| `EMAIL_FROM` / `EMAIL_REPLY_TO` | No | Sender identity for invite emails |

### Chatbot product project

| Variable | Required | Value / notes |
|----------|----------|---------------|
| `MONGODB_URI` | Yes | Same Atlas cluster is fine (isolated DB via `MONGODB_CHATBOT_DB`) |
| `MONGODB_CHATBOT_DB` | No | Defaults to `chatbot` (separate database from the platform) |
| `PLATFORM_API_URL` | Yes | The platform's public URL, e.g. `https://YOUR-PLATFORM.vercel.app` |
| `INTERNAL_API_SECRET` | Yes | **Must match** the platform's value exactly |

> The two apps authenticate to each other with `INTERNAL_API_SECRET`. If they differ, token verification, config delivery, the agent inbox, and the admin SSO all fail with 401.

## Deploy steps

1. **Import the platform project** in Vercel from this GitHub repo, Root Directory `.`. Add the platform env vars. Deploy. Note its URL (e.g. `https://your-platform.vercel.app`).
2. **Import the product project** from the *same* repo, Root Directory `products/ecommerceChatBot`. Set `PLATFORM_API_URL` to the platform URL from step 1 and the matching `INTERNAL_API_SECRET`. Deploy. Note its URL (e.g. `https://your-chatbot.vercel.app`).
3. Set the platform's `APP_URL` to its own deployed URL and redeploy if you changed it.

## Post-deploy: connect the product

1. Sign in to the platform (bootstrap admin) at `https://your-platform.vercel.app`.
2. **Products → Register** the chatbot; set **Base URL** = the product's deployed URL (`https://your-chatbot.vercel.app`).
3. Open the product (`/products/ecommerce-chatbot`) → **Test connection & sync config**. This pulls the product's config schema over the internal API and confirms the two apps can talk.
4. Set **product defaults**, then create a merchant, a site, assign a plan, and issue an access token (add the merchant's site domain to the token's allowlist).
5. **Embed** on the merchant site:

```html
<script src="https://your-chatbot.vercel.app/embed.js" data-product-token="pk_live_xxx" async></script>
```

6. **Advanced dashboard:** on the product page click **Open advanced dashboard** to SSO into the product's `/admin` (overview, moderation, assistant tuning, webhooks, data).

## Notes & limits

- **HTTPS cookies:** production sets `secure` cookies; Vercel provides HTTPS, so sessions and the admin SSO cookie work out of the box.
- **In-memory state:** rate-limit counters and the product's token-verification cache live in process memory, so they reset per serverless instance. Correct for testing; move to Redis before serious scale.
- **Secrets at rest:** product config `secret` fields are not yet encrypted at rest (follow-up).
- **Custom domains:** add them per Vercel project. Update `APP_URL`, `PLATFORM_API_URL`, the product **Base URL** in the catalog, and each token's allowed domains accordingly.
