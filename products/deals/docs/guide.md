# Deals & Promotions — developer guide

- **Mode A** (drop-in): `ui/badges.js#render` (variants `card`, `detail`; `theme.item` picks the item) and
  `ui/dealsPage.js#render` (`grid`, `list`) are mounted by the Loader with the website's design tokens.
- **Mode B** (headless): `createBadges` and `createDealsPage` give state, actions, `subscribe`, `validate` and resolved
  strings; wrap them with the `@ss/web` React/Vue/Svelte adapters. Countdowns never schedule timers — call
  `actions.tick()` from your own interval.
- **Mode C** (API): see `openapi.json`. A typical checkout: sync items (or send line details) → `POST /v1/quotes`
  on every cart change (pass `locks` from earlier quotes) → `POST /v1/quotes/{id}/commit` with the order id when the
  order is placed → `order.cancelled@1` (or `…/release`) when it is cancelled.

Configuration comes only from the signed entitlement document; turning an element off disables all three modes
(403 `element_disabled`), and a disabled deal kind never applies.
