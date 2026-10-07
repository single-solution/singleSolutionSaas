/**
 * Structured eligibility conditions (pure), ported from ibrahimMobiles `offerMatching` / `offerScope` and generalised:
 * no products/brands/grades/categories of one store — any item id, variant id, collection or attribute of a generic
 * cart line, plus cart, customer, payment, delivery and context conditions. Merchants who need more write a rules@1
 * condition (`rules.js`); both must pass.
 *
 * A condition is `{ type, operator, value }`; a `group` holds sub-conditions joined by `and` / `or` (nesting allowed).
 * The list on a coupon is an implicit `and`.
 *
 * - **Item conditions** (`items`, `variants`, `collections`, `attributes`, `unit_price`, `line_quantity`) select
 *   lines. When a coupon has any, the coupon applies to the lines that satisfy every condition (cart conditions are read
 *   from the cart while testing each line) and is eligible only when at least one line matches.
 * - **Cart conditions** (`subtotal`, `cart_quantity`, `payment_method`, `delivery_method`, `country`, `segments`,
 *   `first_order`, `device`, `source`) only read the cart. A coupon with cart conditions only is tested once against
 *   the whole cart and then applies to every line (ported `cartMatchesOffer`).
 * - Missing data never matches (an unknown payment method fails both `in` and `not_in`, as in the original), except
 *   `first_order`, which needs `customer.orderCount`.
 * @module
 */

/** @typedef {import('./cart.js').Cart} Cart */
/** @typedef {import('./cart.js').CartLine} CartLine */
/**
 * @typedef {object} Condition
 * @property {string} type
 * @property {string} operator
 * @property {unknown} value
 */

/** Condition types that read a line. */
export const ITEM_TYPES = Object.freeze(['items', 'variants', 'collections', 'attributes', 'unit_price', 'line_quantity']);
/** Condition types that read the cart, the customer or the context. */
export const CART_TYPES = Object.freeze([
	'subtotal',
	'cart_quantity',
	'payment_method',
	'delivery_method',
	'country',
	'segments',
	'first_order',
	'device',
	'source',
]);
/** Every condition type (plus `group`). */
export const CONDITION_TYPES = Object.freeze([...ITEM_TYPES, ...CART_TYPES, 'group']);
/** Operators per value kind. */
export const SET_OPERATORS = Object.freeze(['in', 'not_in']);
export const RANGE_OPERATORS = Object.freeze(['gte', 'lte', 'between']);
/** Types compared as numbers (minor units or counts). */
export const NUMERIC_TYPES = Object.freeze(['unit_price', 'line_quantity', 'subtotal', 'cart_quantity']);
/** Types whose value is money (minor units of the coupon currency). */
export const MONEY_TYPES = Object.freeze(['unit_price', 'subtotal']);

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {unknown} value
 * @returns {string[]}
 */
const asStrings = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []);

/**
 * True when the condition tree reads a line.
 * @param {Condition} condition
 * @returns {boolean}
 */
export const isItemCondition = (condition) => {
	if (condition.type === 'group') return Array.isArray(condition.value) && condition.value.some(isItemCondition);
	return ITEM_TYPES.includes(condition.type);
};

/**
 * True when no condition of the list reads a line (a whole-cart coupon).
 * @param {readonly Condition[]} conditions
 */
export const isCartOnly = (conditions) => !conditions.some(isItemCondition);

/**
 * Count conditions (groups count with their members) — bounded by `eligibility.max_conditions`.
 * @param {readonly Condition[]} conditions
 * @returns {number}
 */
export const countConditions = (conditions) =>
	conditions.reduce(
		(sum, condition) =>
			sum + 1 + (condition.type === 'group' && Array.isArray(condition.value) ? countConditions(condition.value) : 0),
		0,
	);

/**
 * Compare a scalar or a list against a set (`in` = any member, `not_in` = none).
 * @param {string | string[] | null} actual
 * @param {string} operator
 * @param {unknown} target
 */
const setMatch = (actual, operator, target) => {
	if (actual === null) return false;
	const wanted = asStrings(target);
	const values = Array.isArray(actual) ? actual : [actual];
	const hit = values.some((value) => wanted.includes(value));
	if (operator === 'in') return hit;
	if (operator === 'not_in') return !hit;
	return false;
};

/**
 * Compare a number against `gte` / `lte` / `between [min, max]` (inclusive).
 * @param {number | null} actual
 * @param {string} operator
 * @param {unknown} target
 */
const rangeMatch = (actual, operator, target) => {
	if (actual === null || !Number.isFinite(actual)) return false;
	if (operator === 'gte') return typeof target === 'number' && actual >= target;
	if (operator === 'lte') return typeof target === 'number' && actual <= target;
	if (operator === 'between' && Array.isArray(target) && target.length === 2) {
		const [min, max] = target;
		return typeof min === 'number' && typeof max === 'number' && actual >= min && actual <= max;
	}
	return false;
};

/**
 * Does one line (or the synthetic whole-cart line) satisfy a condition, reading cart facts from `cart`?
 * @param {CartLine | null} line null = whole-cart evaluation (item conditions then never match)
 * @param {Condition} condition
 * @param {Cart} cart
 * @returns {boolean}
 */
export const matchesCondition = (line, condition, cart) => {
	const { type, operator, value } = condition;
	if (type === 'group') {
		const members = Array.isArray(value) ? /** @type {Condition[]} */ (value) : [];
		if (members.length === 0) return false;
		if (operator === 'or') return members.some((member) => matchesCondition(line, member, cart));
		if (operator === 'and') return members.every((member) => matchesCondition(line, member, cart));
		return false;
	}
	switch (type) {
		case 'items':
			return line !== null && setMatch(line.itemId, operator, value);
		case 'variants':
			return line !== null && setMatch(line.variantId, operator, value);
		case 'collections':
			return line !== null && setMatch(line.collections, operator, value);
		case 'attributes': {
			if (line === null || !isObject(value) || typeof value.key !== 'string') return false;
			const attribute = Object.hasOwn(line.attributes, value.key) ? line.attributes[value.key] : undefined;
			const actual = typeof attribute === 'string' ? attribute : Array.isArray(attribute) ? asStrings(attribute) : null;
			return setMatch(actual, operator, value.values);
		}
		case 'unit_price':
			return line !== null && rangeMatch(line.unitAmount, operator, value);
		case 'line_quantity':
			return line !== null && rangeMatch(line.quantity, operator, value);
		case 'subtotal':
			return rangeMatch(cart.subtotal, operator, value);
		case 'cart_quantity':
			return rangeMatch(cart.quantity, operator, value);
		case 'payment_method':
			return setMatch(cart.paymentMethod, operator, value);
		case 'delivery_method':
			return setMatch(cart.deliveryMethod, operator, value);
		case 'country':
			return setMatch(cart.context.country, operator, value);
		case 'segments':
			return setMatch(cart.customer.segments, operator, value);
		case 'first_order':
			if (cart.customer.orderCount === null || operator !== 'eq' || typeof value !== 'boolean') return false;
			return (cart.customer.orderCount === 0) === value;
		case 'device':
			return setMatch(cart.context.device, operator, value);
		case 'source':
			return setMatch(cart.context.source, operator, value);
		default:
			return false;
	}
};

/**
 * Lines a coupon's conditions select (ported `getMatchedCartItems` + `cartMatchesOffer`): with item conditions, the
 * lines that satisfy all conditions; with cart conditions only, every line when the cart satisfies them; no
 * conditions = every line.
 * @param {readonly Condition[]} conditions
 * @param {Cart} cart
 * @returns {CartLine[]}
 */
export const matchedLines = (conditions, cart) => {
	if (conditions.length === 0) return [...cart.lines];
	if (isCartOnly(conditions))
		return conditions.every((condition) => matchesCondition(null, condition, cart)) ? [...cart.lines] : [];
	return cart.lines.filter((line) => conditions.every((condition) => matchesCondition(line, condition, cart)));
};

/**
 * Money values read by a condition list (for the currency check).
 * @param {readonly Condition[]} conditions
 * @returns {boolean}
 */
export const usesMoney = (conditions) =>
	conditions.some((condition) =>
		condition.type === 'group'
			? Array.isArray(condition.value) && usesMoney(/** @type {Condition[]} */ (condition.value))
			: MONEY_TYPES.includes(condition.type),
	);
