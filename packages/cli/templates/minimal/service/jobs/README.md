# jobs/

Scheduled work (`core` + `adapters` only). `daily.js` is the one daily cron (`GET /cron/daily` in `vercel.json`, Bearer
`CRON_SECRET`): a catch-up that flushes the queues and sends the heartbeat. Work that must happen sooner runs when data
is read and as throttled background work after requests, registered in `index.js` (`wireJobs`) with
`product.background.every(name, intervalMs, fn, { per: 'website' })`.
