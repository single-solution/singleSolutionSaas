/**
 * Condition grades (PLAN 0.8.8 Items: used or refurbished items carry a condition grade): the `grades` list the merchant
 * keeps in the dashboard — a stable key, a label shown to shoppers, a description, and the item's return and warranty
 * days for that grade (null = the `returns` setting). Variants name a grade by its key. No I/O.
 * @module
 */

/** At most this many grades. */
export const MAX_GRADES = 20;

/** Grade keys. */
const KEY = /^[a-z][a-z0-9_]{0,39}$/;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/;

/**
 * @typedef {{ key: string, label: string, description: string, returnDays: number | null, warrantyDays: number | null }} Grade
 */

/** @param {unknown} value */
const isDays = (value) => value === null || (Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 3650);

/**
 * Check the list the merchant saves.
 * @param {unknown} value
 * @returns {{ ok: true, value: Grade[] } | { ok: false, errors: string[] }}
 */
export const checkGrades = (value) => {
	if (!Array.isArray(value)) return { ok: false, errors: ['A list is expected.'] };
	if (value.length > MAX_GRADES) return { ok: false, errors: [`At most ${MAX_GRADES} grades.`] };
	/** @type {string[]} */
	const errors = [];
	/** @type {Grade[]} */
	const out = [];
	value.forEach((entry, index) => {
		const n = index + 1;
		if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
			return void errors.push(`Grade ${n}: an object is expected.`);
		const key = typeof entry.key === 'string' ? entry.key.trim() : '';
		if (!KEY.test(key)) errors.push(`Grade ${n}: the key is lowercase letters, digits and _ (starting with a letter).`);
		else if (out.some((grade) => grade.key === key)) errors.push(`Grade ${n}: the key ${key} is used twice.`);
		const label = typeof entry.label === 'string' ? entry.label.trim() : '';
		if (!label || label.length > 60 || CONTROL.test(label)) errors.push(`Grade ${n}: give a label of 1 to 60 characters.`);
		const description = entry.description === undefined ? '' : entry.description;
		if (typeof description !== 'string' || description.length > 500)
			errors.push(`Grade ${n}: the description has at most 500 characters.`);
		const returnDays = entry.returnDays ?? null;
		const warrantyDays = entry.warrantyDays ?? null;
		if (!isDays(returnDays)) errors.push(`Grade ${n}: return days are whole days from 0 to 3650, or empty.`);
		if (!isDays(warrantyDays)) errors.push(`Grade ${n}: warranty days are whole days from 0 to 3650, or empty.`);
		out.push({
			key,
			label,
			description: typeof description === 'string' ? description.trim() : '',
			returnDays: /** @type {number | null} */ (returnDays),
			warrantyDays: /** @type {number | null} */ (warrantyDays),
		});
	});
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out };
};

/**
 * The grades by key (anything malformed in a saved list is skipped).
 * @param {unknown} list
 * @returns {Map<string, Grade>}
 */
export const gradesByKey = (list) => {
	/** @type {Map<string, Grade>} */
	const out = new Map();
	for (const entry of Array.isArray(list) ? list : [])
		if (entry && typeof entry.key === 'string' && typeof entry.label === 'string') out.set(entry.key, entry);
	return out;
};
