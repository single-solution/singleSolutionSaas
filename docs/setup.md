# Setup

Single Next.js application. No Docker. MongoDB Atlas.

## Prerequisites

| Tool        | Version |
| ----------- | ------- |
| Node.js     | 20+     |
| npm or pnpm | latest  |

## Install

```bash
git clone <repo-url> singleSolutionSaas
cd singleSolutionSaas
cp .env.example .env
```

Edit `.env` with your Atlas URI and secrets.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Environment variables

| Variable                       | Required?                      | Purpose                                                                     |
| ------------------------------ | ------------------------------ | --------------------------------------------------------------------------- |
| `MONGODB_URI`                  | Yes                            | MongoDB Atlas cluster connection string                                     |
| `MONGODB_PLATFORM_DB`          | No (default `platform`)        | Database name for portal data                                               |
| `JWT_SECRET`                   | Yes                            | Session signing (min 32 chars)                                              |
| `INTERNAL_API_SECRET`          | Yes                            | Auth for internal site-key verification API                                 |
| `BOOTSTRAP_ADMIN_EMAIL`        | No                             | First platform admin email when DB is empty                                 |
| `BOOTSTRAP_ADMIN_PASSWORD`     | No                             | First platform admin password (min 8 chars)                                 |
| `APP_URL`                      | No (required to email invites) | Public base URL used to build invite links                                  |
| `SMTP_HOST`                    | No                             | SMTP server host; unset disables email sending                              |
| `SMTP_PORT`                    | No (default `587`)             | SMTP server port (`465` implies TLS)                                        |
| `SMTP_SECURE`                  | No                             | `true` to force TLS; defaults to `true` only on port 465                    |
| `SMTP_USER`                    | No                             | SMTP auth username                                                          |
| `SMTP_PASSWORD`                | No                             | SMTP auth password                                                          |
| `EMAIL_FROM`                   | No (required to send)          | From address, e.g. `Single Solution <no-reply@example.com>`                 |
| `EMAIL_REPLY_TO`               | No                             | Reply-to address for outbound email                                         |
| `ECOMMERCE_CHATBOT_PUBLIC_URL` | No                             | Chatbot product origin used by the login page's restricted public-demo link |

When SMTP or `APP_URL` is not configured, merchant onboarding still succeeds; the admin gets a copyable one-time invite link instead of an automatic email.

## Scripts

| Command             | Purpose                        |
| ------------------- | ------------------------------ |
| `npm run dev`       | Development server (port 3000) |
| `npm run build`     | Production build               |
| `npm run start`     | Run production build           |
| `npm run typecheck` | TypeScript check               |

## First login

1. Set bootstrap credentials in `.env`.
2. Start the app and open `/login`.
3. Sign in as platform admin -> redirected to the role-aware dashboard (`/dashboard`).
4. Onboard merchants from `/merchants`: this emails the owner a one-time invite link (or shows a copyable link if SMTP is not configured) that they use to set a password.

## Public demo

1. Run `node --env-file=.env scripts/seed-demo.mjs`.
2. Copy the printed restricted demo token into the chatbot product environment as `PUBLIC_DEMO_PRODUCT_TOKEN`.
3. Set `ECOMMERCE_CHATBOT_PUBLIC_URL` in the platform environment to the chatbot origin.
4. Open `/login` and choose **Try live demo**. If the token is absent or invalid, the chatbot shows a safe static preview instead of a broken page.

## Common issues

| Symptom                        | Fix                                                                    |
| ------------------------------ | ---------------------------------------------------------------------- |
| `Invalid environment` on start | Check `.env` exists; no CRLF in values; `JWT_SECRET` at least 32 chars |
| Cannot connect to MongoDB      | Whitelist your IP in Atlas; verify URI user/password                   |
| 401 after login                | Clear cookies; confirm `JWT_SECRET` unchanged between restarts         |

## Production

Build and run on any Node host (Vercel, Railway, VPS):

```bash
npm run build
npm run start
```

Set all required env vars in the hosting dashboard.
