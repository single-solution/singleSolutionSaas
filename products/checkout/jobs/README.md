# jobs/

Cart & Checkout runs no scheduled or periodic work: there are no cron routes, no background loops and no polling.

- **Expired holds** are expired on read: an unpaid / unconfirmed order whose hold passed is cancelled (stock, codes and
  points released through `order.cancelled@1`) as soon as it is read, listed or confirmed; it never counts as open, and a
  placement short of stock releases that website's expired holds first.
- **Abandoned carts** are marked when the merchant's server reads the cart (`GET /v1/carts`, `GET /v1/carts/{id}` with a
  server key): an open cart with lines untouched for `cart.abandoned_after_hours` publishes `checkout.cart_abandoned@1`
  once at that moment.
- **Dashboard button** "Process expired now" (`POST /v1/dashboard/expiry:run`) does both for the open website, bounded.
- Guest carts disappear through the `carts_ttl` TTL index (`adapters/db.js`); app-kit sends usage and the event outbox
  right after the request that queued them.

This folder is kept empty on purpose.
