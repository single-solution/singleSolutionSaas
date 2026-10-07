/**
 * The lines a quote is for: a cart (by id, with access control) or lines in the request, always re-priced from the
 * item records.
 */
import { isId, isObject } from '../core/text.js';

/** @typedef {import('./context.js').Site} Site */

/**
 * @param {{ items: import('./items.js').ItemsService, carts: import('./carts.js').CartsService }} services
 */
export const createLines =
	({ items, carts }) =>
	/**
	 * @param {Site} site
	 * @param {unknown} body `{ cartId }` or `{ lines: [{ itemId, variantId?, quantity }] }`
	 * @param {import('./carts.js').Requester} who
	 * @returns {Promise<{ ok: true, lines: Array<import('../core/items.js').PricedLine & { lineId: string }>, cartId: string | null }
	 *   | { ok: false, code: string, errors?: Array<{ path: string, code: string }> }>}
	 */
	async (site, body, who) => {
		const input = isObject(body) ? body : {};
		/** @type {Array<{ lineId: string, itemId: string, variantId: string | null, quantity: number }>} */
		let wants;
		let cartId = null;
		if (input.cartId !== undefined) {
			const loaded = await carts.load(site, String(input.cartId), who);
			if (!loaded.ok) return loaded;
			cartId = loaded.cart.id;
			wants = loaded.cart.lines.map((/** @type {any} */ line) => ({
				lineId: line.lineId,
				itemId: line.itemId,
				variantId: line.variantId,
				quantity: line.quantity,
			}));
		} else {
			const raw = Array.isArray(input.lines) ? input.lines : null;
			const max = site.settings.cart.max_lines;
			const maxQuantity = site.settings.cart.max_quantity_per_line;
			if (
				!raw ||
				raw.length > max ||
				raw.some(
					(line) =>
						!isObject(line) ||
						!isId(line.itemId) ||
						(line.variantId !== undefined && line.variantId !== null && !isId(line.variantId)) ||
						!Number.isInteger(line.quantity) ||
						line.quantity < 1 ||
						line.quantity > maxQuantity,
				)
			)
				return { ok: false, code: 'validation_failed', errors: [{ path: '/lines', code: 'lines_invalid' }] };
			wants = raw.map((line, index) => ({
				lineId: `l${index + 1}`,
				itemId: line.itemId,
				variantId: line.variantId ?? null,
				quantity: line.quantity,
			}));
		}
		if (wants.length === 0) return { ok: false, code: 'cart_empty' };
		const priced = await items.price(site, wants);
		const errors = priced
			.map((result, index) => (result.ok ? null : { path: `/lines/${wants[index]?.lineId}`, code: result.reason }))
			.filter((entry) => entry !== null);
		if (errors.length > 0) return { ok: false, code: 'cart_unavailable_lines', errors };
		return {
			ok: true,
			cartId,
			lines: priced.map((result, index) => ({
				.../** @type {{ ok: true, line: import('../core/items.js').PricedLine }} */ (result).line,
				lineId: /** @type {any} */ (wants[index]).lineId,
			})),
		};
	};
