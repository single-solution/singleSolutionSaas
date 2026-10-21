/**
 * The parts of a website's own address (both consoles), each its own address segment after the website:
 * `` (the page) · `products/:productId` · `install` · `usage` · `changes` open the ONE page at their section (flat
 * layout 2026-10-21); `settings/:section` and `setup` are pages of their own.
 * Plain module (no `'use client'`): the server views and the loaders read it too.
 * @module
 */

/** The sub-pages of Website settings, in the order of the inner navigation. */
export const SETTINGS_SECTIONS = /** @type {const} */ (['business', 'brand', 'region', 'pages', 'team', 'connections', 'links']);

/** The parts that are one page each, without a deeper level. */
const SINGLE = /** @type {const} */ (['install', 'setup', 'usage', 'changes']);

/**
 * The part of the address: the segments after the website joined by `/`.
 * @param {string | undefined} part
 * @param {string | undefined} [sub]
 */
export const websitePartOf = (part, sub) => [part, sub].filter(Boolean).join('/');

/**
 * What a part of the address shows, or null when there is no such page. A bare `settings` shows the first section.
 * @param {string} path the part, as `websitePartOf` gives it
 * @returns {{ kind: 'overview' | 'install' | 'setup' | 'usage' | 'changes' } | { kind: 'product', id: string } |
 *   { kind: 'settings', section: string } | null}
 */
export const parseWebsitePart = (path) => {
	if (path === '') return { kind: 'overview' };
	const [head = '', ...rest] = path.split('/');
	const tail = rest.join('/');
	if (head === 'products') return tail && !tail.includes('/') ? { kind: 'product', id: tail } : null;
	if (head === 'settings') {
		if (!tail) return { kind: 'settings', section: SETTINGS_SECTIONS[0] };
		return /** @type {readonly string[]} */ (SETTINGS_SECTIONS).includes(tail) ? { kind: 'settings', section: tail } : null;
	}
	const single = SINGLE.find((kind) => kind === head);
	return single && !tail ? { kind: single } : null;
};

/**
 * The element of the website page an address opens it at: a section (`status`, `products`, `activity`, `usage`) or one
 * product's card; null for the top of the page and for the pages of their own (settings, setup).
 * @param {ReturnType<typeof parseWebsitePart>} parsed
 * @returns {string | null}
 */
export const sectionOf = (parsed) => {
	if (parsed === null) return null;
	if (parsed.kind === 'product') return `product-${parsed.id}`;
	if (parsed.kind === 'install') return 'products';
	if (parsed.kind === 'usage') return 'usage';
	if (parsed.kind === 'changes') return 'activity';
	return null;
};
