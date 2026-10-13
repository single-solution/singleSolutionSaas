/**
 * Back-in-stock and price-drop alerts (PLAN 0.8.8: via Notifications): checking a shopper's alert, when an alert is due
 * for a product as it is now (in stock again, or cheaper than the price stored when the alert was set, or at most its
 * target price, E34), and the stop link each message carries (EN-1). No I/O.
 * @module
 */
import { absolute } from './links.js';

/** @typedef {import('./model.js').AlertRecord} AlertRecord */
/** @typedef {import('./model.js').ProductRecord} ProductRecord */
/** @typedef {import('./model.js').VariantRecord} VariantRecord */

const ALERT_KINDS = Object.freeze(/** @type {AlertRecord['kind'][]} */ (['back_in_stock', 'price_drop']));
/** Waiting alerts per shopper, at most. */
export const MAX_ALERTS = 100;
/** Alerts sent per catalog change or per use, at most (the rest are sent on later uses). */
export const SEND_BATCH = 100;
/**
 * An alert whose message reached no one (Notifications could not be reached or refused it) is tried again on a later
 * use this long after each try, then given up (`failed`).
 */
const RETRY_MS = Object.freeze([60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000]);
/** Tries of an alert's message, at most. */
export const ALERT_TRIES = RETRY_MS.length + 1;

/**
 * When an alert whose message reached no one is tried again, or null when it is given up.
 * @param {number} tries the tries so far (1 after the first)
 * @param {number} now
 */
export const alertRetryAt = (tries, now) => {
	const wait = RETRY_MS[tries - 1];
	return wait === undefined ? null : new Date(now + wait);
};

/** The stop page of an alert's link while the `alerts` setting `stopUrl` names none (E34). */
export const STOP_PATH = '/alerts/unsubscribe/{token}';

/**
 * An alert message's stop link (`{stopUrl}`, EN-1): the `alerts` setting `stopUrl` (a path or https address with
 * `{token}`) on the website, else {@link STOP_PATH}; the page holds the `alerts_stop` widget.
 * @param {unknown} template the `stopUrl` setting
 * @param {string} token
 * @param {string} domain
 */
export const stopLink = (template, token, domain) =>
	absolute(
		(typeof template === 'string' && template.includes('{token}') ? template : STOP_PATH).replaceAll('{token}', token),
		domain,
	);

/**
 * Check a shopper's alert.
 * @param {unknown} body
 * @returns {{ ok: true, value: { kind: AlertRecord['kind'], productId: string, variantId: string | null } } | { ok: false, field: string, message: string }}
 */
export const checkAlertInput = (body) => {
	const input = typeof body === 'object' && body !== null ? /** @type {Record<string, unknown>} */ (body) : {};
	if (!ALERT_KINDS.includes(/** @type {AlertRecord['kind']} */ (input.kind)))
		return { ok: false, field: 'kind', message: 'kind is back_in_stock or price_drop.' };
	if (typeof input.productId !== 'string' || !/^prd_[A-Za-z0-9]{1,64}$/.test(input.productId))
		return { ok: false, field: 'productId', message: 'Name the product.' };
	const variantId = input.variantId ?? null;
	if (variantId !== null && (typeof variantId !== 'string' || !/^var_[A-Za-z0-9]{1,64}$/.test(variantId)))
		return { ok: false, field: 'variantId', message: 'Name the variant, or leave it out.' };
	return {
		ok: true,
		value: { kind: /** @type {AlertRecord['kind']} */ (input.kind), productId: input.productId, variantId },
	};
};

/**
 * Check an alert's optional target price (E34): a price-drop alert is then due once the price is at most this
 * (minor units, below the price now).
 * @param {unknown} value
 * @param {AlertRecord['kind']} kind
 * @param {number} price the price watched now
 * @returns {{ ok: true, targetPrice: number | null } | { ok: false, message: string }}
 */
export const checkTargetPrice = (value, kind, price) => {
	if (value === undefined || value === null) return { ok: true, targetPrice: null };
	if (kind !== 'price_drop') return { ok: false, message: 'Only a price-drop alert takes a target price.' };
	if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= price)
		return { ok: false, message: 'The target price is a whole amount in minor units, below the price now.' };
	return { ok: true, targetPrice: Number(value) };
};

/**
 * Whether a variant can be sold now.
 * @param {Pick<ProductRecord, 'trackStock'>} product
 * @param {Pick<VariantRecord, 'active' | 'stock'>} variant
 */
const sellable = (product, variant) => variant.active && (!product.trackStock || variant.stock > 0);

/**
 * The price an alert watches: its variant's, else the product's lowest.
 * @param {Pick<ProductRecord, 'price' | 'variants'>} product
 * @param {string | null} variantId
 * @returns {number | null} null when the variant is gone or inactive
 */
export const priceOf = (product, variantId) => {
	if (variantId === null) return product.price;
	const variant = product.variants.find((v) => v.id === variantId);
	return variant && variant.active ? variant.price : null;
};

/**
 * Whether an alert is due for the product as it is now: a price-drop alert with a target price once the price is at
 * most the target, else once it is below the price stored.
 * @param {Pick<AlertRecord, 'kind' | 'variantId' | 'price' | 'targetPrice'>} alert
 * @param {Pick<ProductRecord, 'status' | 'inStock' | 'trackStock' | 'price' | 'variants'> | null} product
 */
export const isDue = (alert, product) => {
	if (!product || product.status !== 'active') return false;
	if (alert.kind === 'back_in_stock') {
		if (alert.variantId === null) return product.inStock;
		const variant = product.variants.find((v) => v.id === alert.variantId);
		return Boolean(variant && sellable(product, variant));
	}
	const price = priceOf(product, alert.variantId);
	if (price === null) return false;
	if (typeof alert.targetPrice === 'number') return price <= alert.targetPrice;
	return alert.price !== null && price < alert.price;
};

/**
 * The conditions (an `$or` list over alert fields) of the waiting alerts of a product that are due now.
 * @param {Pick<ProductRecord, 'status' | 'inStock' | 'trackStock' | 'price' | 'variants'>} product
 * @returns {Array<Record<string, unknown>>}
 */
export const dueConditions = (product) => {
	if (product.status !== 'active') return [];
	const active = product.variants.filter((v) => v.active);
	/** @param {number} price a price-drop alert's condition at this price (with or without a target price) */
	const cheaper = (price) => [{ targetPrice: null, price: { $gt: price } }, { targetPrice: { $gte: price } }];
	return [
		...(product.inStock ? [{ kind: 'back_in_stock', variantId: null }] : []),
		...active.filter((v) => sellable(product, v)).map((v) => ({ kind: 'back_in_stock', variantId: v.id })),
		{ kind: 'price_drop', variantId: null, $or: cheaper(product.price) },
		...active.map((v) => ({ kind: 'price_drop', variantId: v.id, $or: cheaper(v.price) })),
	];
};
