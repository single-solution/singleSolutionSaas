/**
 * The parts of a website's own address (both consoles), each its own address segment after the website:
 * `` (product rows home) · `products/:productId` (same home, scroll to row) · `install` · `usage` · `changes` ·
 * `settings/:section` · `setup`.
 * Binding plan (PLAN.md): home is front-first; `install` / `usage` / `changes` are legacy peer apps to collapse
 * (redirect), not the target IA. `settings` and `setup` stay addressable because they are long / focused.
 * Plain module (no `'use client'`): the server views and the loaders read it too.
 * @module
 */

/** The sub-pages of Website settings, in the order of the inner navigation. */
export const SETTINGS_SECTIONS = /** @type {const} */ (['business', 'brand', 'region', 'pages', 'team', 'connections', 'links']);

/** The parts that are legacy peer apps to redirect to website home (PLAN §1, §10 A1). */
export const LEGACY_PEER_REDIRECTS = /** @type {const} */ (['install', 'usage', 'changes']);

/** The parts that are one page each, without a deeper level. */
const SINGLE = /** @type {const} */ (['setup']);

/**
 * The part of the address: the segments after the website joined by `/`.
 * @param {string | undefined} part
 * @param {string | undefined} [sub]
 */
export const websitePartOf = (part, sub) => [part, sub].filter(Boolean).join('/');

/**
 * What a part of the address shows, or null when there is no such page. A bare `settings` shows the first section.
 * Legacy peer apps (install, usage, changes) return redirect to home.
 * @param {string} path the part, as `websitePartOf` gives it
 * @returns {{ kind: 'overview' | 'setup' } | { kind: 'redirect', to: string } | { kind: 'product', id: string } |
 *   { kind: 'settings', section: string } | null}
 */
export const parseWebsitePart = (path) => {
	if (path === '') return { kind: 'overview' };
	const [head = '', ...rest] = path.split('/');
	const tail = rest.join('/');
	if (LEGACY_PEER_REDIRECTS.includes(/** @type {any} */ (head))) return { kind: 'redirect', to: '' };
	if (head === 'products') return tail && !tail.includes('/') ? { kind: 'product', id: tail } : null;
	if (head === 'settings') {
		if (!tail) return { kind: 'settings', section: SETTINGS_SECTIONS[0] };
		return /** @type {readonly string[]} */ (SETTINGS_SECTIONS).includes(tail) ? { kind: 'settings', section: tail } : null;
	}
	const single = SINGLE.find((kind) => kind === head);
	return single && !tail ? { kind: single } : null;
};

/**
 * Scroll target on the product-rows home for a deep link; null for pages of their own.
 * @param {ReturnType<typeof parseWebsitePart>} parsed
 * @returns {string | null}
 */
export const sectionOf = (parsed) => {
	if (parsed === null) return null;
	if (parsed.kind === 'product') return `product-${parsed.id}`;
	return null;
};
