/**
 * Activity-log entries of Accounts (PLAN 0.4.11, 0.8.10 K9), pure: the label and the values of its own entries (never
 * addresses, secrets or message contents). What changed is kept as values (A8): codes, numbers and yes/no that texts
 * put into words, never a sentence in one language.
 * @module
 */

/** Longest text value of an entry (the activity copy shape). */
const MAX_VALUE = 200;

/**
 * The values of an entry: empty ones (undefined, null, '') left out, text cut to its longest length.
 * @param {Record<string, string | number | boolean | null | undefined>} values
 * @returns {Record<string, string | number | boolean>}
 */
export const valuesOf = (values) =>
	Object.fromEntries(
		Object.entries(values)
			.filter(([, value]) => value !== undefined && value !== null && value !== '')
			.map(([key, value]) => [
				key,
				typeof value === 'string' ? value.slice(0, MAX_VALUE) : /** @type {number | boolean} */ (value),
			]),
	);

/**
 * The label of an entry (a user's name, a role's name …); undefined when empty (the kit's activity log cuts it to its
 * longest length).
 * @param {unknown} value
 * @returns {string | undefined}
 */
export const labelOf = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);
