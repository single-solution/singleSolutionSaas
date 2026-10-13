# Accounts

Sign-up and sign-in for a merchant's users on their own website and admin (PLAN.md 0.8.6): phone and e-mail codes,
e-mail and password, Google, Apple and Facebook, roles and permissions, custom profile fields, two-step sign-in,
sessions, data rights and copies of every product's activity log. Messages go through Notifications (pasted token).
Feature keys are in `manifest.json`, the public docs at `/docs`.

## Environment

Exactly three variables (`.env.example`; nothing else is read):

| Variable         | What it is                                                                      |
| ---------------- | ------------------------------------------------------------------------------- |
| `MONGODB_URI`    | this product's own database (never a merchant database)                         |
| `CONNECT_SECRET` | random, at least 32 characters; typed once into Portal → Products → Add product |
| `ENCRYPTION_KEY` | random, at least 32 characters, different for each deployable                   |

## Deploy

1. Create a Vercel project with the root directory `products/accounts` and set the three variables for Production only.
2. Deploy, then in the Portal: Products → **Add product** with its address and `CONNECT_SECRET`, then **Set active**.
3. Merchants register `<address>/oauth/<google|apple|facebook>/callback` with their sign-in providers.

## Import

Feature `import` (PLAN.md 0.8.10 K10; switched on by our admins for a migration, server token only): the kit's routes
`POST /v1/import/:collection?dryRun=1` (NDJSON, at most 1,000 records or 4 MB), `POST /v1/import/:collection/prune`,
`POST /v1/import/finish` and `GET /v1/import/status`. Checks are strict (an unknown field, `websiteId` included, is
refused by name; text over a limit is refused, never cut); times are ISO-8601 with their zone. Nothing is sent. Order:

| Collection | Key   | Stored in              | Example record                                                                                                                                                                                                             |
| ---------- | ----- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roles`    | `key` | `ss_accounts_roles`    | `{"key":"member","name":"Member","permissions":[],"rank":800}`                                                                                                                                                             |
| `fields`   | `key` | `ss_accounts_fields`   | `{"key":"birthday","label":"Birthday","type":"date"}`                                                                                                                                                                      |
| `users`    | `id`  | `ss_accounts_users`    | `{"id":"usr_65f0000000000000000000a3","name":"Mina Member","phone":"+923001234567","phoneVerified":true,"role":"member","roleSince":"2024-02-01T00:00:00Z","passwordHash":"$2b$12$…","createdAt":"2023-12-01T00:00:00Z"}`  |
| `requests` | `id`  | `ss_accounts_requests` | `{"id":"rrq_65f0000000000000000000b1","role":"member","name":"Nora New","phone":"+923001112223","status":"pending","createdAt":"2024-07-01T00:00:00Z"}`                                                                    |
| `copies`   | `id`  | `ss_accounts_copies`   | `{"id":"act_65f0000000000000000000c1","productId":"ecommerce","actor":{"kind":"user","id":"usr_…","name":"Sara Staff"},"action":"order.status_changed","target":"ord_…","label":"Order 1042","at":"2024-05-02T10:00:00Z"}` |

- Roles first: a user's or request's role must exist (ready-made, or imported before), so a dry run of users needs the
  roles imported. A ready-made role key may be imported with the merchant's changes; it keeps its rank.
- Users: `email` and `phone` are normalised (national numbers with the website's phone format), `phoneDigits` and
  `identity` are derived; `passwordHash` is kept as given in a format sign-in checks (bcrypt, `pbkdf2$…` with the
  `legacy_pepper` connection, or `scrypt$…`), any other is refused; `twoStep: { secret, recoveryHashes }` (plain base32
  secret and SHA-256 hex of `recovery:<code>`) is sealed at once. An e-mail address or phone number another user holds
  is refused (one user per phone number: a member of staff and a shopper cannot share one).
- Requests keep their status (`expired` is read from `setupExpiresAt`); setup links are not imported (an older link
  cannot open here): staff give a new one from the user (`staff_links`).
- `finish` derives nothing and answers `{ usersWithUnknownRole, requestsWithUnknownUser }`. `status.totals`:
  `users.staff` (role with a permission), `users.withPassword`, `users.twoStep`, `users.role.<key>`, `requests.pending`.

## Scripts

`pnpm dev` and `pnpm build` regenerate `openapi.json` and `server/widget-script.js` first; `pnpm check` runs format, lint,
typecheck and tests with coverage; `pnpm validate` runs `ss app validate`.
