# jobs/

Scheduled handlers (`core` + `adapters` only), wired to signed cron routes in `app/cron/*` and `vercel.json` when
needed.

- `sweep.js` — `GET /cron/sweep` (hourly, `Authorization: Bearer $CRON_SECRET`): for every website served with
  `inspection` on, inspection photo slots past their `staleAt` are deleted — the object in the merchant's bucket when it
  was uploaded, then the slot (app-kit `sweepStaleUploads`, ≤ 100 per website per run, idempotent). Websites run
  independently.

Report links expire by their stored `expiresAt`, and events and usage are flushed by app-kit's background flusher.
