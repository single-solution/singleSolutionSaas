# Wishlist — developer guide

## Drop-in (Mode A)

The Loader mounts `ui/wishlist.js#render` (the `widgets` element) with the website's design tokens. Pick a variant
for each mount:

- `heart`: an `aria-pressed` toggle button. Pass the item in the element config:
  `{ item: { itemId, variantId?, title?, image?, url?, price?: { amount, currency } } }`.
- `page`: the shopper's lists, with remove, opt-in, share and create/delete list controls.
- `share`: a shared list. Pass `{ shareToken }`, read from your share page URL (`share.page_url` with `{token}`).

Slots: `before`, `after`, `empty`. Every heart on a page shares one state call.

## Headless (Mode B)

```js
import { createElementApi } from '@ss/web/element';
import { createWishlist, createWishlistStore, wishlistClient } from '@wishlist/elements/headless/wishlist.js';

const api = createElementApi({ baseUrl, key: 'pk_live_…', identity: { token: () => siteLoginJwt } });
const store = createWishlistStore({
	client: wishlistClient(api),
	strings,
	storage: { local: window.localStorage, session: window.sessionStorage },
	consent: (category) => consentBanner.allows(category), // the guest token is stored only with consent
});
const heart = createWishlist({
	config: { item: { itemId: 'sku-42', title: 'Linen shirt' } },
	strings,
	client: wishlistClient(api),
	store,
});
heart.subscribe((state) => draw(state)); // state.saved, state.busy, state.message …
await heart.actions.load();
await heart.actions.toggle(); // Result: { ok, value } | { ok: false, problem }
```

- Call `store.consentChanged()` when the shopper changes consent.
- Call `store.reset()` on sign-out.
- After sign-in, `load()` merges the guest list and forgets the token.

## API (Mode C)

- **From your server** (`sk_`):
   - act for a customer with `customerId`, e.g. `POST /v1/lists/default/items { customerId, itemId, title, price }`;
   - list everything with `GET /v1/lists`.
- **Prices and stock:** send `price.changed@1` and `inventory.changed@1` to the Event Hub with an `sk_` key and a
  `merchant` actor, or use the Catalog product. Opted-in customers then produce `wishlist.price_dropped@1` and
  `wishlist.back_in_stock@1`.
- **Who tells the customer:** subscribe Alerts, or your own messaging, to those events. Wishlist sends nothing itself.
- **Share links** carry only an opaque token. `POST /v1/shares` rotates the link and `POST /v1/shares:revoke` ends it.

Configuration comes only from the signed entitlement document (`schemas/*.features.json`). Turning an element off
disables all three modes (403 `element_disabled`).
