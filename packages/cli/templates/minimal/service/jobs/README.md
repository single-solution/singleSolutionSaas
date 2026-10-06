# jobs/

Nothing here runs on a schedule: the product has no crons, no timers and no background passes (PLAN F.19,
event-driven only). Work happens on the request or event that causes it (app-kit sends usage and events after the
request), anything with an expiry is treated as expired when read, data that can simply disappear gets a MongoDB TTL
index, and work a merchant must start goes
behind a dashboard button. Put such trigger-run handlers here (`core` + `adapters` only).
