// @vitest-environment jsdom
/* global document, window */
import { afterEach, describe, expect, it, vi } from 'vitest';
import strings from '../strings/en.json' with { type: 'json' };
import { WIDGET_ATTRIBUTE, WIDGET_GLOBAL } from '../core/widgets.js';
import { mountPayButton } from '../ui/pay-button.js';
import { mountPaymentsAdmin } from '../ui/payments-admin.js';
import { mountSubscriptionsAdmin } from '../ui/subscriptions-admin.js';
import { createTicketSource } from '../ui/tickets.js';
import { ADMIN_CONFIG_PATH, CONFIG_PATH, startWidget } from '../ui/widget.js';

const BASE = 'https://payments.example.dev';

/** @param {string[]} features */
const configOf = (features) => ({
	texts: { ...strings },
	theme: { mode: /** @type {const} */ ('light') },
	customCss: '',
	features,
});

/** @param {string} key @param {Record<string, string>} [data] */
const place = (key, data = {}) => {
	const host = document.createElement('div');
	host.setAttribute(WIDGET_ATTRIBUTE, key);
	for (const [name, value] of Object.entries(data)) host.dataset[name] = value;
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

const flush = async () => {
	for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** @param {number} status @param {unknown} [body] */
const answer = (status, body = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status });

/**
 * `window.fetch` answering by method and path (the query string is ignored).
 * @param {Record<string, (init: RequestInit | undefined, url: URL) => Response | Promise<Response>>} routes
 */
const serve = (routes) =>
	vi.spyOn(window, 'fetch').mockImplementation(async (input, init) => {
		const url = new URL(String(input));
		const route = routes[`${init?.method ?? 'GET'} ${url.pathname}`];
		return route ? route(init, url) : answer(404);
	});

/** @param {HTMLElement} host @param {string} selector */
const inside = (host, selector) => /** @type {any} */ (host.shadowRoot?.querySelector(selector));
/** @param {HTMLElement} host @param {string} text */
const button = (host, text) =>
	/** @type {HTMLButtonElement} */ (
		[...(host.shadowRoot?.querySelectorAll('button') ?? [])].find((b) => b.textContent === text)
	);
/** @param {HTMLElement} host */
const statusText = (host) => inside(host, '[role="status"]')?.textContent;

/** A ticket source with a fixed ticket (or none). @param {string | null} [ticket] */
const tickets = (ticket = 't1') => {
	/** @type {Set<(signedIn: boolean) => void>} */
	const listeners = new Set();
	return {
		current: () => ticket,
		onChange: (/** @type {(signedIn: boolean) => void} */ fn) => {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		stop: () => {},
		/** @param {boolean} value */
		emit: (value) => {
			for (const fn of listeners) fn(value);
		},
	};
};

const PAYMENT = {
	id: 'pay_1',
	status: 'paid',
	amount: 250000,
	currency: 'PKR',
	refunded: 0,
	gateway: 'bank_transfer',
	description: 'Order 1',
	reference: 'o-1',
	customer: { email: 'ana@example.com' },
	proof: { type: 'image/png', size: 10 },
	history: [
		{ at: '2026-10-01T10:00:00.000Z', event: 'created' },
		{ at: '2026-10-01T10:00:00.000Z', event: 'paid', detail: 'x', by: 'Sam' },
	],
	createdAt: '2026-10-01T10:00:00.000Z',
};

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('pay button', () => {
	it('mounts only with data-token while links or the payment API is on', async () => {
		const host = place('pay_button', { link: 'link_1' });
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
		expect(Object.keys(window)).toContain(WIDGET_GLOBAL);
	});

	it('shows a payment link and makes the payment', async () => {
		const host = place('pay_button', { link: 'link_1' });
		/** @type {any[]} */
		const posted = [];
		let reply = answer(422, { errors: [{ path: '/amount' }] });
		serve({
			[`GET ${CONFIG_PATH}`]: () => answer(200, configOf(['payment_links'])),
			'GET /v1/checkout/links/link_1': (init) => {
				expect(/** @type {any} */ (init).headers.authorization).toBe('Bearer browser-token');
				return answer(200, {
					id: 'link_1',
					title: 'Donate',
					description: 'Thanks',
					amount: null,
					minAmount: 500,
					currency: 'USD',
					gateways: [{ id: 'stripe', name: 'Card (Stripe)' }],
				});
			},
			'POST /v1/checkout/links/link_1': (init) => {
				posted.push(JSON.parse(String(init?.body)));
				return reply;
			},
		});
		const { ready } = startWidget({ window, script: script('browser-token') });
		await ready;
		expect(inside(host, 'h2').textContent).toBe('Donate');
		expect(host.shadowRoot?.textContent).toContain('At least USD 5.00');
		inside(host, '#ss-pay-amount').value = '1';
		inside(host, 'form').dispatchEvent(new window.Event('submit'));
		await flush();
		expect(statusText(host)).toBe('Enter an amount of at least USD 5.00.');
		expect(posted[0]).toEqual({ amount: '1', gateway: 'stripe', customer: { name: '', email: '' } });
		for (const [path, text] of [
			['/email', strings['link.invalidEmail']],
			['/gateway', strings['link.invalidMethod']],
			['/other', strings['button.failed']],
		]) {
			reply = answer(422, { errors: [{ path }] });
			inside(host, 'form').dispatchEvent(new window.Event('submit'));
			await flush();
			expect(statusText(host)).toBe(text);
		}
	});

	it('sends the payer on, and renders a fixed link, a payment and nothing for unknown ids', async () => {
		const go = vi.fn();
		/** @type {import('../ui/pay-button.js').VisitorCall} */
		const call = async (path, init) => {
			if (path === '/v1/checkout/links/link_2' && init?.method === 'POST')
				return { ok: true, status: 201, data: { checkoutUrl: 'https://p/pay/1' } };
			if (path === '/v1/checkout/links/link_2')
				return {
					ok: true,
					status: 200,
					data: { title: 'Invoice', description: '', amount: 1500, currency: 'PKR', gateways: [] },
				};
			if (path === '/v1/checkout/payments/pay_2')
				return {
					ok: true,
					status: 200,
					data: { status: 'pending', amount: 1000, currency: 'USD', description: 'Order 2', checkoutUrl: 'https://p/pay/2' },
				};
			if (path === '/v1/checkout/payments/pay_3')
				return { ok: true, status: 200, data: { status: 'paid', amount: 1000, currency: 'USD', description: '' } };
			return { ok: false, status: 404, data: null };
		};
		const config = configOf(['payment_links', 'payment_api']);
		const fixed = place('pay_button', { link: 'link_2' });
		await mountPayButton({ host: fixed, config, call, go });
		expect(fixed.shadowRoot?.textContent).toContain('PKR 15.00');
		expect(statusText(fixed)).toBe(strings['page.noGateway']);
		inside(fixed, 'form').dispatchEvent(new window.Event('submit'));
		await flush();
		expect(go).toHaveBeenCalledWith('https://p/pay/1');

		const pending = place('pay_button', { payment: 'pay_2' });
		await mountPayButton({ host: pending, config, call, go });
		expect(button(pending, 'Pay USD 10.00')).toBeTruthy();
		inside(pending, 'form').dispatchEvent(new window.Event('submit'));
		expect(go).toHaveBeenLastCalledWith('https://p/pay/2');
		const paid = place('pay_button', { payment: 'pay_3' });
		await mountPayButton({ host: paid, config, call, go });
		expect(inside(paid, '.amount').textContent).toBe('USD 10.00 · Paid');

		for (const data of /** @type {Array<Record<string, string>>} */ ([{ payment: 'pay_9' }, { link: 'bad id' }])) {
			const host = place('pay_button', data);
			await mountPayButton({ host, config, call, go });
			expect(host.shadowRoot).toBeNull();
		}
	});

	it('mounts a payment’s button through widget.js, which answers offline as not ok', async () => {
		const host = place('pay_button', { payment: 'pay_4' });
		serve({
			[`GET ${CONFIG_PATH}`]: () => answer(200, configOf(['payment_api'])),
			'GET /v1/checkout/payments/pay_4': () => answer(200, { status: 'pending', amount: 5, currency: 'JPY', description: '' }),
		});
		await startWidget({ window, script: script('browser-token') }).ready;
		expect(button(host, 'Pay JPY 5')).toBeTruthy();
		const offline = place('pay_button', { link: 'link_5' });
		vi.spyOn(window, 'fetch').mockImplementation(async (input) => {
			if (String(input).endsWith(CONFIG_PATH)) return answer(200, configOf(['payment_links']));
			throw new Error('offline');
		});
		await startWidget({ window, script: script('browser-token') }).ready;
		expect(offline.shadowRoot).toBeNull();
	});
});

describe('Payments admin widget', () => {
	/** @param {Record<string, (init: RequestInit | undefined, url: URL) => Response | Promise<Response>>} routes */
	const api = (routes) => {
		const fetch = vi.fn(async (/** @type {any} */ input, /** @type {any} */ init) => {
			const url = new URL(String(input));
			const route = routes[`${init?.method ?? 'GET'} ${url.pathname}`];
			return route ? route(init, url) : answer(404);
		});
		return { base: BASE, tickets: tickets(), fetch: /** @type {any} */ (fetch), calls: fetch };
	};

	it('lists, filters, pages and exports payments', async () => {
		const host = place('payments_admin');
		/** @type {string[]} */
		const queries = [];
		const client = api({
			'GET /v1/admin/payments': (_init, url) => {
				queries.push(url.search);
				const cursor = url.searchParams.get('cursor');
				return answer(200, {
					items: [cursor ? { ...PAYMENT, id: 'pay_2', refunded: 100, gateway: 'generic', customer: {} } : PAYMENT],
					nextCursor: cursor ? null : 'c1',
					hasMore: !cursor,
				});
			},
		});
		const save = vi.fn();
		mountPaymentsAdmin({ host, api: client, config: configOf(['payment_api']), save, open: vi.fn() });
		await flush();
		expect(host.shadowRoot?.querySelectorAll('li')).toHaveLength(1);
		expect(host.shadowRoot?.textContent).toContain('PKR 2,500.00 · Paid · o-1');
		button(host, strings['admin.more']).click();
		await flush();
		expect(host.shadowRoot?.textContent).toContain('Refunded PKR 1.00');
		inside(host, 'input').value = 'ana@example.com';
		inside(host, 'select').value = 'paid';
		inside(host, 'form').dispatchEvent(new window.Event('submit'));
		await flush();
		expect(queries.at(-1)).toContain('q=ana%40example.com');
		expect(queries.at(-1)).toContain('status=paid');
		inside(host, 'select').dispatchEvent(new window.Event('change'));
		await flush();
		button(host, strings['admin.export']).click();
		await flush();
		expect(save).toHaveBeenCalledTimes(1);
		const [name, csv] = save.mock.calls[0] ?? [];
		expect(name).toBe('payments.csv');
		expect(csv.split('\r\n')).toHaveLength(3);
		expect(queries.at(-1)).toContain('limit=100');
	});

	it('shows details: refunds, confirms a transfer, opens the proof', async () => {
		const host = place('payments_admin');
		const pending = { ...PAYMENT, id: 'pay_5', status: 'pending', proof: { type: 'image/png', size: 1 } };
		let refundReply = answer(422, { detail: 'Too much' });
		const open = vi.fn();
		const client = api({
			'GET /v1/admin/payments': () => answer(200, { items: [PAYMENT, pending], nextCursor: null, hasMore: false }),
			'GET /v1/admin/payments/pay_1': () => answer(200, PAYMENT),
			'GET /v1/admin/payments/pay_5': () => answer(200, pending),
			'POST /v1/admin/payments/pay_1/refunds': () => refundReply,
			'POST /v1/admin/payments/pay_5/confirm': () => answer(200, { ...pending, status: 'paid' }),
			'GET /v1/admin/payments/pay_5/proof': () => answer(200, { url: 'https://bucket/proof' }),
			'GET /v1/admin/payments/pay_1/proof': () => answer(404),
		});
		mountPaymentsAdmin({
			host,
			api: client,
			config: configOf(['payment_api', 'refunds', 'bank_transfer']),
			save: vi.fn(),
			open,
		});
		await flush();
		const [first, second] = /** @type {HTMLElement[]} */ ([...(host.shadowRoot?.querySelectorAll('ul > li') ?? [])]);
		/** @param {HTMLElement} item @param {string} text */
		const press = (item, text) => [...item.querySelectorAll('button')].find((b) => b.textContent === text)?.click();
		press(/** @type {HTMLElement} */ (first), strings['admin.open']);
		await flush();
		expect(first?.querySelector('.details')?.textContent).toContain('paid · x · Sam');
		const form = /** @type {HTMLFormElement} */ (first?.querySelector('.details form'));
		expect(/** @type {HTMLInputElement} */ (form.querySelector('input')).value).toBe('2500.00');
		form.dispatchEvent(new window.Event('submit'));
		await flush();
		expect(first?.querySelector('.details [role="status"]')?.textContent).toBe('Not refunded: Too much');
		refundReply = answer(201, { ...PAYMENT, status: 'refunded', refunded: 250000 });
		/** @type {HTMLInputElement} */ (form.querySelector('input')).value = 'abc';
		form.dispatchEvent(new window.Event('submit'));
		await flush();
		expect(first?.querySelector('.details [role="status"]')?.textContent).toBe(strings['admin.refundDone']);
		expect(first?.textContent).toContain('Refunded');
		press(/** @type {HTMLElement} */ (first), strings['admin.proof']);
		await flush();
		expect(first?.querySelector('.details [role="status"]')?.textContent).toBe(strings['admin.failed']);
		press(/** @type {HTMLElement} */ (first), strings['admin.close']);
		expect(first?.querySelector('.details')).toBeNull();

		press(/** @type {HTMLElement} */ (second), strings['admin.open']);
		await flush();
		press(/** @type {HTMLElement} */ (second), strings['admin.proof']);
		await flush();
		expect(open).toHaveBeenCalledWith('https://bucket/proof');
		press(/** @type {HTMLElement} */ (second), strings['admin.confirm']);
		await flush();
		expect(second?.querySelector('.details [role="status"]')?.textContent).toBe(strings['admin.confirmed']);
		expect(second?.textContent).toContain('Paid');
	});

	it('says when confirming fails, the list is empty or cannot load, and when signed out', async () => {
		const pending = { ...PAYMENT, id: 'pay_6', status: 'pending', proof: null };
		const host = place('payments_admin');
		let list = answer(200, { items: [pending], nextCursor: null, hasMore: false });
		const client = api({
			'GET /v1/admin/payments': () => list,
			'GET /v1/admin/payments/pay_6': () => answer(200, pending),
			'POST /v1/admin/payments/pay_6/confirm': () => answer(409, {}),
		});
		mountPaymentsAdmin({ host, api: client, config: configOf(['payment_api', 'bank_transfer']), save: vi.fn(), open: vi.fn() });
		await flush();
		const item = /** @type {HTMLElement} */ (host.shadowRoot?.querySelector('ul > li'));
		[...item.querySelectorAll('button')].find((b) => b.textContent === strings['admin.open'])?.click();
		await flush();
		[...item.querySelectorAll('button')].find((b) => b.textContent === strings['admin.confirm'])?.click();
		await flush();
		expect(item.querySelector('.details [role="status"]')?.textContent).toBe('Not confirmed: ');
		list = answer(200, { items: [], nextCursor: null, hasMore: false });
		inside(host, 'form').dispatchEvent(new window.Event('submit'));
		await flush();
		expect(statusText(host)).toBe(strings['admin.empty']);
		list = answer(500);
		inside(host, 'form').dispatchEvent(new window.Event('submit'));
		await flush();
		expect(statusText(host)).toBe(strings['admin.failed']);
		button(host, strings['admin.export']).click();
		await flush();
		expect(statusText(host)).toBe(strings['admin.failed']);
		/** @type {any} */ (client.tickets).emit(true);
		/** @type {any} */ (client.tickets).emit(false);
		expect(statusText(host)).toBe(strings['admin.signedOut']);

		const signedOut = place('payments_admin');
		mountPaymentsAdmin({
			host: signedOut,
			api: { ...client, tickets: tickets(null) },
			config: configOf(['payment_api']),
			save: vi.fn(),
			open: vi.fn(),
		});
		await flush();
		expect(statusText(signedOut)).toBe(strings['admin.signedOut']);
		const detailsFail = place('payments_admin');
		const failing = api({
			'GET /v1/admin/payments': () => answer(200, { items: [PAYMENT], nextCursor: null, hasMore: false }),
		});
		mountPaymentsAdmin({ host: detailsFail, api: failing, config: configOf(['payment_api']), save: vi.fn(), open: vi.fn() });
		await flush();
		button(detailsFail, strings['admin.open']).click();
		await flush();
		expect(statusText(detailsFail)).toBe(strings['admin.failed']);
	});
});

describe('Subscriptions admin widget', () => {
	it('lists subscriptions, cancels at the gateway and says what failed', async () => {
		const host = place('subscriptions_admin');
		const sub = {
			id: 'sub_1',
			status: 'active',
			gateway: 'stripe',
			plan: 'price_1',
			reference: '',
			customer: { email: 'a@b.co' },
			createdAt: '2026-10-01T10:00:00.000Z',
		};
		let cancel = answer(502, { detail: 'Stripe refused the keys.' });
		const fetch = vi.fn(async (/** @type {any} */ input, /** @type {any} */ init) => {
			const url = new URL(String(input));
			if (url.pathname === '/v1/admin/subscriptions')
				return url.searchParams.get('cursor')
					? answer(200, {
							items: [{ ...sub, id: 'sub_2', status: 'cancelled', customer: {} }],
							nextCursor: null,
							hasMore: false,
						})
					: answer(200, { items: [sub], nextCursor: 'c', hasMore: true });
			if (init?.method === 'POST') return cancel;
			return answer(404);
		});
		const source = tickets();
		mountSubscriptionsAdmin({
			host,
			api: { base: BASE, tickets: source, fetch: /** @type {any} */ (fetch) },
			config: configOf(['subscriptions']),
		});
		await flush();
		expect(host.shadowRoot?.textContent).toContain('Active · price_1');
		button(host, strings['subs.cancel']).click();
		await flush();
		expect(statusText(host)).toBe('Not cancelled: Stripe refused the keys.');
		cancel = answer(200, { ...sub, status: 'cancelled' });
		button(host, strings['subs.cancel']).click();
		await flush();
		expect(statusText(host)).toBe(strings['subs.cancelled']);
		expect(button(host, strings['subs.cancel'])).toBeUndefined();
		button(host, strings['subs.more']).click();
		await flush();
		expect(host.shadowRoot?.querySelectorAll('ul > li')).toHaveLength(2);
		source.emit(true);
		source.emit(false);
		expect(statusText(host)).toBe(strings['subs.signedOut']);
	});

	it('says when there are none, when they cannot load and when signed out', async () => {
		const empty = place('subscriptions_admin');
		const fetch = vi.fn(async () => answer(200, { items: [], nextCursor: null, hasMore: false }));
		mountSubscriptionsAdmin({
			host: empty,
			api: { base: BASE, tickets: tickets(), fetch: /** @type {any} */ (fetch) },
			config: configOf(['subscriptions']),
		});
		await flush();
		expect(statusText(empty)).toBe(strings['subs.empty']);
		const failing = place('subscriptions_admin');
		mountSubscriptionsAdmin({
			host: failing,
			api: { base: BASE, tickets: tickets(), fetch: /** @type {any} */ (vi.fn(async () => answer(500))) },
			config: configOf(['subscriptions']),
		});
		await flush();
		expect(statusText(failing)).toBe(strings['subs.failed']);
		const out = place('subscriptions_admin');
		mountSubscriptionsAdmin({
			host: out,
			api: { base: BASE, tickets: tickets(null), fetch: /** @type {any} */ (fetch) },
			config: configOf(['subscriptions']),
		});
		await flush();
		expect(statusText(out)).toBe(strings['subs.signedOut']);
	});
});

describe('admin widgets through widget.js', () => {
	it('mounts the admin widgets of switched-on features with a ticket', async () => {
		const payments = place('payments_admin');
		const subscriptions = place('subscriptions_admin');
		serve({
			[`GET ${ADMIN_CONFIG_PATH}`]: (init) => {
				expect(/** @type {any} */ (init).headers.authorization).toBe('Bearer t1');
				return answer(200, configOf(['payment_api']));
			},
			'GET /v1/admin/payments': () => answer(200, { items: [], nextCursor: null, hasMore: false }),
		});
		const { admin } = startWidget({ window, script: script(null) });
		await admin({ getTicket: async () => ({ ticket: 't1', expiresAt: new Date(Date.now() + 900_000).toISOString() }) });
		await flush();
		expect(statusText(payments)).toBe(strings['admin.empty']);
		expect(subscriptions.shadowRoot).toBeNull();
		await admin({
			getTicket: async () => {
				throw new Error('no');
			},
		});
		await admin({ getTicket: async () => /** @type {any} */ ({}) });
		vi.spyOn(window, 'fetch').mockImplementation(async () => answer(403));
		await admin({ getTicket: async () => ({ ticket: 't1', expiresAt: new Date().toISOString() }) });
		expect(subscriptions.shadowRoot).toBeNull();
	});

	it('mounts the subscriptions admin, and the ticket source renews', async () => {
		const host = place('subscriptions_admin');
		serve({
			[`GET ${ADMIN_CONFIG_PATH}`]: () => answer(200, configOf(['subscriptions', 'payment_api'])),
			'GET /v1/admin/subscriptions': () => answer(200, { items: [], nextCursor: null, hasMore: false }),
		});
		await startWidget({ window, script: script(null) }).admin({
			getTicket: async () => ({ ticket: 't1', expiresAt: new Date(Date.now() + 900_000).toISOString() }),
		});
		await flush();
		expect(statusText(host)).toBe(strings['subs.empty']);
		/** @type {Array<() => void>} */
		const scheduled = [];
		const source = createTicketSource({
			first: { ticket: 'a', expiresAt: '2026-10-01T10:15:00.000Z' },
			getTicket: async () => ({ ticket: 'b', expiresAt: '2026-10-01T10:30:00.000Z' }),
			schedule: (task) => scheduled.push(task),
			cancel: () => {},
			now: () => Date.parse('2026-10-01T10:00:00.000Z'),
		});
		scheduled[0]?.();
		await flush();
		expect(source.current()).toBe('b');
	});
});
