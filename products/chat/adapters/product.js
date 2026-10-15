/**
 * The product on the kit: `createProductInstance(options)` wires `@ss/app-kit` `createProduct` with Chat's manifest
 * (each feature's settings schema from `schemas/` inline), its widget texts, its Connections (storage, the main and
 * backup AI providers, and the Accounts, Notifications and Ecommerce tokens), the merchant database indexes, the
 * data-rights hooks, the widget settings, what the `import` feature takes (`imports.js`) and its part of the website
 * Setup sheet (the OpenAPI document, the guide's "What your website builds" per feature, its lists in its own words and
 * who answers visitors), and adds the AI providers, the list settings and the tool signing secret (product database) on
 * the kit's start-up pieces (`createProductBase`: the store and the outbound `send`). The Next.js route and the tests pass the rest (config, store, clock, network).
 * Public entry `./product` of this package, so a system test can compose the product with `./routes`.
 * @module
 */
import { createProduct, createProductBase } from '@ss/app-kit';
import guide from '../docs/guide.json' with { type: 'json' };
import manifestFile from '../manifest.json' with { type: 'json' };
import openapi from '../openapi.json' with { type: 'json' };
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
import fallbackAnswers from '../schemas/fallback_answers.settings.json' with { type: 'json' };
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
import shopContext from '../schemas/shop_context.settings.json' with { type: 'json' };
import shopSearch from '../schemas/shop_search.settings.json' with { type: 'json' };
import shopTop from '../schemas/shop_top.settings.json' with { type: 'json' };
import signedInChat from '../schemas/signed_in_chat.settings.json' with { type: 'json' };
import staffAlerts from '../schemas/staff_alerts.settings.json' with { type: 'json' };
import trackShipment from '../schemas/track_shipment.settings.json' with { type: 'json' };
import transcripts from '../schemas/transcripts.settings.json' with { type: 'json' };
import typingReceipts from '../schemas/typing_receipts.settings.json' with { type: 'json' };
import visitorAlerts from '../schemas/visitor_alerts.settings.json' with { type: 'json' };
import visitorChat from '../schemas/visitor_chat.settings.json' with { type: 'json' };
import webhookTools from '../schemas/webhook_tools.settings.json' with { type: 'json' };
import importSettings from '../schemas/import.settings.json' with { type: 'json' };
import messages from '../schemas/messages.json' with { type: 'json' };
import { createAi } from './ai.js';
import { createFileSigner, createSealer } from './crypto.js';
import { createImportOptions } from './imports.js';
import { LISTS, createLists } from './lists.js';
import { INDEXES } from './store.js';

/** Settings schema of each feature (manifest.json points at them with `$ref`). @type {Record<string, unknown>} */
const SETTINGS = {
	visitor_chat: visitorChat,
	guest_chat: guestChat,
	signed_in_chat: signedInChat,
	ai_replies: aiReplies,
	ai_backup: aiBackup,
	ai_instructions: aiInstructions,
	fallback_answers: fallbackAnswers,
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
	shop_context: shopContext,
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
	visitor_alerts: visitorAlerts,
	moderation,
	reports,
	import: importSettings,
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

/** Longest list summary on the Setup sheet (the kit's limit). */
const LIST_SUMMARY_MAX = 300;

/** @param {number} count @param {string} one @param {string} many */
const counted = (count, one, many) => `${count} ${count === 1 ? one : many}`;

/**
 * A list counted and named (`2 tools: check_stock, track_order.`): as many names as fit in a list summary, the rest
 * counted (`and 3 more`).
 * @param {string} one
 * @param {string} many
 * @param {any[]} items
 * @param {(item: any) => string} nameOf
 */
const namedList = (one, many, items, nameOf) => {
	if (items.length === 0) return `No ${many} yet.`;
	const names = items.map(nameOf);
	/** @param {number} shown */
	const text = (shown) =>
		`${counted(names.length, one, many)}: ${names.slice(0, shown).join(', ')}${shown < names.length ? ` and ${names.length - shown} more` : ''}.`;
	let shown = names.length;
	while (shown > 1 && text(shown).length > LIST_SUMMARY_MAX) shown -= 1;
	return text(shown);
};

/** @param {string} one @param {string} many @param {unknown[]} items */
const countedList = (one, many, items) => (items.length === 0 ? `No ${many} yet.` : `${counted(items.length, one, many)}.`);

/**
 * Flows by how they start (`3 flows: 2 start on a page, 1 on a keyword.`).
 * @param {import('../core/flows.js').Flow[]} flows
 */
const flowsText = (flows) => {
	if (flows.length === 0) return 'No flows yet.';
	const starts = /** @type {const} */ (['page', 'keyword'])
		.map((kind) => ({ kind, count: flows.filter((flow) => flow.start.kind === kind).length }))
		.filter(({ count }) => count > 0)
		.map(({ kind, count }, index) => `${index === 0 ? counted(count, 'starts', 'start') : count} on a ${kind}`);
	return `${counted(flows.length, 'flow', 'flows')}: ${starts.join(', ')}.`;
};

/**
 * Each list in Chat's own words: tools by name (never their addresses), custom fields by label, flows by how they
 * start, page rules and fallback answers counted.
 * @type {Record<import('./lists.js').ListName, (items: any[]) => string>}
 */
const LIST_WORDS = {
	tools: (tools) => namedList('tool', 'tools', tools, (tool) => tool.name),
	flows: flowsText,
	custom_fields: (fields) => namedList('field', 'fields', fields, (field) => field.label),
	page_rules: (rules) => countedList('page rule', 'page rules', rules),
	fallback_answers: (answers) => countedList('answer', 'answers', answers),
};

/**
 * Who answers visitors, from the features that are on (handoff needs the inbox).
 * @param {string[]} on
 */
const whoAnswers = (on) => {
	if (on.includes('ai_replies'))
		return on.includes('handoff')
			? 'The AI answers first and hands a conversation to your staff when needed.'
			: on.includes('inbox')
				? 'The AI answers every visitor; your staff can also answer in the inbox.'
				: 'The AI answers every visitor.';
	return on.includes('inbox') ? 'Your staff answer in the inbox.' : 'Nobody answers yet: switch on AI replies or the inbox.';
};

/**
 * Chat's own part of the website Setup sheet: the lists of the features that are on in its own words (a list that
 * cannot be read is left out, so the kit shows its own count) and who answers visitors. Nothing from Connections;
 * Chat publishes no events.
 * @param {import('./lists.js').Lists} lists
 * @param {{ websiteId: string, on: string[] }} website
 */
const setupPart = async (lists, { websiteId, on }) => {
	const names = /** @type {import('./lists.js').ListName[]} */ (Object.keys(LISTS)).filter((name) =>
		on.includes(LISTS[name].feature),
	);
	const worded = await Promise.all(
		names.map(async (name) => {
			try {
				return /** @type {[string, string]} */ ([name, LIST_WORDS[name](await lists.get(websiteId, name))]);
			} catch {
				return null;
			}
		}),
	);
	return {
		lists: Object.fromEntries(worded.filter((entry) => entry !== null)),
		summaries: [{ title: 'Who answers', text: whoAnswers(on) }],
	};
};

/**
 * What the Next.js route and the tests pass: every option but those the adapter sets itself.
 * @typedef {Omit<import('@ss/app-kit').ProductOptions, 'manifest' | 'strings' | 'hooks' | 'connections' | 'data'
 *   | 'problemCodes' | 'messages' | 'imports' | 'lists' | 'openapi' | 'build'>} InstanceOptions
 */

/**
 * The product (kit routes, status, settings, connections, merchant database …) plus its AI providers, list settings,
 * product-database counters and outbound `send`. Data-rights and widget-config hooks are attached by server/routes.js
 * through `attach`.
 * @param {InstanceOptions} options at least `config` and `problems` from `configFromEnv()`
 */
export const createProductInstance = (options) => {
	const now = options.now ?? Date.now;
	const healthy = (options.problems ?? []).length === 0;
	// Chat keeps its list settings and visitor counters in the product database too: the kit's store, shared with it
	const { store, send } = createProductBase(options);
	const keys = healthy ? options.config : undefined;
	const sealer = createSealer(keys?.encryptionKey ?? UNCONFIGURED_KEY, keys?.previousEncryptionKey ?? null);
	const files = createFileSigner(keys?.encryptionKey ?? UNCONFIGURED_KEY, keys?.previousEncryptionKey ?? null);
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
		// staff alerts, transcripts and reply alerts with their default words: every send to Notifications carries them
		// (parity P1)
		messages,
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
				label: 'Accounts token (signed-in visitors, the guest limit while customer sign-in is paused, activity-log copies)',
				kind: 'token',
				productId: 'accounts',
				neededBy: ['signed_in_chat'],
			},
			notifications: {
				label: 'Notifications token (staff alerts, reply alerts to visitors, transcripts, AI cost alerts)',
				kind: 'token',
				productId: 'notifications',
				neededBy: ['ai_cost_alerts', 'transcripts', 'staff_alerts', 'visitor_alerts'],
			},
			ecommerce: {
				label: 'Ecommerce token (shop tools, track shipment, product cards, store context, shop info in the context panel)',
				kind: 'token',
				productId: 'ecommerce',
				neededBy: [
					'shop_search',
					'shop_deals',
					'shop_top',
					'shop_my_orders',
					'track_shipment',
					'product_cards',
					'shop_context',
				],
			},
		},
		// the routes fill these in (they need the merchant database store and the services)
		hooks: {
			exportUser: (ctx, user) => /** @type {NonNullable<typeof hooks.exportUser>} */ (hooks.exportUser)(ctx, user),
			deleteUser: (ctx, user) => /** @type {NonNullable<typeof hooks.deleteUser>} */ (hooks.deleteUser)(ctx, user),
			widgetConfig: (ctx) => /** @type {NonNullable<typeof hooks.widgetConfig>} */ (hooks.widgetConfig)(ctx),
			// the Owner's Re-seal (RT-14): the tool signing secrets in the product database
			resealProduct: () => lists.resealToolSecrets(),
			// its part of the website Setup sheet in its own words (lists, who answers); never secrets
			blueprint: (website) => setupPart(lists, website),
		},
		data: { indexes: INDEXES },
		// the website Setup sheet: the API document and what the merchant's website builds per feature
		openapi,
		build: guide.build,
		// staff, guests, conversations and messages moved in from another system with ss-import (feature `import`,
		// PLAN 0.8.10 K10)
		imports: createImportOptions({
			settings: (websiteId, feature) => product.settings.values(websiteId, feature),
			list: (websiteId, name) => lists.get(websiteId, name),
			business: (websiteId) => product.business(websiteId),
		}),
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
		/** Stable attachment links (CH-8). */
		files,
		counters: store,
		send,
		now,
		/** Attach the data-rights and widget-config hooks (server/routes.js). @param {NonNullable<import('@ss/app-kit').ProductOptions['hooks']>} attached */
		attach: (attached) => Object.assign(hooks, attached),
	});
};

/** @typedef {ReturnType<typeof createProductInstance>} Product */
