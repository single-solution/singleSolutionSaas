# Chat

The Single Solution product for chat on a merchant's own website and admin (PLAN.md 0.8.3, step 8): the visitor chat
widget and visitor API, AI replies with the merchant's own provider key, knowledge, webhook tools and booking, guests
and Accounts sign-ins, handoff with office hours, the inbox with assignment, presence and max chats, leads and flows,
attachments, ratings, transcripts, staff alerts, moderation and reports. Built on `@ss/app-kit`; rebuilt from the old
`products/chatbot`, with ibrahimMobiles' chat as the parity reference.

## Features

34 switches (keys in `manifest.json`, settings in `schemas/`), all starting off at price 0: `visitor_chat`,
`guest_chat`, `signed_in_chat`, `ai_replies`, `ai_backup`, `ai_instructions`, `ai_caps`, `ai_cost_alerts`,
`language_lock`, `knowledge_base`, `knowledge_pages`, `knowledge_editor`, `webhook_tools`, `book_slot`,
`proactive_idle`, `proactive_pages`, `proactive_exit`, `leads_flows`, `custom_fields`, `attachments`,
`typing_receipts`, `ratings`, `transcripts`, `inbox`, `handoff`, `assignment`, `presence_queue`, `internal_notes`,
`saved_replies`, `context_panel`, `ai_summary`, `staff_alerts`, `moderation`, `reports`. The shop tools, track
shipment and product cards join with Ecommerce (step 10); the Ecommerce routes they will call are in `core/shop.js` and
the docs.

All business data (conversations, messages, guests, staff, leads, saved replies, knowledge, pages, AI token counts,
the activity log) lives in the merchant's database (`ss_chat_*`). The product database holds the kit's records plus
Chat's list settings (webhook tools, flows, custom field definitions, page rules), the tool signing secret (sealed with
`ENCRYPTION_KEY`) and per-visitor AI reply counters. AI replies run right after the response (`after()`); the browser
checks with back-off. There are no background jobs, timers or websockets.

## Layout (PLAN 0.4.13)

| Folder      | What it holds                                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `core/`     | pure logic: conversations, flows, fields and leads, handoff and office hours, caps, prompt, AI wire formats, knowledge, tools |
| `api/`      | routes, the service (sites, visitors, views, Notifications), the reply pipeline, visitor API, inbox, knowledge, admin, docs   |
| `adapters/` | the kit wiring (`product.js`), AI providers, cryptography, list settings, the merchant database                               |
| `ui/`       | widgets: `chat` (visitor), `inbox`, `knowledge_editor`, `reports` (admin, tickets)                                            |
| `app/`      | Next.js: the API function and the dashboard (Overview · Features · Settings with lists · Connections · Developers)            |
| `strings/`  | every word of the widgets (Settings → Texts)                                                                                  |
| `schemas/`  | each feature's settings schema                                                                                                |
| `tests/`    | Vitest on the kit's fake Portal with fakes for the AI provider, Notifications, Accounts and storage; MongoDB; jsdom           |
| `docs/`     | the public docs' texts, served at `/docs`                                                                                     |

## Environment and deploying

Exactly three variables (`.env.example`): `MONGODB_URI` (this product's own database), `CONNECT_SECRET` and
`ENCRYPTION_KEY` (each random, at least 32 characters). Deploy with the Vercel project root `products/chat`, set the
three variables for Production, then connect it in the Portal: Products → Add product, with its address and
`CONNECT_SECRET`, then set it Active.

## Scripts

`pnpm dev` / `pnpm build` (both regenerate `openapi.json` and `api/widget-script.js` first) / `pnpm start`,
`pnpm check` (format, lint, typecheck, tests with coverage) and `pnpm validate` (`ss app validate`).
