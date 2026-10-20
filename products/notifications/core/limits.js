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

/**
 * The most messages one address or number gets in the last hour and in the last day, whatever the merchant's own send
 * limits say and required messages included (SR-7-2): a flaw in a product that calls Notifications can never cost the
 * merchant more than this on one recipient. A text costs far more than an email, so those are lower. Messages that
 * were skipped cost nothing and are not counted.
 * @type {Readonly<Record<import('./channels.js').Channel, Readonly<{ perHour: number, perDay: number }>>>}
 */
export const RECIPIENT_CEILINGS = Object.freeze({
	email: Object.freeze({ perHour: 100, perDay: 1000 }),
	sms: Object.freeze({ perHour: 30, perDay: 200 }),
	whatsapp: Object.freeze({ perHour: 30, perDay: 200 }),
	push: Object.freeze({ perHour: 100, perDay: 1000 }),
	staff_push: Object.freeze({ perHour: 100, perDay: 1000 }),
});

/**
 * The same ceilings for Accounts' messages (sign-in codes and links): twice as high, so a person who asks for a code
 * again and again is not shut out while the other messages of the address are.
 * @type {typeof RECIPIENT_CEILINGS}
 */
export const ACCOUNT_CEILINGS = Object.freeze({
	email: Object.freeze({ perHour: 200, perDay: 2000 }),
	sms: Object.freeze({ perHour: 60, perDay: 400 }),
	whatsapp: Object.freeze({ perHour: 60, perDay: 400 }),
	push: Object.freeze({ perHour: 200, perDay: 2000 }),
	staff_push: Object.freeze({ perHour: 200, perDay: 2000 }),
});

/**
 * The most texts (SMS) and WhatsApp messages a website sends to anyone in a minute: lower than the 600 a minute every
 * send route allows, because each of these is billed (SR-7-2).
 */
export const CHANNEL_MINUTE_CEILINGS = Object.freeze({ sms: 100, whatsapp: 100 });
