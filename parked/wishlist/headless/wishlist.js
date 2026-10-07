/**
 * Mode B headless core of the `widgets` element — the heart button, the list page and the share view: state, actions,
 * subscribe, validate, strings, destroy (Part E §4). Framework-agnostic and DOM-free; the default renderer
 * (ui/wishlist.js) and any merchant-built UI use exactly this core. Ported from ibrahimMobiles `useWishlist`: one
 * state call per page shared by every heart (`createWishlistStore`), optimistic toggles rolled back on failure, the
 * guest list merged into the account on sign-in and then forgotten locally.
 *
 * `client` is the element's Mode C client (`wishlistClient(api)` over `@ss/web/element` with the website's `pk_` key
 * and, when the shopper is signed in on the website, their own login token as `SS-Identity`). Guests: the signed guest
 * token from the server is kept in the browser storage the merchant chose (`guest_merge.storage`) **only** when the
 * shopper granted the configured consent category (`consent(category)`); otherwise it lives in memory for this page.
 * Storage and consent are injected — nothing here touches browser globals.
 */
import { formatMoney } from '../core/money.js';
import { createTranslator } from './strings.js';

/** Storage key of the guest token. */
export const GUEST_KEY = 'ss.wishlist.guest';

/** @typedef {{ type?: string, title?: string, status?: number, detail?: string, code?: string, errors?: Array<{ path: string, code: string }> }} Problem */
/**
 * @template T
 * @typedef {{ ok: true, value: T } | { ok: false, problem: Problem }} Result
 */
/** @typedef {{ getItem: (key: string) => string | null, setItem: (key: string, value: string) => void, removeItem: (key: string) => void }} StorageLike */
/**
 * @typedef {object} WishlistClient
 * @property {(body: Record<string, unknown>) => Promise<Result<any>>} state
 * @property {(listId: string, body: Record<string, unknown>) => Promise<Result<any>>} add
 * @property {(listId: string, entryId: string, body: Record<string, unknown>) => Promise<Result<any>>} remove
 * @property {(body: Record<string, unknown>) => Promise<Result<any>>} createList
 * @property {(listId: string, body: Record<string, unknown>) => Promise<Result<any>>} updateList
 * @property {(listId: string, body: Record<string, unknown>) => Promise<Result<any>>} deleteList
 * @property {(body: Record<string, unknown>) => Promise<Result<any>>} share
 * @property {(body: Record<string, unknown>) => Promise<Result<any>>} revoke
 * @property {(token: string) => Promise<Result<any>>} shared
 */

/**
 * Adapt an `@ss/web/element` API client (`createElementApi`) to the element's client.
 * @param {{ get: Function, post: Function, patch: Function, delete: Function }} api
 * @returns {WishlistClient}
 */
export const wishlistClient = (api) => {
	/** @param {any} result @returns {Result<any>} */
	const wrap = (result) =>
		result.ok ? { ok: true, value: result.value } : { ok: false, problem: result.error ?? { code: 'request_failed' } };
	const enc = encodeURIComponent;
	return Object.freeze({
		state: async (body) => wrap(await api.post('/v1/wishlist', body)),
		add: async (listId, body) => wrap(await api.post(`/v1/lists/${enc(listId)}/items`, body)),
		remove: async (listId, entryId, body) => wrap(await api.delete(`/v1/lists/${enc(listId)}/items/${enc(entryId)}`, { body })),
		createList: async (body) => wrap(await api.post('/v1/lists', body)),
		updateList: async (listId, body) => wrap(await api.patch(`/v1/lists/${enc(listId)}`, body)),
		deleteList: async (listId, body) => wrap(await api.delete(`/v1/lists/${enc(listId)}`, { body })),
		share: async (body) => wrap(await api.post('/v1/shares', body)),
		revoke: async (body) => wrap(await api.post('/v1/shares:revoke', body)),
		shared: async (token) => wrap(await api.get(`/v1/shares/${enc(token)}`)),
	});
};

/**
 * @typedef {object} StoreState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {{ kind: 'customer' | 'guest' } | null} owner null = not signed in and guest lists are off
 * @property {any[]} lists the owner's lists with items (server views)
 * @property {Record<string, any>} settings maxLists, maxItems, guests, storage, consentCategory, share, notify, …
 * @property {string | null} activeListId the list the page shows
 * @property {{ listId: string, url: string | null, token: string } | null} share the share link just created
 * @property {string | null} message user-facing status or error text
 */

/**
 * The page-wide store every widget on the page shares (one state call, one guest token).
 * @param {{ client: WishlistClient, strings?: Record<string, string>, storage?: { local?: StorageLike | null, session?: StorageLike | null },
 *   consent?: (category: string) => boolean }} options
 */
export const createWishlistStore = ({ client, strings = {}, storage = {}, consent = () => false }) => {
	const t = createTranslator(strings);
	/** @type {Set<(state: StoreState) => void>} */
	const listeners = new Set();
	/** @type {string | null} */
	let guest = null;
	/** @type {Promise<Result<any>> | null} */
	let loading = null;
	/** @type {StoreState} */
	let state = Object.freeze({
		status: 'idle',
		owner: null,
		lists: [],
		settings: {},
		activeListId: null,
		share: null,
		message: null,
	});
	/** @param {Partial<StoreState>} patch */
	const set = (patch) => {
		state = Object.freeze({ ...state, ...patch });
		for (const listener of listeners) listener(state);
	};
	const stores = () => [storage.local, storage.session].filter((s) => s !== null && s !== undefined);
	/** @param {(s: StorageLike) => void} run */
	const each = (run) => {
		for (const s of stores()) {
			try {
				run(/** @type {StorageLike} */ (s));
			} catch {
				// storage blocked: the token just won't survive a reload
			}
		}
	};
	const readGuest = () => {
		let found = null;
		each((s) => {
			found ??= s.getItem(GUEST_KEY);
		});
		return found;
	};
	/** Keep the guest token where the merchant allows it, and only with consent. */
	const persist = () => {
		const { storage: where = 'memory', consentCategory = 'necessary' } = state.settings;
		const allowed = guest && where !== 'memory' && (consentCategory === 'necessary' || consent(consentCategory));
		const target = allowed ? (where === 'local' ? storage.local : storage.session) : null;
		each((s) => (s === target && guest ? s.setItem(GUEST_KEY, guest) : s.removeItem(GUEST_KEY)));
	};
	/** Body fields that say who is acting (guests send their token). */
	const who = () => (state.owner?.kind === 'guest' && guest ? { guest } : {});
	/** @param {Problem} problem */
	const messageOf = (problem) => {
		const code = problem.code ?? '';
		if (['limit_reached', 'identity_required', 'rate_limited', 'share_not_allowed'].includes(code))
			return t(`wishlist.error.${code}`);
		if (code === 'element_disabled' || code === 'subscription_inactive') return t('wishlist.error.unavailable');
		return t('wishlist.error.request_failed');
	};
	/** @param {any} list */
	const putList = (list) => {
		const known = state.lists.some((l) => l.id === list.id);
		set({ lists: known ? state.lists.map((l) => (l.id === list.id ? list : l)) : [...state.lists, list] });
	};

	const load = async () => {
		if (loading) return loading;
		guest ??= readGuest();
		set({ status: 'loading' });
		loading = client.state(guest ? { guest } : {}).then((result) => {
			loading = null;
			if (!result.ok) {
				set({ status: 'error', message: messageOf(result.problem) });
				return result;
			}
			const value = result.value;
			if (value.dropGuest) guest = null;
			if (value.guest?.token) guest = value.guest.token;
			const activeListId =
				value.lists.find((/** @type {any} */ l) => l.id === state.activeListId)?.id ?? value.lists[0]?.id ?? null;
			set({ status: 'ready', owner: value.owner, lists: value.lists, settings: value.settings, activeListId, message: null });
			persist();
			return result;
		});
		return loading;
	};

	/**
	 * Run a request; on failure restore `rollback` and show the problem.
	 * @param {() => Promise<Result<any>>} request
	 * @param {Partial<StoreState> | null} rollback
	 */
	const run = async (request, rollback) => {
		const result = await request();
		if (!result.ok) set({ ...(rollback ?? {}), message: messageOf(result.problem) });
		return result;
	};

	return Object.freeze({
		/** @returns {StoreState} */
		state: () => state,
		/** @param {(state: StoreState) => void} listener */
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		t,
		load,
		/** Re-apply the consent decision (call when the shopper changes consent). */
		consentChanged: () => persist(),
		/** Forget the shopper (call on sign-out): the next load starts over. */
		reset: () => {
			guest = null;
			persist();
			set({ status: 'idle', owner: null, lists: [], activeListId: null, share: null, message: null });
		},
		/** @param {string} listId */
		select: (listId) => set({ activeListId: listId, share: null }),
		/**
		 * The entry of an item in a list (default: the default list).
		 * @param {{ itemId: string, variantId?: string | null }} item
		 * @param {string | null} [listId]
		 */
		entryOf: (item, listId = null) => {
			const list = listId
				? state.lists.find((l) => l.id === listId)
				: (state.lists.find((l) => l.isDefault) ?? state.lists[0]);
			return (
				list?.items.find(
					(/** @type {any} */ e) => e.itemId === item.itemId && (e.variantId ?? null) === (item.variantId ?? null),
				) ?? null
			);
		},
		/**
		 * Save an item (optimistically shown as saved).
		 * @param {Record<string, any>} item `{ itemId, variantId?, title?, image?, url?, price? }`
		 * @param {string | null} [listId] default: the default list
		 */
		add: async (item, listId = null) => {
			if (!state.owner) {
				set({ message: t('wishlist.error.identity_required') });
				return { ok: false, problem: { code: 'identity_required' } };
			}
			const target = listId ?? 'default';
			const before = state.lists;
			const optimistic = { id: `pending:${item.itemId}`, ...item, variantId: item.variantId ?? null };
			const list = listId
				? state.lists.find((l) => l.id === listId)
				: (state.lists.find((l) => l.isDefault) ?? state.lists[0]);
			if (list) putList({ ...list, items: [optimistic, ...list.items], itemCount: list.itemCount + 1 });
			const result = await run(() => client.add(target, { ...item, ...who() }), { lists: before });
			if (result.ok) {
				putList(result.value.list);
				if (!state.activeListId) set({ activeListId: result.value.list.id });
			}
			return result;
		},
		/**
		 * Remove an entry (optimistically hidden).
		 * @param {string} listId
		 * @param {string} entryId
		 */
		remove: async (listId, entryId) => {
			const before = state.lists;
			const list = state.lists.find((l) => l.id === listId);
			if (list)
				putList({
					...list,
					items: list.items.filter((/** @type {any} */ e) => e.id !== entryId),
					itemCount: list.itemCount - 1,
				});
			const result = await run(() => client.remove(listId, entryId, who()), { lists: before });
			if (result.ok) putList(result.value.list);
			return result;
		},
		/** @param {string} name */
		createList: async (name) => {
			const result = await run(() => client.createList({ name, ...who() }), null);
			if (result.ok) {
				putList(result.value);
				set({ activeListId: result.value.id, message: null });
			}
			return result;
		},
		/** @param {string} listId */
		deleteList: async (listId) => {
			const result = await run(() => client.deleteList(listId, who()), null);
			if (result.ok) {
				const lists = state.lists.filter((l) => l.id !== listId);
				set({ lists, activeListId: lists[0]?.id ?? null });
				await load();
			}
			return result;
		},
		/**
		 * Opt a list in or out of price-drop and back-in-stock signals.
		 * @param {string} listId
		 * @param {boolean} notify
		 */
		setNotify: async (listId, notify) => {
			const result = await run(() => client.updateList(listId, { notify }), null);
			if (result.ok) putList(result.value);
			return result;
		},
		/** @param {string} listId */
		share: async (listId) => {
			const result = await run(() => client.share({ listId, ...who() }), null);
			if (result.ok) {
				const list = state.lists.find((l) => l.id === listId);
				if (list) putList({ ...list, shared: true });
				set({ share: { listId, url: result.value.url, token: result.value.token }, message: t('page.share.created') });
			}
			return result;
		},
		/** @param {string} listId */
		revoke: async (listId) => {
			const result = await run(() => client.revoke({ listId, ...who() }), null);
			if (result.ok) {
				const list = state.lists.find((l) => l.id === listId);
				if (list) putList({ ...list, shared: false });
				set({ share: null, message: t('page.share.revoked') });
			}
			return result;
		},
		/** @param {string} token */
		shared: (token) => client.shared(token),
		/** @param {Problem} problem */
		messageOf,
	});
};

/** @typedef {ReturnType<typeof createWishlistStore>} WishlistStore */

/**
 * @typedef {object} WishlistState what the renderer draws
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {'heart' | 'page' | 'share'} view
 * @property {boolean} signedIn
 * @property {boolean} canSave a customer or a guest
 * @property {{ itemId: string, variantId: string | null, title: string | null } | null} item the heart's item
 * @property {boolean} saved the heart's item is on the target list
 * @property {boolean} busy
 * @property {Array<{ id: string, name: string, isDefault: boolean, notify: boolean, shared: boolean, itemCount: number }>} lists
 * @property {{ id: string, name: string, notify: boolean, shared: boolean,
 *   items: Array<{ id: string, itemId: string, title: string | null, image: string | null, url: string | null, priceText: string, inStock: boolean | null }> } | null} active
 * @property {{ name: string, items: Array<{ itemId: string, title: string | null, image: string | null, url: string | null, priceText: string, inStock: boolean | null }> } | null} shared
 * @property {{ listId: string, url: string | null, token: string } | null} share
 * @property {Record<string, any>} settings
 * @property {string | null} message
 */

/**
 * The element (one per mount): a heart for an item, the list page or the share view, over a shared store.
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: WishlistClient,
 *   identity?: { signedIn?: boolean } | null, emit?: (name: string, data: Record<string, unknown>) => void,
 *   storage?: { local?: StorageLike | null, session?: StorageLike | null }, consent?: (category: string) => boolean,
 *   store?: WishlistStore }} options
 *   `config`: `{ view?: 'heart' | 'page' | 'share', item?: { itemId, variantId?, title?, image?, url?, price? },
 *   listId?, shareToken?, lang? }`; `store`: share one store between the widgets of a page
 */
export const createWishlist = ({ config = {}, strings = {}, client, emit = () => {}, storage, consent, store }) => {
	const shop = store ?? createWishlistStore({ client, strings, storage, consent });
	const t = shop.t;
	const view = config.view === 'page' || config.view === 'share' ? config.view : 'heart';
	const locale = typeof config.lang === 'string' ? config.lang : strings['wishlist.locale'];
	const item = config.item && typeof config.item.itemId === 'string' ? config.item : null;
	/** @type {Set<(state: WishlistState) => void>} */
	const listeners = new Set();
	let destroyed = false;
	let busy = false;
	/** @type {WishlistState['shared']} */
	let shared = null;
	/** @type {string | null} */
	let note = null;
	/** @type {'idle' | 'loading' | 'ready' | 'error'} */
	let shareStatus = 'idle';

	/** @param {any} entry */
	const display = (entry) => ({
		id: entry.id,
		itemId: entry.itemId,
		title: entry.title ?? null,
		image: entry.image ?? null,
		url: entry.url ?? null,
		priceText: formatMoney(entry.price, locale),
		inStock: entry.inStock ?? null,
	});
	/** @returns {WishlistState} */
	const snapshot = () => {
		const s = shop.state();
		const active = s.lists.find((l) => l.id === s.activeListId) ?? null;
		return Object.freeze({
			status: view === 'share' ? shareStatus : s.status,
			view,
			signedIn: s.owner?.kind === 'customer',
			canSave: s.owner !== null,
			item: item ? { itemId: item.itemId, variantId: item.variantId ?? null, title: item.title ?? null } : null,
			saved: item ? shop.entryOf(item, config.listId ?? null) !== null : false,
			busy,
			lists: s.lists.map((l) => ({
				id: l.id,
				name: l.name,
				isDefault: l.isDefault,
				notify: l.notify,
				shared: l.shared,
				itemCount: l.itemCount,
			})),
			active: active
				? { id: active.id, name: active.name, notify: active.notify, shared: active.shared, items: active.items.map(display) }
				: null,
			shared,
			share: s.share,
			settings: s.settings,
			message: note ?? s.message,
		});
	};
	let state = snapshot();
	const publish = () => {
		if (destroyed) return;
		state = snapshot();
		for (const listener of listeners) listener(state);
	};
	const unsubscribe = shop.subscribe(() => {
		note = null;
		publish();
	});

	/**
	 * Field problems of a list form value (pure).
	 * @param {{ name?: unknown }} input
	 * @returns {Array<{ path: string, code: string, message: string }>}
	 */
	const validate = (input) => {
		const name = typeof input.name === 'string' ? input.name.trim() : '';
		return name ? [] : [{ path: '/name', code: 'required', message: t('page.error.name_required') }];
	};

	const actions = Object.freeze({
		/** Load the shopper's lists (once per page for every widget) or, for the share view, the shared list. */
		load: async () => {
			if (view !== 'share') return shop.load();
			const token = typeof config.shareToken === 'string' ? config.shareToken : '';
			shareStatus = 'loading';
			publish();
			const result = await shop.shared(token);
			shareStatus = result.ok ? 'ready' : 'error';
			shared = result.ok ? { name: result.value.name, items: result.value.items.map(display) } : null;
			note = result.ok ? null : t('share.error.not_found');
			publish();
			return result;
		},
		/** Heart: save or remove this mount's item. Resolves to the new saved state (unchanged on failure). */
		toggle: async () => {
			if (!item || busy) return { ok: false, problem: { code: busy ? 'busy' : 'no_item' } };
			busy = true;
			const entry = shop.entryOf(item, config.listId ?? null);
			const title = item.title ?? t('heart.item');
			const target = config.listId ?? null;
			const result = entry
				? await shop.remove(target ?? (shop.state().lists.find((l) => l.isDefault) ?? shop.state().lists[0]).id, entry.id)
				: await shop.add(item, target);
			busy = false;
			if (result.ok) {
				note = shop.state().settings.announce === false ? null : t(entry ? 'heart.removed' : 'heart.saved', { title });
				emit(entry ? 'widgets.removed' : 'widgets.saved', { itemId: item.itemId });
			}
			publish();
			return result;
		},
		/** @param {string} listId */
		select: async (listId) => shop.select(listId),
		/**
		 * @param {string} listId
		 * @param {string} entryId
		 */
		remove: async (listId, entryId) => shop.remove(listId, entryId),
		/** @param {string} name */
		createList: async (name) => {
			const problems = validate({ name });
			if (problems.length > 0) {
				note = problems[0]?.message ?? null;
				publish();
				return { ok: /** @type {const} */ (false), problem: { code: 'validation_failed', errors: problems } };
			}
			return shop.createList(name.trim());
		},
		/** @param {string} listId */
		deleteList: async (listId) => shop.deleteList(listId),
		/**
		 * @param {string} listId
		 * @param {boolean} notify
		 */
		setNotify: async (listId, notify) => shop.setNotify(listId, notify),
		/** @param {string} listId */
		share: async (listId) => {
			const result = await shop.share(listId);
			if (result.ok) emit('widgets.shared', {});
			return result;
		},
		/** @param {string} listId */
		revoke: async (listId) => shop.revoke(listId),
	});

	return Object.freeze({
		/** @returns {WishlistState} immutable snapshot */
		state: () => state,
		actions,
		/**
		 * @param {(state: WishlistState) => void} listener
		 * @returns {() => void}
		 */
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		validate,
		strings,
		t,
		store: shop,
		destroy: () => {
			destroyed = true;
			unsubscribe();
			listeners.clear();
		},
	});
};
