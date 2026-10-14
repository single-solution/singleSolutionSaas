// @vitest-environment jsdom
/* global document, window */
import { afterEach, describe, expect, it, vi } from 'vitest';
import strings from '../strings/en.json' with { type: 'json' };
import { SUBSCRIBED_EVENT, SUBSCRIBER_STORAGE_KEY, WIDGET_ATTRIBUTE, WIDGET_GLOBAL } from '../core/widgets.js';
import { BUTTON_TYPES } from '../core/templates.js';
import { CHANNELS } from '../core/channels.js';
import { STATUSES } from '../core/log.js';
import { codeOf, logReason, notSentText, problemText } from '../ui/problems.js';
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
 * A problem answer as the server sends it (its English detail must never show).
 * @param {number} status @param {string} code @param {string} [field] the field a validation names
 */
const refusal = (status, code, field) =>
	answer(status, {
		type: `https://notifications.example.dev/problems/${code}`,
		detail: 'English words from the server.',
		...(field ? { errors: [{ path: `/${field}/0`, message: 'English words from the server.', code: 'invalid' }] } : {}),
	});

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

	it('the delivery log counts by status, finds a recipient and opens a message to every attempt', async () => {
		const host = place('delivery_log');
		/** @type {URL[]} */
		const counted = [];
		/** @type {URL[]} */
		const listed = [];
		const message = {
			id: 'msg_1',
			template: 'accounts.code',
			source: 'api',
			channel: 'whatsapp',
			to: '+447700900123',
			status: 'sent',
			reason: null,
			subject: '',
			text: '482913 is your code.',
			attempts: [
				{ channel: 'whatsapp', provider: 'meta', at: '2026-10-01T10:00:00.000Z', outcome: 'failed', error: 'HTTP 503' },
				{ channel: 'whatsapp', provider: 'meta', at: '2026-10-01T10:05:00.000Z', outcome: 'sent' },
			],
			dueAt: '2026-10-01T10:05:00.000Z',
			sentAt: '2026-10-01T10:05:00.000Z',
			createdAt: '2026-10-01T10:00:00.000Z',
		};
		await startAdmin({
			'GET /v1/admin/messages/counts': (init, url) => {
				counted.push(url);
				return url.searchParams.get('to') === 'nobody'
					? answer(500)
					: answer(200, { total: 3, groups: { sent: 2, failed: 1 } });
			},
			'GET /v1/admin/messages': (init, url) => {
				listed.push(url);
				return answer(200, { items: [message], nextCursor: null, hasMore: false });
			},
		});
		const [status] = /** @type {HTMLSelectElement[]} */ ([...(host.shadowRoot?.querySelectorAll('select') ?? [])]);
		const options = () => [...(status?.querySelectorAll('option') ?? [])].map((option) => option.textContent);
		expect(options()).toEqual(['All (3)', 'Waiting (0)', 'Retrying (0)', 'Sent (2)', 'Failed (1)', 'Not sent (0)']);
		expect(inside(host, '.count').textContent).toBe('3 messages');
		expect(counted[0]?.searchParams.get('by')).toBe('status');
		/** @type {HTMLSelectElement} */ (status).value = 'failed';
		status?.dispatchEvent(new window.Event('change'));
		await flush();
		expect(inside(host, '.count').textContent).toBe('1 messages');
		expect(counted.at(-1)?.searchParams.has('status')).toBe(false);
		const to = /** @type {HTMLInputElement} */ (inside(host, 'input[type="search"]'));
		to.value = ' +447700900123 ';
		to.dispatchEvent(new window.Event('change'));
		await flush();
		expect(listed.at(-1)?.searchParams.get('to')).toBe('+447700900123');
		expect(counted.at(-1)?.searchParams.get('to')).toBe('+447700900123');
		const details = inside(host, 'details');
		expect(details.querySelector('summary').textContent).toContain('+447700900123 · accounts.code');
		const shown = [...details.querySelectorAll('dt')].map((dt, i) => [
			dt.textContent,
			details.querySelectorAll('dd')[i].textContent,
		]);
		expect(shown).toEqual([
			[strings['log.text'], '482913 is your code.'],
			[strings['log.source'], strings['log.source.api']],
			[strings['log.sentAt'], expect.any(String)],
			[strings['log.attemptList'], expect.stringContaining('WhatsApp · meta · failed · HTTP 503\n')],
			[strings['log.id'], 'msg_1'],
		]);
		// counts that cannot be read leave the badges as they were and no total
		to.value = 'nobody';
		to.dispatchEvent(new window.Event('change'));
		await flush();
		expect(inside(host, '.count').textContent).toBe('');
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
					timeZone: 'Asia/Tokyo',
				}),
			'GET /v1/admin/messages': () => answer(200, { items: [message], nextCursor: null, hasMore: false }),
		});
		const widget = startWidget({ window, script: script(null) });
		await widget.admin({ getTicket: async () => TICKET });
		await flush();
		expect(inside(host, '.meta').textContent).toBe('Email · Sent · 1 attempt · 1 Oct 2026, 19:00');
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
				sensitive: true,
				providerTemplate: '',
			},
		];
		await startAdmin({
			'GET /v1/admin/templates': () => answer(200, { items }),
			'PUT /v1/admin/templates': (init) => {
				const body = JSON.parse(String(init?.body));
				saved.push(body);
				return body.text === '' ? refusal(422, 'validation_failed', 'text') : answer(200, body);
			},
			'DELETE /v1/admin/templates/welcome/sms/de': () => {
				items = [];
				return answer(204);
			},
			'DELETE /v1/admin/templates/x/email/default': () => refusal(404, 'not_found'),
		});
		const pick = /** @type {HTMLButtonElement} */ (inside(host, 'li button'));
		expect(pick.textContent).toBe('welcome · Email · Default');
		pick.click();
		const fields = /** @type {any[]} */ ([...(host.shadowRoot?.querySelectorAll('input, select, textarea') ?? [])]);
		const [key, channel, language, subject, text, required, urgent, sensitive] = fields;
		expect([key.value, channel.value, subject.value, text.value, urgent.checked, required.checked, sensitive.checked]).toEqual([
			'welcome',
			'email',
			'Hi',
			'Hello',
			true,
			false,
			true,
		]);
		channel.value = 'sms';
		language.value = 'de';
		const form = /** @type {HTMLFormElement} */ (inside(host, 'form'));
		form.dispatchEvent(new window.Event('submit', { cancelable: true }));
		await flush();
		expect(saved[0]).toMatchObject({ key: 'welcome', channel: 'sms', language: 'de', urgent: true, sensitive: true });
		expect(statusOf(host)).toBe(strings['templates.saved']);
		text.value = '';
		form.dispatchEvent(new window.Event('submit', { cancelable: true }));
		await flush();
		expect(statusOf(host)).toBe(`This could not be saved: ${strings['problem.field.text']}`);
		button(host, strings['templates.delete']).click();
		await flush();
		expect(statusOf(host)).toBe(strings['templates.deleted']);
		expect(inside(host, 'li').textContent).toBe(strings['templates.empty']);
		key.value = 'x';
		button(host, strings['templates.delete']).click();
		await flush();
		expect(statusOf(host)).toBe(`This could not be deleted: ${strings['problem.not_found']}`);
		button(host, strings['templates.new']).click();
		expect(key.value).toBe('');
	});

	it('the template editor edits the buttons of a WhatsApp template at Meta (PLAN 0.8.10 N1)', async () => {
		const host = place('template_editor');
		/** @type {any[]} */
		const saved = [];
		const items = [
			{
				key: 'accounts.code',
				channel: 'whatsapp',
				language: 'default',
				subject: '',
				text: '{code} is your code.',
				required: true,
				urgent: true,
				providerTemplate: 'authentication',
				buttons: [{ index: 0, type: 'copy_code', value: '{code}' }],
			},
		];
		await startAdmin({
			'GET /v1/admin/templates': () => answer(200, { items }),
			'PUT /v1/admin/templates': (init) => {
				saved.push(JSON.parse(String(init?.body)));
				return answer(200, saved.at(-1));
			},
		});
		const box = inside(host, '.buttons');
		expect(box.hidden).toBe(true);
		/** @type {HTMLButtonElement} */ (inside(host, 'li button')).click();
		expect(box.hidden).toBe(false);
		const rowFields = () => [...box.querySelectorAll('.row')].map((row) => [...row.querySelectorAll('input, select')]);
		expect(rowFields().map((fields) => fields.map((input) => input.value))).toEqual([['0', 'copy_code', '{code}']]);
		const add = button(host, strings['templates.addButton']);
		add.click();
		const [, second] = rowFields();
		expect(second?.map((input) => input.value)).toEqual(['1', 'copy_code', '']);
		if (!second) return;
		const [, type, value] = second;
		type.value = 'url';
		value.value = 'orders/{order}';
		const form = /** @type {HTMLFormElement} */ (inside(host, 'form'));
		form.dispatchEvent(new window.Event('submit', { cancelable: true }));
		await flush();
		expect(saved[0].buttons).toEqual([
			{ index: 0, type: 'copy_code', value: '{code}' },
			{ index: 1, type: 'url', value: 'orders/{order}' },
		]);
		// removing a row frees its place; ten buttons at most
		/** @type {HTMLButtonElement} */ (
			[...box.querySelectorAll('button')].find((b) => b.textContent === strings['templates.removeButton'])
		).click();
		expect(rowFields()).toHaveLength(1);
		for (let i = 0; i < 9; i += 1) add.click();
		expect(rowFields()).toHaveLength(10);
		expect(add.disabled).toBe(true);
		// another channel has no buttons: hidden and sent as none
		const channel = /** @type {HTMLSelectElement} */ (host.shadowRoot?.querySelectorAll('select')[0]);
		channel.value = 'sms';
		channel.dispatchEvent(new window.Event('change'));
		expect(box.hidden).toBe(true);
		form.dispatchEvent(new window.Event('submit', { cancelable: true }));
		await flush();
		expect(saved[1].buttons).toEqual([]);
		button(host, strings['templates.new']).click();
		expect(rowFields()).toHaveLength(0);
	});

	it('the template editor previews the words with samples and sends the saved template as a test', async () => {
		const host = place('template_editor');
		/** @type {any[]} */
		const sends = [];
		const items = [
			{
				key: 'ecommerce.order_status',
				channel: 'email',
				language: 'default',
				subject: 'Order {order}',
				text: 'Order {order} is {status}.{?reason} Reason: {reason}{/reason} {unsubscribeUrl}',
				required: false,
				urgent: false,
				providerTemplate: '',
			},
		];
		await startAdmin({
			'GET /v1/admin/templates': () => answer(200, { items }),
			'POST /v1/admin/messages': (init) => {
				sends.push(JSON.parse(String(init?.body)));
				return sends.length === 1 ? answer(201, { status: 'sent' }) : refusal(422, 'template_not_found');
			},
		});
		/** @type {HTMLButtonElement} */ (inside(host, 'li button')).click();
		const samples = () =>
			/** @type {HTMLInputElement[]} */ ([...(host.shadowRoot?.querySelectorAll('input[data-name]') ?? [])]);
		expect(samples().map((input) => input.dataset.name)).toEqual(['order', 'status', 'reason']);
		const preview = () => inside(host, '.preview').textContent;
		expect(preview()).toBe(`Order {order}Order {order} is {status}. ${strings['templates.sampleUnsubscribe']}`);
		const [order, status, reason] = samples();
		for (const [input, value] of /** @type {const} */ ([
			[order, 'SH-2026-0044'],
			[status, 'canceled'],
			[reason, 'Out of stock'],
		])) {
			/** @type {HTMLInputElement} */ (input).value = value;
			input?.dispatchEvent(new window.Event('input'));
		}
		expect(preview()).toBe(
			`Order SH-2026-0044Order SH-2026-0044 is canceled. Reason: Out of stock ${strings['templates.sampleUnsubscribe']}`,
		);
		// the samples stay while the words change
		const text = /** @type {HTMLTextAreaElement} */ (inside(host, 'textarea'));
		text.value = 'Order {order}: {status}';
		text.dispatchEvent(new window.Event('input'));
		expect(samples().map((input) => input.value)).toEqual(['SH-2026-0044', 'canceled']);
		const to = /** @type {HTMLInputElement} */ (
			[...(host.shadowRoot?.querySelectorAll('input') ?? [])].find((input) => input.getAttribute('autocomplete') === 'off')
		);
		to.value = 'me@shop.example.com';
		button(host, strings['templates.testSend']).click();
		await flush();
		expect(sends[0]).toEqual({
			channel: 'email',
			to: 'me@shop.example.com',
			template: 'ecommerce.order_status',
			language: 'default',
			values: { order: 'SH-2026-0044', status: 'canceled' },
		});
		expect(statusOf(host)).toBe('Test: Sent');
		button(host, strings['templates.testSend']).click();
		await flush();
		expect(statusOf(host)).toBe(`The test was not sent: ${strings['problem.template_not_found']}`);
		// push templates have no test send; a WhatsApp template at Meta previews its buttons
		const channel = /** @type {HTMLSelectElement} */ (host.shadowRoot?.querySelectorAll('select')[0]);
		channel.value = 'push';
		channel.dispatchEvent(new window.Event('change'));
		expect(to.parentElement?.hidden).toBe(true);
		channel.value = 'whatsapp';
		channel.dispatchEvent(new window.Event('change'));
		const name = /** @type {HTMLInputElement} */ (
			[...(host.shadowRoot?.querySelectorAll('input') ?? [])].find((input) => input.getAttribute('maxlength') === '512')
		);
		name.value = 'order_update';
		name.dispatchEvent(new window.Event('input'));
		button(host, strings['templates.addButton']).click();
		const value = /** @type {HTMLInputElement} */ (inside(host, '.buttons .row input[maxlength="2000"]'));
		value.value = 'orders/{order}';
		value.dispatchEvent(new window.Event('input', { bubbles: true }));
		expect(preview()).toContain('Button 0 (Copy code): orders/SH-2026-0044');
		button(host, strings['templates.removeButton']).click();
		expect(preview()).not.toContain('Button 0');
	});

	it('the template editor says when the list cannot be loaded', async () => {
		const host = place('template_editor');
		await startAdmin({ 'GET /v1/admin/templates': () => answer(500) });
		expect(statusOf(host)).toBe(`The templates could not be loaded: ${strings['problem.failed']}`);
	});

	it('send a message: picks channels of switched-on features and reports the outcome', async () => {
		const host = place('send_message');
		/** @type {any[]} */
		const bodies = [];
		const outcomes = [
			answer(201, { status: 'sent' }),
			answer(201, { status: 'queued' }),
			answer(201, { status: 'skipped', reason: 'limited' }),
			answer(201, { status: 'failed', reason: 'The provider answered HTTP 401.' }),
			refusal(422, 'validation_failed', 'to'),
			refusal(429, 'rate_limited'),
			answer(500, {}),
			new Error('offline'),
		];
		await startAdmin({
			'POST /v1/admin/messages': (init) => {
				bodies.push(JSON.parse(String(init?.body)));
				const next = outcomes.shift();
				if (next instanceof Error) throw next;
				return /** @type {Response} */ (next);
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
		// why it was not sent, in the website's words: never the server's English
		expect(await submit()).toBe(`The message was not sent: ${strings['reason.limited']}`);
		expect(await submit()).toBe(`The message was not sent: ${strings['reason.failed']}`);
		expect(await submit()).toBe(`The message was not sent: ${strings['problem.field.to']}`);
		expect(await submit()).toBe(`The message was not sent: ${strings['problem.rate_limited']}`);
		expect(await submit()).toBe(`The message was not sent: ${strings['problem.failed']}`);
		expect(await submit()).toBe(`The message was not sent: ${strings['problem.offline']}`);
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
		const editor = place('template_editor');
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
		/** @type {HTMLFormElement} */ (inside(editor, 'form')).dispatchEvent(new window.Event('submit', { cancelable: true }));
		await vi.advanceTimersByTimeAsync(0);
		expect(statusOf(editor)).toBe(strings['templates.signedOut']);
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

describe('admin widget texts (PLAN 0.4.10)', () => {
	it('every text a widget names after a code exists, so no text key ever shows', () => {
		const keys = [
			...CHANNELS.map((channel) => `channel.${channel}`),
			...STATUSES.map((status) => `status.${status}`),
			...BUTTON_TYPES.map((type) => `templates.buttonType.${type}`),
			...['api', 'staff'].map((source) => `log.source.${source}`),
			...['sent', 'failed'].map((outcome) => `log.outcome.${outcome}`),
			...['unsubscribed', 'limited', 'switched_off', 'failed'].map((reason) => `reason.${reason}`),
			// the fields the admin routes refuse (PUT /v1/admin/templates, POST /v1/admin/messages)
			...['key', 'channel', 'language', 'subject', 'text', 'providerTemplate', 'buttons', 'to', 'template', 'values'].map(
				(field) => `problem.field.${field}`,
			),
			...['offline', 'invalid_token', 'forbidden', 'not_found', 'template_not_found', 'validation_failed', 'failed'].map(
				(code) => `problem.${code}`,
			),
		];
		expect(keys.filter((key) => !Object.hasOwn(strings, key))).toEqual([]);
	});

	it('a refusal shows the text for its field, else for its code, else a general one; never the server’s detail', () => {
		/** @param {string} code @param {unknown} [errors] */
		const refused = (code, errors) => ({
			status: 422,
			data: { type: `https://x.example/problems/${code}`, detail: 'English', errors },
		});
		expect(problemText(strings, { status: 0, data: null })).toBe(strings['problem.offline']);
		expect(problemText(strings, refused('validation_failed', [{ path: '/buttons/0/index' }]))).toBe(
			strings['problem.field.buttons'],
		);
		expect(problemText(strings, refused('validation_failed', [{ path: '/unknown' }]))).toBe(
			strings['problem.validation_failed'],
		);
		expect(problemText(strings, refused('validation_failed'))).toBe(strings['problem.validation_failed']);
		expect(problemText(strings, refused('template_not_found'))).toBe(strings['problem.template_not_found']);
		expect(problemText(strings, refused('teapot'))).toBe(strings['problem.failed']);
		expect(problemText(strings, { status: 500, data: null })).toBe(strings['problem.failed']);
		expect(problemText({}, { status: 500, data: {} })).toBe('');
		expect(codeOf({ status: 403, data: { type: 'https://x.example/problems/forbidden' } })).toBe('forbidden');
	});

	it('a message that was not sent says why in the website’s words; the log keeps a provider’s error as it came', () => {
		expect(notSentText(strings, { status: 'skipped', reason: 'unsubscribed' })).toBe(strings['reason.unsubscribed']);
		expect(notSentText(strings, { status: 'failed', reason: 'The provider answered HTTP 401.' })).toBe(
			strings['reason.failed'],
		);
		expect(notSentText({}, { status: 'failed' })).toBe('');
		expect(logReason(strings, { reason: 'limited' })).toBe(strings['reason.limited']);
		// a product's message the merchant switched off on its channel (parity P1)
		expect(notSentText(strings, { status: 'skipped', reason: 'switched_off' })).toBe(strings['reason.switched_off']);
		expect(logReason(strings, { reason: 'switched_off' })).toBe(strings['reason.switched_off']);
		expect(logReason(strings, { reason: 'The provider answered HTTP 401.' })).toBe('The provider answered HTTP 401.');
		expect(logReason(strings, { reason: null })).toBe('');
		expect(logReason({}, { reason: 'unsubscribed' })).toBe('unsubscribed');
	});
});
