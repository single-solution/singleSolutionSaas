# jobs/

Reviews & Ratings runs no scheduled or periodic work: there are no cron routes, no background passes and no polling.

- **Review requests** are sent when the order completes: with `request_flow` on and `collection.send_on_completion`
  on, `order.completed@1` (or `POST /v1/review-requests`) runs that website's request flow right away — the new
  request plus whatever else is due (reminders, retries after a failed send, requests held by quiet hours), bounded
  by `request_flow.max_per_run`. There is no delayed send (it would need a timer). Merchants can run the flow on
  demand with `POST /v1/request-flow:run` (`sk_`) or **Send due requests now** in the dashboard.
- **Expiry** is judged when read: a request past its `expiresAt` reads and filters as `expired` and verifies no
  review; it is marked expired when touched (link opened, flow run). TTL indexes remove old requests and orders.
- **Stale photo slots** (presigned uploads never attached) can no longer be attached past `staleAt`. Their objects
  and records are deleted on the website's next upload (bounded) or with **Clean up photo uploads** in the
  dashboard; a TTL index on `purgeAt` removes forgotten records.
- Usage and events are sent by app-kit right after the request that queued them.

This folder is kept empty on purpose.
