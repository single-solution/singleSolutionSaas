/**
 * Brand registry (pure): name, slug, logo, description, visibility and an optional scope of collections. A scoped
 * brand may only be set on items in one of its collections or their sub-collections (when `brands.scoping` is on).
 * @module
 */
import { imageRef } from './collections.js';
import { cleanText, isId, isObject, isSlug, issue, slugify } from './text.js';

/**
 * @typedef {object} Brand
 * @property {string} id
 * @property {string} slug
 * @property {string} name
 * @property {string | null} description
 * @property {{ url?: string, key?: string, alt: string | null } | null} logo
 * @property {string[]} collectionIds empty = any collection
 * @property {boolean} visible
 * @property {number} position
 */

/**
 * @param {unknown} input
 * @param {{ current?: Brand | null }} [context]
 * @returns {{ problems: Array<{ path: string, code: string }>, value: Omit<Brand, 'id'> | null }}
 */
export const validateBrand = (input, { current = null } = {}) => {
	if (!isObject(input)) return { problems: [issue('', 'object_required')], value: null };
	const body = /** @type {Record<string, any>} */ (input);
	const has = (/** @type {string} */ key) => Object.hasOwn(body, key);
	/** @type {Array<{ path: string, code: string }>} */
	const problems = [];
	const name = has('name') ? cleanText(body.name, 200) : (current?.name ?? null);
	if (name === null) problems.push(issue('/name', 'required'));
	const slug = has('slug') ? body.slug : (current?.slug ?? slugify(name ?? ''));
	if (!isSlug(slug)) problems.push(issue('/slug', 'slug_invalid'));
	let description = current?.description ?? null;
	if (has('description')) {
		description =
			body.description === null || body.description === '' ? null : cleanText(body.description, 5000, { multiline: true });
		if (body.description && description === null) problems.push(issue('/description', 'text_invalid'));
	}
	let logo = current?.logo ?? null;
	if (has('logo')) {
		logo = body.logo === null ? null : imageRef(body.logo);
		if (body.logo !== null && logo === null) problems.push(issue('/logo', 'media_invalid'));
	}
	const collectionIds = has('collectionIds') ? body.collectionIds : (current?.collectionIds ?? []);
	if (!Array.isArray(collectionIds) || collectionIds.length > 100 || !collectionIds.every(isId))
		problems.push(issue('/collectionIds', 'ids_invalid'));
	const visible = has('visible') ? body.visible : (current?.visible ?? true);
	if (typeof visible !== 'boolean') problems.push(issue('/visible', 'boolean_invalid'));
	const position = has('position') ? body.position : (current?.position ?? 0);
	if (!Number.isSafeInteger(position) || position < 0 || position > 100_000)
		problems.push(issue('/position', 'position_invalid'));
	if (problems.length > 0) return { problems, value: null };
	return {
		problems,
		value: {
			slug,
			name: /** @type {string} */ (name),
			description,
			logo,
			collectionIds: [...new Set(/** @type {string[]} */ (collectionIds))],
			visible,
			position,
		},
	};
};

/**
 * Whether a brand may be set on an item in these collections (scoping).
 * @param {Pick<Brand, 'collectionIds'>} brand
 * @param {readonly string[]} itemCollectionIds
 * @param {ReadonlyArray<{ id: string, ancestors: string[] }>} collections every collection (for sub-collections)
 */
export const brandAllowed = (brand, itemCollectionIds, collections) => {
	if (brand.collectionIds.length === 0) return true;
	return itemCollectionIds.some((id) => {
		if (brand.collectionIds.includes(id)) return true;
		const ancestors = collections.find((c) => c.id === id)?.ancestors ?? [];
		return ancestors.some((a) => brand.collectionIds.includes(a));
	});
};
