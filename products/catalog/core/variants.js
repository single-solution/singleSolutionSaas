/**
 * Variants and stock (pure), ported from the store's variant rows and made generic: an item's variant dimensions are
 * attribute keys (`item.options`), each variant picks one option value per dimension, an item may restrict each
 * dimension to a pool of values (`item.optionPool`), and uniqueness rules come from the settings. Each variant has a
 * price, compare-at price and private cost in minor units, an SKU, a barcode and stock with a per-variant tracking and
 * backorder override plus a "force sold out" switch that leaves the quantity untouched.
 * @module
 */
import { isAmount } from './money.js';
import { OPTION_VALUE } from './attributes.js';
import { cleanText, isId, isKey, isObject, issue } from './text.js';

export const VARIANT_STATUSES = Object.freeze(/** @type {const} */ (['active', 'inactive']));
export const MAX_QUANTITY = 1_000_000_000;
const LIMITS = Object.freeze({ sku: 100, barcode: 64, title: 300, media: 20 });

/**
 * @typedef {object} Variant
 * @property {string} id
 * @property {string | null} sku
 * @property {string | null} barcode
 * @property {string | null} title
 * @property {Record<string, string>} options
 * @property {number} price minor units
 * @property {number | null} compareAtPrice
 * @property {number | null} cost private: never returned to pk_ keys, never published
 * @property {number} quantity on hand (negative when oversold)
 * @property {boolean | null} trackInventory null = the website default
 * @property {'deny' | 'allow' | null} backorder null = the website default
 * @property {boolean} forceOutOfStock
 * @property {'active' | 'inactive'} status
 * @property {string[]} mediaIds
 * @property {number} position
 * @property {string | null} restockedAt ISO time of the last increase
 */

/**
 * Validate a variant (create or patch over `current`). The id is assigned by the caller.
 * @param {unknown} input
 * @param {{ current?: Variant | null, path?: string }} [options]
 * @returns {{ problems: Array<{ path: string, code: string }>, value: Omit<Variant, 'id' | 'restockedAt'> | null }}
 */
export const validateVariant = (input, { current = null, path = '' } = {}) => {
	if (!isObject(input)) return { problems: [issue(path, 'object_required')], value: null };
	const body = /** @type {Record<string, any>} */ (input);
	const has = (/** @type {string} */ key) => Object.hasOwn(body, key);
	/** @type {Array<{ path: string, code: string }>} */
	const problems = [];
	/** @param {string} key @param {number} max @returns {string | null} */
	const optionalText = (key, max) => {
		if (!has(key)) return /** @type {any} */ (current)?.[key] ?? null;
		if (body[key] === null || body[key] === '') return null;
		const text = cleanText(body[key], max);
		if (text === null) problems.push(issue(`${path}/${key}`, 'text_invalid'));
		return text;
	};
	const sku = optionalText('sku', LIMITS.sku);
	const barcode = optionalText('barcode', LIMITS.barcode);
	const title = optionalText('title', LIMITS.title);
	/** @type {Record<string, string>} */
	let options = current?.options ?? {};
	if (has('options')) {
		if (!isObject(body.options) || Object.keys(body.options).length > 10)
			problems.push(issue(`${path}/options`, 'options_invalid'));
		else {
			options = {};
			for (const [key, value] of Object.entries(body.options)) {
				if (!isKey(key) || typeof value !== 'string' || !OPTION_VALUE.test(value))
					problems.push(issue(`${path}/options/${key}`, 'option_invalid'));
				else options[key] = value;
			}
		}
	}
	const price = has('price') ? body.price : current?.price;
	if (!isAmount(price)) problems.push(issue(`${path}/price`, current || has('price') ? 'amount_invalid' : 'required'));
	/** @param {string} key @returns {number | null} */
	const optionalAmount = (key) => {
		if (!has(key)) return /** @type {any} */ (current)?.[key] ?? null;
		if (body[key] === null) return null;
		if (!isAmount(body[key])) problems.push(issue(`${path}/${key}`, 'amount_invalid'));
		return body[key];
	};
	const compareAtPrice = optionalAmount('compareAtPrice');
	const cost = optionalAmount('cost');
	const quantity = has('quantity') ? body.quantity : (current?.quantity ?? 0);
	if (!Number.isSafeInteger(quantity) || Math.abs(quantity) > MAX_QUANTITY)
		problems.push(issue(`${path}/quantity`, 'quantity_invalid'));
	const trackInventory = has('trackInventory') ? body.trackInventory : (current?.trackInventory ?? null);
	if (trackInventory !== null && typeof trackInventory !== 'boolean')
		problems.push(issue(`${path}/trackInventory`, 'boolean_invalid'));
	const backorder = has('backorder') ? body.backorder : (current?.backorder ?? null);
	if (backorder !== null && backorder !== 'deny' && backorder !== 'allow')
		problems.push(issue(`${path}/backorder`, 'backorder_invalid'));
	const forceOutOfStock = has('forceOutOfStock') ? body.forceOutOfStock : (current?.forceOutOfStock ?? false);
	if (typeof forceOutOfStock !== 'boolean') problems.push(issue(`${path}/forceOutOfStock`, 'boolean_invalid'));
	const status = has('status') ? body.status : (current?.status ?? 'active');
	if (!VARIANT_STATUSES.includes(status)) problems.push(issue(`${path}/status`, 'status_invalid'));
	const mediaIds = has('mediaIds') ? body.mediaIds : (current?.mediaIds ?? []);
	if (!Array.isArray(mediaIds) || mediaIds.length > LIMITS.media || !mediaIds.every(isId))
		problems.push(issue(`${path}/mediaIds`, 'ids_invalid'));
	const position = has('position') ? body.position : (current?.position ?? 0);
	if (!Number.isSafeInteger(position) || position < 0 || position > 100_000)
		problems.push(issue(`${path}/position`, 'position_invalid'));
	if (problems.length > 0) return { problems, value: null };
	return {
		problems,
		value: {
			sku,
			barcode,
			title,
			options,
			price,
			compareAtPrice,
			cost,
			quantity,
			trackInventory,
			backorder,
			forceOutOfStock,
			status,
			mediaIds: [...new Set(/** @type {string[]} */ (mediaIds))],
			position,
		},
	};
};

/**
 * The option combination of a variant as a stable string.
 * @param {readonly string[]} optionKeys
 * @param {Record<string, string>} options
 */
export const comboOf = (optionKeys, options) => optionKeys.map((key) => `${key}=${options[key] ?? ''}`).join('&');

/**
 * Rules over an item's whole variant set: every dimension has a value and no other keys, values are options of the
 * dimension's attribute and inside the item's pool, and the uniqueness rule holds.
 * @param {ReadonlyArray<Pick<Variant, 'options' | 'sku'>>} variants
 * @param {{ optionKeys: readonly string[], optionPool: Record<string, string[]>, poolsOn: boolean,
 *   attributeOptions: ReadonlyMap<string, readonly string[]>, uniqueness: 'options' | 'sku' | 'options_and_sku' | 'none',
 *   maxVariants: number }} rules
 * @returns {Array<{ path: string, code: string }>}
 */
export const checkVariantSet = (variants, { optionKeys, optionPool, poolsOn, attributeOptions, uniqueness, maxVariants }) => {
	/** @type {Array<{ path: string, code: string }>} */
	const problems = [];
	if (variants.length > maxVariants) problems.push(issue('/variants', 'limit_reached'));
	const combos = new Map();
	const skus = new Map();
	variants.forEach((variant, index) => {
		const base = `/variants/${index}`;
		for (const key of Object.keys(variant.options))
			if (!optionKeys.includes(key)) problems.push(issue(`${base}/options/${key}`, 'option_unknown'));
		for (const key of optionKeys) {
			const value = variant.options[key];
			if (value === undefined) problems.push(issue(`${base}/options/${key}`, 'required'));
			else if (!(attributeOptions.get(key) ?? []).includes(value))
				problems.push(issue(`${base}/options/${key}`, 'option_invalid'));
			else if (poolsOn && Array.isArray(optionPool[key]) && !optionPool[key].includes(value))
				problems.push(issue(`${base}/options/${key}`, 'not_in_pool'));
		}
		const combo = comboOf(optionKeys, variant.options);
		if ((uniqueness === 'options' || uniqueness === 'options_and_sku') && optionKeys.length > 0) {
			if (combos.has(combo)) problems.push(issue(`${base}/options`, 'duplicate_options'));
			combos.set(combo, index);
		}
		if ((uniqueness === 'sku' || uniqueness === 'options_and_sku') && variant.sku) {
			if (skus.has(variant.sku)) problems.push(issue(`${base}/sku`, 'duplicate_sku'));
			skus.set(variant.sku, index);
		}
	});
	if ((uniqueness === 'options' || uniqueness === 'options_and_sku') && optionKeys.length === 0 && variants.length > 1)
		problems.push(issue('/options', 'dimensions_required'));
	return problems;
};

/**
 * Validate an item's variant dimensions and pool.
 * @param {unknown} options attribute keys
 * @param {unknown} pool `{ key: [values] }`
 * @param {ReadonlyMap<string, readonly string[]>} attributeOptions options of every variant-option attribute
 * @returns {{ problems: Array<{ path: string, code: string }>, options: string[], optionPool: Record<string, string[]> }}
 */
export const validateDimensions = (options, pool, attributeOptions) => {
	/** @type {Array<{ path: string, code: string }>} */
	const problems = [];
	const keys = Array.isArray(options) ? options : [];
	if (options !== undefined && (!Array.isArray(options) || options.length > 5 || new Set(options).size !== options.length))
		problems.push(issue('/options', 'options_invalid'));
	keys.forEach((key, index) => {
		if (!attributeOptions.has(key)) problems.push(issue(`/options/${index}`, 'not_a_variant_option'));
	});
	/** @type {Record<string, string[]>} */
	const optionPool = {};
	if (pool !== undefined && pool !== null) {
		if (!isObject(pool)) problems.push(issue('/optionPool', 'object_required'));
		else
			for (const [key, values] of Object.entries(/** @type {Record<string, unknown>} */ (pool))) {
				const allowed = attributeOptions.get(key);
				if (!keys.includes(key) || !allowed) problems.push(issue(`/optionPool/${key}`, 'option_unknown'));
				else if (!Array.isArray(values) || values.length === 0 || !values.every((v) => allowed.includes(v)))
					problems.push(issue(`/optionPool/${key}`, 'option_invalid'));
				else optionPool[key] = [...new Set(/** @type {string[]} */ (values))];
			}
	}
	return { problems, options: problems.length > 0 ? [] : [...keys], optionPool };
};

/**
 * Stock state of a variant for shoppers (ported availability: a forced sold-out wins, then the quantity).
 * @param {Pick<Variant, 'quantity' | 'trackInventory' | 'backorder' | 'forceOutOfStock' | 'status'>} variant
 * @param {{ trackInventory: boolean, backorders: 'deny' | 'allow', lowStock: number }} defaults
 * @returns {{ state: 'in_stock' | 'low_stock' | 'sold_out' | 'backorder' | 'unavailable', purchasable: boolean, tracked: boolean }}
 */
export const availabilityOf = (variant, { trackInventory, backorders, lowStock }) => {
	const tracked = variant.trackInventory ?? trackInventory;
	if (variant.status === 'inactive') return { state: 'unavailable', purchasable: false, tracked };
	if (variant.forceOutOfStock) return { state: 'sold_out', purchasable: false, tracked };
	if (!tracked) return { state: 'in_stock', purchasable: true, tracked };
	if (variant.quantity > 0)
		return { state: variant.quantity <= lowStock ? 'low_stock' : 'in_stock', purchasable: true, tracked };
	return (variant.backorder ?? backorders) === 'allow'
		? { state: 'backorder', purchasable: true, tracked }
		: { state: 'sold_out', purchasable: false, tracked };
};

/**
 * Whether a variant can give `quantity` units now (the reservation guard).
 * @param {Pick<Variant, 'quantity' | 'trackInventory' | 'backorder' | 'forceOutOfStock' | 'status'>} variant
 * @param {number} quantity
 * @param {{ trackInventory: boolean, backorders: 'deny' | 'allow' }} defaults
 */
export const canTake = (variant, quantity, defaults) => {
	if (variant.status === 'inactive' || variant.forceOutOfStock) return false;
	if (!(variant.trackInventory ?? defaults.trackInventory)) return true;
	return (variant.backorder ?? defaults.backorders) === 'allow' || variant.quantity >= quantity;
};

/**
 * Validate stock lines (`{ variantId | sku, quantity }`).
 * @param {unknown} lines
 * @param {number} max
 * @returns {{ problems: Array<{ path: string, code: string }>, lines: Array<{ variantId: string | null, sku: string | null, quantity: number }> }}
 */
export const validateStockLines = (lines, max) => {
	if (!Array.isArray(lines) || lines.length === 0 || lines.length > max)
		return { problems: [issue('/lines', 'lines_invalid')], lines: [] };
	/** @type {Array<{ path: string, code: string }>} */
	const problems = [];
	const out = lines.map((raw, index) => {
		const line = isObject(raw) ? /** @type {Record<string, any>} */ (raw) : {};
		const variantId = isId(line.variantId) ? line.variantId : null;
		const sku = variantId ? null : cleanText(line.sku, LIMITS.sku);
		if (!variantId && !sku) problems.push(issue(`/lines/${index}`, 'variant_required'));
		if (!Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > MAX_QUANTITY)
			problems.push(issue(`/lines/${index}/quantity`, 'quantity_invalid'));
		return { variantId, sku, quantity: Number(line.quantity) };
	});
	return { problems, lines: out };
};
