# jobs/

Loyalty runs no scheduled or periodic work: there are no cron routes and no background tasks. A member's lapsed
points, due tier review and expiry notice are handled when a request reads or moves that member, and the merchant runs
the whole website from the dashboard ("Run expiry now", `POST /v1/dashboard/expiry:run`) or `POST /v1/expiry:run`.
This folder is kept empty on purpose.
