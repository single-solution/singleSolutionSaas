# jobs/

Coupons runs no scheduled or periodic work: there are no cron routes, no background loops and no polling.

- **Reservations** carry their expiry and are expired on read: a lapsed reservation is expired (its uses go back,
  `coupons.released@1` reason `expired`) as soon as it is read or confirmed, when its code, customer or device needs
  the use, and when its code is read (`GET /v1/codes/{code}`). Open-reservation counts never include lapsed ones.
- **Dashboard button** "Release expired reservations" (`POST /v1/dashboard/reservations:expire`) releases the website's
  lapsed reservations at once, bounded.
- Velocity counters disappear through the `velocity_ttl` TTL index (`adapters/repositories.js`); app-kit sends usage
  (`redemption`) and the event outbox right after the request that queued them. There is no periodic heartbeat.

This folder is kept empty on purpose.
