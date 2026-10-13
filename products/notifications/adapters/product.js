/**
 * The product on the kit: `createProductInstance(options)` wires `@ss/app-kit` `createProduct` with Notifications'
 * manifest (each feature's settings schema from `schemas/` inline), its widget texts, its Connections (providers per
 * channel, push keys, the webhook signing secret and the Accounts token for activity-log copies), the delivery log's
 * shared setting (how long it is kept, PLAN 0.8.10 D11), the merchant database indexes, the data-rights hooks, the widget settings and the list `webhook_urls` (in the product database,
 * whose store it owns), and adds the sealer of sensitive messages, the providers and web push on the same outbound
 * policy. The Next.js route and the tests pass the rest (config, store, clock, network).
 * Public entry `./product` of this package, so a system test can compose the product with `./routes`.
 * @module
 */
import { MongoClient } from 'mongodb';
import { createMemoryStore, createMongoStore, createProduct } from '@ss/app-kit';
import { createOutboundPolicy, safeFetch } from '@ss/net';
import manifestFile from '../manifest.json' with { type: 'json' };
import strings from '../strings/en.json' with { type: 'json' };
import browserPush from '../schemas/browser_push.settings.json' with { type: 'json' };
import delayedSend from '../schemas/delayed_send.settings.json' with { type: 'json' };
import deliveryLog from '../schemas/delivery_log.shared.json' with { type: 'json' };
import email from '../schemas/email.settings.json' with { type: 'json' };
import fallback from '../schemas/fallback.settings.json' with { type: 'json' };
import multiLanguage from '../schemas/multi_language.settings.json' with { type: 'json' };
import quietHours from '../schemas/quiet_hours.settings.json' with { type: 'json' };
import sendApi from '../schemas/send_api.settings.json' with { type: 'json' };
import sendLimits from '../schemas/send_limits.settings.json' with { type: 'json' };
import sms from '../schemas/sms.settings.json' with { type: 'json' };
import staffPush from '../schemas/staff_push.settings.json' with { type: 'json' };
import webhooks from '../schemas/webhooks.settings.json' with { type: 'json' };
import whatsapp from '../schemas/whatsapp.settings.json' with { type: 'json' };
import { normaliseEmail, normalisePhone } from '../core/channels.js';
import { createSealer } from './crypto.js';
import { LISTS, createLists } from './lists.js';
import { createProviders } from './providers.js';
import { INDEXES, createStore } from './store.js';
import { createWebPush, pushKeysOf } from './webpush.js';

/** Settings schema of each feature (manifest.json points at them with `$ref`). @type {Record<string, unknown>} */
const SETTINGS = {
	whatsapp,
	email,
	sms,
	browser_push: browserPush,
	staff_push: staffPush,
	webhooks,
	fallback,
	quiet_hours: quietHours,
	send_limits: sendLimits,
	delayed_send: delayedSend,
	multi_language: multiLanguage,
	send_api: sendApi,
};

/**
 * Settings several features use (PLAN 0.8.10 D11): how long the delivery log of every channel and the outgoing webhook
 * events are kept (`delivery_log.retentionDays`; 0, the default, keeps them forever).
 * @type {Record<string, { name: string, features: string[], settings: any }>}
 */
export const SHARED_SETTINGS = {
	delivery_log: {
		name: 'Delivery log',
		features: ['whatsapp', 'email', 'sms', 'browser_push', 'staff_push', 'webhooks'],
		settings: deliveryLog,
	},
};

/** The manifest as the kit and the Portal take it: settings schemas inline. */
export const manifest = /** @type {import('@ss/contracts').Manifest} */ (
	/** @type {unknown} */ ({
		...manifestFile,
		features: manifestFile.features.map((feature) => ({ ...feature, settings: SETTINGS[feature.key] })),
	})
);

export { strings };

/** The fallback key a misconfigured product builds its sealer with (it answers 503 everywhere anyway). */
const UNCONFIGURED_KEY = 'unconfigured-notifications-encryption-key-000';

/** Notifications' own problem codes. */
const PROBLEM_CODES = Object.freeze({
	template_not_found: Object.freeze({ status: 422, title: 'Template not found' }),
});

/**
 * The addresses a data-rights request names (e-mail and phone, normalised).
 * @param {{ email?: string, phone?: string }} user
 */
const addressesOf = (user) =>
	/** @type {string[]} */ ([normaliseEmail(user.email), normalisePhone(user.phone)].filter((address) => address !== null));

/**
 * Data rights (PLAN 0.4.11): a person's messages, unsubscribes and unsubscribe codes are found by their e-mail address
 * and phone number; delete removes them. Messages are exported as the delivery log keeps them: the values of sensitive
 * messages hidden (PLAN 0.8.10 D11).
 * @param {() => number} now
 * @returns {NonNullable<import('@ss/app-kit').ProductOptions['hooks']>}
 */
const dataRights = (now) => ({
	exportUser: async (ctx, user) => {
		const addresses = addressesOf(user);
		if (addresses.length === 0) return {};
		const store = createStore(await ctx.data(), { now });
		return {
			messages: (await store.messages.byAddresses(addresses)).map((message) => ({
				id: message.id,
				template: message.template,
				channel: message.channel,
				to: message.address,
				subject: message.subject,
				text: message.text,
				status: message.status,
				createdAt: new Date(message.createdAt).toISOString(),
			})),
			unsubscribes: (await store.optouts.byAddresses(addresses)).map((entry) => ({
				address: entry.address,
				via: entry.via,
				at: new Date(entry.createdAt).toISOString(),
			})),
		};
	},
	deleteUser: async (ctx, user) => {
		const addresses = addressesOf(user);
		if (addresses.length === 0) return { deleted: 0, anonymised: 0 };
		const store = createStore(await ctx.data(), { now });
		const deleted =
			(await store.messages.deleteByAddresses(addresses)) +
			(await store.optouts.deleteByAddresses(addresses)) +
			(await store.recipients.deleteByAddresses(addresses));
		return { deleted, anonymised: 0 };
	},
});

/**
 * @typedef {Omit<import('@ss/app-kit').ProductOptions, 'manifest' | 'strings' | 'hooks' | 'connections' | 'data' | 'problemCodes'>
 *   & { createTransport?: import('./smtp.js').CreateSmtpTransport }} InstanceOptions
 */

/**
 * The product (kit routes, status, settings, connections, merchant database …) plus its providers and web push.
 * @param {InstanceOptions} options at least `config` and `problems` from `configFromEnv()`
 */
export const createProductInstance = (options) => {
	const { createTransport, ...kitOptions } = options;
	const now = options.now ?? Date.now;
	const production = (options.nodeEnv ?? process.env.NODE_ENV) === 'production';
	const uri = (options.problems ?? []).length === 0 ? options.config?.mongodbUri : undefined;
	// Notifications keeps its list setting (webhook URLs) in the product database too, so it owns the store
	const store =
		options.store ??
		(uri
			? createMongoStore({ db: new MongoClient(uri, { maxPoolSize: 5, minPoolSize: 0, maxIdleTimeMS: 60_000 }).db(), now })
			: createMemoryStore({ now }));
	const lists = createLists({ store, now });
	const { allowHosts = [], ...outboundRest } = options.outbound ?? {};
	// the same policy the kit uses for addresses merchants enter
	const policy = createOutboundPolicy({ ...outboundRest, allowHosts: production ? [] : allowHosts });
	/** @type {import('./providers.js').OutboundSend} */
	const send = options.outboundSend ?? ((url, init) => safeFetch(url, init, policy));
	const providers = createProviders({ send, policy, now, ...(createTransport ? { createTransport } : {}) });
	const webpush = createWebPush({ send, now });
	const sealer = createSealer(options.config?.encryptionKey || UNCONFIGURED_KEY);

	/** @param {'email' | 'sms' | 'whatsapp'} name */
	const provider = (name) => ({
		test: (/** @type {unknown} */ value) => providers.test(name, value),
	});

	const product = createProduct({
		...kitOptions,
		store,
		manifest,
		strings,
		problemCodes: PROBLEM_CODES,
		connections: {
			email: { label: 'E-mail provider', kind: 'secret', neededBy: ['email'], secretField: 'secret', ...provider('email') },
			sms: { label: 'SMS provider', kind: 'secret', neededBy: ['sms'], secretField: 'secret', ...provider('sms') },
			whatsapp: {
				label: 'WhatsApp provider',
				kind: 'secret',
				neededBy: ['whatsapp'],
				secretField: 'secret',
				...provider('whatsapp'),
			},
			push_keys: {
				label: 'Push keys (VAPID)',
				kind: 'secret',
				neededBy: ['browser_push', 'staff_push'],
				secretField: 'privateKey',
				test: async (value) => {
					const keys = pushKeysOf(value);
					return keys.ok ? { ok: true } : { ok: false, message: keys.message };
				},
			},
			webhook_secret: {
				label: 'Webhook signing secret',
				kind: 'secret',
				neededBy: ['webhooks'],
				test: async (value) =>
					typeof value === 'string' && value.length >= 24
						? { ok: true }
						: { ok: false, message: 'Use a random secret of at least 24 characters.' },
			},
			accounts: { label: 'Accounts token (activity-log copies)', kind: 'token', productId: 'accounts', neededBy: [] },
		},
		hooks: {
			...dataRights(now),
			// what the widgets need (GET /v1/widget/config): the public push key only, never a secret
			widgetConfig: async (ctx) => {
				const keys = await product.connections.value(/** @type {string} */ (ctx.websiteId), 'push_keys');
				const publicKey =
					typeof keys === 'object' && keys !== null && typeof keys.publicKey === 'string' ? keys.publicKey : null;
				return { pushPublicKey: publicKey };
			},
		},
		data: { indexes: INDEXES },
		sharedSettings: SHARED_SETTINGS,
		// the settings API's `GET|PUT /v1/lists/webhook_urls` for the merchant's server (K1, N5), checked like the dashboard's
		lists: {
			webhook_urls: {
				feature: LISTS.webhook_urls.feature,
				title: LISTS.webhook_urls.title,
				get: lists.webhookUrls,
				save: lists.saveWebhookUrls,
			},
		},
	});
	return Object.freeze({ ...product, providers, webpush, lists, sealer, now, send });
};

/** @typedef {ReturnType<typeof createProductInstance>} Product */
