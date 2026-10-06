# Jobs

None. Catalog & PIM runs no scheduled jobs, timers or background loops. Work that becomes due with time is done on
the request that touches it (see `api/due.js`):

- scheduled publish / unpublish: `item.updated@1` is published when the item is next read;
- expired stock holds: read as expired at once, stock given back when read or before stock is next taken or adjusted;
- event outbox leftovers: republished when the item is next read.

The dashboard's **Process due changes** button (`POST /v1/dashboard/due-work`) runs all three for one website.
