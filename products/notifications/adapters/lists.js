/**
 * Notifications' list setting `webhook_urls` (PLAN 0.8.10 N5): the webhook URLs of a website, each with the events it
 * takes, kept in the kit's settings collection of the product database (so a removed website's list goes with its
 * settings). The old setting `webhooks.urls` moves into the list on the list's first read: each of its URLs takes every
 * event, as before, and the old value is removed. Lists have no global defaults.
 * @module
 */
import { checkWebhookUrls, fromOldUrls } from '../core/webhooks.js';

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
	/** The old setting's saved value (the kit's id of a website setting). @param {string} websiteId */
	const oldIdOf = (websiteId) => `${websiteId}|setting|webhooks.urls`;
	/** @param {string} websiteId @param {WebhookUrl[]} value */
	const put = (websiteId, value) =>
		store.put('settings', idOf(websiteId), {
			websiteId,
			kind: 'notifications',
			key: 'list.webhook_urls',
			value,
			at: now(),
		});

	/**
	 * The website's webhook URLs (empty when none); the first read moves the old setting into the list.
	 * @param {string} websiteId
	 * @returns {Promise<WebhookUrl[]>}
	 */
	const webhookUrls = async (websiteId) => {
		const doc = await store.get('settings', idOf(websiteId));
		if (doc) return Array.isArray(doc.value) ? doc.value : [];
		const old = await store.get('settings', oldIdOf(websiteId));
		if (!old) return [];
		const value = fromOldUrls(old.value);
		await put(websiteId, value);
		await store.delete('settings', oldIdOf(websiteId));
		return value;
	};

	return Object.freeze({
		webhookUrls,
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
