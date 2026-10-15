/**
 * Notifications' list settings, kept in the kit's settings collection of the product database (so a removed website's
 * lists go with its settings) and served by the kit (`GET|PUT /v1/lists/<name>` with the server token, and the
 * dashboard twin):
 * - `webhook_urls` (PLAN 0.8.10 N5): the webhook URLs, each with the events it takes (at most the setting
 *   `webhooks.maxUrls`);
 * - `topics` (fixed-choices N2): the unsubscribe topics recipients choose from;
 * - `template_settings` (N2, N5, N7): per template key its topic, its fallback channels and whether send limits count it;
 * - `fallback_chains` (N7): the website's fallback channels per channel, in order;
 * - `quiet_hours` (N6): the quiet windows per weekday and channel (default: every day 21:00–08:00);
 * - `stop_keywords` (N4): the unsubscribe keywords per language of SMS and WhatsApp replies (default: STOP and
 *   UNSUBSCRIBE in English).
 * A list never saved reads as its default.
 * @module
 */
import { checkFallbackChains, checkQuietHours, checkStopKeywords, checkTemplateSettings, checkTopics } from '../core/choices.js';
import { DEFAULT_STOP_KEYWORDS } from '../core/inbound.js';
import { DEFAULT_QUIET_HOURS } from '../core/timing.js';
import { checkWebhookUrls } from '../core/webhooks.js';

/** @typedef {import('../core/webhooks.js').WebhookUrl} WebhookUrl */
/** @typedef {import('../core/choices.js').Topic} Topic */
/** @typedef {import('../core/choices.js').TemplateSettings} TemplateSettings */
/** @typedef {import('../core/choices.js').FallbackChain} FallbackChain */
/** @typedef {import('../core/timing.js').QuietWindow} QuietWindow */
/** @typedef {{ ok: true, value: unknown } | { ok: false, errors: Array<{ path: string, message: string }> }} Saved */

/** The features that send to the website's customers (their topics and template settings apply). */
const SENDING_FEATURES = Object.freeze(['email', 'sms', 'whatsapp', 'browser_push', 'staff_push', 'send_api']);

/** Each list: the feature(s) it belongs to (any of them on) and its name on screens. */
export const LISTS = Object.freeze({
	webhook_urls: Object.freeze({ feature: 'webhooks', title: 'Webhook URLs' }),
	topics: Object.freeze({ feature: ['email', 'sms', 'whatsapp', 'browser_push'], title: 'Unsubscribe topics' }),
	template_settings: Object.freeze({ feature: SENDING_FEATURES, title: 'Template settings' }),
	fallback_chains: Object.freeze({ feature: 'fallback', title: 'Fallback channels' }),
	quiet_hours: Object.freeze({ feature: 'quiet_hours', title: 'Quiet hours' }),
	stop_keywords: Object.freeze({ feature: ['sms', 'whatsapp'], title: 'Unsubscribe keywords' }),
});

/** @typedef {keyof typeof LISTS} ListName */

/** What a list reads as before it is saved. @type {{ [name in ListName]: unknown }} */
const DEFAULTS = Object.freeze({
	webhook_urls: [],
	topics: [],
	template_settings: [],
	fallback_chains: [],
	quiet_hours: DEFAULT_QUIET_HOURS,
	stop_keywords: DEFAULT_STOP_KEYWORDS,
});

/**
 * @param {{ store: import('@ss/app-kit').Store, now: () => number,
 *   maxWebhookUrls: (websiteId: string) => Promise<number> }} options `maxWebhookUrls`: the setting `webhooks.maxUrls`
 */
export const createLists = ({ store, now, maxWebhookUrls }) => {
	/** @param {string} websiteId @param {ListName} name */
	const idOf = (websiteId, name) => `${websiteId}|notifications|list.${name}`;

	/**
	 * A list as saved, else its default (a fresh copy).
	 * @param {ListName} name
	 * @param {string} websiteId
	 * @returns {Promise<any[]>}
	 */
	const read = async (name, websiteId) => {
		const doc = await store.get('settings', idOf(websiteId, name));
		return doc && Array.isArray(doc.value) ? doc.value : structuredClone(/** @type {any[]} */ (DEFAULTS[name]));
	};

	/** @param {ListName} name @param {string} websiteId @param {unknown} value */
	const put = (name, websiteId, value) =>
		store.put('settings', idOf(websiteId, name), {
			websiteId,
			kind: 'notifications',
			key: `list.${name}`,
			value,
			at: now(),
		});

	/**
	 * The check of each list (some read another list or a setting).
	 * @type {{ [name in ListName]: (websiteId: string, value: unknown) => Promise<Saved> }}
	 */
	const checks = {
		webhook_urls: async (websiteId, value) => checkWebhookUrls(value, { max: await maxWebhookUrls(websiteId) }),
		topics: async (_websiteId, value) => checkTopics(value),
		template_settings: async (websiteId, value) =>
			checkTemplateSettings(
				value,
				(await read('topics', websiteId)).map((/** @type {Topic} */ topic) => topic.id),
			),
		fallback_chains: async (_websiteId, value) => checkFallbackChains(value),
		quiet_hours: async (_websiteId, value) => checkQuietHours(value),
		stop_keywords: async (_websiteId, value) => checkStopKeywords(value),
	};

	/**
	 * Check and save a list whole.
	 * @param {ListName} name
	 * @param {string} websiteId
	 * @param {unknown} value
	 * @returns {Promise<Saved>}
	 */
	const save = async (name, websiteId, value) => {
		const checked = await checks[name](websiteId, value);
		if (checked.ok) await put(name, websiteId, checked.value);
		return checked;
	};

	return Object.freeze({
		read,
		save,
		/** @param {string} websiteId @returns {Promise<WebhookUrl[]>} */
		webhookUrls: (websiteId) => read('webhook_urls', websiteId),
		/** @param {string} websiteId @returns {Promise<Topic[]>} */
		topics: (websiteId) => read('topics', websiteId),
		/** @param {string} websiteId @returns {Promise<TemplateSettings[]>} */
		templateSettings: (websiteId) => read('template_settings', websiteId),
		/** @param {string} websiteId @returns {Promise<FallbackChain[]>} */
		fallbackChains: (websiteId) => read('fallback_chains', websiteId),
		/** @param {string} websiteId @returns {Promise<QuietWindow[]>} */
		quietHours: (websiteId) => read('quiet_hours', websiteId),
		/** @param {string} websiteId @returns {Promise<import('../core/inbound.js').StopKeywords[]>} */
		stopKeywords: (websiteId) => read('stop_keywords', websiteId),
		/**
		 * The lists as the kit serves them (`GET|PUT /v1/lists/<name>` and the dashboard twin).
		 * @returns {Record<string, import('@ss/app-kit').ListDefinition>}
		 */
		definitions: () =>
			Object.fromEntries(
				/** @type {ListName[]} */ (Object.keys(LISTS)).map((name) => [
					name,
					{
						feature: [LISTS[name].feature].flat(),
						title: LISTS[name].title,
						get: (/** @type {string} */ websiteId) => read(name, websiteId),
						save: (/** @type {string} */ websiteId, /** @type {unknown} */ value) => save(name, websiteId, value),
					},
				]),
			),
	});
};

/** @typedef {ReturnType<typeof createLists>} Lists */
