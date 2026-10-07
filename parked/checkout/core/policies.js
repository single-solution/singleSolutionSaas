/**
 * Policies shown at checkout and the sign-in gate (pure).
 *
 * Policies link to the merchant's documents — a direct URL, or a Content & Policies product document through the URL
 * template (`{key}` placeholder). A policy marked `required` needs the shopper's consent (a checkbox); placement refuses
 * without it and the order records which versions were accepted.
 *
 * The sign-in gate decides when an identity (bring-your-own identity, `SS-Identity`, e.g. from the Signups product) is
 * required: never, always, for cash on delivery, or above an order total.
 * @module
 */

/**
 * @typedef {{ key: string, url: string, required: boolean, version: string, label?: string }} Policy
 */

/**
 * @param {{ policies: Policy[], content_url_template: string }} settings
 * @param {(key: string) => string} t
 */
export const policiesView = (settings, t) =>
	settings.policies.map((policy) => {
		const url =
			policy.url ||
			(settings.content_url_template.includes('{key}')
				? settings.content_url_template.replaceAll('{key}', encodeURIComponent(policy.key))
				: null);
		return {
			key: policy.key,
			label: policy.label || t(`policies.${policy.key}`),
			url,
			required: policy.required,
			version: policy.version,
		};
	});

/**
 * Required policies the shopper did not accept.
 * @param {{ policies: Policy[] }} settings
 * @param {readonly string[]} accepted
 */
export const missingConsents = (settings, accepted) =>
	settings.policies.filter((policy) => policy.required && !accepted.includes(policy.key)).map((policy) => policy.key);

/**
 * Consents recorded on the order.
 * @param {{ policies: Policy[] }} settings
 * @param {readonly string[]} accepted
 * @param {string} at ISO time
 */
export const consentsOf = (settings, accepted, at) =>
	settings.policies
		.filter((policy) => accepted.includes(policy.key))
		.map((policy) => ({ key: policy.key, version: policy.version, acceptedAt: at }));

/**
 * @typedef {{ required: 'never' | 'always' | 'for_cod' | 'over_amount', over_amount: number, signin_url: string, return_param: string }} GateSettings
 */

/**
 * Is an identity needed for this checkout?
 * @param {GateSettings} settings
 * @param {{ paymentMethod?: string | null, total?: number | null }} checkout
 */
export const identityRequired = (settings, { paymentMethod = null, total = null }) => {
	switch (settings.required) {
		case 'always':
			return true;
		case 'for_cod':
			return paymentMethod === 'cod';
		case 'over_amount':
			return total !== null && total > settings.over_amount;
		default:
			return false;
	}
};

/**
 * Sign-in link with the return address (only an https URL or a path on the website is used).
 * @param {GateSettings} settings
 * @param {unknown} returnTo
 */
export const signinLink = (settings, returnTo) => {
	if (!settings.signin_url) return null;
	const back = typeof returnTo === 'string' && /^(?:https:\/\/|\/(?!\/))[^\s]*$/.test(returnTo) ? returnTo.slice(0, 2048) : null;
	if (!back) return settings.signin_url;
	const relative = settings.signin_url.startsWith('/');
	const url = new URL(settings.signin_url, 'https://website.invalid');
	url.searchParams.set(settings.return_param, back);
	return relative ? `${url.pathname}${url.search}${url.hash}` : url.href;
};
