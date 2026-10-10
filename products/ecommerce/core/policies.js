/**
 * The shop's policies (PLAN 0.8.8 Business details; PLAN 0.8.10 E3): delivery, returns, privacy, terms and warranty
 * texts of the `checkout` settings, in plain text or cleaned HTML (`policyFormat`), with the placeholders
 * `{returnDays}`, `{warrantyDays}`, `{warrantyMonths}` and `{business}` filled; empty policies are left out. No I/O.
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
 * The filled policies.
 * @param {Record<string, unknown>} checkout the `checkout` settings
 * @param {{ returnDays: number, warrantyDays: number, business: string }} values
 * @returns {{ format: 'text' | 'html', policies: Partial<Record<keyof typeof POLICY_SETTINGS, string>> }}
 */
export const fillPolicies = (checkout, { returnDays, warrantyDays, business }) => {
	const format = checkout.policyFormat === 'html' ? 'html' : 'text';
	/** @param {string} text */
	const fill = (text) =>
		text
			.replaceAll('{returnDays}', String(returnDays))
			.replaceAll('{warrantyDays}', String(warrantyDays))
			.replaceAll('{warrantyMonths}', String(Math.round(warrantyDays / 30)))
			.replaceAll('{business}', business);
	/** @type {Partial<Record<keyof typeof POLICY_SETTINGS, string>>} */
	const policies = {};
	for (const [key, setting] of Object.entries(POLICY_SETTINGS)) {
		const raw = typeof checkout[setting] === 'string' ? /** @type {string} */ (checkout[setting]) : '';
		const text = format === 'html' ? cleanHtml(fill(raw)) : fill(raw).trim();
		if (text) policies[/** @type {keyof typeof POLICY_SETTINGS} */ (key)] = text;
	}
	return { format, policies };
};
