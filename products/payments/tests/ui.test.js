// @vitest-environment jsdom
/* global document, window */
import { afterEach, describe, expect, it, vi } from 'vitest';
import manifest from '../manifest.json' with { type: 'json' };
import strings from '../strings/en.json' with { type: 'json' };
import { WIDGET_ATTRIBUTE, WIDGET_GLOBAL } from '../core/widgets.js';
import { mountLinksAdmin } from '../ui/links-admin.js';
import { mountPayButton } from '../ui/pay-button.js';
import { mountPaymentsAdmin } from '../ui/payments-admin.js';
import { mountSubscriptionsAdmin } from '../ui/subscriptions-admin.js';
import { ADMIN_CONFIG_PATH, CONFIG_PATH, startWidget } from '../ui/widget.js';
import { PAY_SCRIPT, renderManualPage } from '../server/pages.js';

const BASE = 'https://payments.example.dev';

/**
 * A widget config as the kit answers it (PLAN 0.8.10 K7: with the website's Format and business time zone; the widgets
 * whose feature is on).
 * @param {string[]} features
 * @param {{ format?: Record<string, unknown>, timeZone?: string }} [look]
 */
const configOf = (features, { format = {}, timeZone = 'UTC' } = {}) => ({
	texts: { ...strings },
	theme: { mode: /** @type {const} */ ('light') },
	customCss: '',
	format,
	timeZone,
	features,
	widgets: manifest.widgets
		.filter((widget) => [widget.feature].flat().some((key) => features.includes(key)))
		.map((widget) => widget.key),
});

/** A custom Format: "US$ 12,500" and "1 Oct 2026, 19:00" in the business time zone (Tokyo, UTC+9). */
const CUSTOM_LOOK = {
	format: { locale: 'en-GB', currencyDisplay: 'custom', currencySymbol: 'US$', wholeUnits: true, times: 'business' },
	timeZone: 'Asia/Tokyo',
};

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
	currency: 'USD',
	refunded: 0,
	gateway: 'bank_transfer',
	kind: 'pay_first',
	methodName: 'Bank transfer',
	description: 'Order 1',
	reference: 'o-1',
	customer: { email: 'ana@example.com' },
	metadata: {},
	proof: { type: 'image/png', size: 10 },
	refunds: [],
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
		expect(posted[0]).toEqual({ amount: '1.00', gateway: 'stripe', customer: { name: '', email: '' } });
		// the shown decimal sign or a comma that cannot be a thousands separator; the API gets a plain decimal (P6)
		inside(host, '#ss-pay-amount').value = '12,5';
		inside(host, 'form').dispatchEvent(new window.Event('submit'));
		await flush();
		expect(posted[1]).toMatchObject({ amount: '12.50' });
		inside(host, '#ss-pay-amount').value = '1,250';
		inside(host, 'form').dispatchEvent(new window.Event('submit'));
		await flush();
		expect(posted).toHaveLength(2);
		expect(statusText(host)).toBe('Enter an amount of at least USD 5.00.');
		inside(host, '#ss-pay-amount').value = '10';
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
					data: { title: 'Invoice', description: '', amount: 1500, currency: 'USD', gateways: [] },
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
		expect(fixed.shadowRoot?.textContent).toContain('USD 15.00');
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

	it('shows no Pay button for a payment the merchant canceled (K-13)', async () => {
		/** @type {import('../ui/pay-button.js').VisitorCall} */
		const call = async () => ({
			ok: true,
			status: 200,
			data: { status: 'voided', amount: 1000, currency: 'USD', description: '', checkoutUrl: 'https://p/pay/4' },
		});
		const host = place('pay_button', { payment: 'pay_4' });
		await mountPayButton({ host, config: configOf(['payment_api']), call, go: vi.fn() });
		expect(inside(host, '.amount').textContent).toBe(`USD 10.00 · ${strings['button.voided']}`);
		expect(host.shadowRoot?.querySelector('button')).toBeNull();
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

	it('shows amounts in the website’s Format from the widget config', async () => {
		const host = place('pay_button', { link: 'link_6' });
		serve({
			[`GET ${CONFIG_PATH}`]: () => answer(200, configOf(['payment_links'], CUSTOM_LOOK)),
			'GET /v1/checkout/links/link_6': () =>
				answer(200, {
					title: 'Invoice',
					description: '',
					amount: null,
					minAmount: 50000,
					currency: 'USD',
					gateways: [{ id: 'stripe', name: 'Card (Stripe)' }],
				}),
			'POST /v1/checkout/links/link_6': () => answer(422, { errors: [{ path: '/amount' }] }),
		});
		await startWidget({ window, script: script('browser-token') }).ready;
		expect(host.shadowRoot?.textContent).toContain('At least US$ 500');
		inside(host, 'form').dispatchEvent(new window.Event('submit'));
		await flush();
		expect(statusText(host)).toBe('Enter an amount of at least US$ 500.');
		const fixed = place('pay_button', { payment: 'pay_6' });
		await mountPayButton({
			host: fixed,
			config: configOf(['payment_api'], CUSTOM_LOOK),
			call: async () => ({
				ok: true,
				status: 200,
				data: { status: 'paid', amount: 1250050, currency: 'USD', description: '' },
			}),
			go: vi.fn(),
		});
		expect(inside(fixed, '.amount').textContent).toBe('US$ 12,501 · Paid');
	});
});

/** A fake admin API answering by method and path. @param {Record<string, (init: any, url: URL) => Response | Promise<Response>>} routes @param {ReturnType<typeof tickets>} [source] */
const adminApi = (routes, source = tickets()) => {
	const fetch = vi.fn(async (/** @type {any} */ input, /** @type {any} */ init) => {
		const url = new URL(String(input));
		const route = routes[`${init?.method ?? 'GET'} ${url.pathname}`];
		return route ? route(init, url) : answer(404);
	});
	return { base: BASE, tickets: source, fetch: /** @type {any} */ (fetch), calls: fetch };
};
/** @param {HTMLElement} host @param {string} text */
const menuItem = (host, text) => {
	inside(host, '.detail-pane [aria-haspopup="menu"]').click();
	const item = /** @type {HTMLButtonElement | undefined} */ (
		[...(host.shadowRoot?.querySelectorAll('[role="menuitem"]') ?? [])].find((b) => b.textContent === text)
	);
	return item;
};
/** @param {HTMLElement} host */
const dialog = (host) => /** @type {HTMLFormElement | null} */ (host.shadowRoot?.querySelector('.dialog') ?? null);
/** @param {HTMLElement} host */
const submitDialog = async (host) => {
	dialog(host)?.dispatchEvent(new window.Event('submit', { cancelable: true }));
	await flush();
};
/** @param {HTMLElement} host */
const detailText = (host) => inside(host, '.detail-pane')?.textContent ?? '';
/** @param {HTMLElement} host */
const detailStatus = (host) => inside(host, '.detail-pane [role="status"]')?.textContent;
/** @param {HTMLElement} host */
const rows = (host) => /** @type {HTMLElement[]} */ ([...(host.shadowRoot?.querySelectorAll('li.item') ?? [])]);

describe('Payments admin widget', () => {
	it('lists, filters with counts, pages and exports payments', async () => {
		const host = place('payments_admin');
		/** @type {string[]} */
		const queries = [];
		const client = adminApi({
			'GET /v1/admin/payments': (_init, url) => {
				queries.push(url.search);
				const cursor = url.searchParams.get('cursor');
				return answer(200, {
					items: [cursor ? { ...PAYMENT, id: 'pay_2', refunded: 100, gateway: 'generic', customer: {} } : PAYMENT],
					nextCursor: cursor ? null : 'c1',
					hasMore: !cursor,
				});
			},
			'GET /v1/admin/payments/counts': (_init, url) =>
				url.searchParams.get('by') === 'state'
					? answer(200, { total: 2, groups: { paid: 1, partially_refunded: 1 } })
					: answer(200, { total: 2, groups: { bank_transfer: 1, generic: 1, none: 0 } }),
			'GET /v1/admin/payments/pay_1': () => answer(200, PAYMENT),
		});
		const save = vi.fn();
		mountPaymentsAdmin({ host, api: client, config: configOf(['payment_api']), save, open: vi.fn() });
		await flush();
		expect(rows(host)).toHaveLength(1);
		expect(rows(host)[0]?.textContent).toContain('o-1');
		expect(rows(host)[0]?.textContent).toContain('USD 2,500.00');
		expect(rows(host)[0]?.getAttribute('aria-current')).toBe('true');
		expect(inside(host, 'h2 .badge').textContent).toBe('2');
		const options = [...inside(host, 'select').options].map((option) => option.textContent);
		expect(options).toContain('All (2)');
		expect(options).toContain('Paid (1)');
		expect(options).toContain('Failed (0)');
		// a manual method's key (its name is on each payment), a gateway's name
		expect(inside(host, 'p.meta').textContent).toBe('bank_transfer 1 · generic 1');
		button(host, strings['admin.more']).click();
		await flush();
		expect(host.shadowRoot?.textContent).toContain('Refunded USD 1.00');
		inside(host, 'input').value = 'ana@example.com';
		inside(host, 'select').value = 'paid';
		inside(host, 'form').dispatchEvent(new window.Event('submit'));
		await flush();
		expect(queries.at(-1)).toContain('q=ana%40example.com');
		expect(queries.at(-1)).toContain('status=paid');
		expect(inside(host, 'select').value).toBe('paid');
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

	it('shows amounts and times in the website’s Format and time zone; the CSV keeps stored values', async () => {
		const host = place('payments_admin');
		const client = adminApi({
			'GET /v1/admin/payments': () =>
				answer(200, { items: [{ ...PAYMENT, refunded: 50000 }], nextCursor: null, hasMore: false }),
			'GET /v1/admin/payments/pay_1': () => answer(200, PAYMENT),
		});
		const save = vi.fn();
		mountPaymentsAdmin({ host, api: client, config: configOf(['payment_api'], CUSTOM_LOOK), save, open: vi.fn() });
		await flush();
		const text = rows(host)[0]?.textContent ?? '';
		expect(text).toContain('US$ 2,500');
		expect(text).toContain('1 Oct 2026, 19:00');
		expect(text).toContain('Refunded US$ 500');
		expect(inside(host, '.detail-pane .sub li').textContent).toBe('1 Oct 2026, 19:00 · created');
		expect(inside(host, 'p.meta').hasAttribute('hidden')).toBe(true);
		button(host, strings['admin.export']).click();
		await flush();
		const [, csv] = save.mock.calls[0] ?? [];
		// the CSV: labels from the texts, plain decimals and the currency in its own column (P8)
		expect(csv.split('\r\n')[0]).toBe('\uFEFFPayment,Date,Status,Amount,Currency,Refunded,Gateway,Reference,Email,Description');
		expect(csv.split('\r\n')[1]).toBe(
			'pay_1,2026-10-01T10:00:00.000Z,Paid,2500.00,USD,500.00,Bank transfer,o-1,ana@example.com,Order 1',
		);
	});

	it('shows every field and acts: refund and confirm in dialogs, proof and pay link in the More menu', async () => {
		const host = place('payments_admin');
		const pending = {
			...PAYMENT,
			id: 'pay_5',
			status: 'pending',
			reference: '',
			description: '',
			customer: { name: 'Ana', email: 'ana@example.com', phone: '+447700900123', id: 'usr_1' },
			metadata: { order: '1042' },
			source: 'api',
			checkoutUrl: 'https://payments.example.dev/pay/web_1/pay_5',
			proof: { type: 'image/png', size: 2048, uploadedAt: '2026-10-01T10:05:00.000Z' },
		};
		/** @type {any[]} */
		const confirmBodies = [];
		let refundReply = answer(422, { detail: 'Too much' });
		/** @type {any[]} */
		const refundBodies = [];
		const open = vi.fn();
		const copy = vi.fn();
		const client = adminApi({
			'GET /v1/admin/payments': () => answer(200, { items: [PAYMENT, pending], nextCursor: null, hasMore: false }),
			'GET /v1/admin/payments/pay_1': () => answer(200, PAYMENT),
			'GET /v1/admin/payments/pay_5': () => answer(200, pending),
			'POST /v1/admin/payments/pay_1/refunds': (init) => {
				refundBodies.push(JSON.parse(init.body));
				return refundReply;
			},
			'POST /v1/admin/payments/pay_5/confirm': (init) => {
				confirmBodies.push(JSON.parse(init.body));
				return answer(200, {
					...pending,
					status: 'paid',
					history: [
						...pending.history,
						{ at: pending.createdAt, event: 'paid', reference: 'TRX-1', note: 'In the bank app' },
					],
				});
			},
			'GET /v1/admin/payments/pay_5/proof': () => answer(200, { url: 'https://bucket/proof' }),
			'GET /v1/admin/payments/pay_1/proof': () => answer(404),
		});
		const config = configOf(['payment_api', 'refunds', 'manual_payments']);
		mountPaymentsAdmin({ host, api: client, config, save: vi.fn(), open, copy });
		await flush();
		expect(detailText(host)).toContain('paid · x · Sam');
		expect(detailText(host)).toContain(strings['admin.field.id']);
		button(host, strings['admin.refund']).click();
		expect(inside(host, '.dialog input[name="amount"]').value).toBe('2500.00');
		inside(host, '.dialog input[name="amount"]').value = '2500,00';
		await submitDialog(host);
		expect(refundBodies.at(-1)).toMatchObject({ amount: 250000 });
		expect(dialog(host)?.querySelector('[role="status"]')?.textContent).toBe('Not refunded: Too much');
		refundReply = answer(201, { ...PAYMENT, status: 'refunded', refunded: 250000 });
		await submitDialog(host);
		expect(dialog(host)).toBeNull();
		expect(detailStatus(host)).toBe(strings['admin.refundDone']);
		expect(rows(host)[0]?.textContent).toContain('Refunded');
		expect(button(host, strings['admin.refund'])).toBeUndefined();
		menuItem(host, strings['admin.proof'])?.click();
		await flush();
		expect(detailStatus(host)).toBe(strings['admin.failed']);
		expect(menuItem(host, strings['admin.copyPayLink'])).toBeUndefined();

		rows(host)[1]?.click();
		await flush();
		expect(inside(host, '.split').getAttribute('data-view')).toBe('detail');
		for (const text of ['Ana', '+447700900123', 'usr_1', 'order', '1042', 'image/png · 2 kB', strings['admin.source.api']])
			expect(detailText(host)).toContain(text);
		menuItem(host, strings['admin.proof'])?.click();
		await flush();
		expect(open).toHaveBeenCalledWith('https://bucket/proof');
		menuItem(host, strings['admin.copyPayLink'])?.click();
		expect(copy).toHaveBeenCalledWith(pending.checkoutUrl);
		menuItem(host, strings['admin.openPayPage'])?.click();
		expect(open).toHaveBeenCalledWith(pending.checkoutUrl);
		menuItem(host, strings['admin.copyId'])?.click();
		expect(copy).toHaveBeenCalledWith('pay_5');
		inside(host, '.detail-pane [aria-haspopup="menu"]').click();
		inside(host, '[role="menu"]').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(inside(host, '[role="menu"]').hasAttribute('hidden')).toBe(true);
		inside(host, '.detail-pane [aria-haspopup="menu"]').click();
		inside(host, '.detail-pane [aria-haspopup="menu"]').click();
		expect(inside(host, '[role="menu"]').hasAttribute('hidden')).toBe(true);
		inside(host, '.detail-pane [aria-haspopup="menu"]').click();
		inside(host, '[role="menu"] button').dispatchEvent(new window.Event('pointerdown', { bubbles: true, composed: true }));
		expect(inside(host, '[role="menu"]').hasAttribute('hidden')).toBe(false);
		document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
		expect(inside(host, '[role="menu"]').hasAttribute('hidden')).toBe(true);
		// the transfer's reference and a note go with the confirmation (PLAN 0.8.10 P3)
		button(host, strings['admin.confirm']).click();
		expect(dialog(host)?.textContent).toContain('USD 2,500.00');
		inside(host, '.dialog input[name="reference"]').value = ' TRX-1 ';
		inside(host, '.dialog textarea[name="note"]').value = 'In the bank app';
		await submitDialog(host);
		expect(confirmBodies).toEqual([{ reference: 'TRX-1', note: 'In the bank app' }]);
		expect(detailStatus(host)).toBe(strings['admin.confirmed']);
		expect(detailText(host)).toContain('paid · TRX-1 · In the bank app');
		expect(button(host, strings['admin.confirm'])).toBeUndefined();
		button(host, strings['admin.back']).click();
		expect(inside(host, '.split').getAttribute('data-view')).toBe('list');
		rows(host)[0]?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
		await flush();
		expect(rows(host)[0]?.getAttribute('aria-current')).toBe('true');
	});

	it('marks money that arrived after the merchant canceled the payment as a refund due (K-13)', async () => {
		const host = place('payments_admin');
		const voided = {
			...PAYMENT,
			id: 'pay_7',
			status: 'voided',
			refundDue: false,
			voidedAt: '2026-10-01T11:00:00.000Z',
			checkoutUrl: 'https://payments.example.dev/pay/web_1/pay_7',
		};
		const late = { ...voided, status: 'paid', refundDue: true, paidAt: '2026-10-01T12:00:00.000Z' };
		const client = adminApi({
			'GET /v1/admin/payments': () => answer(200, { items: [voided], nextCursor: null, hasMore: false }),
			'GET /v1/admin/payments/pay_7': () => answer(200, voided),
			'POST /v1/admin/payments/pay_7/confirm': () => answer(200, late),
		});
		mountPaymentsAdmin({
			host,
			api: client,
			config: configOf(['payment_api', 'refunds', 'manual_payments']),
			save: vi.fn(),
			open: vi.fn(),
		});
		await flush();
		expect(inside(host, '.detail-pane .badge').textContent).toBe(strings['status.voided']);
		expect(detailText(host)).toContain(strings['admin.field.voided']);
		expect(menuItem(host, strings['admin.copyPayLink'])).toBeUndefined();
		expect(button(host, strings['admin.refund'])).toBeUndefined();
		// a transfer that arrives after is confirmed, and is then to be refunded
		button(host, strings['admin.confirm']).click();
		await submitDialog(host);
		expect([...(host.shadowRoot?.querySelectorAll('.detail-pane .badge') ?? [])].map((b) => b.textContent)).toEqual([
			strings['status.paid'],
			strings['admin.refundDue'],
		]);
		expect(rows(host)[0]?.textContent).toContain(strings['admin.refundDue']);
		expect(button(host, strings['admin.refund'])).toBeTruthy();
	});

	it('says when confirming fails, the list is empty or cannot load, and when signed out', async () => {
		const pending = { ...PAYMENT, id: 'pay_6', status: 'pending', proof: null };
		const host = place('payments_admin');
		let list = answer(200, { items: [pending], nextCursor: null, hasMore: false });
		const client = adminApi({
			'GET /v1/admin/payments': () => list,
			'GET /v1/admin/payments/pay_6': () => answer(200, pending),
			'POST /v1/admin/payments/pay_6/confirm': () => answer(409, {}),
		});
		mountPaymentsAdmin({
			host,
			api: client,
			config: configOf(['payment_api', 'manual_payments']),
			save: vi.fn(),
			open: vi.fn(),
		});
		await flush();
		button(host, strings['admin.confirm']).click();
		await submitDialog(host);
		expect(dialog(host)?.querySelector('[role="status"]')?.textContent).toBe('Not confirmed: ');
		dialog(host)?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(dialog(host)).toBeNull();
		button(host, strings['admin.confirm']).click();
		button(host, strings['admin.close']).click();
		expect(dialog(host)).toBeNull();
		list = answer(200, { items: [], nextCursor: null, hasMore: false });
		inside(host, 'form').dispatchEvent(new window.Event('submit'));
		await flush();
		expect(statusText(host)).toBe(strings['admin.empty']);
		expect(detailText(host)).toBe('');
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
		const failing = adminApi({
			'GET /v1/admin/payments': () => answer(200, { items: [PAYMENT], nextCursor: null, hasMore: false }),
		});
		mountPaymentsAdmin({ host: detailsFail, api: failing, config: configOf(['payment_api']), save: vi.fn(), open: vi.fn() });
		await flush();
		expect(statusText(detailsFail)).toBe(strings['admin.failed']);
	});
});

describe('Subscriptions admin widget', () => {
	const sub = {
		id: 'sub_1',
		status: 'active',
		gateway: 'stripe',
		plan: 'price_1',
		reference: '',
		customer: { email: 'a@b.co', name: 'Bo' },
		gatewayReference: 'sub_stripe_1',
		history: [{ at: '2026-10-01T10:00:00.000Z', event: 'created' }],
		createdAt: '2026-10-01T10:00:00.000Z',
		updatedAt: '2026-10-01T10:00:00.000Z',
	};

	it('lists subscriptions with a status filter and cancels at the gateway after a confirmation', async () => {
		const host = place('subscriptions_admin');
		let cancel = answer(502, { detail: 'Stripe refused the keys.' });
		/** @type {string[]} */
		const queries = [];
		const copy = vi.fn();
		const client = adminApi({
			'GET /v1/admin/subscriptions': (_init, url) => {
				queries.push(url.search);
				return url.searchParams.get('cursor')
					? answer(200, {
							items: [{ ...sub, id: 'sub_2', status: 'cancelled', customer: {}, history: [] }],
							nextCursor: null,
							hasMore: false,
						})
					: answer(200, { items: [sub], nextCursor: 'c', hasMore: true });
			},
			'POST /v1/admin/subscriptions/sub_1/cancel': () => cancel,
		});
		mountSubscriptionsAdmin({ host, api: client, config: configOf(['subscriptions']), copy });
		await flush();
		expect(rows(host)[0]?.textContent).toContain('price_1');
		for (const text of ['Bo', 'a@b.co', 'sub_stripe_1', 'created']) expect(detailText(host)).toContain(text);
		menuItem(host, strings['subs.cancel'])?.click();
		expect(dialog(host)?.textContent).toContain('price_1');
		await submitDialog(host);
		expect(dialog(host)?.querySelector('[role="status"]')?.textContent).toBe('Not canceled: Stripe refused the keys.');
		cancel = answer(200, { ...sub, status: 'cancelled' });
		await submitDialog(host);
		expect(dialog(host)).toBeNull();
		expect(detailStatus(host)).toBe(strings['subs.cancelled']);
		expect(menuItem(host, strings['subs.cancel'])).toBeUndefined();
		menuItem(host, strings['subs.copyId'])?.click();
		expect(copy).toHaveBeenCalledWith('sub_1');
		button(host, strings['subs.more']).click();
		await flush();
		expect(rows(host)).toHaveLength(2);
		rows(host)[1]?.click();
		expect(inside(host, '.split').getAttribute('data-view')).toBe('detail');
		expect(detailText(host)).toContain('sub_2');
		rows(host)[0]?.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ' }));
		expect(detailText(host)).toContain('sub_1');
		inside(host, 'select').value = 'active';
		inside(host, 'select').dispatchEvent(new window.Event('change'));
		await flush();
		expect(queries.at(-1)).toContain('status=active');
		/** @type {any} */ (client.tickets).emit(true);
		/** @type {any} */ (client.tickets).emit(false);
		expect(statusText(host)).toBe(strings['subs.signedOut']);
	});

	it('shows times in the website’s Format and business time zone', async () => {
		const host = place('subscriptions_admin');
		const items = [
			{ ...sub, id: 'sub_9', gateway: 'paypal', plan: 'P-1', reference: 'r', createdAt: '2026-10-01T20:30:00.000Z' },
		];
		const client = adminApi({ 'GET /v1/admin/subscriptions': () => answer(200, { items, nextCursor: null, hasMore: false }) });
		mountSubscriptionsAdmin({ host, api: client, config: configOf(['subscriptions'], CUSTOM_LOOK) });
		await flush();
		// 20:30 UTC is the next day in Tokyo (UTC+9)
		expect(inside(host, '.meta').textContent).toContain('2 Oct 2026, 05:30');
	});

	it('says when there are none, when they cannot load and when signed out', async () => {
		const empty = place('subscriptions_admin');
		const none = { 'GET /v1/admin/subscriptions': () => answer(200, { items: [], nextCursor: null, hasMore: false }) };
		mountSubscriptionsAdmin({ host: empty, api: adminApi(none), config: configOf(['subscriptions']) });
		await flush();
		expect(statusText(empty)).toBe(strings['subs.empty']);
		const failing = place('subscriptions_admin');
		mountSubscriptionsAdmin({ host: failing, api: adminApi({}), config: configOf(['subscriptions']) });
		await flush();
		expect(statusText(failing)).toBe(strings['subs.failed']);
		const out = place('subscriptions_admin');
		mountSubscriptionsAdmin({ host: out, api: adminApi(none, tickets(null)), config: configOf(['subscriptions']) });
		await flush();
		expect(statusText(out)).toBe(strings['subs.signedOut']);
	});
});

describe('Payment links admin widget', () => {
	const LINK = {
		id: 'link_1',
		title: 'Invoice 42',
		description: 'Design work',
		amount: 250000,
		minAmount: null,
		currency: 'USD',
		gateways: ['bank_transfer'],
		returnUrl: 'https://shop.example.com/thanks',
		reference: 'inv-42',
		active: true,
		paidCount: 2,
		url: 'https://payments.example.dev/l/web_1/link_1',
		createdAt: '2026-10-01T10:00:00.000Z',
	};
	const OPEN = {
		...LINK,
		id: 'link_2',
		title: 'Donations',
		amount: null,
		minAmount: 500,
		gateways: [],
		active: false,
		paidCount: 0,
	};

	it('lists links and shows one: copy, open and turn it off and on again', async () => {
		const host = place('links_admin');
		/** @type {any[]} */
		const switches = [];
		let switchReply = (/** @type {any} */ body) => answer(200, { ...LINK, active: body.active });
		const open = vi.fn();
		const copy = vi.fn();
		const client = adminApi({
			'GET /v1/admin/links': (_init, url) =>
				url.searchParams.get('cursor')
					? answer(200, { items: [OPEN], nextCursor: null, hasMore: false })
					: answer(200, { items: [LINK], nextCursor: 'c', hasMore: true }),
			'PATCH /v1/admin/links/link_1': (init) => {
				const body = JSON.parse(init.body);
				switches.push(body);
				return switchReply(body);
			},
			// a picked link is read again: its paid count is the latest
			'GET /v1/admin/links/link_2': () => answer(200, { ...OPEN, paidCount: 3 }),
			'GET /v1/admin/links/link_1': () => answer(200, LINK),
			'GET /v1/admin/manual-methods': () => answer(200, { methods: [{ key: 'bank_transfer', name: 'Bank transfer' }] }),
		});
		mountLinksAdmin({ host, api: client, config: configOf(['payment_links', 'manual_payments']), open, copy });
		await flush();
		expect(rows(host)[0]?.textContent).toContain('Invoice 42');
		expect(rows(host)[0]?.textContent).toContain('2 paid');
		for (const text of [LINK.url, 'USD 2,500.00', 'Bank transfer', 'inv-42', 'Design work', LINK.returnUrl, 'link_1'])
			expect(detailText(host)).toContain(text);
		button(host, strings['links.copy']).click();
		expect(copy).toHaveBeenCalledWith(LINK.url);
		expect(detailStatus(host)).toBe(strings['links.copied']);
		menuItem(host, strings['links.openPage'])?.click();
		expect(open).toHaveBeenCalledWith(LINK.url);
		menuItem(host, strings['links.copyId'])?.click();
		expect(copy).toHaveBeenCalledWith('link_1');
		menuItem(host, strings['links.turnOff'])?.click();
		expect(dialog(host)?.textContent).toContain('Invoice 42');
		await submitDialog(host);
		expect(switches).toEqual([{ active: false }]);
		expect(detailStatus(host)).toBe(strings['links.turnedOff']);
		expect(inside(host, '.detail-pane .badge').textContent).toBe(strings['links.off']);
		expect(button(host, strings['links.copy'])).toBeUndefined();
		switchReply = () => answer(409, { detail: 'Try again.' });
		menuItem(host, strings['links.turnOn'])?.click();
		await flush();
		expect(detailStatus(host)).toBe('Not changed: Try again.');
		switchReply = (body) => answer(200, { ...LINK, active: body.active });
		menuItem(host, strings['links.turnOn'])?.click();
		await flush();
		expect(detailStatus(host)).toBe(strings['links.turnedOn']);
		button(host, strings['links.more']).click();
		await flush();
		expect(rows(host)).toHaveLength(2);
		rows(host)[1]?.click();
		await flush();
		expect(inside(host, '.split').getAttribute('data-view')).toBe('detail');
		expect(detailText(host)).toContain('Payer enters it (at least USD 5.00)');
		expect(detailText(host)).toContain(strings['links.allGateways']);
		expect(rows(host)[1]?.textContent).toContain('3 paid');
		rows(host)[0]?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
		await flush();
		expect(detailText(host)).toContain('Invoice 42');
	});

	it('creates a link in a dialog with the switched-on gateways', async () => {
		const host = place('links_admin');
		/** @type {any[]} */
		const bodies = [];
		let reply = answer(422, { detail: 'returnUrl must be on https://shop.example.com.' });
		const client = adminApi({
			'GET /v1/admin/links': () => answer(200, { items: [], nextCursor: null, hasMore: false }),
			'POST /v1/admin/links': (init) => {
				bodies.push(JSON.parse(init.body));
				return reply;
			},
			'GET /v1/admin/manual-methods': () =>
				answer(200, { methods: [{ key: 'bank_transfer', name: 'Bank transfer', kind: 'pay_first' }] }),
		});
		mountLinksAdmin({ host, api: client, config: configOf(['payment_links', 'stripe', 'manual_payments']), open: vi.fn() });
		await flush();
		expect(statusText(host)).toBe(strings['links.empty']);
		button(host, strings['links.new']).click();
		await flush();
		const form = /** @type {HTMLFormElement} */ (dialog(host));
		const set = (/** @type {string} */ name, /** @type {string} */ value) => {
			/** @type {HTMLInputElement} */ (form.querySelector(`[name="${name}"]`)).value = value;
		};
		const boxes = [...form.querySelectorAll('input[type="checkbox"]')].map((box) => /** @type {HTMLInputElement} */ (box));
		// the gateways, then the merchant's manual payment methods by their names (P1)
		expect(boxes.map((box) => box.value)).toEqual(['stripe', 'bank_transfer']);
		expect(form.textContent).toContain('Bank transfer');
		// no link yet: no currency is guessed
		expect(/** @type {HTMLSelectElement} */ (form.querySelector('select[name="currency"]')).value).toBe('');
		set('title', ' Donations ');
		set('currency', 'USD');
		set('minAmount', 'abc');
		await submitDialog(host);
		expect(form.querySelector('[role="status"]')?.textContent).toBe(
			'Enter amounts like 2500 or 2500.50, without thousands separators.',
		);
		set('minAmount', '100');
		set('returnUrl', 'https://elsewhere.example.org/');
		/** @type {HTMLInputElement} */ (boxes[1]).checked = true;
		await submitDialog(host);
		expect(form.querySelector('[role="status"]')?.textContent).toBe(
			'Not created: returnUrl must be on https://shop.example.com.',
		);
		reply = answer(201, OPEN);
		set('returnUrl', '');
		set('amount', '');
		await submitDialog(host);
		expect(bodies.at(-1)).toEqual({
			title: 'Donations',
			description: '',
			currency: 'USD',
			amount: null,
			minAmount: 10000,
			gateways: ['bank_transfer'],
			reference: '',
		});
		expect(dialog(host)).toBeNull();
		expect(rows(host)[0]?.textContent).toContain('Donations');
		expect(detailStatus(host)).toBe(strings['links.created']);
		expect(statusText(host)).toBe('');
	});

	it('picks the currency from the ISO 4217 list, starting with the newest link’s (P7)', async () => {
		const host = place('links_admin');
		const client = adminApi({
			'GET /v1/admin/links': () =>
				answer(200, { items: [{ ...LINK, currency: 'PKR' }, LINK], nextCursor: null, hasMore: false }),
			'GET /v1/admin/links/link_1': () => answer(200, LINK),
		});
		mountLinksAdmin({ host, api: client, config: configOf(['payment_links']), open: vi.fn() });
		await flush();
		button(host, strings['links.new']).click();
		await flush();
		const picker = /** @type {HTMLSelectElement} */ (dialog(host)?.querySelector('select[name="currency"]'));
		expect(picker.value).toBe('PKR');
		const codes = [...picker.options].map((option) => option.value);
		for (const code of ['USD', 'EUR', 'JPY', 'ZAR', 'KWD']) expect(codes).toContain(code);
		expect([...picker.options].find((option) => option.value === 'EUR')?.textContent).toBe('EUR · Euro');
	});

	it('takes amounts typed with the website’s decimal sign (P6)', async () => {
		const host = place('links_admin');
		/** @type {any[]} */
		const bodies = [];
		const client = adminApi({
			'GET /v1/admin/links': () => answer(200, { items: [], nextCursor: null, hasMore: false }),
			'POST /v1/admin/links': (init) => {
				bodies.push(JSON.parse(init.body));
				return answer(201, OPEN);
			},
		});
		const config = configOf(['payment_links', 'stripe'], { format: { locale: 'de-DE' } });
		mountLinksAdmin({ host, api: client, config, open: vi.fn() });
		await flush();
		button(host, strings['links.new']).click();
		await flush();
		const form = /** @type {HTMLFormElement} */ (dialog(host));
		const set = (/** @type {string} */ name, /** @type {string} */ value) => {
			/** @type {HTMLInputElement} */ (form.querySelector(`[name="${name}"]`)).value = value;
		};
		set('title', 'Donations');
		set('currency', 'EUR');
		set('minAmount', '1.250');
		await submitDialog(host);
		expect(form.querySelector('[role="status"]')?.textContent).toBe(
			'Enter amounts like 2500 or 2500,50, without thousands separators.',
		);
		expect(bodies).toEqual([]);
		set('minAmount', '25,50');
		await submitDialog(host);
		expect(bodies[0]).toMatchObject({ currency: 'EUR', amount: null, minAmount: 2550 });
	});

	it('tells gateways with the same brand apart by their currencies (P10)', async () => {
		const host = place('links_admin');
		const client = adminApi({ 'GET /v1/admin/links': () => answer(200, { items: [], nextCursor: null, hasMore: false }) });
		mountLinksAdmin({
			host,
			api: client,
			config: configOf(['payment_links', 'stripe', 'payfast', 'payfast_pk']),
			open: vi.fn(),
		});
		await flush();
		button(host, strings['links.new']).click();
		await flush();
		const labels = [.../** @type {HTMLFormElement} */ (dialog(host)).querySelectorAll('label.check')].map(
			(label) => label.textContent,
		);
		expect(labels).toEqual(['Card (Stripe)', 'PayFast (ZAR)', 'PayFast (PKR)']);
	});

	it('says when links cannot load and when signed out', async () => {
		const failing = place('links_admin');
		mountLinksAdmin({ host: failing, api: adminApi({}), config: configOf(['payment_links']), open: vi.fn() });
		await flush();
		expect(statusText(failing)).toBe(strings['links.failed']);
		const none = { 'GET /v1/admin/links': () => answer(200, { items: [], nextCursor: null, hasMore: false }) };
		const out = place('links_admin');
		mountLinksAdmin({ host: out, api: adminApi(none, tickets(null)), config: configOf(['payment_links']), open: vi.fn() });
		await flush();
		expect(statusText(out)).toBe(strings['links.signedOut']);
		const later = place('links_admin');
		const client = adminApi(none);
		mountLinksAdmin({ host: later, api: client, config: configOf(['payment_links']), open: vi.fn() });
		await flush();
		/** @type {any} */ (client.tickets).emit(true);
		/** @type {any} */ (client.tickets).emit(false);
		expect(statusText(later)).toBe(strings['links.signedOut']);
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

	it('mounts the subscriptions and links admins', async () => {
		const host = place('subscriptions_admin');
		const links = place('links_admin');
		serve({
			[`GET ${ADMIN_CONFIG_PATH}`]: () => answer(200, configOf(['subscriptions', 'payment_links'])),
			'GET /v1/admin/subscriptions': () => answer(200, { items: [], nextCursor: null, hasMore: false }),
			'GET /v1/admin/links': () => answer(200, { items: [], nextCursor: null, hasMore: false }),
		});
		await startWidget({ window, script: script(null) }).admin({
			getTicket: async () => ({ ticket: 't1', expiresAt: new Date(Date.now() + 900_000).toISOString() }),
		});
		await flush();
		expect(statusText(host)).toBe(strings['subs.empty']);
		expect(statusText(links)).toBe(strings['links.empty']);
	});
});

describe('the hosted manual method page and /pay.js', () => {
	const money = (/** @type {number} */ amount, /** @type {string} */ currency) => `${currency} ${(amount / 100).toFixed(2)}`;
	it('shows the method’s words, the accounts’ own rows and the reference, by kind (P1, P2)', () => {
		const html = renderManualPage({
			texts: strings,
			money,
			business: 'Shop',
			amount: 250000,
			currency: 'EUR',
			reference: 'INV-9',
			method: {
				name: 'SEPA transfer',
				kind: 'pay_first',
				details: 'Arrives in one working day.',
				instructions: 'Write INV-9 as the reference.',
				accounts: [
					{
						label: 'Euro account',
						currency: 'EUR',
						rows: [
							{ label: 'IBAN', value: 'DE89 3704 0044 0532 0130 00' },
							{ label: '<b>BIC</b>', value: 'COBADEFFXXX' },
						],
					},
				],
			},
			proof: null,
			uploaded: false,
		});
		const body = new window.DOMParser().parseFromString(html, 'text/html').body;
		expect(body.querySelector('h1')?.textContent).toBe('SEPA transfer');
		expect(body.textContent).toContain('Pay EUR 2500.00 as shown below and quote the reference.');
		for (const text of ['Euro account', 'IBAN', 'DE89 3704 0044 0532 0130 00', 'COBADEFFXXX', 'INV-9', 'Arrives in one'])
			expect(body.textContent).toContain(text);
		// every value is escaped
		expect(body.querySelector('b')).toBeNull();
		expect(body.querySelector('form[data-proof]')).toBeNull();
		for (const kind of /** @type {const} */ (['on_delivery', 'at_pickup'])) {
			const page = renderManualPage({
				texts: strings,
				money,
				business: 'Shop',
				amount: 1000,
				currency: 'USD',
				reference: 'R-1',
				method: { name: 'Cash', kind, details: '', instructions: '', accounts: [] },
				proof: null,
				uploaded: false,
			});
			expect(page).toContain(strings[`manual.intro.${kind}`].replace('{amount}', 'USD 10.00'));
		}
	});
	it('uploads the proof straight to storage with the reference the payer typed (P3)', async () => {
		const html = renderManualPage({
			texts: strings,
			money,
			business: 'Shop',
			amount: 250000,
			currency: 'USD',
			reference: 'INV-9',
			method: {
				name: 'Bank transfer',
				kind: 'pay_first',
				details: '',
				instructions: 'We send our details by email.',
				accounts: [],
			},
			proof: { action: 'https://payments.example.dev/pay/web_1/pay_1/proof' },
			uploaded: false,
		});
		document.body.innerHTML = new window.DOMParser().parseFromString(html, 'text/html').body.innerHTML;
		expect(document.body.textContent).toContain('We send our details by email.');
		/** @type {Array<{ url: string, body: unknown }>} */
		const calls = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (/** @type {string} */ url, /** @type {any} */ init) => {
				calls.push({ url, body: init.body });
				if (url.endsWith('/proof'))
					return new Response(JSON.stringify({ upload: { method: 'PUT', url: 'https://bucket/p', headers: {} }, key: 'k' }));
				return new Response('{}');
			}),
		);
		const form = /** @type {HTMLFormElement} */ (document.querySelector('form[data-proof]'));
		const file = new window.File(['png'], 'proof.png', { type: 'image/png' });
		Object.defineProperty(form.querySelector('input[type="file"]'), 'files', { value: [file] });
		/** @type {HTMLInputElement} */ (form.querySelector('input[name="reference"]')).value = ' TRX-9 ';
		new Function(PAY_SCRIPT)();
		form.dispatchEvent(new window.Event('submit', { cancelable: true }));
		await flush();
		expect(calls.map((call) => call.url)).toEqual([form.action, 'https://bucket/p', `${form.action}/done`]);
		expect(JSON.parse(String(calls[2]?.body))).toEqual({ key: 'k', reference: 'TRX-9' });
		expect(form.querySelector('[role="status"]')?.textContent).toBe(strings['manual.uploaded']);
		vi.unstubAllGlobals();
	});
});
