/**
 * The chatbot service: conversations and the message pipeline (moderation → language → flows → handoff → AI →
 * moderation), handoff to the inbox with assignment and SLAs, agent replies and notes, status changes with CSAT and
 * closing, guest claims, leads, ratings, proactive messages, agents, transcripts, the order/customer caches fed by
 * events and the periodic maintenance. Pure decisions live in core/; this layer only orders effects.
 *
 * Exactly once: ids of conversations, messages, leads and agents derive from the request's Idempotency-Key (app-kit
 * also replays the stored response), stores are upserts keyed by them, and usage records and events carry the same
 * derived keys, so a retried request never double-stores, double-meters or double-publishes.
 */
import { createId } from '@ss/contracts';
import {
	canTransition,
	conversationView,
	guestLimitReached,
	messageView,
	newConversation,
	sanitiseContext,
	streamEtag,
	summaryAfter,
	validateText,
} from '../core/conversation.js';
import { shouldAsk, summarise, validateRating } from '../core/csat.js';
import { matchFlow, stepFlow } from '../core/flows.js';
import {
	aiMayResume,
	pickAgent,
	renderCanned,
	routeByRules,
	shouldHandoff,
	slaBreaches,
	slaFor,
	teamOf,
	teamOpen,
	teamOpensAt,
} from '../core/inbox.js';
import { catalogLanguage, detectLanguage } from '../core/language.js';
import { normaliseLead, validateLead } from '../core/leads.js';
import { moderateInbound } from '../core/moderation.js';
import { mentionsOf } from '../core/notes.js';
import { emptyMemory, pickProactive, recordDismissed, recordShown, sanitiseVisitorContext } from '../core/proactive.js';
import { DAY_MS, HOUR_MS, iso, monthKey } from '../core/time.js';
import { retainUntil, transcriptJson, transcriptText } from '../core/transcripts.js';
import { createTranslator } from '../core/strings.js';
import { createAssistant } from './assistant.js';
import { createKnowledge } from './knowledge.js';

/** @typedef {import('../core/conversation.js').Conversation} Conversation */
/** @typedef {import('../core/conversation.js').Message} Message */
/** @typedef {import('../adapters/db.js').Repositories} Repositories */
/** @typedef {import('./settings.js').Settings} Settings */
/**
 * @typedef {object} Site
 * @property {string} websiteId
 * @property {string | null} domain the website's domain (from its key binding / document) — the link policy
 * @property {Settings} settings
 * @property {Repositories} repos
 */
/**
 * @typedef {object} Deps
 * @property {(event: { websiteId: string, type: string, data: Record<string, unknown>, idempotencyKey: string }) => Promise<unknown>} publish
 * @property {(usage: { websiteId: string, unit: string, quantity: number, idempotencyKey: string }) => Promise<unknown>} recordUsage
 * @property {(entry: Record<string, unknown>) => Promise<unknown>} audit
 * @property {(websiteId: string) => Promise<import('../adapters/ai.js').ChatAdapter>} ai the merchant's AI connector
 * @property {{ fetch: import('../adapters/platform.js').Send }} outbound
 * @property {import('../adapters/tokens.js').Tokens} tokens
 * @property {(text: string) => string} hash
 * @property {(n: number) => Uint8Array} randomBytes
 * @property {() => number} now
 * @property {Record<string, Record<string, string>>} strings catalogs by language
 * @property {{ warn?: (message: string, fields?: Record<string, unknown>) => void }} [log]
 * @property {{ orders: number, customers: number, visitors: number }} retention days, from the manifest's `retention`
 */
/** @typedef {{ customerId: string | null, visitorId: string | null, identity: { subject: string, email?: string | null } | null }} Owner */
/** @typedef {{ type: 'customer' | 'agent' | 'api' | 'staff' | 'merchant' | 'system', id: string | null, name?: string | null }} Actor */

/** @param {string} reason @param {Record<string, unknown>} [extra] */
const failure = (reason, extra = {}) => /** @type {const} */ ({ ok: false, reason, ...extra });

/**
 * @param {Deps} deps
 */
export const createChatbotService = (deps) => {
	const { now, hash } = deps;
	const knowledge = createKnowledge(deps);
	const assistant = createAssistant({ ...deps, knowledge });
	const languages = Object.keys(deps.strings);

	/** Translator for a language (catalog fallback: primary subtag, then `en`). @param {string} language */
	const translator = (language) => {
		const lang = catalogLanguage(language, languages, 'en');
		return createTranslator({ ...(deps.strings.en ?? {}), ...(deps.strings[lang] ?? {}) });
	};

	/** Best-effort publish (the Portal may be down; the data is stored either way). @param {Parameters<Deps['publish']>[0]} event */
	const publish = async (event) => {
		try {
			await deps.publish(event);
		} catch (error) {
			deps.log?.warn?.('event publish failed', { type: event.type, error: /** @type {Error} */ (error)?.message });
		}
	};
	/** @param {Parameters<Deps['recordUsage']>[0]} usage */
	const meter = async (usage) => {
		try {
			await deps.recordUsage(usage);
		} catch (error) {
			deps.log?.warn?.('usage record failed', { unit: usage.unit, error: /** @type {Error} */ (error)?.message });
		}
	};

	/** Retention instant of a website. @param {Site} site */
	const retain = (site) => retainUntil(now(), site.settings.transcripts.retention_days);

	/**
	 * A message document.
	 * @param {Conversation} conversation
	 * @param {{ id: string, author: Message['author'], body: string, at: string, kind?: string, internal?: boolean, payload?: Record<string, unknown> | null,
	 *   authorId?: string | null, authorName?: string | null, language?: string | null }} input
	 * @returns {Message}
	 */
	const messageOf = (conversation, input) => ({
		id: input.id,
		conversationId: conversation.id,
		customerId: conversation.customerId,
		author: input.author,
		authorId: input.authorId ?? null,
		authorName: input.authorName ?? null,
		kind: input.kind ?? 'text',
		internal: input.internal ?? false,
		body: input.body,
		payload: input.payload ?? null,
		language: input.language ?? null,
		at: input.at,
	});

	/**
	 * Store messages and move the conversation summary atomically.
	 * @param {Site} site
	 * @param {Conversation} conversation
	 * @param {Message[]} messages
	 * @param {{ set?: Record<string, unknown>, inc?: Record<string, number>, push?: Record<string, unknown> }} [extra]
	 * @returns {Promise<Conversation>}
	 */
	const append = async (site, conversation, messages, extra = {}) => {
		const until = retain(site);
		if (messages.length > 0)
			await site.repos.messages.insert(messages, { retainUntil: until, visitorId: conversation.visitorId });
		const summary = summaryAfter(conversation, messages);
		const visible = messages.filter((m) => !m.internal);
		const agentReplied = visible.some((m) => m.author === 'agent');
		/** @type {Record<string, number>} */
		const inc = {
			...(extra.inc ?? {}),
			'counts.messages': visible.length,
			'counts.customer': visible.filter((m) => m.author === 'customer').length,
			'counts.unreadByCustomer': visible.filter((m) => m.author === 'agent' || m.author === 'bot').length,
			...(agentReplied ? {} : { 'counts.unreadByTeam': visible.filter((m) => m.author === 'customer').length }),
		};
		const set = {
			...(visible.length > 0 ? { status: summary.status, last: summary.last } : {}),
			...(agentReplied ? { 'counts.unreadByTeam': 0 } : {}),
			...(summary.firstResponseAt ? { 'sla.firstResponseAt': summary.firstResponseAt } : {}),
			...(summary.status === 'open' && conversation.status !== 'open' ? { snoozedUntil: null } : {}),
			retainUntil: until,
			...(extra.set ?? {}),
		};
		const updated = /** @type {Conversation} */ (
			await site.repos.conversations.update(conversation.id, { set, inc, ...(extra.push ? { push: extra.push } : {}) })
		);
		for (const message of visible)
			await publish({
				websiteId: site.websiteId,
				type: 'chatbot.message@1',
				data: {
					conversationId: conversation.id,
					messageId: message.id,
					author: message.author,
					kind: message.kind,
					length: [...message.body].length,
					...(message.language ? { language: message.language } : {}),
					...(conversation.customerId ? { customerId: conversation.customerId } : {}),
				},
				idempotencyKey: `message:${message.id}`,
			});
		return updated ?? conversation;
	};

	/** Bot message ids derived from the triggering message. @param {string} base @param {number} index */
	const botId = (base, index) => `msg_${hash(`${base}:reply:${index}`)}`;

	/**
	 * Flow outputs → bot messages.
	 * @param {Conversation} conversation
	 * @param {import('../core/flows.js').FlowOutput[]} outputs
	 * @param {{ base: string, at: number, language: string, offset: number }} options
	 */
	const flowMessages = (conversation, outputs, { base, at, language, offset }) =>
		outputs.map((output, index) =>
			messageOf(conversation, {
				id: botId(base, offset + index),
				author: 'bot',
				kind: output.kind,
				body: output.text,
				payload:
					output.kind === 'buttons'
						? { buttons: output.buttons }
						: output.kind === 'form'
							? { fields: output.fields }
							: null,
				language,
				at: iso(at + offset + index + 1),
			}),
		);

	/**
	 * Hand a conversation to a person: team, assignment, SLA, the customer notice or the offline fallback.
	 * @param {Site} site
	 * @param {Conversation} conversation
	 * @param {{ reason: string, team?: string | null, base: string, at: number, offset: number, t: (key: string, params?: Record<string, string | number>) => string,
	 *   context?: Record<string, unknown> }} input
	 * @returns {Promise<{ set: Record<string, unknown>, messages: Message[], offline: boolean, assignee: string | null, team: string }>}
	 */
	const planHandoff = async (site, conversation, { reason, team: requested = null, base, at, offset, t, context = {} }) => {
		const { inbox, handoff, leads } = site.settings;
		const teams =
			Array.isArray(inbox?.teams) && inbox.teams.length > 0 ? inbox.teams : [{ key: inbox?.default_team ?? 'support' }];
		let teamKey = requested || handoff?.team || inbox?.default_team || 'support';
		let preferred = null;
		let priority = null;
		if (inbox?.assignment === 'rules' && Array.isArray(inbox.assignment_rules)) {
			const routed = routeByRules(inbox.assignment_rules, context, { now: at, timeZone: site.settings.timeZone });
			teamKey = routed.team ?? teamKey;
			preferred = routed.agentId;
			priority = routed.priority;
		}
		const team = teamOf(teams, teamKey, inbox?.default_team ?? 'support');
		const open = Boolean(inbox) && teamOpen(team, at, site.settings.timeZone);
		/** @type {string | null} */
		let assignee = null;
		if (inbox && open) {
			const [agents, loads] = await Promise.all([site.repos.agents.all(), site.repos.conversations.loads()]);
			const cursorKey = `rr:${team.key}`;
			const cursor = inbox.assignment === 'round_robin' ? await site.repos.counters.get(cursorKey) : 0;
			const picked = pickAgent({
				strategy: inbox.assignment,
				agents: agents.map((/** @type {any} */ a) => ({
					...a,
					teams: a.teams ?? [],
					maxConcurrent: a.maxConcurrent ?? null,
				})),
				team: team.key,
				loads,
				defaultMax: inbox.max_concurrent_per_agent,
				cursor,
				preferred,
			});
			assignee = picked.agentId;
			if (picked.cursor !== cursor) await site.repos.counters.add(cursorKey, picked.cursor - cursor);
		}
		const handedAt = iso(at);
		const sla = inbox
			? slaFor({
					at,
					team,
					firstResponseMinutes: inbox.sla_first_response_minutes,
					resolutionMinutes: inbox.sla_resolution_minutes,
					businessHoursOnly: inbox.sla_count_business_hours_only,
					websiteZone: site.settings.timeZone,
				})
			: null;
		/** @type {Message[]} */
		const messages = [];
		let n = offset;
		const say = (/** @type {string} */ body, /** @type {Partial<Message>} */ extra = {}) => {
			messages.push(
				messageOf(conversation, {
					id: botId(base, n),
					author: 'system',
					kind: 'event',
					body,
					language: conversation.language,
					at: iso(at + n + 1),
					...extra,
				}),
			);
			n += 1;
		};
		if (open) {
			say(t('handoff.joining'));
			if (assignee) {
				const agent = await site.repos.agents.get(assignee);
				say(t('handoff.assigned', { agent: agent?.name ?? assignee }));
			} else if (handoff?.show_queue_position)
				say(t('handoff.queue', { position: (await site.repos.conversations.waitingBefore(handedAt)) + 1 }));
		} else {
			const fallback = handoff?.offline_fallback ?? 'lead_form';
			if (fallback === 'lead_form' && leads)
				messages.push(
					messageOf(conversation, {
						id: botId(base, n++),
						author: 'bot',
						kind: 'form',
						body: t('handoff.offline.lead_form'),
						payload: { lead: true, fields: leads.fields, consent: leads.consent_required },
						language: conversation.language,
						at: iso(at + n),
					}),
				);
			else if (fallback === 'link' && handoff?.offline_link) say(t('handoff.offline.link', { link: handoff.offline_link }));
			else say(t('handoff.offline.message'));
			const opens = inbox ? teamOpensAt(team, at, site.settings.timeZone) : null;
			if (opens && opens !== handedAt) say(t('handoff.offline.opens', { at: opens }));
		}
		return {
			set: {
				handoff: { at: handedAt, reason, team: team.key, offline: !open },
				ai: { ...conversation.ai, paused: true, reason: 'handoff', pausedAt: handedAt },
				team: team.key,
				assignee,
				status: 'open',
				...(priority ? { priority } : {}),
				...(sla ? { sla } : {}),
			},
			messages,
			offline: !open,
			assignee,
			team: team.key,
		};
	};

	/** @param {Site} site @param {Conversation} conversation @param {Awaited<ReturnType<typeof planHandoff>>} plan @param {string} reason */
	const publishHandoff = (site, conversation, plan, reason) =>
		publish({
			websiteId: site.websiteId,
			type: 'chatbot.handoff@1',
			data: {
				conversationId: conversation.id,
				reason,
				team: plan.team,
				offline: plan.offline,
				...(plan.assignee ? { assignee: plan.assignee } : {}),
				...(conversation.customerId ? { customerId: conversation.customerId } : {}),
			},
			idempotencyKey: `handoff:${conversation.id}:${String(plan.set.handoff && /** @type {any} */ (plan.set.handoff).at)}`,
		});

	/**
	 * The bot's turn after a customer message (or a conversation start).
	 * @param {Site} site
	 * @param {Conversation} conversation conversation before the customer message
	 * @param {{ text: string, action: Record<string, any> | null, base: string, at: number, language: string, identity: Owner['identity'], entry: 'start' | 'message', customerName?: string | null }} input
	 * @returns {Promise<{ messages: Message[], set: Record<string, unknown>, inc: Record<string, number>, effects: Array<Record<string, any>>, handoff: Awaited<ReturnType<typeof planHandoff>> | null }>}
	 */
	const botTurn = async (site, conversation, input) => {
		const { settings } = site;
		const t = translator(input.language);
		/** @type {Message[]} */
		const out = [];
		/** @type {Record<string, unknown>} */
		const set = {};
		/** @type {Record<string, number>} */
		const inc = {};
		/** @type {Array<Record<string, any>>} */
		const effects = [];
		/** @type {Awaited<ReturnType<typeof planHandoff>> | null} */
		let handoff = null;
		let aiUnavailable = false;
		const ruleContext = {
			conversation: {
				status: conversation.status,
				messages: conversation.counts.messages,
				tags: conversation.tags,
				priority: conversation.priority,
				language: input.language,
			},
			customer: { identified: Boolean(input.identity) },
			message: { text: input.text },
			page: conversation.context?.page ?? {},
		};
		const doHandoff = async (/** @type {string} */ reason, /** @type {string | null} */ team = null) => {
			if (!settings.handoff || handoff || (conversation.handoff && conversation.ai.paused)) return;
			handoff = await planHandoff(site, conversation, {
				reason,
				team,
				base: input.base,
				at: input.at,
				offset: out.length + 20,
				t,
				context: ruleContext,
			});
			out.push(...handoff.messages);
			const failures = set['ai.failures'];
			Object.assign(set, handoff.set);
			// the handoff replaces the whole `ai` sub-document: carry the failure count into it (no path conflict)
			if (failures !== undefined) {
				set.ai = { .../** @type {Record<string, unknown>} */ (set.ai), failures };
				delete set['ai.failures'];
			}
		};
		/** Run the AI and append its bubbles (or the failure behaviour). */
		const runAi = async (/** @type {{ awaitingHuman?: boolean, step?: string | null }} */ options = {}) => {
			const history = await site.repos.messages.recent(conversation.id, (settings.ai?.history_turns ?? 10) * 2 + 2);
			const result = await assistant.answer(site, {
				conversation,
				text: input.text,
				language: input.language,
				identity: input.identity,
				history,
				t,
				meterKey: `${conversation.id}:${input.base}:${out.length}`,
				awaitingHuman: options.awaitingHuman ?? false,
				step: options.step ?? null,
				customerName: input.customerName ?? conversation.contact?.name ?? null,
			});
			inc.tokens = (inc.tokens ?? 0) + result.usage.input + result.usage.output;
			inc.toolCalls =
				(inc.toolCalls ?? 0) +
				result.tools.filter((tool) => !['search_knowledge', 'escalate_to_human'].includes(tool.name)).length;
			if (result.dontKnow === 'handoff') {
				await doHandoff('knowledge_gap');
				return null;
			}
			if (result.dontKnow === 'say') {
				out.push(
					messageOf(conversation, {
						id: botId(input.base, out.length),
						author: 'bot',
						body: t('ai.dont_know'),
						language: input.language,
						at: iso(input.at + out.length + 1),
					}),
				);
				return t('ai.dont_know');
			}
			if (result.failure === 'disabled' || result.failure === 'unavailable' || result.failure === 'no_model') {
				aiUnavailable = true;
				return null;
			}
			if (result.failure) {
				const failures = conversation.ai.failures + 1;
				set['ai.failures'] = failures;
				const onFailure = settings.ai?.on_failure ?? 'fallback_message';
				if (
					onFailure === 'handoff' ||
					(settings.handoff && settings.handoff.after_ai_failures > 0 && failures >= settings.handoff.after_ai_failures)
				) {
					await doHandoff('ai_failures');
					return null;
				}
				if (onFailure === 'fallback_message')
					out.push(
						messageOf(conversation, {
							id: botId(input.base, out.length),
							author: 'bot',
							body: t(result.failure === 'budget' ? 'ai.fallback.budget' : 'ai.fallback'),
							language: input.language,
							at: iso(input.at + out.length + 1),
						}),
					);
				return null;
			}
			set['ai.failures'] = 0;
			for (const bubble of result.bubbles)
				out.push(
					messageOf(conversation, {
						id: botId(input.base, out.length),
						author: 'bot',
						body: bubble,
						language: input.language,
						at: iso(input.at + out.length + 1),
					}),
				);
			if (result.escalation) await doHandoff(`ai:${result.escalation.reason}`.slice(0, 120));
			return result.bubbles.join('\n');
		};

		// 1. flows
		let handled = false;
		if (settings.flows) {
			const flowsConfig = settings.flows;
			const all = Array.isArray(flowsConfig.flows) ? flowsConfig.flows : [];
			const running = conversation.flow ? all.find((/** @type {any} */ f) => f.id === conversation.flow?.flowId) : null;
			const flow =
				running ??
				matchFlow(
					all,
					{ entry: input.entry, text: input.text, path: conversation.context?.page?.path ?? '' },
					{ context: ruleContext, now: input.at, timeZone: settings.timeZone },
				);
			if (flow) {
				const flowInput = !running
					? { kind: /** @type {const} */ ('start') }
					: input.action?.kind === 'button'
						? { kind: /** @type {const} */ ('button'), value: String(input.action.value ?? '') }
						: input.action?.kind === 'form'
							? { kind: /** @type {const} */ ('form'), values: input.action.values ?? {} }
							: { kind: /** @type {const} */ ('text'), text: input.text };
				const step = await stepFlow(
					{
						flow,
						state: running ? conversation.flow : null,
						input: flowInput,
						context: ruleContext,
						options: {
							maxSteps: flowsConfig.max_steps_per_turn,
							unmatched: flowsConfig.unmatched_input,
							exitKeywords: flowsConfig.exit_keywords,
							now: input.at,
							timeZone: settings.timeZone,
							invalidAnswer: t('flows.invalid_answer'),
						},
					},
					{
						// the AI step's bubbles are appended by runAi itself, so the flow gets no text back
						runAi: async (prompt) => {
							await runAi({ step: prompt });
							return null;
						},
						runTool: async (name, args) => {
							const call = { id: `flow_${name}_${out.length}`, name, arguments: args };
							const custom = (settings.tools?.custom ?? []).find(
								(tool) => tool.name === name && tool.allow_flows !== false,
							);
							if (!custom) return { ok: false, output: t('tools.result.failed') };
							const result = await assistant.executeTool(
								{
									...site,
									settings: {
										...settings,
										tools: settings.tools ? { ...settings.tools, custom: [{ ...custom, allow_ai: true }] } : null,
									},
								},
								{ conversation, identity: input.identity, t, meterKey: `${conversation.id}:${input.base}` },
								call,
							);
							inc.toolCalls = (inc.toolCalls ?? 0) + 1;
							return { ok: result.ok, output: result.content };
						},
					},
				);
				set.flow = step.state;
				out.push(
					...flowMessages(conversation, step.outputs, {
						base: input.base,
						at: input.at,
						language: input.language,
						offset: out.length,
					}),
				);
				for (const effect of step.effects) {
					if (effect.kind === 'handoff') await doHandoff(effect.reason, effect.team);
					else if (effect.kind === 'ai_fallback') await runAi();
					else effects.push(effect);
				}
				handled = step.consumed;
			}
		}
		if (handled || input.entry === 'start') return { messages: out, set, inc, effects, handoff };

		// 2. handoff by phrase, rule or repeated failures
		const decision = shouldHandoff(
			{ text: input.text, conversation, identified: Boolean(input.identity) },
			/** @type {any} */ (settings.handoff),
			{
				now: input.at,
				timeZone: settings.timeZone,
			},
		);
		if (decision.handoff) {
			await doHandoff(/** @type {string} */ (decision.reason));
			return { messages: out, set, inc, effects, handoff };
		}

		// 3. waiting for a person: the AI helps again only after the grace window
		if (conversation.ai.paused) {
			if (
				settings.ai &&
				aiMayResume(conversation, { resumeAfterMinutes: settings.handoff?.ai_resume_after_minutes ?? 0, now: input.at })
			)
				await runAi({ awaitingHuman: true });
			return { messages: out, set, inc, effects, handoff };
		}

		// 4. the AI; without AI the conversation goes to a person
		if (settings.ai) {
			await runAi();
			// AI on but not usable (connector missing, no model): a person answers instead
			if (aiUnavailable && out.length === 0) await doHandoff('ai_unavailable');
		} else await doHandoff('no_ai');
		return { messages: out, set, inc, effects, handoff };
	};

	/**
	 * Apply flow side effects (tags, priority, leads, close).
	 * @param {Site} site
	 * @param {Conversation} conversation
	 * @param {Array<Record<string, any>>} effects
	 * @param {string} base
	 */
	const applyEffects = async (site, conversation, effects, base) => {
		let current = conversation;
		for (const [index, effect] of effects.entries()) {
			if (effect.kind === 'tag' && !current.tags.includes(effect.tag))
				current = /** @type {Conversation} */ (
					(await site.repos.conversations.update(current.id, { push: { tags: effect.tag } })) ?? current
				);
			else if (effect.kind === 'priority')
				current = /** @type {Conversation} */ (
					(await site.repos.conversations.update(current.id, { set: { priority: effect.priority } })) ?? current
				);
			else if (effect.kind === 'lead' && site.settings.leads) {
				const fields = Object.fromEntries(
					Object.entries(effect.fields).filter(([name]) =>
						site.settings.leads?.fields.some((/** @type {any} */ f) => f.name === name),
					),
				);
				await storeLead(site, {
					conversation: current,
					owner: { customerId: current.customerId, visitorId: current.visitorId, identity: null },
					values: fields,
					consent: true,
					key: `${base}:lead:${index}`,
					source: 'flow',
				});
			} else if (effect.kind === 'close')
				current = (
					await close(site, current, { actor: { type: 'system', id: 'flow' }, reason: 'flow', key: `${base}:close` })
				).conversation;
		}
		return current;
	};

	/**
	 * Store a lead (idempotent per key) and publish it.
	 * @param {Site} site
	 * @param {{ conversation: Conversation | null, owner: Owner, values: Record<string, unknown>, consent: boolean, key: string, source: 'form' | 'flow' | 'api' }} input
	 */
	const storeLead = async (site, { conversation, owner, values, consent, key, source }) => {
		const leads = /** @type {Record<string, any>} */ (site.settings.leads);
		const { values: clean, contact } = normaliseLead(values, leads.fields);
		const id = `lead_${hash(`lead:${key}`)}`;
		const t = translator(conversation?.language ?? site.settings.window.default_language);
		const lead = {
			id,
			conversationId: conversation?.id ?? null,
			customerId: owner.customerId,
			visitorId: owner.visitorId,
			fields: clean,
			contact,
			consent: { given: consent, text: consent ? t('window.form.consent') : null },
			source,
			at: iso(now()),
		};
		const stored = await site.repos.leads.insert(lead);
		if (stored) {
			if (conversation)
				await site.repos.conversations.update(conversation.id, {
					set: { contact: { ...(conversation.contact ?? {}), ...contact } },
				});
			if (leads.publish_event)
				await publish({
					websiteId: site.websiteId,
					type: 'chatbot.lead_captured@1',
					data: {
						leadId: id,
						...(conversation ? { conversationId: conversation.id } : {}),
						...(owner.customerId ? { customerId: owner.customerId } : {}),
						contact: Object.fromEntries(Object.entries(contact).filter(([, v]) => v !== null)),
						fields: Object.keys(clean),
						source,
					},
					idempotencyKey: `lead:${id}`,
				});
			const forward = leads.forward_tool
				? (site.settings.tools?.custom ?? []).find((/** @type {any} */ tool) => tool.name === leads.forward_tool)
				: null;
			if (forward)
				await assistant.callWebhook(
					site,
					forward,
					{ lead: clean, contact },
					{ conversationId: conversation?.id ?? null, identity: owner.identity, t },
				);
		}
		return /** @type {Record<string, any>} */ (await site.repos.leads.get(id));
	};

	/**
	 * Close a conversation (idempotent): status, CSAT survey, `chatbot.closed@1`.
	 * @param {Site} site
	 * @param {Conversation} conversation
	 * @param {{ actor: Actor, reason: string, key: string }} input
	 * @returns {Promise<{ conversation: Conversation, messages: Message[] }>}
	 */
	const close = async (site, conversation, { actor, reason, key }) => {
		if (conversation.status === 'closed') return { conversation, messages: [] };
		const at = now();
		const t = translator(conversation.language);
		/** @type {Message[]} */
		const messages = [
			messageOf(conversation, {
				id: `msg_${hash(`${key}:closed`)}`,
				author: 'system',
				kind: 'event',
				body: t('system.closed'),
				at: iso(at),
			}),
		];
		const ask = shouldAsk(site.settings.csat, {
			event: 'closed',
			humanInvolved: Boolean(conversation.handoff),
			alreadyAsked: Boolean(conversation.csat?.askedAt),
		});
		if (ask && site.settings.csat)
			messages.push(
				messageOf(conversation, {
					id: `msg_${hash(`${key}:csat`)}`,
					author: 'bot',
					kind: 'csat',
					body: t('csat.ask'),
					payload: { scale: site.settings.csat.scale, comment: site.settings.csat.follow_up },
					at: iso(at + 1),
				}),
			);
		const updated = await append(site, conversation, messages, {
			set: {
				status: 'closed',
				closedAt: iso(at),
				flow: null,
				...(ask ? { csat: { askedAt: iso(at), score: null, comment: null, ratedAt: null } } : {}),
			},
		});
		const final = updated;
		await publish({
			websiteId: site.websiteId,
			type: 'chatbot.closed@1',
			data: {
				conversationId: conversation.id,
				reason,
				by: actor.type,
				messages: final.counts.messages,
				durationSeconds: Math.max(0, Math.round((at - Date.parse(conversation.openedAt)) / 1000)),
				handedOff: Boolean(conversation.handoff),
				...(conversation.customerId ? { customerId: conversation.customerId } : {}),
			},
			idempotencyKey: `closed:${conversation.id}`,
		});
		return { conversation: final, messages };
	};

	/**
	 * Conversations an owner may see: as `$or` filters.
	 * @param {Owner} owner
	 * @returns {Array<Record<string, string>>}
	 */
	const ownerFilters = (owner) => [
		...(owner.customerId ? [{ customerId: owner.customerId }] : []),
		...(owner.visitorId ? [{ visitorId: owner.visitorId }] : []),
	];
	/** Does the owner own the conversation? @param {Conversation} conversation @param {Owner} owner */
	const owns = (conversation, owner) =>
		Boolean(
			(owner.customerId && conversation.customerId === owner.customerId) ||
			(owner.visitorId && conversation.visitorId === owner.visitorId),
		);

	return Object.freeze({
		knowledge,
		assistant,
		translator,
		owns,

		/**
		 * Start a conversation (idempotent per key), optionally with the first message.
		 * @param {Site} site
		 * @param {{ owner: Owner, text?: string | null, context?: unknown, language?: string | null, subject?: string | null, contact?: Conversation['contact'],
		 *   custom?: Record<string, unknown>, key: string, flowId?: string | null, enforceOpenLimit?: boolean }} input
		 *   `enforceOpenLimit: false` for the merchant's server (the per-visitor cap guards browsers)
		 */
		start: async (site, input) => {
			const { settings } = site;
			const owners = ownerFilters(input.owner);
			const id = `cnv_${hash(`conversation:${site.websiteId}:${input.key}`)}`;
			const existing = await site.repos.conversations.get(id);
			if (existing) return { ok: true, conversation: existing, messages: [], created: false };
			if (
				input.enforceOpenLimit !== false &&
				owners.length > 0 &&
				(await site.repos.conversations.countOpen(owners)) >= settings.window.max_open_conversations
			)
				return failure('too_many_conversations');
			const at = now();
			const text = typeof input.text === 'string' ? input.text : null;
			const language =
				input.language && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(input.language)
					? input.language
					: text && settings.window.detect_language
						? detectLanguage(text, {
								fallback: settings.window.default_language,
								allowed: settings.window.allowed_languages,
								markers: settings.window.language_markers,
							}).language
						: settings.window.default_language;
			const conversation = newConversation({
				id,
				at: iso(at),
				customerId: input.owner.customerId,
				visitorId: input.owner.visitorId,
				language,
				priority: settings.inbox?.default_priority ?? 'normal',
				context: sanitiseContext(input.context),
				subject: input.subject ?? null,
				contact: input.contact ?? null,
				...(input.custom ? { custom: input.custom } : {}),
			});
			const inserted = await site.repos.conversations.insert(conversation, retain(site));
			if (!inserted)
				return {
					ok: true,
					conversation: /** @type {Conversation} */ (await site.repos.conversations.get(id)),
					messages: [],
					created: false,
				};
			await meter({ websiteId: site.websiteId, unit: 'conversation', quantity: 1, idempotencyKey: `conversation:${id}` });
			await publish({
				websiteId: site.websiteId,
				type: 'chatbot.started@1',
				data: {
					conversationId: id,
					channel: 'web',
					identified: Boolean(input.owner.customerId),
					language,
					...(input.owner.customerId ? { customerId: input.owner.customerId } : {}),
					...(conversation.context?.page?.path ? { path: conversation.context.page.path } : {}),
				},
				idempotencyKey: `started:${id}`,
			});
			// greeting flows (conversation start / page triggers)
			/** @type {Message[]} */
			let messages = [];
			let current = conversation;
			if (settings.flows) {
				const turn = await botTurn(site, conversation, {
					text: text ?? '',
					action: null,
					base: `${id}:start`,
					at,
					language,
					identity: input.owner.identity,
					entry: 'start',
				});
				if (turn.messages.length > 0 || Object.keys(turn.set).length > 0) {
					current = await append(site, conversation, turn.messages, { set: turn.set, inc: turn.inc });
					messages = turn.messages;
					current = await applyEffects(site, current, turn.effects, `${id}:start`);
				}
			}
			return { ok: true, conversation: current, messages, created: true, text };
		},

		/**
		 * A customer message (or a button / form action) and the bot's turn.
		 * @param {Site} site
		 * @param {Conversation} conversation
		 * @param {{ text?: unknown, action?: unknown, key: string, owner: Owner, customerName?: string | null }} input
		 */
		customerMessage: async (site, conversation, input) => {
			const { settings } = site;
			if (conversation.status === 'closed') return failure('conversation_closed');
			if (guestLimitReached(conversation, settings.window.guest_message_limit)) return failure('guest_limit_reached');
			const action =
				input.action && typeof input.action === 'object' && !Array.isArray(input.action)
					? /** @type {Record<string, any>} */ (input.action)
					: null;
			if (action && !['button', 'form'].includes(action.kind))
				return failure('validation_failed', { problems: [{ path: '/action/kind', code: 'invalid' }] });
			const rawText =
				typeof input.text === 'string' && input.text.trim()
					? input.text
					: action?.kind === 'button'
						? String(action.label ?? action.value ?? '')
						: action?.kind === 'form'
							? Object.values(action.values ?? {})
									.filter((v) => typeof v === 'string' || typeof v === 'number')
									.join(' · ')
									.slice(0, settings.window.max_message_length) || '✓'
							: input.text;
			const checked = validateText(rawText, { maxLength: settings.window.max_message_length });
			if (!checked.ok) return failure('validation_failed', { problems: checked.problems });
			const t = translator(conversation.language);
			const moderated = moderateInbound(checked.text, settings.moderation, assistant.labelsOf(t));
			if (!moderated.ok) return failure('message_rejected');
			const at = now();
			const language = settings.window.detect_language
				? detectLanguage(moderated.text, {
						fallback: conversation.language,
						allowed: settings.window.allowed_languages,
						markers: settings.window.language_markers,
					}).language
				: conversation.language;
			const id = `msg_${hash(`message:${conversation.id}:${input.key}`)}`;
			const existing = await site.repos.messages.get(id);
			if (existing) return { ok: true, message: existing, replies: [], conversation };
			const customer = messageOf(conversation, {
				id,
				author: 'customer',
				authorId: conversation.customerId,
				body: moderated.text,
				language,
				at: iso(at),
				...(action
					? {
							payload: {
								action: { kind: action.kind, ...(action.kind === 'button' ? { value: String(action.value ?? '') } : {}) },
							},
						}
					: {}),
			});
			const before = { ...conversation, language };
			const turn = await botTurn(site, before, {
				text: moderated.text,
				action,
				base: id,
				at,
				language,
				identity: input.owner.identity,
				entry: 'message',
				customerName: input.customerName ?? null,
			});
			let updated = await append(site, before, [customer, ...turn.messages], {
				set: { language, ...turn.set },
				inc: turn.inc,
			});
			if (turn.handoff)
				await publishHandoff(site, updated, turn.handoff, String(/** @type {any} */ (turn.handoff.set.handoff).reason));
			updated = await applyEffects(site, updated, turn.effects, id);
			return { ok: true, message: customer, replies: turn.messages, conversation: updated };
		},

		/**
		 * An agent (or API) reply: pauses the AI (a person took over) and records the first response.
		 * @param {Site} site
		 * @param {Conversation} conversation
		 * @param {{ text: unknown, key: string, actor: Actor, agentId?: string | null }} input
		 */
		agentMessage: async (site, conversation, { text, key, actor, agentId = null }) => {
			if (conversation.status === 'closed') return failure('conversation_closed');
			const checked = validateText(text, { maxLength: 8000 });
			if (!checked.ok) return failure('validation_failed', { problems: checked.problems });
			const agent = agentId ? await site.repos.agents.get(agentId) : null;
			if (agentId && !agent) return failure('not_found');
			const at = now();
			const message = messageOf(conversation, {
				id: `msg_${hash(`agent:${conversation.id}:${key}`)}`,
				author: 'agent',
				authorId: agent?.id ?? actor.id,
				authorName: agent?.name ?? actor.name ?? null,
				body: checked.text,
				at: iso(at),
			});
			const updated = await append(site, conversation, [message], {
				set: {
					ai: {
						...conversation.ai,
						paused: true,
						reason: conversation.ai.reason === 'manual' ? 'manual' : 'agent',
						pausedAt: conversation.ai.pausedAt ?? iso(at),
					},
					...(agent && !conversation.assignee ? { assignee: agent.id } : {}),
					...(conversation.handoff
						? {}
						: { handoff: { at: iso(at), reason: 'agent', team: conversation.team, offline: false } }),
				},
			});
			return { ok: true, message, conversation: updated };
		},

		/**
		 * An internal note (team only) and `chatbot.note_created@1`.
		 * @param {Site} site
		 * @param {Conversation} conversation
		 * @param {{ text: string, mentions?: string[], key: string, actor: Actor, agentId?: string | null }} input
		 */
		note: async (site, conversation, { text, mentions = [], key, actor, agentId = null }) => {
			const agent = agentId ? await site.repos.agents.get(agentId) : null;
			const agents = (await site.repos.agents.all()).map((/** @type {any} */ a) => String(a.id));
			const note = messageOf(conversation, {
				id: `msg_${hash(`note:${conversation.id}:${key}`)}`,
				author: 'agent',
				authorId: agent?.id ?? actor.id,
				authorName: agent?.name ?? actor.name ?? null,
				kind: 'note',
				internal: true,
				body: text.trim(),
				payload: { mentions: mentionsOf({ text, mentions }, agents) },
				at: iso(now()),
			});
			await site.repos.messages.insert([note], { retainUntil: retain(site), visitorId: conversation.visitorId });
			await publish({
				websiteId: site.websiteId,
				type: 'chatbot.note_created@1',
				data: {
					noteId: note.id,
					conversationId: conversation.id,
					...(note.authorId ? { authorId: note.authorId } : {}),
					mentions: /** @type {any} */ (note.payload).mentions,
				},
				idempotencyKey: `note:${note.id}`,
			});
			return note;
		},

		/**
		 * Team-side changes: status (with CSAT and closing), assignee, team, priority, tags, snooze, AI pause.
		 * @param {Site} site
		 * @param {Conversation} conversation
		 * @param {Record<string, any>} patch validated by core `validatePatch`
		 * @param {{ actor: Actor, key: string }} context
		 */
		patch: async (site, conversation, patch, { actor, key }) => {
			if (patch.status && !canTransition(conversation.status, patch.status)) return failure('invalid_transition');
			if (patch.assignee && site.settings.inbox && !(await site.repos.agents.get(patch.assignee))) return failure('not_found');
			if (patch.status === 'closed') {
				const closed = await close(site, conversation, { actor, reason: 'agent', key });
				return { ok: true, conversation: closed.conversation };
			}
			const at = now();
			const t = translator(conversation.language);
			/** @type {Record<string, unknown>} */
			const set = {};
			/** @type {Message[]} */
			const messages = [];
			for (const field of ['team', 'priority', 'tags', 'subject', 'custom'])
				if (patch[field] !== undefined) set[field] = patch[field];
			if (patch.assignee !== undefined) {
				set.assignee = patch.assignee;
				if (patch.assignee) {
					const agent = await site.repos.agents.get(patch.assignee);
					messages.push(
						messageOf(conversation, {
							id: `msg_${hash(`${key}:assigned`)}`,
							author: 'system',
							kind: 'event',
							body: t('handoff.assigned', { agent: agent?.name ?? patch.assignee }),
							at: iso(at),
						}),
					);
				}
			}
			if (patch.aiPaused !== undefined)
				set.ai = patch.aiPaused
					? { ...conversation.ai, paused: true, reason: 'manual', pausedAt: iso(at) }
					: { paused: false, reason: null, pausedAt: null, failures: 0 };
			if (patch.status && patch.status !== conversation.status) {
				set.status = patch.status;
				if (patch.status === 'snoozed') set.snoozedUntil = new Date(Date.parse(patch.snoozedUntil)).toISOString();
				if (patch.status === 'resolved') {
					set.resolvedAt = iso(at);
					messages.push(
						messageOf(conversation, {
							id: `msg_${hash(`${key}:resolved`)}`,
							author: 'system',
							kind: 'event',
							body: t('system.resolved'),
							at: iso(at + 1),
						}),
					);
					const csat = site.settings.csat;
					if (
						csat &&
						shouldAsk(csat, {
							event: 'resolved',
							humanInvolved: Boolean(conversation.handoff),
							alreadyAsked: Boolean(conversation.csat?.askedAt),
						})
					) {
						messages.push(
							messageOf(conversation, {
								id: `msg_${hash(`${key}:csat`)}`,
								author: 'bot',
								kind: 'csat',
								body: t('csat.ask'),
								payload: { scale: csat.scale, comment: csat.follow_up },
								at: iso(at + 2),
							}),
						);
						set.csat = { askedAt: iso(at), score: null, comment: null, ratedAt: null };
					}
				}
				if (patch.status === 'open' && conversation.status === 'resolved')
					messages.push(
						messageOf(conversation, {
							id: `msg_${hash(`${key}:reopened`)}`,
							author: 'system',
							kind: 'event',
							body: t('system.reopened'),
							at: iso(at + 1),
						}),
					);
			} else if (patch.snoozedUntil !== undefined && conversation.status === 'snoozed')
				set.snoozedUntil = new Date(Date.parse(patch.snoozedUntil)).toISOString();
			const updated =
				messages.length > 0
					? await append(site, conversation, messages, { set })
					: /** @type {Conversation} */ (await site.repos.conversations.update(conversation.id, { set }));
			await deps.audit({
				websiteId: site.websiteId,
				actor: { type: actor.type, ...(actor.id ? { id: actor.id } : {}) },
				action: 'conversation.updated',
				target: { type: 'conversation', id: conversation.id },
				before: Object.fromEntries(Object.keys(patch).map((k) => [k, /** @type {any} */ (conversation)[k] ?? null])),
				after: patch,
			});
			return { ok: true, conversation: updated };
		},

		close,

		/**
		 * The customer (or the API) asks for a person.
		 * @param {Site} site
		 * @param {Conversation} conversation
		 * @param {{ reason: string, team?: string | null, key: string }} input
		 */
		requestHandoff: async (site, conversation, { reason, team = null, key }) => {
			if (conversation.status === 'closed') return failure('conversation_closed');
			if (conversation.handoff && conversation.ai.paused) return { ok: true, conversation, messages: [] };
			const at = now();
			const plan = await planHandoff(site, conversation, {
				reason,
				team,
				base: `handoff:${key}`,
				at,
				offset: 0,
				t: translator(conversation.language),
			});
			const updated = await append(site, conversation, plan.messages, { set: plan.set });
			await publishHandoff(site, updated, plan, reason);
			return { ok: true, conversation: updated, messages: plan.messages };
		},

		/** Messages page with the stream ETag. @param {Site} site @param {Conversation} conversation @param {{ since?: string | null, before?: string | null, limit: number, audience: 'customer' | 'team' }} query */
		messages: async (site, conversation, { since = null, before = null, limit, audience }) => {
			const page = await site.repos.messages.page(conversation.id, { since, before, limit, includeInternal: false });
			return {
				items: page.items.map((/** @type {Message} */ m) => messageView(m, audience)).filter(Boolean),
				hasMoreOlder: page.hasMoreOlder,
				etag: streamEtag(conversation, audience),
			};
		},

		/** @param {Site} site @param {Conversation} conversation @param {'customer' | 'team'} audience */
		markRead: async (site, conversation, audience) =>
			/** @type {Conversation} */ (
				await site.repos.conversations.update(conversation.id, {
					set: audience === 'customer' ? { 'counts.unreadByCustomer': 0 } : { 'counts.unreadByTeam': 0 },
				})
			),

		/** Move a guest's conversations to the signed-in customer. @param {Site} site @param {string} visitorId @param {string} customerId */
		claim: (site, visitorId, customerId) => site.repos.conversations.claim(visitorId, customerId),

		/**
		 * A lead from the form (validated against the configured fields).
		 * @param {Site} site
		 * @param {{ body: Record<string, any>, owner: Owner, key: string, conversation: Conversation | null }} input
		 */
		lead: async (site, { body, owner, key, conversation }) => {
			const leads = site.settings.leads;
			if (!leads) return failure('element_disabled');
			const problems = validateLead(body, { fields: leads.fields, consentRequired: leads.consent_required });
			if (problems.length > 0) return failure('validation_failed', { problems });
			const lead = await storeLead(site, {
				conversation,
				owner,
				values: body.fields,
				consent: body.consent === true,
				key,
				source: 'form',
			});
			if (conversation && conversation.status !== 'closed') {
				const t = translator(conversation.language);
				await append(site, conversation, [
					messageOf(conversation, {
						id: `msg_${hash(`${key}:lead_thanks`)}`,
						author: 'bot',
						body: t('lead.thanks'),
						at: iso(now()),
					}),
				]);
			}
			return { ok: true, lead };
		},

		/**
		 * A CSAT rating (once per conversation).
		 * @param {Site} site
		 * @param {Conversation} conversation
		 * @param {Record<string, any>} body
		 */
		rate: async (site, conversation, body) => {
			const csat = site.settings.csat;
			if (!csat) return failure('element_disabled');
			const problems = validateRating(body, csat);
			if (problems.length > 0) return failure('validation_failed', { problems });
			const at = iso(now());
			const rating = {
				id: `rat_${hash(`rating:${conversation.id}`)}`,
				conversationId: conversation.id,
				customerId: conversation.customerId,
				score: body.score,
				scale: csat.scale,
				comment: typeof body.comment === 'string' ? body.comment.trim() || null : null,
				agentId: conversation.assignee,
				team: conversation.team,
				at,
			};
			if (!(await site.repos.ratings.insert(rating))) return failure('already_rated');
			await site.repos.conversations.update(conversation.id, {
				set: {
					csat: { askedAt: conversation.csat?.askedAt ?? null, score: rating.score, comment: rating.comment, ratedAt: at },
				},
			});
			return { ok: true, rating };
		},

		/** CSAT summary since an instant. @param {Site} site @param {string} since */
		csatSummary: async (site, since) => summarise(await site.repos.ratings.since(since), site.settings.csat?.target ?? 0.85),

		/**
		 * Proactive message for a visitor (frequency memory in the merchant database).
		 * @param {Site} site
		 * @param {{ visitorKey: string | null, sessionId: string | null, context: unknown, identified: boolean, owner: Owner }} input
		 */
		proactive: async (site, { visitorKey, sessionId, context, identified, owner }) => {
			const p = site.settings.proactive;
			if (!p) return null;
			if (
				p.skip_when_conversation_open &&
				ownerFilters(owner).length > 0 &&
				(await site.repos.conversations.countOpen(ownerFilters(owner))) > 0
			)
				return null;
			const memory = visitorKey ? ((await site.repos.visitors.get(visitorKey))?.memory ?? emptyMemory()) : emptyMemory();
			const at = now();
			const clean = sanitiseVisitorContext(context);
			const rule = pickProactive({
				rules: Array.isArray(p.rules) ? p.rules : [],
				memory,
				context: { ...clean, visitor: { ...clean.visitor, identified } },
				now: at,
				timeZone: site.settings.timeZone,
				sessionId,
				maxPerDay: p.max_per_day,
			});
			if (!rule) return null;
			if (visitorKey)
				await site.repos.visitors.save(
					visitorKey,
					recordShown(memory, rule.id, { now: at, sessionId }),
					new Date(at + deps.retention.visitors * DAY_MS),
				);
			return {
				ruleId: rule.id,
				message: rule.message,
				openWindow: rule.open_window === true,
				delaySeconds: rule.delay_seconds ?? 0,
			};
		},

		/** @param {Site} site @param {string} visitorKey @param {string} ruleId */
		dismissProactive: async (site, visitorKey, ruleId) => {
			const memory = (await site.repos.visitors.get(visitorKey))?.memory ?? emptyMemory();
			await site.repos.visitors.save(
				visitorKey,
				recordDismissed(memory, ruleId, now()),
				new Date(now() + deps.retention.visitors * DAY_MS),
			);
		},

		/**
		 * Transcript of a conversation.
		 * @param {Site} site
		 * @param {Conversation} conversation
		 * @param {{ format: 'json' | 'text', audience: 'customer' | 'team' }} options
		 */
		transcript: async (site, conversation, { format, audience }) => {
			const tr = site.settings.transcripts;
			const includeInternal = audience === 'team' && tr.include_internal_notes;
			const messages = await site.repos.messages.all(conversation.id, { max: tr.max_messages, includeInternal });
			const t = translator(conversation.language);
			if (format === 'text')
				return transcriptText({
					conversation: {
						id: conversation.id,
						openedAt: conversation.openedAt,
						closedAt: conversation.closedAt,
						status: conversation.status,
					},
					messages: messages.map((/** @type {Message} */ m) => ({
						author: m.author,
						authorName: audience === 'customer' && m.author === 'agent' ? null : m.authorName,
						text: m.body,
						at: m.at,
						internal: m.internal,
						kind: m.kind,
					})),
					labels: {
						customer: t('transcript.author.customer'),
						bot: t('transcript.author.bot'),
						agent: t('transcript.author.agent'),
						system: t('transcript.author.system'),
						note: t('transcript.note'),
					},
					includeInternal,
					title: t('transcript.title'),
				});
			return transcriptJson({
				conversation: conversationView(conversation, audience),
				messages: messages
					.map((/** @type {Message} */ m) => messageView(m, includeInternal ? 'team' : audience))
					.filter(Boolean),
				exportedAt: iso(now()),
			});
		},

		/**
		 * Render a canned reply for a conversation.
		 * @param {Site} site
		 * @param {Conversation} conversation
		 * @param {{ key: string, agentId?: string | null }} input
		 */
		canned: async (site, conversation, { key, agentId = null }) => {
			const reply = (site.settings.inbox?.canned_replies ?? []).find((/** @type {any} */ r) => r.key === key);
			if (!reply) return failure('unknown_canned_reply');
			const agent = agentId ? await site.repos.agents.get(agentId) : null;
			return {
				ok: true,
				text: renderCanned(reply, {
					customer_name: conversation.contact?.name ?? null,
					agent_name: agent?.name ?? null,
					conversation_id: conversation.id,
				}),
			};
		},

		/** Inbox summary. @param {Site} site */
		inboxSummary: async (site) => {
			const inbox = site.settings.inbox;
			const at = now();
			const [stats, agents] = await Promise.all([site.repos.conversations.stats(iso(at - DAY_MS)), site.repos.agents.all()]);
			return {
				open: stats.open,
				waiting: stats.waiting,
				breaches: stats.breaches,
				agents: {
					total: agents.length,
					online: agents.filter((/** @type {any} */ a) => a.status === 'online' && a.active !== false).length,
				},
				teams: (inbox?.teams ?? []).map((/** @type {any} */ team) => ({
					key: team.key,
					name: team.name ?? team.key,
					open: teamOpen(team, at, site.settings.timeZone),
					opensAt: teamOpensAt(team, at, site.settings.timeZone),
				})),
				assignment: inbox?.assignment ?? 'manual',
			};
		},

		/**
		 * Periodic work for one website: knowledge refresh, SLA breaches, snooze wake-ups, auto-close.
		 * @param {Site} site
		 * @param {{ maxSources?: number, batch?: number }} [options]
		 */
		maintain: async (site, { maxSources = 5, batch = 200 } = {}) => {
			const at = now();
			const result = { refreshed: 0, failed: 0, breaches: 0, woken: 0, closed: 0 };
			if (site.settings.knowledge) {
				for (const source of (await knowledge.dueSources(site)).slice(0, maxSources)) {
					const refreshed = await knowledge.refreshSource(site, source);
					if (refreshed.ok) result.refreshed += 1;
					else result.failed += 1;
				}
			}
			for (const conversation of await site.repos.conversations.slaCandidates(iso(at), batch)) {
				const breached = slaBreaches(conversation, at);
				if (breached.length === 0) continue;
				await site.repos.conversations.update(conversation.id, {
					set: { 'sla.breached': [...(conversation.sla?.breached ?? []), ...breached] },
				});
				await deps.audit({
					websiteId: site.websiteId,
					actor: { type: 'product', id: 'chatbot' },
					action: 'sla.breached',
					target: { type: 'conversation', id: conversation.id },
					after: { breached },
				});
				result.breaches += breached.length;
			}
			for (const conversation of await site.repos.conversations.dueSnoozed(iso(at), batch)) {
				await site.repos.conversations.update(conversation.id, {
					set: { status: 'open', snoozedUntil: null },
					ifStatus: ['snoozed'],
				});
				result.woken += 1;
			}
			const hours = site.settings.inbox?.auto_close_after_hours ?? 0;
			if (hours > 0)
				for (const conversation of await site.repos.conversations.idle(iso(at - hours * HOUR_MS), batch)) {
					await close(site, conversation, {
						actor: { type: 'system', id: 'auto_close' },
						reason: 'inactive',
						key: `auto:${conversation.id}`,
					});
					result.closed += 1;
				}
			return result;
		},

		/**
		 * Order and customer events → caches for the order lookup tool.
		 * @param {Site} site
		 * @param {{ type: string, id: string, occurredAt: string, data: Record<string, any> }} event
		 */
		consume: async (site, event) => {
			const [name] = event.type.split('@');
			const data = event.data ?? {};
			const expiresAt = new Date(now() + deps.retention.orders * DAY_MS);
			if (name?.startsWith('order.') && typeof data.orderId === 'string') {
				const rank = { placed: 1, paid: 2, completed: 3, partially_refunded: 4, refunded: 5, cancelled: 5 };
				/** @type {Record<string, unknown>} */
				const set = { orderId: data.orderId, updatedAt: event.occurredAt };
				for (const field of ['number', 'customerId', 'customer', 'currency'])
					if (data[field] !== undefined)
						set[field] =
							field === 'customer' && data.customer?.email
								? { ...data.customer, email: String(data.customer.email).toLowerCase() }
								: data[field];
				if (Array.isArray(data.lines))
					set.lines = data.lines
						.slice(0, 50)
						.map((/** @type {any} */ l) => ({ title: l.title ?? null, sku: l.sku ?? null, quantity: l.quantity }));
				if (data.amounts?.total !== undefined) set.total = data.amounts.total;
				if (name === 'order.placed') set.placedAt = event.occurredAt;
				const existing = (await site.repos.orders.byNumber(data.orderId)).find(
					(/** @type {any} */ o) => o.orderId === data.orderId,
				);
				/** @type {Record<string, string>} */
				const statusOf = {
					'order.placed': 'placed',
					'order.paid': 'paid',
					'order.completed': 'completed',
					'order.cancelled': 'cancelled',
					'order.refunded': 'refunded',
				};
				let status = statusOf[name];
				/** @type {Record<string, number> | undefined} */
				let inc;
				if (name === 'order.refunded') {
					const amount = Number(data.amount?.amount ?? 0);
					inc = { refunded: amount };
					const total = Number(set.total ?? existing?.total ?? 0);
					status = total > 0 && (existing?.refunded ?? 0) + amount < total ? 'partially_refunded' : 'refunded';
					if (!set.currency && data.amount?.currency) set.currency = data.amount.currency;
				}
				const current = /** @type {keyof typeof rank} */ (existing?.status ?? 'placed');
				if (status && (!existing || (rank[/** @type {keyof typeof rank} */ (status)] ?? 0) >= (rank[current] ?? 0)))
					set.status = status;
				await site.repos.orders.upsert(data.orderId, { set, ...(inc ? { inc } : {}), expiresAt });
				return true;
			}
			if (name?.startsWith('customer.') && typeof data.customerId === 'string') {
				const emails = Array.isArray(data.identities)
					? data.identities
							.filter((/** @type {any} */ i) => i?.type === 'email' && typeof i.value === 'string')
							.map((/** @type {any} */ i) => String(i.value).toLowerCase())
					: [];
				await site.repos.customers.upsert(data.customerId, {
					emails,
					expiresAt: new Date(now() + deps.retention.customers * DAY_MS),
				});
				return true;
			}
			return false;
		},

		/** Dashboard KPIs. @param {Site} site */
		overview: async (site) => {
			const at = now();
			const [stats, tokens, csat, leads, chunks] = await Promise.all([
				site.repos.conversations.stats(iso(at - DAY_MS)),
				site.repos.counters.get(`tokens:${monthKey(at, site.settings.timeZone)}`),
				summarise(await site.repos.ratings.since(iso(at - 30 * DAY_MS)), site.settings.csat?.target ?? 0.85),
				site.repos.leads.countSince(iso(at - 30 * DAY_MS)),
				site.repos.chunks.count(),
			]);
			return { ...stats, tokens, csat, leads, chunks };
		},

		/** New random id. @param {string} prefix */
		newId: (prefix) => createId(prefix, { randomBytes: deps.randomBytes }),
	});
};

/** @typedef {ReturnType<typeof createChatbotService>} ChatbotService */
