/**
 * Cart service: create, read, change lines, reconcile and merge, with access control. A guest cart is reached by its
 * unguessable id (128 random bits); a cart that belongs to a signed-in shopper (identity subject) only by that shopper —
 * or by the merchant's server key. Every change is a compare-and-set on the cart version and publishes
 * `cart.updated@1` (when enabled).
 */
import { addLine, cartUpdatedData, cartView, mergeCarts, reconcile, setQuantity } from '../core/cart.js';
import { cleanText, isId, isObject, issue } from '../core/text.js';

/** @typedef {import('./context.js').Site} Site */
/** @typedef {import('./context.js').Checkout} Checkout */
/** @typedef {{ kind: 'pk' | 'sk' | 'session', subject: string | null, email: string | null, phone: string | null }} Requester */
/** @typedef {{ ok: true, cart: Record<string, any>, view: ReturnType<typeof cartView> } | { ok: false, code: string, errors?: Array<{ path: string, code: string }> }} CartResult */

const DAY = 86_400_000;

/**
 * @param {Checkout} checkout
 * @param {import('./items.js').ItemsService} items
 */
export const createCartsService = (checkout, items) => {
	const { app } = checkout;
	/** @param {Site} site */
	const rules = (site) => ({ maxLines: site.settings.cart.max_lines, maxQuantity: site.settings.cart.max_quantity_per_line });
	/** @param {Site} site */
	const expiry = (site) => new Date(app.now() + site.settings.cart.guest_cart_days * DAY);

	/**
	 * May this requester use the cart?
	 * @param {Record<string, any>} cart
	 * @param {Requester} who
	 */
	const mayUse = (cart, who) => who.kind === 'sk' || cart.customerId === null || cart.customerId === who.subject;

	/**
	 * @param {Site} site
	 * @param {string} id
	 * @param {Requester} who
	 * @param {{ open?: boolean }} [options]
	 * @returns {Promise<{ ok: true, cart: Record<string, any> } | { ok: false, code: string }>}
	 */
	const load = async (site, id, who, { open = true } = {}) => {
		if (!isId(id)) return { ok: false, code: 'cart_not_found' };
		const cart = await site.repos.carts.get(id);
		if (!cart || !mayUse(cart, who)) return { ok: false, code: 'cart_not_found' };
		if (open && cart.status !== 'open') return { ok: false, code: 'cart_closed' };
		return { ok: true, cart };
	};

	/**
	 * Save and publish.
	 * @param {Site} site
	 * @param {Record<string, any>} cart
	 * @param {Parameters<typeof cartView>[1]} [extra]
	 * @returns {Promise<CartResult>}
	 */
	const commit = async (site, cart, extra) => {
		const saved = await site.repos.carts.save({ ...cart, expireAt: expiry(site), abandonedAt: null });
		if (!saved) return { ok: false, code: 'conflict' };
		if (site.settings.cart.publish_updates && saved.currency)
			await checkout.publish(
				site,
				'cart.updated@1',
				cartUpdatedData(/** @type {any} */ (saved)),
				`${saved.id}:${saved.version}`,
			);
		return { ok: true, cart: saved, view: cartView(/** @type {any} */ (saved), extra) };
	};

	/**
	 * @param {Site} site
	 * @param {unknown} body `{ note? }`; server keys may name the owner `{ customerId }`
	 * @param {Requester} who
	 * @returns {Promise<CartResult>}
	 */
	const create = async (site, body, who) => {
		const input = isObject(body) ? body : {};
		const owner = who.kind === 'sk' ? cleanText(input.customerId, 255) : who.subject;
		if (owner && site.settings.cart.guest_merge) {
			const existing = await site.repos.carts.openFor(owner);
			if (existing) return { ok: true, cart: existing, view: cartView(existing) };
		}
		const cart = await site.repos.carts.insert({
			id: app.randomId('crt'),
			status: 'open',
			currency: site.settings.currency,
			customerId: owner ?? null,
			lines: [],
			note: site.settings.cart.allow_notes ? cleanText(input.note, 500) : null,
			lineSeq: 0,
			abandonedAt: null,
			expireAt: expiry(site),
		});
		return { ok: true, cart, view: cartView(/** @type {any} */ (cart)) };
	};

	/**
	 * Price wanted lines and add them.
	 * @param {Site} site
	 * @param {string} id
	 * @param {unknown} body `{ itemId, variantId?, quantity, note? }` or `{ lines: [...] }`
	 * @param {Requester} who
	 * @returns {Promise<CartResult>}
	 */
	const add = async (site, id, body, who) => {
		const loaded = await load(site, id, who);
		if (!loaded.ok) return loaded;
		if (!site.settings.currency) return { ok: false, code: 'currency_not_configured' };
		const input = isObject(body) ? body : {};
		const wants = Array.isArray(input.lines) ? input.lines : [input];
		/** @type {Array<{ path: string, code: string }>} */
		const errors = [];
		if (wants.length === 0 || wants.length > rules(site).maxLines) errors.push(issue('/lines', 'lines_count'));
		wants.forEach((/** @type {any} */ want, index) => {
			const at = Array.isArray(input.lines) ? `/lines/${index}` : '';
			if (!isObject(want) || !isId(want.itemId)) errors.push(issue(`${at}/itemId`, 'id_invalid'));
			else if (want.variantId !== undefined && want.variantId !== null && !isId(want.variantId))
				errors.push(issue(`${at}/variantId`, 'id_invalid'));
			else if (
				!Number.isInteger(want.quantity ?? 1) ||
				(want.quantity ?? 1) < 1 ||
				(want.quantity ?? 1) > rules(site).maxQuantity
			)
				errors.push(issue(`${at}/quantity`, 'quantity_invalid'));
		});
		if (errors.length > 0) return { ok: false, code: 'validation_failed', errors };
		const priced = await items.price(
			site,
			wants.map((/** @type {any} */ want) => ({
				itemId: want.itemId,
				variantId: want.variantId ?? null,
				quantity: want.quantity ?? 1,
			})),
		);
		const refused = priced.findIndex((result) => !result.ok);
		if (refused >= 0) {
			const result = /** @type {{ ok: false, reason: string }} */ (priced[refused]);
			return wants.length === 1
				? { ok: false, code: result.reason }
				: { ok: false, code: result.reason, errors: [issue(`/lines/${refused}`, result.reason)] };
		}
		if (loaded.cart.currency && loaded.cart.currency !== site.settings.currency)
			return { ok: false, code: 'currency_mismatch' };
		/** @type {any} */
		let cart = { ...loaded.cart, currency: site.settings.currency };
		/** @type {import('../core/cart.js').Change[]} */
		const changes = [];
		for (const [index, result] of priced.entries()) {
			if (!result.ok) continue;
			const note = site.settings.cart.allow_notes ? cleanText(/** @type {any} */ (wants[index])?.note, 500) : null;
			const added = addLine(/** @type {any} */ (cart), result.line, { ...rules(site), note });
			if (!added.ok) return { ok: false, code: added.reason };
			cart = added.cart;
			changes.push(...added.changes);
		}
		return commit(site, cart, { changes });
	};

	/**
	 * @param {Site} site
	 * @param {string} id
	 * @param {string} lineId
	 * @param {unknown} body `{ quantity?, note? }`
	 * @param {Requester} who
	 * @returns {Promise<CartResult>}
	 */
	const update = async (site, id, lineId, body, who) => {
		const loaded = await load(site, id, who);
		if (!loaded.ok) return loaded;
		const input = isObject(body) ? body : {};
		if (
			input.quantity !== undefined &&
			(!Number.isInteger(input.quantity) || input.quantity < 0 || input.quantity > rules(site).maxQuantity)
		)
			return { ok: false, code: 'validation_failed', errors: [issue('/quantity', 'quantity_invalid')] };
		let cart = loaded.cart;
		/** @type {import('../core/cart.js').Change[]} */
		let changes = [];
		if (input.quantity !== undefined) {
			const result = setQuantity(/** @type {any} */ (cart), lineId, input.quantity, rules(site));
			if (!result.ok) return { ok: false, code: result.reason };
			cart = result.cart;
			changes = result.changes;
		} else if (!cart.lines.some((/** @type {any} */ line) => line.lineId === lineId))
			return { ok: false, code: 'line_not_found' };
		if (input.note !== undefined && site.settings.cart.allow_notes)
			cart = {
				...cart,
				lines: cart.lines.map((/** @type {any} */ line) =>
					line.lineId === lineId ? { ...line, note: cleanText(input.note, 500) } : line,
				),
			};
		return commit(site, cart, { changes });
	};

	/**
	 * Cart-level changes (`{ note }`).
	 * @param {Site} site
	 * @param {string} id
	 * @param {unknown} body
	 * @param {Requester} who
	 */
	const patch = async (site, id, body, who) => {
		const loaded = await load(site, id, who);
		if (!loaded.ok) return loaded;
		const input = isObject(body) ? body : {};
		const note = site.settings.cart.allow_notes && input.note !== undefined ? cleanText(input.note, 500) : loaded.cart.note;
		return commit(site, { ...loaded.cart, note });
	};

	/**
	 * Re-price the cart from the current item records (price changes, stock caps, items gone).
	 * @param {Site} site
	 * @param {Record<string, any>} cart
	 */
	const refresh = async (site, cart) => {
		const priced = await items.price(
			site,
			cart.lines.map((/** @type {any} */ line) => ({
				itemId: line.itemId,
				variantId: line.variantId,
				quantity: line.quantity,
			})),
		);
		return reconcile(/** @type {any} */ (cart), priced, { ...rules(site), staleLines: site.settings.cart.stale_lines });
	};

	/**
	 * @param {Site} site
	 * @param {string} id
	 * @param {Requester} who
	 * @returns {Promise<CartResult>}
	 */
	const reconcileCart = async (site, id, who) => {
		const loaded = await load(site, id, who);
		if (!loaded.ok) return loaded;
		const { cart, changes, unavailable } = await refresh(site, loaded.cart);
		if (changes.length === 0) return { ok: true, cart: loaded.cart, view: cartView(/** @type {any} */ (loaded.cart)) };
		return commit(site, cart, { changes, unavailable });
	};

	/**
	 * Merge a guest cart into the signed-in shopper's open cart (or claim it when they have none).
	 * @param {Site} site
	 * @param {string} id the guest cart
	 * @param {Requester} who must carry an identity
	 * @returns {Promise<CartResult>}
	 */
	const merge = async (site, id, who) => {
		if (!who.subject) return { ok: false, code: 'identity_required' };
		const loaded = await load(site, id, who);
		if (!loaded.ok) return loaded;
		const guest = loaded.cart;
		if (guest.customerId === who.subject) return { ok: true, cart: guest, view: cartView(/** @type {any} */ (guest)) };
		const target = await site.repos.carts.openFor(who.subject);
		if (!target) return commit(site, { ...guest, customerId: who.subject });
		const { cart, changes } = mergeCarts(/** @type {any} */ (target), /** @type {any} */ (guest), rules(site));
		const saved = await commit(site, cart, { changes });
		if (saved.ok) await site.repos.carts.setStatus(guest.id, 'merged', { mergedInto: target.id });
		return saved;
	};

	return Object.freeze({ mayUse, load, create, add, update, patch, refresh, reconcile: reconcileCart, merge, expiry });
};

/** @typedef {ReturnType<typeof createCartsService>} CartsService */
