/**
 * The generic courier API (PLAN 0.8.8: courier booking via courier APIs with the merchant's keys; one generic adapter,
 * no named couriers in code), like Notifications' generic HTTP gateway. The `courier` connection holds
 * `{ bookUrl, trackUrl, apiKey, headers?, bodyTemplate?, trackingPath?, statusPath? }`:
 *
 * - booking: `POST <bookUrl>` with the JSON body built from `bodyTemplate` (default `core/couriers.js`
 *   `DEFAULT_BODY_TEMPLATE`), whose `{number}`, `{name}`, `{phone}`, `{email}`, `{line1}`, `{line2}`, `{city}`, `{area}`,
 *   `{postalCode}`, `{country}`, `{items}`, `{amount}` (decimal), `{total}` (minor units), `{cod}` (decimal to collect,
 *   0 when prepaid), `{currency}` and `{note}` are filled JSON-escaped; any 2xx answer whose JSON has a tracking
 *   number at `trackingPath` (default `trackingNumber`) is a booking;
 * - tracking: `GET <trackUrl>` with `{tracking}` filled (URL-encoded); the status text is read at `statusPath`
 *   (default `status`);
 * - `headers`: an object (or JSON object text) of extra headers whose values may hold `{apiKey}`; without it the key
 *   goes as `Authorization: Bearer <apiKey>`.
 *
 * Every call goes through the injected `send` (`@ss/net` under the product's outbound policy: https only, every DNS
 * answer vetted, no redirects) with an 8 s timeout and a 64 kB answer cap. The key never appears in errors.
 * @module
 */
import { checkUrl, createOutboundPolicy, isNetError } from '@ss/net';
import {
	DEFAULT_BODY_TEMPLATE,
	TRACKING_TOKEN,
	cleanTracking,
	fillTemplate,
	isPath,
	isTrackingTemplate,
	jsonInner,
	readPath,
} from '../core/couriers.js';
import { toDecimal } from '../core/money.js';

/** @typedef {(url: string, init?: import('@ss/net').SafeFetchInit) => Promise<import('@ss/net').SafeResponse>} OutboundSend */
/** @typedef {import('../core/model.js').OrderRecord} OrderRecord */

/** One courier call's deadline. */
export const COURIER_TIMEOUT_MS = 8000;
/** The largest courier answer read. */
export const COURIER_MAX_BYTES = 64 * 1024;
/** The longest status text kept. */
const MAX_STATUS = 200;

/**
 * @typedef {object} CourierKeys
 * @property {string} bookUrl
 * @property {string} trackUrl
 * @property {string} apiKey
 * @property {Record<string, string> | string} [headers]
 * @property {string} [bodyTemplate]
 * @property {string} [trackingPath]
 * @property {string} [statusPath]
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Extra headers (an object or JSON object text), or null when invalid.
 * @param {unknown} value
 * @returns {Record<string, string> | null}
 */
const headersOf = (value) => {
	if (value === undefined || value === '') return {};
	/** @type {unknown} */
	let parsed = value;
	if (typeof value === 'string')
		try {
			parsed = JSON.parse(value);
		} catch {
			return null;
		}
	if (!isObject(parsed) || Object.keys(parsed).length > 20) return null;
	const entries = Object.entries(parsed);
	return entries.every(([key, v]) => /^[A-Za-z0-9-]{1,64}$/.test(key) && typeof v === 'string' && !/[\r\n]/.test(v))
		? Object.fromEntries(entries.map(([key, v]) => [key.toLowerCase(), String(v)]))
		: null;
};

/**
 * Why a connection value is not usable, or null.
 * @param {unknown} value
 * @param {import('@ss/net').OutboundPolicy} policy
 * @returns {string | null}
 */
export const courierViolation = (value, policy) => {
	if (!isObject(value)) return 'Fill in the booking address, the tracking address and the API key.';
	const book = typeof value.bookUrl === 'string' ? value.bookUrl : '';
	if (!book.startsWith('https://') || !checkUrl(book, policy).ok) return 'The booking address must be a public https address.';
	const track = typeof value.trackUrl === 'string' ? value.trackUrl : '';
	if (!isTrackingTemplate(track) || !checkUrl(track.replaceAll(TRACKING_TOKEN, '0'), policy).ok)
		return `The tracking address must be a public https address containing ${TRACKING_TOKEN}.`;
	if (typeof value.apiKey !== 'string' || value.apiKey.trim() === '' || value.apiKey.length > 2000)
		return 'The API key is required.';
	if (headersOf(value.headers) === null) return 'Headers must be a JSON object of text values.';
	if (value.bodyTemplate !== undefined && value.bodyTemplate !== '') {
		if (typeof value.bodyTemplate !== 'string' || value.bodyTemplate.length > 10_000)
			return 'The body template must be JSON text.';
		try {
			JSON.parse(fillTemplate(value.bodyTemplate, {}, jsonInner));
		} catch {
			return 'The body template must be JSON once its {fields} are filled in.';
		}
	}
	for (const field of /** @type {const} */ (['trackingPath', 'statusPath']))
		if (value[field] !== undefined && value[field] !== '' && !isPath(value[field]))
			return `${field} must be a dotted path such as data.${field === 'trackingPath' ? 'tracking_number' : 'status'}.`;
	return null;
};

/**
 * The booking values of an order (all text; JSON-escaped when filled in).
 * @param {OrderRecord} order
 * @returns {Record<string, string>}
 */
export const bookingValues = (order) => {
	const address = order.address;
	const { total, currency } = order.totals;
	const cashMethods = ['cod', 'pickup'];
	const toCollect = cashMethods.includes(order.payment.method) ? Math.max(0, total - order.payment.paid) : 0;
	return {
		number: order.number,
		name: address?.name || order.customer.name,
		phone: address?.phone || order.customer.phone,
		email: order.customer.email,
		line1: address?.line1 ?? '',
		line2: address?.line2 ?? '',
		city: address?.city ?? '',
		area: address?.area ?? '',
		postalCode: address?.postalCode ?? '',
		country: address?.country ?? '',
		items: String(order.lines.filter((line) => line.kind === 'physical').reduce((sum, line) => sum + line.quantity, 0)),
		amount: toDecimal(total, currency),
		total: String(total),
		cod: toDecimal(toCollect, currency),
		currency,
		note: address?.notes || order.note,
	};
};

/**
 * @param {{ send: OutboundSend, policy?: import('@ss/net').OutboundPolicy }} options
 */
export const createCouriers = ({ send, policy = createOutboundPolicy() }) => {
	/**
	 * The request headers of a call.
	 * @param {CourierKeys} keys
	 * @param {boolean} body
	 */
	const headers = (keys, body) => {
		const extra = headersOf(keys.headers) ?? {};
		const filled = Object.fromEntries(Object.entries(extra).map(([name, v]) => [name, v.replaceAll('{apiKey}', keys.apiKey)]));
		return {
			accept: 'application/json',
			...(body ? { 'content-type': 'application/json' } : {}),
			...(Object.keys(filled).length > 0 ? filled : { authorization: `Bearer ${keys.apiKey}` }),
		};
	};

	/**
	 * One call: the status and the JSON answer (null when not JSON); status 0 when the courier could not be reached.
	 * @param {string} url
	 * @param {import('@ss/net').SafeFetchInit} init
	 * @returns {Promise<{ status: number, json: unknown }>}
	 */
	const call = async (url, init) => {
		try {
			const response = await send(url, {
				...init,
				timeoutMs: COURIER_TIMEOUT_MS,
				maxBytes: COURIER_MAX_BYTES,
				redirect: 'error',
			});
			/** @type {unknown} */
			let json = null;
			try {
				json = JSON.parse(response.body.toString('utf8'));
			} catch {
				json = null;
			}
			return { status: response.status, json };
		} catch (error) {
			if (!isNetError(error)) throw error;
			return { status: 0, json: null };
		}
	};

	/** @param {number} status */
	const failure = (status) => (status === 0 ? 'The courier could not be reached.' : `The courier answered ${status}.`);

	return Object.freeze({
		/**
		 * The connection test: the shape and the addresses only (read-only: a courier API cannot be checked without
		 * booking).
		 * @param {unknown} value
		 * @returns {Promise<{ ok: boolean, message?: string }>}
		 */
		test: async (value) => {
			const violation = courierViolation(value, policy);
			return violation ? { ok: false, message: violation } : { ok: true };
		},
		/**
		 * Book a shipment for an order.
		 * @param {{ order: OrderRecord, value: unknown }} input `value`: the `courier` connection
		 * @returns {Promise<{ ok: true, trackingNumber: string } | { ok: false, message: string }>}
		 */
		book: async ({ order, value }) => {
			const violation = courierViolation(value, policy);
			if (violation) return { ok: false, message: violation };
			const keys = /** @type {CourierKeys} */ (value);
			const template = keys.bodyTemplate || DEFAULT_BODY_TEMPLATE;
			const answer = await call(keys.bookUrl, {
				method: 'POST',
				headers: headers(keys, true),
				body: fillTemplate(template, bookingValues(order), jsonInner),
			});
			if (answer.status < 200 || answer.status > 299) return { ok: false, message: failure(answer.status) };
			const trackingNumber = cleanTracking(readPath(answer.json, keys.trackingPath || 'trackingNumber'));
			return trackingNumber
				? { ok: true, trackingNumber }
				: { ok: false, message: 'The courier did not answer a tracking number.' };
		},
		/**
		 * The latest status of a booked parcel.
		 * @param {{ trackingNumber: string, value: unknown }} input
		 * @returns {Promise<{ ok: true, status: string } | { ok: false, message: string }>}
		 */
		track: async ({ trackingNumber, value }) => {
			const violation = courierViolation(value, policy);
			if (violation) return { ok: false, message: violation };
			const keys = /** @type {CourierKeys} */ (value);
			const answer = await call(keys.trackUrl.replaceAll(TRACKING_TOKEN, encodeURIComponent(trackingNumber)), {
				method: 'GET',
				headers: headers(keys, false),
			});
			if (answer.status < 200 || answer.status > 299) return { ok: false, message: failure(answer.status) };
			const status = readPath(answer.json, keys.statusPath || 'status');
			const text = typeof status === 'string' || typeof status === 'number' ? String(status).trim().slice(0, MAX_STATUS) : '';
			return text ? { ok: true, status: text } : { ok: false, message: 'The courier did not answer a status.' };
		},
	});
};

/** @typedef {ReturnType<typeof createCouriers>} Couriers */
