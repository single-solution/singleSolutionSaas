/**
 * Role pricing (PLAN 0.8.10 E19, E31): the `role_prices` list — Accounts roles whose signed-in shoppers get their own
 * prices, with the label quotes, orders and invoices show. One entry per role, either a percent (0–90) off the goods
 * after offers (`kind: percent`, the default) or a price list (`kind: prices`): fixed prices per product, or per
 * variant (a variant's price beats its product's); items not listed keep their price, and a listed price never raises
 * one. Both come off before points, delivery and tax. The arithmetic is in `core/checkout.js` (`roleDiscounts`). No I/O.
 * @module
 */

/** At most this many role prices, and prices in one price list. */
const MAX_ROLE_PRICES = 20;
const MAX_PRICES = 500;
/** An Accounts role key. */
const ROLE = /^[A-Za-z0-9_.:-]{1,40}$/;
/** A product id and a variant id. */
const PRODUCT_ID = /^prd_[A-Za-z0-9_-]{1,64}$/;
const VARIANT_ID = /^var_[A-Za-z0-9_-]{1,64}$/;
/** The label quotes, orders and invoices show when the merchant gives none. */
const DEFAULT_LABEL = 'Member discount';

/** @typedef {{ productId: string, variantId: string | null, price: number }} ListedPrice a price in minor units */
/**
 * @typedef {{ role: string, kind: 'percent' | 'prices', percent: number, prices: ListedPrice[], label: string }} RolePrice
 *   `percent`: 0 for a price list
 */
/**
 * What a role's prices take off (`roleTermsOf`): a percent of the goods, or a price per variant id and product id.
 * @typedef {{ percent: number, prices: ReadonlyMap<string, number> | null }} RoleTerms
 */

/**
 * Check one price of a price list.
 * @param {unknown} raw @param {string} at
 * @param {string[]} errors
 * @returns {ListedPrice | null}
 */
const priceOf = (raw, at, errors) => {
	const entry = typeof raw === 'object' && raw !== null ? /** @type {Record<string, unknown>} */ (raw) : {};
	const productId = typeof entry.productId === 'string' ? entry.productId : '';
	const variantId = entry.variantId === undefined || entry.variantId === null || entry.variantId === '' ? null : entry.variantId;
	if (!PRODUCT_ID.test(productId)) errors.push(`${at}: productId is a product id (prd_…).`);
	else if (variantId !== null && (typeof variantId !== 'string' || !VARIANT_ID.test(variantId)))
		errors.push(`${at}: variantId is a variant id (var_…) or null.`);
	else if (!Number.isSafeInteger(entry.price) || /** @type {number} */ (entry.price) < 0)
		errors.push(`${at}: the price is a whole number of minor units from 0.`);
	else return { productId, variantId: /** @type {string | null} */ (variantId), price: /** @type {number} */ (entry.price) };
	return null;
};

/**
 * Check the list the merchant saves.
 * @param {unknown} value
 * @returns {{ ok: true, value: RolePrice[] } | { ok: false, errors: string[] }}
 */
export const checkRolePrices = (value) => {
	if (!Array.isArray(value)) return { ok: false, errors: ['Role prices are a list.'] };
	/** @type {string[]} */
	const errors = [];
	if (value.length > MAX_ROLE_PRICES) errors.push(`At most ${MAX_ROLE_PRICES} role prices.`);
	/** @type {RolePrice[]} */
	const out = [];
	for (const [index, raw] of value.entries()) {
		const entry = typeof raw === 'object' && raw !== null ? /** @type {Record<string, unknown>} */ (raw) : {};
		const at = `Entry ${index + 1}`;
		const role = typeof entry.role === 'string' ? entry.role.trim() : '';
		const label = typeof entry.label === 'string' ? entry.label.trim() : '';
		const kind = entry.kind === undefined ? 'percent' : entry.kind;
		if (!ROLE.test(role)) errors.push(`${at}: role is an Accounts role key (1–40 characters).`);
		else if (out.some((other) => other.role === role)) errors.push(`Role '${role}' is listed twice.`);
		if (label.length > 60) errors.push(`${at}: the label has at most 60 characters.`);
		if (kind !== 'percent' && kind !== 'prices') {
			errors.push(`${at}: kind is percent or prices.`);
			continue;
		}
		/** @type {ListedPrice[]} */
		const prices = [];
		let percent = 0;
		if (kind === 'percent') {
			percent = /** @type {number} */ (entry.percent);
			if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 90)
				errors.push(`${at}: percent is from 0 to 90.`);
		} else {
			const list = Array.isArray(entry.prices) ? entry.prices : null;
			if (!list || list.length === 0 || list.length > MAX_PRICES)
				errors.push(`${at}: a price list has 1 to ${MAX_PRICES} prices.`);
			for (const [priceIndex, rawPrice] of (list ?? []).entries()) {
				const price = priceOf(rawPrice, `${at}, price ${priceIndex + 1}`, errors);
				if (!price) continue;
				if (prices.some((other) => other.productId === price.productId && other.variantId === price.variantId))
					errors.push(`${at}, price ${priceIndex + 1}: this product or variant is listed twice.`);
				prices.push(price);
			}
		}
		out.push({ role, kind, percent: Number(percent), prices, label: label || DEFAULT_LABEL });
	}
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out };
};

/**
 * What a role price takes off (null: nothing): its percent, or its prices by variant id and product id.
 * @param {Pick<RolePrice, 'kind' | 'percent' | 'prices'> | null | undefined} entry
 * @returns {RoleTerms | null}
 */
export const roleTermsOf = (entry) => {
	if (!entry) return null;
	if (entry.kind !== 'prices') return entry.percent > 0 ? { percent: entry.percent, prices: null } : null;
	/** @type {Map<string, number>} */
	const prices = new Map();
	// a variant's own price beats its product's
	for (const listed of entry.prices) if (listed.variantId === null) prices.set(listed.productId, listed.price);
	for (const listed of entry.prices) if (listed.variantId !== null) prices.set(listed.variantId, listed.price);
	return prices.size > 0 ? { percent: 0, prices } : null;
};

/**
 * The prices of a role's price list that lines of these products use (an order keeps only those).
 * @param {RolePrice} entry @param {ReadonlySet<string>} productIds
 * @returns {ListedPrice[]}
 */
export const pricesFor = (entry, productIds) => entry.prices.filter((listed) => productIds.has(listed.productId));
