/**
 * The events each pixel gets, as the merchant's conversion actions name them (G5: the list Conversion actions, seeded
 * with the four shop events, a search and a contact under each pixel's standard names; any event, the merchant's own
 * included, may be sent under any name, and as a Google Ads conversion with its label): Meta (`fbq('track', …)` for its
 * standard events, `fbq('trackCustom', …)` for others), Google tags (`gtag('event', …)`
 * for Google Analytics 4 and Google Ads loaded by Growth, with the Google Ads conversion of an action's label; and, while the
 * Tag Manager container is loaded, the same GA4 event pushed to its `dataLayer` as `{ event, ecommerce }`, which its
 * tags take, for example Google Analytics 4 inside Tag Manager, PLAN 0.8.10 G1) and TikTok (`ttq.track(…)`). Money
 * arrives in minor units with a currency and goes to the pixels in major units.
 *
 * Also (PLAN 0.8.10 G2): a site search (Meta `Search`, GA4 `search`, TikTok `Search`) and a contact (Meta `Contact`,
 * GA4 `generate_lead`, TikTok `Contact`); items are named by their product id, or by their variant id with the
 * `contentIds` setting `variant`.
 * @module
 */
import { currencyDigits, isAmount, isCurrency } from '@ss/contracts/format';
import { isObject } from '@ss/contracts/util';

/**
 * Minor units as a major-unit number (1250 USD → 12.5).
 * @param {number} minor
 * @param {string} currency
 */
export const toMajor = (minor, currency) => minor / 10 ** currencyDigits(currency);

/** Meta's standard events (`fbq('track', …)`); any other name is a custom event (`fbq('trackCustom', …)`). */
const META_STANDARD = new Set([
	'AddPaymentInfo',
	'AddToCart',
	'AddToWishlist',
	'CompleteRegistration',
	'Contact',
	'CustomizeProduct',
	'Donate',
	'FindLocation',
	'InitiateCheckout',
	'Lead',
	'Purchase',
	'Schedule',
	'Search',
	'StartTrial',
	'SubmitApplication',
	'Subscribe',
	'ViewContent',
]);

/** @typedef {'view_item' | 'add_to_cart' | 'begin_checkout' | 'purchase'} Step */
/**
 * A conversion action (G5): the event and its name for each pixel ('' : not sent there), and the Google Ads
 * conversion label ('' : none).
 * @typedef {{ event: string, meta: string, google: string, tiktok: string, adsLabel: string }} Action
 */
/** @typedef {'product' | 'variant'} ContentIds which id names an item */
/** @typedef {{ id: string, variantId: string | null, name: string, price: number | null, quantity: number }} Item */
/** @typedef {{ items: Item[], value: number | null, currency: string | null, orderId: string | null }} Detail */
/** @typedef {{ vendor: 'meta' | 'google' | 'datalayer' | 'tiktok', args: unknown[] }} PixelCall */
/**
 * The pixels loaded in the page: `google`, Google Analytics 4 or Google Ads through gtag.js; `gtm`, the Tag Manager
 * container; `ads`, the Google Ads conversion of a purchase.
 * @typedef {{ meta: boolean, google: boolean, gtm: boolean, ads: { id: string } | null, tiktok: boolean }} Loaded
 */

/** @param {unknown} value @param {number} max */
const short = (value, max) => (typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, max) : '');

/**
 * A browser event's `detail`, checked: `{ items: [{ id, variantId?, name?, price?, quantity? }], value, currency,
 * orderId? }` with money in minor units.
 * @param {unknown} raw
 * @returns {Detail}
 */
export const detailOf = (raw) => {
	const detail = isObject(raw) ? raw : {};
	const currency = isCurrency(detail.currency) ? detail.currency : null;
	const items = (Array.isArray(detail.items) ? detail.items : [])
		.filter(isObject)
		.slice(0, 50)
		.map((item) => ({
			id: short(item.id, 80),
			variantId: short(item.variantId, 80) || null,
			name: short(item.name, 200),
			price: isAmount(item.price) ? item.price : null,
			quantity:
				typeof item.quantity === 'number' && Number.isSafeInteger(item.quantity) && item.quantity > 0 ? item.quantity : 1,
		}))
		.filter((item) => item.id !== '');
	return {
		items,
		value: currency !== null && isAmount(detail.value) ? detail.value : null,
		currency,
		orderId: short(detail.orderId, 80) || null,
	};
};

/**
 * One Google Analytics 4 event: `gtag('event', …)` while gtag.js is loaded, and a `dataLayer` push while the Tag Manager
 * container is (an ecommerce event as `{ event, ecommerce }`, after clearing the last `ecommerce` object, as Google
 * asks).
 * @param {string} name
 * @param {Record<string, unknown>} params
 * @param {Loaded} loaded
 * @param {boolean} ecommerce
 * @returns {PixelCall[]}
 */
const googleEvent = (name, params, loaded, ecommerce) => [
	...(loaded.google ? [{ vendor: /** @type {const} */ ('google'), args: ['event', name, params] }] : []),
	...(loaded.gtm
		? ecommerce
			? [
					{ vendor: /** @type {const} */ ('datalayer'), args: [{ ecommerce: null }] },
					{ vendor: /** @type {const} */ ('datalayer'), args: [{ event: name, ecommerce: params }] },
				]
			: [{ vendor: /** @type {const} */ ('datalayer'), args: [{ event: name, ...params }] }]
		: []),
];

/**
 * The id that names an item: its product id, or with `variant` its variant id (the product id without one).
 * @param {Item} item
 * @param {ContentIds} contentIds
 */
const itemIdOf = (item, contentIds) => (contentIds === 'variant' ? (item.variantId ?? item.id) : item.id);

/**
 * The Meta call of an event name: `track` for a standard event, `trackCustom` for another.
 * @param {string} name
 */
const metaMethod = (name) => (META_STANDARD.has(name) ? 'track' : 'trackCustom');

/**
 * The Google Ads conversion of an action with a label, while Google Ads is loaded.
 * @param {Action | null | undefined} action
 * @param {Loaded} loaded
 * @param {Record<string, unknown>} params
 * @returns {PixelCall[]}
 */
const adsConversion = (action, loaded, params) =>
	action?.adsLabel && loaded.google && loaded.ads
		? [{ vendor: 'google', args: ['event', 'conversion', { send_to: `${loaded.ads.id}/${action.adsLabel}`, ...params }] }]
		: [];

/**
 * The pixel calls of one shop event, for the tags that are loaded, under the names of its conversion action (none
 * without one).
 * @param {Step} step
 * @param {Detail} detail
 * @param {Loaded} loaded
 * @param {ContentIds} [contentIds]
 * @param {Action | null} [action] the event's conversion action (G5)
 * @returns {PixelCall[]}
 */
export const pixelCalls = (step, detail, loaded, contentIds = 'product', action = null) => {
	if (!action) return [];
	const names = action;
	const currency = detail.currency;
	const value = currency !== null && detail.value !== null ? toMajor(detail.value, currency) : undefined;
	const money = value === undefined ? {} : { value, currency };
	/** @param {number | null} price */
	const major = (price) => (price !== null && currency !== null ? { price: toMajor(price, currency) } : {});
	/** @type {PixelCall[]} */
	const calls = [];
	if (loaded.meta && names.meta)
		calls.push({
			vendor: 'meta',
			args: [
				metaMethod(names.meta),
				names.meta,
				{
					content_ids: detail.items.map((item) => itemIdOf(item, contentIds)),
					content_type: 'product',
					num_items: detail.items.reduce((sum, item) => sum + item.quantity, 0),
					...money,
				},
				...(detail.orderId ? [{ eventID: `${step}-${detail.orderId}` }] : []),
			],
		});
	if (names.google)
		calls.push(
			...googleEvent(
				names.google,
				{
					...money,
					...(detail.orderId ? { transaction_id: detail.orderId } : {}),
					items: detail.items.map((item) => ({
						item_id: itemIdOf(item, contentIds),
						...(item.name ? { item_name: item.name } : {}),
						...(item.variantId ? { item_variant: item.variantId } : {}),
						quantity: item.quantity,
						...major(item.price),
					})),
				},
				loaded,
				true,
			),
		);
	calls.push(...adsConversion(action, loaded, { ...money, ...(detail.orderId ? { transaction_id: detail.orderId } : {}) }));
	if (loaded.tiktok && names.tiktok)
		calls.push({
			vendor: 'tiktok',
			args: [
				names.tiktok,
				{
					contents: detail.items.map((item) => ({
						content_id: itemIdOf(item, contentIds),
						quantity: item.quantity,
						...major(item.price),
					})),
					content_type: 'product',
					...money,
				},
			],
		});
	return calls;
};

/**
 * A site search's `detail` (`ss:search`, `SSGrowth.search`), checked: the term (at most 100 characters) and how many
 * results the page found; null without a term.
 * @param {unknown} raw
 * @returns {{ term: string, results: number | null } | null}
 */
export const searchOf = (raw) => {
	const detail = isObject(raw) ? raw : {};
	const term = typeof detail.term === 'string' ? detail.term.replace(/\s+/g, ' ').trim().slice(0, 100) : '';
	if (term === '') return null;
	const results =
		typeof detail.results === 'number' && Number.isSafeInteger(detail.results) && detail.results >= 0 ? detail.results : null;
	return { term, results };
};

/**
 * A contact's `detail` (`ss:contact`, `SSGrowth.contact`), checked: how the visitor got in touch (for example
 * `whatsapp`; letters, digits, `_` and `-`, at most 40), or null.
 * @param {unknown} raw
 * @returns {{ method: string | null }}
 */
export const contactOf = (raw) => {
	const method = isObject(raw) && typeof raw.method === 'string' ? raw.method.trim().toLowerCase() : '';
	return { method: /^[a-z0-9_-]{1,40}$/.test(method) ? method : null };
};

/**
 * The pixel calls of an event with plain parameters, under the names of its conversion action (none without one).
 * @param {Action | null | undefined} action
 * @param {{ meta: Record<string, unknown>, google: Record<string, unknown>, tiktok: Record<string, unknown> }} params
 * @param {Loaded} loaded
 * @returns {PixelCall[]}
 */
const plainCalls = (action, params, loaded) =>
	action
		? [
				...(loaded.meta && action.meta
					? [{ vendor: /** @type {const} */ ('meta'), args: [metaMethod(action.meta), action.meta, params.meta] }]
					: []),
				...(action.google ? googleEvent(action.google, params.google, loaded, false) : []),
				...adsConversion(action, loaded, {}),
				...(loaded.tiktok && action.tiktok
					? [{ vendor: /** @type {const} */ ('tiktok'), args: [action.tiktok, params.tiktok] }]
					: []),
			]
		: [];

/**
 * The pixel calls of a site search (G2), under its conversion action's names (Meta `Search`, GA4 `search`, TikTok
 * `Search` to start with).
 * @param {string} term
 * @param {Loaded} loaded
 * @param {Action | null} [action]
 * @returns {PixelCall[]}
 */
export const searchCalls = (term, loaded, action = null) =>
	plainCalls(action, { meta: { search_string: term }, google: { search_term: term }, tiktok: { query: term } }, loaded);

/**
 * The pixel calls of a contact (G2), with the method when there is one, under its conversion action's names (Meta
 * `Contact`, GA4 `generate_lead`, TikTok `Contact` to start with).
 * @param {string | null} method
 * @param {Loaded} loaded
 * @param {Action | null} [action]
 * @returns {PixelCall[]}
 */
export const contactCalls = (method, loaded, action = null) => {
	const params = method === null ? {} : { method };
	return plainCalls(action, { meta: params, google: params, tiktok: params }, loaded);
};

/**
 * The pixel calls of the merchant's own event (G2 `SSGrowth.track(name, props)`), with its properties, under its
 * conversion action's names (none without one).
 * @param {Record<string, string | number | boolean>} props
 * @param {Loaded} loaded
 * @param {Action | null} [action]
 * @returns {PixelCall[]}
 */
export const customCalls = (props, loaded, action = null) =>
	plainCalls(action, { meta: props, google: props, tiktok: props }, loaded);

/**
 * A Web Vital as a Google Analytics 4 event (PLAN 0.8.10 G7), labeled as web.dev's `web-vitals` guide does, so the
 * standard GA4 reports read it (SG-26): the event is named after the vital, with `value` (whole milliseconds; CLS × 1000),
 * `metric_id` (one id per vital of a page load, which GA4 reports group by), `metric_value` (CLS as measured),
 * `metric_rating` (`good`, `needs-improvement`, `poor`), `event_category` `web-vitals`, `event_label` (the metric id
 * again) and `non_interaction`.
 * @param {string} name LCP, INP, CLS, FCP or TTFB
 * @param {number} value milliseconds (CLS × 1000)
 * @param {'good' | 'needs_improvement' | 'poor'} rating
 * @param {Loaded} loaded
 * @param {string} id the vital's id in this page load
 * @returns {PixelCall[]}
 */
export const vitalCalls = (name, value, rating, loaded, id) =>
	googleEvent(
		name,
		{
			value: Math.round(value),
			metric_id: id,
			metric_value: name === 'CLS' ? Math.round(value) / 1000 : Math.round(value),
			metric_rating: rating.replace('_', '-'),
			event_category: 'web-vitals',
			event_label: id,
			non_interaction: true,
		},
		loaded,
		false,
	);

/**
 * What `POST /v1/collect` takes for a funnel event (each item's ids, name, price and quantity; money in minor units).
 * @param {Step} step
 * @param {Detail} detail
 * @param {string} path
 */
export const funnelEvent = (step, detail, path) => ({
	type: step,
	path,
	// each item's name and price go too: Growth's product totals keep them (R7 #113), the raw event does not
	items: detail.items.map((item) => ({
		id: item.id,
		variantId: item.variantId,
		name: item.name,
		price: item.price,
		quantity: item.quantity,
	})),
	...(detail.currency !== null && detail.value !== null ? { value: detail.value, currency: detail.currency } : {}),
	...(step === 'purchase' && detail.orderId ? { orderId: detail.orderId } : {}),
});
