/**
 * The signed-in shopper's wishlist as the widgets on a page share it (feature `wishlist`): the saved product ids,
 * read once per sign-in, and saving or removing a product. Every widget asking for the same `shop` gets the same
 * list, and hears each change.
 * @module
 */

/** @typedef {import('./widget.js').Shop} Shop */
/** @typedef {import('./widget.js').Answer} Answer */

/** @param {Shop} shop */
const createSaved = (shop) => {
	/** @type {{ signIn: string | null, ids: Promise<Set<string>> } | null} */
	let cache = null;
	/** @type {Set<() => void>} */
	const listeners = new Set();

	/**
	 * The saved product ids (empty for guests or when the wishlist cannot be read).
	 * @returns {Promise<Set<string>>}
	 */
	const ids = () => {
		const signIn = shop.signIn();
		if (!signIn) return Promise.resolve(new Set());
		if (cache?.signIn !== signIn)
			cache = {
				signIn,
				ids: shop
					.call('/v1/shop/wishlist')
					.then((answer) =>
						answer.ok ? new Set(answer.data.items.map((/** @type {{ id: string }} */ item) => item.id)) : new Set(),
					),
			};
		return cache.ids;
	};

	/**
	 * Save a product, or remove it when saved.
	 * @param {string} productId
	 * @returns {Promise<{ ok: boolean, saved: boolean, answer: Answer }>}
	 */
	const toggle = async (productId) => {
		const was = (await ids()).has(productId);
		const answer = await shop.call(`/v1/shop/wishlist/items/${encodeURIComponent(productId)}`, {
			method: was ? 'DELETE' : 'POST',
		});
		if (!answer.ok) return { ok: false, saved: was, answer };
		const next = new Set(answer.data.items.map((/** @type {{ id: string }} */ item) => item.id));
		cache = { signIn: shop.signIn(), ids: Promise.resolve(next) };
		for (const listener of listeners) listener();
		return { ok: true, saved: next.has(productId), answer };
	};

	/** @param {() => void} listener @returns {() => void} */
	const onChange = (listener) => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	};

	return Object.freeze({ ids, toggle, onChange });
};

/** @type {WeakMap<Shop, ReturnType<typeof createSaved>>} */
const shared = new WeakMap();

/**
 * The wishlist shared by every widget of this `shop`.
 * @param {Shop} shop
 */
export const savedOf = (shop) => {
	const found = shared.get(shop);
	if (found) return found;
	const made = createSaved(shop);
	shared.set(shop, made);
	return made;
};
