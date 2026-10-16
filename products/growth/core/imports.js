/**
 * The `import` feature's records (pure; PLAN 0.8.10 K10, Migration step 8, G8): a day of daily totals as `ss-import`
 * sends it, rebuilt from another system's analytics — `{ day: 'YYYY-MM-DD', part: 0, totals: { <metric>: { <key as
 * text>: { c, s? } } } }`, the day in the business time zone (K8). Each metric must be one Growth counts, with keys of
 * the form it writes them (`events.js`), a whole count of 0 or more and a finite sum (only metrics that keep a sum);
 * unknown fields are refused by name. The adapter escapes the keys as the day's document stores them.
 * @module
 */
import { isCurrency } from '@ss/contracts/format';
import { isObject } from '@ss/contracts/util';
import { isDay } from './analytics.js';
import { BROWSERS, DEVICES, DIRECT, SYSTEMS, VITALS, pathOf } from './events.js';

/** @typedef {{ path: string, message: string }} ImportError */
/** @typedef {Record<string, Record<string, { c: number, s?: number }>>} DayTotals metric → key → count and sum */

/** The longest key of free text (a source, country, city or search term). */
const MAX_TEXT_KEY = 300;
const RATINGS = Object.freeze(['good', 'needs_improvement', 'poor']);
const VITAL_NAMES = Object.freeze(Object.keys(VITALS));

/** The key of a metric without keys. @param {string} key */
const isEmpty = (key) => key === '';
/** @param {string} key */
const isPath = (key) => pathOf(key) === key;
/** Free text: 1–300 characters without control characters. @param {string} key */
// eslint-disable-next-line no-control-regex
const isText = (key) => key.length > 0 && [...key].length <= MAX_TEXT_KEY && !/[\u0000-\u001f\u007f]/.test(key);
/**
 * A path and a second part joined by a line break (`<path>\n<name>`), the second part checked.
 * @param {(part: string) => boolean} second
 */
const pathAnd = (second) => (/** @type {string} */ key) => {
	const cut = key.indexOf('\n');
	return cut > 0 && isPath(key.slice(0, cut)) && second(key.slice(cut + 1));
};
/** @param {ReadonlyArray<string>} values */
const oneOf = (values) => (/** @type {string} */ key) => values.includes(key);
/** A product id as the shop events give it (R7 #113): 1–80 characters, no control characters. @param {string} key */
// eslint-disable-next-line no-control-regex
const isItem = (key) => key.length > 0 && key.length <= 80 && !/[\u0000-\u001f\u007f]/.test(key);
/**
 * A product id and a second part joined by a line break (`<product id>\n<part>`), the second part checked.
 * @param {(part: string) => boolean} second
 */
const itemAnd = (second) => (/** @type {string} */ key) => {
	const cut = key.indexOf('\n');
	return cut > 0 && isItem(key.slice(0, cut)) && second(key.slice(cut + 1));
};

/**
 * The metrics of the daily totals (as `events.js` writes them): what their keys are (`keys`, for messages, and the
 * check) and whether they keep a sum.
 * @type {Readonly<Record<string, { keys: string, key: (key: string) => boolean, sum: boolean }>>}
 */
const METRICS = Object.freeze({
	visits: { keys: 'only the empty key ""', key: isEmpty, sum: false },
	page_views: { keys: 'only the empty key ""', key: isEmpty, sum: false },
	sessions: { keys: 'only the empty key ""', key: isEmpty, sum: false },
	session_pages: { keys: 'only the empty key ""', key: isEmpty, sum: false },
	engaged: { keys: 'only the empty key ""', key: isEmpty, sum: false },
	duration: { keys: 'only the empty key ""', key: isEmpty, sum: true },
	page: { keys: 'a path from /', key: isPath, sum: false },
	not_found: { keys: 'a path from /', key: isPath, sum: false },
	source: { keys: `a host, campaign source or ${DIRECT}`, key: isText, sum: false },
	country: { keys: 'a country', key: isText, sum: false },
	city: { keys: 'a city', key: isText, sum: false },
	search: { keys: 'a search term', key: isText, sum: false },
	search_empty: { keys: 'a search term', key: isText, sum: false },
	device: { keys: DEVICES.join(', '), key: oneOf(DEVICES), sum: false },
	event: {
		keys: 'an event name (view_item, add_to_cart, begin_checkout, purchase, contact or your own: lower-case letters, digits and _)',
		key: (/** @type {string} */ key) => /^[a-z][a-z0-9_]{0,39}$/.test(key),
		sum: false,
	},
	page_match: {
		keys: 'a page pattern from / (* and ** wildcards)',
		key: (/** @type {string} */ key) => /^\/[^\s?#]*$/.test(key),
		sum: false,
	},
	browser: { keys: BROWSERS.join(', '), key: oneOf(BROWSERS), sum: false },
	os: { keys: SYSTEMS.join(', '), key: oneOf(SYSTEMS), sum: false },
	revenue: { keys: 'a currency (ISO 4217)', key: isCurrency, sum: true },
	vital: {
		keys: '<vital>:<rating> (good, needs_improvement, poor)',
		key: oneOf(VITAL_NAMES.flatMap((name) => RATINGS.map((rating) => `${name}:${rating}`))),
		sum: false,
	},
	vital_value: { keys: VITAL_NAMES.join(', '), key: oneOf(VITAL_NAMES), sum: true },
	vital_page: { keys: '<path>\\n<vital>', key: pathAnd(oneOf(VITAL_NAMES)), sum: true },
	not_found_from: { keys: '<path>\\n<where from>', key: pathAnd(isText), sum: false },
	// product performance (R7 #113): each product's steps (a cart's and a purchase's sum: units), revenue and name
	item_view: { keys: 'a product id', key: isItem, sum: false },
	item_cart: { keys: 'a product id', key: isItem, sum: true },
	item_checkout: { keys: 'a product id', key: isItem, sum: false },
	item_purchase: { keys: 'a product id', key: isItem, sum: true },
	item_revenue: { keys: '<product id>\\n<currency>', key: itemAnd(isCurrency), sum: true },
	item_name: { keys: '<product id>\\n<name>', key: itemAnd(isText), sum: false },
});

/**
 * A JSON pointer segment (`/` and `~` escaped), for the path of an error.
 * @param {string} key
 */
const pointer = (key) => key.replace(/~/g, '~0').replace(/\//g, '~1');

/**
 * One imported day of totals, checked: the day, `part` 0 (an imported day is one document, which replaces the day's
 * first document) and the totals with readable keys; counts and sums as the day's document keeps them (no sum while it
 * is 0).
 * @param {Record<string, unknown>} record
 * @returns {{ ok: true, value: { day: string, part: 0, totals: DayTotals } } | { ok: false, errors: ImportError[] }}
 */
export const checkDay = (record) => {
	/** @type {ImportError[]} */
	const errors = [];
	for (const field of Object.keys(record))
		if (!['day', 'part', 'totals'].includes(field))
			errors.push({
				path: `/${field}`,
				message:
					field === 'websiteId' || field === 'merchantId'
						? `${field} is never taken from a record: the import stamps the website.`
						: `Unknown field ${field}.`,
			});
	if (!isDay(record.day)) errors.push({ path: '/day', message: 'A day: YYYY-MM-DD (in the business time zone).' });
	if (record.part !== 0) errors.push({ path: '/part', message: 'part is 0: an imported day is one document.' });
	/** @type {DayTotals} */
	const totals = {};
	if (!isObject(record.totals)) errors.push({ path: '/totals', message: 'The totals: { <metric>: { <key>: { c, s } } }.' });
	else
		for (const [metric, keys] of Object.entries(record.totals)) {
			const rule = METRICS[metric];
			const at = `/totals/${pointer(metric)}`;
			if (!rule || !Object.hasOwn(METRICS, metric)) {
				errors.push({ path: at, message: `Unknown metric ${metric}: one of ${Object.keys(METRICS).join(', ')}.` });
				continue;
			}
			if (!isObject(keys)) {
				errors.push({ path: at, message: 'The keys of the metric: { <key>: { c, s } }.' });
				continue;
			}
			/** @type {Record<string, { c: number, s?: number }>} */
			const kept = {};
			for (const [key, total] of Object.entries(keys)) {
				const here = `${at}/${pointer(key)}`;
				const before = errors.length;
				if (!rule.key(key)) errors.push({ path: here, message: `A key of ${metric} is ${rule.keys}.` });
				if (!isObject(total)) {
					errors.push({ path: here, message: 'A total: { c, s }.' });
					continue;
				}
				for (const field of Object.keys(total))
					if (field !== 'c' && field !== 's') errors.push({ path: `${here}/${field}`, message: `Unknown field ${field}.` });
				if (!Number.isSafeInteger(total.c) || Number(total.c) < 0)
					errors.push({ path: `${here}/c`, message: 'The count: a whole number of 0 or more.' });
				const sum = total.s ?? 0;
				if (typeof sum !== 'number' || !Number.isFinite(sum))
					errors.push({ path: `${here}/s`, message: 'The sum: a finite number.' });
				else if (sum !== 0 && !rule.sum) errors.push({ path: `${here}/s`, message: `${metric} keeps no sum.` });
				if (errors.length === before) kept[key] = { c: Number(total.c), ...(sum === 0 ? {} : { s: Number(sum) }) };
			}
			totals[metric] = kept;
		}
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { day: String(record.day), part: 0, totals } };
};
