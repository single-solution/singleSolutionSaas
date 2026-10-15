/**
 * Page types (pure, C6): the merchant's own kinds of pages, `{ key, name, path, nudge }`, kept as the list
 * `page_types` (seeded with product, category, deals and cart pages). A page gets its type from `SSChat.setPage({ kind
 * })` (or `page.kind` on the visitor API) when the key is one of the website's types, else from the first type whose
 * path pattern matches the page's path (`*` = one segment, `**` = any), else `other`. The type picks the idle nudge's
 * text and tells the AI what the visitor is looking at.
 * @module
 */
import { pathMatches } from './text.js';

/** The type of a page that matches none of the merchant's types. */
export const OTHER_PAGE = 'other';

/** A page type key: lower-case letters, digits, `-` or `_`, starting with a letter. */
export const PAGE_TYPE_KEY = /^[a-z][a-z0-9_-]{0,39}$/;

/** Most page types, and the longest name, path pattern and nudge. */
export const PAGE_TYPE_LIMITS = Object.freeze({ types: 30, name: 60, path: 200, nudge: 300 });

/** @typedef {{ key: string, name: string, path: string, nudge: string }} PageType */

/**
 * What a website starts with: the four kinds of shop pages, no path patterns (pages name their kind with setPage) and
 * no own nudge (the general nudge text).
 * @type {readonly PageType[]}
 */
export const PAGE_TYPE_SEED = Object.freeze([
	Object.freeze({ key: 'product', name: 'Product page', path: '', nudge: '' }),
	Object.freeze({ key: 'category', name: 'Category page', path: '', nudge: '' }),
	Object.freeze({ key: 'deals', name: 'Deals page', path: '', nudge: '' }),
	Object.freeze({ key: 'cart', name: 'Cart', path: '', nudge: '' }),
]);

/** @param {unknown} value */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Check the page types a merchant saves: unique keys (not `other`), a name, an optional path pattern from `/` and an
 * optional nudge text (`{product}` = the product the page names).
 * @param {unknown} items
 * @returns {{ ok: true, value: PageType[] } | { ok: false, errors: string[] }}
 */
export const checkPageTypes = (items) => {
	if (!Array.isArray(items) || items.length > PAGE_TYPE_LIMITS.types)
		return { ok: false, errors: [`Up to ${PAGE_TYPE_LIMITS.types} page types.`] };
	/** @type {string[]} */
	const errors = [];
	/** @type {PageType[]} */
	const value = [];
	const keys = new Set();
	items.forEach((item, index) => {
		const at = `Page type ${index + 1}`;
		const entry = isObject(item) ? /** @type {Record<string, unknown>} */ (item) : {};
		const key = typeof entry.key === 'string' ? entry.key : '';
		const name = typeof entry.name === 'string' ? entry.name.trim() : '';
		const path = typeof entry.path === 'string' ? entry.path.trim() : entry.path === undefined ? '' : null;
		const nudge = typeof entry.nudge === 'string' ? entry.nudge.trim() : entry.nudge === undefined ? '' : null;
		if (!PAGE_TYPE_KEY.test(key) || key === OTHER_PAGE || keys.has(key))
			return void errors.push(`${at}: a unique key (lower-case letters, digits, - or _; not ${OTHER_PAGE}).`);
		if (name.length === 0 || name.length > PAGE_TYPE_LIMITS.name)
			return void errors.push(`${at}: a name of up to ${PAGE_TYPE_LIMITS.name} characters.`);
		if (path === null || (path !== '' && !path.startsWith('/')) || path.length > PAGE_TYPE_LIMITS.path)
			return void errors.push(`${at}: a path pattern from / (up to ${PAGE_TYPE_LIMITS.path} characters), or none.`);
		if (nudge === null || nudge.length > PAGE_TYPE_LIMITS.nudge)
			return void errors.push(`${at}: a nudge of up to ${PAGE_TYPE_LIMITS.nudge} characters, or none.`);
		keys.add(key);
		value.push({ key, name, path, nudge });
	});
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
};

/**
 * The type of a page: the kind the page named when it is one of the types, else the first type whose path pattern
 * matches the path, else `other`.
 * @param {readonly { key: string, path: string }[]} types
 * @param {unknown} kind what setPage (or the visitor API's `page.kind`) named
 * @param {string} path the page's path (`/products/lamp`)
 * @returns {string}
 */
export const pageTypeOf = (types, kind, path) => {
	if (typeof kind === 'string' && kind !== OTHER_PAGE && types.some((type) => type.key === kind)) return kind;
	return types.find((type) => type.path !== '' && pathMatches(type.path, path))?.key ?? OTHER_PAGE;
};
