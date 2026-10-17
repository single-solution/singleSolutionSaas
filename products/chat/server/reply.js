/**
 * What happens after a visitor message (PLAN 0.8.3): a running flow ends when the visitor types; a keyword starts a
 * flow; a handoff phrase or keyword hands the chat to a person (after the AI answered that message, with the handoff
 * setting `answerFirst`, PLAN 0.8.10 C4); otherwise the AI answers right after the response (`after()`, the widget
 * checks every 3 s meanwhile; or within the request with `?wait=1`, C10, which waits up to 20 s and lets a slower
 * answer finish after the response, CH-1; a reply that went stale starts again once, RT-6) unless the chat waits for a
 * person (from `REASSURE_AFTER_MINUTES` after the handoff the AI then only reassures, C4), staff paused the AI, or a
 * limit or cap is reached. The AI uses the website's own provider (backup on failure, when on), knowledge from
 * switched-on features, the store context from Ecommerce (C1), the merchant's webhook tools, the booking endpoint and
 * the shop tools (Ecommerce, Portal link; the products they return become product cards on the answer), the language
 * lock (C14; its options after the re-audit, CH-16 to CH-19, CH-38), "never disclose" (C1) and moderation.
 * Answers are markdown, split on `---` lines (and around tables with `tableBubble`, CH-21) into at most `bubbles`
 * messages (C2). When the AI fails, a cap is reached or the answer is refused, the first matching fallback answer
 * replies (C3), else the on-failure setting applies; N failures in a row hand off (an answer only in the wrong language
 * never hands off by itself, CH-19). Staff alerts go out as the features say.
 * @module
 */
import { formatText, problem } from '@ss/app-kit';
import { runAssistant } from '../core/assistant.js';
import { botPhrases } from '../core/bot-phrases.js';
import { checkAiConnection } from '../core/models.js';
import { advance, keywordFlow } from '../core/flows.js';
import {
	PLACEHOLDERS as PLACEHOLDER_FEATURES,
	budgetOf,
	compareSearches,
	comparedNames,
	comparedProduct,
	comparisonTable,
	fillFallback,
	matchingFallbacks,
	placeholdersOf,
	productList,
	tableOf,
} from '../core/fallback.js';
import { keepLinks, splitBubbles } from '../core/markdown.js';
import { handoffReason } from '../core/handoff.js';
import {
	DISCLOSE_RETRY,
	PASSAGE_CHARS,
	HISTORY_TURNS,
	MAX_TOOL_ROUNDS,
	buildSystemPrompt,
	disclosesBot,
	languageRetry,
	summaryPrompt,
} from '../core/prompt.js';
import { RETRIEVAL, passages, queryTerms, rank } from '../core/knowledge.js';
import { detectLanguage, languageForms, markerSetsOf, primary, replyMatchesLanguage, translationOf } from '../core/language.js';
import { linkAllowed, moderateOutbound } from '../core/moderation.js';
import {
	BUILTIN,
	TOOL_RESPONSE_MAX_BYTES,
	TOOL_SIGNATURE_HEADER,
	TOOL_TIMEOUT_MS,
	builtinSchemas,
	checkArguments,
	slotRange,
	toolOutput,
	webhookSchema,
} from '../core/tools.js';
import {
	SHOP_UNAVAILABLE,
	cardOf,
	compareFactsOf,
	contextPath,
	contextText,
	needsCurrency,
	shopAnswer,
	shopRequest,
	shopSchemas,
} from '../core/shop.js';
import { pendingStale } from '../core/conversation.js';
import {
	AI_MAX_OUTPUT_TOKENS,
	AI_REPLIES_PER_NETWORK_PER_DAY,
	AI_REPLIES_PER_VISITOR_PER_DAY,
	AI_TEMPERATURE,
	REASSURE_AFTER_MINUTES,
	SHOP_SEARCH_MAX_RESULTS,
} from '../core/limits.js';
import { isHttpsUrl } from '../core/text.js';
import { dayKey } from '../core/time.js';
import { SIGN_IN_HEADER, WAIT_MS } from '../core/widgets.js';
import { currencyDigits } from '@ss/contracts/format';
import { bookingAnswers } from '../core/booking.js';
import { labeledDetail, parseTagging, taggingPrompt } from '../core/labels.js';
import { jsonOf } from '@ss/net';
import { signWebhook } from '@ss/protocol';
import { labelListsOf, phoneCodeOf } from './service.js';

/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Visitor} Visitor */
/** @typedef {import('../core/conversation.js').ConversationRecord} ConversationRecord */
/** @typedef {import('../core/providers.js').ChatMessage} ChatMessage */

const DAY_MS = 86_400_000;
/** One answer's deadline over every provider and tool call (ms). */
const ANSWER_DEADLINE_MS = 45_000;
/** How long a store context is kept per website, sign-in and product (C1). */
const CONTEXT_CACHE_MS = 60_000;
/** How long the shop's currency is kept per website (prices the AI gives in whole units become minor units). */
const CURRENCY_CACHE_MS = 60 * 60_000;
/** Most store contexts and currencies kept per instance. */
const CACHE_MAX = 500;

/**
 * A small time-limited cache (per instance; dropped oldest first past `CACHE_MAX`).
 * @template T
 * @param {number} ttl
 * @param {() => number} now
 */
const timedCache = (ttl, now) => {
	/** @type {Map<string, { at: number, value: T }>} */
	const entries = new Map();
	return {
		/** @param {string} key @returns {{ value: T } | null} */
		get: (key) => {
			const hit = entries.get(key);
			return hit && now() - hit.at < ttl ? { value: hit.value } : null;
		},
		/** @param {string} key @param {T} value */
		set: (key, value) => {
			entries.delete(key);
			entries.set(key, { at: now(), value });
			if (entries.size > CACHE_MAX) entries.delete(/** @type {string} */ (entries.keys().next().value));
		},
	};
};

/** Who the activity log names for what the AI did itself (C7: AI tagging). */
const AI_ACTOR = Object.freeze({ kind: 'ai', id: 'ai', name: 'AI' });

/**
 * What the AI is told to ask the visitor for when a booking's answers are not complete (C10): question labels, the
 * service, or an email address or a phone number.
 * @param {string[]} ask
 */
const askFor = (ask) =>
	`Ask the visitor for ${ask
		.map((item) =>
			item === 'service' ? 'the service' : item === 'contact' ? 'an email address or a phone number' : `“${item}”`,
		)
		.join(', ')}, then book again.`;

/**
 * @param {import('../adapters/product.js').Product} product
 * @param {Service} service
 */
export const createReply = (product, service) => {
	const { now } = product;
	/** @type {ReturnType<typeof timedCache<string | null>>} */
	const contexts = timedCache(CONTEXT_CACHE_MS, now);
	/** @type {ReturnType<typeof timedCache<string>>} */
	const currencies = timedCache(CURRENCY_CACHE_MS, now);

	/** The website's own domain (links in answers). @param {Site} s */
	const domainOf = async (s) => {
		const serving = await product.serving(s.websiteId, { after: s.ctx.after });
		return serving.ok ? String(/** @type {any} */ (serving.status).domain ?? '') : '';
	};

	/** Keep the shop's currency from an Ecommerce answer. @param {Site} s @param {unknown} body */
	const rememberCurrency = (s, body) => {
		const b = /** @type {any} */ (body);
		const currency = b?.currency ?? b?.items?.[0]?.currency;
		if (typeof currency === 'string' && /^[A-Z]{3}$/.test(currency)) currencies.set(s.websiteId, currency);
	};

	/**
	 * Whole units of the shop's currency → minor units (prices the AI and fallback budgets give); the currency is learned
	 * from Ecommerce's answers, else asked once with the newest product.
	 * @param {Site} s
	 */
	const minorUnits = async (s) => {
		let currency = currencies.get(s.websiteId)?.value ?? null;
		if (currency === null) {
			const answer = await product.callProduct(s.websiteId, 'ecommerce', '/v1/chat/products/top?kind=new&limit=1');
			// unknown stays unknown for the cache time (2 digits), so a shop without products is not asked every time
			currencies.set(s.websiteId, '');
			if (answer.ok) rememberCurrency(s, answer.body);
			currency = currencies.get(s.websiteId)?.value ?? '';
		}
		const factor = 10 ** (currency ? currencyDigits(currency) : 2);
		return (/** @type {number} */ amount) => Math.round(amount * factor);
	};

	/**
	 * The store context of an AI reply (store context on, C1): Ecommerce's `GET /v1/chat/context` for the product the
	 * visitor is viewing, with the verified sign-in forwarded; cached 60 s per website, sign-in and product; cut to
	 * `SHOP_CONTEXT_MAX_CHARACTERS` (C22).
	 * @param {Site} s
	 * @param {ConversationRecord} c
	 * @param {string | null} signIn
	 */
	const storeContext = async (s, c, signIn) => {
		if (!s.on.includes('shop_context')) return null;
		const path = contextPath((c.currentPage ?? c.page)?.productId);
		const who = signIn ? (c.visitor.kind === 'user' ? c.visitor.id : '') : '';
		const key = `${s.websiteId}|${who}|${path}`;
		const cached = contexts.get(key);
		if (cached) return cached.value && contextText({ text: cached.value });
		const answer = await product.callProduct(
			s.websiteId,
			'ecommerce',
			path,
			signIn ? { headers: { [SIGN_IN_HEADER]: signIn } } : {},
		);
		const text = answer.ok ? contextText(answer.body) : null;
		if (answer.ok) {
			contexts.set(key, text);
			rememberCurrency(s, answer.body);
		}
		return text && contextText({ text });
	};

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
		const { showNotice } = await s.values('handoff');
		// the handoff notice is a widget text (C16); outside office hours, when staff are back
		const said =
			hours && !hours.open
				? await service.closedText(s, hours)
				: showNotice === true
					? String(texts['chat.handoffNotice'] ?? '').trim()
					: '';
		if (said) current = (await service.botMessage(s, current, said)).conversation;
		if (current.visitor.kind === 'guest' && !current.email && !current.phone)
			current = (await service.botMessage(s, current, String(texts['chat.contactAsk']))).conversation;
		current = await service.route(s, current, await conversationLanguage(s, current));
		await service.staffAlert(s, current, 'needs_you');
		if (s.on.includes('ai_summary')) s.ctx.after(() => summarize(s, current.id).catch(() => null));
		s.ctx.after(() => tagWithAi(s, current.id).catch(() => null));
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
	 * Whether the AI reassures a visitor waiting for a person (C4): from `REASSURE_AFTER_MINUTES` after this handoff
	 * (each handoff waits again, CH-5), while the office is open.
	 * @param {Site} s
	 * @param {ConversationRecord} c
	 */
	const reassureDue = async (s, c) => {
		const since = c.waitingSince ?? c.handedOffAt;
		if (!c.waiting || !since || !s.on.includes('handoff')) return false;
		if (now() - new Date(since).getTime() < REASSURE_AFTER_MINUTES * 60_000) return false;
		const hours = await service.officeHours(s);
		return !hours || hours.open;
	};

	/**
	 * Start the AI answer: right after the response, or within the request (`inline`, C10). Within the request it waits
	 * up to `WAIT_MS`: an answer that needs a provider call after that (a tool round, a retry) goes on right after the
	 * response with its normal deadline, and the request answers with the reply still pending, which the visitor's
	 * check picks up (CH-1); a provider call already running finishes first. An answer that throws stays pending and is
	 * started again when it goes stale (RT-6).
	 * @param {Site} s
	 * @param {ConversationRecord} c
	 * @param {boolean} inline
	 */
	const startAnswer = async (s, c, inline) => {
		const pending = /** @type {ConversationRecord} */ (
			await s.store.conversations.update(c.id, {
				set: { aiPending: true, aiPendingSince: new Date(now()), aiRetried: false },
			})
		);
		if (!inline) {
			s.ctx.after(() => answer(s, pending.id));
			return pending;
		}
		const until = now() + WAIT_MS;
		/** @type {(later: boolean) => void} */
		let release = () => undefined;
		/** @type {Promise<boolean>} */
		const released = new Promise((resolve) => {
			release = resolve;
		});
		const running = answer(s, pending.id, { onCall: () => (now() > until ? release(true) : undefined) });
		const later = await Promise.race([
			running.then(
				() => false,
				() => true,
			),
			released,
		]);
		if (later) s.ctx.after(() => running);
		return /** @type {ConversationRecord} */ (await s.store.conversations.get(c.id));
	};

	/**
	 * A visitor checks the chat: an AI reply that went stale (cut short or failed, RT-6) starts again once right after
	 * the response; stale again, it counts as failed (fallback answers, else the on-failure setting).
	 * @param {Site} s
	 * @param {ConversationRecord} c
	 * @returns {Promise<ConversationRecord>}
	 */
	const resume = async (s, c) => {
		if (!pendingStale(c, now())) return c;
		const claimed = await s.store.conversations.update(c.id, {
			set: { aiPendingSince: new Date(now()), aiRetried: true },
			unless: { aiPending: true, aiPendingSince: c.aiPendingSince ?? null },
		});
		if (!claimed) return c;
		const giveUp = c.aiRetried === true;
		s.ctx.after(() => answer(s, c.id, { giveUp }));
		return claimed;
	};

	/**
	 * The language of a visitor's message (language lock on, else null): script, telling letters and marker words with
	 * the merchant's thresholds; when it shows none, the default language (else the first allowed one, else English;
	 * CH-38).
	 * @param {Site} s
	 * @param {string} text
	 * @returns {Promise<string | null>}
	 */
	const languageOf = async (s, text) => {
		if (!s.on.includes('language_lock') || !text) return null;
		const lock = await s.values('language_lock');
		// the answer's language when a message shows none: the website's (set once in the Portal), else the first allowed
		const { region } = await s.ctx.website();
		return detectLanguage(text, {
			fallback: String(region.language || lock.allowedLanguages[0] || 'en'),
			allowed: lock.allowedLanguages,
			markers: markerSetsOf(lock.markerWords),
		}).language;
	};

	/**
	 * The language of the conversation's latest visitor message (language lock on), else null.
	 * @param {Site} s
	 * @param {ConversationRecord} c
	 */
	const conversationLanguage = async (s, c) => {
		if (!s.on.includes('language_lock')) return null;
		const recent = await s.store.messages.list(c.id, { limit: 20, internal: false });
		const last = [...recent].reverse().find((m) => m.author === 'visitor' && m.text);
		return last ? languageOf(s, last.text) : null;
	};

	/**
	 * After a visitor message was stored. `inline`: the AI answers within the request (C10).
	 * @param {Site} s
	 * @param {ConversationRecord} c
	 * @param {string} text
	 * @param {{ inline?: boolean }} [options]
	 * @returns {Promise<ConversationRecord>}
	 */
	const afterVisitorMessage = async (s, c, text, { inline = false } = {}) => {
		let current = c;
		if (current.flow)
			current = /** @type {ConversationRecord} */ (await s.store.conversations.update(current.id, { set: { flow: null } }));
		await service.staffAlert(s, current, 'new_message');
		if (s.on.includes('leads_flows') && text) {
			const flow = keywordFlow(await s.list('flows'), text, current.flowsRun);
			if (flow) return startFlow(s, current, flow);
		}
		const aiOn = s.on.includes('ai_replies') && !current.aiPaused;
		if (s.on.includes('handoff') && text && !current.waiting) {
			const settings = await s.values('handoff');
			if (handoffReason(text, { askPhrases: settings.askPhrases, keywords: settings.keywords })) {
				if (!settings.answerFirst || !aiOn) return handOff(s, current);
				// the AI answers this message first, then the chat goes to a person (C4)
				current = /** @type {ConversationRecord} */ (
					await s.store.conversations.update(current.id, { set: { pendingHandoff: true } })
				);
				return startAnswer(s, current, inline);
			}
		}
		if (current.waiting) {
			if (aiOn && (await reassureDue(s, current))) return startAnswer(s, current, inline);
			return current;
		}
		// without the AI the chat is your staff's: routing gives it to a member (C12)
		if (!aiOn) return service.route(s, current, await languageOf(s, text));
		return startAnswer(s, current, inline);
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
		/** @type {{ ok: false, code: string } | { ok: true, value: import('../core/providers.js').ChatResult }} */
		let result = { ok: false, code: 'not_connected' };
		for (const connection of connections) {
			result = await product.ai.chat(connection, {
				...request,
				temperature: AI_TEMPERATURE,
				maxTokens: AI_MAX_OUTPUT_TOKENS,
			});
			if (result.ok) return result;
		}
		return result;
	};

	/**
	 * Knowledge passages for a question (knowledge base and website pages, when on): entries in the visitor's language
	 * or in any language (C21).
	 * @param {Site} s
	 * @param {string} question
	 * @param {string | null} [language] the visitor's language (language lock), else null: every entry
	 */
	const knowledge = async (s, question, language = null) => {
		const entries = s.on.includes('knowledge_base');
		const pages = s.on.includes('knowledge_pages');
		if (!entries && !pages) return [];
		const terms = queryTerms(question);
		if (terms.length === 0) return [];
		const found = await s.store.knowledge.search(terms);
		// an entry in another language than the visitor's is left out; '' is any language (C21)
		const fits = (/** @type {string | undefined} */ own) => !own || language === null || primary(own) === primary(language);
		const chunks = found.chunks.filter((chunk) => (chunk.sourceType === 'entry' ? entries && fits(chunk.language) : pages));
		/** @type {Record<string, number>} */
		const df = {};
		for (const chunk of chunks) for (const term of terms) if (chunk.tf[term]) df[term] = (df[term] ?? 0) + 1;
		const avgLength = chunks.length > 0 ? chunks.reduce((sum, chunk) => sum + chunk.length, 0) / chunks.length : 1;
		const ranked = rank({ terms, chunks, stats: { count: found.count, avgLength, df }, ...RETRIEVAL });
		return passages(ranked, { maxChars: PASSAGE_CHARS });
	};

	/**
	 * A page as the AI hears of it: its kind is the name of the merchant's page type (C6), else its key.
	 * @param {Site} s
	 * @param {import('../core/conversation.js').PageContext | null} page
	 */
	const namedPage = async (s, page) => {
		if (!page) return null;
		const type = (await s.list('page_types')).find((each) => each.key === page.kind);
		return { ...page, kind: type ? String(type.name) : page.kind };
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
				headers: { 'content-type': 'application/json', [TOOL_SIGNATURE_HEADER]: signWebhook({ body, secret, now }) },
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
		// the merchant's own questions and services (C10)
		const asks = bookingUrl
			? { questions: await s.list('booking_questions'), services: await s.list('booking_services') }
			: null;
		const webhooks = s.on.includes('webhook_tools') ? await s.list('tools') : [];
		const shop = shopSchemas(s.on, { signedIn: signIn !== null });
		const schemas = [
			...builtinSchemas({ handoff: s.on.includes('handoff'), booking: asks }),
			...shop,
			...webhooks.map(webhookSchema),
		];
		const signedIn = visitor?.kind === 'user' ? { id: visitor.id, email: visitor.email } : null;
		const withCards = s.on.includes('product_cards');
		/** @type {import('../core/shop.js').ProductCard[]} */
		const cards = [];
		/**
		 * A shop tool: one read from Ecommerce through the Portal's link (the sign-in tools forward the verified sign-in;
		 * the model's arguments never name the user). A failed call answers that it cannot be looked up now.
		 * @param {import('../core/providers.js').ToolCall} call
		 */
		const shopCall = async (call) => {
			const request = shopRequest(call.name, call.arguments, {
				...(needsCurrency(call.name, call.arguments) ? { minor: await minorUnits(s) } : {}),
			});
			if (!request.ok) return { ok: false, content: request.content };
			const answer = await product.callProduct(
				s.websiteId,
				'ecommerce',
				request.path,
				// offered only with a verified sign-in (shopSchemas)
				request.signIn ? { headers: { [SIGN_IN_HEADER]: String(signIn) } } : {},
			);
			if (!answer.ok) return { ok: false, content: SHOP_UNAVAILABLE };
			rememberCurrency(s, answer.body);
			const found = shopAnswer(call.name, answer.body, await s.format());
			if (withCards)
				for (const item of found.products)
					if (cards.length < SHOP_SEARCH_MAX_RESULTS && !cards.some((card) => card.productId === item.id))
						cards.push(cardOf(item));
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
				const services = asks?.services ?? [];
				const service = services.find((each) => each.key === call.arguments.service)?.key ?? null;
				if (services.length > 0 && !service) return { ok: false, content: askFor(['service']) };
				return callEndpoint(s, bookingUrl, {
					action: 'list_slots',
					...range,
					timeZone,
					...(service ? { service } : {}),
				});
			}
			if (bookingUrl && asks && call.name === BUILTIN.book) {
				const a = call.arguments;
				if (typeof a.slotId !== 'string') return { ok: false, content: 'Ask which free slot the visitor wants.' };
				const checked = bookingAnswers(a, {
					...asks,
					needsContact: booking?.needsContact !== false,
					signedInEmail: signedIn?.email ?? null,
					callingCode: await phoneCodeOf(s),
				});
				if (!checked.ok) return { ok: false, content: askFor(checked.ask) };
				return callEndpoint(s, bookingUrl, {
					action: 'book',
					slotId: a.slotId,
					...(checked.service ? { service: checked.service } : {}),
					answers: checked.answers,
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
	 * Whether this visitor or network may have another AI reply today (code-constant windows and limits). The
	 * network limit counts guests only: a signed-in visitor is known by their account and has the visitor limit, so the
	 * guests on a shared network address never use up their replies (CH-14).
	 * @param {Site} s
	 * @param {ConversationRecord} c
	 */
	const withinReplyLimits = async (s, c) => {
		// the visitor's address: SS-Visitor-IP on a visitor call from the merchant's server (K3), else the network's
		const ip = String(s.ctx.clientIp ?? 'unknown');
		const checks = /** @type {Array<[string, number]>} */ ([
			[`chat-ai|${s.websiteId}|visitor|${c.visitor.kind}:${c.visitor.id}`, AI_REPLIES_PER_VISITOR_PER_DAY],
			...(c.visitor.kind === 'guest' ? [[`chat-ai|${s.websiteId}|network|${ip}`, AI_REPLIES_PER_NETWORK_PER_DAY]] : []),
		]);
		for (const [key, limit] of checks) {
			const { count } = await product.counters.hit(key, DAY_MS, now());
			if (count > limit) return false;
		}
		return true;
	};

	/**
	 * A shop read for a fallback answer (Ecommerce, Portal link): Ecommerce's answer to the tool's request, or null.
	 * @param {Site} s
	 * @param {string} tool
	 * @param {Record<string, unknown>} args
	 * @param {string | null} signIn the verified sign-in for the visitor's own data
	 */
	const shopBody = async (s, tool, args, signIn) => {
		const request = shopRequest(tool, args, {
			...(needsCurrency(tool, args) ? { minor: await minorUnits(s) } : {}),
		});
		if (!request.ok || (request.signIn && !signIn)) return null;
		const answer = await product.callProduct(
			s.websiteId,
			'ecommerce',
			request.path,
			request.signIn ? { headers: { [SIGN_IN_HEADER]: String(signIn) } } : {},
		);
		if (!answer.ok) return null;
		rememberCurrency(s, answer.body);
		return answer.body;
	};

	/**
	 * A shop read for a fallback answer: the tool's answer as the AI would get it, or null.
	 * @param {Site} s
	 * @param {string} tool
	 * @param {Record<string, unknown>} args
	 * @param {string | null} signIn the verified sign-in for the visitor's own data
	 */
	const shopRead = async (s, tool, args, signIn) => {
		const body = await shopBody(s, tool, args, signIn);
		return body === null ? null : shopAnswer(tool, body, await s.format()).content;
	};

	/**
	 * The two products a message names around one of the keywords, side by side (C18): each side is searched in the
	 * catalog with its words, then with fewer (the word farthest from the keyword dropped each time) until a product is
	 * found (the one named exactly so, else the first; never the other side's), and the table is made from both
	 * products' details. Null when a side finds no product or Ecommerce cannot answer.
	 * @param {Site} s
	 * @param {{ message: string, keywords: string[], words: Parameters<typeof comparisonTable>[1] }} input
	 */
	const comparison = async (s, { message, keywords, words }) => {
		const names = comparedNames(message, keywords);
		if (!names) return null;
		/** @type {string | null} */
		let taken = null;
		/** @type {import('../core/shop.js').CompareFacts[]} */
		const facts = [];
		for (const side of /** @type {const} */ (['left', 'right'])) {
			/** @type {import('../core/shop.js').ShopProduct | null} */
			let found = null;
			for (const query of compareSearches(names[side], side)) {
				const body = await shopBody(s, 'search_catalog', { query }, null);
				if (body === null) return null;
				found = comparedProduct(shopAnswer('search_catalog', body).products, query, taken);
				if (found) break;
			}
			if (!found) return null;
			taken = found.id;
			const details = compareFactsOf(
				await shopBody(s, 'get_product_details', { productId: found.id }, null),
				await s.format(),
			);
			if (!details) return null;
			facts.push(details);
		}
		return comparisonTable(facts, words);
	};

	/**
	 * The text of a fallback placeholder from the shop tools that are on, or null.
	 * @param {Site} s
	 * @param {keyof typeof import('../core/fallback.js').PLACEHOLDERS} name
	 * @param {{ message: string, signIn: string | null, keywords: string[] }} input `keywords`: the answer's
	 */
	const placeholderText = async (s, name, { message, signIn, keywords }) => {
		const texts = await s.texts();
		/** @param {string} key a widget text (Settings, Texts) */
		const text = (key) => String(texts[key]);
		const words = {
			outOfStock: text('chat.outOfStock'),
			was: (/** @type {string} */ price) => formatText(text('chat.wasPrice'), { price }),
		};
		if (name === 'comparison')
			return comparison(s, {
				message,
				keywords,
				words: {
					...words,
					price: text('chat.comparePrice'),
					availability: text('chat.compareAvailability'),
					inStock: text('chat.inStock'),
					brand: text('chat.compareBrand'),
					condition: text('chat.compareCondition'),
					yes: text('chat.compareYes'),
					no: text('chat.compareNo'),
				},
			});
		/** @param {any} content */
		const products = (content) =>
			Array.isArray(content?.products) && content.products.length > 0 ? productList(content.products, words) : null;
		if (name === 'deals_table') {
			const content = /** @type {any} */ (await shopRead(s, 'list_active_deals', {}, null));
			if (!Array.isArray(content?.deals) || content.deals.length === 0) return null;
			return tableOf(
				[text('chat.dealName'), text('chat.dealDetails'), text('chat.dealEnds')],
				content.deals.map((/** @type {any} */ d) => [
					String(d.name),
					String(d.offer ?? d.description ?? ''),
					String(d.endsAt ?? ''),
				]),
			);
		}
		if (name === 'top_products') return products(await shopRead(s, 'get_top_products', { kind: 'top' }, null));
		if (name === 'products_under') {
			const budget = budgetOf(message, { keywords, words: (await s.values('fallback_answers')).budgetWords });
			if (budget === null) return null;
			return products(await shopRead(s, 'search_catalog', { query: '', maxPrice: budget, inStock: true }, null));
		}
		const content = /** @type {any} */ (await shopRead(s, 'get_my_orders', {}, signIn));
		if (!Array.isArray(content?.orders) || content.orders.length === 0) return null;
		return content.orders
			.map((/** @type {any} */ o) => `- ${[o.number, o.status, o.total, o.placedAt].filter(Boolean).join(' — ')}`)
			.join('\n');
	};

	/**
	 * The first fallback answer that matches the visitor's message and whose placeholders fill (fallback answers on).
	 * @param {Site} s
	 * @param {{ message: string, language: string | null, signIn: string | null }} input
	 * @returns {Promise<string | null>}
	 */
	const fallbackAnswer = async (s, { message, language, signIn }) => {
		if (!s.on.includes('fallback_answers') || !message) return null;
		const items = /** @type {import('../core/fallback.js').FallbackAnswer[]} */ (await s.list('fallback_answers'));
		/** @type {Map<string, string | null>} */
		const filled = new Map();
		for (const item of matchingFallbacks(items, { message, language })) {
			/** @type {Record<string, string | null>} */
			const values = {};
			for (const name of placeholdersOf(item.text)) {
				// a comparison depends on the answer's keywords (the words between the two products)
				const key = name === 'comparison' ? `${name}\n${item.keywords.join('\n')}` : name;
				if (!s.on.includes(PLACEHOLDER_FEATURES[name])) values[name] = null;
				else {
					if (!filled.has(key))
						filled.set(key, await placeholderText(s, name, { message, signIn, keywords: item.keywords }));
					values[name] = filled.get(key) ?? null;
				}
			}
			const text = fillFallback(item.text, values);
			if (text) return text;
		}
		return null;
	};

	/**
	 * Links of a markdown message: kept on the website, or as the moderation link policy allows (moderation on).
	 * @param {Site} s
	 * @param {string} text
	 */
	const linksOf = async (s, text) => {
		const moderation = s.on.includes('moderation') ? /** @type {any} */ (await s.values('moderation')) : null;
		const websiteDomain = await domainOf(s);
		return keepLinks(text, {
			websiteDomain,
			allowed: moderation
				? (target) => linkAllowed(target, { mode: moderation.linkPolicy, hosts: moderation.allowedLinkHosts, websiteDomain })
				: null,
		});
	};

	/**
	 * The AI answer to the conversation's last visitor message (run after the response, or within it with `?wait=1`).
	 * `onCall` runs before each provider call; `giveUp`: no AI call, straight to the fallback answers and the
	 * on-failure setting (a reply that went stale twice, RT-6).
	 * @param {Site} s
	 * @param {string} conversationId
	 * @param {{ onCall?: () => void, giveUp?: boolean }} [options]
	 */
	const answer = async (s, conversationId, { onCall, giveUp = false } = {}) => {
		let c = await s.store.conversations.get(conversationId);
		if (!c) return;
		const done = (/** @type {Record<string, unknown>} */ set = {}) =>
			s.store.conversations.update(conversationId, { set: { aiPending: false, ...set } });
		/** The handoff the answered message asked for (C4), once the answer is out. */
		const settle = async () => {
			const current = await s.store.conversations.get(conversationId);
			if (!current?.pendingHandoff) return;
			await handOff(
				s,
				/** @type {ConversationRecord} */ (
					await s.store.conversations.update(conversationId, { set: { pendingHandoff: false } })
				),
			);
		};
		const reassure = c.waiting && (await reassureDue(s, c));
		if ((c.waiting && !reassure) || c.aiPaused) {
			await done();
			return settle();
		}
		const visitor = /** @type {Visitor | null} */ (
			c.visitor.kind === 'user' ? { kind: 'user', id: c.visitor.id, name: c.name, email: c.email, phone: c.phone } : null
		);
		const history = (await s.store.messages.list(c.id, { limit: HISTORY_TURNS * 2, internal: false })).filter(
			(m) => m.author !== 'system' && m.text,
		);
		const last = [...history].reverse().find((m) => m.author === 'visitor');
		const connections = giveUp ? [] : await connectionsOf(s, { backup: true });
		const allowed = connections.length > 0 && (await withinReplyLimits(s, c)) && !(await service.capped(s));
		const lock = s.on.includes('language_lock') ? await s.values('language_lock') : null;
		const markers = lock ? markerSetsOf(lock.markerWords) : [];
		const language = last ? await languageOf(s, last.text) : null;
		/** @type {import('../core/language.js').CheckOptions} */
		const check = {
			markers,
			latinFor: lock?.acceptLatinFor ?? [],
		};
		// the shop's sign-in tools only for the user whose sign-in Chat verified on this request
		const signIn = await s.signIn();
		const verified = signIn && visitor && signIn.user.id === visitor.id ? signIn.token : null;
		const settings = await s.values('ai_replies');
		/** @type {{ text: string, failure: string | null, escalation: { reason: string } | null }} */
		let result = { text: '', failure: 'unavailable', escalation: null };
		/** @type {import('../core/shop.js').ProductCard[]} */
		let cards = [];
		if (allowed && last) {
			const botName = (await s.texts())['chat.botName'];
			const tools = reassure ? null : await toolsOf(s, c, visitor, verified);
			const system = buildSystemPrompt({
				botName: String(botName),
				business: await s.business(),
				instructions: s.on.includes('ai_instructions')
					? String((await s.values('ai_instructions')).instructions) || null
					: null,
				style: String(settings.style),
				dontKnow: String(settings.dontKnow),
				language,
				languageAlso: language ? (languageForms(language, check.latinFor ?? [])[1] ?? null) : null,
				passages: reassure ? [] : await knowledge(s, last.text, language),
				visitor: { signedIn: visitor !== null, name: c.name },
				page: await namedPage(s, c.currentPage ?? c.page),
				handoff: !reassure && s.on.includes('handoff'),
				shop: { tools: tools?.shop ?? false, cards: (tools?.shop ?? false) && s.on.includes('product_cards') },
				neverDisclose: settings.neverDisclose === true,
				bubbles: reassure ? 1 : Number(settings.bubbles),
				context: reassure ? null : await storeContext(s, c, verified),
				reassure,
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
					tools: tools?.schemas ?? [],
					maxRounds: tools && tools.schemas.length > 0 ? MAX_TOOL_ROUNDS : 0,
					languageOk: language ? (text) => replyMatchesLanguage(text, language, check) : null,
					retryInstruction: language ? languageRetry(language) : '',
					checks:
						settings.neverDisclose === true
							? [
									{
										ok: (text) => !disclosesBot(text, botPhrases(settings.extraBotPhrases)),
										retry: DISCLOSE_RETRY,
										failure: 'disclosed',
									},
								]
							: [],
				},
				{
					call: (request) => complete(s, connections, request),
					execute: tools ? tools.execute : async () => ({ ok: false, content: 'No such tool.' }),
					spend: (usage) => service.spend(s, usage.input + usage.output),
					expired: () => {
						onCall?.();
						return now() > deadline;
					},
				},
			);
			cards = tools ? tools.cards() : [];
		}
		c = /** @type {ConversationRecord} */ (await s.store.conversations.get(conversationId));
		if ((c.waiting && !reassure) || c.aiPaused) {
			await done();
			return settle();
		}
		const texts = await s.texts();
		const botName = (await s.texts())['chat.botName'];
		/** Post an answer as the assistant: markdown, split into bubbles, the cards on the last one. @param {string[]} parts */
		const post = async (parts) => {
			let current = c;
			for (const [index, part] of parts.entries()) {
				const last = index === parts.length - 1;
				current = (
					await service.append(
						s,
						current,
						{ author: 'ai', text: part, name: String(botName), format: 'markdown', ...(last ? { cards } : {}) },
						last ? { set: { aiPending: false, aiFailures: 0 }, inc: { aiReplies: 1 } } : {},
					)
				).conversation;
			}
			return current;
		};
		if (result.text) {
			const moderation = await service.moderation(s);
			const { email, phone } = await s.business();
			const checked = moderateOutbound(result.text, moderation, {
				labels: labelsOf(texts),
				websiteDomain: await domainOf(s),
				own: { email, phone },
			});
			if (checked.ok) {
				const parts = splitBubbles(await linksOf(s, checked.text), reassure ? 1 : Number(settings.bubbles), {
					tables: settings.tableBubble === true,
				});
				const posted = await post(parts.length > 0 ? parts : [checked.text]);
				if (result.escalation) await handOff(s, posted);
				return settle();
			}
		}
		if (reassure) {
			await done();
			return;
		}
		if (result.escalation) {
			await handOff(s, /** @type {ConversationRecord} */ (await done()));
			return settle();
		}
		// a fallback answer from the merchant's list, filled with live shop data (C3)
		const fallback = await fallbackAnswer(s, { message: last?.text ?? '', language, signIn: verified });
		if (fallback) {
			cards = [];
			await post([await linksOf(s, fallback)]);
			return settle();
		}
		// the AI could not answer: the on-failure setting, and a handoff after N failures in a row. An answer that stayed
		// in the wrong language is a failure too, but never hands off by itself: the AI works, so the visitor gets the
		// unavailable message (CH-19). That message is in the visitor's language when the language lock has it.
		const failed = /** @type {ConversationRecord} */ (
			await s.store.conversations.update(conversationId, { set: { aiPending: false }, inc: { aiFailures: 1 } })
		);
		const { onFailure } = settings;
		const { failuresBeforeHandoff } = await s.values('handoff');
		const wrongLanguage = result.failure === 'language';
		const inARow = Number(failuresBeforeHandoff) > 0 && failed.aiFailures >= Number(failuresBeforeHandoff);
		const handoffNow = s.on.includes('handoff') && (inARow || (onFailure !== 'message' && !wrongLanguage));
		let current = failed;
		if (onFailure !== 'handoff' || !handoffNow) {
			const translated = lock && language ? translationOf(lock.unavailableTexts, language) : null;
			current = (await service.botMessage(s, current, translated ?? String(texts['chat.aiUnavailable']))).conversation;
		}
		if (handoffNow) await handOff(s, current);
		await settle();
	};

	/**
	 * The AI summary of a conversation (on handoff and on demand); counted in the AI token caps.
	 * @param {Site} s
	 * @param {string} conversationId
	 * @returns {Promise<string>}
	 */
	const summarize = async (s, conversationId) => {
		const connections = await connectionsOf(s, { backup: true });
		if (connections.length === 0 || (await service.capped(s)))
			throw problem('ai_unavailable', 'The AI cannot write a summary now (no AI key, or an AI token cap is reached).');
		const messages = await s.store.messages.list(conversationId, { limit: 200, internal: false });
		const transcript = messages.map((m) => `${m.author}: ${m.text}`).join('\n');
		const result = await complete(s, connections, {
			messages: [
				{ role: 'system', content: summaryPrompt(String((await s.values('ai_summary')).instructions)) },
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

	/**
	 * AI tagging (C7, the inbox setting `aiTagging`, AI replies on): the AI picks a conversation's topic, tags and
	 * priority from the merchant's lists only, and fills only what is still empty (staff choices stay). Quietly does
	 * nothing without lists, an AI key, or under a token cap.
	 * @param {Site} s
	 * @param {string} conversationId
	 */
	const tagWithAi = async (s, conversationId) => {
		if (!s.on.includes('inbox') || !s.on.includes('ai_replies') || (await s.values('inbox')).aiTagging !== true) return;
		const labels = await labelListsOf(s);
		if (labels.tags.length + labels.topics.length + labels.priorities.length === 0) return;
		const c = await s.store.conversations.get(conversationId);
		if (!c || (c.tags.length > 0 && c.topic && c.priority)) return;
		const connections = await connectionsOf(s, { backup: true });
		if (connections.length === 0 || (await service.capped(s))) return;
		const messages = await s.store.messages.list(conversationId, { limit: 100, internal: false });
		const result = await complete(s, connections, {
			messages: [
				{ role: 'system', content: taggingPrompt(labels) },
				{
					role: 'user',
					content: messages
						.map((m) => `${m.author}: ${m.text}`)
						.join('\n')
						.slice(-12_000),
				},
			],
			tools: [],
		});
		if (!result.ok) return;
		await service.spend(s, result.value.usage.input + result.value.usage.output);
		const picked = parseTagging(result.value.text, labels);
		if (!picked) return;
		/** @type {Record<string, unknown>} */
		const set = {};
		if (c.tags.length === 0 && picked.tags.length > 0) set.tags = picked.tags;
		if (!c.topic && picked.topic) set.topic = picked.topic;
		if (!c.priority && picked.priority) set.priority = picked.priority;
		if (Object.keys(set).length === 0) return;
		await s.store.conversations.update(conversationId, { set });
		await service.log(s, AI_ACTOR, 'conversation.labels_changed', conversationId, {
			label: c.name || 'Conversation',
			detail: labeledDetail(set, labels),
		});
	};

	return Object.freeze({
		afterVisitorMessage,
		handOff,
		startFlow,
		runFlow,
		summarize,
		tagWithAi,
		answer,
		resume,
		linksOf,
	});
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
