/**
 * Chat's list settings and the tool signing secret, in the product database (PLAN 0.8.3 Chat data): webhook tools,
 * flows, custom field definitions and proactive page rules are kept per website in the kit's settings collection (so
 * a removed website's lists go with its settings), each checked by its feature's rules and recorded in Recent changes.
 * Lists have no global defaults. The tool signing secret is sealed with `ENCRYPTION_KEY`; it is made on first use.
 * @module
 */
import { checkCustomFields, checkPageRules } from '../core/fields.js';
import { checkFlows } from '../core/flows.js';
import { checkTools } from '../core/tools.js';
import { randomSecret } from './crypto.js';

/** Each list: the feature it belongs to, its name on screens, and its check. */
export const LISTS = Object.freeze({
	tools: { feature: 'webhook_tools', title: 'Webhook tools', check: checkTools },
	flows: { feature: 'leads_flows', title: 'Flows', check: checkFlows },
	custom_fields: { feature: 'custom_fields', title: 'Custom fields', check: checkCustomFields },
	page_rules: { feature: 'proactive_pages', title: 'Page rules', check: checkPageRules },
});

/** @typedef {keyof typeof LISTS} ListName */

/**
 * @param {{ store: import('@ss/app-kit').Store, sealer: import('./crypto.js').Sealer, now: () => number }} options
 */
export const createLists = ({ store, sealer, now }) => {
	/** @param {string} websiteId @param {string} key */
	const idOf = (websiteId, key) => `${websiteId}|chat|${key}`;

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
			const aad = `chat|tool-secret|${websiteId}`;
			const opened = regenerate ? null : sealer.open((await store.get('settings', id))?.value, aad);
			if (opened) return opened;
			const secret = `whsec_${randomSecret(32)}`;
			await store.put('settings', id, {
				websiteId,
				kind: 'chat',
				key: 'tool-secret',
				value: sealer.seal(secret, aad),
				at: now(),
			});
			return secret;
		},
	});
};

/** @typedef {ReturnType<typeof createLists>} Lists */
