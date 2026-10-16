/**
 * Couriers and tracking links (PLAN 0.8.8: couriers with tracking-link templates; no courier is named in code). The
 * merchant's `couriers` list holds `{ key, name, trackingUrl, connection }`: `trackingUrl` is an https template with
 * `{tracking}` where the (URL-encoded) tracking number goes, or '' when the courier has no tracking page; `connection`
 * is the courier API connection its shipments are booked and tracked through (`courier_1` … `courier_5`, each holding one
 * courier's own keys, fixed-choices E25), or '' when it is shipped by hand only. Several couriers may book at once. Also the pure parts of the
 * generic courier API (`adapters/couriers.js`): filling the booking body template and reading a value at a dotted path
 * of the courier's answer. No I/O.
 * @module
 */

/** At most this many couriers. */
const MAX_COURIERS = 30;
/** Where the tracking number goes in a template. */
export const TRACKING_TOKEN = '{tracking}';
/** Longest tracking number. */
export const MAX_TRACKING = 80;
/** Longest tracking-link template. */
const MAX_TEMPLATE = 300;
/** A courier key. */
const KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** The courier API connections: one per courier the merchant books with (E25). */
export const COURIER_CONNECTIONS = Object.freeze(['courier_1', 'courier_2', 'courier_3', 'courier_4', 'courier_5']);

/** @typedef {{ key: string, name: string, trackingUrl: string, connection: string }} Courier */

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
		const connection = row.connection ?? '';
		if (!KEY.test(key)) {
			errors.push(`Courier key '${key}' must be 1–40 lowercase letters, digits, - or _.`);
			continue;
		}
		if (keys.has(key)) errors.push(`Courier '${key}' is listed twice.`);
		keys.add(key);
		if (!name || name.length > 60) errors.push(`Courier '${key}' needs a name of at most 60 characters.`);
		if (trackingUrl !== '' && !isTrackingTemplate(trackingUrl))
			errors.push(`Courier '${key}': the tracking link must be an https address containing ${TRACKING_TOKEN}.`);
		if (connection !== '' && !COURIER_CONNECTIONS.includes(/** @type {string} */ (connection)))
			errors.push(`Courier '${key}': the booking connection is one of ${COURIER_CONNECTIONS.join(', ')}, or none.`);
		couriers.push({ key, name, trackingUrl, connection: String(connection) });
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
 * The courier a booking goes to (E25): the one staff picked (by key), else the preselected one (the `courier_apis`
 * setting `courier`) while it has a booking connection, else the first of the list that has one; null when none.
 * @param {unknown} list the `couriers` list
 * @param {{ picked: string, preselected: string }} keys
 * @returns {Courier | null}
 */
export const bookingCourier = (list, { picked, preselected }) => {
	if (picked) return courierOf(list, picked);
	const first = courierOf(list, preselected);
	if (first?.connection) return first;
	return (Array.isArray(list) ? /** @type {Courier[]} */ (list) : []).find((courier) => courier?.connection) ?? null;
};

/**
 * A courier of the list by its key or its name (staff may give either; an order keeps the name, E28).
 * @param {unknown} list
 * @param {string} keyOrName
 * @returns {Courier | null}
 */
export const courierNamed = (list, keyOrName) => {
	const name = keyOrName.trim().toLowerCase();
	return (
		courierOf(list, keyOrName) ??
		(Array.isArray(list) ? /** @type {Courier[]} */ (list) : []).find(
			(courier) =>
				String(courier?.name ?? '')
					.trim()
					.toLowerCase() === name,
		) ??
		null
	);
};

/**
 * The tracking link of a package ('' when the courier has no tracking page).
 * @param {string} template
 * @param {string} trackingNumber
 */
export const trackingLink = (template, trackingNumber) =>
	template && isTrackingTemplate(template) ? template.replaceAll(TRACKING_TOKEN, encodeURIComponent(trackingNumber)) : '';

/**
 * A package's tracking page, built on read from today's `couriers` list (E28): the courier is found by its key or its
 * name (any case); without a template, the address kept on the shipment (a courier API's answer), else ''.
 * @param {unknown} couriers the `couriers` list
 * @param {{ courier: string, trackingNumber: string, trackingUrl?: string } | null} shipment
 */
export const shipmentLink = (couriers, shipment) => {
	if (!shipment) return '';
	const list = Array.isArray(couriers) ? /** @type {Courier[]} */ (couriers) : [];
	const name = String(shipment.courier ?? '')
		.trim()
		.toLowerCase();
	const courier =
		courierOf(list, shipment.courier) ??
		list.find(
			(item) =>
				String(item?.name ?? '')
					.trim()
					.toLowerCase() === name,
		) ??
		null;
	const built = courier && shipment.trackingNumber ? trackingLink(courier.trackingUrl, shipment.trackingNumber) : '';
	const kept = typeof shipment.trackingUrl === 'string' && /^https:\/\//.test(shipment.trackingUrl) ? shipment.trackingUrl : '';
	return built || kept;
};

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
	region: '{region}',
	postalCode: '{postalCode}',
	country: '{country}',
	items: '{items}',
	amount: '{amount}',
	cod: '{cod}',
	currency: '{currency}',
	weightG: '{weightG}',
	note: '{note}',
});

/** The fields a booking template may name. */
const TEMPLATE_FIELDS = Object.freeze([
	'number',
	'name',
	'phone',
	'email',
	'line1',
	'line2',
	'city',
	'area',
	'region',
	'postalCode',
	'country',
	'items',
	'amount',
	'total',
	'cod',
	'currency',
	'weightG',
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
