/**
 * The product on the kit: `createProductInstance(options)` wires `@ss/app-kit` `createProduct` with Notifications'
 * manifest (each feature's settings schema from `schemas/` inline), its widget texts, its Connections (providers per
 * channel, push keys, the webhook signing secret and the Accounts token for activity-log copies), the delivery log's
 * shared setting (how long it is kept, PLAN 0.8.10 D11), the merchant database indexes, the data-rights hooks, the
 * widget settings, the list `webhook_urls` (in the product database: the kit's `createProductBase` store, shared with the
 * kit) and its part of the website
 * Setup sheet (the OpenAPI document, the guide's "What your website builds" per feature, the channels that are on, and
 * while Outgoing webhooks is on the events it sends and its webhook URLs by host only), and adds the sealer of sensitive
 * messages, the providers and web push on the same outbound policy, and the other products from the Portal's directory
 * (whose template keys are theirs) with the message defaults its dashboard lists (parity P1). The Next.js route and the tests pass the rest (config, store, clock, network).
 * Public entry `./product` of this package, so a system test can compose the product with `./routes`.
 * @module
 */
import { normalizeEmail } from '@ss/contracts/email';
import { isObject } from '@ss/contracts/util';
import { createProduct, createProductBase } from '@ss/app-kit';
import { noopLogger } from '@ss/net';
import guide from '../docs/guide.json' with { type: 'json' };
import manifestFile from '../manifest.json' with { type: 'json' };
import openapi from '../openapi.json' with { type: 'json' };
import strings from '../strings/en.json' with { type: 'json' };
import push from '../schemas/push.settings.json' with { type: 'json' };
import browserPush from '../schemas/browser_push.settings.json' with { type: 'json' };
import delayedSend from '../schemas/delayed_send.settings.json' with { type: 'json' };
import deliveryLog from '../schemas/delivery_log.shared.json' with { type: 'json' };
import email from '../schemas/email.settings.json' with { type: 'json' };
import fallback from '../schemas/fallback.settings.json' with { type: 'json' };
import multiLanguage from '../schemas/multi_language.settings.json' with { type: 'json' };
import quietHours from '../schemas/quiet_hours.settings.json' with { type: 'json' };
import sendApi from '../schemas/send_api.settings.json' with { type: 'json' };
import sendingPolicy from '../schemas/sending_policy.shared.json' with { type: 'json' };
import sendLimits from '../schemas/send_limits.settings.json' with { type: 'json' };
import sms from '../schemas/sms.settings.json' with { type: 'json' };
import staffPush from '../schemas/staff_push.settings.json' with { type: 'json' };
import webhooks from '../schemas/webhooks.settings.json' with { type: 'json' };
import whatsapp from '../schemas/whatsapp.settings.json' with { type: 'json' };
import { normalizePhone } from '../core/channels.js';
import { WEBHOOK_EVENTS, webhookUrlsSummary } from '../core/webhooks.js';
import { createSealer, resealWebsite } from './crypto.js';
import { createDefaults } from './defaults.js';
import { createLists } from './lists.js';
import { createProviders } from './providers.js';
import { INDEXES, createStore } from './store.js';
import { createWebPush, pushKeysOf } from './webpush.js';

/** Settings schema of each feature (manifest.json points at them with `$ref`). @type {Record<string, unknown>} */
const SETTINGS = {
	whatsapp,
	email,
	sms,
	push,
	webhooks,
	send_api: sendApi,
};

/**
 * Settings several features use (PLAN 0.8.10 D11): how long the delivery log of every channel and the outgoing webhook
 * events are kept (`delivery_log.retentionDays`; 0, the default, keeps them forever).
 * @type {Record<string, { name: string, features: string[], settings: any }>}
 */
const SHARED_SETTINGS = {
	delivery_log: {
		name: 'Delivery log',
		features: ['whatsapp', 'email', 'sms', 'push', 'browser_push', 'staff_push', 'webhooks', 'send_api'],
		settings: deliveryLog,
	},
	sending_policy: {
		name: 'Sending policy',
		features: ['whatsapp', 'email', 'sms', 'push', 'browser_push', 'staff_push', 'send_api'],
		settings: sendingPolicy,
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

/** The features that send to the website's customers, named in its Setup sheet (staff push reaches its staff only). */
const CUSTOMER_CHANNELS = Object.freeze(['whatsapp', 'email', 'sms', 'push', 'browser_push']);

/** The fallback key a misconfigured product builds its sealer with (it answers 503 everywhere anyway). */
const UNCONFIGURED_KEY = 'unconfigured-notifications-encryption-key-000';

/** Notifications' own problem codes. */
const PROBLEM_CODES = Object.freeze({
	template_not_found: Object.freeze({ status: 422, title: 'Template not found' }),
});

/**
 * The addresses a data-rights request names (email and phone, normalized).
 * @param {{ email?: string, phone?: string }} user
 */
const addressesOf = (user) =>
	/** @type {string[]} */ ([normalizeEmail(user.email), normalizePhone(user.phone)].filter((address) => address !== null));

/**
 * Data rights (PLAN 0.4.11): a person's messages, unsubscribes (from everything or a topic) and unsubscribe codes are found by their email address
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
			unsubscribes: [
				...(await store.optouts.byAddresses(addresses)).map((entry) => ({
					address: entry.address,
					topic: null,
					via: entry.via,
					at: new Date(entry.createdAt).toISOString(),
				})),
				...(await store.topicOptouts.byAddresses(addresses)).map((entry) => ({
					address: entry.address,
					topic: entry.topic,
					via: entry.via,
					at: new Date(entry.createdAt).toISOString(),
				})),
			],
		};
	},
	deleteUser: async (ctx, user) => {
		const addresses = addressesOf(user);
		if (addresses.length === 0) return { deleted: 0, anonymized: 0 };
		const store = createStore(await ctx.data(), { now });
		const deleted =
			(await store.messages.deleteByAddresses(addresses)) +
			(await store.optouts.deleteByAddresses(addresses)) +
			(await store.topicOptouts.deleteByAddresses(addresses)) +
			(await store.recipients.deleteByAddresses(addresses));
		return { deleted, anonymized: 0 };
	},
});

/**
 * @typedef {Omit<import('@ss/app-kit').ProductOptions, 'manifest' | 'strings' | 'hooks' | 'connections' | 'data' | 'problemCodes' | 'openapi' | 'build'>
 *   & { createTransport?: import('./smtp.js').CreateSmtpTransport }} InstanceOptions
 */

/**
 * The product (kit routes, status, settings, connections, merchant database …) plus its providers and web push.
 * @param {InstanceOptions} options at least `config` and `problems` from `configFromEnv()`
 */
export const createProductInstance = (options) => {
	const { createTransport, ...kitOptions } = options;
	const now = options.now ?? Date.now;
	// Notifications keeps its list settings in the product database too, and sends to providers and push services on
	// the policy the kit uses for addresses merchants enter: the kit's start-up pieces, shared with the kit
	const { store, policy, send } = createProductBase(kitOptions);
	const lists = createLists({ store, now });
	const providers = createProviders({ send, policy, now, ...(createTransport ? { createTransport } : {}) });
	const webpush = createWebPush({ send, now });
	const keys = (options.problems ?? []).length === 0 ? options.config : undefined;
	const sealer = createSealer(keys?.encryptionKey || UNCONFIGURED_KEY, keys?.previousEncryptionKey ?? null);

	/** @param {'email' | 'sms' | 'whatsapp'} name */
	const provider = (name) => ({
		test: (/** @type {unknown} */ value) => providers.test(name, value),
	});

	/**
	 * Notifications' own part of the website Setup sheet: the customer channels that are on and, while Outgoing webhooks
	 * is on, the events it sends (its own and other products') and its webhook URLs by host only. Never a secret; it
	 * reads the one list only while that feature is on.
	 * @param {{ websiteId: string, on: string[] }} website
	 */
	const setupPart = async ({ websiteId, on }) => {
		const channels = manifest.features
			.filter(
				(feature) =>
					CUSTOMER_CHANNELS.includes(feature.key) &&
					on.includes(feature.key) &&
					(feature.key !== 'browser_push' || !on.includes('push')),
			)
			.map((feature) => feature.name);
		const summaries = [
			{
				title: 'Channels',
				text: channels.length > 0 ? `${channels.join(', ')}.` : 'None is on yet, so nothing can be sent to customers.',
			},
		];
		if (!on.includes('webhooks')) return { summaries };
		const urls = await lists.webhookUrls(websiteId);
		return {
			lists: { webhook_urls: webhookUrlsSummary(urls) },
			summaries: [
				...summaries,
				{
					title: 'Webhook events',
					text: `${WEBHOOK_EVENTS.slice(0, -1).join(', ')} and ${WEBHOOK_EVENTS.at(-1)}, plus the events other products forward (for example payments.payment.paid); each URL takes the events it names, or every event.`,
				},
			],
		};
	};

	const product = createProduct({
		...kitOptions,
		store,
		manifest,
		strings,
		problemCodes: PROBLEM_CODES,
		connections: {
			email: { label: 'Email provider', kind: 'secret', neededBy: ['email'], secretField: 'secret', ...provider('email') },
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
				neededBy: ['push', 'browser_push', 'staff_push'],
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
		},
		hooks: {
			...dataRights(now),
			// the Owner's Re-seal (RT-14): the sealed words of waiting messages in each website's merchant database
			resealWebsite: (data) => resealWebsite(sealer, data),
			// what the widgets need (GET /v1/widget/config): the public push key only, never a secret
			widgetConfig: async (ctx) => {
				const keys = await product.connections.value(/** @type {string} */ (ctx.websiteId), 'push_keys');
				return { pushPublicKey: isObject(keys) && typeof keys.publicKey === 'string' ? keys.publicKey : null };
			},
			blueprint: setupPart,
		},
		data: { indexes: INDEXES },
		sharedSettings: SHARED_SETTINGS,
		// the website Setup sheet: the API document and what the merchant's website builds per feature
		openapi,
		build: guide.build,
		// the lists (webhook URLs, topics, template settings, fallback channels, quiet hours): the settings API's
		// `GET|PUT /v1/lists/<name>` for the merchant's server (K1) and the dashboard's twin
		lists: lists.definitions(),
	});
	// the other products (the Portal's directory): whose template keys are theirs, and their messages with their
	// defaults (the dashboard's list; a send carries its own defaults)
	const defaults = createDefaults({
		products: () => product.products(),
		self: manifest.id,
		send,
		now,
		...(options.logger ? { logger: options.logger } : {}),
	});
	return Object.freeze({
		...product,
		providers,
		webpush,
		lists,
		sealer,
		now,
		send,
		defaults,
		logger: options.logger ?? noopLogger,
	});
};

/** @typedef {ReturnType<typeof createProductInstance>} Product */
