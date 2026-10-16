/**
 * Branding logo rules, shared by the server check and the admin Settings screen. No imports: the browser bundle reads
 * this file, so it must never pull server code in.
 */

/** Logo file types (never SVG) and size cap (PLAN 0.8.2 Branding). */
export const LOGO_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
export const LOGO_MAX_BYTES = 200 * 1024;
