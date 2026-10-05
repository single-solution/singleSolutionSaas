/**
 * AI answers through the merchant's own AI connector: budget checks, knowledge retrieval, the system prompt, the tool
 * loop (core/assistant.js), token metering (`ai_token`, idempotent per call), language verification, bubble
 * splitting and the outbound moderation of every bubble. Tools: order lookups from the order-event cache (verified
 * customer only, or a guest with number + e-mail when allowed), knowledge search, escalation and the merchant's
 * webhook tools (signed, through the kit's SSRF guard, metered as `tool_call`).
 */
import { runAssistant } from '../core/assistant.js';
import { alertCrossed, outputCap, remainingTokens } from '../core/budget.js';
import { replyMatchesLanguage, languageName } from '../core/language.js';
import { moderateOutbound, redact, splitBubbles } from '../core/moderation.js';
import { buildSystemPrompt, historyTurns } from '../core/prompt.js';
import { resolveModel } from '../core/providers.js';
import { BUILTIN, checkArguments, guestClaimMatches, orderSummary, toolOutput, toolSchemas } from '../core/tools.js';
import { monthKey } from '../core/time.js';
import { normalise } from '../core/text.js';

/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./service.js').Deps} Deps */
/** @typedef {import('../core/conversation.js').Conversation} Conversation */
/** @typedef {{ subject: string, email?: string | null } | null} Identity */

/** Characters of a tool result kept by default. */
const DEFAULT_TOOL_CHARS = 4000;

/**
 * @param {Deps & { knowledge: import('./knowledge.js').Knowledge }} deps
 */
export const createAssistant = (deps) => {
	const { now, hash } = deps;

	/** PII labels for a language. @param {(key: string) => string} t */
	const labelsOf = (t) => ({
		card: t('moderation.redacted.card'),
		iban: t('moderation.redacted.iban'),
		email: t('moderation.redacted.email'),
		phone: t('moderation.redacted.phone'),
		ip: t('moderation.redacted.ip'),
	});

	/**
	 * Call a merchant webhook tool.
	 * @param {Site} site
	 * @param {import('../core/tools.js').CustomTool} tool
	 * @param {Record<string, unknown>} args
	 * @param {{ conversationId: string | null, identity: Identity, t: (key: string) => string }} context
	 * @returns {Promise<{ ok: boolean, output: string }>}
	 */
	const callWebhook = async (site, tool, args, { conversationId, identity, t }) => {
		const timestamp = Math.floor(now() / 1000);
		const body = JSON.stringify({
			tool: tool.name,
			arguments: args,
			conversationId,
			websiteId: site.websiteId,
			...(tool.include_customer && identity ? { customer: { subject: identity.subject, email: identity.email ?? null } } : {}),
			sentAt: new Date(now()).toISOString(),
		});
		const signature = deps.tokens.signTool({
			websiteId: site.websiteId,
			version: Number(site.settings.tools?.signing_key_version ?? 1),
			body,
			timestamp,
		});
		try {
			const response = await deps.outbound.fetch(tool.url, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, text/plain',
					'ss-chatbot-signature': signature,
				},
				body,
				timeoutMs: tool.timeout_ms ?? 8000,
				maxBytes: 262_144,
				redirect: 'error',
			});
			const text = response.body.toString('utf8');
			if (response.status < 200 || response.status > 299) return { ok: false, output: t('tools.result.failed') };
			return { ok: true, output: toolOutput(text || '{}', tool.max_response_chars ?? DEFAULT_TOOL_CHARS) };
		} catch {
			return { ok: false, output: t('tools.result.failed') };
		}
	};

	/**
	 * Run one tool call for a conversation.
	 * @param {Site} site
	 * @param {{ conversation: Conversation | null, identity: Identity, t: (key: string) => string, meterKey: string }} context
	 * @param {import('../core/providers.js').ToolCall} call
	 * @returns {Promise<{ content: string, ok: boolean, escalate?: { reason: string } | null }>}
	 */
	const executeTool = async (site, { conversation, identity, t, meterKey }, call) => {
		const tools = site.settings.tools;
		const meter = async () => {
			await deps.recordUsage({
				websiteId: site.websiteId,
				unit: 'tool_call',
				quantity: 1,
				idempotencyKey: `tool:${meterKey}:${call.id}`,
			});
		};
		if (call.name === BUILTIN.escalate && site.settings.handoff) {
			const reason = typeof call.arguments.reason === 'string' ? call.arguments.reason.slice(0, 200) : 'ai';
			return { ok: true, content: t('tools.result.escalated'), escalate: { reason } };
		}
		if (call.name === BUILTIN.knowledge && site.settings.knowledge) {
			const query = typeof call.arguments.query === 'string' ? call.arguments.query : '';
			const found = await deps.knowledge.search(site, query);
			return {
				ok: true,
				content:
					found.length === 0
						? t('tools.result.no_results')
						: toolOutput(
								found.map((p) => ({ ref: p.ref, title: p.title, url: p.url, text: p.text })),
								6000,
							),
			};
		}
		if (!tools) return { ok: false, content: t('tools.result.failed') };
		if (conversation && conversation.toolCalls >= tools.calls_per_conversation)
			return { ok: false, content: t('tools.result.failed') };
		if (call.name === BUILTIN.orders && tools.order_lookup) {
			if (!identity) return { ok: true, content: t('tools.result.not_signed_in') };
			await meter();
			const email = identity.email ? normalise(identity.email) : null;
			const extra = email ? await site.repos.customers.idsForEmail(email) : [];
			const orders = await site.repos.orders.forCustomer(
				{ customerIds: [identity.subject, ...extra], subject: identity.subject, email },
				tools.max_orders,
			);
			return {
				ok: true,
				content:
					orders.length === 0
						? t('tools.result.no_orders')
						: toolOutput(
								orders.map((/** @type {any} */ o) => orderSummary(o, tools.order_fields)),
								6000,
							),
			};
		}
		if (call.name === BUILTIN.guestOrder && tools.guest_order_lookup) {
			await meter();
			const claim = { number: String(call.arguments.number ?? ''), email: String(call.arguments.email ?? '') };
			if (!claim.number || !claim.email) return { ok: true, content: t('tools.result.not_found') };
			const match = (await site.repos.orders.byNumber(claim.number.replace(/^#/, '').trim())).find((/** @type {any} */ o) =>
				guestClaimMatches(o, claim),
			);
			return {
				ok: true,
				content: match ? toolOutput(orderSummary(match, tools.order_fields), 4000) : t('tools.result.not_found'),
			};
		}
		const custom = (tools.custom ?? []).find((tool) => tool.name === call.name && tool.allow_ai !== false);
		if (!custom) return { ok: false, content: t('tools.result.failed') };
		const args = checkArguments(custom, call.arguments);
		if (!args.ok) return { ok: false, content: `invalid arguments: ${args.errors.join('; ')}` };
		await meter();
		const result = await callWebhook(site, custom, args.value, { conversationId: conversation?.id ?? null, identity, t });
		return { ok: result.ok, content: result.output };
	};

	/**
	 * Generate an answer.
	 * @param {Site} site
	 * @param {{ conversation: Conversation, text: string, language: string, identity: Identity, history: Array<Record<string, any>>,
	 *   t: (key: string, params?: Record<string, string | number>) => string, meterKey: string, awaitingHuman?: boolean, step?: string | null,
	 *   customerName?: string | null }} input
	 * @returns {Promise<{ bubbles: string[], failure: string | null, usage: { input: number, output: number }, escalation: { reason: string } | null,
	 *   tools: Array<{ name: string, ok: boolean }>, passages: number, dontKnow: 'say' | 'handoff' | null }>}
	 */
	const answer = async (site, input) => {
		const ai = site.settings.ai;
		const empty = { bubbles: [], usage: { input: 0, output: 0 }, escalation: null, tools: [], passages: 0, dontKnow: null };
		if (!ai) return { ...empty, failure: 'disabled' };
		/** @type {import('../adapters/ai.js').ChatAdapter} */
		let adapter;
		try {
			adapter = await deps.ai(site.websiteId);
		} catch {
			return { ...empty, failure: 'unavailable' };
		}
		const model = resolveModel({
			provider: adapter.provider,
			override: ai.model,
			connectorModel: adapter.model,
			defaults: ai.default_models,
		});
		if (!model) return { ...empty, failure: 'no_model' };
		const month = monthKey(now(), site.settings.timeZone);
		const counterKey = `tokens:${month}`;
		let monthUsed = await site.repos.counters.get(counterKey);
		let spent = 0;
		const left = () =>
			remainingTokens({
				conversationUsed: input.conversation.tokens + spent,
				perConversation: ai.tokens_per_conversation,
				monthUsed,
				monthly: ai.monthly_token_budget,
			});
		if (left() <= 0) return { ...empty, failure: 'budget' };

		const k = site.settings.knowledge;
		const found = k ? await deps.knowledge.search(site, input.text) : [];
		if (k && found.length === 0 && k.dont_know !== 'answer' && !input.step)
			return { ...empty, failure: null, dontKnow: k.dont_know === 'handoff' ? 'handoff' : 'say' };

		const { t } = input;
		const moderation = site.settings.moderation;
		const labels = labelsOf(t);
		const toAi = (/** @type {string} */ text) =>
			moderation?.redact_before_ai ? redact(text, moderation.redact_inbound, labels).text : text;
		const identified = Boolean(input.identity);
		const tools = toolSchemas({
			config: site.settings.tools,
			identified,
			knowledge: Boolean(k),
			handoff: Boolean(site.settings.handoff),
			t,
		});
		const system = buildSystemPrompt({
			t,
			assistantName: ai.assistant_name || t('window.title'),
			language: input.language,
			languageLock: ai.language_lock,
			tone: ai.tone,
			instructions: ai.instructions,
			presentAsHuman: ai.present_as_human,
			forbiddenTopics: ai.forbidden_topics,
			answerLength: ai.answer_length,
			bubbleSeparator: ai.bubble_separator,
			maxBubbles: ai.max_bubbles,
			citationStyle: ai.citation_style,
			passages: found,
			groundedOnly: Boolean(k?.grounded_only),
			customer: { identified, name: input.customerName ? ` (${input.customerName})` : '' },
			page: input.conversation.context?.page ?? null,
			awaitingHuman: Boolean(input.awaitingHuman),
			toolNames: tools.map((tool) => tool.name),
			step: input.step ?? null,
			websiteDomain: site.domain,
		});
		const history = historyTurns(/** @type {any[]} */ (input.history), ai.history_turns).map((turn) => ({
			...turn,
			content: toAi(turn.content),
		}));
		const deadline = now() + ai.reply_deadline_ms;
		const markers = site.settings.window.language_markers;
		const languageOk = ai.language_lock
			? (/** @type {string} */ text) => replyMatchesLanguage(text, input.language, { markers })
			: null;
		let calls = 0;
		const result = await runAssistant(
			{
				messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: toAi(input.text) }],
				tools,
				maxRounds: ai.max_tool_rounds,
				languageOk,
				retryInstruction: ai.language_retry ? t('ai.retry_language', { language: languageName(input.language) }) : '',
			},
			{
				call: ({ messages, tools: offered }) =>
					adapter.chat({
						model,
						messages,
						tools: offered,
						temperature: ai.temperature,
						maxTokens: outputCap(ai.max_output_tokens, left()),
						timeoutMs: Math.max(1000, Math.min(ai.request_timeout_ms, deadline - now())),
					}),
				execute: (call) =>
					executeTool(
						site,
						{ conversation: input.conversation, identity: input.identity, t, meterKey: input.meterKey },
						call,
					),
				remainingTokens: left,
				spend: async (usage) => {
					const total = usage.input + usage.output;
					calls += 1;
					spent += total;
					const before = monthUsed;
					monthUsed = await site.repos.counters.add(counterKey, total);
					await deps.recordUsage({
						websiteId: site.websiteId,
						unit: 'ai_token',
						quantity: total,
						idempotencyKey: `ai:${input.meterKey}:${calls}`,
					});
					if (alertCrossed({ before, after: monthUsed, monthly: ai.monthly_token_budget, percent: ai.cost_alert_percent }))
						await deps.audit({
							websiteId: site.websiteId,
							actor: { type: 'product', id: 'chatbot' },
							action: 'ai.budget_alert',
							target: { type: 'budget', id: month },
							after: { used: monthUsed, budget: ai.monthly_token_budget },
						});
				},
				expired: () => now() > deadline,
			},
		);
		const usage = result.usage;
		const base = { usage, escalation: result.escalation, tools: result.tools, passages: found.length, dontKnow: null };
		if (result.failure) return { ...base, bubbles: [], failure: result.failure };
		const bubbles = splitBubbles(result.text, { separator: ai.bubble_separator, maxBubbles: ai.max_bubbles, maxLength: 4000 });
		/** @type {string[]} */
		const safe = [];
		for (const bubble of bubbles) {
			const checked = moderateOutbound(bubble, moderation, {
				labels,
				websiteDomain: site.domain,
				presentAsHuman: ai.present_as_human,
			});
			if (!checked.ok) return { ...base, bubbles: [], failure: `unsafe_${checked.reason}` };
			if (checked.text.trim()) safe.push(checked.text);
		}
		return safe.length > 0 ? { ...base, bubbles: safe, failure: null } : { ...base, bubbles: [], failure: 'empty' };
	};

	return Object.freeze({ answer, executeTool, callWebhook, labelsOf, hash });
};

/** @typedef {ReturnType<typeof createAssistant>} Assistant */
