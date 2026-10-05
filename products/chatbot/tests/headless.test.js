/** Mode B headless cores: transport, chat client, window, launcher, proactive, lead form, CSAT, inbox and notes. */
import { describe, expect, it } from 'vitest';
import en from '../strings/en.json' with { type: 'json' };
import { createChatClient, memoryStorage } from '../headless/chatClient.js';
import { createCsat } from '../headless/csat.js';
import { createInbox } from '../headless/inbox.js';
import { createLauncher } from '../headless/launcher.js';
import { createLeadForm } from '../headless/leadForm.js';
import { createNotesPanel } from '../headless/notes.js';
import { createProactive } from '../headless/proactive.js';
import { createTransport } from '../headless/transport.js';
import { createWindow } from '../headless/window.js';
import { createFakeApi, createScheduler, createVisibility, flush } from './helpers.js';

const ok = (/** @type {any} */ value) => ({ ok: /** @type {const} */ (true), value });
const fail = (/** @type {string} */ code, status = 400) => ({ ok: /** @type {const} */ (false), error: { code, status } });
const conv = (/** @type {Record<string, any>} */ extra = {}) => ({
	id: 'cnv_1',
	status: 'open',
	humanRequested: false,
	aiPaused: false,
	unread: 0,
	guestLimitReached: false,
	...extra,
});
const message = (/** @type {Record<string, any>} */ m) => ({
	id: m.id,
	conversationId: 'cnv_1',
	author: 'bot',
	authorName: null,
	kind: 'text',
	text: 'x',
	at: m.at ?? '2026-10-01T10:00:00.000Z',
	...m,
});

describe('transport', () => {
	const make = (/** @type {Record<string, any>} */ extra = {}) => {
		const scheduler = createScheduler(0);
		const visibility = createVisibility();
		let ticks = 0;
		const transport = createTransport({
			intervalMs: 10_000,
			idleAfterMs: 60_000,
			idleIntervalMs: 30_000,
			stopAfterMs: 120_000,
			burstIntervalMs: 2_000,
			burstWindowMs: 10_000,
			onTick: () => {
				ticks += 1;
				if (extra.throws) throw new Error('boom');
			},
			onError: () => {},
			scheduler,
			visibility,
			...extra,
		});
		return { scheduler, visibility, transport, ticks: () => ticks };
	};
	it('polls while visible, backs off when idle, stops after inactivity and resumes on input', async () => {
		const { scheduler, visibility, transport, ticks } = make();
		transport.start();
		transport.start();
		await flush();
		expect(ticks()).toBe(1);
		await scheduler.advance(10_000);
		expect(ticks()).toBe(2);
		await scheduler.advance(60_000); // idle: 30 s interval now
		const before = ticks();
		await scheduler.advance(30_000);
		expect(ticks()).toBe(before + 1);
		await scheduler.advance(120_000);
		expect(transport.isParked()).toBe(true);
		const parkedAt = ticks();
		await scheduler.advance(120_000);
		expect(ticks()).toBe(parkedAt);
		visibility.poke();
		await flush();
		expect(ticks()).toBe(parkedAt + 1);
		expect(transport.isParked()).toBe(false);
		transport.stop();
		expect(transport.isRunning()).toBe(false);
		expect(scheduler.pending()).toBe(0);
	});
	it('does not poll hidden pages and ticks at once when visible again', async () => {
		const { scheduler, visibility, transport, ticks } = make();
		transport.start();
		await flush();
		visibility.set(true);
		await scheduler.advance(60_000);
		expect(ticks()).toBe(1);
		transport.pollNow();
		expect(ticks()).toBe(1);
		visibility.set(false);
		await flush();
		expect(ticks()).toBe(2);
		transport.stop();
	});
	it('bursts after sending, settles early, survives tick errors', async () => {
		const { scheduler, transport, ticks } = make({ throws: true });
		transport.expectReply();
		expect(ticks()).toBe(0); // not running
		transport.start();
		await flush();
		transport.expectReply();
		await scheduler.advance(2_000);
		expect(ticks()).toBe(2);
		transport.settleReply();
		transport.settleReply();
		await scheduler.advance(2_000);
		expect(ticks()).toBe(2);
		await scheduler.advance(8_000);
		expect(ticks()).toBe(3);
		transport.touch();
		transport.pollNow();
		await flush();
		expect(transport.ticks()).toBe(4);
		transport.stop();
		transport.pollNow();
		transport.settleReply();
	});
	it('works without a visibility source', async () => {
		const scheduler = createScheduler(0);
		let ticks = 0;
		const transport = createTransport({
			intervalMs: 1,
			idleAfterMs: 100_000,
			idleIntervalMs: 5,
			stopAfterMs: 1_000_000,
			burstIntervalMs: 1,
			burstWindowMs: 1,
			onTick: () => void (ticks += 1),
			scheduler,
		});
		transport.start();
		await flush();
		await scheduler.advance(10_000);
		expect(ticks).toBeGreaterThan(1);
		transport.touch();
		await flush();
		transport.stop();
	});
});

describe('chat client', () => {
	it('sends the login token, else the guest marker it was given, and claims guest history after sign-in', async () => {
		const api = createFakeApi({
			'POST /v1/conversations': () => ok({ conversation: conv(), marker: { token: 'cm1.tok' } }),
			'POST /v1/conversations:claim': () => ok({ claimed: 1 }),
			'GET *': () => ok({ items: [] }),
			'POST *': () => ok({}),
		});
		const storage = memoryStorage();
		let login = /** @type {string | null} */ (null);
		const client = createChatClient({ api, storage, identity: { token: () => login } });
		expect(client.hasIdentity()).toBe(false);
		await client.start({ text: 'hi' });
		expect(storage.get()).toBe('cm1.tok');
		await client.list({ cursor: 'c', status: 'open' });
		expect(api.calls.at(-1)).toMatchObject({
			path: '/v1/conversations',
			options: { query: { cursor: 'c', status: 'open' }, headers: { 'ss-identity': 'cm1.tok' } },
		});
		await client.messages('cnv/1', { since: 's', before: 'b', limit: 5, etag: 'W/"1"' });
		expect(api.calls.at(-1)).toMatchObject({
			path: '/v1/conversations/cnv%2F1/messages',
			options: { headers: { 'if-none-match': 'W/"1"' } },
		});
		await client.get('cnv_1');
		await client.send('cnv_1', { text: 'x' });
		await client.read('cnv_1');
		await client.close('cnv_1');
		await client.handoff({ conversationId: 'cnv_1' });
		await client.lead({ fields: {} });
		await client.rate({ conversationId: 'cnv_1', score: 5 });
		await client.proactive({ context: {} });
		await client.dismissProactive({ ruleId: 'r' });
		expect(/** @type {any} */ (await client.claim()).value).toEqual({ claimed: 0 }); // no login yet
		login = 'jwt.login.token';
		expect(client.hasIdentity()).toBe(true);
		await client.get('cnv_1');
		expect(api.calls.at(-1)?.options.headers).toEqual({ 'ss-identity': 'jwt.login.token' });
		expect(/** @type {any} */ (await client.claim()).value).toEqual({ claimed: 1 });
		expect(api.calls.at(-1)?.options.body).toEqual({ marker: 'cm1.tok' });
		expect(storage.get()).toBeNull();
	});
});

describe('window headless core', () => {
	const config = {
		quick_replies: ['Track my order'],
		max_message_length: 50,
		group_messages_within_seconds: 60,
		history_page_size: 20,
		poll_interval_ms: 5_000,
	};
	/** @param {Record<string, any>} routes */
	const make = (routes = {}) => {
		const scheduler = createScheduler(0);
		const visibility = createVisibility();
		const events = /** @type {any[]} */ ([]);
		const api = createFakeApi({
			'POST /v1/conversations': () =>
				ok({
					conversation: conv(),
					messages: [],
					message: message({ id: 'm1', author: 'customer', text: 'hi', at: '2026-10-01T10:00:00.000Z' }),
					replies: [
						message({
							id: 'm2',
							text: 'Hello! Pick one:',
							kind: 'buttons',
							payload: {
								buttons: [
									{ label: 'Orders', value: 'orders' },
									{ label: 'Help', url: '/help' },
								],
							},
							at: '2026-10-01T10:00:00.001Z',
						}),
					],
					marker: { token: 'cm1.marker' },
				}),
			'GET /v1/conversations': () => ok({ items: [] }),
			'GET /v1/conversations/cnv_1/messages': () => ok({ items: [], etag: 'W/"0"', conversation: conv() }),
			'POST /v1/conversations/cnv_1/messages': ({ options }) =>
				options.body.action?.kind === 'form'
					? ok({
							message: message({ id: 'm5', author: 'customer', text: 'form' }),
							replies: [
								message({
									id: 'm6',
									kind: 'csat',
									text: 'Rate us',
									payload: { scale: 3, comment: false },
									at: '2026-10-01T10:09:00.000Z',
								}),
							],
							conversation: conv(),
						})
					: ok({
							message: message({
								id: `c${options.body.text}`,
								author: 'customer',
								text: options.body.text,
								at: '2026-10-01T10:06:00.000Z',
							}),
							replies: [
								message({
									id: 'm4',
									text: 'Fill this',
									kind: 'form',
									payload: { fields: [{ name: 'email', type: 'email', required: true }] },
									at: '2026-10-01T10:06:00.001Z',
								}),
							],
							conversation: conv({ aiPaused: true }),
						}),
			'POST /v1/conversations/cnv_1/read': () => ok(conv()),
			'POST /v1/ratings': () => ok({ id: 'rat_1' }),
			'POST /v1/handoffs': () => ok({ conversation: conv({ humanRequested: true }), messages: [] }),
			'POST /v1/leads': () => ok({ id: 'lead_1' }),
			...routes,
		});
		const win = createWindow({
			config,
			strings: en,
			client: api,
			emit: (name, data) => events.push([name, data]),
			scheduler,
			visibility,
			page: () => ({ path: '/faq', title: 'FAQ' }),
		});
		return { win, api, scheduler, events };
	};

	it('opens without a conversation, starts one with the first message and shows quick replies', async () => {
		const { win, api, events } = make();
		expect(win.state().quickReplies).toEqual([{ label: 'Track my order', value: 'Track my order' }]);
		await win.actions.open();
		expect(api.calls).toHaveLength(0); // no identity yet: nothing to resume
		await win.actions.setDraft('hi');
		const sent = await win.actions.send();
		expect(sent.ok).toBe(true);
		expect(api.calls[0]?.options.body).toEqual({ text: 'hi', context: { page: { path: '/faq', title: 'FAQ' } } });
		const state = win.state();
		expect(state).toMatchObject({ conversationId: 'cnv_1', draft: '', sending: false, unread: 0 });
		expect(state.messages.map((m) => [m.id, m.label])).toEqual([
			['m1', 'You'],
			['m2', 'Assistant'],
		]);
		expect(state.quickReplies).toEqual([
			{ label: 'Orders', value: 'orders' },
			{ label: 'Help', value: 'Help', url: '/help' },
		]);
		expect(events.map((e) => e[0])).toEqual(['opened', 'started', 'message_received', 'message_sent']);
		expect(win.validate('x'.repeat(51))[0]).toMatchObject({ code: 'too_long', message: 'That message is too long.' });
		expect(win.validate('')).toHaveLength(1);
		expect((await win.actions.send('   ')).ok).toBe(false);
		expect(win.state().errorCode).toBe('validation_failed');
		win.destroy();
	});

	it('answers buttons and forms, polls agent replies, loads older pages, rates and asks for a person', async () => {
		let agentReplied = false;
		const { win, api, scheduler, events } = make({
			'GET /v1/conversations': () => ok({ items: [conv()] }),
			'GET /v1/conversations/cnv_1/messages': (/** @type {any} */ { options }) =>
				options.query.before
					? ok({
							items: [message({ id: 'm0', author: 'customer', text: 'older', at: '2026-10-01T09:00:00.000Z' })],
							hasMoreOlder: false,
							conversation: conv(),
						})
					: options.query.since === undefined
						? ok({
								items: [
									message({
										id: 'm2',
										text: 'Pick',
										kind: 'buttons',
										payload: { buttons: [{ label: 'Orders', value: 'orders' }] },
										at: '2026-10-01T10:00:00.001Z',
									}),
								],
								hasMoreOlder: true,
								etag: 'W/"1"',
								conversation: conv({ unread: 1 }),
							})
						: !agentReplied || options.headers['if-none-match'] === 'W/"2"'
							? fail('not_modified', 304)
							: ok({
									items: [
										message({
											id: 'm3',
											author: 'agent',
											authorName: 'Sam',
											text: 'A person here',
											at: '2026-10-01T10:15:00.000Z',
										}),
									],
									etag: 'W/"2"',
									conversation: conv({ humanRequested: true }),
								}),
		});
		const storage = { token: 'cm1.marker' };
		// resume needs an identity: the client gets the marker through its storage
		const resumed = createWindow({
			config,
			strings: en,
			client: createChatClient({ api, storage: { get: () => storage.token, set: () => {} } }),
			scheduler,
			emit: (n, d) => events.push([n, d]),
		});
		await resumed.actions.open();
		expect(resumed.state()).toMatchObject({ conversationId: 'cnv_1', hasMoreOlder: true });
		expect(api.calls.some((c) => c.path === '/v1/conversations/cnv_1/read')).toBe(true);
		await resumed.actions.choose({ label: 'Orders', value: 'orders' });
		expect(api.calls.findLast((c) => c.method === 'POST' && c.path.endsWith('/messages'))?.options.body).toEqual({
			text: 'Orders',
			action: { kind: 'button', value: 'orders' },
		});
		expect(resumed.state().form).toMatchObject({ kind: 'flow', fields: [{ name: 'email' }] });
		expect(resumed.validate({ values: {} })[0]).toMatchObject({ path: '/email', message: 'This field is required.' });
		expect(resumed.validate({ fields: [{ name: 'e', type: 'email' }], values: { e: 'bad' } })[0]?.message).toBe(
			'Please check this field.',
		);
		expect((await resumed.actions.submitForm({})).ok).toBe(false);
		await resumed.actions.submitForm({ email: 'a@b.co' });
		expect(resumed.state().survey).toEqual({ messageId: 'm6', scale: 3, comment: false });
		await resumed.actions.rate(3);
		expect(resumed.state()).toMatchObject({ rated: true, survey: null });
		agentReplied = true;
		await scheduler.advance(5_000);
		expect(resumed.state().messages.some((m) => m.id === 'm3' && m.label === 'Sam')).toBe(true);
		await resumed.actions.refresh(); // 304: unchanged
		await resumed.actions.loadOlder();
		expect(resumed.state().messages[0]?.id).toBe('m0');
		expect((await resumed.actions.loadOlder()).ok).toBe(false);
		await resumed.actions.requestHuman();
		expect(resumed.state().humanRequested).toBe(true);
		expect(/** @type {any} */ (await resumed.actions.choose({ label: 'Help', value: 'Help', url: '/help' })).value).toEqual({
			url: '/help',
		});
		await resumed.actions.close();
		await resumed.actions.toggle();
		expect(resumed.state().open).toBe(true);
		await resumed.actions.toggle();
		await resumed.actions.newConversation();
		expect(resumed.state()).toMatchObject({
			conversationId: null,
			messages: [],
			quickReplies: [{ label: 'Track my order', value: 'Track my order' }],
		});
		expect((await resumed.actions.rate(1)).ok).toBe(false);
		expect((await resumed.actions.requestHuman()).ok).toBe(false);
		expect((await resumed.actions.submitForm({})).ok).toBe(false);
		resumed.destroy();
		win.destroy();
	});

	it('maps problems to messages, counts unread messages while closed and submits lead forms', async () => {
		const { win } = make({
			'POST /v1/conversations': () => fail('guest_limit_reached', 403),
		});
		await win.actions.send('hello');
		expect(win.state()).toMatchObject({
			errorCode: 'guest_limit_reached',
			guestLimitReached: true,
			error: 'Please sign in to continue this conversation.',
		});
		const lead = make({
			'POST /v1/conversations': () =>
				ok({
					conversation: conv(),
					messages: [],
					message: message({ id: 'c1', author: 'customer', text: 'hi' }),
					replies: [
						message({
							id: 'f1',
							kind: 'form',
							text: 'Leave details',
							payload: { lead: true, fields: [{ name: 'email', type: 'email', required: true }] },
							at: '2026-10-01T10:00:00.002Z',
						}),
					],
				}),
			'POST /v1/leads': () => fail('validation_failed', 422),
		});
		await lead.win.actions.send('hi');
		expect(lead.win.state().form?.kind).toBe('lead');
		expect((await lead.win.actions.submitForm({ email: 'a@b.co' }, { consent: true })).ok).toBe(false);
		const later = make({
			'POST /v1/conversations': () =>
				ok({
					conversation: conv(),
					messages: [],
					message: message({ id: 'c1', author: 'customer', text: 'hi' }),
					replies: [
						message({
							id: 'f1',
							kind: 'form',
							text: 'Leave details',
							payload: { lead: true, fields: [{ name: 'email', type: 'email', required: true }] },
							at: '2026-10-01T10:00:00.002Z',
						}),
					],
				}),
			'GET /v1/conversations/cnv_1/messages': () =>
				ok({
					items: [message({ id: 'm3', author: 'agent', text: 'A person here', at: '2026-10-01T10:05:00.000Z' })],
					etag: 'W/"2"',
					conversation: conv({ unread: 2 }),
				}),
		});
		await later.win.actions.send('hi');
		await later.win.actions.submitForm({ email: 'a@b.co' }, { consent: true });
		expect(later.win.state().form).toBeNull();
		await later.win.actions.refresh();
		expect(later.win.state().unread).toBe(2); // window closed: the form and the agent reply count as unread
		const failing = make({ 'GET /v1/conversations/cnv_1/messages': () => fail('internal_error', 500) });
		await failing.win.actions.send('hi');
		expect((await failing.win.actions.refresh()).ok).toBe(false);
		const listFails = make({ 'GET /v1/conversations': () => fail('identity_required', 401) });
		const resumable = createWindow({
			config,
			strings: en,
			client: createChatClient({ api: { request: listFails.api.request }, storage: { get: () => 'cm1.x', set: () => {} } }),
		});
		expect((await resumable.actions.open()).ok).toBe(true);
		const broken = createWindow({
			config,
			strings: en,
			client: createChatClient({
				api: { request: async () => fail('internal_error', 500) },
				storage: { get: () => 'cm1.x', set: () => {} },
			}),
		});
		expect((await broken.actions.open()).ok).toBe(false);
		resumable.destroy();
		broken.destroy();
	});
});

describe('launcher headless core', () => {
	const fakeWindow = () => {
		let state = { open: false, unread: 2 };
		const listeners = new Set();
		return {
			state: () => state,
			subscribe: (/** @type {any} */ fn) => {
				listeners.add(fn);
				return () => listeners.delete(fn);
			},
			actions: {
				open: async () => {
					state = { open: true, unread: 0 };
					for (const fn of listeners) /** @type {any} */ (fn)(state);
				},
				close: async () => {
					state = { ...state, open: false };
				},
			},
			push: (/** @type {any} */ next) => {
				state = next;
				for (const fn of listeners) /** @type {any} */ (fn)(state);
			},
		};
	};
	it('shows the badge, toggles the window and follows hide rules', async () => {
		const win = fakeWindow();
		const events = /** @type {any[]} */ ([]);
		const launcher = createLauncher({
			config: {
				hide_on_paths: ['/checkout/**'],
				hide_on_devices: ['tablet'],
				position: 'bottom_start',
				size: 'large',
				icon: 'help',
				show_label: true,
				open_selector: '#help',
			},
			strings: en,
			window: win,
			environment: { path: '/products/1', device: 'mobile' },
			emit: (name) => events.push(name),
		});
		expect(launcher.state()).toMatchObject({
			visible: true,
			badge: '2',
			label: 'Open chat',
			position: 'bottom_start',
			size: 'large',
			icon: 'help',
			showLabel: true,
		});
		expect(launcher.openSelector).toBe('#help');
		await launcher.actions.toggle();
		expect(launcher.state()).toMatchObject({ open: true, badge: null, label: 'Close chat' });
		await launcher.actions.open();
		await launcher.actions.close();
		expect(launcher.state().open).toBe(false);
		await launcher.actions.close();
		win.push({ open: false, unread: 12 });
		expect(launcher.state().badge).toBe('9+');
		await launcher.actions.signal('navigate', '/checkout/pay');
		expect(launcher.state().visible).toBe(false);
		expect(
			createLauncher({ config: { hide_on_devices: ['tablet'] }, strings: en, environment: { device: 'tablet' } }).state()
				.visible,
		).toBe(false);
		expect(launcher.validate()).toEqual([]);
		expect(events).toContain('clicked');
		launcher.destroy();
	});
	it('opens automatically on the configured trigger, once per session', async () => {
		const scheduler = createScheduler(0);
		const session = new Map();
		const win = fakeWindow();
		const delayed = createLauncher({
			config: { auto_open: 'delay', auto_open_delay_seconds: 5 },
			strings: en,
			window: win,
			scheduler,
			session: { get: (k) => session.get(k) ?? null, set: (k, v) => session.set(k, v) },
		});
		await scheduler.advance(5_000);
		expect(delayed.state()).toMatchObject({ open: true, autoOpened: true });
		const again = createLauncher({
			config: { auto_open: 'scroll', auto_open_scroll_percent: 40 },
			strings: en,
			window: fakeWindow(),
			session: { get: (k) => session.get(k) ?? null, set: (k, v) => session.set(k, v) },
		});
		expect((await again.actions.signal('scroll', 60)).ok).toBe(false); // once per session
		const scroll = createLauncher({
			config: { auto_open: 'scroll', auto_open_scroll_percent: 40, auto_open_once_per_session: false },
			strings: en,
			window: fakeWindow(),
		});
		expect((await scroll.actions.signal('scroll', 10)).ok).toBe(false);
		expect((await scroll.actions.signal('scroll', 60)).ok).toBe(true);
		const idle = createLauncher({
			config: { auto_open: 'idle', auto_open_idle_seconds: 30 },
			strings: en,
			window: fakeWindow(),
		});
		expect((await idle.actions.signal('idle', 31)).ok).toBe(true);
		const exit = createLauncher({ config: { auto_open: 'exit_intent' }, strings: en, window: fakeWindow() });
		expect((await exit.actions.signal('exit')).ok).toBe(true);
		expect((await exit.actions.signal('exit')).ok).toBe(false);
		const selector = createLauncher({ config: {}, strings: en, window: fakeWindow() });
		await selector.actions.signal('selector');
		expect(selector.state().open).toBe(true);
		const pending = createLauncher({ config: { auto_open: 'delay' }, strings: en, scheduler });
		pending.destroy();
		expect(scheduler.pending()).toBe(0);
		delayed.destroy();
	});
});

describe('proactive, lead form, CSAT, inbox and notes cores', () => {
	it('evaluates, delays, shows, dismisses and replies to proactive messages', async () => {
		const scheduler = createScheduler(0);
		const events = /** @type {any[]} */ ([]);
		let opened = 0;
		const api = createFakeApi({
			'POST /v1/proactive:evaluate': () =>
				ok({ message: { ruleId: 'cart', message: 'Need help?', openWindow: true, delaySeconds: 3 } }),
			'POST /v1/proactive:dismiss': () => ok({ dismissed: true }),
		});
		const proactive = createProactive({
			strings: en,
			client: api,
			scheduler,
			window: { actions: { open: async () => void (opened += 1) } },
			emit: (n) => events.push(n),
			visitor: { id: 'anon_1', sessionId: 's1' },
		});
		await proactive.actions.evaluate({ page: { path: '/cart' } });
		expect(proactive.state().status).toBe('waiting');
		await scheduler.advance(3_000);
		expect(proactive.state().status).toBe('shown');
		expect(opened).toBe(1);
		await proactive.actions.dismiss();
		expect(proactive.state().status).toBe('dismissed');
		await proactive.actions.reply();
		expect(opened).toBe(2);
		expect(events).toEqual(['shown', 'dismissed', 'replied']);
		expect(proactive.validate()).toEqual([]);
		const none = createProactive({
			strings: en,
			client: createFakeApi({ 'POST /v1/proactive:evaluate': () => ok({ message: null }) }),
			scheduler,
		});
		await none.actions.evaluate({});
		expect(none.state().status).toBe('none');
		expect((await none.actions.dismiss()).ok).toBe(false);
		expect((await none.actions.reply()).ok).toBe(false);
		const broken = createProactive({ strings: en, client: createFakeApi({}), scheduler });
		await broken.actions.evaluate({});
		expect(broken.state().status).toBe('error');
		proactive.destroy();
	});
	it('validates and submits the lead form', async () => {
		const api = createFakeApi({
			'POST /v1/leads': ({ options }) =>
				options.body.fields.email === 'fail@x.co' ? fail('internal_error', 500) : ok({ id: 'lead_1' }),
		});
		const form = createLeadForm({
			config: {
				fields: [
					{ name: 'name', type: 'text', required: true },
					{ name: 'email', type: 'email', required: true, label: 'Work e-mail' },
				],
				consent_required: true,
			},
			strings: en,
			client: api,
			conversationId: 'cnv_1',
		});
		expect(form.state().fields.map((f) => f.label)).toEqual(['Name', 'Work e-mail']);
		expect((await form.actions.submit()).ok).toBe(false);
		expect(Object.keys(form.state().errors)).toEqual(['name', 'email', 'consent']);
		await form.actions.setValue('name', 'Ana');
		await form.actions.setValue('email', 'fail@x.co');
		await form.actions.setConsent(true);
		expect((await form.actions.submit()).ok).toBe(false);
		expect(form.state().error).toBe('Your details could not be sent. Please try again.');
		await form.actions.setValue('email', 'ana@x.co');
		expect((await form.actions.submit()).ok).toBe(true);
		expect(api.calls.at(-1)?.options.body).toEqual({
			conversationId: 'cnv_1',
			fields: { name: 'Ana', email: 'ana@x.co' },
			consent: true,
		});
		expect(form.validate({ values: { name: 'A', email: 'a@b.co' }, consent: true })).toEqual([]);
		expect(form.validate(null).length).toBe(3);
		form.destroy();
	});
	it('rates with the configured scale', async () => {
		const api = createFakeApi({
			'POST /v1/ratings': ({ options }) => (options.body.score === 1 ? fail('already_rated', 409) : ok({ id: 'rat_1' })),
		});
		const csat = createCsat({ config: { scale: 3, comment_max_length: 5 }, strings: en, client: api, conversationId: 'cnv_1' });
		expect(csat.state().options.map((o) => o.label)).toEqual(['1 of 3', '2 of 3', '3 of 3']);
		expect((await csat.actions.submit()).ok).toBe(false);
		await csat.actions.select(1);
		expect((await csat.actions.submit()).ok).toBe(false);
		await csat.actions.select(3);
		await csat.actions.setComment('toolong');
		expect((await csat.actions.submit()).ok).toBe(false);
		await csat.actions.setComment('great');
		expect((await csat.actions.submit()).ok).toBe(true);
		expect(api.calls.at(-1)?.options.body).toEqual({ conversationId: 'cnv_1', score: 3, comment: 'great' });
		expect(createCsat({ config: { scale: 7 }, strings: en, client: api, conversationId: 'x' }).state().scale).toBe(5);
		expect(csat.validate({ score: 9 })[0]?.path).toBe('/score');
		csat.destroy();
	});
	it('drives the agent inbox: queue, conversation, canned reply, reply, update and notes', async () => {
		const scheduler = createScheduler(0);
		const api = createFakeApi({
			'GET /v1/conversations': () => ok({ items: [conv()] }),
			'GET /v1/inbox/canned-replies': () => ok({ items: [{ key: 'hi', title: 'Hi', body: 'Hi {customer_name}' }] }),
			'GET /v1/conversations/cnv_1/messages': ({ options }) =>
				options.query?.since
					? ok({ items: [message({ id: 'm9', author: 'customer', at: '2026-10-01T11:00:00.000Z' })], etag: 'W/"9"' })
					: ok({ items: [message({ id: 'm1' })], etag: 'W/"1"', conversation: conv() }),
			'POST /v1/inbox/canned-replies:render': () => ok({ text: 'Hi Ana' }),
			'POST /v1/conversations/cnv_1/messages': () =>
				ok({
					message: message({ id: 'm2', author: 'agent', at: '2026-10-01T10:01:00.000Z' }),
					conversation: conv({ status: 'pending' }),
				}),
			'PATCH /v1/conversations/cnv_1': () => ok(conv({ status: 'resolved' })),
			'GET /v1/conversations/cnv_1/notes': () => ok({ items: [{ id: 'n1', text: 'vip', authorName: 'Sam', at: 't' }] }),
			'POST /v1/conversations/cnv_1/notes': () => ok({ id: 'n2', text: 'call back', authorName: null, at: 't' }),
		});
		const inbox = createInbox({ strings: en, client: api, agentId: 'agt_1', scheduler });
		await inbox.actions.load({ status: 'open', team: '' });
		expect(inbox.state()).toMatchObject({ status: 'ready', queue: [{ id: 'cnv_1' }], canned: [{ key: 'hi' }] });
		expect(api.calls[0]?.options.query).toEqual({ status: 'open' });
		expect((await inbox.actions.reply()).ok).toBe(false);
		expect((await inbox.actions.useCanned('hi')).ok).toBe(false);
		expect((await inbox.actions.update({ status: 'resolved' })).ok).toBe(false);
		await inbox.actions.select('cnv_1');
		await inbox.actions.useCanned('hi');
		expect(inbox.state().draft).toBe('Hi Ana');
		await inbox.actions.setDraft('Hello!');
		await inbox.actions.reply();
		expect(inbox.state().messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm9']);
		await scheduler.advance(10_000);
		expect(inbox.state().messages.map((m) => m.id)).toContain('m9');
		await inbox.actions.refresh();
		await inbox.actions.update({ status: 'resolved' });
		expect(inbox.state().queue[0]?.status).toBe('resolved');
		const notes = /** @type {any} */ (inbox.notes());
		await notes.actions.load();
		expect(notes.state().notes).toHaveLength(1);
		expect((await notes.actions.add()).ok).toBe(false);
		await notes.actions.setDraft('call back');
		await notes.actions.add();
		expect(notes.state().notes.map((/** @type {any} */ n) => n.id)).toEqual(['n1', 'n2']);
		expect(notes.validate({ text: '' })).toHaveLength(1);
		expect(inbox.validate('')).toHaveLength(1);
		expect(inbox.validate('ok')).toEqual([]);
		inbox.destroy();
		const failing = createInbox({ strings: en, client: createFakeApi({}), scheduler });
		await failing.actions.load();
		expect(failing.state().status).toBe('error');
		expect((await failing.actions.select('x')).ok).toBe(false);
		const failingNotes = createNotesPanel({ strings: en, client: createFakeApi({}), conversationId: 'x' });
		await failingNotes.actions.load();
		expect(failingNotes.state().status).toBe('error');
		await failingNotes.actions.setDraft('x');
		expect((await failingNotes.actions.add()).ok).toBe(false);
		failingNotes.destroy();
		failing.destroy();
	});
});
