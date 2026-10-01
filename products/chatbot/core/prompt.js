/**
 * System prompt (pure), layered as in ibrahimMobiles but international and merchant-neutral:
 *
 *   1. language lock (the customer's language for THIS message, detected server-side);
 *   2. the product's safety rules — from the string catalog, never removable by merchant instructions;
 *   3. persona and tone, forbidden topics, escalation state;
 *   4. live, server-chosen data only: retrieved knowledge passages, who the customer is (verified or guest), the page;
 *   5. the merchant's instructions.
 *
 * The real boundary is (4): the model can only reveal what the server put in the prompt or a tool returned.
 * @module
 */
import { languageName } from './language.js';

/** Number of core rules in the catalog (`ai.rule.1` … `ai.rule.N`). */
export const CORE_RULE_COUNT = 9;

/** @typedef {(key: string, params?: Record<string, string | number>) => string} Translate */
/**
 * @typedef {object} PromptInput
 * @property {Translate} t
 * @property {string} assistantName
 * @property {string} language BCP 47 tag the answer must use
 * @property {boolean} languageLock
 * @property {string} tone
 * @property {string} instructions merchant instructions
 * @property {boolean} presentAsHuman
 * @property {string[]} forbiddenTopics
 * @property {'short' | 'medium' | 'long'} answerLength
 * @property {string} bubbleSeparator
 * @property {number} maxBubbles
 * @property {'none' | 'inline' | 'footnote'} citationStyle
 * @property {Array<{ ref: number, title: string, url: string | null, text: string }>} passages
 * @property {boolean} groundedOnly
 * @property {{ identified: boolean, name?: string | null }} customer
 * @property {{ path?: string, title?: string } | null} page
 * @property {boolean} awaitingHuman
 * @property {string[]} toolNames
 * @property {string | null} [step] instruction of a flow AI step
 * @property {string | null} [websiteDomain]
 */

/**
 * @param {PromptInput} input
 * @returns {string}
 */
export const buildSystemPrompt = (input) => {
	const { t } = input;
	const lines = [];
	if (input.languageLock) {
		const name = languageName(input.language);
		lines.push(t('ai.language_lock', { language: name, tag: input.language }), '');
	}
	lines.push(t('ai.identity', { name: input.assistantName, website: input.websiteDomain ?? '' }));
	lines.push(t(`ai.tone.${input.tone}`));
	lines.push('', t('ai.rules.title'));
	for (let i = 1; i <= CORE_RULE_COUNT; i += 1) lines.push(`${i}. ${t(`ai.rule.${i}`)}`);
	lines.push(`${CORE_RULE_COUNT + 1}. ${t(input.presentAsHuman ? 'ai.rule.human' : 'ai.rule.disclose')}`);
	if (input.forbiddenTopics.length > 0) {
		lines.push(`${CORE_RULE_COUNT + 2}. ${t('ai.rule.forbidden', { topics: input.forbiddenTopics.join('; ') })}`);
	}
	if (input.awaitingHuman) lines.push('', t('ai.awaiting_human'));
	if (input.step) lines.push('', t('ai.flow_step', { instruction: input.step }));
	lines.push('', t(`ai.length.${input.answerLength}`));
	if (input.maxBubbles > 1) lines.push(t('ai.bubbles', { separator: input.bubbleSeparator, max: input.maxBubbles }));
	if (input.toolNames.length > 0) lines.push(t('ai.tools'));

	lines.push(
		'',
		t(input.customer.identified ? 'ai.customer.identified' : 'ai.customer.guest', { name: input.customer.name ?? '' }),
	);
	if (input.page && (input.page.path || input.page.title)) {
		lines.push(t('ai.page', { path: input.page.path ?? '', title: input.page.title ?? '' }));
	}

	if (input.passages.length > 0) {
		lines.push('', t(input.groundedOnly ? 'ai.knowledge.grounded' : 'ai.knowledge.title'));
		if (input.citationStyle !== 'none') lines.push(t(`ai.citations.${input.citationStyle}`));
		for (const passage of input.passages) {
			lines.push(`[${passage.ref}] ${passage.title}${passage.url ? ` (${passage.url})` : ''}`, passage.text, '');
		}
	} else if (input.groundedOnly) lines.push('', t('ai.knowledge.none'));

	if (input.instructions.trim()) lines.push('', t('ai.instructions.title'), input.instructions.trim());
	return lines
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
};

/**
 * Conversation history as chat turns: customer → user, bot → assistant; agent messages are given to the model as
 * assistant turns too (the model continues the team's voice); system notices and internal notes are never sent.
 * @param {Array<{ author: string, body: string, internal?: boolean, kind?: string }>} messages oldest first
 * @param {number} turns
 * @returns {Array<{ role: 'user' | 'assistant', content: string }>}
 */
export const historyTurns = (messages, turns) =>
	(turns > 0
		? messages
				.filter(
					(m) => !m.internal && (m.kind ?? 'text') !== 'event' && ['customer', 'bot', 'agent'].includes(m.author) && m.body,
				)
				.slice(-turns)
		: []
	).map((m) => ({
		role: m.author === 'customer' ? /** @type {const} */ ('user') : /** @type {const} */ ('assistant'),
		content: m.body,
	}));
