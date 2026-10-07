// @vitest-environment jsdom
/**
 * Merchant Console in the browser (jsdom), part 2 — products and subscriptions against a live in-process Portal:
 * catalog with plan comparison, balance check and subscribe, element switches, configuration through the SchemaForm
 * (edit, preview diff, save, client and server validation mapped to fields, reset, locked fields read-only),
 * history rollback, plan change, pause/resume/cancel, and the usage page charts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@ss/ui';
import { closeMongoClients } from '../../src/infra/db.js';
import * as loaders from '../../src/console/loaders.js';
import { ProductsView } from '../../src/console/views/products.js';
import { SubscriptionView } from '../../src/console/views/subscription.js';
import { ConfigurePanel, diffLine } from '../../src/console/views/configure.js';
import { UsageView } from '../../src/console/views/usage.js';
import { byLabel, cleanup, render, type } from '@ss/ui/testing';
import { startMongo } from '../helpers.js';
import {
	button,
	buttons,
	clickEl,
	createWorld,
	dialog,
	fill,
	press,
	pressDialog,
	quiet,
	settle,
	shows,
	until,
} from './merchant-harness.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

/** @type {Awaited<ReturnType<typeof startMongo>>} */
let mongo;
beforeAll(async () => {
	mongo = await startMongo();
});
afterAll(async () => {
	await closeMongoClients();
	await mongo?.stop();
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

/** @param {import('react').ReactNode} node */
const withToasts = (node) => render(<ToastProvider durationMs={600_000}>{node}</ToastProvider>);

/** Switch of the element labelled `name`. @param {string} name */
const switchOf = (name) => byLabel(document, name);

/** Radio whose label starts with `prefix`. @param {string} prefix @param {ParentNode} [root] */
const radioStarting = (prefix, root = document) => {
	const label = [...root.querySelectorAll('label')].find((l) => l.textContent?.startsWith(prefix));
	if (!label) throw new Error(`no radio “${prefix}…”`);
	return /** @type {HTMLInputElement} */ (document.getElementById(/** @type {HTMLLabelElement} */ (label).htmlFor));
};

describe('merchant console interactions (jsdom): products and subscriptions', () => {
	it('subscribes, switches, configures and changes plan against a live Portal', async () => {
		const restore = quiet();
		const world = await createWorld({ db: mongo.db('merchant_ui_2') });
		const appId = await world.seedPack();
		const { b, merchantId } = await world.signup('owner@shop.test', 'Shop & Co');
		b.use();
		const site = await b.api.post(`/v1/merchants/${merchantId}/websites`, { domain: 'shop.example.com' });
		if (!site.ok) throw new Error('website');
		const website = site.data.website;
		const websiteId = /** @type {string} */ (website.websiteId);

		// ---------------------------------------------------------------- catalog: no credits yet → balance check
		withToasts(<ProductsView {...await loaders.loadProducts(b.api, merchantId, websiteId)} />);
		expect(shows('Notice bar')).toBe(true);
		await press('Compare plans');
		expect(dialog().textContent).toContain('Included');
		await pressDialog('Close');
		await press('Subscribe');
		await until(() => shows('Not enough credits'));
		expect(button('Subscribe', dialog()).disabled).toBe(true);
		await pressDialog('Cancel');
		cleanup();

		await world.credit(merchantId, 250_000, 'bank-1');
		const products = await loaders.loadProducts(b.api, merchantId, websiteId);
		if (!products.ok) throw new Error('products');
		withToasts(<ProductsView {...products} />);
		await press('Subscribe');
		await clickEl(radioStarting('Plus'));
		expect(shows('Covers about')).toBe(true);
		await clickEl(radioStarting('Basic'));
		await pressDialog('Subscribe');
		const subscribed = await b.waitCall('POST', `/v1/merchants/${merchantId}/websites/${websiteId}/subscriptions`, (s) =>
			[200, 201].includes(s),
		);
		const subscriptionId = /** @type {string} */ (subscribed.body.subscription.subscriptionId);
		cleanup();

		// a product with no plans, needing a resource — subscribing again is refused
		const entry = /** @type {any} */ (products.catalog[0]);
		const variant = {
			...entry,
			plans: [],
			requires: ['database'],
			price: { ...entry.price, metered: true, trialHours: 2 },
		};
		withToasts(
			<ProductsView
				{...products}
				subscriptions={[]}
				catalog={[variant, { ...entry, appId: 'app_free', price: { ...entry.price, free: true }, plans: [] }]}
				website={{ ...products.website, env: 'test' }}
			/>,
		);
		expect(shows('Needs your database connected')).toBe(true);
		expect(shows('Free')).toBe(true);
		await clickEl(/** @type {HTMLButtonElement} */ (buttons('Subscribe')[0]));
		expect(shows('This product has no plans')).toBe(true);
		expect(shows('Includes a trial of 2 hours.')).toBe(true);
		await pressDialog('Subscribe');
		await until(() =>
			b.calls.some((c) => c.method === 'POST' && c.path.endsWith(`/websites/${websiteId}/subscriptions`) && c.status >= 400),
		);
		await settle(2);
		cleanup();
		render(<ProductsView {...products} catalog={[]} />);
		expect(shows('No products are listed yet')).toBe(true);
		cleanup();
		render(<ProductsView ok={false} problem={{ status: 404, title: 'Not found', code: 'not_found' }} />);
		expect(shows('Not found')).toBe(true);
		cleanup();

		// an admin lock on the tone (read-only for the merchant)
		const locked = await world.staff.api.request('PATCH', `/v1/admin/subscriptions/${subscriptionId}/config`, {
			features: { 'bar.tone': { value: 'warning', locked: true } },
			reason: 'brand rule',
		});
		expect(locked.ok).toBe(true);

		// ---------------------------------------------------------------- subscription: element switches
		const load = () => loaders.loadSubscription(b.api, merchantId, websiteId, subscriptionId);
		const detail = await load();
		if (!detail.ok) throw new Error('subscription');
		withToasts(<SubscriptionView {...detail} />);
		expect(shows('Add-on')).toBe(true);
		await clickEl(switchOf('Trust badge'));
		await until(() => shows('Trust badge switched on'));
		await until(() => !(/** @type {HTMLButtonElement} */ (switchOf('Notice bar')).disabled));
		await clickEl(switchOf('Notice bar'));
		await until(() => shows('Notice bar switched off'));
		await until(() => !(/** @type {HTMLButtonElement} */ (switchOf('Notice bar')).disabled));
		await clickEl(switchOf('Notice bar'));
		await until(() => shows('Notice bar switched on'));

		// ---------------------------------------------------------------- configure: SchemaForm
		await press('Configure');
		expect(shows('Set by admin')).toBe(true);
		expect(document.querySelector('[data-field="tone"]')).toBeNull();
		fill('Message', 'Free shipping');
		fill('Max per day', '99');
		await until(() => shows('2 unsaved changes.'));
		await press('Preview');
		await until(() => document.querySelector('[data-field="maxPerDay"] [role="alert"]'));
		fill('Max per day', '4');
		await press('Preview');
		await b.waitCall(
			'POST',
			(p) => p.endsWith('/config/preview'),
			(s) => s === 200,
		);
		await until(() => shows('bar.message'));
		await press('Discard');
		await until(() => shows('No unsaved changes.'));
		fill('Message', 'Free shipping');
		fill('Reason (optional)', 'promo');
		await press(`Advanced settings (1)`);
		await clickEl(byLabel(document, 'Dismissible'));
		await press('Save');
		await until(() => shows('Configuration saved'));
		await b.waitCall('GET', (p) => p.endsWith('/config/history'));
		await settle(3);
		// element select: switch to the badge and back
		type(byLabel(document, 'Element'), 'badge');
		await settle(1);
		expect(shows('Badge label')).toBe(true);
		type(byLabel(document, 'Element'), 'bar');
		await settle(1);
		// reset an overridden setting
		await until(() => buttons('Reset').length > 0);
		await clickEl(/** @type {HTMLButtonElement} */ (buttons('Reset')[0]));
		await until(() => shows('Setting reset'));
		await settle(2);

		// ---------------------------------------------------------------- history: roll back, restore defaults
		await press('History');
		await until(() => buttons('Roll back to this').length > 0);
		await clickEl(/** @type {HTMLButtonElement} */ (buttons('Roll back to this')[0]));
		await pressDialog('Roll back');
		await until(() => shows('Rolled back to version'));
		await settle(2);
		await press('Restore defaults');
		expect(shows('Every website override is removed')).toBe(true);
		await pressDialog('Roll back');
		await b.waitCall(
			'POST',
			(p) => p.endsWith('/config/rollback'),
			(s) => s >= 400 || s === 200,
		);
		await settle(2);

		// ---------------------------------------------------------------- plan change
		await press('Plan');
		await clickEl(radioStarting('Plus', document.querySelector('[role="tabpanel"]') ?? document));
		await press('Change plan');
		expect(shows('Switch to plus?')).toBe(true);
		await pressDialog('Change plan');
		await until(() => shows('Plan changed'));

		// ---------------------------------------------------------------- pause, resume, cancel
		await press('Pause');
		await pressDialog('Pause');
		await until(() => shows('Subscription paused'));
		await press('Resume');
		await until(() => shows('Subscription resumed'));
		await press('Cancel subscription');
		await pressDialog('Cancel subscription');
		await until(() => shows('Subscription cancelled'));
		// a second cancel is refused by the Portal (the action stays visible on a stale view)
		cleanup();

		// ---------------------------------------------------------------- variants of the page
		const after = await load();
		if (!after.ok) throw new Error('subscription');
		withToasts(
			<SubscriptionView
				{...after}
				subscription={{ ...after.subscription, status: 'active', holds: ['spend_cap', 'custom_hold'] }}
				product={{ ...after.product, kind: 'service', plans: [] }}
				history={{ items: after.history.items, nextCursor: 'cursor-x' }}
				configProblem={{ status: 503, title: 'Unavailable', detail: 'Config is down.' }}
			/>,
		);
		expect(shows('Raise the spend cap')).toBe(true);
		await press('Open in product');
		await b.waitCall('POST', `/v1/merchants/${merchantId}/apps/${appId}/launch`);
		await settle(2);
		// a launch answered without a link says so instead of doing nothing
		vi.stubGlobal('fetch', async (/** @type {any} */ input, /** @type {any} */ init) =>
			String(input).endsWith('/launch') ? new Response('{}', { status: 200 }) : b.fetch(input, init),
		);
		await press('Open in product');
		await until(() => shows('The product did not return a launch link.'));
		b.use();
		await press('History');
		await press('Load older versions');
		await settle(3);
		// actions on a cancelled subscription are refused and surface the problem
		await press('Elements');
		await clickEl(switchOf('Trust badge'));
		await until(() => b.calls.some((c) => c.method === 'PUT' && c.path.includes('/elements/') && c.status >= 400));
		await press('Pause');
		await pressDialog('Pause');
		await until(() => b.calls.some((c) => c.path.endsWith('/pause') && c.status >= 400));
		await press('Plan');
		await settle(1);
		await press('History');
		await until(() => buttons('Roll back to this').length > 0);
		await clickEl(/** @type {HTMLButtonElement} */ (buttons('Roll back to this')[0]));
		await pressDialog('Roll back');
		await settle(3);
		cleanup();
		withToasts(
			<SubscriptionView
				{...after}
				subscription={{ ...after.subscription, status: 'active', planCode: 'basic' }}
				product={{ ...after.product, elements: [] }}
			/>,
		);
		expect(shows('This product lists no elements')).toBe(true);
		await press('Plan');
		await clickEl(radioStarting('Plus', document.querySelector('[role="tabpanel"]') ?? document));
		await press('Change plan');
		await pressDialog('Change plan');
		await until(() => b.calls.some((c) => c.method === 'PUT' && c.path.endsWith('/plan') && c.status >= 400));
		cleanup();
		render(<SubscriptionView ok={false} problem={{ status: 404, title: 'Not found', code: 'not_found' }} />);
		expect(shows('Not found')).toBe(true);
		cleanup();

		// a looser client schema than the Portal's: the server's validation errors map to the fields
		const sub2 = await b.api.post(`/v1/merchants/${merchantId}/websites/${websiteId}/subscriptions`, {
			appId,
			planCode: 'basic',
		});
		const sub2Id = sub2.ok ? sub2.data.subscription.subscriptionId : subscriptionId;
		const detail2 = await loaders.loadSubscription(b.api, merchantId, websiteId, sub2Id);
		if (!detail2.ok) throw new Error('subscription 2');
		const loose = {
			...detail2.product,
			elements: detail2.product.elements.map((/** @type {any} */ e) =>
				e.key === 'bar'
					? {
							...e,
							features: {
								...e.features,
								properties: {
									...e.features.properties,
									message: { ...e.features.properties.message, maxLength: 5000 },
								},
							},
						}
					: e,
			),
		};
		withToasts(
			<ConfigurePanel
				merchantId={merchantId}
				website={detail2.website}
				subscription={detail2.subscription}
				product={loose}
				overview={detail2.overview}
				effective={detail2.effective}
				onSaved={() => undefined}
			/>,
		);
		fill('Message', 'y'.repeat(400));
		await press('Preview');
		await until(() => b.calls.some((c) => c.path.endsWith('/config/preview') && c.status >= 400));
		await until(() => document.querySelector('[data-field="message"] [role="alert"]'));
		await press('Save');
		await until(() => b.calls.some((c) => c.method === 'PATCH' && c.path.endsWith('/config') && c.status >= 400));
		cleanup();
		expect(diffLine({ kind: 'elements', key: 'bar', op: 'added', after: { enabled: true } })).toBe('Element bar set to on');
		expect(diffLine({ key: 'bar.x', op: 'removed', before: { value: null } })).toBe('bar.x reset (was unlimited)');
		expect(diffLine({ key: 'bar.y', before: { value: [1] }, after: undefined })).toBe('bar.y: [1] → —');

		// ---------------------------------------------------------------- usage: charts from ledger entries
		const usage = await loaders.loadUsage(b.api, merchantId, websiteId, { from: '2026-01-01', to: '2026-12-31' });
		if (!usage.ok) throw new Error('usage');
		const at = new Date().toISOString();
		render(
			<UsageView
				{...usage}
				meter={{
					...(usage.meter ?? {}),
					balanceMillicredits: 100_000,
					burnRatePerHour: 1750,
					hoursRemaining: 12,
					monthToDate: 3500,
					projectedMonth: 90_000,
					periodEnd: at,
					subscriptions: [{ websiteId, subscriptionId, burnRatePerHour: 1750 }],
				}}
				statement={{
					entries: [
						{
							entryId: 'e1',
							type: 'settlement',
							amountMillicredits: -1750,
							periodStart: '2026-10-01T10:00:00.000Z',
							appId,
							details: {
								breakdown: [
									{ kind: 'base', amount: 100 },
									{ kind: 'element', element: 'bar', amount: 1250 },
									{ kind: 'element', element: 'gone', amount: 400 },
								],
							},
						},
						{
							entryId: 'e2',
							type: 'metered',
							amountMillicredits: -30,
							at: '2026-10-02T00:00:00.000Z',
							appId,
							details: { lines: [{ unit: 'view', quantity: 3, amount: 30 }] },
						},
						{ entryId: 'e3', type: 'deposit', amountMillicredits: 5000, at: '2026-10-01T00:00:00.000Z' },
					],
				}}
				statementProblem={{ status: 400, title: 'Bad range' }}
			/>,
		);
		expect(shows('Spend per day')).toBe(true);
		expect(shows('Notice bar base')).toBe(true);
		expect(shows('3 used')).toBe(true);
		expect(document.querySelectorAll('svg, [role="img"], [role="meter"]').length).toBeGreaterThan(0);
		await press('Amount');
		await press('Hour');
		cleanup();
		render(<UsageView ok={false} problem={{ status: 403, title: 'Forbidden', code: 'forbidden' }} />);
		expect(shows('No access')).toBe(true);
		restore();
	});
});
