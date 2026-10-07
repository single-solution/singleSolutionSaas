/**
 * Phone numbers by the merchant's pattern settings (pure, no country assumed). A number is normalised (spaces, dots,
 * dashes and brackets removed, one leading `+` kept), optionally rewritten by prefix (`0` → `+44`, say), then checked:
 *
 * - `any`: only the digit count bounds;
 * - `e164`: `+` and 7–15 digits after the rewrites;
 * - `patterns`: one of the merchant's templates, where `#` is any digit and every other character is literal
 *   (`+1##########`, `07#########`). Matching is linear — merchant input never becomes a regular expression.
 * @module
 */

/**
 * @typedef {object} PhoneRules
 * @property {'any' | 'e164' | 'patterns'} mode
 * @property {string[]} patterns
 * @property {Array<{ prefix: string, replace: string }>} rewrites
 * @property {number} minDigits
 * @property {number} maxDigits
 */

const E164 = /^\+[1-9]\d{6,14}$/;

/** @param {string} raw */
export const normalisePhone = (raw) => {
	const compact = raw.replace(/[\s().\-\u00a0]/g, '');
	return compact.startsWith('+') ? `+${compact.slice(1).replace(/\+/g, '')}` : compact.replace(/\+/g, '');
};

/**
 * Does `value` match the template (`#` = digit)?
 * @param {string} value
 * @param {string} template
 */
export const matchesTemplate = (value, template) => {
	if (value.length !== template.length) return false;
	for (let index = 0; index < template.length; index += 1) {
		const want = template[index];
		const got = value[index];
		if (want === '#' ? !(got !== undefined && got >= '0' && got <= '9') : want !== got) return false;
	}
	return true;
};

/**
 * Validate and normalise a phone number.
 * @param {unknown} value
 * @param {PhoneRules} rules
 * @returns {{ ok: true, value: string, e164: string | null } | { ok: false, code: 'phone_invalid' }}
 */
export const checkPhone = (value, rules) => {
	if (typeof value !== 'string' || value.length > 40) return { ok: false, code: 'phone_invalid' };
	const compact = normalisePhone(value);
	if (!/^\+?\d+$/.test(compact)) return { ok: false, code: 'phone_invalid' };
	const rewrite = rules.rewrites.find((entry) => entry.prefix !== '' && compact.startsWith(entry.prefix));
	const rewritten = rewrite ? `${rewrite.replace}${compact.slice(rewrite.prefix.length)}` : compact;
	const digits = rewritten.replace(/\D/g, '').length;
	if (digits < rules.minDigits || digits > rules.maxDigits) return { ok: false, code: 'phone_invalid' };
	if (rules.mode === 'e164' && !E164.test(rewritten)) return { ok: false, code: 'phone_invalid' };
	if (rules.mode === 'patterns' && rules.patterns.length > 0) {
		const matched = rules.patterns.some(
			(template) => matchesTemplate(compact, template) || matchesTemplate(rewritten, template),
		);
		if (!matched) return { ok: false, code: 'phone_invalid' };
	}
	return { ok: true, value: rewritten, e164: E164.test(rewritten) ? rewritten : null };
};
