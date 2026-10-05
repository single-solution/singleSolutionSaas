/**
 * Effective settings of a website: which elements are on (signed entitlement document), their configuration (feature
 * schemas' defaults overlaid with the document's values) and the website's own settings (currency, time zone). Every
 * number, flag, text and list the product uses comes from here — nothing is hard-coded.
 */
import { effectiveConfig } from '../core/config.js';
import { isCurrency } from '../core/orders.js';
import cart from '../schemas/cart.features.json' with { type: 'json' };
import checkoutForm from '../schemas/checkout_form.features.json' with { type: 'json' };
import loyaltyRedeem from '../schemas/loyalty_redeem.features.json' with { type: 'json' };
import offerApply from '../schemas/offer_apply.features.json' with { type: 'json' };
import paymentGateway from '../schemas/payment_gateway.features.json' with { type: 'json' };
import paymentManual from '../schemas/payment_manual.features.json' with { type: 'json' };
import paymentProofs from '../schemas/payment_proofs.features.json' with { type: 'json' };
import placeOrder from '../schemas/place_order.features.json' with { type: 'json' };
import policiesNotice from '../schemas/policies_notice.features.json' with { type: 'json' };
import signinGate from '../schemas/signin_gate.features.json' with { type: 'json' };
import successPage from '../schemas/success_page.features.json' with { type: 'json' };

/** Feature schema of every element. */
export const SCHEMAS = Object.freeze({
	cart,
	checkout_form: checkoutForm,
	place_order: placeOrder,
	payment_manual: paymentManual,
	payment_proofs: paymentProofs,
	payment_gateway: paymentGateway,
	offer_apply: offerApply,
	loyalty_redeem: loyaltyRedeem,
	success_page: successPage,
	policies_notice: policiesNotice,
	signin_gate: signinGate,
});

/** @typedef {keyof typeof SCHEMAS} ElementKey */

/** @param {unknown} zone */
const isTimeZone = (zone) => {
	if (typeof zone !== 'string' || zone === '') return false;
	try {
		return Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone !== '';
	} catch {
		return false;
	}
};

/**
 * @param {{ can: (key: string) => boolean, config: (key: string) => Record<string, unknown> | null | undefined,
 *   website?: { currency?: string, timeZone?: string, language?: string } | null }} source
 */
export const settingsFrom = ({ can, config, website = null }) => {
	const of = (/** @type {ElementKey} */ key) => effectiveConfig(SCHEMAS[key], config(key));
	const cartSettings = of('cart');
	const currency = isCurrency(website?.currency)
		? /** @type {string} */ (website?.currency)
		: isCurrency(cartSettings.default_currency)
			? /** @type {string} */ (cartSettings.default_currency)
			: null;
	return {
		enabled: (/** @type {ElementKey} */ key) => can(key),
		currency,
		timeZone: isTimeZone(website?.timeZone) ? /** @type {string} */ (website?.timeZone) : 'UTC',
		language: typeof website?.language === 'string' ? website.language : 'en',
		cart: cartSettings,
		form: /** @type {import('../core/form.js').FormSettings & Record<string, any>} */ (of('checkout_form')),
		place: of('place_order'),
		manual: /** @type {import('../core/payments.js').ManualSettings & Record<string, any>} */ (of('payment_manual')),
		proofs: of('payment_proofs'),
		gateway: of('payment_gateway'),
		offers: of('offer_apply'),
		loyalty: of('loyalty_redeem'),
		success: /** @type {import('../core/success.js').SuccessSettings} */ (of('success_page')),
		policies: /** @type {{ policies: import('../core/policies.js').Policy[], content_url_template: string }} */ (
			of('policies_notice')
		),
		gate: /** @type {import('../core/policies.js').GateSettings} */ (of('signin_gate')),
	};
};

/** @typedef {ReturnType<typeof settingsFrom>} Settings */

/**
 * Settings from a signed entitlement document through the app-kit helpers.
 * @param {any} product app-kit product
 * @param {any} doc entitlement document
 * @returns {Settings}
 */
export const settingsForDoc = (product, doc) =>
	settingsFrom({
		can: (key) => product.entitlements.can(doc, key),
		config: (key) => product.entitlements.config(doc, key) ?? {},
		website: doc?.website ?? null,
	});
