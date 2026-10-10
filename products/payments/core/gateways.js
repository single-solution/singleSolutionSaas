/**
 * The gateways (PLAN 0.8.7): their ids (`payfast` is PayFast South Africa, `payfast_pk` PayFast Pakistan), the feature
 * that switches each on, the connection holding the merchant's keys, the currencies each one takes and how it refunds.
 * Every gateway is a redirect to the gateway's own page or form: card details never reach Payments. No I/O.
 * @module
 */

/** Gateway ids, in the order payers see them. */
export const GATEWAYS = Object.freeze(
	/** @type {const} */ ([
		'stripe',
		'paypal',
		'payfast',
		'payfast_pk',
		'jazzcash',
		'easypaisa',
		'rapid',
		'bank_transfer',
		'generic',
	]),
);

/** @typedef {typeof GATEWAYS[number]} Gateway */

/** The feature of each gateway (its feature key; the generic adapter is `generic_gateway`). */
export const GATEWAY_FEATURES = Object.freeze({
	stripe: 'stripe',
	paypal: 'paypal',
	payfast: 'payfast',
	payfast_pk: 'payfast_pk',
	jazzcash: 'jazzcash',
	easypaisa: 'easypaisa',
	rapid: 'rapid',
	bank_transfer: 'bank_transfer',
	generic: 'generic_gateway',
});

/** The connection holding each gateway's keys (bank transfer has none: its details are settings). */
export const GATEWAY_CONNECTIONS = Object.freeze({
	stripe: 'stripe',
	paypal: 'paypal',
	payfast: 'payfast',
	payfast_pk: 'payfast_pk',
	jazzcash: 'jazzcash',
	easypaisa: 'easypaisa',
	rapid: 'rapid',
	bank_transfer: null,
	generic: 'generic',
});

/** PayPal's currencies for checkout (its REST API list). */
const PAYPAL_CURRENCIES = Object.freeze([
	'AUD',
	'BRL',
	'CAD',
	'CHF',
	'CNY',
	'CZK',
	'DKK',
	'EUR',
	'GBP',
	'HKD',
	'HUF',
	'ILS',
	'JPY',
	'MXN',
	'MYR',
	'NOK',
	'NZD',
	'PHP',
	'PLN',
	'SEK',
	'SGD',
	'THB',
	'TWD',
	'USD',
]);

/**
 * The currencies each gateway takes; `null` = any code (Stripe refuses the few it does not take when the payment
 * starts; bank transfer is the merchant's own account; the generic adapter takes what its connection lists, else any).
 * @type {Readonly<Record<Gateway, ReadonlyArray<string> | null>>}
 */
export const GATEWAY_CURRENCIES = Object.freeze({
	stripe: null,
	paypal: PAYPAL_CURRENCIES,
	payfast: Object.freeze(['ZAR']),
	payfast_pk: Object.freeze(['PKR']),
	jazzcash: Object.freeze(['PKR']),
	easypaisa: Object.freeze(['PKR']),
	rapid: Object.freeze(['PKR']),
	bank_transfer: null,
	generic: null,
});

/** Gateways whose subscriptions Payments mirrors (gateway-managed plans). */
export const SUBSCRIPTION_GATEWAYS = Object.freeze(/** @type {const} */ (['stripe', 'paypal']));

/**
 * True when `value` is a gateway id.
 * @param {unknown} value
 * @returns {value is Gateway}
 */
export const isGateway = (value) => typeof value === 'string' && /** @type {readonly string[]} */ (GATEWAYS).includes(value);

/**
 * Whether a gateway takes a currency.
 * @param {Gateway} gateway
 * @param {string} currency
 * @param {ReadonlyArray<string> | null} [own] the generic adapter's own list from its connection
 */
export const takesCurrency = (gateway, currency, own = null) => {
	const list = gateway === 'generic' && own && own.length > 0 ? own : GATEWAY_CURRENCIES[gateway];
	return list === null || list.includes(currency);
};

/**
 * The gateways a payer may pick for a payment: switched on, connected (bank transfer: its account number is set) and
 * taking the currency, in {@link GATEWAYS} order.
 * @param {{ on: readonly string[], ready: (gateway: Gateway) => boolean, currency: string, own?: ReadonlyArray<string> | null,
 *   only?: readonly string[] | null }} input `only`: a payment link's own choice of gateways
 * @returns {Gateway[]}
 */
export const gatewaysFor = ({ on, ready, currency, own = null, only = null }) =>
	GATEWAYS.filter(
		(gateway) =>
			on.includes(GATEWAY_FEATURES[gateway]) &&
			(only === null || only.length === 0 || only.includes(gateway)) &&
			takesCurrency(gateway, currency, own) &&
			ready(gateway),
	);
