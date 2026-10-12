/**
 * Role pricing (PLAN 0.8.10 E19): the `role_prices` list — Accounts roles whose signed-in shoppers get a percent (0–90)
 * off the goods after offers and before delivery, with the label quotes, orders and invoices show. One entry per role.
 * The arithmetic is in `core/checkout.js` (`roleDiscountOf`). No I/O.
 * @module
 */

/** At most this many role prices. */
const MAX_ROLE_PRICES = 20;
/** An Accounts role key. */
const ROLE = /^[A-Za-z0-9_.:-]{1,40}$/;

/** @typedef {{ role: string, percent: number, label: string }} RolePrice */

/**
 * Check the list the merchant saves.
 * @param {unknown} value
 * @returns {{ ok: true, value: RolePrice[] } | { ok: false, errors: string[] }}
 */
export const checkRolePrices = (value) => {
	if (!Array.isArray(value)) return { ok: false, errors: ['Role prices are a list.'] };
	/** @type {string[]} */
	const errors = [];
	if (value.length > MAX_ROLE_PRICES) errors.push(`At most ${MAX_ROLE_PRICES} role prices.`);
	/** @type {RolePrice[]} */
	const out = [];
	for (const [index, raw] of value.entries()) {
		const entry = typeof raw === 'object' && raw !== null ? /** @type {Record<string, unknown>} */ (raw) : {};
		const role = typeof entry.role === 'string' ? entry.role.trim() : '';
		const label = typeof entry.label === 'string' ? entry.label.trim() : '';
		const percent = entry.percent;
		if (!ROLE.test(role)) errors.push(`Entry ${index + 1}: role is an Accounts role key (1–40 characters).`);
		else if (out.some((other) => other.role === role)) errors.push(`Role '${role}' is listed twice.`);
		if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 90)
			errors.push(`Entry ${index + 1}: percent is from 0 to 90.`);
		if (label.length > 60) errors.push(`Entry ${index + 1}: the label has at most 60 characters.`);
		out.push({ role, percent: Number(percent), label: label || 'Member discount' });
	}
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out };
};
