// @vitest-environment jsdom
/**
 * The Setup page in the browser (jsdom) against a live in-process Portal with fake products (owner request
 * 2026-10-14): the merchant's sheet (the website's facts, a product's panel, a product that did not answer), Refresh,
 * Copy and Download JSON, share links (create once-shown, list, revoke), the admin's page, the Setup button on website
 * cards, and the public shared page (key from the address fragment; without values; a link that does not work).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@ss/ui';
import { act, cleanup, render, type } from '@ss/ui/testing';
import { closeMongoClients } from '../../src/testing.js';
import * as admin from '../../src/console/admin/loaders.js';
import { MerchantsView } from '../../src/console/admin/views/merchants.js';
import { AdminSetupView } from '../../src/console/admin/views/setup.js';
import * as loaders from '../../src/console/loaders.js';
import { MerchantSetupView, SharedSetupView, valueText } from '../../src/console/views/setup.js';
import { startMongo } from '../helpers.js';
import { browserOf, buttons, createWorld, dialog, press, pressDialog, quiet, settle, shows, until } from './merchant-harness.js';

vi.mock('next/navigation.js', async (importOriginal) => {
	const { testRouter } = await import('./router.js');
	return { .../** @type {object} */ (await importOriginal()), useRouter: () => testRouter };
});

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

/** A merchant with one website that has Notes (answers) and Chatty (refuses with 500). @param {string} name */
const world = async (name) => {
	const w = await createWorld({ db: mongo.db(name) });
	const { b, merchantId } = await w.signup('owner@shop.test', 'Shop & Co');
	const site = await w.addWebsite(merchantId, 'shop.example.com');
	const websiteId = String(site.websiteId);
	await w.connect();
	const chatty = await w.connect({ id: 'chatty', name: 'Chatty', widgets: false });
	chatty.tamper.blueprint = 'status_500';
	await w.addProduct(merchantId, websiteId, 'notes');
	await w.addProduct(merchantId, websiteId, 'chatty');
	return { w, b, merchantId, websiteId };
};

describe('Setup page (jsdom)', () => {
	it('shows the merchant the sheet, gathers it again, copies it, and makes, lists and revokes share links', async () => {
		const restore = quiet();
		const { w, b, merchantId, websiteId } = await world('setup_page_merchant');
		try {
			const writeText = vi.fn(async () => undefined);
			vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
			b.use();
			const setup = await loaders.loadSetup(b.api, merchantId, websiteId);
			if (!setup.ok) throw new Error('setup');
			withToasts(
				<MerchantSetupView
					sheet={setup.sheet}
					links={setup.links}
					merchantId={merchantId}
					websiteId={websiteId}
					back={{ href: `/websites/${websiteId}`, label: 'Back to the website' }}
				/>,
			);
			expect(shows('Setup · shop.example.com')).toBe(true);
			expect(shows('Found: Example Shop')).toBe(true);
			expect(shows('https://shop.example.com')).toBe(true);
			expect(shows('Chatty did not answer')).toBe(true);
			expect(shows('It could not be reached. Try Refresh in a moment.')).toBe(true);
			// the product's panel: what is left to do, a feature on with its settings, one off, connections, install, events
			expect(shows('Add the widget script to every page of your website.')).toBe(true);
			expect(shows('Notes per visitor per day10')).toBe(true);
			expect(shows('GreetingLeave us a noteDefault')).toBe(true);
			expect(shows('Off: Notes inbox')).toBe(true);
			expect(shows('Database (MongoDB)')).toBe(true);
			expect(shows('Connected')).toBe(true);
			expect(shows('notes.settings.changed')).toBe(true);
			expect(shows('A server token is issued; it is never shown here.')).toBe(true);
			const download = /** @type {HTMLAnchorElement} */ (
				[...document.querySelectorAll('a')].find((a) => a.textContent === 'Download JSON')
			);
			expect(download.getAttribute('href')).toBe(`/v1/merchants/${merchantId}/websites/${websiteId}/setup?download=1`);

			await press('Copy JSON');
			await until(() => shows('The JSON is in your clipboard.'));
			expect(JSON.parse(String(/** @type {any} */ (writeText.mock.calls[0])?.[0])).schema).toBe('ss.blueprint/1');
			await press('Refresh');
			await b.waitCall('GET', `/v1/merchants/${merchantId}/websites/${websiteId}/setup?fresh=1`, (s) => s === 200);
			await until(() => shows('Setup gathered again.'));

			// share links: refused days, then a link without values, shown once and listed
			expect(shows('No share links yet.')).toBe(true);
			await press('Create share link');
			const days = /** @type {HTMLInputElement} */ (dialog().querySelector('input[type="number"]'));
			await type(days, '45');
			await pressDialog('Create link');
			expect(dialog().textContent).toContain('Enter a whole number of days from 1 to 30.');
			await type(days, '3');
			await act(async () => {
				/** @type {HTMLElement} */ (dialog().querySelector('[role="switch"]')).click();
			});
			await pressDialog('Create link');
			const made = await b.waitCall('POST', `/v1/merchants/${merchantId}/websites/${websiteId}/setup/links`, (s) => s === 201);
			expect(made.body.link).toMatchObject({ values: false, install: true });
			await until(() => dialog().textContent?.includes('Share link created'));
			expect(dialog().textContent).toContain(made.body.url);
			expect(shows('Made by the merchant · Without settings values · Not opened yet')).toBe(true);
			await press('Revoke');
			await b.waitCall('DELETE', `/v1/merchants/${merchantId}/websites/${websiteId}/setup/links/${made.body.link.linkId}`);
			await until(() => shows('Share link revoked. It stops working at once.'));
			expect(shows('Revoked')).toBe(true);
		} finally {
			restore();
			await w.close();
		}
	});

	it('shows the admin the same page with the admin client, and a Setup button on the website card', async () => {
		const restore = quiet();
		const { w, merchantId, websiteId } = await world('setup_page_admin');
		try {
			const { ownerBrowser, owner } = w;
			ownerBrowser.use();
			const list = await admin.loadMerchants(ownerBrowser.api, {});
			const detail = await admin.loadMerchant(ownerBrowser.api, merchantId, owner);
			if (!detail.ok) throw new Error('merchant');
			withToasts(<MerchantsView {...list} detail={detail} selectedId={merchantId} admin={owner} />);
			const setupLink = /** @type {HTMLAnchorElement} */ (document.querySelector('a[aria-label="Setup of shop.example.com"]'));
			expect(setupLink.getAttribute('href')).toBe(`/admin/merchants/${merchantId}/websites/${websiteId}/setup`);
			cleanup();
			const setup = await loaders.loadSetup(ownerBrowser.api, merchantId, websiteId);
			if (!setup.ok) throw new Error('setup');
			withToasts(
				<AdminSetupView
					sheet={setup.sheet}
					links={setup.links}
					merchantId={merchantId}
					websiteId={websiteId}
					back={{ href: '/admin', label: 'Back to the website' }}
				/>,
			);
			await press('Create share link');
			await pressDialog('Create link');
			await ownerBrowser.waitCall('POST', `/v1/merchants/${merchantId}/websites/${websiteId}/setup/links`, (s) => s === 201);
			await until(() => shows('Made by an admin · Shows everything'));
			// Finance sees no Setup button (no Install and tokens either)
			cleanup();
			const finance = await w.adminOf('finance');
			finance.b.use();
			const financeDetail = await admin.loadMerchant(finance.b.api, merchantId, finance.admin);
			if (!financeDetail.ok) throw new Error('merchant');
			withToasts(
				<MerchantsView
					{...await admin.loadMerchants(finance.b.api, {})}
					detail={financeDetail}
					selectedId={merchantId}
					admin={finance.admin}
				/>,
			);
			expect(document.querySelector('a[aria-label="Setup of shop.example.com"]')).toBeNull();
		} finally {
			restore();
			await w.close();
		}
	});

	it('opens a shared copy from the key in the address fragment, read-only, and says when a link does not work', async () => {
		const restore = quiet();
		const { w, b, merchantId, websiteId } = await world('setup_page_shared');
		try {
			const made = await b.api.post(`/v1/merchants/${merchantId}/websites/${websiteId}/setup/links`, { values: false });
			if (!made.ok) throw new Error('link');
			const key = String(made.data.url).split('#key=')[1];
			const visitor = browserOf(w.portal);
			visitor.use();
			const createObjectURL = vi.fn(() => 'blob:setup');
			const revokeObjectURL = vi.fn();
			Object.assign(URL, { createObjectURL, revokeObjectURL });
			window.history.replaceState(null, '', `/shared-setup#key=${key}`);
			render(<SharedSetupView brand="Single Solution" />);
			await until(() => shows('Setup of shop.example.com'));
			expect(window.location.hash).toBe('');
			expect(shows('Settings values are not part of this copy.')).toBe(true);
			expect(shows('This copy works until')).toBe(true);
			expect(buttons('Refresh')).toEqual([]);
			expect(shows('Share links')).toBe(false);
			const call = await visitor.waitCall('POST', '/v1/setup/shared');
			expect(call.status).toBe(200);
			await press('Download JSON');
			expect(createObjectURL).toHaveBeenCalledTimes(1);
			expect(revokeObjectURL).toHaveBeenCalledWith('blob:setup');
			cleanup();

			// no key, and a revoked link
			window.history.replaceState(null, '', '/shared-setup');
			render(<SharedSetupView brand="Single Solution" />);
			await until(() => shows('This share link does not work'));
			cleanup();
			await b.api.request('DELETE', `/v1/merchants/${merchantId}/websites/${websiteId}/setup/links/${made.data.link.linkId}`);
			window.history.replaceState(null, '', `/shared-setup#key=${key}`);
			render(<SharedSetupView brand="Single Solution" />);
			await until(() => shows('It may have expired or been revoked.'));
			await settle();
		} finally {
			restore();
			await w.close();
		}
	});

	it('words setting values', () => {
		expect([true, false, [], ['a', 2], '', null, { a: 1 }, 7].map(valueText)).toEqual([
			'Yes',
			'No',
			'None',
			'a, 2',
			'None',
			'None',
			'{"a":1}',
			'7',
		]);
	});
});
