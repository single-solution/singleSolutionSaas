// @vitest-environment jsdom
/**
 * Ecommerce's Overview on the shared `@ss/ui` pattern (PLAN 0.6 "Overviews talk"): the kit's greeting, Needs you, setup
 * and Recent changes, with Ecommerce's own items judged from setup only — the currency and country the Portal's website
 * settings still lack (a link to the Portal, not a form here), Payments (recommended) with checkout, the Atlas Search index, staff alerts
 * that reach nobody or link nowhere, and bank transfer recorded by staff without bank details — each with its button to
 * the right section; only the loads the switched-on features need.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, click, render } from '@ss/ui/testing';
import { TABS } from '../app/dashboard/tabs.js';
import { defaultPaymentMethods, newAccount } from '../core/payment-methods.js';
import { inDashboard } from './dashboard-provider.js';

const WEBSITE = 'web_1';
const BASE = `/v1/dashboard/websites/${WEBSITE}`;

/**
 * The dashboard API's answers for a website with these features on, connections and settings (`{ value, source }`).
 * @param {{ on: string[], connections?: Array<Record<string, unknown>>, needed?: Array<Record<string, unknown>>,
 *   settings?: Record<string, Record<string, { value: unknown, source: string }>>, schemas?: Record<string, unknown>,
 *   lists?: Record<string, unknown>, search?: unknown, methods?: unknown[], missing?: string[] }} state `methods`: the
 *   `payment_methods` list (today's four by default); `lists`: other lists by name; `missing`: what the Portal's website
 *   settings still lack of what Ecommerce requires
 */
const serve = ({
	on,
	connections = [],
	needed = [],
	settings = {},
	schemas = {},
	lists = {},
	search = { search: 'basic', index: 'x', state: null },
	methods = defaultPaymentMethods(),
	missing = [],
}) => {
	/** @type {Record<string, unknown>} */
	const answers = {
		[`${BASE}/overview`]: {
			website: { websiteId: WEBSITE, merchantId: 'm_1', domain: 'shop.example.com' },
			status: { status: 'active', graceEndsAt: null },
			featuresOn: on,
			todayMillicredits: 1500,
			checklist: {
				connections: needed,
				widget: null,
				website: { version: 1, requires: ['region.currency', 'region.country'], missing },
			},
			recentChanges: [],
		},
		[`${BASE}/connections`]: { connections },
		[`${BASE}/search-index`]: search,
		[`${BASE}/lists/payment_methods`]: { value: methods },
		...Object.fromEntries(Object.entries(lists).map(([name, value]) => [`${BASE}/lists/${name}`, { value }])),
		[`${BASE}/settings`]: {
			features: Object.entries(settings).map(([key, values]) => ({ key, on: true, schema: schemas[key] ?? {}, values })),
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
	open: (/** @type {string} */ tab, /** @type {string | undefined} */ section) =>
		void opened.push(section ? `${tab}#${section}` : tab),
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
	it('greets, sends the missing currency and country to the Portal, and reads only what the features need', async () => {
		const loads = serve({
			on: ['catalog'],
			missing: ['region.currency', 'region.country'],
			settings: { catalog: { currency: value('USD', 'portal') } },
		});
		const Overview = TABS.overview;
		const { container } = render(inDashboard(<Overview {...props} />));
		await settle();
		// the greeting is the text behind the page's (i)
		click(/** @type {HTMLElement} */ (container.querySelector('button[aria-label="About this page"]')));
		const text = container.textContent ?? '';
		expect(text).toContain('Welcome back, Sam');
		expect(text).toContain('Needs setup: set currency, country in the Portal');
		// one link to the Portal's Region and format; no form and no "Set currency" step of Ecommerce's own
		expect(text).not.toContain('Set your currency');
		const link = [...container.querySelectorAll('a')].find((node) => node.textContent === 'Open Website settings');
		expect(link?.getAttribute('href')).toBe('https://portal.example.com/websites/web_1/settings#region');
		// no checkout or staff alerts: no connections read
		expect(loads()).not.toContain('/connections');
		cleanup();
		serve({ on: ['catalog'], settings: { catalog: { currency: value('EUR', 'portal') } } });
		const set = render(inDashboard(<Overview {...props} />));
		await settle();
		expect(set.container.textContent).not.toContain('Needs setup');
		expect(set.container.textContent).toContain('Everything on shop.example.com is ready');
	});

	it('recommends Payments with checkout and counts the connections the features need', async () => {
		serve({
			on: ['catalog', 'checkout'],
			needed: [{ name: 'database', label: 'Database', neededBy: ['catalog'], status: 'connected' }],
			connections: [
				{ name: 'link_payments', label: 'Payments', neededBy: [], status: 'not_connected' },
				{ name: 'link_notifications', label: 'Notifications', neededBy: [], status: 'connected' },
			],
			settings: { catalog: { currency: value('USD', 'website') } },
		});
		const Overview = TABS.overview;
		const { container } = render(inDashboard(<Overview {...props} />));
		await settle();
		const text = container.textContent ?? '';
		expect(text).toContain('Payments is not connected');
		expect(text).toContain('Connect Payments (recommended)');
		expect(text).toContain('Connect Notifications for order messages to shoppers');
		expect(text).toContain('Connections ready1 of 1');
		await press(container, 'Connect');
		expect(opened).toEqual(['connections#connection-link_payments']);
	});

	it('asks for staff alert recipients and admin page, how to pay methods paid by hand and the Atlas Search index', async () => {
		/** today's bank transfer paid by hand: no instructions, no account with a value yet @param {Record<string, unknown>} patch */
		const byHand = (patch) =>
			defaultPaymentMethods().map((method) =>
				method.key === 'bank_transfer' ? { ...method, via: 'manual', accounts: [newAccount()], ...patch } : method,
			);
		serve({
			on: ['catalog', 'checkout', 'staff_alerts'],
			connections: [{ name: 'link_payments', label: 'Payments', neededBy: [], status: 'connected' }],
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
		expect(opened).toEqual(['settings#checkout.payment-methods']);
		cleanup();
		// recipients set, the admin page set, the note written: nothing of them
		serve({
			on: ['catalog', 'checkout', 'staff_alerts'],
			connections: [{ name: 'link_payments', label: 'Payments', neededBy: [], status: 'connected' }],
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

	it('lists what the switched-on features need set, each with its why and a button to its own section', async () => {
		/** @param {string} group */
		const field = (group) => ({ type: 'string', title: 'x', default: '', 'x-ui': { group } });
		serve({
			on: ['catalog', 'checkout', 'delivery_zones', 'taxes'],
			needed: [{ name: 'database', label: 'Database', neededBy: ['catalog'], status: 'connected' }],
			connections: [{ name: 'link_payments', label: 'Payments', neededBy: [], status: 'connected' }],
			settings: {
				catalog: {
					currency: value('USD', 'website'),
					productUrl: value('/products/{slug}', 'built-in'),
					categoryUrl: value('/categories/{slug}', 'website'),
				},
				checkout: { guests: value('off', 'built-in') },
			},
			schemas: {
				catalog: {
					properties: {
						currency: field('Basics'),
						productUrl: field('Page addresses'),
						categoryUrl: field('Page addresses'),
						weightUnit: field('Units'),
					},
				},
			},
			lists: {
				delivery_zones: [{ key: 'all', name: 'Everywhere', rates: [] }],
				order_flow: { statuses: [{ key: 'placed' }, { key: 'done' }] },
				tax_rules: [],
			},
		});
		const Overview = TABS.overview;
		const { container } = render(inDashboard(<Overview {...props} />));
		await settle();
		const text = container.textContent ?? '';
		// not done yet: the product address is only the built-in start, the zone has no rate, no tax rule
		for (const words of [
			'Set the product page address',
			'Where your product pages live on your website, for example /shop/{slug}.',
			'Add a delivery zone with a rate',
			'Add a tax rule',
		])
			expect(text).toContain(words);
		/** @param {string} label */
		const row = (label) =>
			/** @type {HTMLElement} */ (
				/** @type {HTMLElement[]} */ ([...container.querySelectorAll('li')]).find((li) => li.textContent?.includes(label))
			);
		// ticked from what was saved: the category address was chosen, the order steps exist, the optional step is left out of the count
		expect(row('Set the category page address').querySelector('.line-through')).not.toBeNull();
		expect(row('Check your order steps').textContent).toContain('2 steps');
		expect(row('Decide on guest checkout').textContent).toContain('Optional');
		// the buttons open the exact section: a feature's page (its groups are stacked on it), a list's view, a connection
		await press(row('Set the product page address'), 'Set address');
		await press(row('Add a delivery zone with a rate'), 'Open delivery zones');
		await press(row('Offer a way to pay'), 'Review');
		await press(row('Add a tax rule'), 'Open tax rules');
		await press(row('Decide on guest checkout'), 'Choose');
		expect(opened).toEqual([
			'settings#catalog',
			'settings#delivery_zones',
			'settings#checkout.payment-methods',
			'settings#taxes',
			'settings#checkout',
		]);
	});
});
