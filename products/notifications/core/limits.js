/**
 * Fixed limits of Notifications (settings-ownership step 1). Each of these was a merchant setting once; none is a
 * business choice (a wrong retry timing loses messages or hammers the provider), so the product owns them and no form
 * offers them. The value is the old default. Pure; no I/O.
 * @module
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * The waits before attempts 2, 3, … of a failed message of every channel (email, SMS, WhatsApp, browser push, staff
 * push), each judged on the next use of the website after it: the first attempt is at once, then 1 and 5 minutes later.
 */
export const RETRY_WAITS = Object.freeze([MINUTE, 5 * MINUTE]);

/** The same for an event sent to a merchant's webhook URL: at once, then 1, 5 and 30 minutes and 2 hours later. */
export const WEBHOOK_RETRY_WAITS = Object.freeze([MINUTE, 5 * MINUTE, 30 * MINUTE, 2 * HOUR]);

/** The furthest ahead, in days, a delayed send may be set. */
export const MAX_DELAY_DAYS = 30;

/** Templates a website keeps. */
export const MAX_TEMPLATES = 1000;

/** Webhook URLs a website sends events to. */
export const MAX_WEBHOOK_URLS = 5;

/** Browser push subscriptions of visitors a website keeps (the merchant's staff are not counted; SR-7-1). */
export const MAX_VISITOR_SUBSCRIPTIONS = 50_000;

/**
 * Days a visitor's browser push subscription is kept without being seen: a new subscribe from the browser and a push the
 * browser accepted both refresh it, then the database's expiry index removes it (SR-7-1).
 */
export const VISITOR_SUBSCRIPTION_DAYS = 365;
