# {{name}} — developer guide

- **Mode C** (API): `GET /v1/status` with a `pk_`/`sk_` website key (see `openapi.json`) returns the placeholder
  element's status and its configured `greeting`.
- Replace the `status` element with your own: add it to `manifest.json` (modes, price, features in `schemas/`,
  `api.resources` documented in `openapi.json`), put pure logic in `core/`, Mode B cores in `headless/`, Mode A
  renderers in `ui/`, and routes in `api/routes.js`.

Configuration comes only from the signed entitlement document (`schemas/status.features.json` defines the features);
turning the element off disables it (403 `element_disabled`).
