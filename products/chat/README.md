# Chat

Chat on a merchant's own website and admin (PLAN.md 0.8.3): the visitor chat widget, AI replies with the merchant's own
provider key, knowledge, webhook tools and booking, guests and Accounts sign-ins, handoff, the inbox, leads and flows,
attachments, ratings, transcripts, staff alerts, moderation, reports and Ecommerce's shop tools. Feature keys are in
`manifest.json`, the public docs at `/docs`.

Besides Chat's own routes, the merchant's server gets the kit's routes (PLAN.md 0.8.10): the settings API with Chat's
lists (`GET|PUT /v1/lists/tools|flows|custom_fields|page_rules|fallback_answers|redaction_patterns|teams|office_hours|office_exceptions|page_types|upload_types|booking_questions|booking_services|tags|topics|priorities`), the `SS-Actor-*` headers (replies, changes and
knowledge edits then carry that member of staff instead of no name, which the widget shows as the text `chat.staff`), visitor routes with the server token and
`SS-Visitor-IP`, conversation counts (`GET /v1/conversations/count` and `/counts?by=status|waiting|guest|unread`, ticket
twins under `/v1/admin/`), the activity log (`GET /v1/activity`) and the Format (`GET|PUT /v1/format`).

## Import

The `import` feature (price 0; our admins switch it on for a migration and off after it) takes another system's chats
from `ss-import`, with the server token only (PLAN.md 0.8.10 K10). Nothing is sent: no message, event, alert, AI call or
activity copy; each call writes one activity entry with its counts.

- `POST /v1/import/<collection>?dryRun=1` takes NDJSON (at most 1,000 records or 4 MB per call) of Chat's own record
  shapes, times as ISO 8601 text. A record replaces the stored one with its key, so every step can be re-run. In order:
   - `staff` by `id` (an Accounts user id): `name`, `email`, `presence`, `maxChats`.
   - `guests` by `keyHash`, the SHA-256 (hex) of the old guest cookie value, with the guest `id` (`guest_…`) its
     conversations name. The old value sent as `SS-Guest` (any key of 16–128 of `A–Z a–z 0–9 - _`) then reaches the
     guest's conversation. `expireAt` defaults to the Guest chat setting's days from now.
   - `conversations` by `id` (`conv_…`): the visitor (`{ kind: 'guest' | 'user', id }`), contact, `status` (`open`,
     `awaiting_visitor`, `resolved`), waiting and handoff times, the AI pause with who and when, `assignedTo` (an imported
     member of staff), the single `note`, custom field values (checked against the Custom fields list), `summary`,
     `rating`, `page`, `unreadStaff`, `unreadVisitor`, `lastMessageAt` and `createdAt`.
   - `messages` by `id` (`msg_…`, one record per message): `conversationId` (imported first), `author` (`visitor`, `ai`,
     `staff`, `system`), `staffId`, `name`, `text`, `format`, `internal` (a staff note), `attachment` (its `key` under
     `chat/` in Chat's storage, `name`, `type` and `size`) and `createdAt`.
- Unknown fields, `websiteId` and `merchantId` are refused by name; text longer than Chat keeps is refused, never cut.
- `POST /v1/import/finish`, after every pass, numbers each imported conversation's messages 1..n by time (ties by id)
  and sets its counters, preview, last message time and the read marks behind its unread counts. It takes 100
  conversations per call: call again with `?after=<next>` while `more` is true. Running it again changes nothing.
- `POST /v1/import/<collection>/prune` removes imported records the source no longer has; `GET /v1/import/status`
  answers the counts and the sums `ss-import verify` compares (`conversations`, `messages`, `conversations.<status>`,
  `conversations.waiting`).

## Environment

Exactly three variables, and one optional while the encryption key changes (`.env.example`; nothing else is read):

| Variable                  | What it is                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MONGODB_URI`             | this product's own database (never a merchant database)                                                                                                                                                 |
| `CONNECT_SECRET`          | random, at least 32 characters; typed once into Portal → Products → Add product                                                                                                                         |
| `ENCRYPTION_KEY`          | random, at least 32 characters, different for each deployable: seals the Connections (database address, AI keys, storage keys, pasted tokens) and the tool signing secret, and signs attachment links   |
| `ENCRYPTION_KEY_PREVIOUS` | optional, only while `ENCRYPTION_KEY` is changed: the old key, so sealed values and attachment links keep opening; removed once the dashboard's Re-seal (Prices → Encryption key, Owner) says it can be |

## Deploy

1. Create a Vercel project with the root directory `products/chat` and set the three variables for Production only.
2. Deploy, then in the Portal: Products → **Add product** with its address and `CONNECT_SECRET`, then **Set active**.

## Scripts

`pnpm dev` and `pnpm build` regenerate `openapi.json` and `server/widget-script.js` first; `pnpm check` runs format, lint,
typecheck and tests with coverage; `pnpm validate` runs `ss app validate`.
