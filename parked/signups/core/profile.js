/**
 * Customer profiles (pure): the merchant's field schema (`profile.fields`), international addresses, custom fields and
 * verification badges. E-mail and phone are not profile fields: they change only by proving control of the new
 * identifier (OTP / magic link with `purpose: "link"`), which is what makes the verification badges trustworthy.
 * @module
 */

/** Field types a merchant can declare. */
export const FIELD_TYPES = Object.freeze(/** @type {const} */ (['text', 'date', 'boolean', 'number', 'url']));
/** Address members (international shape: no regional assumptions; `country` is ISO 3166-1 alpha-2). */
export const ADDRESS_FIELDS = Object.freeze(
	/** @type {const} */ (['label', 'line1', 'line2', 'city', 'region', 'postal_code', 'country']),
);
const ADDRESS_MAX = 200;
const COUNTRY = /^[A-Z]{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/**
 * @typedef {object} FieldDef
 * @property {string} key
 * @property {string} [label]
 * @property {typeof FIELD_TYPES[number]} type
 * @property {boolean} [required]
 * @property {number} [max_length]
 */
/** @typedef {Partial<Record<typeof ADDRESS_FIELDS[number], string>> & { id: string, is_default?: boolean }} Address */
/** @typedef {{ path: string, code: string }} FieldProblem */
/**
 * @typedef {object} ProfileRules
 * @property {readonly FieldDef[]} fields
 * @property {number} maxAddresses
 * @property {readonly string[]} addressRequired
 * @property {number} maxCustomKeys
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Check one profile value against its definition.
 * @param {FieldDef} def
 * @param {unknown} value
 * @returns {string | null} problem code
 */
const fieldProblem = (def, value) => {
	if (value === null) return def.required ? 'required' : null;
	const max = def.max_length ?? 200;
	switch (def.type) {
		case 'boolean':
			return typeof value === 'boolean' ? null : 'type';
		case 'number':
			return typeof value === 'number' && Number.isFinite(value) ? null : 'type';
		case 'date':
			return typeof value === 'string' && DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
				? null
				: 'format';
		case 'url':
			if (typeof value !== 'string' || value.length > Math.min(max, 2048)) return 'format';
			try {
				return ['https:', 'http:'].includes(new URL(value).protocol) ? null : 'format';
			} catch {
				return 'format';
			}
		default:
			if (typeof value !== 'string') return 'type';
			if (def.required && value.trim().length === 0) return 'required';
			return value.length > max ? 'too_long' : null;
	}
};

/**
 * Validate one address.
 * @param {unknown} address
 * @param {readonly string[]} required
 * @param {string} path
 * @returns {FieldProblem[]}
 */
export const addressProblems = (address, required, path) => {
	if (!isObject(address)) return [{ path, code: 'type' }];
	/** @type {FieldProblem[]} */
	const problems = [];
	for (const key of Object.keys(address))
		if (!(/** @type {readonly string[]} */ (ADDRESS_FIELDS).includes(key)) && key !== 'id' && key !== 'is_default')
			problems.push({ path: `${path}/${key}`, code: 'unknown_field' });
	for (const key of ADDRESS_FIELDS) {
		const value = address[key];
		if (value === undefined || value === null || value === '') {
			if (required.includes(key)) problems.push({ path: `${path}/${key}`, code: 'required' });
			continue;
		}
		if (typeof value !== 'string' || value.length > ADDRESS_MAX) problems.push({ path: `${path}/${key}`, code: 'type' });
		else if (key === 'country' && !COUNTRY.test(value)) problems.push({ path: `${path}/${key}`, code: 'format' });
	}
	if (address.is_default !== undefined && typeof address.is_default !== 'boolean')
		problems.push({ path: `${path}/is_default`, code: 'type' });
	return problems;
};

/**
 * Validate a profile patch `{ profile?, addresses?, custom? }` (JSON Merge Patch semantics for `profile` and
 * `custom`; `addresses` replaces the list).
 * @param {unknown} body
 * @param {ProfileRules} rules
 * @returns {FieldProblem[]}
 */
export const validateProfilePatch = (body, rules) => {
	if (!isObject(body)) return [{ path: '', code: 'type' }];
	/** @type {FieldProblem[]} */
	const problems = [];
	for (const key of Object.keys(body))
		if (!['profile', 'addresses', 'custom'].includes(key)) problems.push({ path: `/${key}`, code: 'unknown_field' });
	if (body.profile !== undefined) {
		if (!isObject(body.profile)) problems.push({ path: '/profile', code: 'type' });
		else
			for (const [key, value] of Object.entries(body.profile)) {
				const def = rules.fields.find((field) => field.key === key);
				const code = def ? fieldProblem(def, value) : 'unknown_field';
				if (code) problems.push({ path: `/profile/${key}`, code });
			}
	}
	if (body.addresses !== undefined) {
		if (!Array.isArray(body.addresses)) problems.push({ path: '/addresses', code: 'type' });
		else {
			if (body.addresses.length > rules.maxAddresses) problems.push({ path: '/addresses', code: 'too_many' });
			body.addresses.forEach((address, index) =>
				problems.push(...addressProblems(address, rules.addressRequired, `/addresses/${index}`)),
			);
		}
	}
	if (body.custom !== undefined) {
		if (!isObject(body.custom)) problems.push({ path: '/custom', code: 'type' });
		else {
			const entries = Object.entries(body.custom);
			if (entries.length > rules.maxCustomKeys) problems.push({ path: '/custom', code: 'too_many' });
			for (const [key, value] of entries) {
				if (!KEY.test(key)) problems.push({ path: `/custom/${key}`, code: 'format' });
				else if (value !== null && !['string', 'number', 'boolean'].includes(typeof value))
					problems.push({ path: `/custom/${key}`, code: 'type' });
				else if (typeof value === 'string' && value.length > 500) problems.push({ path: `/custom/${key}`, code: 'too_long' });
			}
		}
	}
	return problems;
};

/**
 * Apply a validated patch.
 * @template {{ profile?: Record<string, unknown>, addresses?: Address[], custom?: Record<string, unknown> }} C
 * @param {C} customer
 * @param {{ profile?: Record<string, unknown>, addresses?: Array<Record<string, unknown>>, custom?: Record<string, unknown> }} patch
 * @param {{ newId: () => string, maxCustomKeys: number }} options
 * @returns {{ customer: C, changed: string[] }}
 */
export const applyProfilePatch = (customer, patch, { newId, maxCustomKeys }) => {
	/** @type {string[]} */
	const changed = [];
	/**
	 * @param {Record<string, unknown>} base
	 * @param {Record<string, unknown>} merge
	 */
	const merged = (base, merge) => {
		const out = { ...base };
		for (const [key, value] of Object.entries(merge)) {
			if (value === null) delete out[key];
			else out[key] = value;
		}
		return out;
	};
	let next = { ...customer };
	if (patch.profile) {
		next = { ...next, profile: merged(customer.profile ?? {}, patch.profile) };
		changed.push(...Object.keys(patch.profile).map((key) => `profile.${key}`));
	}
	if (patch.addresses) {
		const keep = new Set((customer.addresses ?? []).map((address) => address.id));
		const addresses = patch.addresses.map((address) => {
			/** @type {Record<string, unknown>} */
			const clean = {};
			for (const key of ADDRESS_FIELDS) if (typeof address[key] === 'string' && address[key] !== '') clean[key] = address[key];
			const id = typeof address.id === 'string' && keep.has(address.id) ? address.id : newId();
			return /** @type {Address} */ ({ id, ...clean, is_default: address.is_default === true });
		});
		const firstDefault = addresses.findIndex((address) => address.is_default);
		next = {
			...next,
			addresses: addresses.map((address, index) => ({
				...address,
				is_default: index === (firstDefault === -1 ? 0 : firstDefault),
			})),
		};
		changed.push('addresses');
	}
	if (patch.custom) {
		const custom = merged(customer.custom ?? {}, patch.custom);
		next = { ...next, custom: Object.fromEntries(Object.entries(custom).slice(0, maxCustomKeys)) };
		changed.push('custom');
	}
	return { customer: next, changed };
};

/**
 * Required profile fields without a value (UIs prompt for them).
 * @param {{ profile?: Record<string, unknown> }} customer
 * @param {readonly FieldDef[]} fields
 */
export const missingFields = (customer, fields) =>
	fields
		.filter((field) => field.required)
		.filter((field) => {
			const value = customer.profile?.[field.key];
			return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
		})
		.map((field) => field.key);

/**
 * Verification badges.
 * @param {{ email?: string | null, phone?: string | null, emailVerifiedAt?: string | null, phoneVerifiedAt?: string | null }} customer
 */
export const badges = (customer) => ({
	email: customer.email ? (customer.emailVerifiedAt ? 'verified' : 'unverified') : 'none',
	phone: customer.phone ? (customer.phoneVerifiedAt ? 'verified' : 'unverified') : 'none',
});
