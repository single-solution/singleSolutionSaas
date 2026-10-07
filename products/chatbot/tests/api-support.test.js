/**
 * Human support on the real router and MongoDB: handoff by phrase (assignment round-robin, SLA, queue), offline
 * fallback (lead form), AI resume after the grace window, agent replies pausing the AI, notes, status changes with
 * CSAT, the agents API, inbox summary, canned replies, work settled on read (SLA breaches, snooze wake-up, auto-close) and the
 * dashboard API with SSO sessions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, MERCHANT, WEBSITE } from './harness.js';

const TEAMS = [{ key: 'support', name: 'Support', hours: [], first_response_minutes: 0, resolution_minutes: 0 }];

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
beforeAll(async () => {
	h = await createHarness({
		config: {
			inbox: {
				teams: TEAMS,
				assignment: 'round_robin',
				canned_replies: [{ key: 'thanks', title: 'Thanks', body: 'Thanks {customer_name}, {agent_name} here.' }],
				auto_close_after_hours: 1,
				tags: ['vip'],
			},
			handoff: { ai_resume_after_minutes: 2 },
		},
	});
});
afterAll(async () => h?.close());

/** Start a guest conversation; returns its id and marker. @param {string} text */
const guest = async (text) => {
	h.clock.advance(1_000);
	const started = await h.browser('POST', '/v1/conversations', { body: { text } });
	expect(started.status, JSON.stringify(started.json)).toBe(201);
	return { id: started.json.conversation.id, marker: started.json.marker.token, json: started.json };
};

describe('handoff and the inbox', () => {
	/** @type {string[]} */
	const agents = [];
	it('manages agents (bounded, validated, soft-deleted)', async () => {
		for (const name of ['Ana', 'Ben']) {
			const created = await h.call('POST', '/v1/agents', { body: { name, teams: ['support'], status: 'online' } });
			expect(created.status, JSON.stringify(created.json)).toBe(201);
			agents.push(created.json.id);
		}
		expect((await h.call('POST', '/v1/agents', { body: { name: '' } })).status).toBe(422);
		expect((await h.call('PATCH', `/v1/agents/${agents[1]}`, { body: { status: 'away' } })).json.status).toBe('away');
		expect((await h.call('PATCH', '/v1/agents/agt_nobody', { body: { status: 'away' } })).status).toBe(404);
		expect((await h.call('PATCH', `/v1/agents/${agents[1]}`, { body: { status: 'busy' } })).status).toBe(422);
		await h.call('PATCH', `/v1/agents/${agents[1]}`, { body: { status: 'online' } });
		const listed = await h.call('GET', '/v1/agents?limit=1');
		expect(listed.json.items).toHaveLength(1);
		expect(listed.json.hasMore).toBe(true);
		expect((await h.call('GET', `/v1/agents/${agents[0]}`)).json.name).toBe('Ana');
		expect((await h.call('GET', '/v1/agents/agt_x')).status).toBe(404);
		expect((await h.call('GET', '/v1/agents', { key: h.pk, headers: { origin: 'https://shop.example.com' } })).status).toBe(
			403,
		);
	});

	it('hands off on an escalation phrase: assigned round-robin, SLA set, AI paused, chatbot.handoff@1', async () => {
		const { id, marker, json } = await guest('I want to talk to someone please');
		expect(json.replies.map((/** @type {any} */ m) => m.kind)).toEqual(['event', 'event']);
		expect(json.conversation).toMatchObject({ humanRequested: true, aiPaused: true });
		const team = await h.call('GET', `/v1/conversations/${id}`);
		expect(team.json).toMatchObject({ team: 'support', handoff: { reason: 'customer_request', offline: false } });
		expect(agents).toContain(team.json.assignee);
		const firstAgent = team.json.assignee;
		expect(team.json.sla.firstResponseDueAt).toBeTruthy();
		expect(h.published('chatbot.handoff@1').at(-1)?.data).toMatchObject({
			conversationId: id,
			assignee: firstAgent,
			offline: false,
		});
		// the AI stays quiet during the grace window
		const aiCalls = h.network.aiCalls().length;
		const quiet = await h.browser('POST', `/v1/conversations/${id}/messages`, { identity: marker, body: { text: 'hello?' } });
		expect(quiet.json.replies).toEqual([]);
		expect(h.network.aiCalls().length).toBe(aiCalls);
		// after it, the AI helps (reassurance) while nobody answered
		h.clock.advance(3 * 60_000);
		h.network.ai('A teammate will be with you shortly.');
		const resumed = await h.browser('POST', `/v1/conversations/${id}/messages`, {
			identity: marker,
			body: { text: 'still there?' },
		});
		expect(resumed.json.replies.map((/** @type {any} */ m) => m.text)).toEqual(['A teammate will be with you shortly.']);
		// an agent reply records the first response and keeps the AI paused
		const reply = await h.call('POST', `/v1/conversations/${id}/messages`, {
			body: { author: 'agent', agentId: agents[0], text: 'Hi, Ana here.' },
		});
		h.clock.advance(1_000);
		expect(reply.status, JSON.stringify(reply.json)).toBe(201);
		expect(reply.json.message).toMatchObject({ author: 'agent', authorName: 'Ana', authorId: agents[0] });
		expect(reply.json.conversation).toMatchObject({ status: 'pending', unreadByTeam: 0 });
		expect(reply.json.conversation.sla.firstResponseAt).toBeTruthy();
		h.clock.advance(10 * 60_000);
		const afterAgent = await h.browser('POST', `/v1/conversations/${id}/messages`, {
			identity: marker,
			body: { text: 'thanks' },
		});
		expect(afterAgent.json.replies).toEqual([]);
		expect(afterAgent.json.conversation.status).toBe('open');
		expect(
			(
				await h.call('POST', `/v1/conversations/${id}/messages`, {
					body: { author: 'agent', agentId: 'agt_nobody', text: 'x' },
				})
			).status,
		).toBe(404);
		// the second handoff goes to the next agent
		const second = await guest('can I speak to someone');
		expect((await h.call('GET', `/v1/conversations/${second.id}`)).json.assignee).toBe(agents.find((a) => a !== firstAgent));
		const waiting = await h.call('GET', '/v1/handoffs');
		expect(waiting.status).toBe(200);
	});

	it('keeps internal notes for the team only', async () => {
		const { id, marker } = await guest('question about my order');
		const note = await h.call('POST', `/v1/conversations/${id}/notes`, { body: { text: `VIP — @${agents[1]}` } });
		expect(note.status, JSON.stringify(note.json)).toBe(201);
		expect(note.json).toMatchObject({ internal: true, kind: 'note', payload: { mentions: [agents[1]] } });
		expect((await h.call('POST', `/v1/conversations/${id}/notes`, { body: { text: '' } })).status).toBe(422);
		expect((await h.call('GET', `/v1/conversations/${id}/notes`)).json.items).toHaveLength(1);
		const customer = await h.browser('GET', `/v1/conversations/${id}/messages`, { identity: marker });
		expect(customer.json.items.some((/** @type {any} */ m) => m.kind === 'note')).toBe(false);
		expect(h.published('chatbot.note_created@1').at(-1)?.data).toMatchObject({ conversationId: id, mentions: [agents[1]] });
		expect((await h.call('GET', '/v1/conversations/cnv_nope/notes')).status).toBe(404);
	});

	it('changes status (resolved asks CSAT, reopen, snooze, close), tags and assignment with validation and audit', async () => {
		const { id, marker } = await guest('hello there');
		h.clock.advance(1_000);
		const resolved = await h.call('PATCH', `/v1/conversations/${id}`, {
			body: { status: 'resolved', tags: ['vip'], priority: 'high' },
		});
		expect(resolved.status, JSON.stringify(resolved.json)).toBe(200);
		expect(resolved.json).toMatchObject({
			status: 'resolved',
			tags: ['vip'],
			priority: 'high',
			csat: { askedAt: expect.any(String) },
		});
		const page = await h.browser('GET', `/v1/conversations/${id}/messages`, { identity: marker });
		expect(page.json.items.map((/** @type {any} */ m) => m.kind).slice(-2)).toEqual(['event', 'csat']);
		expect((await h.call('PATCH', `/v1/conversations/${id}`, { body: { tags: ['unknown'] } })).status).toBe(422);
		expect((await h.call('PATCH', `/v1/conversations/${id}`, { body: { status: 'pending' } })).status).toBe(409);
		expect((await h.call('PATCH', `/v1/conversations/${id}`, { body: { status: 'open' } })).json.status).toBe('open');
		expect((await h.call('PATCH', `/v1/conversations/${id}`, { body: { assignee: 'agt_nobody' } })).status).toBe(404);
		const assigned = await h.call('PATCH', `/v1/conversations/${id}`, { body: { assignee: agents[1], aiPaused: true } });
		expect(assigned.json).toMatchObject({ assignee: agents[1], ai: { paused: true, reason: 'manual' } });
		expect((await h.call('PATCH', `/v1/conversations/${id}`, { body: { aiPaused: false } })).json.ai.paused).toBe(false);
		const snoozed = await h.call('PATCH', `/v1/conversations/${id}`, {
			body: { status: 'snoozed', snoozedUntil: new Date(h.clock.now() + 60_000).toISOString() },
		});
		expect(snoozed.json.status).toBe('snoozed');
		expect(
			(
				await h.call('PATCH', `/v1/conversations/${id}`, {
					body: { snoozedUntil: new Date(h.clock.now() + 120_000).toISOString() },
				})
			).json.snoozedUntil,
		).toBeTruthy();
		const audit = await h.db.collection('ss_chatbot_audit').findOne({ websiteId: WEBSITE, action: 'conversation.updated' });
		expect(audit?.actor).toMatchObject({ type: 'api' });
		const closed = await h.call('PATCH', `/v1/conversations/${id}`, { body: { status: 'closed' } });
		expect(closed.json.status).toBe('closed');
		expect((await h.call('PATCH', '/v1/conversations/cnv_nope', { body: { status: 'open' } })).status).toBe(404);
	});

	it('serves the inbox summary and canned replies', async () => {
		const summary = await h.call('GET', '/v1/inbox');
		expect(summary.json).toMatchObject({
			agents: { total: 2, online: 2 },
			assignment: 'round_robin',
			teams: [{ key: 'support', open: true }],
		});
		expect((await h.call('GET', '/v1/inbox/canned-replies')).json.items[0]).toMatchObject({ key: 'thanks' });
		const { id } = await guest('hi');
		const rendered = await h.call('POST', '/v1/inbox/canned-replies:render', {
			idempotencyKey: null,
			body: { key: 'thanks', conversationId: id, agentId: agents[0] },
		});
		expect(rendered.json.text).toBe('Thanks , Ana here.');
		expect(
			(
				await h.call('POST', '/v1/inbox/canned-replies:render', {
					idempotencyKey: null,
					body: { key: 'nope', conversationId: id },
				})
			).status,
		).toBe(404);
		expect(
			(
				await h.call('POST', '/v1/inbox/canned-replies:render', {
					idempotencyKey: null,
					body: { key: 'thanks', conversationId: 'cnv_x' },
				})
			).status,
		).toBe(404);
		expect((await h.call('POST', '/v1/inbox/canned-replies:render', { idempotencyKey: null, body: {} })).status).toBe(422);
	});

	it('settles on read: SLA breaches recorded once, deleted agents purged by TTL, idle conversations auto-closed', async () => {
		const { id } = await guest('please talk to someone now');
		await h.call('DELETE', `/v1/agents/${agents[1]}`);
		expect((await h.call('DELETE', `/v1/agents/${agents[1]}`)).status).toBe(404);
		const deleted = await h.collection('agents').findOne({ websiteId: WEBSITE, id: agents[1] });
		expect(deleted?.purgeAt.getTime()).toBe(h.clock.now() + 30 * 24 * 3_600_000);
		h.clock.advance(40 * 24 * 3_600_000);
		await h.entitle();
		// nothing ran: the KPI already counts the missed targets, nothing is recorded until the conversation is read
		expect((await h.call('GET', '/v1/inbox')).json.breaches).toBeGreaterThanOrEqual(1);
		expect((await h.collection('conversations').findOne({ websiteId: WEBSITE, id }))?.sla.breached).toEqual([]);
		const read = await h.call('GET', `/v1/conversations/${id}`);
		expect(read.json.sla.breached).toEqual(['first_response', 'resolution']);
		expect((await h.call('GET', `/v1/conversations/${id}`)).json.sla.breached).toEqual(['first_response', 'resolution']);
		const breached = await h.collection('conversations').findOne({ websiteId: WEBSITE, id });
		expect(breached?.sla.breached).toEqual(['first_response', 'resolution']);
		// a resolved conversation idle past auto_close_after_hours is closed when read (single read or listing)
		const single = await guest('close me when read');
		const listed = await guest('close me when listed');
		for (const c of [single, listed]) await h.call('PATCH', `/v1/conversations/${c.id}`, { body: { status: 'resolved' } });
		expect((await h.call('GET', `/v1/conversations/${single.id}`)).json.status).toBe('resolved');
		h.clock.advance(2 * 3_600_000);
		await h.entitle();
		expect((await h.collection('conversations').findOne({ websiteId: WEBSITE, id: single.id }))?.status).toBe('resolved');
		expect((await h.call('GET', `/v1/conversations/${single.id}`)).json.status).toBe('closed');
		const page = await h.call('GET', '/v1/conversations?status=resolved&limit=100');
		expect(page.json.items.find((/** @type {any} */ c) => c.id === listed.id)?.status).toBe('closed');
		expect((await h.collection('conversations').findOne({ websiteId: WEBSITE, id: listed.id }))?.status).toBe('closed');
		expect(h.published('chatbot.closed@1').filter((e) => e.data.reason === 'inactive').length).toBeGreaterThanOrEqual(2);
	});

	it('settles a conversation once when two reads race (the breach write is guarded)', async () => {
		const { id } = await guest('please talk to someone now');
		h.clock.advance(40 * 24 * 3_600_000);
		await h.entitle();
		const site = /** @type {any} */ (await h.chatbot.siteFor(WEBSITE));
		const stale = await h.collection('conversations').findOne({ websiteId: WEBSITE, id });
		const [a, b] = await Promise.all([site.repos.conversations.get(id), site.repos.conversations.get(id)]);
		expect(a.sla.breached).toEqual(['first_response', 'resolution']);
		expect(b.sla.breached).toEqual(['first_response', 'resolution']);
		// a stale copy settled after the write keeps the recorded breaches
		const again = await h.chatbot.service.settle(site, /** @type {any} */ ({ ...stale, sla: { ...stale?.sla, breached: [] } }));
		expect(again?.sla?.breached).toEqual(['first_response', 'resolution']);
		expect(await h.chatbot.service.settle(site, null)).toBeNull();
	});

	it('reads a passed snooze as open, and wakes it on access', async () => {
		const snoozed = await guest('snooze until later');
		const until = new Date(h.clock.now() + 60_000).toISOString();
		await h.call('PATCH', `/v1/conversations/${snoozed.id}`, { body: { status: 'snoozed', snoozedUntil: until } });
		/** @param {string} status */
		const ids = async (status) =>
			(await h.call('GET', `/v1/conversations?status=${status}&limit=100`)).json.items.map((/** @type {any} */ c) => c.id);
		expect(await ids('snoozed')).toContain(snoozed.id);
		expect(await ids('open')).not.toContain(snoozed.id);
		h.clock.advance(61_000);
		// nothing ran: listings already see it as open
		expect(await ids('snoozed')).not.toContain(snoozed.id);
		expect(await ids('open,pending')).toContain(snoozed.id);
		expect(await ids('snoozed,closed')).not.toContain(snoozed.id);
		expect(await ids('open,snoozed')).toContain(snoozed.id);
		expect((await h.collection('conversations').findOne({ websiteId: WEBSITE, id: snoozed.id }))?.status).toBe('snoozed');
		// reading it ends the snooze
		const read = await h.call('GET', `/v1/conversations/${snoozed.id}`);
		expect(read.json.status).toBe('open');
		const stored = await h.collection('conversations').findOne({ websiteId: WEBSITE, id: snoozed.id });
		expect(stored?.status).toBe('open');
		expect(stored?.snoozedUntil).toBeNull();
	});

	it('goes offline with a lead form when the team is closed', async () => {
		await h.entitle({
			config: {
				inbox: { teams: [{ key: 'support', hours: [{ days: ['sun'], start: '00:00', end: '00:01' }] }] },
				handoff: {},
			},
		});
		const { json } = await guest('talk to someone');
		const form = json.replies.find((/** @type {any} */ m) => m.kind === 'form');
		expect(form.payload).toMatchObject({ lead: true, consent: true });
		expect(json.replies.some((/** @type {any} */ m) => m.text.startsWith("We're back at"))).toBe(true);
		await h.entitle({
			config: {
				inbox: { teams: [{ key: 'support', hours: [{ days: ['sun'], start: '00:00', end: '00:01' }] }] },
				handoff: { offline_fallback: 'link', offline_link: 'https://wa.me/123' },
			},
		});
		const link = await guest('talk to someone');
		expect(link.json.replies[0].text).toContain('https://wa.me/123');
		await h.entitle({ elements: { inbox: false }, config: { handoff: { offline_fallback: 'message' } } });
		const message = await guest('talk to someone');
		expect(message.json.replies[0].text).toContain('Leave a message here');
		expect((await h.call('GET', '/v1/inbox')).status).toBe(403);
		expect(
			(await h.call('POST', `/v1/conversations/${message.id}/messages`, { body: { author: 'agent', text: 'hi' } })).status,
		).toBe(403);
		const requested = await h.browser('POST', '/v1/handoffs', {
			identity: message.marker,
			body: { conversationId: message.id },
		});
		expect(requested.status).toBe(201);
		await h.entitle();
	});
});

describe('dashboard (SSO)', () => {
	/** @param {'merchant' | 'admin'} kind @param {Record<string, any>} [extra] */
	const launch = async (kind, extra = {}) => {
		const { token } = await h.portal.issueLaunch({
			kind,
			subject: 'usr_merchant',
			user: { id: 'usr_merchant', email: 'owner@shop.example.com' },
			scope: { merchantId: MERCHANT, websiteId: WEBSITE },
			...extra,
		});
		const sso = await h.handle(new Request(`https://chatbot.example.com/sso?launch=${encodeURIComponent(token)}`));
		const session = /ss_session=(ses_[^;]+)/.exec(sso.headers.get('set-cookie') ?? '')?.[1];
		if (!session) throw new Error(`no session (${sso.status})`);
		return session;
	};
	it('serves KPIs, conversations, agent replies (auto agent), notes, status and FAQ entries to merchants', async () => {
		const session = await launch('merchant');
		const bearer = { key: session };
		expect((await h.call('GET', '/v1/session', bearer)).json).toMatchObject({ kind: 'merchant', role: 'merchant' });
		const overview = await h.call('GET', '/v1/dashboard/overview', bearer);
		expect(overview.status).toBe(200);
		expect(overview.json).toHaveProperty('tokens');
		const { id } = await guest('dashboard test');
		const detail = await h.call('GET', `/v1/dashboard/conversations/${id}`, bearer);
		expect(detail.json.items.length).toBeGreaterThan(0);
		expect(
			(await h.call('GET', `/v1/dashboard/conversations/${id}`, { ...bearer, headers: { 'if-none-match': detail.json.etag } }))
				.status,
		).toBe(304);
		expect((await h.call('GET', '/v1/dashboard/conversations/cnv_x', bearer)).status).toBe(404);
		const reply = await h.call('POST', `/v1/dashboard/conversations/${id}/messages`, {
			...bearer,
			body: { text: 'From the dashboard' },
		});
		expect(reply.status, JSON.stringify(reply.json)).toBe(201);
		expect(reply.json.message.authorName).toBe('owner@shop.example.com');
		expect(
			(await h.call('POST', `/v1/dashboard/conversations/${id}/notes`, { ...bearer, body: { text: 'note' } })).status,
		).toBe(201);
		expect(
			(await h.call('PATCH', `/v1/dashboard/conversations/${id}`, { ...bearer, body: { status: 'resolved' } })).json.status,
		).toBe('resolved');
		expect(
			(await h.call('POST', '/v1/dashboard/knowledge-entries', { ...bearer, body: { question: 'Hours?', answer: '9 to 5.' } }))
				.status,
		).toBe(201);
		expect((await h.call('POST', '/v1/dashboard/knowledge-entries', { ...bearer, body: {} })).status).toBe(422);
		const refresh = await h.call('POST', '/v1/dashboard/knowledge-sources:refresh', { ...bearer, idempotencyKey: null });
		expect(refresh.json).toEqual({ refreshed: 0, failed: 0, remaining: 0 });
		for (const path of [`/v1/dashboard/conversations/cnv_x/messages`, `/v1/dashboard/conversations/cnv_x/notes`])
			expect((await h.call('POST', path, { ...bearer, body: { text: 'x' } })).status).toBe(404);
		expect((await h.call('PATCH', '/v1/dashboard/conversations/cnv_x', { ...bearer, body: {} })).status).toBe(404);
		// staff (admin launch) reply as staff; without a website the dashboard routes answer 400
		const staff = await launch('admin', { subject: 'stf_1', user: { id: 'stf_1' } });
		const staffReply = await h.call('POST', `/v1/dashboard/conversations/${id}/notes`, { key: staff, body: { text: 'staff' } });
		expect(staffReply.status).toBe(201);
		const unscoped = await launch('merchant', { scope: { merchantId: MERCHANT } });
		expect((await h.call('GET', '/v1/dashboard/overview', { key: unscoped })).status).toBe(400);
		expect(
			(await h.call('POST', '/v1/dashboard/knowledge-sources:refresh', { key: unscoped, idempotencyKey: null })).status,
		).toBe(400);
	});
	it('resolves dashboard contexts (live, pick website, not subscribed)', async () => {
		const { resolveDashboard } = await import('../api/dashboard.js');
		expect((await resolveDashboard({ chatbot: h.chatbot, sessionId: null })).state).toBe('signin');
		const live = await resolveDashboard({ chatbot: h.chatbot, sessionId: await launch('merchant') });
		expect(live.state).toBe('ready');
		if (live.state !== 'ready') return;
		expect(live.aiConnected).toBe(true);
		expect((await live.data.conversations({ status: 'open' })).length).toBeGreaterThanOrEqual(0);
		const first = (await live.data.conversations({}))[0];
		expect((await live.data.conversation(String(first?.id)))?.conversation.id).toBe(first?.id);
		expect(await live.data.conversation('cnv_x')).toBeNull();
		expect((await live.data.entries()).length).toBeGreaterThan(0);
		expect(await live.data.sources()).toEqual([]);
		expect(await live.data.overview()).toHaveProperty('open');
		const admin = await launch('admin', { scope: { merchantId: MERCHANT, websiteIds: [] } });
		expect((await resolveDashboard({ chatbot: h.chatbot, sessionId: admin })).state).toBe('pick_website');
		const other = await launch('merchant', { scope: { merchantId: MERCHANT, websiteId: 'web_9123456789abcdefghjkmnpq' } });
		expect((await resolveDashboard({ chatbot: h.chatbot, sessionId: other })).state).toBe('not_subscribed');
	});
});
