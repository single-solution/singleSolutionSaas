# jobs/

No scheduled work: the product has no crons, no timers and no background passes (PLAN F.19, event-driven only).
Work runs on the request or event that causes it, expiries are judged when read, and anything a merchant must start
goes behind a dashboard button. Trigger-run handlers live here (`core` + `adapters` only).
