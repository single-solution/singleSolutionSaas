/**
 * Mode B headless core of the `collections` element: the visible collections tree (`GET /v1/collections?tree=true`)
 * with expand / collapse, the active collection and its breadcrumb path. DOM-free.
 */
import { createTranslator } from './strings.js';
import { createStore, refused } from './store.js';

/**
 * @typedef {object} TreeNode
 * @property {string} id
 * @property {string} slug
 * @property {string} title
 * @property {number} depth
 * @property {boolean} expanded
 * @property {boolean} active
 * @property {ReadonlyArray<TreeNode>} children
 */
/**
 * @typedef {object} CollectionsState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {ReadonlyArray<TreeNode>} tree
 * @property {string | null} activeId
 * @property {ReadonlyArray<{ id: string, title: string }>} path root → active
 * @property {string | null} error
 */

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: import('./store.js').CatalogClient,
 *   emit?: (name: string, data: Record<string, unknown>) => void }} options
 */
export const createCollections = ({ strings = {}, client, emit = () => {} }) => {
	const t = createTranslator(strings);
	const store = createStore(
		/** @type {CollectionsState} */ ({ status: 'idle', tree: [], activeId: null, path: [], error: null }),
	);
	/** @type {Array<Record<string, any>>} */
	let raw = [];
	/** @type {Set<string>} */
	const expanded = new Set();

	/** @param {Array<Record<string, any>>} nodes @param {string | null} activeId @returns {TreeNode[]} */
	const shape = (nodes, activeId) =>
		nodes.map((node) => ({
			id: node.id,
			slug: node.slug,
			title: node.title,
			depth: node.depth,
			expanded: expanded.has(node.id),
			active: node.id === activeId,
			children: shape(node.children ?? [], activeId),
		}));

	/** @param {string} id @param {Array<Record<string, any>>} nodes @returns {Array<{ id: string, title: string }> | null} */
	const pathTo = (id, nodes) => {
		for (const node of nodes) {
			if (node.id === id) return [{ id: node.id, title: node.title }];
			const below = pathTo(id, node.children ?? []);
			if (below) return [{ id: node.id, title: node.title }, ...below];
		}
		return null;
	};

	/** @param {string | null} activeId */
	const settle = (activeId) =>
		store.set({ tree: shape(raw, activeId), activeId, path: activeId ? (pathTo(activeId, raw) ?? []) : [] });

	const actions = Object.freeze({
		/** @param {{ activeId?: string | null }} [options] */
		load: async ({ activeId = null } = {}) => {
			store.set({ status: 'loading', error: null });
			const result = await client.get('/v1/collections', { query: { tree: true } });
			if (!result.ok) {
				store.set({ status: 'error', error: t('catalog.error.load_failed') });
				return result;
			}
			raw = result.value.items ?? [];
			for (const step of activeId ? (pathTo(activeId, raw) ?? []) : []) expanded.add(step.id);
			store.set({ status: 'ready' });
			settle(activeId);
			return result;
		},
		/** @param {string} id */
		toggle: (id) => {
			if (!pathTo(id, raw)) return refused('not_found');
			if (expanded.has(id)) expanded.delete(id);
			else expanded.add(id);
			settle(store.get().activeId);
			return { ok: true, value: expanded.has(id) };
		},
		/** @param {string} id */
		select: (id) => {
			const path = pathTo(id, raw);
			if (!path) return refused('not_found');
			for (const step of path) expanded.add(step.id);
			settle(id);
			emit('selected', { collectionId: id });
			return { ok: true, value: path };
		},
	});

	return Object.freeze({
		/** @returns {CollectionsState} */
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
