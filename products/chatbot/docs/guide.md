# Chatbot & Support — developer guide

- **Mode A** (drop-in): `ui/window.js#render`, `ui/launcher.js#render` and `ui/proactive.js#render` are mounted by the
  Loader with the website's design tokens (`--ss-*` variables); variants `bubble | side_panel | full_screen_mobile`,
  `round | pill`, `teaser`.
- **Mode B** (headless): `createWindow({ config, strings, client, identity, emit, scheduler?, visibility?, storage?, page? })`
  where `client` is `createElementApi({ baseUrl, key: 'pk_…', identity })` from `@ss/web/element`. Pass `storage`
  (e.g. localStorage behind consent) to keep the guest marker; pass `identity.token()` returning the site's login JWT
  for signed-in customers and call `actions.claim()` after sign-in. The launcher takes the window instance
  (`createLauncher({ window })`) and environment signals (`actions.signal('scroll', 60)`).
- **Mode C** (API): see `openapi.json`. Browser keys send `SS-Identity`; servers use `sk_` keys.

Configuration comes only from the signed entitlement document (`schemas/*.features.json`); turning an element off
disables all three modes (403 `element_disabled`). Conditions everywhere (handoff, flows, assignment, proactive) are
rules@1. Webhook tools: verify `ss-chatbot-signature` with the secret from `POST /v1/tools:signing-secret`.
