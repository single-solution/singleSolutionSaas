// @vitest-environment jsdom
/* global document, window */
import { afterEach, describe, expect, it, vi } from 'vitest';
import strings from '../strings/en.json' with { type: 'json' };
import { SUBSCRIBED_EVENT, SUBSCRIBER_STORAGE_KEY, WIDGET_ATTRIBUTE, WIDGET_GLOBAL } from '../core/widgets.js';
import { REFRESH_BEFORE_MS, adminCall, createTicketSource } from '../ui/tickets.js';
import { ADMIN_CONFIG_PATH, CONFIG_PATH, startWidget } from '../ui/widget.js';

const BASE = 'https://notifications.example.dev';
const KEY = Buffer.alloc(65, 4).toString('base64url');

/** @param {string[]} features @param {string | null} [pushPublicKey] */
const configOf = (features, pushPublicKey = KEY) => ({
	texts: { ...strings },
	theme: { mode: /** @type {const} */ ('light') },
	customCss: '',
	features,
	settings: { pushPublicKey },
});

/** @param {string} key */
const place = (key) => {
	const host = document.createElement('div');
	host.setAttribute(WIDGET_ATTRIBUTE, key);
	document.body.append(host);
	return host;
};

/** @param {string | null} token */
const script = (token) => {
	const node = document.createElement('script');
	node.src = `${BASE}/widget.js`;
	if (token) node.dataset.token = token;
	return node;
};

/** Let pending promises settle. */
const flush = async () => {
	for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** @param {number} status @param {unknown} [body] */
const answer = (status, body = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status });

/**
 * `window.fetch` answering by method and path.
 * @param {Record<string, (init: RequestInit | undefined, url: URL) => Response | Promise<Response>>} routes keys `METHOD /path`
 */
const serve = (routes) =>
	vi.spyOn(window, 'fetch').mockImplementation(async (input, init) => {
		const url = new URL(String(input));
		const route = routes[`${init?.method ?? 'GET'} ${url.pathname}`];
		return route ? route(init, url) : answer(404);
	});

/** @param {HTMLElement} host @param {string} selector */
const inside = (host, selector) => /** @type {any} */ (host.shadowRoot?.querySelector(selector));
/** @param {HTMLElement} host */
const statusOf = (host) => inside(host, '[role="status"]').textContent;
/** @param {HTMLElement} host @param {string} text */
const button = (host, text) =>
	/** @type {HTMLButtonElement} */ (
		[...(host.shadowRoot?.querySelectorAll('button') ?? [])].find((b) => b.textContent === text)
	);

/**
 * The browser push APIs jsdom lacks.
 * @param {{ permission?: string, request?: string, subscribeFails?: boolean }} [options]
 */
const pushBrowser = ({ permission = 'default', request = 'granted', subscribeFails = false } = {}) => {
	const subscription = {
		endpoint: 'https://push.example.net/s/1',
		toJSON: () => ({ endpoint: 'https://push.example.net/s/1', keys: { p256dh: 'p', auth: 'a' } }),
		unsubscribe: vi.fn(async () => true),
	};
	const pushManager = {
		subscribe: vi.fn(async () => {
			if (subscribeFails) throw new Error('denied');
			return subscription;
		}),
		getSubscription: vi.fn(async () => subscription),
	};
	const serviceWorker = {
		register: vi.fn(async () => ({ pushManager })),
		getRegistration: vi.fn(async () => ({ pushManager })),
	};
	Object.defineProperty(window.navigator, 'serviceWorker', { value: serviceWorker, configurable: true });
	Object.assign(window, {
		PushManager: function PushManager() {},
		Notification: { permission, requestPermission: vi.fn(async () => request) },
	});
	return { subscription, pushManager, serviceWorker };
};

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.useRealTimers();
	window.localStorage.clear();
	Reflect.deleteProperty(window.navigator, 'serviceWorker');
	Reflect.deleteProperty(window, 'PushManager');
	Reflect.deleteProperty(window, 'Notification');
});

describe('visitor push-permission widget', () => {
	it('mounts only with data-token while browser push is on', async () => {
		const host = place('push_permission');
		const fetch = serve({ [`GET ${CONFIG_PATH}`]: () => answer(200, configOf([])) });
		await startWidget({ window, script: script(null) }).ready;
		expect(fetch).not.toHaveBeenCalled();
		await startWidget({ window, script: script('browser-token') }).ready;
		expect(host.shadowRoot).toBeNull();
		fetch.mockImplementation(async () => {
			throw new Error('offline');
		});
		await startWidget({ window, script: script('browser-token') }).ready;
		expect(host.shadowRoot).toBeNull();
	});

	it('says when the browser cannot show notifications or blocked them', async () => {
		const host = place('push_permission');
		serve({ [`GET ${CONFIG_PATH}`]: () => answer(200, configOf(['browser_push'])) });
		await startWidget({ window, script: script('browser-token') }).ready;
		expect(statusOf(host)).toBe(strings['push.unsupported']);
		pushBrowser({ permission: 'denied' });
		await startWidget({ window, script: script('browser-token') }).ready;
		expect(statusOf(host)).toBe(strings['push.blocked']);
	});

	it('subscribes, announces the subscriber id, and turns off again', async () => {
		const host = place('push_permission');
		const { subscription, serviceWorker } = pushBrowser();
		/** @type {unknown[]} */
		const sent = [];
		serve({
			[`GET ${CONFIG_PATH}`]: () => answer(200, configOf(['browser_push'])),
			'POST /v1/push/subscriptions': (init) => {
				sent.push(JSON.parse(String(init?.body)));
				return answer(201, { subscriberId: 'sub_1' });
			},
			'POST /v1/push/subscriptions/remove': (init) => {
				sent.push(JSON.parse(String(init?.body)));
				return answer(204);
			},
		});
		/** @type {string[]} */
		const announced = [];
		window.addEventListener(SUBSCRIBED_EVENT, (event) =>
			announced.push(/** @type {CustomEvent} */ (event).detail.subscriberId),
		);
		await startWidget({ window, script: script('browser-token') }).ready;
		expect(statusOf(host)).toBe(strings['push.ask']);
		button(host, strings['push.enable']).click();
		await flush();
		expect(serviceWorker.register).toHaveBeenCalledWith('/ss-notifications-sw.js');
		expect(sent[0]).toEqual({ subscription: subscription.toJSON() });
		expect(window.localStorage.getItem(SUBSCRIBER_STORAGE_KEY)).toBe('sub_1');
		expect(announced).toEqual(['sub_1']);
		expect(statusOf(host)).toBe(strings['push.enabled']);
		button(host, strings['push.disable']).click();
		await flush();
		expect(sent[1]).toEqual({ subscriberId: 'sub_1', endpoint: subscription.endpoint });
		expect(subscription.unsubscribe).toHaveBeenCalled();
		expect(window.localStorage.getItem(SUBSCRIBER_STORAGE_KEY)).toBeNull();
		expect(statusOf(host)).toBe(strings['push.ask']);
	});

	it('shows the stored state, a refusal and failures', async () => {
		window.localStorage.setItem(SUBSCRIBER_STORAGE_KEY, 'sub_9');
		pushBrowser({ permission: 'granted', request: 'denied' });
		const host = place('push_permission');
		serve({
			[`GET ${CONFIG_PATH}`]: () => answer(200, configOf(['browser_push'])),
			'POST /v1/push/subscriptions': () => answer(403, {}),
		});
		await startWidget({ window, script: script('browser-token') }).ready;
		expect(statusOf(host)).toBe(strings['push.enabled']);
		document.body.replaceChildren();
		const again = place('push_permission');
		pushBrowser({ request: 'denied' });
		await startWidget({ window, script: script('browser-token') }).ready;
		button(again, strings['push.enable']).click();
		await flush();
		expect(statusOf(again)).toBe(strings['push.blocked']);
		pushBrowser({ request: 'default' });
		document.body.replaceChildren();
		const third = place('push_permission');
		await startWidget({ window, script: script('browser-token') }).ready;
		button(third, strings['push.enable']).click();
		await flush();
		expect(statusOf(third)).toBe(strings['push.ask']);
		pushBrowser();
		button(third, strings['push.enable']).click();
		await flush();
		expect(statusOf(third)).toBe(strings['push.failed']);
		pushBrowser({ subscribeFails: true });
		button(third, strings['push.enable']).click();
		await flush();
		expect(statusOf(third)).toBe(strings['push.failed']);
	});
});

describe('admin widgets', () => {
	const TICKET = { ticket: 'ticket-1', expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
	const ADMIN_FEATURES = ['email', 'sms', 'send_api', 'staff_push'];

	/** @param {Record<string, (init: RequestInit | undefined, url: URL) => Response | Promise<Response>>} routes */
	const startAdmin = async (routes, features = ADMIN_FEATURES) => {
		const fetch = serve({ [`GET ${ADMIN_CONFIG_PATH}`]: () => answer(200, configOf(features)), ...routes });
		const widget = startWidget({ window, script: script(null) });
		expect(/** @type {any} */ (window)[WIDGET_GLOBAL].admin).toBe(widget.admin);
		await widget.admin({ getTicket: async () => TICKET });
		await flush();
		return fetch;
	};

	it('mount nothing without a ticket or a config', async () => {
		const host = place('delivery_log');
		const fetch = serve({ [`GET ${ADMIN_CONFIG_PATH}`]: () => answer(403) });
		const widget = startWidget({ window, script: script(null) });
		await widget.admin({
			getTicket: async () => {
				throw new Error('no');
			},
		});
		await widget.admin({ getTicket: async () => /** @type {any} */ ({}) });
		expect(fetch).not.toHaveBeenCalled();
		await widget.admin({ getTicket: async () => TICKET });
		expect(host.shadowRoot).toBeNull();
	});

	it('the delivery log lists, filters and pages the messages', async () => {
		const host = place('delivery_log');
		/** @type {URL[]} */
		const asked = [];
		const item = (/** @type {string} */ id, /** @type {string | null} */ template) => ({
			id,
			template,
			channel: 'sms',
			to: '+15550001111',
			status: 'failed',
			reason: 'bad number',
			attempts: [{}, {}],
			createdAt: '2026-10-01T10:00:00.000Z',
		});
		await startAdmin({
			'GET /v1/admin/messages': (init, url) => {
				asked.push(url);
				if (url.searchParams.get('status') === 'sent') return answer(500);
				if (url.searchParams.get('channel') === 'email') return answer(200, { items: [], nextCursor: null, hasMore: false });
				return url.searchParams.get('cursor')
					? answer(200, { items: [item('m2', null)], nextCursor: null, hasMore: false })
					: answer(200, { items: [item('m1', 'welcome')], nextCursor: 'c1', hasMore: true });
			},
		});
		expect(host.shadowRoot?.querySelectorAll('li')).toHaveLength(1);
		expect(inside(host, 'li').textContent).toContain('+15550001111 · welcome');
		expect(inside(host, '.meta').textContent).toContain('SMS · Failed · 2 attempts');
		button(host, strings['log.more']).click();
		await flush();
		expect(asked.at(-1)?.searchParams.get('cursor')).toBe('c1');
		expect(host.shadowRoot?.querySelectorAll('li')[1]?.textContent).toContain(strings['log.oneOff']);
		const [status, channel] = /** @type {HTMLSelectElement[]} */ ([...(host.shadowRoot?.querySelectorAll('select') ?? [])]);
		/** @type {HTMLSelectElement} */ (channel).value = 'email';
		channel?.dispatchEvent(new window.Event('change'));
		await flush();
		expect(statusOf(host)).toBe(strings['log.empty']);
		/** @type {HTMLSelectElement} */ (status).value = 'sent';
		status?.dispatchEvent(new window.Event('change'));
		await flush();
		expect(statusOf(host)).toBe(strings['log.failed']);
	});

	it('the delivery log shows times with the website’s Format and business time zone', async () => {
		const host = place('delivery_log');
		const message = {
			id: 'm1',
			template: 'welcome',
			channel: 'email',
			to: 'a@example.com',
			status: 'sent',
			reason: null,
			attempts: [{}],
			createdAt: '2026-10-01T10:00:00.000Z',
		};
		serve({
			[`GET ${ADMIN_CONFIG_PATH}`]: () =>
				answer(200, {
					...configOf(ADMIN_FEATURES),
					format: { locale: 'en-GB', currencyDisplay: 'code', currencySymbol: '', wholeUnits: false, times: 'business' },
					timeZone: 'Asia/Karachi',
				}),
			'GET /v1/admin/messages': () => answer(200, { items: [message], nextCursor: null, hasMore: false }),
		});
		const widget = startWidget({ window, script: script(null) });
		await widget.admin({ getTicket: async () => TICKET });
		await flush();
		expect(inside(host, '.meta').textContent).toBe('E-mail · Sent · 1 attempts · 1 Oct 2026, 15:00');
	});

	it('the template editor lists, loads, saves and deletes templates', async () => {
		const host = place('template_editor');
		/** @type {any[]} */
		const saved = [];
		let items = [
			{
				key: 'welcome',
				channel: 'email',
				language: 'default',
				subject: 'Hi',
				text: 'Hello',
				required: false,
				urgent: true,
				providerTemplate: '',
			},
		];
		await startAdmin({
			'GET /v1/admin/templates': () => answer(200, { items }),
			'PUT /v1/admin/templates': (init) => {
				const body = JSON.parse(String(init?.body));
				saved.push(body);
				return body.text === '' ? answer(422, { detail: 'Write the message.' }) : answer(200, body);
			},
			'DELETE /v1/admin/templates/welcome/sms/ur': () => {
				items = [];
				return answer(204);
			},
			'DELETE /v1/admin/templates/x/email/default': () => answer(404, { detail: 'No such template.' }),
		});
		const pick = /** @type {HTMLButtonElement} */ (inside(host, 'li button'));
		expect(pick.textContent).toBe('welcome · E-mail · Default');
		pick.click();
		const fields = /** @type {any[]} */ ([...(host.shadowRoot?.querySelectorAll('input, select, textarea') ?? [])]);
		const [key, channel, language, subject, text, required, urgent] = fields;
		expect([key.value, channel.value, subject.value, text.value, urgent.checked, required.checked]).toEqual([
			'welcome',
			'email',
			'Hi',
			'Hello',
			true,
			false,
		]);
		channel.value = 'sms';
		language.value = 'ur';
		const form = /** @type {HTMLFormElement} */ (inside(host, 'form'));
		form.dispatchEvent(new window.Event('submit', { cancelable: true }));
		await flush();
		expect(saved[0]).toMatchObject({ key: 'welcome', channel: 'sms', language: 'ur', urgent: true });
		expect(statusOf(host)).toBe(strings['templates.saved']);
		text.value = '';
		form.dispatchEvent(new window.Event('submit', { cancelable: true }));
		await flush();
		expect(statusOf(host)).toBe('This could not be saved: Write the message.');
		button(host, strings['templates.delete']).click();
		await flush();
		expect(statusOf(host)).toBe(strings['templates.deleted']);
		expect(inside(host, 'li').textContent).toBe(strings['templates.empty']);
		key.value = 'x';
		button(host, strings['templates.delete']).click();
		await flush();
		expect(statusOf(host)).toBe('This could not be saved: No such template.');
		button(host, strings['templates.new']).click();
		expect(key.value).toBe('');
	});

	it('the template editor says when the list cannot be loaded', async () => {
		const host = place('template_editor');
		await startAdmin({ 'GET /v1/admin/templates': () => answer(500) });
		expect(statusOf(host)).toBe('This could not be saved: ');
	});

	it('send a message: picks channels of switched-on features and reports the outcome', async () => {
		const host = place('send_message');
		/** @type {any[]} */
		const bodies = [];
		const outcomes = [
			answer(201, { status: 'sent' }),
			answer(201, { status: 'queued' }),
			answer(201, { status: 'skipped', reason: 'limited' }),
			answer(422, { detail: 'Enter an e-mail address.' }),
			answer(500, {}),
		];
		await startAdmin({
			'POST /v1/admin/messages': (init) => {
				bodies.push(JSON.parse(String(init?.body)));
				return /** @type {Response} */ (outcomes.shift());
			},
		});
		const channel = /** @type {HTMLSelectElement} */ (inside(host, 'select'));
		expect([...channel.options].map((option) => option.value)).toEqual(['email', 'sms']);
		const subject = /** @type {HTMLInputElement} */ (inside(host, '#send-subject'));
		expect(subject.hidden).toBe(false);
		/** @type {HTMLInputElement} */ (inside(host, '#send-to')).value = ' ana@example.com ';
		subject.value = 'Hi';
		/** @type {HTMLTextAreaElement} */ (inside(host, '#send-text')).value = 'Hello';
		const form = /** @type {HTMLFormElement} */ (inside(host, 'form'));
		const submit = async () => {
			form.dispatchEvent(new window.Event('submit', { cancelable: true }));
			await flush();
			return statusOf(host);
		};
		expect(await submit()).toBe(strings['send.done']);
		expect(bodies[0]).toEqual({ channel: 'email', to: 'ana@example.com', subject: 'Hi', text: 'Hello' });
		channel.value = 'sms';
		channel.dispatchEvent(new window.Event('change'));
		expect(subject.hidden).toBe(true);
		expect(await submit()).toBe(strings['send.later']);
		expect(bodies[1]).not.toHaveProperty('subject');
		expect(await submit()).toBe('The message was not sent: limited');
		expect(await submit()).toBe('The message was not sent: Enter an e-mail address.');
		expect(await submit()).toBe(strings['send.failed']);
	});

	it('staff push subscribes the ticket’s user', async () => {
		const host = place('staff_push_permission');
		pushBrowser();
		/** @type {unknown[]} */
		const sent = [];
		await startAdmin({
			'POST /v1/admin/push/subscriptions': (init) => {
				sent.push(JSON.parse(String(init?.body)));
				return answer(201, { subscriberId: 'sub_s' });
			},
		});
		expect(statusOf(host)).toBe(strings['staffPush.ask']);
		button(host, strings['staffPush.enable']).click();
		await flush();
		expect(sent).toHaveLength(1);
		expect(statusOf(host)).toBe(strings['staffPush.enabled']);
		expect(window.localStorage.getItem(SUBSCRIBER_STORAGE_KEY)).toBeNull();
	});

	it('widgets of switched-off features stay empty', async () => {
		const host = place('delivery_log');
		const staff = place('staff_push_permission');
		await startAdmin({}, ['email']);
		expect(host.shadowRoot).toBeNull();
		expect(staff.shadowRoot).toBeNull();
	});
});

describe('tickets', () => {
	it('are renewed a minute before they expire; a failed renewal signs the widgets out', async () => {
		vi.useFakeTimers();
		const now = Date.parse('2026-10-01T10:00:00Z');
		vi.setSystemTime(now);
		const getTicket = vi
			.fn()
			.mockResolvedValueOnce({ ticket: 't2', expiresAt: new Date(now + 30 * 60_000).toISOString() })
			.mockRejectedValueOnce(new Error('signed out'));
		const tickets = createTicketSource({
			first: { ticket: 't1', expiresAt: new Date(now + 15 * 60_000).toISOString() },
			getTicket,
			schedule: (task, ms) => /** @type {any} */ (setTimeout(task, ms)),
			cancel: (id) => clearTimeout(id),
			now: () => Date.now(),
		});
		/** @type {boolean[]} */
		const seen = [];
		const off = tickets.onChange((signedIn) => seen.push(signedIn));
		expect(tickets.current()).toBe('t1');
		await vi.advanceTimersByTimeAsync(15 * 60_000 - REFRESH_BEFORE_MS);
		expect(tickets.current()).toBe('t2');
		await vi.advanceTimersByTimeAsync(30 * 60_000);
		expect(tickets.current()).toBeNull();
		expect(seen).toEqual([true, false]);
		off();
		tickets.stop();
		const fetch = vi.fn();
		expect(await adminCall({ base: BASE, tickets, fetch }, 'GET', '/v1/admin/messages')).toEqual({
			ok: false,
			status: 0,
			data: null,
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it('a widget shows Signed out when the page cannot give a new ticket', async () => {
		vi.useFakeTimers();
		const host = place('delivery_log');
		serve({
			[`GET ${ADMIN_CONFIG_PATH}`]: () => answer(200, configOf(['send_api'])),
			'GET /v1/admin/messages': () => answer(200, { items: [], nextCursor: null, hasMore: false }),
		});
		const widget = startWidget({ window, script: script(null) });
		let calls = 0;
		await widget.admin({
			getTicket: async () => {
				calls += 1;
				if (calls > 1) throw new Error('signed out');
				return { ticket: 't', expiresAt: new Date(Date.now() + 2 * 60_000).toISOString() };
			},
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(statusOf(host)).toBe(strings['log.empty']);
		await vi.advanceTimersByTimeAsync(2 * 60_000);
		expect(statusOf(host)).toBe(strings['log.signedOut']);
		const fetch = vi.fn().mockRejectedValue(new Error('offline'));
		const source = createTicketSource({
			first: { ticket: 'x', expiresAt: new Date().toISOString() },
			getTicket: async () => ({ ticket: 'y', expiresAt: '' }),
			schedule: () => 0,
			cancel: () => {},
			now: () => 0,
		});
		expect(await adminCall({ base: BASE, tickets: source, fetch }, 'GET', '/x')).toEqual({ ok: false, status: 0, data: null });
	});
});
