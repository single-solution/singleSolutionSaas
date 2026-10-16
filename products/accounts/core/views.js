/**
 * The users list's saved views (A5), pure: a staff member names a set of the list's filters (for example "VIP
 * customers": tags VIP, role customer) and opens it again in one click; the merchant's views, in their order.
 * @module
 */

/** Most saved views a website keeps. */
export const MAX_VIEWS = 50;
/** The users list's filters a view may keep (the query parameters of `GET /v1/users`). */
const VIEW_FILTERS = Object.freeze([
	'q',
	'role',
	'roles',
	'permission',
	'status',
	'blocked',
	'deletion',
	'phone',
	'phoneDigits',
	'consent',
	'tags',
	'createdAfter',
]);
const KEY = /^[a-z][a-z0-9_]{0,39}$/;

/** @typedef {{ key: string, name: string, query: Record<string, string> }} SavedView */

/**
 * Check a view as staff save it (the key comes from the path): a name and the list's filters, each as text.
 * @param {string} key @param {unknown} input
 * @returns {{ ok: true, value: SavedView } | { ok: false, field: string, message: string }}
 */
export const checkView = (key, input) => {
	const body = typeof input === 'object' && input !== null ? /** @type {Record<string, unknown>} */ (input) : {};
	if (!KEY.test(key)) return { ok: false, field: 'key', message: 'Use 1–40 lower-case letters, digits or _.' };
	const name = typeof body.name === 'string' ? body.name.trim() : '';
	if (name === '' || name.length > 80 || [...name].some((ch) => ch.charCodeAt(0) < 32))
		return { ok: false, field: 'name', message: 'Name the view (at most 80 characters on one line).' };
	const query = body.query ?? {};
	if (typeof query !== 'object' || query === null || Array.isArray(query))
		return { ok: false, field: 'query', message: 'Send the filters as { name: value }.' };
	/** @type {Record<string, string>} */
	const out = {};
	for (const [filter, value] of Object.entries(query)) {
		if (!VIEW_FILTERS.includes(filter))
			return {
				ok: false,
				field: `query/${filter}`,
				message: `A view keeps only the list's filters: ${VIEW_FILTERS.join(', ')}.`,
			};
		if (typeof value !== 'string' || value.length > 200)
			return { ok: false, field: `query/${filter}`, message: 'Each filter is text of at most 200 characters.' };
		if (value.trim() !== '') out[filter] = value.trim();
	}
	return { ok: true, value: { key, name, query: out } };
};
