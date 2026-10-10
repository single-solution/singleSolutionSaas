/**
 * What happens after a visitor message (PLAN 0.8.3): a running flow ends when the visitor types; a keyword starts a
 * flow; a handoff phrase or keyword hands the chat to a person; otherwise the AI answers right after the response
 * (`after()`, the widget checks every 3 s meanwhile) unless the chat waits for a person, staff paused the AI, or a
 * limit or cap is reached. The AI uses the website's own provider (backup on failure, when on), knowledge from
 * switched-on features, the merchant's webhook tools, the booking endpoint and the shop tools (Ecommerce, pasted token;
 * the products they return become product cards on the answer), the language lock and moderation. On
 * failure the on-failure setting applies; N failures in a row hand off. Staff alerts go out as the features say.
 * @module
 */
import { problem } from '@ss/app-kit';
import { runAssistant } from '../core/assistant.js';
import { checkAiConnection } from '../core/models.js';
import { advance, keywordFlow } from '../core/flows.js';
import { handoffReason } from '../core/handoff.js';
import {
	PASSAGE_CHARS,
	HISTORY_TURNS,
	MAX_TOOL_ROUNDS,
	SUMMARY_PROMPT,
	buildSystemPrompt,
	languageRetry,
} from '../core/prompt.js';
import { RETRIEVAL, passages, queryTerms, rank } from '../core/knowledge.js';
import { detectLanguage, replyMatchesLanguage } from '../core/language.js';
import { moderateOutbound } from '../core/moderation.js';
import {
	BUILTIN,
	TOOL_RESPONSE_MAX_BYTES,
	TOOL_SIGNATURE_HEADER,
	TOOL_TIMEOUT_MS,
	builtinSchemas,
	checkArguments,
	isHttpsUrl,
	slotRange,
	toolOutput,
	webhookSchema,
} from '../core/tools.js';
import { SHOP_LIMIT, SHOP_UNAVAILABLE, cardOf, shopAnswer, shopRequest, shopSchemas } from '../core/shop.js';
import { dayKey } from '../core/time.js';
import { SIGN_IN_HEADER } from '../core/widgets.js';
import { jsonOf } from '@ss/net';
import { signTool } from '../adapters/crypto.js';

/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Visitor} Visitor */
/** @typedef {import('../core/conversation.js').ConversationRecord} ConversationRecord */
/** @typedef {import('../core/providers.js').ChatMessage} ChatMessage */

const DAY_MS = 86_400_000;
/** One answer's deadline over every provider and tool call (ms). */
const ANSWER_DEADLINE_MS = 45_000;

/** Marker words setting lines (`ur: hai kya mein`) → marker sets. @param {string[]} lines */
const markerSets = (lines) =>
	lines.flatMap((line) => {
		const match = /^\s*([a-zA-Z]{2,3}(?:-[A-Za-z0-9]{2,8})?)\s*:\s*(.+)$/.exec(line);
		return match
			? [
					{
						language: String(match[1]),
						words: String(match[2])
							.split(/[\s,]+/)
							.filter(Boolean),
					},
				]
			: [];
	});

/**
 * @param {import('../adapters/product.js').Product} product
 * @param {Service} service
 */
export const createReply = (product, service) => {
	const { now } = product;

	/**
	 * Hand a conversation to a person (handoff on): the flag, the AI stops, a bot message (or office hours), the
	 * contact request for a guest without one, the `Chat needs you` alert and the AI summary.
	 * @param {Site} s
	 * @param {ConversationRecord} c
	 * @returns {Promise<ConversationRecord>}
	 */
	const handOff = async (s, c) => {
		if (!s.on.includes('handoff') || c.waiting) return c;
		let current = /** @type {ConversationRecord} */ (
			await s.store.conversations.update(c.id, {
				set: {
					waiting: true,
					waitingSince: new Date(now()),
					handedOffAt: c.handedOffAt ?? new Date(now()),
					aiPending: false,
					aiFailures: 0,
				},
			})
		);
		const texts = await s.texts();
		const hours = await service.officeHours(s);
		current = (
			await service.botMessage(
				s,
				current,
				hours && !hours.open ? await service.closedText(s, hours) : String(texts['chat.handoff']),
			)
		).conversation;
		if (current.visitor.kind === 'guest' && !current.email && !current.phone)
			current = (await service.botMessage(s, current, String(texts['chat.contactAsk']))).conversation;
		await service.staffAlert(s, current, 'needs_you');
		if (s.on.includes('ai_summary')) s.ctx.after(() => summarise(s, current.id).catch(() => null));
		return current;
	};

	/**
	 * Start a flow and run it until it waits or ends.
	 * @param {Site} s
	 * @param {ConversationRecord} c
	 * @param {import('../core/flows.js').Flow} flow
	 */
	const startFlow = async (s, c, flow) => {
		const current = /** @type {ConversationRecord} */ (
			await s.store.conversations.update(c.id, { push: { flowsRun: flow.id } })
		);
		return runFlow(s, current, flow, 0);
	};

	/**
	 * Run a flow from a step.
	 * @param {Site} s
	 * @param {ConversationRecord} c
	 * @param {import('../core/flows.js').Flow} flow
	 * @param {number} from
	 */
	const runFlow = async (s, c, flow, from) => {
		const run = advance(flow, from, { handoff: s.on.includes('handoff') });
		let current = c;
		for (const message of run.messages)
			current = (await service.botMessage(s, current, message.text, message.buttons ? { buttons: message.buttons } : {}))
				.conversation;
		current = /** @type {ConversationRecord} */ (
			await s.store.conversations.update(current.id, {
				set: { flow: run.waitAt === null ? null : { id: flow.id, step: run.waitAt } },
			})
		);
		if (run.handoff) current = await handOff(s, current);
		return current;
	};

	/**
	 * After a visitor message was stored.
	 * @param {Site} s
	 * @param {ConversationRecord} c
	 * @param {string} text
	 * @returns {Promise<ConversationRecord>}
	 */
	const afterVisitorMessage = async (s, c, text) => {
		let current = c;
		if (current.flow)
			current = /** @type {ConversationRecord} */ (await s.store.conversations.update(current.id, { set: { flow: null } }));
		await service.staffAlert(s, current, 'new_message');
		if (s.on.includes('leads_flows') && text) {
			const flow = keywordFlow(await s.list('flows'), text, current.flowsRun);
			if (flow) return startFlow(s, current, flow);
		}
		if (s.on.includes('handoff') && text && !current.waiting) {
			const settings = await s.values('handoff');
			if (handoffReason(text, { askPhrases: settings.askPhrases, keywords: settings.keywords })) return handOff(s, current);
		}
		if (current.waiting) {
			const hours = await service.officeHours(s);
			if (hours && !hours.open) return current;
		}
		if (!s.on.includes('ai_replies') || current.waiting || current.aiPaused) return current;
		const pending = /** @type {ConversationRecord} */ (
			await s.store.conversations.update(current.id, { set: { aiPending: true } })
		);
		s.ctx.after(() => answer(s, pending.id));
		return pending;
	};

	// -------------------------------------------------------------------------------------------------- AI

	/**
	 * The website's AI connections in order: main, then backup (when on).
	 * @param {Site} s
	 * @param {{ backup: boolean }} options
	 */
	const connectionsOf = async (s, { backup }) => {
		const names = backup && s.on.includes('ai_backup') ? ['ai', 'ai_backup'] : ['ai'];
		const out = [];
		for (const name of names) {
			const checked = checkAiConnection(await product.connections.value(s.websiteId, name));
			if (checked.ok) out.push(checked.value);
		}
		return out;
	};

	/**
	 * One completion with the main provider, else the backup.
	 * @param {Site} s
	 * @param {import('../core/models.js').AiConnection[]} connections
	 * @param {{ messages: ChatMessage[], tools: import('../core/providers.js').ToolSchema[] }} request
	 */
	const complete = async (s, connections, request) => {
		const { temperature, maxOutputTokens } = await s.values('ai_replies');
		/** @type {{ ok: false, code: string } | { ok: true, value: import('../core/providers.js').ChatResult }} */
		let result = { ok: false, code: 'not_connected' };
		for (const connection of connections) {
			result = await product.ai.chat(connection, {
				...request,
				temperature: Number(temperature),
				maxTokens: Number(maxOutputTokens),
			});
			if (result.ok) return result;
		}
		return result;
	};

	/**
	 * Knowledge passages for a question (knowledge base and website pages, when on).
	 * @param {Site} s
	 * @param {string} question
	 */
	const knowledge = async (s, question) => {
		const entries = s.on.includes('knowledge_base');
		const pages = s.on.includes('knowledge_pages');
		if (!entries && !pages) return [];
		const terms = queryTerms(question);
		if (terms.length === 0) return [];
		const found = await s.store.knowledge.search(terms);
		const chunks = found.chunks.filter((chunk) => (chunk.sourceType === 'entry' ? entries : pages));
		/** @type {Record<string, number>} */
		const df = {};
		for (const chunk of chunks) for (const term of terms) if (chunk.tf[term]) df[term] = (df[term] ?? 0) + 1;
		const avgLength = chunks.length > 0 ? chunks.reduce((sum, chunk) => sum + chunk.length, 0) / chunks.length : 1;
		const ranked = rank({ terms, chunks, stats: { count: found.count, avgLength, df }, ...RETRIEVAL });
		return passages(ranked, { maxChars: PASSAGE_CHARS });
	};

	/**
	 * A signed POST to the merchant's own endpoint (webhook tools and booking).
	 * @param {Site} s
	 * @param {string} url
	 * @param {unknown} payload
	 */
	const callEndpoint = async (s, url, payload) => {
		const body = JSON.stringify(payload);
		const secret = await product.lists.toolSecret(s.websiteId);
		try {
			const response = await product.send(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', [TOOL_SIGNATURE_HEADER]: signTool(secret, body, now()) },
				body,
				redirect: 'error',
				timeoutMs: TOOL_TIMEOUT_MS,
				maxBytes: TOOL_RESPONSE_MAX_BYTES,
			});
			if (response.status < 200 || response.status > 299)
				return { ok: false, content: `The tool answered ${response.status}.` };
			let value;
			try {
				value = jsonOf(response);
			} catch {
				value = response.body.toString('utf8');
			}
			return { ok: true, content: toolOutput(value) };
		} catch {
			return { ok: false, content: 'The tool cannot be reached right now.' };
		}
	};

	/**
	 * The tools of a turn and how to run them, and the product cards the shop tools found.
	 * @param {Site} s
	 * @param {ConversationRecord} c
	 * @param {Visitor | null} visitor
	 * @param {string | null} signIn the visitor's Accounts sign-in, verified on this request for this conversation's user
	 */
	const toolsOf = async (s, c, visitor, signIn) => {
		const booking = s.on.includes('book_slot') ? await s.values('book_slot') : null;
		const bookingUrl = booking && isHttpsUrl(booking.bookingUrl) ? String(booking.bookingUrl) : null;
		const webhooks = s.on.includes('webhook_tools') ? await s.list('tools') : [];
		const shop = shopSchemas(s.on, { signedIn: signIn !== null });
		const schemas = [
			...builtinSchemas({ handoff: s.on.includes('handoff'), booking: bookingUrl !== null }),
			...shop,
			...webhooks.map(webhookSchema),
		];
		const signedIn = visitor?.kind === 'user' ? { id: visitor.id, email: visitor.email } : null;
		const withCards = s.on.includes('product_cards');
		/** @type {import('../core/shop.js').ProductCard[]} */
		const cards = [];
		/**
		 * A shop tool: one read from Ecommerce with the pasted token (the sign-in tools forward the verified sign-in;
		 * the model's arguments never name the user). A failed call answers that it cannot be looked up now.
		 * @param {import('../core/providers.js').ToolCall} call
		 */
		const shopCall = async (call) => {
			const request = shopRequest(call.name, call.arguments);
			if (!request.ok) return { ok: false, content: request.content };
			const answer = await product.callProduct(
				s.websiteId,
				'ecommerce',
				request.path,
				// offered only with a verified sign-in (shopSchemas)
				request.signIn ? { headers: { [SIGN_IN_HEADER]: String(signIn) } } : {},
			);
			if (!answer.ok) return { ok: false, content: SHOP_UNAVAILABLE };
			const found = shopAnswer(call.name, answer.body, await s.format());
			if (withCards)
				for (const item of found.products)
					if (cards.length < SHOP_LIMIT && !cards.some((card) => card.productId === item.id)) cards.push(cardOf(item));
			return { ok: true, content: toolOutput(found.content) };
		};
		/** @param {import('../core/providers.js').ToolCall} call */
		const execute = async (call) => {
			if (call.name === BUILTIN.escalate)
				return {
					content: 'The chat is handed to a person from the team.',
					escalate: { reason: String(call.arguments.reason ?? '') },
				};
			if (bookingUrl && call.name === BUILTIN.slots) {
				const { timeZone } = await s.business();
				const range = slotRange(call.arguments, { today: dayKey(now(), timeZone), daysAhead: Number(booking?.daysAhead) });
				if (!range) return { ok: false, content: 'Ask for dates from today on.' };
				return callEndpoint(s, bookingUrl, { action: 'list_slots', ...range, timeZone });
			}
			if (bookingUrl && call.name === BUILTIN.book) {
				const a = call.arguments;
				if (typeof a.slotId !== 'string' || typeof a.name !== 'string' || (!a.email && !a.phone && !signedIn?.email))
					return { ok: false, content: 'Ask for the slot, the name and an e-mail address or phone number.' };
				return callEndpoint(s, bookingUrl, {
					action: 'book',
					slotId: a.slotId,
					name: a.name,
					email: typeof a.email === 'string' ? a.email : (signedIn?.email ?? null),
					phone: typeof a.phone === 'string' ? a.phone : null,
					conversationId: c.id,
				});
			}
			if (shop.some((t) => t.name === call.name)) return shopCall(call);
			const tool = webhooks.find((t) => t.name === call.name);
			if (!tool) return { ok: false, content: 'No such tool.' };
			const args = checkArguments(tool, call.arguments);
			if (!args.ok) return { ok: false, content: 'The tool needs other arguments.' };
			return callEndpoint(s, tool.url, {
				tool: tool.name,
				arguments: args.value,
				conversationId: c.id,
				...(tool.includeVisitor && signedIn ? { visitor: signedIn } : {}),
			});
		};
		return { schemas, execute, cards: () => [...cards], shop: shop.length > 0 };
	};

	/**
	 * Whether this visitor or network may have another AI reply today (code-constant windows, settings limits).
	 * @param {Site} s
	 * @param {ConversationRecord} c
	 */
	const withinReplyLimits = async (s, c) => {
		const { repliesPerVisitorPerDay, repliesPerNetworkPerDay } = await s.values('ai_replies');
		// the visitor's address: SS-Visitor-IP on a visitor call from the merchant's server (K3), else the network's
		const ip = String(s.ctx.clientIp ?? 'unknown');
		const checks = /** @type {Array<[string, number]>} */ ([
			[`chat-ai|${s.websiteId}|visitor|${c.visitor.kind}:${c.visitor.id}`, Number(repliesPerVisitorPerDay)],
			[`chat-ai|${s.websiteId}|network|${ip}`, Number(repliesPerNetworkPerDay)],
		]);
		for (const [key, limit] of checks) {
			if (limit <= 0) continue;
			const { count } = await product.counters.hit(key, DAY_MS, now());
			if (count > limit) return false;
		}
		return true;
	};

	/**
	 * The AI answer to the conversation's last visitor message (run after the response).
	 * @param {Site} s
	 * @param {string} conversationId
	 */
	const answer = async (s, conversationId) => {
		let c = await s.store.conversations.get(conversationId);
		if (!c) return;
		const done = (/** @type {Record<string, unknown>} */ set = {}) =>
			s.store.conversations.update(conversationId, { set: { aiPending: false, ...set } });
		if (c.waiting || c.aiPaused) return void (await done());
		const visitor = /** @type {Visitor | null} */ (
			c.visitor.kind === 'user' ? { kind: 'user', id: c.visitor.id, name: c.name, email: c.email, phone: c.phone } : null
		);
		const history = (await s.store.messages.list(c.id, { limit: HISTORY_TURNS * 2, internal: false })).filter(
			(m) => m.author !== 'system' && m.text,
		);
		const last = [...history].reverse().find((m) => m.author === 'visitor');
		const connections = await connectionsOf(s, { backup: true });
		const allowed = connections.length > 0 && (await withinReplyLimits(s, c)) && !(await service.capped(s));
		/** @type {{ text: string, failure: string | null, escalation: { reason: string } | null }} */
		let result = { text: '', failure: 'unavailable', escalation: null };
		/** @type {import('../core/shop.js').ProductCard[]} */
		let cards = [];
		if (allowed && last) {
			const lock = s.on.includes('language_lock') ? await s.values('language_lock') : null;
			const markers = lock ? markerSets(lock.markerWords) : [];
			const language = lock
				? detectLanguage(last.text, { fallback: lock.allowedLanguages[0] ?? 'en', allowed: lock.allowedLanguages, markers })
						.language
				: null;
			const settings = await s.values('ai_replies');
			const { botName } = await s.values('visitor_chat');
			// the shop's sign-in tools only for the user whose sign-in Chat verified on this request
			const signIn = await s.signIn();
			const verified = signIn && visitor && signIn.user.id === visitor.id ? signIn.token : null;
			const tools = await toolsOf(s, c, visitor, verified);
			const system = buildSystemPrompt({
				botName: String(botName),
				business: await s.business(),
				instructions: s.on.includes('ai_instructions')
					? String((await s.values('ai_instructions')).instructions) || null
					: null,
				dontKnow: String(settings.dontKnow),
				language,
				passages: await knowledge(s, last.text),
				visitor: { signedIn: visitor !== null, name: c.name },
				page: c.page,
				handoff: s.on.includes('handoff'),
				shop: { tools: tools.shop, cards: tools.shop && s.on.includes('product_cards') },
			});
			/** @type {ChatMessage[]} */
			const messages = [
				{ role: 'system', content: system },
				...history.map(
					(m) => /** @type {ChatMessage} */ ({ role: m.author === 'visitor' ? 'user' : 'assistant', content: m.text }),
				),
			];
			const deadline = now() + ANSWER_DEADLINE_MS;
			result = await runAssistant(
				{
					messages,
					tools: tools.schemas,
					maxRounds: tools.schemas.length > 0 ? MAX_TOOL_ROUNDS : 0,
					languageOk: language ? (text) => replyMatchesLanguage(text, language, { markers }) : null,
					retryInstruction: language ? languageRetry(language) : '',
				},
				{
					call: (request) => complete(s, connections, request),
					execute: tools.execute,
					remainingTokens: () => Number.POSITIVE_INFINITY,
					spend: (usage) => service.spend(s, usage.input + usage.output),
					expired: () => now() > deadline,
				},
			);
			cards = tools.cards();
		}
		c = /** @type {ConversationRecord} */ (await s.store.conversations.get(conversationId));
		if (c.waiting || c.aiPaused) return void (await done());
		const texts = await s.texts();
		if (result.text) {
			const moderation = s.on.includes('moderation') ? /** @type {any} */ (await s.values('moderation')) : null;
			const { domain } = await product.serving(s.websiteId).then((serving) => (serving.ok ? serving.status : { domain: '' }));
			const checked = moderateOutbound(result.text, moderation, { labels: labelsOf(texts), websiteDomain: domain });
			if (checked.ok) {
				const { botName } = await s.values('visitor_chat');
				const appended = await service.append(
					s,
					c,
					{ author: 'ai', text: checked.text, name: String(botName), cards },
					{
						set: { aiPending: false, aiFailures: 0 },
						inc: { aiReplies: 1 },
					},
				);
				if (result.escalation) await handOff(s, appended.conversation);
				return;
			}
		}
		if (result.escalation) {
			await handOff(s, /** @type {ConversationRecord} */ (await done()));
			return;
		}
		// the AI could not answer: the on-failure setting, and a handoff after N failures in a row
		const failed = /** @type {ConversationRecord} */ (
			await s.store.conversations.update(conversationId, { set: { aiPending: false }, inc: { aiFailures: 1 } })
		);
		const { onFailure } = await s.values('ai_replies');
		const { failuresBeforeHandoff } = await s.values('handoff');
		const handoffNow =
			s.on.includes('handoff') &&
			(onFailure !== 'message' || (Number(failuresBeforeHandoff) > 0 && failed.aiFailures >= Number(failuresBeforeHandoff)));
		let current = failed;
		if (onFailure !== 'handoff' || !s.on.includes('handoff'))
			current = (await service.botMessage(s, current, String(texts['chat.aiUnavailable']))).conversation;
		if (handoffNow) await handOff(s, current);
	};

	/**
	 * The AI summary of a conversation (on handoff and on demand); counted in the AI token caps.
	 * @param {Site} s
	 * @param {string} conversationId
	 * @returns {Promise<string>}
	 */
	const summarise = async (s, conversationId) => {
		const connections = await connectionsOf(s, { backup: true });
		if (connections.length === 0 || (await service.capped(s)))
			throw problem('ai_unavailable', 'The AI cannot write a summary now (no AI key, or an AI token cap is reached).');
		const messages = await s.store.messages.list(conversationId, { limit: 200, internal: false });
		const transcript = messages.map((m) => `${m.author}: ${m.text}`).join('\n');
		const result = await complete(s, connections, {
			messages: [
				{ role: 'system', content: SUMMARY_PROMPT },
				{ role: 'user', content: transcript.slice(-24_000) },
			],
			tools: [],
		});
		if (!result.ok || !result.value.text.trim()) throw problem('ai_unavailable', 'The AI cannot write a summary now.');
		await service.spend(s, result.value.usage.input + result.value.usage.output);
		const summary = result.value.text.trim().slice(0, 2000);
		await s.store.conversations.update(conversationId, { set: { summary } });
		return summary;
	};

	return Object.freeze({ afterVisitorMessage, handOff, startFlow, runFlow, summarise, answer });
};

/**
 * Redaction labels from the widget texts.
 * @param {Record<string, string>} texts
 */
export const labelsOf = (texts) => ({
	card: texts['redacted.card'] ?? '[card]',
	iban: texts['redacted.iban'] ?? '[iban]',
	email: texts['redacted.email'] ?? '[email]',
	phone: texts['redacted.phone'] ?? '[phone]',
	ip: texts['redacted.ip'] ?? '[ip]',
});

/** @typedef {ReturnType<typeof createReply>} Reply */
