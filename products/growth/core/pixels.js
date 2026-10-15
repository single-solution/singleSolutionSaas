/**
 * The four shop events (PLAN 0.8.9) as each pixel names them: Meta (`fbq('track', …)`), Google tags (`gtag('event', …)`
 * for Google Analytics 4 and Google Ads loaded by Growth, with the Google Ads conversion of a purchase; and, while the
 * Tag Manager container is loaded, the same GA4 event pushed to its `dataLayer` as `{ event, ecommerce }`, which its
 * tags take, for example Google Analytics 4 inside Tag Manager, PLAN 0.8.10 G1) and TikTok (`ttq.track(…)`). Money
 * arrives in minor units with a currency and goes to the pixels in major units.
 *
 * Also (PLAN 0.8.10 G2): a site search (Meta `Search`, GA4 `search`, TikTok `Search`) and a contact (Meta `Contact`,
 * GA4 `generate_lead`, TikTok `Contact`); items are named by their product id, or by their variant id with the
 * `contentIds` setting `variant`.
 * @module
 */
import { isAmount, isCurrency } from '@ss/contracts/format';
import { isObject } from '@ss/contracts/util';
import { toMajor } from './money.js';

/** Each funnel step's name per pixel. */
const PIXEL_EVENTS = Object.freeze({
	view_item: Object.freeze({ meta: 'ViewContent', google: 'view_item', tiktok: 'ViewContent' }),
	add_to_cart: Object.freeze({ meta: 'AddToCart', google: 'add_to_cart', tiktok: 'AddToCart' }),
	begin_checkout: Object.freeze({ meta: 'InitiateCheckout', google: 'begin_checkout', tiktok: 'InitiateCheckout' }),
	purchase: Object.freeze({ meta: 'Purchase', google: 'purchase', tiktok: 'CompletePayment' }),
});

/** @typedef {keyof typeof PIXEL_EVENTS} Step */
/** @typedef {'product' | 'variant'} ContentIds which id names an item */
/** @typedef {{ id: string, variantId: string | null, name: string, price: number | null, quantity: number }} Item */
/** @typedef {{ items: Item[], value: number | null, currency: string | null, orderId: string | null }} Detail */
/** @typedef {{ vendor: 'meta' | 'google' | 'datalayer' | 'tiktok', args: unknown[] }} PixelCall */
/**
 * The pixels loaded in the page: `google`, Google Analytics 4 or Google Ads through gtag.js; `gtm`, the Tag Manager
 * container; `ads`, the Google Ads conversion of a purchase.
 * @typedef {{ meta: boolean, google: boolean, gtm: boolean, ads: { id: string, label: string } | null, tiktok: boolean }} Loaded
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
 * The pixel calls of one funnel event, for the tags that are loaded.
 * @param {Step} step
 * @param {Detail} detail
 * @param {Loaded} loaded
 * @param {ContentIds} [contentIds]
 * @returns {PixelCall[]}
 */
export const pixelCalls = (step, detail, loaded, contentIds = 'product') => {
	const names = PIXEL_EVENTS[step];
	const currency = detail.currency;
	const value = currency !== null && detail.value !== null ? toMajor(detail.value, currency) : undefined;
	const money = value === undefined ? {} : { value, currency };
	/** @param {number | null} price */
	const major = (price) => (price !== null && currency !== null ? { price: toMajor(price, currency) } : {});
	/** @type {PixelCall[]} */
	const calls = [];
	if (loaded.meta)
		calls.push({
			vendor: 'meta',
			args: [
				'track',
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
	if (step === 'purchase' && loaded.google && loaded.ads)
		calls.push({
			vendor: 'google',
			args: [
				'event',
				'conversion',
				{
					send_to: `${loaded.ads.id}/${loaded.ads.label}`,
					...money,
					...(detail.orderId ? { transaction_id: detail.orderId } : {}),
				},
			],
		});
	if (loaded.tiktok)
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
 * The pixel calls of a site search (G2): Meta `Search`, GA4 `search`, TikTok `Search`.
 * @param {string} term
 * @param {Loaded} loaded
 * @returns {PixelCall[]}
 */
export const searchCalls = (term, loaded) => [
	...(loaded.meta ? [{ vendor: /** @type {const} */ ('meta'), args: ['track', 'Search', { search_string: term }] }] : []),
	...googleEvent('search', { search_term: term }, loaded, false),
	...(loaded.tiktok ? [{ vendor: /** @type {const} */ ('tiktok'), args: ['Search', { query: term }] }] : []),
];

/**
 * The pixel calls of a contact (G2): Meta `Contact`, GA4 `generate_lead`, TikTok `Contact`, each with the method when
 * there is one.
 * @param {string | null} method
 * @param {Loaded} loaded
 * @returns {PixelCall[]}
 */
export const contactCalls = (method, loaded) => {
	const params = method === null ? {} : { method };
	return [
		...(loaded.meta ? [{ vendor: /** @type {const} */ ('meta'), args: ['track', 'Contact', params] }] : []),
		...googleEvent('generate_lead', params, loaded, false),
		...(loaded.tiktok ? [{ vendor: /** @type {const} */ ('tiktok'), args: ['Contact', params] }] : []),
	];
};

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
 * What `POST /v1/collect` takes for a funnel event (ids and quantities; money in minor units).
 * @param {Step} step
 * @param {Detail} detail
 * @param {string} path
 */
export const funnelEvent = (step, detail, path) => ({
	type: step,
	path,
	items: detail.items.map((item) => ({ id: item.id, variantId: item.variantId, quantity: item.quantity })),
	...(detail.currency !== null && detail.value !== null ? { value: detail.value, currency: detail.currency } : {}),
	...(step === 'purchase' && detail.orderId ? { orderId: detail.orderId } : {}),
});
