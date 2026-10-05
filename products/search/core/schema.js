/**
 * Document types and documents (pure). A website defines its own document types in `index.document_types`: per type
 * the fields it holds and, per field, whether it is searchable, matches as you type (prefix), is returned to browsers
 * (display) or is private (server keys only: never matched, suggested or returned for a `pk_` key). Nothing about a
 * kind of website is assumed: a type may be a product, an article, a doc page, a listing or anything else.
 * @module
 */

/** Document id: opaque, URL-safe, ≤ 128 characters. */
export const ID = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/;
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const CURRENCY = /^[A-Z]{3}$/;
/** Values one list field keeps. */
export const MAX_LIST = 100;

/**
 * @typedef {object} FieldDef
 * @property {string} key
 * @property {boolean} searchable
 * @property {boolean} prefix
 * @property {boolean} display
 * @property {boolean} private
 */
/**
 * @typedef {object} TypeDef
 * @property {string} key
 * @property {string} label
 * @property {string} titleField
 * @property {string} descriptionField
 * @property {FieldDef[]} fields
 */
/**
 * @typedef {string | number | boolean | Array<string | number | boolean>} FieldValue
 */
/**
 * @typedef {object} DocumentInput a validated document as the index stores it (before analysis)
 * @property {string} id
 * @property {string} type
 * @property {string | null} url
 * @property {string | null} image
 * @property {number | null} price minor units
 * @property {string | null} currency
 * @property {number} boost
 * @property {Record<string, FieldValue>} fields declared fields of the type only
 */

/** @param {unknown} value @returns {value is Record<string, any>} */
export const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Document types from the index configuration (invalid entries dropped, first definition of a key wins).
 * @param {unknown} config `index.document_types`
 * @returns {Map<string, TypeDef>}
 */
export const typesOf = (config) => {
	/** @type {Map<string, TypeDef>} */
	const out = new Map();
	for (const raw of Array.isArray(config) ? config : []) {
		if (!isObject(raw) || typeof raw.key !== 'string' || !KEY.test(raw.key) || out.has(raw.key)) continue;
		/** @type {Map<string, FieldDef>} */
		const fields = new Map();
		for (const field of Array.isArray(raw.fields) ? raw.fields : []) {
			if (!isObject(field) || typeof field.key !== 'string' || !KEY.test(field.key) || fields.has(field.key)) continue;
			const isPrivate = field.private === true;
			fields.set(field.key, {
				key: field.key,
				searchable: field.searchable !== false,
				prefix: field.prefix === true,
				display: field.display === true && !isPrivate,
				private: isPrivate,
			});
		}
		const pick = (/** @type {unknown} */ name, /** @type {string} */ fallback) =>
			typeof name === 'string' && KEY.test(name) ? name : fallback;
		out.set(raw.key, {
			key: raw.key,
			label: typeof raw.label === 'string' && raw.label.length > 0 ? raw.label.slice(0, 80) : raw.key,
			titleField: pick(raw.title_field, 'title'),
			descriptionField: pick(raw.description_field, 'description'),
			fields: [...fields.values()],
		});
	}
	return out;
};

/**
 * A link: an https URL or a site-relative path (never `//host`, never another scheme).
 * @param {unknown} value
 * @returns {string | null | undefined} undefined when invalid, null when absent
 */
export const linkOf = (value) => {
	if (value === null || value === undefined || value === '') return null;
	if (typeof value !== 'string' || value.length > 2000 || /[\s\\]/.test(value)) return undefined;
	if (value.startsWith('/') && !value.startsWith('//')) return value;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && url.username === '' && url.password === '' ? url.href : undefined;
	} catch {
		return undefined;
	}
};

/**
 * A field value as stored: strings (cut), finite numbers, booleans, lists of those, or a flat object of those (an
 * attribute map, stored as `key value` strings).
 * @param {unknown} value
 * @param {number} maxChars
 * @returns {FieldValue | undefined}
 */
export const fieldValueOf = (value, maxChars) => {
	const scalar = (/** @type {unknown} */ v) => {
		if (typeof v === 'string') return v.slice(0, maxChars);
		if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
		if (typeof v === 'boolean') return v;
		return undefined;
	};
	if (Array.isArray(value)) {
		const list = value
			.slice(0, MAX_LIST)
			.map(scalar)
			.filter((v) => v !== undefined);
		return /** @type {Array<string | number | boolean>} */ (list);
	}
	if (isObject(value)) {
		/** @type {string[]} */
		const list = [];
		for (const [key, inner] of Object.entries(value).slice(0, MAX_LIST)) {
			for (const v of Array.isArray(inner) ? inner.slice(0, 20) : [inner]) {
				const s = scalar(v);
				if (s !== undefined) list.push(`${key.slice(0, 64)} ${String(s)}`.slice(0, maxChars));
			}
		}
		return list.slice(0, MAX_LIST);
	}
	return scalar(value);
};

/**
 * @typedef {{ path: string, code: string }} FieldProblem
 */

/**
 * Validate a document from any source.
 * @param {unknown} input `{ id, type, url?, image?, price?, currency?, boost?, fields: {} }`
 * @param {{ types: Map<string, TypeDef>, maxFieldChars: number, newId?: () => string }} context
 * @returns {{ ok: true, value: DocumentInput, ignored: string[] } | { ok: false, errors: FieldProblem[] }}
 */
export const validateDocument = (input, { types, maxFieldChars, newId }) => {
	/** @type {FieldProblem[]} */
	const errors = [];
	if (!isObject(input)) return { ok: false, errors: [{ path: '', code: 'object_required' }] };
	const id = input.id === undefined && newId ? newId() : input.id;
	if (typeof id !== 'string' || !ID.test(id)) errors.push({ path: '/id', code: 'id_invalid' });
	const type = typeof input.type === 'string' ? types.get(input.type) : undefined;
	if (!type) errors.push({ path: '/type', code: 'type_unknown' });
	const url = linkOf(input.url);
	if (url === undefined) errors.push({ path: '/url', code: 'url_invalid' });
	const image = linkOf(input.image);
	if (image === undefined) errors.push({ path: '/image', code: 'url_invalid' });
	const price = input.price ?? null;
	if (price !== null && !(Number.isSafeInteger(price) && price >= 0)) errors.push({ path: '/price', code: 'minor_units' });
	const currency = input.currency ?? null;
	if (currency !== null && !(typeof currency === 'string' && CURRENCY.test(currency)))
		errors.push({ path: '/currency', code: 'currency_invalid' });
	const boost = input.boost ?? 0;
	if (typeof boost !== 'number' || !Number.isFinite(boost) || boost < 0 || boost > 1_000_000)
		errors.push({ path: '/boost', code: 'boost_range' });
	if (input.fields !== undefined && !isObject(input.fields)) errors.push({ path: '/fields', code: 'object_required' });
	if (errors.length > 0 || !type) return { ok: false, errors };
	const raw = isObject(input.fields) ? input.fields : {};
	/** @type {Record<string, FieldValue>} */
	const fields = {};
	const declared = new Set(type.fields.map((field) => field.key));
	for (const field of type.fields) {
		if (!Object.hasOwn(raw, field.key)) continue;
		const value = fieldValueOf(raw[field.key], maxFieldChars);
		if (value === undefined) errors.push({ path: `/fields/${field.key}`, code: 'value_invalid' });
		else fields[field.key] = value;
	}
	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: {
			id: /** @type {string} */ (id),
			type: type.key,
			url: /** @type {string | null} */ (url),
			image: /** @type {string | null} */ (image),
			price: /** @type {number | null} */ (price),
			currency: /** @type {string | null} */ (currency),
			boost,
			fields,
		},
		ignored: Object.keys(raw)
			.filter((key) => !declared.has(key))
			.slice(0, 50),
	};
};

/**
 * Text of a field value (lists joined).
 * @param {FieldValue | undefined} value
 */
export const textOf = (value) => (Array.isArray(value) ? value.map(String).join(' ') : value === undefined ? '' : String(value));

/**
 * A result item: what a key may see of a stored document. Browsers (`pk_`) get the display fields that are not private;
 * servers (`sk_`) get every field.
 * @param {Record<string, any>} doc stored document
 * @param {TypeDef | undefined} type
 * @param {{ owner: boolean }} options
 */
export const hitView = (doc, type, { owner }) => {
	const fields = isObject(doc.fields) ? doc.fields : {};
	const defs = type?.fields ?? [];
	/** @type {Record<string, FieldValue>} */
	const shown = {};
	for (const def of defs)
		if (Object.hasOwn(fields, def.key) && (owner || (def.display && !def.private))) shown[def.key] = fields[def.key];
	const isPublic = (/** @type {string} */ key) => owner || defs.some((def) => def.key === key && !def.private);
	const titleKey = type?.titleField ?? 'title';
	const descriptionKey = type?.descriptionField ?? 'description';
	return {
		id: String(doc.id),
		type: String(doc.type),
		title: isPublic(titleKey) ? textOf(fields[titleKey]).slice(0, 300) : '',
		description: isPublic(descriptionKey) ? textOf(fields[descriptionKey]).slice(0, 500) : '',
		url: typeof doc.url === 'string' ? doc.url : null,
		image: typeof doc.image === 'string' ? doc.image : null,
		price: Number.isSafeInteger(doc.price) ? doc.price : null,
		currency: typeof doc.currency === 'string' ? doc.currency : null,
		fields: shown,
		...(owner
			? {
					boost: typeof doc.boost === 'number' ? doc.boost : 0,
					source: typeof doc.source === 'string' ? doc.source : null,
					updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : (doc.updatedAt ?? null),
				}
			: {}),
	};
};

/** @typedef {ReturnType<typeof hitView>} Hit */

/**
 * Searchable fields a key may match, per document type: browsers never match private fields.
 * @param {Map<string, TypeDef>} types
 * @param {{ owner: boolean, only?: readonly string[] | null }} options `only`: the document types searched (empty = all)
 * @returns {Map<string, Map<string, { prefix: boolean }>>} type key → field key → options
 */
export const matchableFields = (types, { owner, only = null }) => {
	/** @type {Map<string, Map<string, { prefix: boolean }>>} */
	const out = new Map();
	for (const type of types.values()) {
		if (only && only.length > 0 && !only.includes(type.key)) continue;
		/** @type {Map<string, { prefix: boolean }>} */
		const fields = new Map();
		for (const field of type.fields)
			if (field.searchable && (owner || !field.private)) fields.set(field.key, { prefix: field.prefix });
		if (fields.size > 0) out.set(type.key, fields);
	}
	return out;
};
