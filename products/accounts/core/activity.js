/**
 * Activity-log entries of Accounts (PLAN 0.4.11, 0.8.10 K9), pure: the label and detail of its own entries (never
 * addresses, secrets or message contents).
 * @module
 */

/**
 * The plain-text detail of an entry; undefined when empty (the kit's activity log cuts it to its longest length).
 * @param {ReadonlyArray<string | null | undefined | false>} parts joined with '; '
 * @returns {string | undefined}
 */
export const detailOf = (parts) => {
	const text = parts.filter((part) => typeof part === 'string' && part.trim() !== '').join('; ');
	return text === '' ? undefined : text;
};

/**
 * The label of an entry (a user's name, a role's name …); undefined when empty (the kit's activity log cuts it to its
 * longest length).
 * @param {unknown} value
 * @returns {string | undefined}
 */
export const labelOf = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);
