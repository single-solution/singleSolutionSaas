/**
 * Outgoing webhooks (PLAN 0.8.5): events sent to the merchant's own URLs, signed with the merchant's signing secret so
 * the receiver can check them (the signing is in `adapters/signatures.js`), and the check of the events other
 * products forward (PLAN 0.8.10 K5). No I/O.
 * @module
 */
import { isId } from '@ss/contracts';

/** Events a merchant can receive. */
export const WEBHOOK_EVENTS = Object.freeze(['message.sent', 'message.failed', 'recipient.unsubscribed']);
/** Name of the signature header. */
export const SIGNATURE_HEADER = 'ss-signature';
/** URLs a website may send events to, at most. */
const MAX_WEBHOOK_URLS = 5;
/** A receiver should refuse signatures older than this (the docs say so). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;
/** Largest `data` of a forwarded event, in bytes of JSON. */
export const EVENT_DATA_MAX_BYTES = 16 * 1024;

/** Event types other products forward through `POST /v1/events`: `<product id>.<event>`. */
const PRODUCT_EVENT = /^(?:accounts|ecommerce|chat|payments|growth)\.[a-z][a-z0-9_.]{0,62}$/;
/** An ISO-8601 time with its offset: date, hours and minutes, optional seconds and fraction. */
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * The webhook URLs of a website's settings that are https addresses (the setting allows up to five).
 * @param {unknown} urls
 * @returns {string[]}
 */
export const webhookUrls = (urls) =>
	(Array.isArray(urls) ? urls : [])
		.filter((url) => typeof url === 'string' && /^https:\/\/[^\s]+$/.test(url))
		.slice(0, MAX_WEBHOOK_URLS);

/**
 * The instant of a real ISO-8601 time (`2026-10-01T10:00:00.000Z`, `2026-10-01T15:00+05:00`), or null: the day must
 * exist and the clock and offset be in range.
 * @param {unknown} value
 * @returns {number | null} epoch ms
 */
export const eventTime = (value) => {
	if (typeof value !== 'string') return null;
	const match = ISO_TIME.exec(value);
	if (!match) return null;
	const [, year, month, day, hour, minute, second = '0', offsetHour = '0', offsetMinute = '0'] = match;
	const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
	if (date.toISOString().slice(0, 10) !== `${year}-${month}-${day}`) return null;
	if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 || Number(offsetHour) > 23 || Number(offsetMinute) > 59)
		return null;
	const at = Date.parse(value);
	return Number.isFinite(at) ? at : null;
};

/**
 * @typedef {object} ForwardedEvent
 * @property {string | null} id the product's own event id (`evt_…`), null when it sent none
 * @property {string} type `<product id>.<event>`
 * @property {number | null} at when it happened (epoch ms), null when it sent no time
 * @property {Record<string, unknown>} data
 */

/**
 * Check an event another product forwards (`POST /v1/events` with `{ id?, type, at?, data }`): its type is
 * `<product id>.<event>`, its data an object of at most 16 kB of JSON, its optional id a well-formed `evt_…` id and its
 * optional time a real ISO-8601 time.
 * @param {unknown} input
 * @returns {{ ok: true, value: ForwardedEvent } | { ok: false, field: string, message: string }}
 */
export const checkForwardedEvent = (input) => {
	const body = typeof input === 'object' && input !== null ? /** @type {Record<string, unknown>} */ (input) : {};
	/** @param {string} field @param {string} message */
	const fail = (field, message) => /** @type {const} */ ({ ok: false, field, message });
	if (typeof body.type !== 'string' || !PRODUCT_EVENT.test(body.type))
		return fail('type', 'Name the event as <product id>.<event>, for example payments.payment.paid.');
	const data = body.data;
	if (typeof data !== 'object' || data === null || Array.isArray(data) || JSON.stringify(data).length > EVENT_DATA_MAX_BYTES)
		return fail('data', 'data is an object of at most 16 kB of JSON.');
	if (body.id !== undefined && !isId(body.id, 'evt')) return fail('id', 'id is the event id of your product (evt_…).');
	const at = body.at === undefined ? null : eventTime(body.at);
	if (body.at !== undefined && at === null) return fail('at', 'at is an ISO-8601 time, for example 2026-10-01T10:00:00.000Z.');
	return {
		ok: true,
		value: {
			id: body.id === undefined ? null : /** @type {string} */ (body.id),
			type: body.type,
			at,
			data: /** @type {Record<string, unknown>} */ (data),
		},
	};
};
