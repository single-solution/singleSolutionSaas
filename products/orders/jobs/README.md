# jobs/

The Order Manager runs no scheduled or periodic work: there are no cron routes, no background loops and no polling.

- **Auto-expiry** is applied on read: an order whose status expired is moved (to its `expireTo` status, with its events
  and customer message) before any read returns it, so nobody sees or acts on an expired status.
- **Order outbox** entries a crashed request left behind are delivered again (same idempotency keys) the next time the
  order is read.
- **Customer message retries** (with backoff) are sent when their order is next read.
- **Dashboard button** "Process due now" (`POST /v1/dashboard/due:run`) does all three for the open website, bounded.
- app-kit sends usage and its event outbox right after the request that queued them.

This folder is kept empty on purpose.
