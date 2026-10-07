# Wishlist (`wishlist`)

An SSPS v1 **service product** (PLAN Part D §17, Appendix A.17). Shoppers save anything a website offers (products,
courses, rooms, articles) to one or more named lists. Guests keep a list too, behind consent, and it merges into their
account when they sign in. They can share a list with a read-only link. Customers who opt in on a list produce
price-drop and back-in-stock signals that Alerts or the merchant's own messaging can act on. **All data lives in the
merchant's own MongoDB** (connected in the Portal). This deployment keeps only caches and queues.

**Why a service product, not "element pack + Graph storage".** PLAN describes Wishlist as an element pack that stores
its state in the Website Graph. The Portal does not offer Graph storage to packs yet: the delivery runtime gives pack
elements a placeholder Graph client, and every call answers `graph_unavailable`
(`platform/src/modules/delivery/runtime/entry.js`). A pack also has no server, so it could not verify guest tokens or
consume price and stock events. Wishlist is therefore a service product. It ships its drop-in widgets as a Mode A
element (`widgets`): a heart button, a list page and a share view.

Ported from ibrahimMobiles (`packages/shared/src/wishlist.ts`, `apps/web/src/lib/wishlist/*`,
`apps/web/src/components/shared/WishlistButton.tsx`):

- entries are kept newest first and deduplicated, and the oldest is evicted at the cap;
- on sign-in the guest list merges into the account as a union and is then cleared locally;
- one state load is shared by every heart on the page;
- toggles are optimistic and roll back on failure;
- the heart is a real `<button aria-pressed>` that never triggers the card link around it.

## Elements

Each element is switchable per website and priced in millicredits per hour. Each setting is a feature in
`schemas/<element>.features.json`, with plan bounds where the plan matters. No currency, language, domain or item type
is assumed.

| Element           | Modes   | Price /h | What it does                                                                                                                                                                                                                                                                                                       |
| ----------------- | ------- | -------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lists`           | C       |      100 | Named lists of any item: an external `itemId` and optional `variantId`, plus a snapshot of title, image, price and URL. Links follow a URL policy. **Limits:** `max_lists` and `max_items_per_list` (plan-bounded). When a list is full: `evict_oldest` or `refuse`. Writes are rate-limited per customer or guest |
| `guest_merge`     | C       |       50 | Signed guest tokens (`wg1.…`, website-bound, expiring, no personal data). The token is stored in `local`, `session` or `memory` storage, only when the shopper granted `consent_category`. On sign-in the guest list merges, either `into_default` or with `keep_lists`. New tokens are rate-limited per IP        |
| `share`           | C       |       50 | Read-only share links with an opaque 130-bit token. Only its SHA-256 is stored. Links can be rotated or revoked, and can expire. The view hides the owner and list ids. Prices can be hidden. Guests may share only if the merchant allows it                                                                      |
| `price_drop_hook` | C       |      100 | Consumes `price.changed@1` and `inventory.changed@1` and keeps each entry's latest price and stock current. For opted-in customer lists it publishes `wishlist.price_dropped@1` and `wishlist.back_in_stock@1`, with a minimum drop, a cool-down and location filters. It sends no messages itself                 |
| `widgets`         | A, B, C |      100 | Mode A renderer (`heart`, `page`, `share`; tokens only) and headless core, on one state call (`POST /v1/wishlist`)                                                                                                                                                                                                 |

Plans:

- **starter**: lists, guest_merge and widgets (250 mc/h); share and price_drop_hook are add-ons.
- **pro**: all five elements (400 mc/h), with higher limits.

## Identity and owners

- `pk_` + `SS-Identity`: the customer of the website's own login, from Signups or the merchant's issuer, verified by
  app-kit. A token that fails verification is refused. It is never downgraded to a guest.
- `pk_` without a login: the guest whose signed token is sent as `guest` in the body. Guest tokens are never put in
  URLs.
- `sk_`: the merchant's server, acting merchant-wide or for the customer it names in `customerId`.

## Events

- **Consumes:** `price.changed@1` and `inventory.changed@1`, from Catalog or the merchant's server through the Event
  Hub or `POST /v1/events` with `sk_`. Browser-originated events (`pk_`, `customer` or `anonymous` actor) are ignored
  unless `accept_customer_events` is on.
- **Publishes:** `wishlist.price_dropped@1` and `wishlist.back_in_stock@1` (schemas in `schemas/events/`). Each event
  is idempotent per change and customer. It carries the customer's login `subject`, and their e-mail only when
  `include_email` is on.
- `@ss/contracts` catalogues no event for this, so these are product events.

## Data

The collections are `ss_wishlist_{lists,stock,notifications,audit}`:

- entries are embedded in their list and changed by compare-and-set on `rev`;
- guest lists and notifications expire by TTL.

## API (Mode C)

`openapi.json` documents every operation (`x-ss-key-kind: "sk"` marks server-only routes).

| Operation | Route                                                                                      |
| --------- | ------------------------------------------------------------------------------------------ |
| Lists     | `GET`/`POST /v1/lists` · `GET`/`PATCH`/`DELETE /v1/lists/{id}` (`default` alias)           |
| Items     | `POST /v1/lists/{id}/items` · `DELETE /v1/lists/{id}/items/{entryId}`                      |
| Guests    | `POST /v1/guests` · `POST /v1/guests:merge`                                                |
| Shares    | `POST /v1/shares` · `POST /v1/shares:revoke` · `GET /v1/shares/{token}`                    |
| Signals   | `GET /v1/notifications` (sk)                                                               |
| Widgets   | `POST /v1/wishlist` (state: owner, lists, settings; issues, renews or merges guest tokens) |
| Standard  | `/v1/entitlement`, `/v1/config`, `/v1/events`, `/v1/strings`, `/v1/session`                |

## Develop

```bash
cp .env.example .env.local     # MONGODB_URI (empty = in-memory control store) + a random CONNECT_SECRET (≥ 32 chars)
pnpm dev                       # product on :3000
# local Portal → Admin → Apps → Add product → http://localhost:3000 + the CONNECT_SECRET
pnpm validate                  # ss app validate
pnpm check                     # format, lint, typecheck, tests with coverage
ss pack build .                # the widgets (Mode A) → upload dist/pack in the Portal (app page → Upload widgets)
```

`MONGODB_URI` and `CONNECT_SECRET` (see `.env.example`): the product's own control database and the connect secret.
The Portal connection, the product's signing key and its generated secrets live there. The guest-token secret is one of
them. The e2e suite (`@ss/e2e`) composes this product from its `./platform` and `./routes` exports and runs it against
the real Portal.
