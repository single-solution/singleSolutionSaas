/**
 * Lead capture and form fields (pure): field validation shared by lead forms and flow forms (client and server use
 * the same rules), lead validation against the merchant's field list and consent.
 * @module
 */

/** @typedef {{ name: string, label?: string, type: string, required?: boolean, options?: string[], max_length?: number }} Field */

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/u;
const PHONE = /^\+?[0-9 ()./-]{6,24}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate one field value. Returns a problem code or null.
 * @param {Field} field
 * @param {unknown} value
 * @returns {string | null}
 */
export const validateField = (field, value) => {
	const empty = value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
	if (empty) return field.required ? 'required' : null;
	if (field.type === 'checkbox') return typeof value === 'boolean' ? (field.required && !value ? 'required' : null) : 'invalid';
	if (field.type === 'number') return typeof value === 'number' && Number.isFinite(value) ? null : 'invalid';
	if (typeof value !== 'string') return 'invalid';
	const text = value.trim();
	if ([...text].length > (field.max_length ?? (field.type === 'textarea' ? 4000 : 300))) return 'too_long';
	if (field.type === 'email' && !EMAIL.test(text)) return 'invalid_email';
	if (field.type === 'phone' && (!PHONE.test(text) || text.replace(/\D/g, '').length < 6)) return 'invalid_phone';
	if (field.type === 'date' && (!DATE.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`)))) return 'invalid_date';
	if (field.type === 'select' && field.options?.length && !field.options.includes(text)) return 'invalid_option';
	return null;
};

/**
 * Validate a lead submission `{ fields: { name: value }, consent }`.
 * @param {unknown} body
 * @param {{ fields: Field[], consentRequired: boolean }} config
 * @returns {Array<{ path: string, code: string }>}
 */
export const validateLead = (body, { fields, consentRequired }) => {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return [{ path: '', code: 'object_required' }];
	const b = /** @type {Record<string, any>} */ (body);
	const values = b.fields && typeof b.fields === 'object' && !Array.isArray(b.fields) ? b.fields : null;
	if (!values) return [{ path: '/fields', code: 'required' }];
	/** @type {Array<{ path: string, code: string }>} */
	const problems = [];
	for (const field of fields) {
		const code = validateField(field, values[field.name]);
		if (code) problems.push({ path: `/fields/${field.name}`, code });
	}
	for (const key of Object.keys(values))
		if (!fields.some((f) => f.name === key)) problems.push({ path: `/fields/${key}`, code: 'unknown_field' });
	if (consentRequired && b.consent !== true) problems.push({ path: '/consent', code: 'consent_required' });
	if (b.conversationId !== undefined && (typeof b.conversationId !== 'string' || b.conversationId.length > 64))
		problems.push({ path: '/conversationId', code: 'invalid' });
	return problems;
};

/**
 * Normalised lead values (trimmed strings) and the contact it implies.
 * @param {Record<string, unknown>} values
 * @param {Field[]} fields
 */
export const normaliseLead = (values, fields) => {
	/** @type {Record<string, unknown>} */
	const out = {};
	for (const field of fields) {
		const value = values[field.name];
		if (value === undefined || value === null || value === '') continue;
		out[field.name] = typeof value === 'string' ? value.trim() : value;
	}
	const byType = (/** @type {string} */ type) => {
		const field = fields.find((f) => f.type === type && typeof out[f.name] === 'string');
		return field ? /** @type {string} */ (out[field.name]) : null;
	};
	const name = typeof out.name === 'string' ? out.name : null;
	return {
		values: out,
		contact: { name, email: byType('email')?.toLowerCase() ?? null, phone: byType('phone') },
	};
};
