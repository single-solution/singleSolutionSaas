/**
 * Mode B headless core of the `media` element: an item's gallery (images with srcset and alt text, videos), the
 * current index with next / previous (wrapping), and narrowing to one variant's media (media without variants apply to
 * every variant). DOM-free.
 */
import { createTranslator } from './strings.js';
import { createStore, refused } from './store.js';

/**
 * @typedef {object} GalleryState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {string | null} title
 * @property {ReadonlyArray<{ id: string, kind: 'image' | 'video', url: string, srcset: string | null, alt: string, width: number | null, height: number | null }>} media
 * @property {number} index
 * @property {string | null} variantId
 * @property {string | null} positionText "2 / 5"
 * @property {string | null} error
 */

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: import('./store.js').CatalogClient,
 *   emit?: (name: string, data: Record<string, unknown>) => void }} options
 */
export const createGallery = ({ strings = {}, client, emit = () => {} }) => {
	const t = createTranslator(strings);
	const store = createStore(
		/** @type {GalleryState} */ ({
			status: 'idle',
			title: null,
			media: [],
			index: 0,
			variantId: null,
			positionText: null,
			error: null,
		}),
	);
	/** @type {Array<Record<string, any>>} */
	let all = [];

	/** @param {string | null} variantId @param {number} index */
	const settle = (variantId, index) => {
		const media = all
			.filter((m) => m.url && (!variantId || m.variantIds.length === 0 || m.variantIds.includes(variantId)))
			.map((m) => ({
				id: m.id,
				kind: m.kind,
				url: m.url,
				srcset: m.srcset ?? null,
				alt: m.alt ?? '',
				width: m.width ?? null,
				height: m.height ?? null,
			}));
		const bounded = media.length === 0 ? 0 : ((index % media.length) + media.length) % media.length;
		store.set({
			media,
			index: bounded,
			variantId,
			positionText: media.length > 0 ? t('catalog.gallery.position', { index: bounded + 1, count: media.length }) : null,
		});
	};

	const actions = Object.freeze({
		/** @param {string} ref item id or slug */
		load: async (ref) => {
			store.set({ status: 'loading', error: null });
			const result = await client.get(`/v1/items/${encodeURIComponent(ref)}`);
			if (!result.ok) {
				store.set({ status: 'error', error: t('catalog.error.load_failed') });
				return result;
			}
			all = result.value.media ?? [];
			store.set({ status: 'ready', title: result.value.title ?? null });
			settle(null, 0);
			return result;
		},
		/** @param {number} index */
		show: (index) => {
			if (!Number.isInteger(index) || index < 0 || index >= store.get().media.length) return refused('index_invalid');
			settle(store.get().variantId, index);
			emit('shown', { index });
			return { ok: true, value: index };
		},
		next: () => {
			if (store.get().media.length === 0) return refused('empty');
			settle(store.get().variantId, store.get().index + 1);
			return { ok: true, value: store.get().index };
		},
		previous: () => {
			if (store.get().media.length === 0) return refused('empty');
			settle(store.get().variantId, store.get().index - 1);
			return { ok: true, value: store.get().index };
		},
		/** @param {string | null} variantId */
		forVariant: (variantId) => {
			settle(variantId, 0);
			return { ok: true, value: store.get().media.length };
		},
	});

	return Object.freeze({
		/** @returns {GalleryState} */
		state: () => store.get(),
		actions,
		subscribe: store.subscribe,
		/** @returns {Array<{ path: string, code: string, message: string }>} */
		validate: () => [],
		strings,
		t,
		destroy: store.destroy,
	});
};
