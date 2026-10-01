/**
 * URL sync (pure): a selection ↔ URL query parameters, so shared links, bookmarks and the back button land on the same
 * configuration — the PDP's "query params are the source of truth", generalised. Parameter names are the group keys
 * (or merchant-chosen names) with an optional prefix; multi-choice values are joined with the separator (repeated
 * parameters when an option key contains it); defaults can be left out; other query parameters are preserved.
 * @module
 */

/** Longest query string read. */
export const MAX_SEARCH = 4096;

/**
 * @typedef {object} UrlOptions
 * @property {string} prefix
 * @property {Record<string, string>} names group key → parameter name
 * @property {string} separator
 * @property {boolean} omitDefaults
 * @property {'base' | 'selection'} canonical
 * @property {'replace' | 'push'} history
 */
/** @typedef {{ key: string, type: string, default: unknown, options: ReadonlyArray<{ key: string }> }} UrlGroup */

/**
 * URL options from the `url_sync` feature values.
 * @param {Record<string, any>} config
 * @returns {UrlOptions}
 */
export const urlOptionsFrom = (config) => ({
	prefix: typeof config.param_prefix === 'string' ? config.param_prefix : '',
	names: Object.fromEntries(
		(Array.isArray(config.param_names) ? config.param_names : [])
			.filter((entry) => typeof entry === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}=[A-Za-z0-9_.-]{1,64}$/.test(entry))
			.map((entry) => /** @type {[string, string]} */ (entry.split('=', 2))),
	),
	separator: typeof config.multi_separator === 'string' && config.multi_separator.length === 1 ? config.multi_separator : ',',
	omitDefaults: config.omit_defaults !== false,
	canonical: config.canonical === 'selection' ? 'selection' : 'base',
	history: config.history === 'push' ? 'push' : 'replace',
});

/**
 * @param {string} groupKey
 * @param {UrlOptions} options
 */
export const paramOf = (groupKey, options) => `${options.prefix}${options.names[groupKey] ?? groupKey}`;

/** @param {unknown} a @param {unknown} b */
const same = (a, b) => (Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((v, i) => v === b[i]) : a === b);

/**
 * Query parameters of a selection, in group order (empty groups left out).
 * @param {ReadonlyArray<UrlGroup>} groups
 * @param {Record<string, unknown>} selection
 * @param {UrlOptions} options
 * @returns {Array<[string, string]>}
 */
export const encodeSelection = (groups, selection, options) => {
	/** @type {Array<[string, string]>} */
	const out = [];
	for (const group of groups) {
		const value = selection[group.key];
		if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) continue;
		if (options.omitDefaults && group.default !== null && same(value, group.default)) continue;
		const name = paramOf(group.key, options);
		if (Array.isArray(value)) {
			const keys = value.map(String);
			if (keys.some((key) => key.includes(options.separator))) for (const key of keys) out.push([name, key]);
			else out.push([name, keys.join(options.separator)]);
		} else out.push([name, String(value)]);
	}
	return out;
};

/**
 * Parse a query string (`?a=b&c=d` or `a=b`), capped.
 * @param {string} search
 */
const paramsOf = (search) =>
	new URLSearchParams(
		String(search ?? '')
			.slice(0, MAX_SEARCH)
			.replace(/^\?/, ''),
	);

/**
 * The selection encoded in a query string (raw values: the resolver validates them).
 * @param {ReadonlyArray<UrlGroup>} groups
 * @param {string} search
 * @param {UrlOptions} options
 * @returns {Record<string, unknown>}
 */
export const decodeSelection = (groups, search, options) => {
	const params = paramsOf(search);
	/** @type {Record<string, unknown>} */
	const selection = {};
	for (const group of groups) {
		const values = params.getAll(paramOf(group.key, options)).filter((value) => value !== '');
		if (values.length === 0) continue;
		if (group.type === 'multi') {
			const known = new Set(group.options.map((option) => option.key));
			selection[group.key] = values.flatMap((value) => (known.has(value) ? [value] : value.split(options.separator)));
		} else if (group.type === 'range') {
			const value = /** @type {string} */ (values[0]);
			selection[group.key] = /^-?\d+(?:\.\d+)?$/.test(value) ? Number(value) : value;
		} else selection[group.key] = values[0];
	}
	return selection;
};

/**
 * A query string with the selection's parameters replacing the configurator's (other parameters kept in place).
 * @param {string} search
 * @param {ReadonlyArray<UrlGroup>} groups
 * @param {Record<string, unknown>} selection
 * @param {UrlOptions} options
 * @returns {string} `?…` or ''
 */
export const mergeSearch = (search, groups, selection, options) => {
	const own = new Set(groups.map((group) => paramOf(group.key, options)));
	const kept = [...paramsOf(search).entries()].filter(([name]) => !own.has(name));
	const text = new URLSearchParams([...kept, ...encodeSelection(groups, selection, options)]).toString();
	return text ? `?${text}` : '';
};

/**
 * The canonical query string: '' (`base`) or only the selection's parameters in group order (`selection`).
 * @param {ReadonlyArray<UrlGroup>} groups
 * @param {Record<string, unknown>} selection
 * @param {UrlOptions} options
 */
export const canonicalSearch = (groups, selection, options) => {
	if (options.canonical === 'base') return '';
	const text = new URLSearchParams(encodeSelection(groups, selection, { ...options, omitDefaults: true })).toString();
	return text ? `?${text}` : '';
};
