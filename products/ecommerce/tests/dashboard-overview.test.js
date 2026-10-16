// @vitest-environment jsdom
/**
 * Ecommerce's Overview on the shared `@ss/ui` pattern (PLAN 0.6 "Overviews talk"): the kit's greeting, Needs you, setup
 * and Recent changes, with Ecommerce's own items judged from setup only — the currency until the merchant sets it (USD
 * stays the default, Claude's decision 9), Payments (recommended) with checkout, the Atlas Search index, staff alerts
 * that reach nobody or link nowhere, and bank transfer recorded by staff without bank details — each with its button to
 * the right section; only the loads the switched-on features need.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@ss/ui/testing';
import { TABS } from '../app/dashboard/tabs.js';
import { defaultPaymentMethods, newAccount } from '../core/payment-methods.js';
import { inDashboard } from './dashboard-provider.js';

const WEBSITE = 'web_1';
const BASE = `/v1/dashboard/websites/${WEBSITE}`;

/**
 * The dashboard API's answers for a website with these features on, connections and settings (`{ value, source }`).
 * @param {{ on: string[], connections?: Array<Record<string, unknown>>, needed?: Array<Record<string, unknown>>,
 *   settings?: Record<string, Record<string, { value: unknown, source: string }>>, search?: unknown,
 *   methods?: unknown[] }} state `methods`: the `payment_methods` list (today's four by default)
 */
const serve = ({
	on,
	connections = [],
	needed = [],
	settings = {},
	search = { search: 'basic', index: 'x', state: null },
	methods = defaultPaymentMethods(),
}) => {
	/** @type {Record<string, unknown>} */
	const answers = {
		[`${BASE}/overview`]: {
			website: { domain: 'shop.example.com' },
			status: { status: 'active', graceEndsAt: null },
			featuresOn: on,
			todayMillicredits: 1500,
			checklist: { connections: needed, widget: null, business: { found: true } },
			recentChanges: [],
		},
		[`${BASE}/connections`]: { connections },
		[`${BASE}/search-index`]: search,
		[`${BASE}/lists/payment_methods`]: { value: methods },
		[`${BASE}/settings`]: {
			features: Object.entries(settings).map(([key, values]) => ({ key, on: true, schema: {}, values })),
		},
	};
	const fetch = vi.fn(async (/** @type {string} */ path) =>
		path in answers
			? new Response(JSON.stringify(answers[path]), { status: 200 })
			: new Response(JSON.stringify({ status: 404, title: 'Not found' }), { status: 404 }),
	);
	vi.stubGlobal('fetch', fetch);
	return () => fetch.mock.calls.map(([path]) => String(path).replace(BASE, ''));
};

const settle = async () => {
	for (let i = 0; i < 6; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};

/** @type {string[]} */
let opened = [];
const props = {
	websiteId: WEBSITE,
	who: /** @type {const} */ ({ kind: 'merchant', id: 'm_1', name: 'Sam' }),
	support: { channels: [{ type: /** @type {const} */ ('email'), label: 'Email', url: 'mailto:help@example.com' }] },
	domain: 'shop.example.com',
	portal: 'https://portal.example.com',
	open: (/** @type {string} */ tab) => void opened.push(tab),
};

/** @param {HTMLElement} container @param {string} label */
const press = async (container, label) => {
	const button = [...container.querySelectorAll('button')].find((node) => node.textContent === label);
	if (!button) throw new Error(`no button ${label}`);
	await act(async () => button.click());
};

/** @param {unknown} value @param {string} [source] */
const value = (value, source = 'default') => ({ value, source });

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	opened = [];
});

describe('Ecommerce’s Overview', () => {
	it('greets, asks for the currency until it is set, and reads only what the features need', async () => {
		const loads = serve({ on: ['catalog'], settings: { catalog: { currency: value('USD'), mediaBaseUrl: value('') } } });
		const Overview = TABS.overview;
		const { container } = render(inDashboard(<Overview {...props} />));
		await settle();
		const text = container.textContent ?? '';
		expect(text).toContain('Welcome back, Sam');
		expect(text).toContain('Set your currency.');
		expect(text).toContain('Every price is in USD, the default, until you set your shop’s currency');
		expect(text).toContain('Now USD');
		await press(container, 'Set it');
		expect(opened).toEqual(['settings']);
		// no checkout or staff alerts: no connections read
		expect(loads()).not.toContain('/connections');
		cleanup();
		serve({ on: ['catalog'], settings: { catalog: { currency: value('EUR', 'website'), mediaBaseUrl: value('') } } });
		const set = render(inDashboard(<Overview {...props} />));
		await settle();
		expect(set.container.textContent).not.toContain('Every price is in');
		expect(set.container.textContent).toContain('Everything on shop.example.com is ready');
		expect(set.container.textContent).toContain('Set your currencyNow EUR');
	});

	it('recommends Payments with checkout and counts the connections the features need', async () => {
		serve({
			on: ['catalog', 'checkout'],
			needed: [{ name: 'database', label: 'Database', neededBy: ['catalog'], status: 'connected' }],
			connections: [
				{ name: 'payments', label: 'Payments', neededBy: [], status: 'not_connected' },
				{ name: 'notifications', label: 'Notifications', neededBy: [], status: 'connected' },
			],
			settings: { catalog: { currency: value('USD', 'website') } },
		});
		const Overview = TABS.overview;
		const { container } = render(inDashboard(<Overview {...props} />));
		await settle();
		const text = container.textContent ?? '';
		expect(text).toContain('Payments is not connected');
		expect(text).toContain('Connect Payments (recommended)');
		expect(text).toContain('Connect Notifications for order messages to shoppers (optional)');
		expect(text).toContain('Connections ready1 of 1');
		await press(container, 'Connect');
		expect(opened).toEqual(['connections']);
	});

	it('asks for staff alert recipients and admin page, how to pay methods paid by hand and the Atlas Search index', async () => {
		/** today's bank transfer paid by hand: no instructions, no account with a value yet @param {Record<string, unknown>} patch */
		const byHand = (patch) =>
			defaultPaymentMethods().map((method) =>
				method.key === 'bank_transfer' ? { ...method, via: 'manual', accounts: [newAccount()], ...patch } : method,
			);
		serve({
			on: ['catalog', 'checkout', 'staff_alerts'],
			connections: [{ name: 'payments', label: 'Payments', neededBy: [], status: 'connected' }],
			methods: byHand({}),
			settings: {
				catalog: { currency: value('USD', 'website') },
				staff_alerts: { recipients: value([]), staffPermission: value(''), adminUrl: value('') },
			},
			search: {
				search: 'atlas',
				index: 'products_search',
				state: { missing: true, at: '2026-10-02T18:05:00.000Z', message: 'index not found' },
			},
		});
		const Overview = TABS.overview;
		const { container } = render(inDashboard(<Overview {...props} />));
		await settle();
		const text = container.textContent ?? '';
		for (const words of [
			'No one gets staff alerts',
			'Staff alerts have no admin page to link to',
			'Shoppers are not told where to pay: Bank transfer',
			'The Atlas Search index products_search is missing',
			'Atlas Search: index not found',
			'3 more things need you',
		])
			expect(text).toContain(words);
		const docs = [...container.querySelectorAll('a')].find((node) => node.textContent === 'How to create it');
		expect(docs?.getAttribute('href')).toBe('/docs#atlas-search');
		await press(container, 'Add them');
		expect(opened).toEqual(['settings']);
		cleanup();
		// recipients set, the admin page set, the note written: nothing of them
		serve({
			on: ['catalog', 'checkout', 'staff_alerts'],
			connections: [{ name: 'payments', label: 'Payments', neededBy: [], status: 'connected' }],
			methods: byHand({ accounts: [{ label: '', currency: '', rows: [{ label: 'Account', value: '123' }] }] }),
			settings: {
				catalog: { currency: value('USD', 'website') },
				staff_alerts: {
					recipients: value(['orders@example.com'], 'website'),
					staffPermission: value(''),
					adminUrl: value('https://admin.example.com/orders/{id}', 'website'),
				},
			},
		});
		const fine = render(inDashboard(<Overview {...props} />));
		await settle();
		expect(fine.container.textContent).toContain('Nothing needs you right now.');
	});
});
