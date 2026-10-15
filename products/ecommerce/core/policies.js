/**
 * The shop's policies (PLAN 0.8.8 Business details; PLAN 0.8.10 E3, SF-1, E27): the merchant's list `policies` — each
 * `{ key, title, text }`, in the order shown, seeded with delivery, returns, privacy, terms and warranty and open to any
 * other the merchant adds — in plain text or cleaned HTML (the `checkout` setting `policyFormat`), with the
 * placeholders `{returnDays}`, `{warrantyDays}`, `{warrantyMonths}`, `{business}`, `{email}`, `{phone}`, `{address}`,
 * `{deliveryFee}` and `{freeDeliveryOver}` filled (also written with double braces, `{{business}}`); other text in
 * braces stays as typed. Policies without text are left out. No I/O.
 * @module
 */
import { cleanHtml } from './catalog-content.js';

/** A policy of the list. @typedef {{ key: string, title: string, text: string }} Policy */

/** At most this many policies. */
export const MAX_POLICIES = 20;
/** The longest title and text of a policy. */
const MAX_TITLE = 80;
const MAX_TEXT = 20_000;
/** A policy key: it names the policy's page (`/policies/<key>`) on the merchant's site. */
const KEY = /^[a-z][a-z0-9_-]{0,39}$/;

/** The list of a new website: the five usual policies, without text until the merchant writes them. */
export const DEFAULT_POLICIES = Object.freeze(
	/** @type {Policy[]} */ ([
		{ key: 'shipping', title: 'Delivery policy', text: '' },
		{ key: 'returns', title: 'Returns policy', text: '' },
		{ key: 'warranty', title: 'Warranty policy', text: '' },
		{ key: 'privacy', title: 'Privacy policy', text: '' },
		{ key: 'terms', title: 'Terms and conditions', text: '' },
	]).map((policy) => Object.freeze(policy)),
);

/**
 * Check the `policies` list the merchant saves.
 * @param {unknown} value
 * @returns {{ ok: true, value: Policy[] } | { ok: false, errors: string[] }}
 */
export const checkPolicies = (value) => {
	if (!Array.isArray(value)) return { ok: false, errors: ['A list of policies is expected.'] };
	/** @type {string[]} */
	const errors = [];
	if (value.length > MAX_POLICIES) errors.push(`At most ${MAX_POLICIES} policies.`);
	/** @type {Policy[]} */
	const policies = [];
	const keys = new Set();
	for (const raw of value) {
		const row = typeof raw === 'object' && raw !== null ? /** @type {Record<string, unknown>} */ (raw) : {};
		const key = typeof row.key === 'string' ? row.key.trim() : '';
		const title = typeof row.title === 'string' ? row.title.trim() : '';
		const text = row.text === undefined || row.text === null ? '' : row.text;
		if (!KEY.test(key)) {
			errors.push(`Policy key '${key}' must be 1–40 lowercase letters, digits, - or _, starting with a letter.`);
			continue;
		}
		if (keys.has(key)) errors.push(`Policy '${key}' is listed twice.`);
		keys.add(key);
		if (!title || title.length > MAX_TITLE) errors.push(`Policy '${key}' needs a title of at most ${MAX_TITLE} characters.`);
		if (typeof text !== 'string' || text.length > MAX_TEXT)
			errors.push(`The text of policy '${key}' has at most ${MAX_TEXT.toLocaleString('en-US')} characters.`);
		policies.push({ key, title, text: typeof text === 'string' ? text : '' });
	}
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value: policies };
};

/**
 * What the placeholders stand for: the return and warranty days, the business's name and contacts (business.json),
 * and the delivery fee where no zone matches and the amount delivery is free from, written as money ('' when none).
 * @typedef {{ returnDays: number, warrantyDays: number, business: string, email?: string, phone?: string,
 *   address?: string, deliveryFee?: string, freeDeliveryOver?: string }} PolicyValues
 */

/** A placeholder, with one or two braces. */
const PLACEHOLDER = /\{\{([A-Za-z]+)\}\}|\{([A-Za-z]+)\}/g;

/** @param {string} value */
const escapeHtml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The filled policies, in the list's order, those without text left out.
 * @param {ReadonlyArray<Policy>} list the `policies` list
 * @param {unknown} policyFormat the `checkout` setting `policyFormat`
 * @param {PolicyValues} values
 * @returns {{ format: 'text' | 'html', policies: Policy[] }}
 */
export const fillPolicies = (list, policyFormat, values) => {
	const format = policyFormat === 'html' ? 'html' : 'text';
	/** @type {Record<string, string>} */
	const known = {
		returnDays: String(values.returnDays),
		warrantyDays: String(values.warrantyDays),
		warrantyMonths: String(Math.round(values.warrantyDays / 30)),
		business: values.business,
		email: values.email ?? '',
		phone: values.phone ?? '',
		address: values.address ?? '',
		deliveryFee: values.deliveryFee ?? '',
		freeDeliveryOver: values.freeDeliveryOver ?? '',
	};
	/** @param {string} text */
	const fill = (text) =>
		text.replace(PLACEHOLDER, (whole, double, single) => {
			const key = String(double ?? single);
			if (!Object.hasOwn(known, key)) return whole;
			const value = /** @type {string} */ (known[key]);
			return format === 'html' ? escapeHtml(value) : value;
		});
	return {
		format,
		policies: list.flatMap(({ key, title, text }) => {
			const filled = format === 'html' ? cleanHtml(fill(text)) : fill(text).trim();
			return filled ? [{ key, title, text: filled }] : [];
		}),
	};
};
