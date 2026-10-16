/**
 * The merchant's named lists (fixed-choices E17–E20, E40): every list a merchant adds to, renames, reorders and removes
 * from has entries with a key (stored on records: lowercase letters, digits, `_` and `-`, starting with a letter) and
 * a name people read. This part checks that shape once for every such list; each list adds its own fields. No I/O.
 * @module
 */

/** A list entry's key. */
export const LIST_KEY = /^[a-z][a-z0-9_-]{0,39}$/;
/** The longest name of an entry. */
export const MAX_ENTRY_LABEL = 60;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/;

/** @typedef {{ path: string, message: string }} ListError */
/** @typedef {{ ok: true, value: any[] } | { ok: false, errors: ListError[] }} NamedListCheck */

/**
 * Check a list of named entries: a list of at most `max` objects, each with a key (once) and a name of 1 to `label`
 * characters; `fields` reads the entry's own fields (its errors under the entry's path).
 * @param {unknown} value
 * @param {{ max: number, what: string, label?: number, reserved?: readonly string[],
 *   fields?: (entry: Record<string, unknown>, fail: (field: string, message: string) => void) => Record<string, unknown> }} rules
 * @returns {NamedListCheck}
 */
export const checkNamedList = (value, { max, what, label = MAX_ENTRY_LABEL, reserved = [], fields }) => {
	if (!Array.isArray(value)) return { ok: false, errors: [{ path: '/value', message: 'A list is expected.' }] };
	if (value.length > max) return { ok: false, errors: [{ path: '/value', message: `At most ${max} ${what}.` }] };
	/** @type {ListError[]} */
	const errors = [];
	/** @type {Array<Record<string, unknown> & { key: string, label: string }>} */
	const out = [];
	value.forEach((raw, index) => {
		const path = `/value/${index}`;
		const entry = typeof raw === 'object' && raw !== null ? /** @type {Record<string, unknown>} */ (raw) : {};
		const key = typeof entry.key === 'string' ? entry.key.trim() : '';
		const name = typeof entry.label === 'string' ? entry.label.trim() : '';
		if (!LIST_KEY.test(key))
			errors.push({ path: `${path}/key`, message: 'A key is lowercase letters, digits, _ and - (starting with a letter).' });
		else if (reserved.includes(key)) errors.push({ path: `${path}/key`, message: `${key} is a fixed key.` });
		else if (out.some((item) => item.key === key))
			errors.push({ path: `${path}/key`, message: `The key ${key} is used twice.` });
		if (!name || name.length > label || CONTROL.test(name))
			errors.push({ path: `${path}/label`, message: `Give a name of 1 to ${label} characters.` });
		const own = fields ? fields(entry, (field, message) => errors.push({ path: `${path}/${field}`, message })) : {};
		out.push({ key, label: name, ...own });
	});
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out };
};

/**
 * The name of a key in a list, else the key itself (an entry removed since).
 * @param {ReadonlyArray<{ key: string, label: string }>} list
 * @param {unknown} key
 */
export const labelIn = (list, key) => list.find((entry) => entry.key === key)?.label ?? String(key ?? '');

/**
 * A boolean field (default when absent).
 * @param {Record<string, unknown>} entry @param {string} field @param {boolean} fallback
 * @param {(field: string, message: string) => void} fail
 */
export const boolField = (entry, field, fallback, fail) => {
	if (entry[field] === undefined || entry[field] === null) return fallback;
	if (typeof entry[field] !== 'boolean') fail(field, `${field} is true or false.`);
	return entry[field] === true;
};

/**
 * One value of a fixed set (default when absent).
 * @template {string} V
 * @param {Record<string, unknown>} entry @param {string} field @param {readonly V[]} values @param {V} fallback
 * @param {(field: string, message: string) => void} fail
 * @returns {V}
 */
export const oneOf = (entry, field, values, fallback, fail) => {
	if (entry[field] === undefined || entry[field] === null) return fallback;
	if (!values.includes(/** @type {V} */ (entry[field]))) fail(field, `${field} is ${values.join(', ')}.`);
	return /** @type {V} */ (entry[field]);
};
