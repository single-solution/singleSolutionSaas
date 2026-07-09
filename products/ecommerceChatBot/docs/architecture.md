# Ecommerce ChatBot

An embeddable customer-support and AI assistant chat widget for e-commerce platforms.

## Architecture & Integration

This product is a standalone backend widget. It serves the widget bundle and its API from this isolated codebase. The merchant embeds the widget on their storefront (e.g., Shopify, WooCommerce, or custom Next.js site) via a script tag or iframe, and can layer their own CSS overrides on top of it.

- **Isolation:** Built within `singleSolutionSaas/products/ecommerceChatBot`, treated as a totally separate product.
- **Verification:** Uses the `singleSolutionSaas` internal verify endpoint (`/api/internal/site-keys/verifications`) to validate the merchant's API key. It does not read directly from the platform DB for merchant identity.
- **Database:** Runs on the same MongoDB cluster as the platform, but uses a separate database (e.g., `ecommerce_chatbot` instead of `platform`).
- **Origins:** Served across multiple origins (merchant storefronts). Must handle CORS securely based on the verified site key.

## Data Model (Isolated DB)

- `ChatThread`: Represents exactly one persistent conversation per visitor/customer per site.
- `ChatMessage`: Individual messages within a thread (human or AI).
- `ChatSettings`: Merchant-specific configuration (colors, greeting, AI tone, enabled/disabled state), mapped by `siteId`.

## Core Behavior

- **One Thread Per Visitor:** Each guest or signed-in user has one persistent conversation.
- **Optimistic UI:** Client sends append a `local-id` immediately; server responds with persisted version.
- **Polling / Realtime:** Uses long-polling (fast when tab is focused, slow when blurred) or Server-Sent Events (SSE) to sync messages.
- **Handoff:** Supports AI auto-reply with escalation to human agents (or WhatsApp routing).

## API Endpoints

- `GET /api/chatbot/bootstrap`: Initial fetch to get settings and active thread state.
- `GET /api/chatbot/thread`: Fetch historical messages.
- `POST /api/chatbot/messages`: Send a new message.
- `POST /api/chatbot/read`: Mark thread as read.

*(Ported and adapted from the `ibrahimMobiles` LiveChatWidget.)*
