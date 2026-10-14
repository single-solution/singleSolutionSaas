/**
 * Notifications' list setting `webhook_urls` (PLAN 0.8.10 N5): the webhook URLs of a website, each with the events it
 * takes, kept in the kit's settings collection of the product database (so a removed website's list goes with its
 * settings). Lists have no global defaults.
 * @module
 */
import { checkWebhookUrls } from '../core/webhooks.js';

/** @typedef {import('../core/webhooks.js').WebhookUrl} WebhookUrl */

/** Each list: the feature it belongs to and its name on screens. */
export const LISTS = Object.freeze({
	webhook_urls: Object.freeze({ feature: 'webhooks', title: 'Webhook URLs' }),
});

/**
 * @param {{ store: import('@ss/app-kit').Store, now: () => number }} options
 */
export const createLists = ({ store, now }) => {
	/** @param {string} websiteId */
	const idOf = (websiteId) => `${websiteId}|notifications|list.webhook_urls`;
	/** @param {string} websiteId @param {WebhookUrl[]} value */
	const put = (websiteId, value) =>
		store.put('settings', idOf(websiteId), {
			websiteId,
			kind: 'notifications',
			key: 'list.webhook_urls',
			value,
			at: now(),
		});

	return Object.freeze({
		/**
		 * The website's webhook URLs (empty when none).
		 * @param {string} websiteId
		 * @returns {Promise<WebhookUrl[]>}
		 */
		webhookUrls: async (websiteId) => {
			const doc = await store.get('settings', idOf(websiteId));
			return doc && Array.isArray(doc.value) ? doc.value : [];
		},
		/**
		 * Check and save the webhook URLs whole.
		 * @param {string} websiteId
		 * @param {unknown} value
		 */
		saveWebhookUrls: async (websiteId, value) => {
			const checked = checkWebhookUrls(value);
			if (checked.ok) await put(websiteId, checked.value);
			return checked;
		},
	});
};

/** @typedef {ReturnType<typeof createLists>} Lists */
