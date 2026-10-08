/**
 * Couriers and tracking links (PLAN 0.8.8: couriers with tracking-link templates; no courier is named in code). The
 * merchant's `couriers` list holds `{ key, name, trackingUrl }`: `trackingUrl` is an https template with `{tracking}`
 * where the (URL-encoded) tracking number goes, or '' when the courier has no tracking page. Also the pure parts of the
 * generic courier API (`adapters/couriers.js`): filling the booking body template and reading a value at a dotted path
 * of the courier's answer. No I/O.
 * @module
 */

/** At most this many couriers. */
export const MAX_COURIERS = 30;
/** Where the tracking number goes in a template. */
export const TRACKING_TOKEN = '{tracking}';
/** Longest tracking number. */
export const MAX_TRACKING = 80;
/** Longest tracking-link template. */
const MAX_TEMPLATE = 300;
/** A courier key. */
const KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** @typedef {{ key: string, name: string, trackingUrl: string }} Courier */

/**
 * Whether a text holds control characters.
 * @param {string} text
 */
export const hasControl = (text) => [...text].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

/**
 * Whether a tracking-link template is a usable https address once the number is filled in.
 * @param {string} template
 */
export const isTrackingTemplate = (template) => {
	if (template.length > MAX_TEMPLATE || !template.includes(TRACKING_TOKEN)) return false;
	try {
		const url = new URL(template.replaceAll(TRACKING_TOKEN, '0'));
		return url.protocol === 'https:' && url.username === '' && url.password === '';
	} catch {
		return false;
	}
};

/**
 * Check the list the merchant saves.
 * @param {unknown} value
 * @returns {{ ok: true, value: Courier[] } | { ok: false, errors: string[] }}
 */
export const checkCouriers = (value) => {
	if (!Array.isArray(value)) return { ok: false, errors: ['A list of couriers is expected.'] };
	/** @type {string[]} */
	const errors = [];
	if (value.length > MAX_COURIERS) errors.push(`At most ${MAX_COURIERS} couriers.`);
	/** @type {Courier[]} */
	const couriers = [];
	const keys = new Set();
	for (const raw of value) {
		const row = typeof raw === 'object' && raw !== null ? /** @type {Record<string, unknown>} */ (raw) : {};
		const key = typeof row.key === 'string' ? row.key.trim() : '';
		const name = typeof row.name === 'string' ? row.name.trim() : '';
		const trackingUrl = typeof row.trackingUrl === 'string' ? row.trackingUrl.trim() : '';
		if (!KEY.test(key)) {
			errors.push(`Courier key '${key}' must be 1–40 lowercase letters, digits, - or _.`);
			continue;
		}
		if (keys.has(key)) errors.push(`Courier '${key}' is listed twice.`);
		keys.add(key);
		if (!name || name.length > 60) errors.push(`Courier '${key}' needs a name of at most 60 characters.`);
		if (trackingUrl !== '' && !isTrackingTemplate(trackingUrl))
			errors.push(`Courier '${key}': the tracking link must be an https address containing ${TRACKING_TOKEN}.`);
		couriers.push({ key, name, trackingUrl });
	}
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value: couriers };
};

/**
 * A courier of the list by key, or null.
 * @param {unknown} list the saved `couriers` list
 * @param {string} key
 * @returns {Courier | null}
 */
export const courierOf = (list, key) =>
	(Array.isArray(list) ? /** @type {Courier[]} */ (list) : []).find((courier) => courier?.key === key) ?? null;

/**
 * The tracking link of a parcel ('' when the courier has no tracking page).
 * @param {string} template
 * @param {string} trackingNumber
 */
export const trackingLink = (template, trackingNumber) =>
	template && isTrackingTemplate(template) ? template.replaceAll(TRACKING_TOKEN, encodeURIComponent(trackingNumber)) : '';

/**
 * A tracking number staff typed or a courier API answered: trimmed, 1–{@link MAX_TRACKING} visible characters.
 * @param {unknown} value
 * @returns {string | null}
 */
export const cleanTracking = (value) => {
	const text =
		typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value.trim() : '';
	return text.length >= 1 && text.length <= MAX_TRACKING && !hasControl(text) ? text : null;
};

// ------------------------------------------------------------------------------------------------- courier APIs

/** The booking body when the connection has no template: every order field the API may need. */
export const DEFAULT_BODY_TEMPLATE = JSON.stringify({
	reference: '{number}',
	name: '{name}',
	phone: '{phone}',
	email: '{email}',
	address: '{line1}',
	address2: '{line2}',
	city: '{city}',
	area: '{area}',
	postalCode: '{postalCode}',
	country: '{country}',
	items: '{items}',
	amount: '{amount}',
	cod: '{cod}',
	currency: '{currency}',
	note: '{note}',
});

/** The fields a booking template may name. */
export const TEMPLATE_FIELDS = Object.freeze([
	'number',
	'name',
	'phone',
	'email',
	'line1',
	'line2',
	'city',
	'area',
	'postalCode',
	'country',
	'items',
	'amount',
	'total',
	'cod',
	'currency',
	'note',
]);

const PLACEHOLDER = new RegExp(`\\{(${TEMPLATE_FIELDS.join('|')})\\}`, 'g');

/**
 * Fill a template's `{field}` placeholders, each encoded by `encode`; unknown placeholders stay as they are.
 * @param {string} template
 * @param {Record<string, string>} values
 * @param {(value: string) => string} [encode]
 */
export const fillTemplate = (template, values, encode = (value) => value) =>
	template.replace(PLACEHOLDER, (_, name) => encode(values[name] ?? ''));

/**
 * Text inside a JSON string literal (so a filled value can never break out of its quotes).
 * @param {string} value
 */
export const jsonInner = (value) => JSON.stringify(value).slice(1, -1);

/** A dotted path into a JSON answer (`data.tracking_number`, `items.0.status`). */
const PATH = /^[A-Za-z0-9_$-]{1,64}(\.[A-Za-z0-9_$-]{1,64}){0,9}$/;

/**
 * Whether a dotted path is usable.
 * @param {unknown} path
 */
export const isPath = (path) => typeof path === 'string' && PATH.test(path);

/**
 * The value at a dotted path of a JSON answer, or undefined.
 * @param {unknown} value
 * @param {string} path
 * @returns {unknown}
 */
export const readPath = (value, path) => {
	let current = value;
	for (const part of path.split('.')) {
		if (typeof current !== 'object' || current === null || !Object.hasOwn(current, part)) return undefined;
		current = /** @type {Record<string, unknown>} */ (current)[part];
	}
	return current;
};
