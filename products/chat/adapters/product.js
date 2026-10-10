/**
 * The product on the kit: `createProductInstance(options)` wires `@ss/app-kit` `createProduct` with Chat's manifest
 * (each feature's settings schema from `schemas/` inline), its widget texts, its Connections (storage, the main and
 * backup AI providers, and the Accounts, Notifications and Ecommerce tokens), the merchant database indexes, the
 * data-rights hooks and the widget settings, and adds the AI providers, the list settings and the tool signing secret
 * (product database) on the same outbound policy. The Next.js route and the tests pass the rest (config, store, clock,
 * network). Public entry `./product` of this package, so a system test can compose the product with `./routes`.
 * @module
 */
import { createMemoryStore, createMongoStore, createProduct } from '@ss/app-kit';
import { createOutboundPolicy, safeFetch } from '@ss/net';
import { MongoClient } from 'mongodb';
import manifestFile from '../manifest.json' with { type: 'json' };
import strings from '../strings/en.json' with { type: 'json' };
import aiBackup from '../schemas/ai_backup.settings.json' with { type: 'json' };
import aiCaps from '../schemas/ai_caps.settings.json' with { type: 'json' };
import aiCostAlerts from '../schemas/ai_cost_alerts.settings.json' with { type: 'json' };
import aiInstructions from '../schemas/ai_instructions.settings.json' with { type: 'json' };
import aiReplies from '../schemas/ai_replies.settings.json' with { type: 'json' };
import aiSummary from '../schemas/ai_summary.settings.json' with { type: 'json' };
import assignment from '../schemas/assignment.settings.json' with { type: 'json' };
import attachments from '../schemas/attachments.settings.json' with { type: 'json' };
import bookSlot from '../schemas/book_slot.settings.json' with { type: 'json' };
import contextPanel from '../schemas/context_panel.settings.json' with { type: 'json' };
import customFields from '../schemas/custom_fields.settings.json' with { type: 'json' };
import guestChat from '../schemas/guest_chat.settings.json' with { type: 'json' };
import handoff from '../schemas/handoff.settings.json' with { type: 'json' };
import inbox from '../schemas/inbox.settings.json' with { type: 'json' };
import internalNotes from '../schemas/internal_notes.settings.json' with { type: 'json' };
import knowledgeBase from '../schemas/knowledge_base.settings.json' with { type: 'json' };
import knowledgeEditor from '../schemas/knowledge_editor.settings.json' with { type: 'json' };
import knowledgePages from '../schemas/knowledge_pages.settings.json' with { type: 'json' };
import languageLock from '../schemas/language_lock.settings.json' with { type: 'json' };
import leadsFlows from '../schemas/leads_flows.settings.json' with { type: 'json' };
import moderation from '../schemas/moderation.settings.json' with { type: 'json' };
import presenceQueue from '../schemas/presence_queue.settings.json' with { type: 'json' };
import productCards from '../schemas/product_cards.settings.json' with { type: 'json' };
import proactiveExit from '../schemas/proactive_exit.settings.json' with { type: 'json' };
import proactiveIdle from '../schemas/proactive_idle.settings.json' with { type: 'json' };
import proactivePages from '../schemas/proactive_pages.settings.json' with { type: 'json' };
import ratings from '../schemas/ratings.settings.json' with { type: 'json' };
import reports from '../schemas/reports.settings.json' with { type: 'json' };
import savedReplies from '../schemas/saved_replies.settings.json' with { type: 'json' };
import shopDeals from '../schemas/shop_deals.settings.json' with { type: 'json' };
import shopMyOrders from '../schemas/shop_my_orders.settings.json' with { type: 'json' };
import shopSearch from '../schemas/shop_search.settings.json' with { type: 'json' };
import shopTop from '../schemas/shop_top.settings.json' with { type: 'json' };
import signedInChat from '../schemas/signed_in_chat.settings.json' with { type: 'json' };
import staffAlerts from '../schemas/staff_alerts.settings.json' with { type: 'json' };
import trackShipment from '../schemas/track_shipment.settings.json' with { type: 'json' };
import transcripts from '../schemas/transcripts.settings.json' with { type: 'json' };
import typingReceipts from '../schemas/typing_receipts.settings.json' with { type: 'json' };
import visitorChat from '../schemas/visitor_chat.settings.json' with { type: 'json' };
import webhookTools from '../schemas/webhook_tools.settings.json' with { type: 'json' };
import { createAi } from './ai.js';
import { createSealer } from './crypto.js';
import { LISTS, createLists } from './lists.js';
import { INDEXES, createStore } from './store.js';

/** Settings schema of each feature (manifest.json points at them with `$ref`). @type {Record<string, unknown>} */
const SETTINGS = {
	visitor_chat: visitorChat,
	guest_chat: guestChat,
	signed_in_chat: signedInChat,
	ai_replies: aiReplies,
	ai_backup: aiBackup,
	ai_instructions: aiInstructions,
	ai_caps: aiCaps,
	ai_cost_alerts: aiCostAlerts,
	language_lock: languageLock,
	knowledge_base: knowledgeBase,
	knowledge_pages: knowledgePages,
	knowledge_editor: knowledgeEditor,
	webhook_tools: webhookTools,
	book_slot: bookSlot,
	shop_search: shopSearch,
	shop_deals: shopDeals,
	shop_top: shopTop,
	shop_my_orders: shopMyOrders,
	track_shipment: trackShipment,
	product_cards: productCards,
	proactive_idle: proactiveIdle,
	proactive_pages: proactivePages,
	proactive_exit: proactiveExit,
	leads_flows: leadsFlows,
	custom_fields: customFields,
	attachments,
	typing_receipts: typingReceipts,
	ratings,
	transcripts,
	inbox,
	handoff,
	assignment,
	presence_queue: presenceQueue,
	internal_notes: internalNotes,
	saved_replies: savedReplies,
	context_panel: contextPanel,
	ai_summary: aiSummary,
	staff_alerts: staffAlerts,
	moderation,
	reports,
};

/** The manifest as the kit and the Portal take it: settings schemas inline. */
export const manifest = /** @type {import('@ss/contracts').Manifest} */ (
	/** @type {unknown} */ ({
		...manifestFile,
		features: manifestFile.features.map((feature) => ({ ...feature, settings: SETTINGS[feature.key] })),
	})
);

export { strings };

/** Chat's own problem codes. */
const PROBLEM_CODES = Object.freeze({
	sign_in_required: Object.freeze({ status: 403, title: 'Sign in to chat' }),
	guest_limit_reached: Object.freeze({ status: 403, title: 'Guest message limit reached' }),
	message_rejected: Object.freeze({ status: 422, title: 'Message rejected' }),
	notifications_not_connected: Object.freeze({ status: 503, title: 'Notifications not connected' }),
	not_sent: Object.freeze({ status: 502, title: 'Not sent' }),
	staff_full: Object.freeze({ status: 409, title: 'This person has the most chats they can take' }),
	storage_not_connected: Object.freeze({ status: 503, title: 'Storage not connected' }),
	ai_unavailable: Object.freeze({ status: 503, title: 'The AI cannot answer now' }),
});

/** The fallback key a misconfigured product builds its sealer with (it answers 503 everywhere anyway). */
const UNCONFIGURED_KEY = 'unconfigured-chat-encryption-key-0000000000';

/**
 * @typedef {Omit<import('@ss/app-kit').ProductOptions, 'manifest' | 'strings' | 'hooks' | 'connections' | 'data' | 'problemCodes'>
 *   & { hooks?: { exportUser: NonNullable<import('@ss/app-kit').ProductOptions['hooks']>['exportUser'], deleteUser: NonNullable<import('@ss/app-kit').ProductOptions['hooks']>['deleteUser'], widgetConfig: NonNullable<import('@ss/app-kit').ProductOptions['hooks']>['widgetConfig'] } }} InstanceOptions
 */

/**
 * The product (kit routes, status, settings, connections, merchant database …) plus its AI providers, list settings,
 * product-database counters and outbound `send`. Data-rights and widget-config hooks are attached by api/routes.js
 * through `attach`.
 * @param {InstanceOptions} options at least `config` and `problems` from `configFromEnv()`
 */
export const createProductInstance = (options) => {
	const now = options.now ?? Date.now;
	const production = (options.nodeEnv ?? process.env.NODE_ENV) === 'production';
	const healthy = (options.problems ?? []).length === 0;
	const uri = options.config?.mongodbUri;
	// Chat keeps its list settings and visitor counters in the product database too, so it owns the store
	const store =
		options.store ??
		(healthy && uri
			? createMongoStore({ db: new MongoClient(uri, { maxPoolSize: 5, minPoolSize: 0, maxIdleTimeMS: 60_000 }).db(), now })
			: createMemoryStore({ now }));
	const { allowHosts = [], ...outboundRest } = options.outbound ?? {};
	const policy = createOutboundPolicy({ ...outboundRest, allowHosts: production ? [] : allowHosts });
	/** @type {import('./ai.js').Send} */
	const send = options.outboundSend ?? ((url, init) => safeFetch(url, init, policy));
	const sealer = createSealer(options.config?.encryptionKey ?? UNCONFIGURED_KEY);
	const ai = createAi({ send });
	const lists = createLists({ store, sealer, now });
	/** @type {NonNullable<import('@ss/app-kit').ProductOptions['hooks']>} */
	const hooks = {};

	const product = createProduct({
		...options,
		store,
		manifest,
		strings,
		problemCodes: PROBLEM_CODES,
		connections: {
			storage: { label: 'Storage (S3-compatible)', kind: 'storage', neededBy: ['attachments'] },
			ai: { label: 'AI provider', kind: 'secret', neededBy: ['ai_replies'], secretField: 'apiKey', test: ai.test },
			ai_backup: {
				label: 'Backup AI provider',
				kind: 'secret',
				neededBy: ['ai_backup'],
				secretField: 'apiKey',
				test: ai.test,
			},
			accounts: {
				label: 'Accounts token (signed-in visitors, activity-log copies)',
				kind: 'token',
				productId: 'accounts',
				neededBy: ['signed_in_chat'],
			},
			notifications: {
				label: 'Notifications token (staff alerts, transcripts, AI cost alerts)',
				kind: 'token',
				productId: 'notifications',
				neededBy: ['ai_cost_alerts', 'transcripts', 'staff_alerts'],
			},
			ecommerce: {
				label: 'Ecommerce token (shop tools, track shipment, product cards, shop info in the context panel)',
				kind: 'token',
				productId: 'ecommerce',
				neededBy: ['shop_search', 'shop_deals', 'shop_top', 'shop_my_orders', 'track_shipment', 'product_cards'],
			},
		},
		// the routes fill these in (they need the merchant database store and the services)
		hooks: {
			exportUser: (ctx, user) => /** @type {NonNullable<typeof hooks.exportUser>} */ (hooks.exportUser)(ctx, user),
			deleteUser: (ctx, user) => /** @type {NonNullable<typeof hooks.deleteUser>} */ (hooks.deleteUser)(ctx, user),
			widgetConfig: (ctx) => /** @type {NonNullable<typeof hooks.widgetConfig>} */ (hooks.widgetConfig)(ctx),
		},
		data: { indexes: INDEXES },
		// the settings API's `GET|PUT /v1/lists/:list` for the merchant's server (K1), checked like the dashboard's
		lists: Object.fromEntries(
			/** @type {import('./lists.js').ListName[]} */ (Object.keys(LISTS)).map((name) => [
				name,
				{
					feature: LISTS[name].feature,
					title: LISTS[name].title,
					get: (/** @type {string} */ websiteId) => lists.get(websiteId, name),
					save: (/** @type {string} */ websiteId, /** @type {unknown} */ value) => lists.save(websiteId, name, value),
				},
			]),
		),
	});
	return Object.freeze({
		...product,
		ai,
		lists,
		counters: store,
		send,
		now,
		/**
		 * The merchant database store of a request's website.
		 * @param {{ data: () => Promise<import('@ss/app-kit').WebsiteData> }} ctx
		 */
		storeOf: async (ctx) => createStore(await ctx.data(), { now }),
		/** Attach the data-rights and widget-config hooks (api/routes.js). @param {NonNullable<import('@ss/app-kit').ProductOptions['hooks']>} attached */
		attach: (attached) => Object.assign(hooks, attached),
	});
};

/** @typedef {ReturnType<typeof createProductInstance>} Product */
