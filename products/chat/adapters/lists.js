/**
 * Chat's list settings and the tool signing secret, in the product database (PLAN 0.8.3 Chat data): webhook tools,
 * flows, custom field definitions, proactive page rules and fallback answers (PLAN 0.8.10 C3) are kept per website in the kit's settings collection (so
 * a removed website's lists go with its settings), each checked by its feature's rules and recorded in Recent changes.
 * Lists have no global defaults. The tool signing secret is sealed with `ENCRYPTION_KEY`; it is made on first use and
 * sealed again with the current key by the Owner's Re-seal (`resealToolSecrets`).
 * @module
 */
import { checkFallbackAnswers } from '../core/fallback.js';
import { checkCustomFields, checkPageRules } from '../core/fields.js';
import { checkFlows } from '../core/flows.js';
import { checkTools } from '../core/tools.js';
import { resealEach } from '@ss/app-kit';
import { randomToken } from '@ss/protocol';

/** Each list: the feature it belongs to, its name on screens, and its check. */
export const LISTS = Object.freeze({
	tools: { feature: 'webhook_tools', title: 'Webhook tools', check: checkTools },
	flows: { feature: 'leads_flows', title: 'Flows', check: checkFlows },
	custom_fields: { feature: 'custom_fields', title: 'Custom fields', check: checkCustomFields },
	page_rules: { feature: 'proactive_pages', title: 'Page rules', check: checkPageRules },
	fallback_answers: { feature: 'fallback_answers', title: 'Fallback answers', check: checkFallbackAnswers },
});

/** @typedef {keyof typeof LISTS} ListName */

/**
 * @param {{ store: import('@ss/app-kit').Store, sealer: import('./crypto.js').Sealer, now: () => number }} options
 */
export const createLists = ({ store, sealer, now }) => {
	/** @param {string} websiteId @param {string} key */
	const idOf = (websiteId, key) => `${websiteId}|chat|${key}`;
	/** @param {string} websiteId */
	const toolSecretAad = (websiteId) => `chat|tool-secret|${websiteId}`;

	/**
	 * The saved items of a list (empty when none).
	 * @param {string} websiteId
	 * @param {ListName} name
	 * @returns {Promise<any[]>}
	 */
	const get = async (websiteId, name) => {
		const doc = await store.get('settings', idOf(websiteId, `list.${name}`));
		return Array.isArray(doc?.value) ? doc.value : [];
	};

	return Object.freeze({
		get,
		/**
		 * Check and save a list.
		 * @param {string} websiteId
		 * @param {ListName} name
		 * @param {unknown} items
		 * @returns {Promise<{ ok: true, value: any[] } | { ok: false, errors: string[] }>}
		 */
		save: async (websiteId, name, items) => {
			const checked = LISTS[name].check(items);
			if (!checked.ok) return checked;
			await store.put('settings', idOf(websiteId, `list.${name}`), {
				websiteId,
				kind: 'chat',
				key: `list.${name}`,
				value: checked.value,
				at: now(),
			});
			return checked;
		},
		/**
		 * The website's tool signing secret (made on first use, or again when `ENCRYPTION_KEY` changed).
		 * @param {string} websiteId
		 * @param {{ regenerate?: boolean }} [options]
		 */
		toolSecret: async (websiteId, { regenerate = false } = {}) => {
			const id = idOf(websiteId, 'tool-secret');
			const aad = toolSecretAad(websiteId);
			const opened = regenerate ? null : sealer.open((await store.get('settings', id))?.value, aad);
			if (opened) return opened;
			const secret = `whsec_${randomToken(32)}`;
			await store.put('settings', id, {
				websiteId,
				kind: 'chat',
				key: 'tool-secret',
				value: sealer.seal(secret, aad),
				at: now(),
			});
			return secret;
		},
		/**
		 * The Owner's Re-seal (RT-14): every website's tool signing secret sealed again with the current key.
		 * @returns {Promise<import('@ss/app-kit').ResealCounts>}
		 */
		resealToolSecrets: async () =>
			resealEach(
				sealer,
				(await store.list('settings', { kind: 'chat', key: 'tool-secret' }, { limit: 100_000 })).map((doc) => ({
					sealed: doc.value,
					aad: toolSecretAad(doc.websiteId),
					save: async (/** @type {string} */ next) => {
						const id = idOf(doc.websiteId, 'tool-secret');
						if ((await store.get('settings', id))?.value === doc.value)
							await store.put('settings', id, { ...doc, value: next });
					},
				})),
			),
	});
};

/** @typedef {ReturnType<typeof createLists>} Lists */
