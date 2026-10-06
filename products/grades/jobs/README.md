# jobs/

Scheduled handlers (`core` + `adapters` only), wired to signed cron routes in `app/cron/*` and `vercel.json` when
needed.

- `sweep.js` — `GET /cron/sweep` (daily catch-up, `Authorization: Bearer $CRON_SECRET`): for every website served
  with `inspection` on, inspection photo slots past their `staleAt` are deleted — the object in the merchant's bucket
  when it was uploaded, then the slot (app-kit `sweepStaleUploads`, ≤ 100 per website per run, idempotent). Websites
  run independently. The same sweep runs after requests for the request's website (`product.background.every`, at most
  hourly, ≤ 25 slots), registered by `wireJobs`; a slot past its `staleAt` never counts, whether or not it was swept.

Report links expire by their stored `expiresAt`, and events and usage are flushed by app-kit's background flusher.
