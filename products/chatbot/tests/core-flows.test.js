/** Pure core: flows, inbox and handoff decisions, proactive messages, conversations, leads, CSAT, transcripts, tools, prompt, rules, notes. */
import { describe, expect, it } from 'vitest';
import {
	canTransition,
	conversationView,
	guestLimitReached,
	mergeMessages,
	messageView,
	newConversation,
	sanitiseContext,
	statusAfter,
	streamEtag,
	summaryAfter,
	validatePatch,
	validateText,
} from '../core/conversation.js';
import { isPositive, shouldAsk, summarise, validateRating } from '../core/csat.js';
import { answerValid, matchFlow, stepFlow, validateFlow } from '../core/flows.js';
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
	validateAgent,
} from '../core/inbox.js';
import { normaliseLead, validateField, validateLead } from '../core/leads.js';
import { mentionsOf, validateNote } from '../core/notes.js';
import {
	capsAllow,
	emptyMemory,
	pickProactive,
	recordDismissed,
	recordShown,
	sanitiseVisitorContext,
} from '../core/proactive.js';
import { buildSystemPrompt, CORE_RULE_COUNT, historyTurns } from '../core/prompt.js';
import { checkCondition, compileCondition, conditionMatches } from '../core/rules.js';
import { createTranslator } from '../core/strings.js';
import {
	BUILTIN,
	checkArguments,
	formatMoney,
	guestClaimMatches,
	orderSummary,
	parametersOf,
	signatureBase,
	toolOutput,
	toolSchemas,
} from '../core/tools.js';
import { retainUntil, transcriptJson, transcriptText } from '../core/transcripts.js';
import en from '../strings/en.json' with { type: 'json' };

const t = createTranslator(en);
const NOW = Date.parse('2026-10-05T10:00:00Z'); // Monday
const at = new Date(NOW).toISOString();
/** @param {Record<string, any>} [extra] @returns {any} */
const conv = (extra = {}) => ({
	...newConversation({ id: 'cnv_1', at, customerId: null, visitorId: 'vis_1', language: 'en', priority: 'normal' }),
	...extra,
});
/** @param {Record<string, any>} m @returns {any} */
const msg = (m) => ({
	id: m.id ?? 'm',
	conversationId: 'cnv_1',
	customerId: null,
	authorId: null,
	authorName: null,
	kind: 'text',
	internal: false,
	body: 'hi',
	payload: null,
	language: 'en',
	at,
	...m,
});

describe('flows', () => {
	/** @type {import('../core/flows.js').Flow} */
	const returns = {
		id: 'returns',
		name: 'Returns',
		priority: 5,
		trigger: { type: 'keyword', keywords: ['return', 'refund'] },
		start: 'menu',
		nodes: [
			{
				id: 'menu',
				type: 'buttons',
				text: 'What do you need?',
				variable: 'choice',
				buttons: [
					{ label: 'Start a return', value: 'start', next: 'order' },
					{ label: 'Talk to us', next: 'human' },
					{ label: 'Policy', url: '/returns' },
				],
			},
			{ id: 'order', type: 'question', text: 'Your order e-mail?', variable: 'email', validate: 'email', next: 'check' },
			{ id: 'check', type: 'condition', condition: "endsWith(vars.email, '@vip.example')", then: 'vip', else: 'form' },
			{ id: 'vip', type: 'action', action: { kind: 'add_tag', name: 'vip' }, next: 'prio' },
			{ id: 'prio', type: 'action', action: { kind: 'set_priority', name: 'high' }, next: 'form' },
			{
				id: 'form',
				type: 'form',
				text: 'Details',
				fields: [{ name: 'reason', type: 'select', required: true, options: ['size', 'damaged'] }],
				next: 'tool',
			},
			{ id: 'tool', type: 'action', action: { kind: 'call_tool', name: 'create_rma' }, next: 'ai' },
			{ id: 'ai', type: 'ai_step', prompt: 'Explain the next steps for {vars.reason}', next: 'set' },
			{ id: 'set', type: 'action', action: { kind: 'set_variable', name: 'done', value: 'yes {vars.reason}' }, next: 'lead' },
			{ id: 'lead', type: 'action', action: { kind: 'capture_lead' }, next: 'bye' },
			{ id: 'bye', type: 'message', text: 'Thanks {vars.email}!', next: 'end' },
			{ id: 'end', type: 'end', text: 'Bye' },
			{ id: 'human', type: 'handoff', text: 'Connecting you…', team: 'returns' },
		],
	};
	const options = {
		maxSteps: 25,
		unmatched: /** @type {const} */ ('repeat'),
		exitKeywords: ['cancel'],
		now: NOW,
		timeZone: 'UTC',
		invalidAnswer: 'Sorry?',
	};
	const deps = {
		runAi: async (/** @type {string} */ prompt) => `AI: ${prompt}`,
		runTool: async (/** @type {string} */ name) => ({ ok: true, output: `rma for ${name}` }),
	};

	it('validates graphs for the builder', () => {
		expect(validateFlow(returns)).toEqual({ ok: true, errors: [], warnings: [] });
		const broken = /** @type {any} */ ({
			id: 'x',
			start: 'nope',
			trigger: { type: 'keyword', when: 'a ==' },
			nodes: [
				{ id: 'a', type: 'message' },
				{ id: 'a', type: 'weird', next: 'zz' },
				{ id: 'q', type: 'question' },
				{ id: 'b', type: 'buttons', buttons: [] },
				{ id: 'f', type: 'form' },
				{ id: 'c', type: 'condition', then: 'missing' },
				{ id: 'd', type: 'condition', condition: '1 <' },
				{ id: 'e', type: 'action' },
				{ id: 'g', type: 'ai_step' },
			],
		});
		const result = validateFlow(broken);
		expect(result.ok).toBe(false);
		expect(result.errors.map((e) => `${e.path}:${e.code}`)).toEqual(
			expect.arrayContaining([
				'/nodes/1/id:duplicate_id',
				'/start:unknown_node',
				'/nodes/1/type:unknown_type',
				'/nodes/1/next:unknown_node',
				'/nodes/0/text:required',
				'/nodes/2/variable:required',
				'/nodes/3/buttons:required',
				'/nodes/4/fields:required',
				'/nodes/5/condition:required',
				'/nodes/5/then:unknown_node',
				'/nodes/6/condition:invalid_condition',
				'/nodes/7/action:required',
				'/trigger/when:invalid_condition',
				'/trigger/keywords:required',
			]),
		);
		expect(result.warnings).toEqual(
			expect.arrayContaining([
				{ path: '/nodes/8/prompt', code: 'empty_prompt' },
				{ path: '/nodes/0', code: 'unreachable' },
			]),
		);
		expect(validateFlow(/** @type {any} */ ({})).ok).toBe(false);
	});

	it('matches triggers by priority', () => {
		const welcome = {
			id: 'welcome',
			trigger: { type: 'conversation_start' },
			start: 'm',
			nodes: [{ id: 'm', type: 'message', text: 'Hi' }],
		};
		const page = {
			id: 'page',
			priority: 9,
			trigger: { type: 'page', path: '/checkout/**' },
			start: 'm',
			nodes: [{ id: 'm', type: 'message', text: 'Need help paying?' }],
		};
		const event = {
			id: 'event',
			trigger: { type: 'event', event: 'order.placed@1' },
			start: 'm',
			nodes: [{ id: 'm', type: 'message', text: 'Thanks' }],
		};
		const off = { ...welcome, id: 'off', enabled: false };
		const conditional = {
			...welcome,
			id: 'cond',
			priority: 50,
			trigger: { type: 'conversation_start', when: 'customer.identified' },
		};
		const all = [returns, welcome, page, event, off, conditional, { id: 'bad', start: 'x', nodes: [] }];
		const ctx = { context: { customer: { identified: false } }, now: NOW, timeZone: 'UTC' };
		expect(matchFlow(all, { entry: 'start', path: '/checkout/pay' }, ctx)?.id).toBe('page');
		expect(matchFlow(all, { entry: 'start', path: '/' }, ctx)?.id).toBe('welcome');
		expect(matchFlow(all, { entry: 'start', path: '/' }, { ...ctx, context: { customer: { identified: true } } })?.id).toBe(
			'cond',
		);
		expect(matchFlow(all, { entry: 'message', text: 'I want a refund' }, ctx)?.id).toBe('returns');
		expect(matchFlow(all, { entry: 'event', eventType: 'order.placed@1' }, ctx)?.id).toBe('event');
		expect(matchFlow(all, { entry: 'message', text: 'hello' }, ctx)).toBeNull();
		expect(matchFlow(all, { entry: 'message', flowId: 'event' }, ctx)?.id).toBe('event');
		expect(matchFlow([{ ...welcome, trigger: undefined }], { entry: 'start' }, ctx)).toBeNull();
	});

	it('runs a flow: buttons, validated question, condition, actions, form, tool, AI step, end', async () => {
		const context = { conversation: {}, customer: { identified: false } };
		let step = await stepFlow({ flow: returns, state: null, input: { kind: 'start' }, context, options }, deps);
		expect(step.outputs).toEqual([
			{
				kind: 'buttons',
				text: 'What do you need?',
				buttons: [
					{ label: 'Start a return', value: 'start' },
					{ label: 'Talk to us', value: 'Talk to us' },
					{ label: 'Policy', value: 'Policy', url: '/returns' },
				],
			},
		]);
		expect(step.state).toEqual({ flowId: 'returns', node: 'menu', vars: {}, waiting: 'buttons' });
		// free text that matches no button: repeated
		const repeat = await stepFlow(
			{ flow: returns, state: step.state, input: { kind: 'text', text: 'what?' }, context, options },
			deps,
		);
		expect(repeat.outputs[0]?.kind).toBe('buttons');
		step = await stepFlow(
			{ flow: returns, state: step.state, input: { kind: 'button', value: 'start' }, context, options },
			deps,
		);
		expect(step.outputs).toEqual([{ kind: 'text', text: 'Your order e-mail?' }]);
		const invalid = await stepFlow(
			{ flow: returns, state: step.state, input: { kind: 'text', text: 'not an email' }, context, options },
			deps,
		);
		expect(invalid.outputs.map((o) => o.text)).toEqual(['Sorry?', 'Your order e-mail?']);
		step = await stepFlow(
			{ flow: returns, state: step.state, input: { kind: 'text', text: 'ana@vip.example' }, context, options },
			deps,
		);
		expect(step.effects).toEqual([
			{ kind: 'tag', tag: 'vip' },
			{ kind: 'priority', priority: 'high' },
		]);
		expect(step.outputs).toEqual([{ kind: 'form', text: 'Details', fields: returns.nodes[5]?.fields }]);
		const badForm = await stepFlow(
			{ flow: returns, state: step.state, input: { kind: 'form', values: { reason: 'other' } }, context, options },
			deps,
		);
		expect(badForm.outputs[0]).toEqual({ kind: 'text', text: 'Sorry?' });
		step = await stepFlow(
			{ flow: returns, state: step.state, input: { kind: 'form', values: { reason: 'size' } }, context, options },
			deps,
		);
		expect(step.outputs.map((o) => o.text)).toEqual(['AI: Explain the next steps for size', 'Thanks ana@vip.example!', 'Bye']);
		expect(step.effects).toEqual([
			{
				kind: 'lead',
				fields: {
					choice: 'start',
					email: 'ana@vip.example',
					reason: 'size',
					tool: { ok: true, output: 'rma for create_rma' },
					done: 'yes size',
				},
			},
		]);
		expect(step.state).toBeNull();
	});

	it('hands off, exits, closes and honours unmatched-input modes and the step limit', async () => {
		/** @type {Record<string, unknown>} */
		const context = {};
		const start = await stepFlow({ flow: returns, state: null, input: { kind: 'start' }, context, options }, deps);
		const human = await stepFlow(
			{ flow: returns, state: start.state, input: { kind: 'text', text: 'talk to us' }, context, options },
			deps,
		);
		expect(human.effects).toEqual([{ kind: 'handoff', team: 'returns', reason: 'flow:returns' }]);
		expect(human.outputs[0]?.text).toBe('Connecting you…');
		const exit = await stepFlow(
			{ flow: returns, state: start.state, input: { kind: 'text', text: 'Cancel' }, context, options },
			deps,
		);
		expect(exit).toMatchObject({ state: null, consumed: true });
		const ai = await stepFlow(
			{
				flow: returns,
				state: start.state,
				input: { kind: 'text', text: 'hm' },
				context,
				options: { ...options, unmatched: 'ai' },
			},
			deps,
		);
		expect(ai).toMatchObject({ state: null, consumed: false, effects: [{ kind: 'ai_fallback' }] });
		const leave = await stepFlow(
			{
				flow: returns,
				state: start.state,
				input: { kind: 'text', text: 'hm' },
				context,
				options: { ...options, unmatched: 'exit' },
			},
			deps,
		);
		expect(leave).toMatchObject({ state: null, consumed: false });
		const lost = await stepFlow(
			{
				flow: returns,
				state: { flowId: 'returns', node: 'gone', vars: {}, waiting: 'question' },
				input: { kind: 'text', text: 'x' },
				context,
				options,
			},
			deps,
		);
		expect(lost.consumed).toBe(false);
		const loop = { id: 'loop', start: 'a', nodes: [{ id: 'a', type: 'message', text: 'again', next: 'a' }] };
		expect(
			(await stepFlow({ flow: loop, state: null, input: { kind: 'start' }, context, options: { ...options, maxSteps: 3 } }))
				.outputs,
		).toHaveLength(3);
		const closing = { id: 'c', start: 'a', nodes: [{ id: 'a', type: 'action', action: { kind: 'close' } }] };
		expect((await stepFlow({ flow: closing, state: null, input: { kind: 'start' }, context, options })).effects).toEqual([
			{ kind: 'close' },
		]);
		const resume = {
			id: 'r',
			start: 'a',
			nodes: [
				{ id: 'a', type: 'message', text: 'x', next: 'b' },
				{ id: 'b', type: 'end' },
			],
		};
		const odd = await stepFlow({
			flow: resume,
			state: { flowId: 'r', node: 'a', vars: {}, waiting: null },
			input: { kind: 'text', text: 'x' },
			context,
			options,
		});
		expect(odd.state).toBeNull();
		// no deps: ai steps and tools are skipped
		const quiet = {
			id: 'q',
			start: 'a',
			nodes: [
				{ id: 'a', type: 'ai_step', prompt: 'x', next: 'b' },
				{ id: 'b', type: 'action', action: { kind: 'call_tool', name: 't' } },
			],
		};
		expect((await stepFlow({ flow: quiet, state: null, input: { kind: 'start' }, context, options })).outputs).toEqual([]);
		expect(answerValid(' ', 'text')).toBe(false);
		expect(answerValid('12', 'number')).toBe(false);
		expect(answerValid('+44 20 7946 0958', 'phone')).toBe(true);
	});
});

describe('handoff and inbox decisions', () => {
	const handoff = {
		allow_customer_request: true,
		escalation_phrases: ['talk to someone', 'humano'],
		when: "message.length > 200 or conversation.priority == 'urgent'",
		after_ai_failures: 2,
	};
	const options = { now: NOW, timeZone: 'UTC' };
	it('decides when to hand off', () => {
		expect(
			shouldHandoff({ text: 'Can I talk to someone?', conversation: conv(), identified: false }, handoff, options),
		).toEqual({ handoff: true, reason: 'customer_request' });
		expect(shouldHandoff({ text: 'Quiero un HUMANO', conversation: conv(), identified: false }, handoff, options).handoff).toBe(
			true,
		);
		expect(
			shouldHandoff(
				{
					text: 'hi',
					conversation: conv({ ai: { paused: false, reason: null, pausedAt: null, failures: 2 } }),
					identified: false,
				},
				handoff,
				options,
			).reason,
		).toBe('ai_failures');
		expect(
			shouldHandoff({ text: 'hi', conversation: conv({ priority: 'urgent' }), identified: true }, handoff, options).reason,
		).toBe('rule');
		expect(shouldHandoff({ text: 'hi', conversation: conv(), identified: true }, handoff, options).handoff).toBe(false);
		expect(shouldHandoff({ text: 'talk to someone', conversation: conv(), identified: true }, null, options).handoff).toBe(
			false,
		);
		expect(
			shouldHandoff(
				{ text: 'talk to someone', conversation: conv(), identified: true },
				{ ...handoff, allow_customer_request: false, when: '' },
				options,
			).handoff,
		).toBe(false);
	});
	it('lets the AI resume only after the grace window and never over a person or a manual pause', () => {
		const paused = conv({
			ai: { paused: true, reason: 'handoff', pausedAt: new Date(NOW - 5 * 60_000).toISOString(), failures: 0 },
		});
		expect(aiMayResume(paused, { resumeAfterMinutes: 3, now: NOW })).toBe(true);
		expect(aiMayResume(paused, { resumeAfterMinutes: 10, now: NOW })).toBe(false);
		expect(aiMayResume(paused, { resumeAfterMinutes: 0, now: NOW })).toBe(false);
		expect(
			aiMayResume(
				{ ...paused, sla: { firstResponseAt: at, firstResponseDueAt: null, resolutionDueAt: null, breached: [] } },
				{ resumeAfterMinutes: 3, now: NOW },
			),
		).toBe(false);
		expect(aiMayResume({ ...paused, ai: { ...paused.ai, reason: 'manual' } }, { resumeAfterMinutes: 3, now: NOW })).toBe(false);
		expect(aiMayResume(conv(), { resumeAfterMinutes: 3, now: NOW })).toBe(true);
		expect(aiMayResume({ ...paused, ai: { ...paused.ai, pausedAt: null } }, { resumeAfterMinutes: 3, now: NOW })).toBe(false);
	});
	it('teams, hours, routing and agent picking', () => {
		const teams = [
			{ key: 'support', hours: [{ days: ['mon'], start: '09:00', end: '17:00' }], time_zone: 'Mars/Base' },
			{ key: 'sales', time_zone: 'Asia/Tokyo', hours: [{ days: ['mon'], start: '09:00', end: '17:00' }] },
		];
		expect(teamOf(teams, 'sales', 'support').key).toBe('sales');
		expect(teamOf(teams, 'nope', 'support').key).toBe('support');
		expect(teamOf([], null, 'support')).toEqual({ key: 'support' });
		expect(teamOf([{ key: 'only' }], 'x', 'y').key).toBe('only');
		expect(teamOpen(/** @type {any} */ (teams[0]), NOW, 'UTC')).toBe(true);
		expect(teamOpen(/** @type {any} */ (teams[1]), NOW, 'UTC')).toBe(false);
		expect(teamOpensAt(/** @type {any} */ (teams[1]), NOW, 'UTC')).toBe('2026-10-12T00:00:00.000Z');
		expect(teamOpensAt({ key: 'never', hours: [{ days: ['mon'], start: '25:00', end: '26:00' }] }, NOW, 'UTC')).toBeNull();
		expect(
			routeByRules(
				[
					{ when: "conversation.language == 'de'", team: 'dach' },
					{ when: '', agent_id: 'agt_x', priority: 'high' },
				],
				{ conversation: { language: 'fr' } },
				options,
			),
		).toEqual({ team: null, agentId: 'agt_x', priority: 'high' });
		expect(
			routeByRules([{ when: "conversation.language == 'de'", team: 'dach' }], { conversation: { language: 'de' } }, options)
				.team,
		).toBe('dach');
		expect(routeByRules([], {}, options)).toEqual({ team: null, agentId: null, priority: null });
		const agents = /** @type {any[]} */ ([
			{ id: 'a', status: 'online', active: true, teams: ['support'], maxConcurrent: 1 },
			{ id: 'b', status: 'online', active: true, teams: [], maxConcurrent: null },
			{ id: 'c', status: 'away', active: true, teams: [], maxConcurrent: null },
			{ id: 'd', status: 'online', active: false, teams: [], maxConcurrent: null },
			{ id: 'e', status: 'online', active: true, teams: ['sales'], maxConcurrent: null },
		]);
		const base = { agents, team: 'support', loads: { a: 0, b: 3 }, defaultMax: 8, cursor: 0 };
		expect(pickAgent({ ...base, strategy: 'round_robin' })).toEqual({ agentId: 'a', cursor: 1 });
		expect(pickAgent({ ...base, strategy: 'round_robin', cursor: 1 })).toEqual({ agentId: 'b', cursor: 2 });
		expect(pickAgent({ ...base, strategy: 'least_loaded', loads: { a: 0, b: 0 } }).agentId).toBe('a');
		expect(pickAgent({ ...base, strategy: 'least_loaded', loads: { a: 1, b: 2 } }).agentId).toBe('b');
		expect(pickAgent({ ...base, strategy: 'rules', preferred: 'b' }).agentId).toBe('b');
		expect(pickAgent({ ...base, strategy: 'manual' }).agentId).toBeNull();
		expect(pickAgent({ ...base, strategy: 'round_robin', agents: [] }).agentId).toBeNull();
	});
	it('SLA due times and breaches', () => {
		const team = { key: 'support', hours: [{ days: ['mon'], start: '09:00', end: '11:00' }] };
		const sla = slaFor({
			at: NOW,
			team,
			firstResponseMinutes: 30,
			resolutionMinutes: 120,
			businessHoursOnly: true,
			websiteZone: 'UTC',
		});
		expect(sla).toEqual({
			firstResponseDueAt: '2026-10-05T10:30:00.000Z',
			firstResponseAt: null,
			resolutionDueAt: '2026-10-12T10:00:00.000Z',
			breached: [],
		});
		expect(
			slaFor({
				at: NOW,
				team: { key: 'x', first_response_minutes: 5 },
				firstResponseMinutes: 30,
				resolutionMinutes: 60,
				businessHoursOnly: false,
				websiteZone: 'UTC',
			}).firstResponseDueAt,
		).toBe('2026-10-05T10:05:00.000Z');
		const late = conv({
			sla: { ...sla, firstResponseDueAt: '2026-10-05T09:00:00.000Z', resolutionDueAt: '2026-10-05T09:30:00.000Z' },
		});
		expect(slaBreaches(late, NOW)).toEqual(['first_response', 'resolution']);
		expect(slaBreaches({ ...late, sla: { ...late.sla, breached: ['first_response', 'resolution'] } }, NOW)).toEqual([]);
		expect(slaBreaches({ ...late, status: 'resolved', sla: { ...late.sla, firstResponseAt: at } }, NOW)).toEqual([]);
		expect(slaBreaches(conv(), NOW)).toEqual([]);
		expect(slaBreaches({ ...late, status: 'closed' }, NOW)).toEqual([]);
	});
	it('canned replies and agent validation', () => {
		expect(
			renderCanned(
				{ body: 'Hi {customer_name}, {agent_name} here ({conversation_id}).' },
				{ customer_name: 'Ana', agent_name: null, conversation_id: 'cnv_1' },
			),
		).toBe('Hi Ana,  here (cnv_1).');
		expect(
			validateAgent(
				{
					name: 'Sam',
					email: 'sam@x.org',
					teams: ['support'],
					status: 'online',
					active: true,
					maxConcurrent: 4,
					userId: 'usr_1',
				},
				{ teams: ['support'] },
			),
		).toEqual([]);
		expect(
			validateAgent(
				{ name: '', email: 'x', teams: ['nope'], status: 'busy', active: 1, maxConcurrent: 0, userId: 7, extra: 1 },
				{ teams: [] },
			).map((p) => p.path),
		).toEqual(['/extra', '/name', '/email', '/teams', '/status', '/active', '/maxConcurrent', '/userId']);
		expect(validateAgent({ status: 'away' }, { partial: true, teams: [] })).toEqual([]);
		expect(validateAgent(null, { teams: [] })).toEqual([{ path: '', code: 'object_required' }]);
	});
});

describe('proactive messages', () => {
	const rules = /** @type {any[]} */ ([
		{
			id: 'cart',
			priority: 10,
			when: 'cart.value >= 10000',
			message: 'Need help with your order?',
			max_per_day: 1,
			dismiss_days: 7,
		},
		{ id: 'returning', when: 'visitor.returning', message: 'Welcome back!', max_per_session: 1, cooldown_minutes: 60 },
		{ id: 'off', enabled: false, message: 'never' },
	]);
	const context = sanitiseVisitorContext({
		page: { path: '/cart' },
		cart: { value: 12000, items: 2, currency: 'EUR' },
		visitor: { returning: true },
	});
	it('picks by priority within caps, remembers showings and dismissals', () => {
		const memory = emptyMemory();
		const first = pickProactive({ rules, memory, context, now: NOW, timeZone: 'UTC', sessionId: 's1', maxPerDay: 5 });
		expect(first?.id).toBe('cart');
		const shown = recordShown(memory, 'cart', { now: NOW, sessionId: 's1' });
		expect(
			pickProactive({ rules, memory: shown, context, now: NOW + 1000, timeZone: 'UTC', sessionId: 's1', maxPerDay: 5 })?.id,
		).toBe('returning');
		const twice = recordShown(shown, 'returning', { now: NOW + 1000, sessionId: 's1' });
		expect(
			pickProactive({ rules, memory: twice, context, now: NOW + 2000, timeZone: 'UTC', sessionId: 's1', maxPerDay: 5 }),
		).toBeNull();
		expect(
			pickProactive({ rules, memory: twice, context, now: NOW + 2000, timeZone: 'UTC', sessionId: 's2', maxPerDay: 5 }),
		).toBeNull(); // cooldown
		expect(
			pickProactive({ rules, memory: twice, context, now: NOW + 2000, timeZone: 'UTC', sessionId: 's2', maxPerDay: 2 }),
		).toBeNull(); // daily cap
		const dismissed = recordDismissed(memory, 'cart', NOW);
		expect(capsAllow(/** @type {any} */ (rules[0]), dismissed, { now: NOW + 86_400_000, sessionId: null })).toBe(false);
		expect(capsAllow(/** @type {any} */ (rules[0]), dismissed, { now: NOW + 8 * 86_400_000, sessionId: null })).toBe(true);
		expect(
			pickProactive({
				rules,
				memory,
				context: sanitiseVisitorContext(null),
				now: NOW,
				timeZone: 'UTC',
				sessionId: null,
				maxPerDay: 5,
			}),
		).toBeNull();
	});
	it('sanitises untrusted visitor context', () => {
		expect(
			sanitiseVisitorContext({
				page: { path: 7, url: 'x'.repeat(3000) },
				visitor: { visits: 'many' },
				cart: { currency: 'EURO' },
			}),
		).toEqual({
			page: { path: null, url: 'x'.repeat(2048), referrer: null, type: null },
			visitor: { returning: false, visits: 0, secondsOnPage: 0 },
			cart: { value: 0, items: 0, currency: 'EUR' },
		});
	});
});

describe('conversations', () => {
	it('moves statuses like an inbox', () => {
		expect(statusAfter('resolved', 'customer')).toBe('open');
		expect(statusAfter('open', 'customer')).toBe('open');
		expect(statusAfter('open', 'agent')).toBe('pending');
		expect(statusAfter('pending', 'agent')).toBe('pending');
		expect(statusAfter('pending', 'bot')).toBe('pending');
		expect(statusAfter('closed', 'customer')).toBe('closed');
		expect(canTransition('open', 'resolved')).toBe(true);
		expect(canTransition('closed', 'open')).toBe(false);
		expect(canTransition('closed', 'closed')).toBe(true);
	});
	it('computes the summary moved with appended messages', () => {
		const c = conv({ handoff: { at, reason: 'x', team: 'support', offline: false } });
		const summary = summaryAfter(c, [
			msg({ id: '1', author: 'customer', body: 'Hello   there' }),
			msg({ id: '2', author: 'agent', body: 'Hi!' }),
			msg({ id: 'n', author: 'agent', internal: true, body: 'note' }),
		]);
		expect(summary).toEqual({
			status: 'pending',
			counts: { messages: 2, customer: 1, unreadByCustomer: 1, unreadByTeam: 0 },
			last: { at, author: 'agent', preview: 'Hi!' },
			firstResponseAt: at,
		});
		expect(summaryAfter(c, [msg({ author: 'bot', body: 'x' })]).firstResponseAt).toBeUndefined();
	});
	it('validates text, guest limits and context', () => {
		expect(validateText(' hi\r\nthere ', { maxLength: 10 })).toEqual({ ok: true, text: 'hi\nthere' });
		expect(validateText(5, { maxLength: 10 })).toMatchObject({ ok: false, problems: [{ code: 'required' }] });
		expect(validateText('   ', { maxLength: 10 })).toMatchObject({ ok: false, problems: [{ code: 'empty' }] });
		expect(validateText('x'.repeat(11), { maxLength: 10 })).toMatchObject({ ok: false, problems: [{ code: 'too_long' }] });
		expect(validateText('bad\u0007bell', { maxLength: 20 })).toMatchObject({
			ok: false,
			problems: [{ code: 'invalid_characters' }],
		});
		const guest = conv({ counts: { messages: 6, customer: 3, unreadByCustomer: 0, unreadByTeam: 0 } });
		expect(guestLimitReached(guest, 3)).toBe(true);
		expect(guestLimitReached(guest, 0)).toBe(false);
		expect(guestLimitReached({ ...guest, customerId: 'cus_1' }, 3)).toBe(false);
		expect(
			sanitiseContext({
				page: { url: 'https://shop.example.com/a/b?x=1', title: ' A   page ' },
				referrer: 'https://google.com/',
			}),
		).toEqual({
			page: { url: 'https://shop.example.com/a/b?x=1', path: '/a/b', title: 'A page' },
			referrer: 'https://google.com/',
		});
		expect(sanitiseContext({ page: { url: 'javascript:alert(1)', path: 'nope' } })).toBeNull();
		expect(sanitiseContext({ page: { path: '/p' } })).toEqual({ page: { path: '/p' } });
		expect(sanitiseContext([])).toBeNull();
	});
	it('views per audience, ETags and merges', () => {
		const c = conv({ customerId: 'cus_1', custom: { vip: true } });
		const customer = conversationView(c, 'customer', { guestLimit: 5 });
		expect(customer).toMatchObject({ id: 'cnv_1', unread: 0, identified: true, guestLimitReached: false });
		expect(customer).not.toHaveProperty('assignee');
		expect(conversationView(c, 'team')).toMatchObject({
			customerId: 'cus_1',
			assignee: null,
			ai: { paused: false },
			custom: { vip: true },
		});
		const note = msg({ id: 'n', author: 'agent', internal: true, kind: 'note', authorId: 'agt_1', payload: { mentions: [] } });
		expect(messageView(note, 'customer')).toBeNull();
		expect(messageView(note, 'team')).toMatchObject({ internal: true, authorId: 'agt_1', payload: { mentions: [] } });
		expect(messageView(msg({ language: null }), 'customer')).not.toHaveProperty('language');
		expect(streamEtag(c, 'team')).not.toBe(streamEtag({ ...c, status: 'closed' }, 'team'));
		const merged = mergeMessages(
			[
				{ id: 'b', at: '2' },
				{ id: 'a', at: '1' },
			],
			[
				{ id: 'c', at: '2' },
				{ id: 'a', at: '1', x: 1 },
			],
		);
		expect(merged.map((m) => m.id)).toEqual(['a', 'b', 'c']);
		expect(mergeMessages([{ id: 'b', at: '1' }], [{ id: 'a', at: '1' }]).map((m) => m.id)).toEqual(['a', 'b']);
		expect(mergeMessages([{ id: 'a', at: '2' }], [{ id: 'b', at: '1' }]).map((m) => m.id)).toEqual(['b', 'a']);
	});
	it('validates team patches', () => {
		const options = { allowedTags: ['vip'], teams: ['support'], snoozeMaxMs: 3_600_000, now: NOW };
		expect(
			validatePatch(
				{
					status: 'snoozed',
					snoozedUntil: new Date(NOW + 60_000).toISOString(),
					tags: ['vip'],
					priority: 'high',
					team: 'support',
					assignee: 'agt_1',
					aiPaused: true,
					subject: 'x',
					custom: { a: 1 },
				},
				options,
			),
		).toEqual([]);
		expect(validatePatch({ status: 'snoozed' }, options).map((p) => p.code)).toEqual(['required']);
		expect(validatePatch({ snoozedUntil: new Date(NOW + 7_200_000).toISOString() }, options).map((p) => p.code)).toEqual([
			'out_of_range',
		]);
		expect(
			validatePatch(
				{
					status: 'x',
					assignee: 5,
					team: 'nope',
					priority: 'x',
					tags: ['other'],
					aiPaused: 'y',
					subject: 7,
					custom: [],
					zz: 1,
				},
				options,
			).map((p) => p.path),
		).toEqual(['/zz', '/status', '/assignee', '/team', '/priority', '/tags', '/aiPaused', '/subject', '/custom']);
		expect(validatePatch({ tags: 'x' }, options)[0]?.code).toBe('invalid');
		expect(validatePatch(null, options)).toEqual([{ path: '', code: 'object_required' }]);
	});
});

describe('leads, CSAT, transcripts, notes', () => {
	const fields = /** @type {any[]} */ ([
		{ name: 'name', type: 'text', required: true },
		{ name: 'email', type: 'email', required: true },
		{ name: 'phone', type: 'phone' },
		{ name: 'topic', type: 'select', options: ['sales', 'support'] },
		{ name: 'ok', type: 'checkbox', required: true },
		{ name: 'n', type: 'number' },
		{ name: 'd', type: 'date' },
		{ name: 'msg', type: 'textarea', max_length: 5 },
	]);
	it('validates fields and leads', () => {
		expect(validateField(/** @type {any} */ (fields[1]), 'ana@example.org')).toBeNull();
		expect(validateField(/** @type {any} */ (fields[1]), 'nope')).toBe('invalid_email');
		expect(validateField(/** @type {any} */ (fields[2]), 'abc')).toBe('invalid_phone');
		expect(validateField(/** @type {any} */ (fields[3]), 'other')).toBe('invalid_option');
		expect(validateField(/** @type {any} */ (fields[4]), false)).toBe('required');
		expect(validateField(/** @type {any} */ (fields[4]), 'yes')).toBe('invalid');
		expect(validateField(/** @type {any} */ (fields[5]), 'x')).toBe('invalid');
		expect(validateField(/** @type {any} */ (fields[6]), '2026-02-30x')).toBe('invalid_date');
		expect(validateField(/** @type {any} */ (fields[7]), 'toolong')).toBe('too_long');
		expect(validateField(/** @type {any} */ (fields[0]), 5)).toBe('invalid');
		expect(validateField(/** @type {any} */ (fields[2]), undefined)).toBeNull();
		const body = { fields: { name: 'Ana', email: 'ANA@example.org', ok: true, n: 2, d: '2026-10-01' }, consent: true };
		expect(validateLead(body, { fields, consentRequired: true })).toEqual([]);
		expect(validateLead({ fields: { zz: 1 } }, { fields, consentRequired: true }).map((p) => p.path)).toEqual([
			'/fields/name',
			'/fields/email',
			'/fields/ok',
			'/fields/zz',
			'/consent',
		]);
		expect(validateLead({}, { fields, consentRequired: false })).toEqual([{ path: '/fields', code: 'required' }]);
		expect(validateLead(null, { fields, consentRequired: false })[0]?.code).toBe('object_required');
		expect(
			validateLead(
				{ fields: { name: 'a', email: 'a@b.co', ok: true }, conversationId: 5 },
				{ fields, consentRequired: false },
			)[0]?.path,
		).toBe('/conversationId');
		expect(normaliseLead({ name: ' Ana ', email: ' ANA@example.org ', phone: '', extra: 1 }, fields)).toEqual({
			values: { name: 'Ana', email: 'ANA@example.org' },
			contact: { name: 'Ana', email: 'ana@example.org', phone: null },
		});
	});
	it('asks, validates and summarises CSAT', () => {
		const config = {
			scale: 5,
			ask_when: /** @type {const} */ ('on_close'),
			follow_up: true,
			comment_max_length: 10,
			target: 0.8,
		};
		expect(shouldAsk(config, { event: 'closed', humanInvolved: false, alreadyAsked: false })).toBe(true);
		expect(shouldAsk(config, { event: 'closed', humanInvolved: false, alreadyAsked: true })).toBe(false);
		expect(
			shouldAsk({ ...config, ask_when: 'after_human' }, { event: 'resolved', humanInvolved: false, alreadyAsked: false }),
		).toBe(false);
		expect(
			shouldAsk({ ...config, ask_when: 'after_human' }, { event: 'resolved', humanInvolved: true, alreadyAsked: false }),
		).toBe(true);
		expect(shouldAsk({ ...config, ask_when: 'manual' }, { event: 'closed', humanInvolved: true, alreadyAsked: false })).toBe(
			false,
		);
		expect(shouldAsk(null, { event: 'closed', humanInvolved: true, alreadyAsked: false })).toBe(false);
		expect(validateRating({ conversationId: 'c', score: 5, comment: 'great' }, config)).toEqual([]);
		expect(validateRating({ score: 6, comment: 'x'.repeat(11) }, config).map((p) => p.code)).toEqual([
			'required',
			'out_of_range',
			'too_long',
		]);
		expect(validateRating({ conversationId: 'c', score: 1, comment: 'x' }, { ...config, follow_up: false })[0]?.code).toBe(
			'not_allowed',
		);
		expect(validateRating(null, config)[0]?.code).toBe('object_required');
		expect([1, 2, 3, 4, 5].map((s) => isPositive(s, 5))).toEqual([false, false, false, true, true]);
		expect([1, 2].map((s) => isPositive(s, 2))).toEqual([false, true]);
		expect(isPositive(8, 10)).toBe(true);
		expect(
			summarise(
				[
					{ score: 5, scale: 5 },
					{ score: 2, scale: 5 },
				],
				0.8,
			),
		).toEqual({ count: 2, positive: 1, csat: 0.5, average: 0.625, target: 0.8, onTarget: false });
		expect(summarise([], 0.8)).toEqual({ count: 0, positive: 0, csat: null, average: null, target: 0.8, onTarget: null });
		expect(summarise([{ score: 1, scale: 1 }], 0.8).average).toBe(0);
	});
	it('renders transcripts and retention', () => {
		const text = transcriptText({
			conversation: { id: 'cnv_1', openedAt: at, closedAt: at, status: 'closed' },
			messages: [
				{ author: 'customer', authorName: null, text: 'Hi', at, kind: 'text' },
				{ author: 'agent', authorName: 'Sam', text: 'Hello', at, kind: 'text' },
				{ author: 'agent', authorName: null, text: 'secret note', at, internal: true, kind: 'note' },
				{ author: 'system', authorName: null, text: 'Closed', at, kind: 'event' },
			],
			labels: { customer: 'Customer', agent: 'Agent' },
			includeInternal: false,
			title: 'Transcript',
		});
		expect(text).toBe(`Transcript\ncnv_1 · ${at} → ${at}\n\n[${at}] Customer: Hi\n[${at}] Sam: Hello\n[${at}] — Closed\n`);
		expect(
			transcriptText({
				conversation: { id: 'c', openedAt: at, closedAt: null, status: 'open' },
				messages: [{ author: 'x', authorName: null, text: 'n', at, internal: true, kind: 'note' }],
				labels: {},
				includeInternal: true,
				title: 'T',
			}),
		).toContain('(note) x: n');
		expect(transcriptJson({ conversation: {}, messages: [], exportedAt: at })).toEqual({
			format: 'ss-chatbot-transcript@1',
			exportedAt: at,
			conversation: {},
			messages: [],
		});
		expect(retainUntil(0, 2).toISOString()).toBe('1970-01-03T00:00:00.000Z');
		expect(retainUntil(0, 0).toISOString()).toBe('1970-01-02T00:00:00.000Z');
	});
	it('validates notes and resolves mentions', () => {
		expect(validateNote({ text: 'ok', mentions: ['agt_1'] })).toEqual([]);
		expect(validateNote({ text: ' ', mentions: 'x', extra: 1 }).map((p) => p.path)).toEqual(['/text', '/mentions', '/extra']);
		expect(validateNote({ text: 'x'.repeat(8001) })[0]?.code).toBe('too_long');
		expect(validateNote(null)[0]?.code).toBe('object_required');
		expect(mentionsOf({ text: 'ping @agt_2 and @nobody', mentions: ['agt_1'] }, ['agt_1', 'agt_2'])).toEqual([
			'agt_1',
			'agt_2',
		]);
	});
});

describe('tools, prompt and rules', () => {
	const tools = /** @type {any} */ ({
		order_lookup: true,
		guest_order_lookup: true,
		order_fields: ['number', 'status', 'placedAt', 'updatedAt', 'total', 'currency', 'items', 'refunded'],
		max_orders: 5,
		knowledge_search: true,
		escalate: true,
		calls_per_conversation: 30,
		custom: [
			{
				name: 'check_stock',
				description: 'Stock',
				url: 'https://x.test/s',
				parameters: [
					{ name: 'sku', type: 'string', required: true, description: 'SKU' },
					{ name: 'qty', type: 'integer' },
					{ name: 'gift', type: 'boolean' },
					{ name: 'size', type: 'string', enum: ['s', 'm'] },
					{ name: 'price', type: 'number' },
				],
			},
			{ name: 'hidden', description: 'Not for AI', url: 'https://x.test/h', allow_ai: false },
		],
	});
	it('offers tools by identity and configuration', () => {
		expect(toolSchemas({ config: tools, identified: true, knowledge: true, handoff: true, t }).map((x) => x.name)).toEqual([
			BUILTIN.orders,
			BUILTIN.knowledge,
			BUILTIN.escalate,
			'check_stock',
		]);
		expect(toolSchemas({ config: tools, identified: false, knowledge: false, handoff: false, t }).map((x) => x.name)).toEqual([
			BUILTIN.guestOrder,
			'check_stock',
		]);
		expect(toolSchemas({ config: null, identified: true, knowledge: true, handoff: true, t }).map((x) => x.name)).toEqual([
			BUILTIN.knowledge,
			BUILTIN.escalate,
		]);
		expect(parametersOf(tools.custom[0]).required).toEqual(['sku']);
		expect(parametersOf({ name: 'x', description: '', url: '' }).properties).toEqual({});
	});
	it('checks model arguments against the declared parameters', () => {
		expect(
			checkArguments(tools.custom[0], { sku: 'A1', qty: '2', gift: 'true', size: 'm', price: '9.5', extra: 'dropped' }),
		).toEqual({ ok: true, value: { sku: 'A1', qty: 2, gift: true, size: 'm', price: 9.5 } });
		expect(checkArguments(tools.custom[0], { qty: 1.5, gift: 'maybe', size: 'xl', price: 'x' })).toEqual({
			ok: false,
			errors: [
				'sku: required',
				'qty: must be integer',
				'gift: must be boolean',
				'size: must be one of s, m',
				'price: must be number',
			],
		});
		expect(checkArguments(tools.custom[0], { sku: 'x'.repeat(3000) })).toMatchObject({
			ok: true,
			value: { sku: 'x'.repeat(2000) },
		});
	});
	it('summarises orders and checks guest claims', () => {
		const order = {
			orderId: 'ord_1',
			number: '1042',
			customerId: 'cus_1',
			customer: { email: 'Ana@Example.org' },
			status: 'completed',
			currency: 'JPY',
			total: 4500,
			lines: [
				{ title: 'Mug', quantity: 2 },
				{ sku: 'S1', quantity: 1 },
			],
			refunded: 100,
			placedAt: at,
			updatedAt: at,
		};
		expect(orderSummary(order, tools.order_fields)).toEqual({
			number: '1042',
			status: 'completed',
			placedAt: at,
			updatedAt: at,
			total: '4500 JPY',
			currency: 'JPY',
			items: [
				{ title: 'Mug', quantity: 2 },
				{ title: 'S1', quantity: 1 },
			],
			refunded: '100 JPY',
		});
		expect(orderSummary({ ...order, number: null, placedAt: null, refunded: 0 }, ['number', 'placedAt', 'refunded'])).toEqual({
			number: 'ord_1',
		});
		expect(formatMoney(12345, 'USD')).toBe('123.45 USD');
		expect(formatMoney(5, 'BHD')).toBe('0.005 BHD');
		expect(formatMoney(null, 'USD')).toBeNull();
		expect(formatMoney(100, 'NOT')).toBe('1.00 NOT');
		expect(guestClaimMatches(order, { number: '#1042', email: 'ana@example.org' })).toBe(true);
		expect(guestClaimMatches(order, { number: '1043', email: 'ana@example.org' })).toBe(false);
		expect(guestClaimMatches({ ...order, customer: null }, { number: '1042', email: 'a' })).toBe(false);
		expect(toolOutput({ a: 'x'.repeat(50) }, 20)).toHaveLength(20);
		expect(toolOutput('short', 20)).toBe('short');
		expect(signatureBase(1, '{}')).toBe('ss-chatbot-tool.v1.1.{}');
	});
	it('builds the layered system prompt', () => {
		const prompt = buildSystemPrompt({
			t,
			assistantName: 'Ava',
			language: 'pt-BR',
			languageLock: true,
			tone: 'friendly',
			instructions: 'We sell furniture.',
			presentAsHuman: false,
			forbiddenTopics: ['politics'],
			answerLength: 'short',
			bubbleSeparator: '---',
			maxBubbles: 3,
			citationStyle: 'inline',
			passages: [{ ref: 1, title: 'Shipping', url: 'https://shop.example.com/shipping', text: 'We ship worldwide.' }],
			groundedOnly: true,
			customer: { identified: true, name: ' (Ana)' },
			page: { path: '/cart', title: 'Cart' },
			awaitingHuman: true,
			toolNames: ['lookup_orders'],
			step: 'Collect the order number',
			websiteDomain: 'shop.example.com',
		});
		expect(prompt).toContain('Brazilian Portuguese (pt-BR)');
		expect(prompt).toContain('You are Ava');
		expect(prompt).toContain(`${CORE_RULE_COUNT}. `);
		expect(prompt).toContain('say honestly that you are an automated assistant');
		expect(prompt).toContain('politics');
		expect(prompt).toContain('[1] Shipping (https://shop.example.com/shipping)');
		expect(prompt).toContain('answer only from these passages');
		expect(prompt).toContain('CURRENT STEP: Collect the order number');
		expect(prompt).toContain('MERCHANT INSTRUCTIONS:\nWe sell furniture.');
		const minimal = buildSystemPrompt({
			t,
			assistantName: 'Bot',
			language: 'en',
			languageLock: false,
			tone: 'concise',
			instructions: ' ',
			presentAsHuman: true,
			forbiddenTopics: [],
			answerLength: 'long',
			bubbleSeparator: '---',
			maxBubbles: 1,
			citationStyle: 'none',
			passages: [],
			groundedOnly: true,
			customer: { identified: false },
			page: null,
			awaitingHuman: false,
			toolNames: [],
		});
		expect(minimal).not.toContain('LANGUAGE');
		expect(minimal).toContain('do not describe yourself as automated');
		expect(minimal).toContain("say you don't know");
		expect(
			historyTurns(
				[
					msg({ author: 'customer', body: 'a' }),
					msg({ author: 'bot', body: 'b' }),
					msg({ author: 'agent', body: 'c', internal: true }),
					msg({ author: 'system', body: 'd' }),
					msg({ author: 'agent', body: 'e', kind: 'event' }),
					msg({ author: 'agent', body: 'f' }),
				],
				2,
			),
		).toEqual([
			{ role: 'assistant', content: 'b' },
			{ role: 'assistant', content: 'f' },
		]);
		expect(historyTurns([msg({ author: 'customer', body: 'a' })], 0)).toEqual([]);
	});
	it('compiles, checks and evaluates rules@1 conditions (errors never match)', () => {
		expect(compileCondition('')).toEqual({ ok: true, program: null });
		expect(compileCondition('cart.value > 1').ok).toBe(true);
		expect(compileCondition('cart.value > 1')).toBe(compileCondition('cart.value > 1'));
		expect(conditionMatches('cart.value > 1', { cart: { value: 2 } }, { now: NOW, timeZone: 'UTC' })).toEqual({
			matched: true,
			error: null,
		});
		expect(conditionMatches('', {}, { now: NOW, timeZone: 'UTC', whenEmpty: false }).matched).toBe(false);
		expect(conditionMatches('1 <', {}, { now: NOW, timeZone: 'UTC' }).error).not.toBeNull();
		expect(conditionMatches("lower(1) == 'x'", {}, { now: NOW, timeZone: 'UTC' }).matched).toBe(false);
		expect(checkCondition('', 'flow').ok).toBe(true);
		expect(checkCondition('unknown.thing == 1', 'proactive').warnings.length).toBeGreaterThan(0);
		for (let i = 0; i < 510; i += 1) compileCondition(`cart.value > ${i}`);
		expect(compileCondition('cart.value > 0').ok).toBe(true);
	});
});
