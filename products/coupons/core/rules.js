/**
 * rules@1 eligibility conditions (`eligibility.when`): compiled once per source (bounded cache), checked for editors
 * with the context roots this product provides, evaluated with the website's time zone. This is the shared `@ss/rules`
 * language (PLAN F.4) — merchants never get a private DSL. An evaluation error means "not eligible".
 * @module
 */
import { check, compile, evaluateCondition } from '@ss/rules';

/** Identifiers a coupon condition can read (plus `now`). */
export const RULE_ROOTS = Object.freeze(['cart', 'customer', 'paymentMethod', 'deliveryMethod', 'context', 'coupon']);

/** Sources kept compiled per process (least recently used are dropped first). */
const CACHE_LIMIT = 500;

/** @type {Map<string, ReturnType<typeof compile>>} */
const cache = new Map();

/**
 * Compile a condition (empty / whitespace = always true, represented by `null`).
 * @param {string | undefined | null} source
 * @returns {{ ok: true, program: import('@ss/rules').Program | null } | { ok: false, error: import('@ss/rules').RuleError }}
 */
export const compileCondition = (source) => {
	if (typeof source !== 'string' || source.trim() === '') return { ok: true, program: null };
	const hit = cache.get(source);
	if (hit) {
		cache.delete(source);
		cache.set(source, hit);
		return hit;
	}
	const result = compile(source);
	cache.set(source, result);
	if (cache.size > CACHE_LIMIT) cache.delete(/** @type {string} */ (cache.keys().next().value));
	return result;
};

/**
 * Editor diagnostics for a condition: errors with positions, unknown identifiers as warnings, paths and functions.
 * @param {string} source
 */
export const checkCondition = (source) => {
	if (typeof source !== 'string' || source.trim() === '')
		return { ok: true, errors: [], warnings: [], paths: [], functions: [] };
	return check(source, { roots: [...RULE_ROOTS] });
};

/**
 * The context a condition sees: the cart (lines as plain data), the customer, payment and delivery methods, the
 * request context and the coupon being tested.
 * @param {import('./cart.js').Cart} cart
 * @param {{ id: string, code: string }} coupon
 */
export const ruleContext = (cart, coupon) => ({
	cart: {
		currency: cart.currency,
		subtotal: cart.subtotal,
		quantity: cart.quantity,
		shipping: cart.shipping,
		lines: cart.lines.map((line) => ({
			lineId: line.lineId,
			itemId: line.itemId,
			variantId: line.variantId,
			quantity: line.quantity,
			unitAmount: line.unitAmount,
			amount: line.amount,
			attributes: line.attributes,
			collections: line.collections,
		})),
	},
	customer: { ...cart.customer },
	paymentMethod: cart.paymentMethod,
	deliveryMethod: cart.deliveryMethod,
	context: { country: cart.context.country, device: cart.context.device, source: cart.context.source },
	coupon: { id: coupon.id, code: coupon.code },
	segments: cart.customer.segments,
});

/**
 * Evaluate a condition.
 * @param {string | undefined | null} source
 * @param {Record<string, unknown>} context
 * @param {{ now: number, timeZone: string }} options
 * @returns {{ matched: boolean, error: string | null }}
 */
export const conditionMatches = (source, context, { now, timeZone }) => {
	const compiled = compileCondition(source);
	if (!compiled.ok) return { matched: false, error: compiled.error.code };
	if (compiled.program === null) return { matched: true, error: null };
	const result = evaluateCondition(compiled.program, context, { now: new Date(now), timeZone });
	return result.ok ? { matched: result.value === true, error: null } : { matched: false, error: result.error.code };
};
