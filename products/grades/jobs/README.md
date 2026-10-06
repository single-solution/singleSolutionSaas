# jobs/

None. This product runs no scheduled jobs, background loops or polling: work happens inside the request that makes it
relevant, for the records that request touches.

- Inspection photo slots that were never confirmed stop counting once past their `staleAt` (checked on read). They are
  deleted — the object in the merchant's bucket when it was uploaded, then the slot (app-kit `sweepStaleUploads`) — on
  the website's next new photo slot (`POST /v1/inspections/{id}/photos`, up to 25 stale slots) or from the dashboard's
  "Clean up stale photos" button (`POST /v1/dashboard/photos:sweep`, up to 100). A TTL index on `purgeAt` (a week
  later) removes any record left behind.
- Report links expire by their stored `expiresAt` (refused on read).
