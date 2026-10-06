# jobs/

Deals runs no scheduled or periodic work: there are no cron routes and no background tasks. Price locks and quotes
carry their expiry and are judged when they are used, a MongoDB TTL index removes old quotes, and app-kit sends the
metered usage and the event outbox right after the request that queued them. This folder is kept empty on purpose.
