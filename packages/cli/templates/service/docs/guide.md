# {{name}} — developer guide

- **Mode A** (drop-in): `ui/notes.js#render` is mounted by the Loader with the website's design tokens.
- **Mode B** (headless): `headless/notes.js#createNotes({ config, strings, client, emit })` gives state, actions,
  `subscribe`, `validate` and resolved strings; wrap it with the `@ss/web` React/Vue/Svelte adapters.
- **Mode C** (API): `GET/POST /v1/notes`, `GET/PATCH/DELETE /v1/notes/{id}` with a `pk_`/`sk_` website key
  (see `openapi.json`).

Configuration comes only from the signed entitlement document (`schemas/notes.features.json` defines the features);
turning the element off disables all three modes (403 `element_disabled`).
