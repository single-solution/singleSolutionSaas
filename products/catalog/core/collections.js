/**
 * Collections tree (pure): categories or any grouping, with a depth limit, manual order, marketing copy, SEO fields and
 * a visibility cascade (a hidden collection hides every collection below it).
 * @module
 */
import { cleanText, isId, isObject, isSlug, issue, isNil, seoOf, slugify } from './text.js';

const LIMITS = Object.freeze({ title: 200, description: 20000, seoTitle: 200, seoDescription: 500, heading: 200 });

/**
 * @typedef {object} Collection
 * @property {string} id
 * @property {string} slug
 * @property {string} title
 * @property {string | null} heading marketing headline
 * @property {string | null} description marketing copy
 * @property {string | null} parentId
 * @property {string[]} ancestors root first
 * @property {number} depth 1 = root
 * @property {number} position
 * @property {boolean} visible own flag (see {@link visibleCollectionIds} for the cascade)
 * @property {{ title: string | null, description: string | null }} seo
 * @property {{ url?: string, key?: string, alt?: string | null } | null} image
 */

/**
 * Validate a collection (create or patch over `current`); the tree position is checked by {@link placeIn}.
 * @param {unknown} input
 * @param {{ current?: Collection | null, seoFields: boolean }} context
 * @returns {{ problems: Array<{ path: string, code: string }>, value: Omit<Collection, 'id' | 'ancestors' | 'depth'> | null }}
 */
export const validateCollection = (input, { current = null, seoFields }) => {
	if (!isObject(input)) return { problems: [issue('', 'object_required')], value: null };
	const body = /** @type {Record<string, any>} */ (input);
	const has = (/** @type {string} */ key) => Object.hasOwn(body, key);
	/** @type {Array<{ path: string, code: string }>} */
	const problems = [];
	const title = has('title') ? cleanText(body.title, LIMITS.title) : (current?.title ?? null);
	if (title === null) problems.push(issue('/title', 'required'));
	const slug = has('slug') ? body.slug : (current?.slug ?? slugify(title ?? ''));
	if (!isSlug(slug)) problems.push(issue('/slug', 'slug_invalid'));
	/** @param {string} key @param {number} max @param {boolean} [multiline] */
	const text = (key, max, multiline = false) => {
		if (!has(key)) return /** @type {any} */ (current)?.[key] ?? null;
		if (body[key] === null || body[key] === '') return null;
		const value = cleanText(body[key], max, { multiline });
		if (value === null) problems.push(issue(`/${key}`, 'text_invalid'));
		return value;
	};
	const heading = text('heading', LIMITS.heading);
	const description = text('description', LIMITS.description, true);
	const parentId = has('parentId') ? body.parentId : (current?.parentId ?? null);
	if (parentId !== null && !isId(parentId)) problems.push(issue('/parentId', 'id_invalid'));
	const position = has('position') ? body.position : (current?.position ?? 0);
	if (!Number.isSafeInteger(position) || position < 0 || position > 100_000)
		problems.push(issue('/position', 'position_invalid'));
	const visible = has('visible') ? body.visible : (current?.visible ?? true);
	if (typeof visible !== 'boolean') problems.push(issue('/visible', 'boolean_invalid'));
	let seo = current?.seo ?? { title: null, description: null };
	if (has('seo')) {
		if (!seoFields) problems.push(issue('/seo', 'seo_disabled'));
		else if (!isObject(body.seo)) problems.push(issue('/seo', 'object_required'));
		else {
			const parsed = seoOf(body.seo);
			problems.push(...parsed.problems);
			seo = parsed.value;
		}
	}
	let image = current?.image ?? null;
	if (has('image')) {
		image = body.image === null ? null : imageRef(body.image);
		if (body.image !== null && image === null) problems.push(issue('/image', 'media_invalid'));
	}
	if (problems.length > 0) return { problems, value: null };
	return {
		problems,
		value: { slug, title: /** @type {string} */ (title), heading, description, parentId, position, visible, seo, image },
	};
};

/**
 * A small media reference (`url` https or a storage `key`).
 * @param {unknown} input
 * @returns {{ url?: string, key?: string, alt: string | null } | null}
 */
export const imageRef = (input) => {
	if (!isObject(input)) return null;
	const body = /** @type {Record<string, any>} */ (input);
	const alt = isNil(body.alt) ? null : cleanText(body.alt, 300);
	if (typeof body.url === 'string' && body.url.length <= 2048 && /^https:\/\/[^\s]+$/.test(body.url))
		return { url: body.url, alt };
	if (typeof body.key === 'string' && /^[A-Za-z0-9!_.*'()/-]{1,512}$/.test(body.key) && !body.key.includes('..'))
		return { key: body.key, alt };
	return null;
};

/**
 * Where a collection goes in the tree: its ancestors and depth, refusing unknown parents, cycles and too deep trees.
 * @param {ReadonlyArray<Pick<Collection, 'id' | 'parentId' | 'ancestors' | 'depth'>>} all every collection of the website
 * @param {{ id: string | null, parentId: string | null, maxDepth: number }} input `id` null = a new collection
 * @returns {{ ok: true, ancestors: string[], depth: number } | { ok: false, code: 'parent_unknown' | 'cycle' | 'too_deep' }}
 */
export const placeIn = (all, { id, parentId, maxDepth }) => {
	if (parentId === null)
		return subtreeFits(all, id, 1, maxDepth) ? { ok: true, ancestors: [], depth: 1 } : { ok: false, code: 'too_deep' };
	const parent = all.find((c) => c.id === parentId);
	if (!parent) return { ok: false, code: 'parent_unknown' };
	if (id !== null && (parent.id === id || parent.ancestors.includes(id))) return { ok: false, code: 'cycle' };
	const depth = parent.depth + 1;
	if (!subtreeFits(all, id, depth, maxDepth)) return { ok: false, code: 'too_deep' };
	return { ok: true, ancestors: [...parent.ancestors, parent.id], depth };
};

/**
 * @param {ReadonlyArray<Pick<Collection, 'id' | 'ancestors' | 'depth'>>} all
 * @param {string | null} id
 * @param {number} depth new depth of `id`
 * @param {number} maxDepth
 */
const subtreeFits = (all, id, depth, maxDepth) => {
	if (depth > maxDepth) return false;
	if (id === null) return true;
	const self = all.find((c) => c.id === id);
	const deepest = all.filter((c) => c.ancestors.includes(id)).reduce((max, c) => Math.max(max, c.depth), self?.depth ?? 0);
	return depth + (deepest - (self?.depth ?? deepest)) <= maxDepth;
};

/**
 * Ancestors and depth of every collection below `id` after it moved (its descendants keep their relative place).
 * @param {ReadonlyArray<Collection>} all
 * @param {string} id
 * @param {{ ancestors: string[], depth: number }} moved
 * @returns {Array<{ id: string, ancestors: string[], depth: number }>}
 */
export const descendantPlaces = (all, id, moved) =>
	all
		.filter((c) => c.ancestors.includes(id))
		.map((c) => {
			const below = c.ancestors.slice(c.ancestors.indexOf(id));
			const ancestors = [...moved.ancestors, ...below];
			return { id: c.id, ancestors, depth: ancestors.length + 1 };
		});

/**
 * Ids of the collections shoppers see: visible themselves and every ancestor visible (the cascade).
 * @param {ReadonlyArray<Pick<Collection, 'id' | 'visible' | 'ancestors'>>} all
 * @returns {Set<string>}
 */
export const visibleCollectionIds = (all) => {
	const hidden = new Set(all.filter((c) => !c.visible).map((c) => c.id));
	return new Set(all.filter((c) => !hidden.has(c.id) && !c.ancestors.some((a) => hidden.has(a))).map((c) => c.id));
};

/**
 * A collection and every collection below it.
 * @param {ReadonlyArray<Pick<Collection, 'id' | 'ancestors'>>} all
 * @param {string} id
 */
export const withDescendants = (all, id) => [id, ...all.filter((c) => c.ancestors.includes(id)).map((c) => c.id)];

/**
 * Nested tree in manual order (position, then title).
 * @template {Pick<Collection, 'id' | 'parentId' | 'position' | 'title'>} T
 * @param {readonly T[]} list
 * @returns {Array<T & { children: any[] }>}
 */
export const buildTree = (list) => {
	const sorted = [...list].sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
	const ids = new Set(sorted.map((c) => c.id));
	/** @param {string | null} parentId @returns {Array<T & { children: any[] }>} */
	const childrenOf = (parentId) =>
		sorted
			.filter((c) => (parentId === null ? c.parentId === null || !ids.has(c.parentId) : c.parentId === parentId))
			.map((c) => ({ ...c, children: childrenOf(c.id) }));
	return childrenOf(null);
};
