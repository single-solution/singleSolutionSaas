/**
 * Merchant search keys (pure). `nameKey` is the normalised merchant name stored next to `name` so a case- and
 * accent-insensitive **prefix** search is an anchored, index-backed range scan (`{ nameKey: 1 }`); e-mail search
 * uses the lower-cased, uniquely indexed user e-mail the same way.
 * @module
 */

/**
 * Normalised name: Unicode NFKD without combining marks, lower case, single spaces, trimmed, ≤ 120 chars.
 * @param {unknown} name
 * @returns {string}
 */
export const nameKey = (name) =>
	String(name ?? '')
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 120);

/**
 * Anchored prefix regex source for a literal prefix (every regex metacharacter escaped).
 * @param {string} prefix
 * @returns {string}
 */
export const prefixPattern = (prefix) => `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;

/**
 * A search query from `?q=`: `{ kind: 'email', prefix }` when it contains `@`, else `{ kind: 'name', prefix }`;
 * null for empty or over-long input.
 * @param {unknown} q
 * @returns {{ kind: 'email' | 'name', prefix: string } | null}
 */
export const parseMerchantQuery = (q) => {
	if (typeof q !== 'string') return null;
	const trimmed = q.trim();
	if (trimmed.length === 0 || trimmed.length > 120) return null;
	if (trimmed.includes('@')) return { kind: 'email', prefix: trimmed.toLowerCase() };
	const key = nameKey(trimmed);
	return key ? { kind: 'name', prefix: key } : null;
};
