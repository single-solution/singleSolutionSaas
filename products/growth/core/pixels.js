/**
 * The four shop events (PLAN 0.8.9) as each pixel names them: Meta (`fbq('track', …)`), Google tags (`gtag('event', …)`,
 * GA4 ecommerce events and, for a purchase, the Google Ads conversion) and TikTok (`ttq.track(…)`). Money arrives in
 * minor units with a currency and goes to the pixels in major units.
 * @module
 */
import { isAmount, isCurrency, toMajor } from './money.js';

/** Each funnel step's name per pixel. */
export const PIXEL_EVENTS = Object.freeze({
	view_item: Object.freeze({ meta: 'ViewContent', google: 'view_item', tiktok: 'ViewContent' }),
	add_to_cart: Object.freeze({ meta: 'AddToCart', google: 'add_to_cart', tiktok: 'AddToCart' }),
	begin_checkout: Object.freeze({ meta: 'InitiateCheckout', google: 'begin_checkout', tiktok: 'InitiateCheckout' }),
	purchase: Object.freeze({ meta: 'Purchase', google: 'purchase', tiktok: 'CompletePayment' }),
});

/** @typedef {keyof typeof PIXEL_EVENTS} Step */
/** @typedef {{ id: string, variantId: string | null, name: string, price: number | null, quantity: number }} Item */
/** @typedef {{ items: Item[], value: number | null, currency: string | null, orderId: string | null }} Detail */
/** @typedef {{ vendor: 'meta' | 'google' | 'tiktok', args: unknown[] }} PixelCall */

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
 * The pixel calls of one funnel event, for the tags that are loaded.
 * @param {Step} step
 * @param {Detail} detail
 * @param {{ meta: boolean, google: boolean, ads: { id: string, label: string } | null, tiktok: boolean }} loaded
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
	if (loaded.google) {
		calls.push({
			vendor: 'google',
			args: [
				'event',
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
			],
		});
		if (step === 'purchase' && loaded.ads)
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
	}
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
