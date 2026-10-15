/**
 * The gateways (PLAN 0.8.7): their ids (`payfast` is PayFast South Africa, `payfast_pk` PayFast Pakistan), the feature
 * that switches each on, the connection holding the merchant's keys, the currencies each one takes and how it refunds.
 * Every gateway is a redirect to the gateway's own page or form: card details never reach Payments. The merchant's own
 * custom gateways (P4) run on the generic adapter, each in a connection of its own (`generic_1` … `generic_5`) and
 * named by its own key: `generic:<key>`. No I/O.
 * @module
 */

/** The adapters' ids, in the order payers see them (`generic`: the adapter of the merchant's custom gateways). */
export const GATEWAYS = Object.freeze(
	/** @type {const} */ (['stripe', 'paypal', 'payfast', 'payfast_pk', 'jazzcash', 'easypaisa', 'rapid', 'generic']),
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
	generic: 'generic_gateway',
});

/** The connection holding each gateway's keys (custom gateways: {@link CUSTOM_GATEWAY_CONNECTIONS}). */
export const GATEWAY_CONNECTIONS = Object.freeze({
	stripe: 'stripe',
	paypal: 'paypal',
	payfast: 'payfast',
	payfast_pk: 'payfast_pk',
	jazzcash: 'jazzcash',
	easypaisa: 'easypaisa',
	rapid: 'rapid',
	generic: null,
});

/** The connections of the merchant's custom gateways, one each (P4; an engine cap of 5). */
export const CUSTOM_GATEWAY_CONNECTIONS = Object.freeze(['generic_1', 'generic_2', 'generic_3', 'generic_4', 'generic_5']);

/** A custom gateway's own key: lowercase letters, digits and `-`. */
export const CUSTOM_KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * True for a custom gateway's id, `generic:<key>` (P4).
 * @param {unknown} value
 * @returns {value is string}
 */
export const isCustomGateway = (value) =>
	typeof value === 'string' && value.startsWith('generic:') && CUSTOM_KEY.test(value.slice('generic:'.length));

/**
 * The adapter a gateway id runs on: a custom gateway's is `generic`.
 * @param {string} id
 * @returns {Gateway}
 */
export const adapterOf = (id) => /** @type {Gateway} */ (isCustomGateway(id) ? 'generic' : id);

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
 * starts; the generic adapter takes what its connection lists, else any).
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
	generic: null,
});

/** Gateways whose subscriptions Payments mirrors (gateway-managed plans). */
export const SUBSCRIPTION_GATEWAYS = Object.freeze(/** @type {const} */ (['stripe', 'paypal']));

/**
 * True when `value` is a gateway a payment may name: a built-in gateway's id or a custom gateway's `generic:<key>`.
 * @param {unknown} value
 * @returns {value is string}
 */
export const isGateway = (value) =>
	isCustomGateway(value) ||
	(typeof value === 'string' && value !== 'generic' && /** @type {readonly string[]} */ (GATEWAYS).includes(value));

/**
 * Whether a gateway takes a currency.
 * @param {string} gateway a gateway's id (a custom gateway's `generic:<key>`)
 * @param {string} currency
 * @param {ReadonlyArray<string> | null} [own] a custom gateway's own list from its connection
 */
export const takesCurrency = (gateway, currency, own = null) => {
	const adapter = adapterOf(gateway);
	const list = adapter === 'generic' && own && own.length > 0 ? own : GATEWAY_CURRENCIES[adapter];
	return list === null || list.includes(currency);
};

/**
 * The gateways a payer may pick for a payment: switched on, connected and taking the currency, in {@link GATEWAYS}
 * order (manual methods are the merchant's list, `./methods.js`).
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

/**
 * The ways to pay in the order payers see them (P5): the merchant's preferred way first (the link page and the pay
 * button preselect it), then the ones of the merchant's order, then the rest in their usual order (gateways in
 * {@link GATEWAYS} order, then the merchant's manual payment methods in their list's order). Names not offered now
 * are ignored.
 * @param {readonly string[]} ways the ways offered now, in their usual order
 * @param {{ order: readonly unknown[], preferred: unknown }} merchant `payment_api.methodOrder` and
 *   `payment_api.preferredMethod`
 * @returns {string[]}
 */
export const orderedWays = (ways, { order, preferred }) => {
	const first = [preferred, ...order].filter(
		(id, index, all) => typeof id === 'string' && ways.includes(id) && all.indexOf(id) === index,
	);
	return [.../** @type {string[]} */ (first), ...ways.filter((id) => !first.includes(id))];
};
