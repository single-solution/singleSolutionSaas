# jobs/

None. This product runs no scheduled jobs, background loops or polling: work happens inside (or right after) the
request that makes it relevant, for the records that request touches.

- Snoozes, SLA breaches and auto-close are settled when a conversation is read (`service.settle`, applied by the
  repositories of `api/routes.js` to every conversation a request reads or lists). The inbox KPI already counts
  missed SLA targets that no read has recorded yet.
- Deleted FAQ entries and agents carry `purgeAt`; a MongoDB TTL index removes them (`adapters/db.js`).
- Conversations and messages expire by their `retainUntil` TTL index; order, customer and visitor caches by
  `expiresAt`.
- Web pages due for a refresh are fetched by the dashboard's "Refresh due pages" button
  (`POST /v1/dashboard/knowledge-sources:refresh`) or one by one with `POST /v1/knowledge-sources/:id/refresh`.
