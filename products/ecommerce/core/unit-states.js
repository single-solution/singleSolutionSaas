/**
 * Unit states (E38; feature `grades_serials`): what a numbered unit is doing. `in_stock` (for sale) and `sold` (with
 * its order) are fixed: stock counts and orders rely on them. Every other state is the merchant's own, kept as the
 * `unit_states` list (`{ key, label }`, at most 20; seeded: faulty): reserved, demo, in repair, on loan … A unit in such
 * a state is not for sale; staff move it back in stock. No I/O.
 * @module
 */

/** The states code relies on. */
export const FIXED_UNIT_STATES = Object.freeze(/** @type {const} */ (['in_stock', 'sold']));
/** The list before the merchant saves it. */
export const DEFAULT_UNIT_STATES = Object.freeze([Object.freeze({ key: 'faulty', label: 'Faulty' })]);
/** At most this many states, and characters in a label. */
export const UNIT_STATE_LIMITS = Object.freeze({ states: 20, label: 40 });

/** @typedef {{ key: string, label: string }} UnitState */

const KEY = /^[a-z][a-z0-9_-]{0,39}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/;

/**
 * Check the `unit_states` list: each state a key (lowercase letters, digits, _ and -, starting with a letter; not
 * in_stock or sold; each once) and a label of 1 to 40 characters.
 * @param {unknown} value
 * @returns {{ ok: true, value: UnitState[] } | { ok: false, errors: Array<{ path: string, message: string }> }}
 */
export const checkUnitStates = (value) => {
	if (!Array.isArray(value)) return { ok: false, errors: [{ path: '/value', message: 'A list is expected.' }] };
	if (value.length > UNIT_STATE_LIMITS.states)
		return { ok: false, errors: [{ path: '/value', message: `At most ${UNIT_STATE_LIMITS.states} unit states.` }] };
	/** @type {Array<{ path: string, message: string }>} */
	const errors = [];
	/** @type {UnitState[]} */
	const out = [];
	value.forEach((entry, index) => {
		const path = `/value/${index}`;
		const key = typeof entry?.key === 'string' ? entry.key.trim() : '';
		const label = typeof entry?.label === 'string' ? entry.label.trim() : '';
		if (!KEY.test(key))
			errors.push({ path: `${path}/key`, message: 'A key is lowercase letters, digits, _ and - (starting with a letter).' });
		else if (FIXED_UNIT_STATES.includes(/** @type {any} */ (key)))
			errors.push({ path: `${path}/key`, message: `${key} is a fixed state.` });
		else if (out.some((state) => state.key === key))
			errors.push({ path: `${path}/key`, message: `The key ${key} is used twice.` });
		if (!label || label.length > UNIT_STATE_LIMITS.label || CONTROL.test(label))
			errors.push({ path: `${path}/label`, message: `Give a label of 1 to ${UNIT_STATE_LIMITS.label} characters.` });
		out.push({ key, label });
	});
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out };
};

/**
 * A status staff may give a unit: back in stock, or one of the merchant's states; null otherwise (sold changes only
 * with an order or a return).
 * @param {unknown} status
 * @param {ReadonlyArray<UnitState>} states
 * @returns {string | null}
 */
export const unitStatusOf = (status, states) =>
	status === 'in_stock' || states.some((state) => state.key === status) ? /** @type {string} */ (status) : null;
