# Alerts & Waitlists — developer guide

## Drop-in (Mode A)

The Loader mounts `ui/notifyMe.js#render` (`capture` element, placement per website) with the website's design tokens.
Variants `inline` (the form) and `button` (a "Notify me" disclosure); slots `before` / `after`. Pass the item through
the element config: `{ itemId, variantId?, item: { name, url }, price: { amount, currency } }`.

## Headless (Mode B)

```js
import { createElementApi } from '@ss/web/element';
import { createNotifyMe, notifyMeClient } from '@alerts/elements/headless/notifyMe.js';

const api = createElementApi({ baseUrl: config.apiBaseUrl, key: 'pk_live_…', identity: { token: () => siteLoginJwt } });
const notify = createNotifyMe({
	config: { itemId: 'itm_42' },
	strings,
	client: notifyMeClient(api),
	identity: { signedIn: true },
});
notify.subscribe((state) => render(state));
await notify.actions.load();
await notify.actions.setConsent(true);
const result = await notify.actions.subscribe(); // Result: { ok, value } | { ok: false, problem }
```

## API (Mode C)

- Report stock and price from your server: `POST /v1/triggers` `{ kind: 'inventory', itemId, quantity, previousQuantity }`
  (or send `inventory.changed@1` / `price.changed@1` to the Event Hub with an `sk_` key and a `merchant` actor).
- Bulk: `POST /v1/triggers:batch` `{ changes: [...] }` or `POST /v1/triggers:import` `{ csv }`.
- Sending is event-driven (no scheduled jobs): each trigger sends its alerts and the website's other due messages
  (quiet hours, digests, caps, retries) while `dispatch.inline_dispatch` is on. To send due messages without a new
  trigger — or with inline dispatch off — call `POST /v1/messages:dispatch` (`sk_`) or press **Send due now** in the
  dashboard.
- Subscribe from your server: `POST /v1/subscriptions` with `sk_` (any address, `customerId`, `tier`).
- Your own unsubscribe page: set `unsubscribe.page_url` (with `{token}`), preview with `GET /v1/unsubscribe/{token}`
  and apply with `POST /v1/unsubscribe { token }` — never on page load.

Configuration comes only from the signed entitlement document (`schemas/*.features.json`); turning an element off
disables all three modes (403 `element_disabled`).
