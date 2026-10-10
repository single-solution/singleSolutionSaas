# Chat

Chat on a merchant's own website and admin (PLAN.md 0.8.3): the visitor chat widget, AI replies with the merchant's own
provider key, knowledge, webhook tools and booking, guests and Accounts sign-ins, handoff, the inbox, leads and flows,
attachments, ratings, transcripts, staff alerts, moderation, reports and Ecommerce's shop tools. Feature keys are in
`manifest.json`, the public docs at `/docs`.

Besides Chat's own routes, the merchant's server gets the kit's routes (PLAN.md 0.8.10): the settings API with Chat's
lists (`GET|PUT /v1/lists/tools|flows|custom_fields|page_rules`), the `SS-Actor-*` headers (replies, changes and
knowledge edits then carry that member of staff instead of `Team`), visitor routes with the server token and
`SS-Visitor-IP`, conversation counts (`GET /v1/conversations/count` and `/counts?by=status|waiting|guest|unread`, ticket
twins under `/v1/admin/`), the activity log (`GET /v1/activity`) and the Format (`GET|PUT /v1/format`).

## Environment

Exactly three variables (`.env.example`; nothing else is read):

| Variable         | What it is                                                                      |
| ---------------- | ------------------------------------------------------------------------------- |
| `MONGODB_URI`    | this product's own database (never a merchant database)                         |
| `CONNECT_SECRET` | random, at least 32 characters; typed once into Portal → Products → Add product |
| `ENCRYPTION_KEY` | random, at least 32 characters, different for each deployable                   |

## Deploy

1. Create a Vercel project with the root directory `products/chat` and set the three variables for Production only.
2. Deploy, then in the Portal: Products → **Add product** with its address and `CONNECT_SECRET`, then **Set active**.

## Scripts

`pnpm dev` and `pnpm build` regenerate `openapi.json` and `server/widget-script.js` first; `pnpm check` runs format, lint,
typecheck and tests with coverage; `pnpm validate` runs `ss app validate`.
