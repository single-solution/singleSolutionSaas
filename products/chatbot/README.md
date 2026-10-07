# Chatbot & Support (`chatbot`)

An SSPS v1 **service product** (PLAN Part D §1, Part E). A website chat launcher and window, AI answers through the
merchant's **own** AI provider, knowledge from FAQ entries and web pages, visual-builder-ready conversation flows,
tools (order status from order events, the merchant's webhooks), a human inbox with handoff, assignment, working hours
and SLAs, proactive messages, lead capture, CSAT, transcripts and moderation — drop-in, headless or API only. **All
conversations, messages, knowledge, leads and caches live in the merchant's own MongoDB**; AI calls run with the
merchant's AI connector credentials resolved through the Portal. This deployment keeps only caches, queues and website
ids.

Ported from ibrahimMobiles (`apps/web/src/lib/chat`, `packages/shared/src/chat`, the admin inbox and
`packages/db/src/inquiryMessages.ts`) and generalised: no market, currency, language or provider is assumed.

## Elements

Every element is switchable per website and priced in millicredits per hour; every setting is a feature with a schema,
a default and plan bounds (`x-plan`) in `schemas/<element>.features.json` — nothing is hard-coded.

| Element        | Modes   | Price /h | Metered                                      | What it does                                                                                                                                                                                                                                                                                                            |
| -------------- | ------- | -------: | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `window`       | A, B, C |      400 | `conversation` 1 mc each (300 / 3 000 incl.) | Conversations and messages (separate collection), guest marker tokens, identified customers via `SS-Identity`, polling with ETag/304, back-off and idle stop, quick replies, flow buttons/forms, languages (script detection + configurable marker words), limits (length, guest messages, open conversations, rate)    |
| `launcher`     | A, B    |      100 | —                                            | Floating / tab-bar button: position (reading-direction aware), offset, size, icon/avatar, label, pulse, unread badge, hide rules (paths, devices), auto-open (delay, scroll %, exit intent, idle, selector click, once per session)                                                                                     |
| `ai_replies`   | C       |      500 | `ai_token` 1 mc per 1 000 (250 k / 2.5 M)    | OpenAI, Anthropic, Google or any OpenAI-compatible endpoint via the merchant's AI connector; persona/tone, instructions on top of non-removable safety rules, language lock + one retry, bubbles, citations, tool rounds cap, per-call timeout, answer deadline, per-conversation and monthly token budgets, cost alert |
| `knowledge`    | C       |      200 | —                                            | FAQ entries (REST/dashboard) and https pages fetched through `@ss/net` safeFetch, chunked into the merchant DB with term frequencies, BM25 ranking with source priority and minimum coverage; "don't know" = answer / say so / hand off                                                                                 |
| `flows`        | C       |      200 | —                                            | JSON graphs: message, question (validated), buttons, form, condition (rules@1), action (variable, tag, priority, webhook tool, lead, close), AI step, handoff, end; triggers start / keyword / page / event; step limit; builder `check` and `simulate`                                                                 |
| `tools`        | C       |      200 | `tool_call` 1 mc per 10 (500 / 5 000)        | Order lookup for the verified customer from `order.*@1` events, guest lookup with number + e-mail (opt-in), knowledge search, escalation; merchant webhook tools with typed parameters, HMAC-signed requests, timeouts, response caps                                                                                   |
| `inbox`        | B, C    |      400 | —                                            | Agents (bounded), teams with working hours (overnight windows, zones), assignment manual / round-robin / least loaded / rules@1, SLAs (optionally working time only) with breach tracking, statuses, priorities, tags, canned replies, internal notes, snooze, auto-close                                               |
| `handoff`      | C       |      100 | —                                            | Escalation phrases (any language), rules@1 condition, repeated AI failures, the AI's escalation tool or a flow; team; offline fallback (lead form, link, message, next opening); AI resumes after a grace window; queue position                                                                                        |
| `proactive`    | A, B, C |      150 | —                                            | Rules@1 on page / visitor / cart, delay, open window, per-session / per-day / cooldown caps, dismissal memory, global daily cap, not while a conversation is open                                                                                                                                                       |
| `lead_capture` | B, C    |      150 | —                                            | Configurable fields, consent, when it is offered, `chatbot.lead_captured@1`, optional forwarding to a webhook tool                                                                                                                                                                                                      |
| `csat`         | B, C    |      100 | —                                            | Scale 2/3/5/10, when asked (on close, after a person, manual), comment, target and summary                                                                                                                                                                                                                              |
| `transcripts`  | C       |      100 | —                                            | Retention days (TTL index on `retainUntil`), JSON/text export for merchants and (optionally) customers, internal notes on request, TTL purge of soft-deleted records                                                                                                                                                    |
| `moderation`   | C       |      100 | —                                            | PII redaction in/out (Luhn cards, mod-97 IBANs, e-mails, phones, IPs), redaction before the AI, leak filter (credential shapes, internals phrases), link policy (website only / allow-list / none / any), blocked terms (mask / reject)                                                                                 |

Plans: **starter** = window, launcher, ai_replies, knowledge, handoff, lead_capture, moderation (1 550 mc/h; add-ons
tools, proactive, csat, transcripts); **pro** = all thirteen elements, higher bounds. Trial 48 h.

**Events.** Publishes `chatbot.started@1`, `chatbot.message@1` (metadata only, never the text), `chatbot.handoff@1`,
`chatbot.closed@1`, `chatbot.lead_captured@1` and `chatbot.note_created@1` (schemas in `schemas/events/`). Consumes
`order.*@1` (order cache: number, status that never moves backwards, totals, lines, refunds, customer reference) and
`customer.*@1` (verified e-mails → customer ids) for the order lookup tool.

**Customer identity.** Browser (`pk_`) routes read `SS-Identity`: the website's own login token (bring-your-own
identity, verified by app-kit, `ctx.identity.subject` = customer) or, for guests, the marker token returned by the
first `POST /v1/conversations` (HMAC over website + visitor + expiry). `POST /v1/conversations:claim` moves a guest's
history to the customer after sign-in. Server (`sk_`) routes act for the merchant and may name a `customerId`.

## How it works

- **Message pipeline.** Validate → moderation inbound (blocked terms, PII) → language detection → running flow or a
  flow trigger → handoff decision → waiting for a person? (AI only after the grace window) → AI (budget check,
  knowledge passages, tools loop, language check and retry, bubble split, moderation outbound) → store the customer
  message and the replies in one append that moves the conversation summary atomically → events and usage.
- **Exactly once.** Conversation, message, lead and agent ids derive from the Idempotency-Key hashed with the website,
  the caller (customer, guest marker, dashboard session or server key) and the route, so another caller's identical key
  never reaches your records (a fresh random key when none is sent, or for an anonymous browser); stores are upserts; usage (`conversation:<id>`, `ai:<conversation>:<message>:<n>`, `tool:<…>`)
  and events carry derived keys. app-kit refuses a repeated key on creating POSTs within 24 h (409 `duplicate_request`).
- **AI providers** are app-kit connector adapters (`adapters/ai.js`) over the kit's HTTP connector; request/response
  mapping is pure (`core/providers.js`). Unknown/absent model or connector → the conversation goes to a person.
- **Data.** `ss_chatbot_{conversations,messages,entries,chunks,sources,leads,ratings,agents,counters,orders,customers,
visitors,audit}` in the merchant DB, `websiteId` first in every index, TTL indexes for retention and caches, lazy
  migrations, export/anonymise through the Portal-signed standard routes.

## API (Mode C)

`openapi.json` documents every operation with examples (45 paths; `x-ss-key-kind: sk` marks server-only reads).

| Area          | Routes                                                                                                                                                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversations | `GET/POST /v1/conversations` · `POST /v1/conversations:claim` · `GET/PATCH /v1/conversations/{id}` · `GET/POST …/{id}/messages` (since/before, ETag) · `POST …/{id}/read` · `POST …/{id}/close`                               |
| Inbox         | `GET/POST …/{id}/notes` · `GET/POST /v1/agents` · `GET/PATCH/DELETE /v1/agents/{id}` · `GET /v1/inbox` · `GET /v1/inbox/canned-replies` · `POST /v1/inbox/canned-replies:render`                                              |
| Handoff       | `GET /v1/handoffs` · `POST /v1/handoffs`                                                                                                                                                                                      |
| AI            | `GET /v1/assistant` (connector, budget) · `POST /v1/assistant:preview`                                                                                                                                                        |
| Knowledge     | `GET/POST /v1/knowledge-entries` · `POST /v1/knowledge-entries:batch` · `GET/PATCH/DELETE /v1/knowledge-entries/{id}` · `GET /v1/knowledge-sources` · `POST /v1/knowledge-sources/{id}/refresh` · `POST /v1/knowledge:search` |
| Flows, tools  | `GET /v1/flows` · `POST /v1/flows:check` · `POST /v1/flows:simulate` · `GET /v1/tools` · `POST /v1/tools/{name}/invoke` · `POST /v1/tools:signing-secret`                                                                     |
| Engagement    | `GET /v1/proactive` · `POST /v1/proactive:evaluate` · `POST /v1/proactive:dismiss` · `GET/POST /v1/leads` · `GET /v1/leads/{id}` · `GET/POST /v1/ratings`                                                                     |
| Transcripts   | `GET /v1/transcripts` · `GET /v1/transcripts/{conversationId}?format=json\|text` · `POST /v1/moderation:check`                                                                                                                |
| Standard      | `/v1/entitlement`, `/v1/config`, `/v1/events`, `/v1/strings`, `/v1/session`, `/sso`                                                                                                                                           |

Errors are RFC 9457 problems with stable codes (`guest_limit_reached`, `conversation_closed`, `message_rejected`,
`too_many_conversations`, `already_rated`, `invalid_transition`, `limit_reached`, `unknown_tool`, `source_failed`,
`identity_required`, …). Webhook tools receive `ss-chatbot-signature: t=<unix>,v1=<hex>,kv=<version>` = HMAC-SHA-256
of `ss-chatbot-tool.v1.<t>.<body>` with the secret from `POST /v1/tools:signing-secret`.

**Headless (Mode B).** `headless/window.js#createWindow`, `launcher.js#createLauncher`, `proactive.js#createProactive`,
`leadForm.js#createLeadForm`, `csat.js#createCsat`, `inbox.js#createInbox` (+ `notes.js#createNotesPanel`) — the
standard `{ state, actions, subscribe, validate, strings, destroy }` shape over an `@ss/web/element` API client; timers,
visibility and token storage are injected (`headless/transport.js`), so they run anywhere. **Drop-in (Mode A).**
`ui/window.js`, `ui/launcher.js`, `ui/proactive.js` — `render({ state, actions, strings, theme, slots, dom })`, design
tokens only; `ss pack build .` bundles them for the Portal's "Upload widgets".

## Dashboard (SSO)

`/sso?launch=` → `ss_session`: overview KPIs, inbox (status filter), a live conversation (polled with the same transport,
replies, canned replies, internal notes, status), knowledge (FAQ entries, page states, "Refresh due pages"), settings (link to the
subscription's configuration in the Portal and the AI connector state). Merchant and admin (staff) launches; replies by
dashboard users create their agent record when the inbox is on.

## Develop

```sh
pnpm dev                       # Next.js on :3000 (MONGODB_URI empty = in-memory control store; CONNECT_SECRET in .env.local)
ss app validate .              # 0 problems
pnpm check                     # format, lint, typecheck, tests with coverage: core, headless, renderers, API on MongoDB
```

The system test `e2e/tests/chatbot-portal.test.js` (monorepo workspace `@ss/e2e`) runs the real Portal in
process: staff → Add product (URL + connect secret) → activation → merchant signup → website → credits → starter subscription →
database and AI connectors (a fake OpenAI-compatible provider on local https; the Portal's check calls `/models`) →
`pk_` key → a guest opens a conversation from the website's origin → the product resolves the merchant's AI credentials
through the Portal and answers → data in the merchant DB → `ai_token` usage → hourly settlement (1 550 mc for the
elements, 10 mc metered for the tokens above the included amount).

## Deploy

1. Deploy this directory on any Node 22 host that runs Next.js (on Vercel: Root Directory = this folder). In the
   monorepo, `next.config.js` sets the workspace root automatically.
2. Set two environment variables: `MONGODB_URI`, the product's own small MongoDB (sessions, caches, usage queue, its
   signing key and generated secrets), and `CONNECT_SECRET` (random, at least 32 characters). Nothing else.
3. Portal → Admin → Apps → **Add product** → the product URL and `CONNECT_SECRET` → **Connect**. The product generates
   its key and pins the Portal; then activate it in the Portal. Nothing runs on a timer.

## Changelog

- **Unreleased** — knowledge pages and webhook tools use app-kit's `product.outbound.fetch` (the private connector
  workaround is gone); `window.messages_per_minute` is an app-kit dynamic route limit on
  `POST /v1/conversations/{id}/messages` (per customer / guest marker for browsers, per conversation for servers; agent
  and bot replies are not limited); event-driven only — the maintenance cron, the background task after requests and
  the site registry are gone: a passed snooze reads as open and is woken when read, SLA breaches are recorded and idle
  conversations auto-closed when the conversation is read or listed (the inbox KPI counts missed targets right away),
  deleted FAQ entries and agents are purged by a TTL index on `purgeAt`, and due web pages are refreshed by the
  dashboard's "Refresh due pages" button (`POST /v1/dashboard/knowledge-sources:refresh`) or per page by the API.
- **1.0.0** — first release: thirteen elements, three renderers, six headless cores, REST v1 (45 paths), dashboard,
  maintenance cron (removed since).
