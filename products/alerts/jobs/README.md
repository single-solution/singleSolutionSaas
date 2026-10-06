# jobs/

Alerts & Waitlists runs no scheduled or periodic work: there are no cron routes, no background passes and no polling.

- **Sending** happens when something happens: a trigger (Event Hub event, `POST /v1/triggers`, batch or CSV import)
  runs that website's outbox right away when `dispatch.inline_dispatch` is on — its own alerts plus anything of the
  website that became due meanwhile (quiet hours ended, a batching window closed, a cap reset, a retry's `notBefore`
  passed), repairs stale claims and resumes trigger runs that hit the fan-out limit. `POST /v1/messages:dispatch`
  (`sk_` key) and the dashboard's **Send due now** button (Messages page) do the same on demand.
- **Expiry** is judged when read: a subscription past its `expiresAt` is never claimed, counted or confirmed and is
  ended (`expired`) when it is touched; MongoDB TTL indexes remove expired subscriptions, messages, trigger runs and
  counters.
- Usage and events are sent by app-kit right after the request that queued them.

This folder is kept empty on purpose.
