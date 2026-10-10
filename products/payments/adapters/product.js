/**
 * The product on the kit: `createProductInstance(options)` wires `@ss/app-kit` `createProduct` with Payments' manifest
 * (each feature's settings schema from `schemas/` inline), its widget and page texts, its Connections (storage for
 * bank-transfer proofs, each gateway's keys, the Notifications token for webhooks and the Accounts token for
 * activity-log copies), the merchant database indexes, the data-rights hooks and the kit's events (PLAN 0.8.10 K5:
 * `payments.<type>`, forwarded through Notifications), and adds the gateway adapters on the same outbound policy. The Next.js route and the tests pass the rest (config, store, clock, network).
 * Public entry `./product` of this package, so a system test can compose the product with `./routes`.
 * @module
 */
import { createProduct } from '@ss/app-kit';
import { createOutboundPolicy, safeFetch } from '@ss/net';
import manifestFile from '../manifest.json' with { type: 'json' };
import strings from '../strings/en.json' with { type: 'json' };
import bankTransfer from '../schemas/bank_transfer.settings.json' with { type: 'json' };
import easypaisaSettings from '../schemas/easypaisa.settings.json' with { type: 'json' };
import genericGateway from '../schemas/generic_gateway.settings.json' with { type: 'json' };
import jazzcashSettings from '../schemas/jazzcash.settings.json' with { type: 'json' };
import payfastSettings from '../schemas/payfast.settings.json' with { type: 'json' };
import payfastPkSettings from '../schemas/payfast_pk.settings.json' with { type: 'json' };
import paymentApi from '../schemas/payment_api.settings.json' with { type: 'json' };
import paymentLinks from '../schemas/payment_links.settings.json' with { type: 'json' };
import paypalSettings from '../schemas/paypal.settings.json' with { type: 'json' };
import rapidSettings from '../schemas/rapid.settings.json' with { type: 'json' };
import refunds from '../schemas/refunds.settings.json' with { type: 'json' };
import stripeSettings from '../schemas/stripe.settings.json' with { type: 'json' };
import subscriptions from '../schemas/subscriptions.settings.json' with { type: 'json' };
import { paymentView, subscriptionView } from '../core/payments.js';
import { createAdapters } from './gateways/index.js';
import { INDEXES, createStore } from './store.js';

/** Settings schema of each feature (manifest.json points at them with `$ref`). @type {Record<string, unknown>} */
const SETTINGS = {
	stripe: stripeSettings,
	paypal: paypalSettings,
	payfast: payfastSettings,
	payfast_pk: payfastPkSettings,
	jazzcash: jazzcashSettings,
	easypaisa: easypaisaSettings,
	rapid: rapidSettings,
	bank_transfer: bankTransfer,
	generic_gateway: genericGateway,
	payment_links: paymentLinks,
	payment_api: paymentApi,
	subscriptions,
	refunds,
};

/** The manifest as the kit and the Portal take it: settings schemas inline. */
export const manifest = /** @type {import('@ss/contracts').Manifest} */ (
	/** @type {unknown} */ ({
		...manifestFile,
		features: manifestFile.features.map((feature) => ({ ...feature, settings: SETTINGS[feature.key] })),
	})
);

export { strings };

/** Payments' own problem codes. */
const PROBLEM_CODES = Object.freeze({
	gateway_not_ready: Object.freeze({ status: 422, title: 'Gateway not ready' }),
	currency_not_supported: Object.freeze({ status: 422, title: 'Currency not supported' }),
	not_refundable: Object.freeze({ status: 409, title: 'Not refundable' }),
	gateway_failed: Object.freeze({ status: 502, title: 'The gateway refused' }),
	storage_not_connected: Object.freeze({ status: 503, title: 'Storage not connected' }),
});

/**
 * Data rights (PLAN 0.4.11): a person's payments and subscriptions are found by their Accounts user id, e-mail or
 * phone. Delete removes their details from those records; the amounts stay, because they are the merchant's money
 * records.
 * @param {() => number} now
 * @returns {NonNullable<import('@ss/app-kit').ProductOptions['hooks']>}
 */
const dataRights = (now) => ({
	exportUser: async (ctx, user) => {
		const store = createStore(await ctx.data(), { now });
		return {
			// what the person paid and when; the merchant's own labels and the gateway history stay out
			payments: (await store.payments.ofPerson(user)).map((payment) => {
				const view = paymentView(payment, '');
				return {
					id: view.id,
					status: view.status,
					amount: view.amount,
					currency: view.currency,
					refunded: view.refunded,
					gateway: view.gateway,
					description: view.description,
					reference: view.reference,
					customer: view.customer,
					paidAt: view.paidAt,
					createdAt: view.createdAt,
				};
			}),
			subscriptions: (await store.subscriptions.ofPerson(user)).map((subscription) => {
				const view = subscriptionView(subscription);
				return {
					id: view.id,
					status: view.status,
					gateway: view.gateway,
					plan: view.plan,
					customer: view.customer,
					createdAt: view.createdAt,
				};
			}),
		};
	},
	deleteUser: async (ctx, user) => {
		const store = createStore(await ctx.data(), { now });
		const anonymised = (await store.payments.anonymise(user)) + (await store.subscriptions.anonymise(user));
		return { deleted: 0, anonymised };
	},
});

/**
 * @typedef {Omit<import('@ss/app-kit').ProductOptions, 'manifest' | 'strings' | 'hooks' | 'connections' | 'data' | 'problemCodes' | 'events'>} InstanceOptions
 */

/**
 * The product (kit routes, status, settings, connections, merchant database …) plus its gateway adapters.
 * @param {InstanceOptions} options at least `config` and `problems` from `configFromEnv()`
 */
export const createProductInstance = (options) => {
	const now = options.now ?? Date.now;
	const production = (options.nodeEnv ?? process.env.NODE_ENV) === 'production';
	const { allowHosts = [], ...outboundRest } = options.outbound ?? {};
	// the same policy the kit uses for addresses merchants enter
	const policy = createOutboundPolicy({ ...outboundRest, allowHosts: production ? [] : allowHosts });
	/** @type {import('./util.js').OutboundSend} */
	const send = options.outboundSend ?? ((url, init) => safeFetch(url, init, policy));
	const gateways = createAdapters(policy);

	/**
	 * A gateway connection: checked for its shape, then tested read-only with the gateway where it has such a call.
	 * @param {keyof typeof gateways} name
	 * @param {string} label
	 * @param {string} feature
	 * @param {string} secretField the member whose last 4 characters are shown
	 * @returns {import('@ss/app-kit').ConnectionDefinition}
	 */
	const gateway = (name, label, feature, secretField) => ({
		label,
		kind: 'secret',
		neededBy: [feature],
		secretField,
		test: async (value) => {
			const problem = gateways[name].violation(value);
			if (problem) return { ok: false, message: problem };
			return gateways[name].test(/** @type {Record<string, any>} */ (value), { send, now });
		},
	});

	const product = createProduct({
		...options,
		manifest,
		strings,
		problemCodes: PROBLEM_CODES,
		connections: {
			storage: { label: 'Storage for transfer proofs (S3-compatible)', kind: 'storage', neededBy: ['bank_transfer'] },
			stripe: gateway('stripe', 'Stripe keys', 'stripe', 'secretKey'),
			paypal: gateway('paypal', 'PayPal app', 'paypal', 'secret'),
			payfast: gateway('payfast', 'PayFast (South Africa) account', 'payfast', 'merchantKey'),
			payfast_pk: gateway('payfast_pk', 'PayFast (Pakistan) account', 'payfast_pk', 'securedKey'),
			jazzcash: gateway('jazzcash', 'JazzCash account', 'jazzcash', 'integritySalt'),
			easypaisa: gateway('easypaisa', 'Easypaisa store', 'easypaisa', 'hashKey'),
			rapid: gateway('rapid', 'Rapid Gateway account', 'rapid', 'secretKey'),
			generic: gateway('generic', 'Generic gateway', 'generic_gateway', 'secret'),
			notifications: {
				label: 'Notifications token (signed webhooks to your server)',
				kind: 'token',
				productId: 'notifications',
				neededBy: [],
			},
			accounts: { label: 'Accounts token (activity-log copies)', kind: 'token', productId: 'accounts', neededBy: [] },
		},
		hooks: dataRights(now),
		data: { indexes: INDEXES },
		// payment events (`payment.paid`, `payment.failed`, `payment.refunded`, `subscription.updated`) on the kit's
		// mechanism: stored in `ss_payments_events`, listed by GET /v1/events, forwarded through Notifications
		events: true,
	});
	return Object.freeze({ ...product, gateways, now, send });
};

/** @typedef {ReturnType<typeof createProductInstance>} Product */
