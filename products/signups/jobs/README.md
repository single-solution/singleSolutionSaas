# jobs/

None. This product runs no scheduled jobs, background loops or polling: work happens inside (or right after) the
request or event that makes it relevant, for the records it touches.

- Deletions whose cooling-off ended run when the customer is read (sign-in, refresh, identity, the customer routes,
  customer listings — only the listed customers) and from the dashboard's "Run due deletions" button
  (`POST /v1/dashboard/deletions:run`, at most 100 per click).
- Signing keys rotate when they are read and due (the new key is pre-published first); superseded keys past the
  retention window are deleted at the same moment.
- The request to make Signups the website's identity issuer is sent on `entitlement.changed@1` (once per issuer
  configuration), or from the dashboard / `POST /v1/issuer:register`.
- Expired codes, links, counters, cooldowns, sessions and risk events are refused on read and removed by TTL indexes
  (`adapters/db.js`).
