/**
 * Chat's list settings and the tool signing secret, in the product database (PLAN 0.8.3 Chat data): webhook tools,
 * flows, custom field definitions, proactive page rules, fallback answers (PLAN 0.8.10 C3), redaction patterns (C14),
 * teams (C12), the office hours with their dated exceptions (C9) and the page types (C6, seeded with the four kinds of
 * shop pages) are kept per website in the kit's settings collection (so a removed website's lists go with its
 * settings), each checked by its feature's rules and recorded in Recent changes. A list never saved answers its seed
 * (the starting entries every website gets; most lists start empty). The tool signing secret is sealed with
 * `ENCRYPTION_KEY`; it is made on first use and sealed again with the current key by the Owner's Re-seal
 * (`resealToolSecrets`).
 * @module
 */
import { checkFallbackAnswers } from '../core/fallback.js';
import { checkCustomFields, checkPageRules } from '../core/fields.js';
import { checkFlows } from '../core/flows.js';
import { checkOfficeExceptions, checkOfficeHours } from '../core/handoff.js';
import { checkRedactionPatterns } from '../core/moderation.js';
import { checkTeams } from '../core/routing.js';
import { PAGE_TYPE_SEED, checkPageTypes } from '../core/pages.js';
import { checkTools } from '../core/tools.js';
import { resealEach } from '@ss/app-kit';
import { randomToken } from '@ss/protocol';

/**
 * Each list: the feature it belongs to, its name on screens, its check and its seed (what a website that never saved
 * the list has).
 */
export const LISTS = Object.freeze({
	tools: { feature: 'webhook_tools', title: 'Webhook tools', check: checkTools, seed: [] },
	flows: { feature: 'leads_flows', title: 'Flows', check: checkFlows, seed: [] },
	custom_fields: { feature: 'custom_fields', title: 'Custom fields', check: checkCustomFields, seed: [] },
	page_rules: { feature: 'proactive_pages', title: 'Page rules', check: checkPageRules, seed: [] },
	fallback_answers: { feature: 'fallback_answers', title: 'Fallback answers', check: checkFallbackAnswers, seed: [] },
	redaction_patterns: { feature: 'moderation', title: 'Redaction patterns', check: checkRedactionPatterns, seed: [] },
	teams: { feature: 'assignment', title: 'Teams', check: checkTeams, seed: [] },
	office_hours: { feature: 'handoff', title: 'Office hours', check: checkOfficeHours, seed: [] },
	office_exceptions: { feature: 'handoff', title: 'Office hours exceptions', check: checkOfficeExceptions, seed: [] },
	page_types: { feature: 'visitor_chat', title: 'Page types', check: checkPageTypes, seed: PAGE_TYPE_SEED },
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
	 * The saved items of a list, else its seed (a copy).
	 * @param {string} websiteId
	 * @param {ListName} name
	 * @returns {Promise<any[]>}
	 */
	const get = async (websiteId, name) => {
		const doc = await store.get('settings', idOf(websiteId, `list.${name}`));
		return Array.isArray(doc?.value) ? doc.value : structuredClone(/** @type {unknown[]} */ (LISTS[name].seed));
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
