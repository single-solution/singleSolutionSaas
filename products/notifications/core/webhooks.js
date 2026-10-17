/**
 * Outgoing webhooks (PLAN 0.8.5): events sent to the merchant's own URLs, signed with the merchant's signing secret so
 * the receiver can check them (the signing is in `adapters/signatures.js`), the list of URLs with the events each one
 * takes (`webhook_urls`, PLAN 0.8.10 N5) with its summary for the website's Setup sheet (hosts only) and the check of
 * the events other products forward (PLAN 0.8.10 K5). No I/O.
 * @module
 */
import { isId } from '@ss/contracts';
import { MAX_WEBHOOK_URLS } from './limits.js';

/** Events a merchant can receive. */
export const WEBHOOK_EVENTS = Object.freeze(['message.sent', 'message.failed', 'recipient.unsubscribed']);
/** Name of the signature header. */
export const SIGNATURE_HEADER = 'ss-signature';
/** Event types one URL may name, at most. */
const MAX_URL_EVENTS = 50;
/** Longest webhook URL. */
const MAX_URL_LENGTH = 2048;
/** Largest `data` of a forwarded event, in bytes of JSON. */
const EVENT_DATA_MAX_BYTES = 16 * 1024;
/** Longest summary of the list in the website's Setup sheet (the kit's limit for a list summary). */
const SUMMARY_MAX = 300;

/**
 * Event types other products forward through `POST /v1/events`: `<product id>.<event>` for any product id (the
 * `@ss/contracts` pattern, so a product made later forwards its events too), but never `notifications.` nor the first
 * part of Notifications' own events (`message.`, `recipient.`), which are named without a product prefix.
 */
const PRODUCT_EVENT = /^(?!(?:notifications|message|recipient)\.)[a-z][a-z0-9-]{1,30}\.[a-z][a-z0-9_.]{0,62}$/;
/** An ISO-8601 time with its offset: date, hours and minutes, optional seconds and fraction. */
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * One webhook URL and the events it takes (empty: every event).
 * @typedef {{ url: string, events: string[] }} WebhookUrl
 */

/**
 * Whether a value is a webhook URL: an https address without user or password, at most 2,048 characters.
 * @param {unknown} url
 * @returns {url is string}
 */
const isWebhookUrl = (url) => {
	if (typeof url !== 'string' || url.length > MAX_URL_LENGTH || !/^https:\/\/[^\s]+$/.test(url)) return false;
	try {
		const parsed = new URL(url);
		return parsed.username === '' && parsed.password === '';
	} catch {
		return false;
	}
};

/**
 * Whether a value names an event a URL can take: Notifications' own (`message.sent`) or another product's
 * (`payments.payment.paid`).
 * @param {unknown} type
 * @returns {type is string}
 */
const isEventType = (type) => typeof type === 'string' && (WEBHOOK_EVENTS.includes(type) || PRODUCT_EVENT.test(type));

/**
 * Check the list `webhook_urls`: at most `MAX_WEBHOOK_URLS` https URLs (five), each once,
 * each with the events it takes (at most 50 types; empty takes every event).
 * @param {unknown} input
 * @returns {{ ok: true, value: WebhookUrl[] } | { ok: false, errors: Array<{ path: string, message: string }> }}
 */
export const checkWebhookUrls = (input) => {
	const max = MAX_WEBHOOK_URLS;
	if (!Array.isArray(input)) return { ok: false, errors: [{ path: '/value', message: 'The list is [{ url, events }].' }] };
	if (input.length > max) return { ok: false, errors: [{ path: '/value', message: `Add at most ${max} URLs.` }] };
	/** @type {Array<{ path: string, message: string }>} */
	const errors = [];
	/** @type {WebhookUrl[]} */
	const value = [];
	for (const [at, raw] of input.entries()) {
		const entry = typeof raw === 'object' && raw !== null ? /** @type {Record<string, unknown>} */ (raw) : {};
		const url = typeof entry.url === 'string' ? entry.url.trim() : entry.url;
		if (!isWebhookUrl(url))
			errors.push({ path: `/value/${at}/url`, message: 'Use an https address of at most 2048 characters.' });
		else if (value.some((other) => other.url === url))
			errors.push({ path: `/value/${at}/url`, message: 'This URL is listed twice.' });
		const events = entry.events ?? [];
		if (!Array.isArray(events) || events.length > MAX_URL_EVENTS || !events.every(isEventType))
			errors.push({
				path: `/value/${at}/events`,
				message: `List at most ${MAX_URL_EVENTS} event types, such as message.failed or payments.payment.paid (none: every event).`,
			});
		else if (isWebhookUrl(url)) value.push({ url, events: [...new Set(events)] });
	}
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
};

/**
 * The URLs that take an event: those that name its type, and those that name none.
 * @param {ReadonlyArray<WebhookUrl>} list
 * @param {string} type
 * @returns {string[]}
 */
export const urlsFor = (list, type) =>
	list.filter((entry) => entry.events.length === 0 || entry.events.includes(type)).map((entry) => entry.url);

/** Names as people read them: `a`, `a and b`, `a, b and c`. @param {string[]} names */
const listed = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/**
 * The list `webhook_urls` in a few words for the website's Setup sheet: how many URLs, on which hosts, and which take
 * every event (for example `2 URLs on hooks.example.com and api.example.com; 1 takes every event.`). Hosts only, never
 * a path or a query, which may hold a token; at most 300 characters (hosts that do not fit are counted instead).
 * @param {ReadonlyArray<WebhookUrl>} list
 * @returns {string}
 */
export const webhookUrlsSummary = (list) => {
	if (list.length === 0) return 'No URLs yet.';
	const hosts = [...new Set(list.map((entry) => new URL(entry.url).hostname))];
	const every = list.filter((entry) => entry.events.length === 0).length;
	const one = list.length === 1;
	const urls = `${list.length} ${one ? 'URL' : 'URLs'}`;
	const takes =
		every === list.length
			? one
				? 'it takes every event'
				: 'all take every event'
			: every === 0
				? one
					? 'it takes only the events it names'
					: 'each takes only the events it names'
				: `${every} ${every === 1 ? 'takes' : 'take'} every event`;
	for (let shown = hosts.length; shown > 0; shown -= 1) {
		const names = shown === hosts.length ? hosts : [...hosts.slice(0, shown), `${hosts.length - shown} more`];
		const text = `${urls} on ${listed(names)}; ${takes}.`;
		if (text.length <= SUMMARY_MAX) return text;
	}
	return `${urls} on ${hosts.length} ${hosts.length === 1 ? 'host' : 'hosts'}; ${takes}.`;
};

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
