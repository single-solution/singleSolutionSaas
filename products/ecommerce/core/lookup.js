/**
 * The Chat lookups' answers (PLAN 0.8.3 Shop tools; the endpoints in `products/chat/core/shop.js`): small, read-only
 * views of products, deals, and one signed-in shopper's orders, account and shipments. Answers never carry street
 * addresses or phone numbers. Pure functions, no I/O.
 * @module
 */
import { statusOf } from './flow.js';
import { activeVariants, variantInStock } from './seo.js';

/** @typedef {import('./model.js').ProductRecord} ProductRecord */
/** @typedef {import('./model.js').VariantRecord} VariantRecord */
/** @typedef {import('./model.js').OrderRecord} OrderRecord */
/** @typedef {import('./model.js').OrderFlow} OrderFlow */

/** A product description in a details answer is cut to this many characters. */
const DETAILS_DESCRIPTION_LENGTH = 1500;
/** A details answer lists at most this many variants. */
const DETAILS_VARIANTS = 20;
/** A search uses at most this many words, each at most 40 characters. */
const MAX_TERMS = 6;
/** The longest search text. */
const MAX_QUERY = 120;

/**
 * A `limit` query value as a whole number from 1 to `max` (anything else: the default).
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} max
 */
export const limitOf = (value, fallback, max) => {
	const n = typeof value === 'string' && /^\d{1,4}$/.test(value) ? Number(value) : Number.NaN;
	return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : fallback;
};

/**
 * Escape a text for a regular expression.
 * @param {string} text
 */
export const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The words of a search text, as escaped regular expression sources (at most a few; empty when there is nothing to
 * search for).
 * @param {unknown} q
 * @returns {string[]}
 */
export const searchTerms = (q) =>
	(typeof q === 'string' ? q.slice(0, MAX_QUERY) : '')
		.toLowerCase()
		.split(/[\s,;/]+/)
		.map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').slice(0, 40))
		.filter((word) => word.length > 0)
		.slice(0, MAX_TERMS)
		.map(escapeRegex);

/**
 * The variant a product card adds to the cart: the cheapest active one in stock, else the cheapest active one.
 * @param {ProductRecord} product
 * @returns {VariantRecord | null}
 */
export const cardVariant = (product) => {
	const variants = activeVariants(product);
	const cheapest = (/** @type {VariantRecord[]} */ list) =>
		list.reduce(
			(/** @type {VariantRecord | null} */ best, variant) => (!best || variant.price < best.price ? variant : best),
			null,
		);
	return cheapest(variants.filter((variant) => variantInStock(product, variant))) ?? cheapest(variants);
};

/**
 * Lowest and highest active variant prices.
 * @param {ProductRecord} product
 */
export const priceRange = (product) => {
	const prices = activeVariants(product).map((variant) => variant.price);
	return prices.length > 0 ? { min: Math.min(...prices), max: Math.max(...prices) } : { min: product.price, max: product.price };
};

/**
 * A product as a Chat card.
 * @param {ProductRecord} product
 * @param {{ currency: string, image: string | null, url: string }} context
 */
export const productCard = (product, { currency, image, url }) => {
	const variant = cardVariant(product);
	return {
		id: product.id,
		name: product.name,
		price: variant ? variant.price : product.price,
		currency,
		image: image && /^https:\/\//.test(image) ? image : null,
		url,
		inStock: product.inStock,
		variantId: variant ? variant.id : null,
	};
};

/**
 * A product's details for Chat (`get_product_details`).
 * @param {ProductRecord} product
 * @param {{ currency: string, image: string | null, url: string, brand: string | null,
 *   attributes: Map<string, { name: string, unit: string }>, grades: Map<string, string> }} context
 *   `attributes`: attribute id → name and unit; `grades`: grade key → label
 */
export const productDetails = (product, context) => {
	const description = String(product.description ?? '').trim();
	return {
		...productCard(product, context),
		summary: product.summary,
		description:
			description.length > DETAILS_DESCRIPTION_LENGTH
				? `${description.slice(0, DETAILS_DESCRIPTION_LENGTH - 1)}…`
				: description,
		brand: context.brand,
		options: product.options.map((option) => ({ name: option.name, values: [...option.values] })),
		priceRange: priceRange(product),
		specs: Object.entries(product.specs ?? {}).map(([id, value]) => {
			const attribute = context.attributes.get(id);
			return { name: attribute?.name ?? id, value, unit: attribute?.unit ?? '' };
		}),
		variants: activeVariants(product)
			.slice(0, DETAILS_VARIANTS)
			.map((variant) => ({
				id: variant.id,
				options: { ...variant.options },
				price: variant.price,
				compareAtPrice: variant.compareAtPrice,
				grade: variant.grade ? (context.grades.get(variant.grade) ?? variant.grade) : null,
				inStock: variantInStock(product, variant),
			})),
	};
};

/**
 * Grade key → label, from the `grades` list (entries `{ key, label }`; others are skipped).
 * @param {unknown} list
 * @returns {Map<string, string>}
 */
export const gradeLabels = (list) =>
	new Map(
		(Array.isArray(list) ? list : [])
			.filter((grade) => grade && typeof grade.key === 'string')
			.map((grade) => [String(grade.key), typeof grade.label === 'string' && grade.label ? grade.label : String(grade.key)]),
	);

/**
 * The label of an order's status in the website's flow (the key when the flow no longer has it).
 * @param {OrderFlow} flow
 * @param {string} key
 */
export const statusLabel = (flow, key) => statusOf(flow, key)?.label ?? key;

/**
 * An order as Chat's `get_my_orders` sees it.
 * @param {OrderRecord} order
 * @param {OrderFlow} flow
 */
export const orderSummary = (order, flow) => ({
	number: order.number,
	status: statusLabel(flow, order.status),
	total: order.totals.total,
	currency: order.totals.currency,
	placedAt: new Date(order.placedAt).toISOString(),
});

/**
 * An order's shipment as Chat's `track_shipment` sees it (null when it has none).
 * @param {OrderRecord} order
 * @param {OrderFlow} flow
 */
export const shipmentSummary = (order, flow) =>
	order.shipment
		? {
				orderNumber: order.number,
				courier: order.shipment.courier,
				trackingNumber: order.shipment.trackingNumber,
				trackingUrl: /^https?:\/\//.test(order.shipment.trackingUrl) ? order.shipment.trackingUrl : '',
				status: order.shipment.status || statusLabel(flow, order.status),
			}
		: null;
