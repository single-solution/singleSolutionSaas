// @vitest-environment jsdom
/**
 * Merchant Console in the browser (jsdom), part 3 — keys, resources (connectors), credits and the spend cap against
 * a live in-process Portal: keys created (shown once, then only the hint), rotated and revoked; connectors created
 * per kind with client validation, tested, edited (label, new credentials), assigned to websites and deleted; the
 * credits statement with filters; the monthly spend cap set, changed and removed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@ss/ui';
import { closeMongoClients } from '../../src/infra/db.js';
import * as loaders from '../../src/console/loaders.js';
import { KeysView } from '../../src/console/views/keys.js';
import { CheckReport, ConnectorsView, providerLabel } from '../../src/console/views/connectors.js';
import { CreditsView, SpendCapView } from '../../src/console/views/credits.js';
import { byLabel, cleanup, render, type } from '@ss/ui/testing';
import { startMongo } from '../helpers.js';
import {
	button,
	buttons,
	check,
	clickEl,
	createWorld,
	dialog,
	fill,
	fillDialog,
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

/** `YYYY-MM-DD` `days` from today (UTC). @param {number} days */
const day = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe('merchant console interactions (jsdom): keys, resources, credits', () => {
	it('drives keys, connectors, credits and the spend cap against a live Portal', async () => {
		const restore = quiet();
		const world = await createWorld({ db: mongo.db('merchant_ui_3') });
		const appId = await world.seedPack();
		const { b, merchantId } = await world.signup('owner@shop.test', 'Shop & Co');
		b.use();
		const site = await world.addWebsite(merchantId, 'shop.example.com');
		const websiteId = /** @type {string} */ (site.website.websiteId);
		const twinId = /** @type {string} */ (site.twin.websiteId);
		await world.credit(merchantId, 250_000, 'bank-1');
		const sub = await world.subscribe(merchantId, websiteId, { appId, planCode: 'basic' });
		expect(sub.subscriptionId).toBeTruthy();

		// ---------------------------------------------------------------- keys
		withToasts(<KeysView {...await loaders.loadKeys(b.api, merchantId, websiteId)} />);
		expect(shows('No keys yet')).toBe(true);
		await press('Create key');
		// the F.16 vocabulary: platform scopes (defaults on) + one group per listed service product
		await check('Read elements (elements.read)', dialog());
		await check('Send events (events.write)', dialog());
		await pressDialog('Create key');
		expect(shows('Choose at least one scope.')).toBe(true);
		await check('Read elements (elements.read)', dialog());
		await check('Send events (events.write)', dialog());
		fillDialog('Expires (optional)', day(-3));
		await pressDialog('Create key');
		expect(shows('Choose a date in the future.')).toBe(true);
		fillDialog('Expires (optional)', day(30));
		await check('Also allow subdomains of shop.example.com', dialog());
		await pressDialog('Create key');
		const created = await b.waitCall('POST', `/v1/merchants/${merchantId}/websites/${websiteId}/keys`, (s) => s < 300);
		const pk = String(created.body.key);
		await until(() => shows('Your new key — copy it now'));
		expect(dialog().textContent).toContain(pk);
		expect(shows('it is shown only once')).toBe(true);
		await pressDialog('I have copied it');
		await until(() => !shows(pk));
		expect(shows('+ subdomains')).toBe(true);
		// a secret key, then one the server refuses (unknown scope)
		await press('Create key');
		await check('Secret (sk_) — for your server only', dialog());
		await pressDialog('Create key');
		await until(() => shows('Never put an sk_ key in a web page'));
		await pressDialog('I have copied it');
		await press('Create key');
		await check('Send events (events.write)', dialog());
		await pressDialog('Create key');
		await until(() => b.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/keys')).length >= 3);
		await settle(2);
		await pressDialog(shows('copy it now') ? 'I have copied it' : 'Cancel');
		// rotate with a grace period: the new key is shown once
		await until(() => buttons('Rotate').length >= 2);
		await clickEl(/** @type {HTMLButtonElement} */ (buttons('Rotate')[0]));
		await check('1 hour', dialog());
		await pressDialog('Rotate');
		await until(() => shows('New key — copy it now'));
		expect(shows('The previous key keeps working')).toBe(true);
		await pressDialog('I have copied it');
		await until(() => shows('Revokes'));
		await clickEl(/** @type {HTMLButtonElement} */ (buttons('Revoke')[0]));
		fillDialog('Reason (optional)', 'leaked');
		await pressDialog('Revoke key');
		await until(() => shows('Key revoked'));
		cleanup();
		// stale page: rotating / revoking a revoked key shows the problem in the dialog
		const keys = await loaders.loadKeys(b.api, merchantId, twinId);
		const allKeys = await loaders.loadKeys(b.api, merchantId, websiteId);
		if (!keys.ok || !allKeys.ok) throw new Error('keys');
		const revoked = allKeys.keys.find((/** @type {any} */ k) => k.status !== 'active');
		withToasts(<KeysView {...allKeys} keys={[{ ...revoked, status: 'active' }]} />);
		await press('Rotate');
		await pressDialog('Rotate');
		await until(() => dialog().querySelector('[role="alert"]'));
		await pressDialog('Cancel');
		await press('Revoke');
		await pressDialog('Revoke key');
		await until(() => b.calls.filter((c) => c.path.endsWith('/revoke')).length >= 2);
		await settle(2);
		cleanup();
		render(<KeysView {...keys} />);
		expect(shows('These are test keys.')).toBe(true);
		cleanup();

		// ---------------------------------------------------------------- connectors
		const resources = () => loaders.loadResources(b.api, merchantId, websiteId);
		withToasts(<ConnectorsView {...await resources()} />);
		expect(shows('What this website uses')).toBe(true);
		await clickEl(/** @type {HTMLButtonElement} */ (buttons('Connect')[0]));
		await pressDialog('Connect and test');
		expect(shows('Connection string is required.')).toBe(true);
		fillDialog('Connection string', 'mongodb+srv://shop:secret@cluster0.example.net/shop?tls=true');
		fillDialog('Database name', 'shop');
		fillDialog('Label (optional)', 'Main DB');
		await pressDialog('Connect and test');
		await until(() => shows('Resource connected') || b.calls.some((c) => c.path.endsWith('/connectors') && c.status >= 400));
		await settle(2);
		if (document.querySelector('[role="dialog"]')) await pressDialog('Cancel');
		// kinds and providers: payments (free provider), storage, messaging over SMTP and HTTP
		await press('Add connector');
		type(byLabel(dialog(), 'Kind'), 'payments');
		await settle(1);
		fillDialog('Provider', '');
		fillDialog('Credentials', 'not a pair');
		await pressDialog('Connect and test');
		expect(shows('Choose or type a provider.')).toBe(true);
		expect(shows('is not NAME=value')).toBe(true);
		fillDialog('Provider', 'Stripe');
		fillDialog('Credentials', 'publishableKey=pk_test_1\nsecretKey=sk_test_1\n');
		world.probe.ok = false;
		await pressDialog('Connect and test');
		await until(() => shows('Saved, but the connection check failed') || !document.querySelector('[role="dialog"]'));
		await settle(2);
		world.probe.ok = true;
		await press('Add connector');
		type(byLabel(dialog(), 'Kind'), 'storage');
		await settle(1);
		type(byLabel(dialog(), 'Provider'), 'r2');
		await settle(1);
		await check('Use path-style URLs', dialog());
		await pressDialog('Connect and test');
		expect(shows('Endpoint is required.')).toBe(true);
		type(byLabel(dialog(), 'Kind'), 'messaging');
		await settle(1);
		type(byLabel(dialog(), 'Provider'), 'smtp');
		await settle(1);
		fillDialog('Port', '1.5');
		await pressDialog('Connect and test');
		expect(shows('Enter a whole number.')).toBe(true);
		type(byLabel(dialog(), 'Provider'), 'generic-http');
		await settle(1);
		type(byLabel(dialog(), 'Authentication'), 'header');
		fillDialog('Base URL', 'ftp://not-https');
		fillDialog('API key', 'k');
		await pressDialog('Connect and test');
		await until(() => b.calls.some((c) => c.method === 'POST' && c.path.endsWith('/connectors') && c.status >= 400));
		await pressDialog('Cancel');
		cleanup();

		// a connector assigned only to the test twin (so "Show all" appears on the live website)
		const twinConnector = await b.api.post(`/v1/merchants/${merchantId}/connectors`, {
			kind: 'ai',
			provider: 'openai',
			credentials: { apiKey: 'sk-test-1' },
			websiteIds: [twinId],
		});
		expect(twinConnector.ok).toBe(true);
		withToasts(<ConnectorsView {...await resources()} />);
		await until(() => buttons('Test').length > 0);
		world.probe.ok = false;
		await clickEl(/** @type {HTMLButtonElement} */ (buttons('Test')[0]));
		await until(() => shows('Check failed') || shows('Check passed'));
		world.probe.ok = true;
		// edit: an empty form changes nothing locally; a new label alone; then new credentials (re-checked)
		/** @param {string} name the connector row showing `name` */
		const rowOf = (name) =>
			/** @type {HTMLElement} */ ([...document.querySelectorAll('li')].find((li) => li.textContent?.includes(name)));
		await clickEl(button('Edit', rowOf('Main DB')));
		fillDialog('Label', '');
		await pressDialog('Save');
		expect(shows('Enter a label or new credentials.')).toBe(true);
		fillDialog('Label', 'Renamed');
		await pressDialog('Save');
		await until(() => shows('Connector updated'));
		await until(() => rowOf('Renamed'));
		await clickEl(button('Edit', rowOf('Renamed')));
		expect(byLabel(dialog(), 'Label').value).toBe('Renamed');
		fillDialog('Connection string', 'mongodb+srv://shop:other@cluster0.example.net/shop?tls=true');
		await pressDialog('Save');
		await until(() => b.calls.filter((c) => c.method === 'PATCH' && c.status === 200).length >= 2);
		const patched = b.calls.filter((c) => c.method === 'PATCH').at(-1);
		expect(patched?.body?.report?.ok).toBe(true);
		await until(() => !document.querySelector('[role="dialog"]'));
		await clickEl(/** @type {HTMLButtonElement} */ (buttons('Websites')[0]));
		await check('shop.example.com (test)', dialog());
		await pressDialog('Save');
		await until(() => shows('Websites updated'));
		await clickEl(
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('button')].find((x) => x.textContent?.startsWith('Show all ('))
			),
		);
		await until(() => shows('Every connector of your organisation.'));
		// assign the twin-only connector to this website as well
		const twinRow = /** @type {HTMLElement} */ (
			[...document.querySelectorAll('li')].find(
				(li) => li.textContent?.includes('Used by: shop.example.com (test)') && !li.textContent?.includes(', '),
			)
		);
		if (twinRow) {
			await clickEl(button('Websites', twinRow));
			expect(shows("lets this website's products use it")).toBe(true);
			await check('shop.example.com', dialog());
			await pressDialog('Save');
			await until(() => !document.querySelector('[role="dialog"]'));
		}
		await press('Only this website');
		await until(() => buttons('Delete').length > 0);
		await clickEl(/** @type {HTMLButtonElement} */ (buttons('Delete')[0]));
		await pressDialog('Delete');
		await until(() => shows('Connector deleted'));
		cleanup();
		// stale page: actions on a deleted connector show the problem
		const stale = await resources();
		if (!stale.ok) throw new Error('resources');
		const ghost = {
			connectorId: 'con_0000000000000000000000000z',
			kind: 'database',
			provider: 'mongodb',
			label: null,
			status: 'connected',
			websiteIds: [websiteId],
			createdAt: new Date().toISOString(),
			preview: { host: 'cluster0.example.net', dbName: null },
			lastCheckReport: {
				ok: false,
				checkedAt: new Date().toISOString(),
				checks: [
					{ name: 'auth', ok: false, code: 'auth_failed' },
					{ name: 'tls', ok: false },
				],
				warnings: ['plain', { code: 'slow_link' }, { message: 'Watch out' }],
			},
		};
		withToasts(<ConnectorsView {...stale} connectors={[ghost]} />);
		expect(shows('Some checks failed') && shows('Watch out')).toBe(true);
		await press('Websites');
		await pressDialog('Save');
		await until(() => b.calls.some((c) => c.path.endsWith(`${ghost.connectorId}/websites`) && c.status >= 400));
		await pressDialog('Cancel');
		await press('Delete');
		await pressDialog('Delete');
		await until(() => dialog().querySelector('[role="alert"]'));
		await pressDialog('Cancel');
		await press('Edit');
		fillDialog('Connection string', 'mongodb+srv://a:b@cluster0.example.net/x?tls=true');
		await pressDialog('Save');
		await until(() => b.calls.some((c) => c.method === 'PATCH' && c.path.endsWith(ghost.connectorId) && c.status >= 400));
		await pressDialog('Cancel');
		await press('Test');
		await until(() => b.calls.some((c) => c.path.endsWith(`${ghost.connectorId}/test`) && c.status >= 400));
		cleanup();
		render(<CheckReport report={null} />);
		expect(shows('Not tested yet.')).toBe(true);
		cleanup();
		expect(providerLabel('mongodb')).toBe('MongoDB');
		expect(providerLabel('my-gateway')).toMatch(/gateway/i);

		// ---------------------------------------------------------------- credits statement with filters
		render(<CreditsView {...await loaders.loadCredits(b.api, merchantId, { from: day(-30), to: day(1), websiteId })} />);
		expect(shows('Statement')).toBe(true);
		expect(byLabel(document, 'Website').value).toBe(websiteId);
		await press('Amount');
		await press('Type');
		cleanup();
		const credits = await loaders.loadCredits(b.api, merchantId, {});
		if (!credits.ok) throw new Error('credits');
		render(
			<CreditsView
				{...credits}
				meter={{
					balanceMillicredits: 0,
					burnRatePerHour: 1000,
					hoursRemaining: 0,
					subscriptions: [{}],
					monthToDate: 5,
					projectedMonth: 9,
				}}
				statementProblem={{ status: 400, title: 'Bad range' }}
				statement={{
					openingBalanceMillicredits: 1000,
					closingBalanceMillicredits: 2000,
					totals: { deposit: 5000, settlement: -4000 },
					entries: [
						{
							entryId: 'e1',
							type: 'settlement',
							amountMillicredits: -4000,
							at: new Date().toISOString(),
							appId,
							websiteId,
						},
						{
							entryId: 'e2',
							type: 'settlement',
							amountMillicredits: -10,
							at: new Date().toISOString(),
							appId,
							websiteId: 'web_gone',
						},
						{ entryId: 'e3', type: 'deposit', amountMillicredits: 5000, at: new Date().toISOString(), reference: 'bank-1' },
					],
				}}
			/>,
		);
		expect(shows('Opening') && shows('Closing') && shows('bank-1')).toBe(true);
		cleanup();
		render(<CreditsView ok={false} problem={{ status: 403, title: 'Forbidden', code: 'forbidden' }} />);
		cleanup();

		// ---------------------------------------------------------------- spend cap
		withToasts(<SpendCapView {...await loaders.loadSpendCap(b.api, merchantId)} />);
		expect(shows('No cap')).toBe(true);
		expect(buttons('Remove cap')).toHaveLength(0);
		fill('Monthly cap', '0');
		await press('Save');
		expect(shows('Enter an amount above zero.')).toBe(true);
		fill('Monthly cap', 'abc');
		await press('Save');
		expect(b.calls.some((c) => c.method === 'PUT' && c.path.endsWith('/spend-cap'))).toBe(false);
		fill('Monthly cap', '50');
		await press('Save');
		await until(() => shows('Spend cap saved'));
		await until(() => shows('50 credits'));
		const put = b.calls.find((c) => c.method === 'PUT' && c.path.endsWith('/spend-cap'));
		expect(put?.status).toBe(200);
		fill('Monthly cap', '1000000000000000');
		await press('Save');
		await settle(2);
		await press('Remove cap');
		await pressDialog('Remove cap');
		await until(() => shows('Spend cap removed'));
		await until(() => shows('No cap'));
		cleanup();
		// a reached cap is explained; removing an already removed cap is harmless or shows the problem
		const cap = await loaders.loadSpendCap(b.api, merchantId);
		if (!cap.ok) throw new Error('spend cap');
		withToasts(
			<SpendCapView
				{...cap}
				cap={{ limit: 1000, spent: 1000, remaining: 0, reached: true, periodEnd: new Date().toISOString() }}
				meter={{ burnRatePerHour: 1000 }}
			/>,
		);
		expect(shows('The spend cap is reached') && shows('Current spend')).toBe(true);
		await press('Remove cap');
		await pressDialog('Remove cap');
		await until(() => b.calls.filter((c) => c.method === 'DELETE' && c.path.endsWith('/spend-cap')).length >= 2);
		await settle(2);
		cleanup();
		render(<SpendCapView ok={false} problem={{ status: 403, title: 'Forbidden', code: 'forbidden' }} />);
		expect(shows('No access')).toBe(true);
		restore();
	});
});
