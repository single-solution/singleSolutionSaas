# jobs/

Scheduled handlers (`core` + `adapters` only), wired to signed cron routes in `app/cron/*` and `vercel.json` when
needed. Grades ships none: pending inspection photo slots expire through a TTL index in the merchant's database, report
links expire by their stored `expiresAt`, and events and usage are flushed by app-kit's background flusher.
