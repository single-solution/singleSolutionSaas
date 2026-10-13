/**
 * The shop's policies (PLAN 0.8.8 Business details; PLAN 0.8.10 E3, SF-1): delivery, returns, privacy, terms and
 * warranty texts of the `checkout` settings, in plain text or cleaned HTML (`policyFormat`), with the placeholders
 * `{returnDays}`, `{warrantyDays}`, `{warrantyMonths}`, `{business}`, `{email}`, `{phone}`, `{address}`,
 * `{deliveryFee}` and `{freeDeliveryOver}` filled (also written with double braces, `{{business}}`); other text in
 * braces stays as typed. Empty policies are left out. No I/O.
 * @module
 */
import { cleanHtml } from './catalog-content.js';

/** The policies, in the order they are shown, and their settings. */
export const POLICY_SETTINGS = Object.freeze({
	shipping: 'policyShipping',
	returns: 'policyReturns',
	privacy: 'policyPrivacy',
	terms: 'policyTerms',
	warranty: 'policyWarranty',
});

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
 * The filled policies.
 * @param {Record<string, unknown>} checkout the `checkout` settings
 * @param {PolicyValues} values
 * @returns {{ format: 'text' | 'html', policies: Partial<Record<keyof typeof POLICY_SETTINGS, string>> }}
 */
export const fillPolicies = (checkout, values) => {
	const format = checkout.policyFormat === 'html' ? 'html' : 'text';
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
	/** @type {Partial<Record<keyof typeof POLICY_SETTINGS, string>>} */
	const policies = {};
	for (const [key, setting] of Object.entries(POLICY_SETTINGS)) {
		const raw = typeof checkout[setting] === 'string' ? /** @type {string} */ (checkout[setting]) : '';
		const text = format === 'html' ? cleanHtml(fill(raw)) : fill(raw).trim();
		if (text) policies[/** @type {keyof typeof POLICY_SETTINGS} */ (key)] = text;
	}
	return { format, policies };
};
