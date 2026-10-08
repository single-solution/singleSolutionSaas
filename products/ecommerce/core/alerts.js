/**
 * Back-in-stock and price-drop alerts (PLAN 0.8.8: via Notifications): checking a shopper's alert, and when an alert
 * is due for a product as it is now (in stock again, or cheaper than the price stored when the alert was set). No I/O.
 * @module
 */

/** @typedef {import('./model.js').AlertRecord} AlertRecord */
/** @typedef {import('./model.js').ProductRecord} ProductRecord */
/** @typedef {import('./model.js').VariantRecord} VariantRecord */

export const ALERT_KINDS = Object.freeze(/** @type {AlertRecord['kind'][]} */ (['back_in_stock', 'price_drop']));
/** Waiting alerts per shopper, at most. */
export const MAX_ALERTS = 100;
/** Alerts sent per catalog change or per use, at most (the rest are sent on later uses). */
export const SEND_BATCH = 100;

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
 * Whether a variant can be sold now.
 * @param {Pick<ProductRecord, 'trackStock'>} product
 * @param {Pick<VariantRecord, 'active' | 'stock'>} variant
 */
export const sellable = (product, variant) => variant.active && (!product.trackStock || variant.stock > 0);

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
 * Whether an alert is due for the product as it is now.
 * @param {Pick<AlertRecord, 'kind' | 'variantId' | 'price'>} alert
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
	return price !== null && alert.price !== null && price < alert.price;
};

/**
 * The conditions (an `$or` list over alert fields) of the waiting alerts of a product that are due now.
 * @param {Pick<ProductRecord, 'status' | 'inStock' | 'trackStock' | 'price' | 'variants'>} product
 * @returns {Array<Record<string, unknown>>}
 */
export const dueConditions = (product) => {
	if (product.status !== 'active') return [];
	const active = product.variants.filter((v) => v.active);
	return [
		...(product.inStock ? [{ kind: 'back_in_stock', variantId: null }] : []),
		...active.filter((v) => sellable(product, v)).map((v) => ({ kind: 'back_in_stock', variantId: v.id })),
		{ kind: 'price_drop', variantId: null, price: { $gt: product.price } },
		...active.map((v) => ({ kind: 'price_drop', variantId: v.id, price: { $gt: v.price } })),
	];
};
