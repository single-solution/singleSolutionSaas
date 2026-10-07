/**
 * Effective settings of a website: which elements are on (signed entitlement document) and their configuration (feature
 * schemas' defaults overlaid with the document's values), plus the website's own time zone, language and currency.
 * Every number, flag, list and label the product uses comes from here — nothing is hard-coded.
 */
import { effectiveConfig } from '../core/config.js';
import { isTimeZone } from '../core/time.js';
import claims from '../schemas/claims.features.json' with { type: 'json' };
import messages from '../schemas/messages.features.json' with { type: 'json' };
import photos from '../schemas/photos.features.json' with { type: 'json' };
import queue from '../schemas/queue.features.json' with { type: 'json' };
import refunds from '../schemas/refunds.features.json' with { type: 'json' };
import restock from '../schemas/restock.features.json' with { type: 'json' };
import serialRegistry from '../schemas/serial_registry.features.json' with { type: 'json' };

/** Feature schema of every element. */
export const SCHEMAS = Object.freeze({
	claims,
	photos,
	queue,
	refunds,
	restock,
	serial_registry: serialRegistry,
	messages,
});

/** @typedef {keyof typeof SCHEMAS} ElementKey */
/** @typedef {import('../core/claims.js').Status} Status */

/**
 * @typedef {object} Settings
 * @property {(key: ElementKey) => boolean} enabled
 * @property {string} timeZone
 * @property {string | null} language
 * @property {string | null} currency
 * @property {Record<string, any>} claims
 * @property {import('../core/views.js').Vocabulary} vocabulary types, reasons, statuses and transitions
 * @property {string} initialStatus
 * @property {Record<string, any> | null} photos null when off
 * @property {Record<string, any>} queue defaults apply when off
 * @property {Record<string, any> | null} refunds null when off
 * @property {Record<string, any> | null} restock null when off
 * @property {Record<string, any>} serials the serial format applies to claims too
 * @property {Record<string, any> | null} messages null when off
 */

/**
 * Unique entries by `key` (the first wins).
 * @template {{ key: string }} T
 * @param {T[]} list
 * @returns {T[]}
 */
const uniqueByKey = (list) => {
	const seen = new Set();
	return list.filter((entry) => (seen.has(entry.key) ? false : (seen.add(entry.key), true)));
};

/**
 * @param {{ can: (key: string) => boolean, config: (key: string) => Record<string, unknown> | null | undefined,
 *   website?: { timeZone?: string, language?: string, currency?: string } | null }} source
 * @returns {Settings}
 */
export const settingsFrom = ({ can, config, website = null }) => {
	const of = (/** @type {ElementKey} */ key) => effectiveConfig(SCHEMAS[key], config(key));
	const enabled = (/** @type {ElementKey} */ key) => can(key);
	const claimsConfig = of('claims');
	const queueConfig = enabled('queue') ? of('queue') : effectiveConfig(SCHEMAS.queue, {});
	/** @type {Status[]} */
	const statuses = uniqueByKey(queueConfig.statuses);
	const initialStatus = statuses.some((status) => status.key === queueConfig.initial_status)
		? queueConfig.initial_status
		: /** @type {Status} */ (statuses[0]).key;
	return {
		enabled,
		timeZone: isTimeZone(website?.timeZone) ? /** @type {string} */ (website?.timeZone) : 'UTC',
		language: typeof website?.language === 'string' ? website.language : null,
		currency: typeof website?.currency === 'string' ? website.currency : null,
		claims: claimsConfig,
		vocabulary: {
			types: uniqueByKey(claimsConfig.types),
			reasons: uniqueByKey(claimsConfig.reasons),
			statuses,
			transitions: queueConfig.transitions,
		},
		initialStatus,
		photos: enabled('photos') ? of('photos') : null,
		queue: queueConfig,
		refunds: enabled('refunds') ? of('refunds') : null,
		restock: enabled('restock') ? of('restock') : null,
		serials: of('serial_registry'),
		messages: enabled('messages') ? of('messages') : null,
	};
};

/**
 * Settings from a signed entitlement document through the app-kit helpers.
 * @param {any} product app-kit product
 * @param {any} doc entitlement document
 * @returns {Settings}
 */
export const settingsForDoc = (product, doc) =>
	settingsFrom({
		can: (key) => product.entitlements.can(doc, key),
		config: (key) => product.entitlements.config(doc, key) ?? {},
		website: doc.website ?? null,
	});
