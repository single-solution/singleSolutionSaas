# jobs/

Wishlist needs no scheduled work: guest lists and signal records expire through TTL indexes in the merchant's
database (`adapters/db.js`), and app-kit flushes the event outbox in the background.
