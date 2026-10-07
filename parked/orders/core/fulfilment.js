/**
 * Fulfilment (pure): the merchant's carriers with tracking URL templates (merchant data — no carrier is shipped with
 * the product), tracking links and the fulfilment patch of an order. Ported from the store's courier list: templates
 * must be https:// with a `{tracking}` token, the number is URL-encoded, a carrier removed later still shows its key.
 * @module
 */
import { cleanText, httpsUrl, isObject, issue } from './text.js';

/** Where the tracking number goes in a template. */
export const TRACKING_TOKEN = '{tracking}';
/** Longest tracking number. */
export const MAX_TRACKING = 80;

/**
 * @typedef {{ key: string, name: string, template: string | null, serviceLevels: string[] }} Carrier
 */

/**
 * An https:// template with the token (null when unsafe or without the token).
 * @param {unknown} value
 * @returns {string | null}
 */
export const safeTemplate = (value) => {
	if (typeof value !== 'string' || !value.includes(TRACKING_TOKEN)) return null;
	return httpsUrl(value.split(TRACKING_TOKEN).join('0')) ? value.trim() : null;
};

/**
 * Carriers from the `fulfilment` settings (duplicates dropped, unsafe templates cleared).
 * @param {unknown} raw
 * @returns {Carrier[]}
 */
export const carriersOf = (raw) => {
	/** @type {Carrier[]} */
	const out = [];
	for (const entry of Array.isArray(raw) ? raw : []) {
		if (!isObject(entry) || typeof entry.key !== 'string' || out.some((c) => c.key === entry.key)) continue;
		const name = cleanText(entry.name, 80);
		if (!name) continue;
		out.push({
			key: entry.key,
			name,
			template: safeTemplate(entry.tracking_url_template),
			serviceLevels: (Array.isArray(entry.service_levels) ? entry.service_levels : []).filter((s) => typeof s === 'string'),
		});
	}
	return out;
};

/**
 * Tracking page for a number ('' when the template is missing or unsafe, or there is no number).
 * @param {string | null | undefined} template
 * @param {string | null | undefined} number
 */
export const trackingUrl = (template, number) => {
	const value = number?.trim();
	const safe = safeTemplate(template);
	if (!value || !safe) return '';
	return safe.split(TRACKING_TOKEN).join(encodeURIComponent(value));
};

/**
 * @typedef {object} Fulfilment
 * @property {string | null} carrier carrier key
 * @property {string | null} carrierName
 * @property {string | null} serviceLevel
 * @property {string | null} trackingNumber
 * @property {string | null} trackingUrl
 * @property {string | null} dispatchVideoUrl
 * @property {string | null} eta ISO date
 * @property {string | null} note
 */

/** @returns {Fulfilment} */
export const emptyFulfilment = () => ({
	carrier: null,
	carrierName: null,
	serviceLevel: null,
	trackingNumber: null,
	trackingUrl: null,
	dispatchVideoUrl: null,
	eta: null,
	note: null,
});

/**
 * Apply a fulfilment patch (`null` clears a field, absent keeps it) against the settings.
 * @param {Fulfilment | null | undefined} current
 * @param {unknown} patch
 * @param {{ carriers: Carrier[], allowOther: boolean, dispatchVideo: boolean, maxNote: number }} settings
 * @returns {{ ok: true, value: Fulfilment, changed: string[] } | { ok: false, errors: Array<{ path: string, code: string }> }}
 */
export const applyFulfilment = (current, patch, settings) => {
	if (!isObject(patch)) return { ok: false, errors: [issue('', 'object_required')] };
	/** @type {Array<{ path: string, code: string }>} */
	const errors = [];
	const next = { ...emptyFulfilment(), ...(current ?? {}) };
	/** @type {string[]} */
	const changed = [];
	/** @param {string} name */
	const has = (name) => Object.hasOwn(patch, name);
	if (has('carrier')) {
		if (patch.carrier === null || patch.carrier === '') {
			next.carrier = null;
			next.carrierName = null;
			next.serviceLevel = null;
		} else {
			const key = cleanText(patch.carrier, 80);
			const known = settings.carriers.find((c) => c.key === key);
			if (!key || (!known && !settings.allowOther)) errors.push(issue('/carrier', 'carrier_unknown'));
			else {
				next.carrier = known ? known.key : key;
				next.carrierName = known ? known.name : key;
			}
		}
		changed.push('carrier');
	}
	if (has('serviceLevel')) {
		const level = patch.serviceLevel === null ? null : cleanText(patch.serviceLevel, 60);
		const known = settings.carriers.find((c) => c.key === next.carrier);
		if (
			patch.serviceLevel !== null &&
			(!level || (known && known.serviceLevels.length > 0 && !known.serviceLevels.includes(level)))
		)
			errors.push(issue('/serviceLevel', 'service_level_unknown'));
		else next.serviceLevel = level;
		changed.push('serviceLevel');
	}
	if (has('trackingNumber')) {
		const number = patch.trackingNumber === null ? null : cleanText(patch.trackingNumber, MAX_TRACKING);
		if (patch.trackingNumber !== null && !number) errors.push(issue('/trackingNumber', 'text_invalid'));
		else next.trackingNumber = number;
		changed.push('trackingNumber');
	}
	if (has('dispatchVideoUrl')) {
		const url = patch.dispatchVideoUrl === null ? null : httpsUrl(patch.dispatchVideoUrl);
		if (!settings.dispatchVideo) errors.push(issue('/dispatchVideoUrl', 'dispatch_video_disabled'));
		else if (patch.dispatchVideoUrl !== null && !url) errors.push(issue('/dispatchVideoUrl', 'url_invalid'));
		else next.dispatchVideoUrl = url;
		changed.push('dispatchVideoUrl');
	}
	if (has('eta')) {
		const date = patch.eta === null ? null : new Date(String(patch.eta));
		if (date && Number.isNaN(date.getTime())) errors.push(issue('/eta', 'date_invalid'));
		else next.eta = date ? date.toISOString() : null;
		changed.push('eta');
	}
	if (has('note')) {
		const note = patch.note === null ? null : cleanText(patch.note, Math.max(1, settings.maxNote), { multiline: true });
		if (patch.note !== null && (!note || settings.maxNote === 0)) errors.push(issue('/note', 'text_invalid'));
		else next.note = note;
		changed.push('note');
	}
	if (errors.length > 0) return { ok: false, errors };
	if (changed.length === 0) return { ok: false, errors: [issue('', 'nothing_to_change')] };
	const carrier = settings.carriers.find((c) => c.key === next.carrier);
	next.trackingUrl = trackingUrl(carrier?.template, next.trackingNumber) || null;
	return { ok: true, value: next, changed };
};
