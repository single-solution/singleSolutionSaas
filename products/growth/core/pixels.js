/**
 * The four shop events (PLAN 0.8.9) as each pixel names them: Meta (`fbq('track', …)`), Google tags (`gtag('event', …)`
 * for Google Analytics 4 and Google Ads loaded by Growth, with the Google Ads conversion of a purchase; and, while the
 * Tag Manager container is loaded, the same GA4 event pushed to its `dataLayer` as `{ event, ecommerce }`, which its
 * tags take, for example Google Analytics 4 inside Tag Manager, PLAN 0.8.10 G1) and TikTok (`ttq.track(…)`). Money
 * arrives in minor units with a currency and goes to the pixels in major units.
 * @module
 */
import { isAmount, isCurrency, toMajor } from './money.js';

/** Each funnel step's name per pixel. */
const PIXEL_EVENTS = Object.freeze({
	view_item: Object.freeze({ meta: 'ViewContent', google: 'view_item', tiktok: 'ViewContent' }),
	add_to_cart: Object.freeze({ meta: 'AddToCart', google: 'add_to_cart', tiktok: 'AddToCart' }),
	begin_checkout: Object.freeze({ meta: 'InitiateCheckout', google: 'begin_checkout', tiktok: 'InitiateCheckout' }),
	purchase: Object.freeze({ meta: 'Purchase', google: 'purchase', tiktok: 'CompletePayment' }),
});

/** @typedef {keyof typeof PIXEL_EVENTS} Step */
/** @typedef {{ id: string, variantId: string | null, name: string, price: number | null, quantity: number }} Item */
/** @typedef {{ items: Item[], value: number | null, currency: string | null, orderId: string | null }} Detail */
/** @typedef {{ vendor: 'meta' | 'google' | 'datalayer' | 'tiktok', args: unknown[] }} PixelCall */
/**
 * The pixels loaded in the page: `google`, Google Analytics 4 or Google Ads through gtag.js; `gtm`, the Tag Manager
 * container; `ads`, the Google Ads conversion of a purchase.
 * @typedef {{ meta: boolean, google: boolean, gtm: boolean, ads: { id: string, label: string } | null, tiktok: boolean }} Loaded
 */

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

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
			quantity: Number.isSafeInteger(item.quantity) && item.quantity > 0 ? item.quantity : 1,
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
 * The pixel calls of one funnel event, for the tags that are loaded.
 * @param {Step} step
 * @param {Detail} detail
 * @param {Loaded} loaded
 * @returns {PixelCall[]}
 */
export const pixelCalls = (step, detail, loaded) => {
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
					content_ids: detail.items.map((item) => item.id),
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
					item_id: item.id,
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
					contents: detail.items.map((item) => ({ content_id: item.id, quantity: item.quantity, ...major(item.price) })),
					content_type: 'product',
					...money,
				},
			],
		});
	return calls;
};

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
