# Accounts

The Single Solution product for sign-up and sign-in of a merchant's users on their own website and admin (PLAN.md
0.8.6, step 7): one user list for shoppers and staff with roles, profiles, two-step sign-in, sessions, data rights and
copies of every product's activity log. Built on `@ss/app-kit`.

## Features

| Key               | What it does                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `phone_code`      | Sign-up and sign-in with a code by SMS or WhatsApp, sent through Notifications (pasted token)                        |
| `email_password`  | E-mail + password: password rules, breached-password check, lock after wrong passwords, Forgot password              |
| `email_code`      | E-mail code or magic link, sent through Notifications                                                                |
| `google`          | Sign-in with Google (the merchant's OAuth client)                                                                    |
| `apple`           | Sign in with Apple (the merchant's Services ID and key)                                                              |
| `facebook`        | Sign-in with Facebook (the merchant's app)                                                                           |
| `roles`           | Roles (ready-made and own), permissions from pasted products and own names, session lengths, Users and Roles widgets |
| `custom_fields`   | The merchant's own profile fields (text, number, date, choice), set in the dashboard                                 |
| `two_step`        | Authenticator-app codes and recovery codes; optional or required per role                                            |
| `approval`        | Open, invite-only or approval sign-up, required fields, invites                                                      |
| `risk_checks`     | Disposable e-mail domains, accounts per device and per network                                                       |
| `terms`           | The accepted terms version is recorded; a new version is asked at the next sign-in                                   |
| `data_rights`     | Download my data; delete my account after approval (or N days), erased in every connected product                    |
| `activity_copies` | Receives every connected product's activity-log copies                                                               |
| `orders_tab`      | My account lists the user's orders from Ecommerce (pasted token)                                                     |

Sign-ins are EdDSA JWTs of 15 minutes (`aud` = website id) that the merchant's server and other products verify
offline with `GET /v1/websites/:websiteId/keys`; the widget renews them with a rotating refresh token. Work that has
to happen later (deletions after N days, erasures a product did not confirm) runs right after later requests for the
website; there are no background jobs.

## Layout (PLAN 0.4.13)

| Folder      | What it holds                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| `core/`     | pure logic: e-mail and phone, profiles and custom fields, roles, sign-in rules, widget names, snippets                     |
| `api/`      | routes, the service (sign-ins, sessions, messages, data rights), flows per method, My account, the merchant's side, docs   |
| `adapters/` | the kit wiring (`product.js`), cryptography, Google/Apple/Facebook and the breached-password list, the merchant database   |
| `ui/`       | widgets: `sign_in`, `my_account` (visitor), `users_admin`, `roles_admin` (admin, tickets)                                  |
| `app/`      | Next.js: the API function and the dashboard (Overview · Features · Settings with Custom fields · Connections · Developers) |
| `strings/`  | every word of the widgets (Settings → Texts)                                                                               |
| `schemas/`  | each feature's settings schema                                                                                             |
| `tests/`    | Vitest on the kit's fake Portal with fakes for Notifications, other products and the providers; MongoDB; jsdom             |
| `docs/`     | the public docs' texts, served at `/docs`                                                                                  |

## Environment and deploying

Exactly three variables (`.env.example`): `MONGODB_URI` (this product's own database), `CONNECT_SECRET` and
`ENCRYPTION_KEY` (each random, at least 32 characters). Deploy with the Vercel project root `products/accounts`, set the
three variables for Production, then connect it in the Portal: Products → Add product, with its address and
`CONNECT_SECRET`, then set it Active. Merchants register `<address>/oauth/<google|apple|facebook>/callback` with their
providers.

## Scripts

`pnpm dev` / `pnpm build` (both regenerate `openapi.json` and `api/widget-script.js` first) / `pnpm start`,
`pnpm check` (format, lint, typecheck, tests with coverage) and `pnpm validate` (`ss app validate`).
