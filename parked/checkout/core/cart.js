/**
 * Cart rules (pure): add / change / remove lines under the website's caps, merge a guest cart into a customer's cart,
 * and reconcile stored lines with the current item records (price changes, stock caps, items gone). Lines carry a
 * server-priced snapshot; a quantity is never above the line cap or the tracked stock.
 * @module
 */

/**
 * @typedef {import('./items.js').PricedLine & { lineId: string, note: string | null }} CartLine
 */
/**
 * @typedef {object} Cart
 * @property {string} id
 * @property {'open' | 'converted' | 'merged' | 'abandoned'} status
 * @property {string | null} currency
 * @property {string | null} customerId identity subject (bring-your-own identity), null for guests
 * @property {CartLine[]} lines
 * @property {string | null} note
 * @property {number} lineSeq
 */
/**
 * @typedef {object} CartRules
 * @property {number} maxLines
 * @property {number} maxQuantity per line
 */
/**
 * @typedef {object} Change what reconciliation or a cap changed, for the shopper
 * @property {string} lineId
 * @property {'price' | 'quantity' | 'unavailable' | 'removed'} kind
 * @property {string} title
 * @property {number | null} [from]
 * @property {number | null} [to]
 * @property {string} [reason]
 */

/**
 * Highest quantity a line may hold.
 * @param {{ available: number | null }} line
 * @param {CartRules} rules
 */
export const lineCap = (line, rules) =>
	line.available === null ? rules.maxQuantity : Math.max(0, Math.min(rules.maxQuantity, line.available));

/**
 * Add a priced line (same item + variant → one line, quantities added and capped).
 * @param {Cart} cart
 * @param {import('./items.js').PricedLine} priced
 * @param {CartRules & { note?: string | null }} rules
 * @returns {{ ok: true, cart: Cart, lineId: string, changes: Change[] } | { ok: false, reason: 'too_many_lines' }}
 */
export const addLine = (cart, priced, rules) => {
	const existing = cart.lines.find((line) => line.itemId === priced.itemId && line.variantId === priced.variantId);
	const cap = lineCap(priced, rules);
	if (existing) {
		const wanted = existing.quantity + priced.quantity;
		const quantity = Math.min(wanted, cap);
		const line = { ...existing, ...priced, lineId: existing.lineId, quantity, note: rules.note ?? existing.note };
		return {
			ok: true,
			cart: { ...cart, lines: cart.lines.map((entry) => (entry.lineId === existing.lineId ? line : entry)) },
			lineId: existing.lineId,
			changes:
				quantity < wanted ? [{ lineId: line.lineId, kind: 'quantity', title: line.title, from: wanted, to: quantity }] : [],
		};
	}
	if (cart.lines.length >= rules.maxLines) return { ok: false, reason: 'too_many_lines' };
	const lineId = `l${cart.lineSeq + 1}`;
	const quantity = Math.min(priced.quantity, cap);
	return {
		ok: true,
		cart: {
			...cart,
			lineSeq: cart.lineSeq + 1,
			lines: [...cart.lines, { ...priced, lineId, quantity, note: rules.note ?? null }],
		},
		lineId,
		changes:
			quantity < priced.quantity
				? [{ lineId, kind: 'quantity', title: priced.title, from: priced.quantity, to: quantity }]
				: [],
	};
};

/**
 * Set a line's quantity (0 removes it).
 * @param {Cart} cart
 * @param {string} lineId
 * @param {number} quantity
 * @param {CartRules} rules
 * @returns {{ ok: true, cart: Cart, changes: Change[] } | { ok: false, reason: 'line_not_found' }}
 */
export const setQuantity = (cart, lineId, quantity, rules) => {
	const line = cart.lines.find((entry) => entry.lineId === lineId);
	if (!line) return { ok: false, reason: 'line_not_found' };
	if (quantity === 0) return { ok: true, cart: { ...cart, lines: cart.lines.filter((entry) => entry !== line) }, changes: [] };
	const to = Math.min(quantity, lineCap(line, rules));
	return {
		ok: true,
		cart: { ...cart, lines: cart.lines.map((entry) => (entry === line ? { ...entry, quantity: to } : entry)) },
		changes: to < quantity ? [{ lineId, kind: 'quantity', title: line.title, from: quantity, to }] : [],
	};
};

/**
 * Merge a guest cart into the customer's cart: quantities of the same item + variant are added and capped, lines over
 * `maxLines` are left out (reported as removed).
 * @param {Cart} target
 * @param {Cart} source
 * @param {CartRules} rules
 * @returns {{ cart: Cart, changes: Change[] }}
 */
export const mergeCarts = (target, source, rules) => {
	let cart = { ...target, note: target.note ?? source.note };
	/** @type {Change[]} */
	const changes = [];
	for (const line of source.lines) {
		const result = addLine(cart, line, { ...rules, note: line.note });
		if (result.ok) {
			cart = result.cart;
			changes.push(...result.changes);
		} else changes.push({ lineId: line.lineId, kind: 'removed', title: line.title, reason: result.reason });
	}
	return { cart, changes };
};

/**
 * Reconcile lines with fresh pricing results (same order as `cart.lines`). Prices always follow the item record;
 * quantities follow the caps; a line that can no longer be sold is flagged (kept, `unavailable`) or removed, by policy.
 * @param {Cart} cart
 * @param {Array<{ ok: true, line: import('./items.js').PricedLine } | { ok: false, reason: string }>} results
 * @param {CartRules & { staleLines: 'flag' | 'remove' }} rules
 * @returns {{ cart: Cart, changes: Change[], unavailable: string[] }}
 */
export const reconcile = (cart, results, rules) => {
	/** @type {Change[]} */
	const changes = [];
	/** @type {string[]} */
	const unavailable = [];
	/** @type {CartLine[]} */
	const lines = [];
	cart.lines.forEach((line, index) => {
		const result = results[index];
		if (!result || !result.ok) {
			const reason = result && !result.ok ? result.reason : 'item_unavailable';
			changes.push({
				lineId: line.lineId,
				kind: rules.staleLines === 'remove' ? 'removed' : 'unavailable',
				title: line.title,
				reason,
			});
			unavailable.push(line.lineId);
			if (rules.staleLines !== 'remove') lines.push(line);
			return;
		}
		const fresh = result.line;
		const quantity = Math.min(line.quantity, lineCap(fresh, rules));
		if (fresh.unitAmount !== line.unitAmount)
			changes.push({ lineId: line.lineId, kind: 'price', title: fresh.title, from: line.unitAmount, to: fresh.unitAmount });
		if (quantity !== line.quantity)
			changes.push({ lineId: line.lineId, kind: 'quantity', title: fresh.title, from: line.quantity, to: quantity });
		if (quantity === 0) {
			unavailable.push(line.lineId);
			if (rules.staleLines !== 'remove')
				lines.push({ ...line, ...fresh, lineId: line.lineId, note: line.note, quantity: line.quantity });
			return;
		}
		lines.push({ ...line, ...fresh, lineId: line.lineId, note: line.note, quantity });
	});
	return { cart: { ...cart, lines }, changes, unavailable };
};

/**
 * Sum of line amounts.
 * @param {ReadonlyArray<{ unitAmount: number, quantity: number }>} lines
 */
export const subtotalOf = (lines) => lines.reduce((sum, line) => sum + line.unitAmount * line.quantity, 0);

/**
 * Public view of a cart (the API and the headless cart read this shape).
 * @param {Cart & { updatedAt?: Date | string, expiresAt?: Date | string | null }} cart
 * @param {{ changes?: Change[], unavailable?: string[] }} [extra]
 */
export const cartView = (cart, { changes = [], unavailable = [] } = {}) => ({
	id: cart.id,
	status: cart.status,
	currency: cart.currency,
	signedIn: Boolean(cart.customerId),
	note: cart.note,
	lines: cart.lines.map((line) => ({
		lineId: line.lineId,
		itemId: line.itemId,
		variantId: line.variantId,
		title: line.title,
		variantTitle: line.variantTitle,
		sku: line.sku,
		image: line.image,
		url: line.url,
		quantity: line.quantity,
		maxQuantity: line.available,
		unitAmount: line.unitAmount,
		compareAtAmount: line.compareAtAmount,
		totalAmount: line.unitAmount * line.quantity,
		requiresShipping: line.requiresShipping,
		note: line.note,
		available: !unavailable.includes(line.lineId),
	})),
	quantity: cart.lines.reduce((sum, line) => sum + line.quantity, 0),
	subtotalAmount: subtotalOf(cart.lines.filter((line) => !unavailable.includes(line.lineId))),
	changes,
	updatedAt: cart.updatedAt ? new Date(cart.updatedAt).toISOString() : null,
});

/**
 * `cart.updated@1` data (standard event; lines in the cart currency).
 * @param {Cart} cart
 */
export const cartUpdatedData = (cart) => ({
	cartId: cart.id,
	currency: /** @type {string} */ (cart.currency),
	lines: cart.lines.slice(0, 500).map((line) => ({
		itemId: line.itemId,
		variantId: line.variantId,
		...(line.sku ? { sku: line.sku } : {}),
		title: line.title.slice(0, 300),
		quantity: line.quantity,
		unitAmount: line.unitAmount,
		totalAmount: line.unitAmount * line.quantity,
	})),
	subtotalAmount: subtotalOf(cart.lines),
});
