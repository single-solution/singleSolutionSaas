// @vitest-environment jsdom
/**
 * The website page in the browser (jsdom) against a live in-process Portal with fake products (PLAN 0.8.2, 0.5.9, 0.4.4):
 * the same page in the Admin Console and the Portal — products (Open through the right launch route, Add product in a
 * drawer with its refusals, Remove with a typed confirmation of the product name), Remove website (disabled with
 * `Remove its products first` while products remain, then a typed confirmation of the domain), the Install and tokens
 * page (script tag, browser token, server token reveal / copy / regenerate with a typed confirmation,
 * `Cannot be shown: regenerate`), the Usage page, and what each role sees.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@ss/ui';
import { act, cleanup, keydown, render, type } from '@ss/ui/testing';
import { closeMongoClients } from '../../src/testing.js';
import * as admin from '../../src/console/admin/loaders.js';
import { AdminWebsiteView, SITE_PILLS } from '../../src/console/admin/views/website.js';
import * as loaders from '../../src/console/loaders.js';
import { WebsiteView, WebsitesView } from '../../src/console/views/websites.js';
import { InstallBlock, twoStepOnOf } from '../../src/console/views/website.js';
import { WebsitePageView } from '../../src/console/views/website-page.js';
import { startMongo } from '../helpers.js';
import { totpCode } from '../../src/infra/auth.js';
import {
	button,
	buttons,
	clickEl,
	createWorld,
	dialog,
	fillDialog,
	press,
	pressDialog,
	pressMenu,
	quiet,
	settle,
	shows,
	until,
} from './merchant-harness.js';
import { testRouter } from './router.js';

/**
 * Confirm the Open configure password/OTP dialog and wait for the launch.
 * @returns {Promise<any>}
 */
const confirmOpen = async (/** @type {any} */ browser, /** @type {string} */ path) => {
	const codeLabel = [...dialog().querySelectorAll('label')].find((l) => /code/i.test(l.textContent ?? ''));
	if (codeLabel) {
		let code = browser.totpSecret ? totpCode(browser.totpSecret, Date.now()) : null;
		if (!code) {
			await browser.api.post('/v1/me/step-up-otp', {});
			if (browser.world?.lastOtp) code = browser.world.lastOtp();
		}
		fillDialog('Two-step or recovery code', code || '123456');
	} else {
		fillDialog('Your password', browser.password);
	}
	const fromIndex = browser.calls.length;
	await pressDialog('Open configure');
	const found = await until(() => {
		const call = browser.calls.slice(fromIndex).find((/** @type {any} */ c) => c.method === 'POST' && c.path === path);
		if (!call) return false;
		return call;
	});
	await settle(3);
	return found;
};

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

/**
 * Answer the page's API calls (`fetch`) with `answer`, one API result per call; each call is kept in `seen` as
 * `[path, { method, body? }]`.
 * @param {(path: string, init: { method: string, body?: unknown }) => Promise<any>} answer
 * @param {Array<[string, any]>} [seen]
 */
const stubApi = (answer, seen = []) => {
	vi.stubGlobal('fetch', async (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) => {
		const call = { method: init.method ?? 'GET', ...(init.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) };
		seen.push([String(path), call]);
		const result = await answer(String(path), call);
		return new Response(JSON.stringify(result.ok ? result.data : result.problem), { status: result.status });
	});
	return seen;
};

/** @param {import('react').ReactNode} node */
const withToasts = (node) => render(<ToastProvider durationMs={600_000}>{node}</ToastProvider>);

/** The typed confirmation input of the open dialog. */
const confirmInput = () => {
	const label = [...dialog().querySelectorAll('label')].find((l) => /^Type .* to confirm/.test(l.textContent ?? ''));
	if (!label) throw new Error('no typed confirmation');
	return /** @type {HTMLInputElement} */ (document.getElementById(/** @type {HTMLLabelElement} */ (label).htmlFor));
};

/**
 * The claims of a launch URL's token (decoded, not verified).
 * @param {string} url
 */
const claimsOf = (url) => {
	const token = String(new URL(url).searchParams.get('launch'));
	return JSON.parse(Buffer.from(String(token.split('.')[1]), 'base64url').toString('utf8'));
};

/** Close the open dialog. */
const closeDialog = () => clickEl(/** @type {Element} */ (dialog().querySelector('button[aria-label="Close"]')));

/** Open an actions menu by its label. @param {string} label */
const menu = (label) => clickEl(/** @type {Element} */ (document.querySelector(`button[aria-label="${label}"]`)));

/** @param {string} label */
const menuItem = (label) =>
	/** @type {HTMLButtonElement} */ ([...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent === label));

describe('website page (jsdom)', () => {
	it('drives the website page in the Admin Console as the Owner: products, tokens, usage and Remove website', async () => {
		const restore = quiet();
		const world = await createWorld({ db: mongo.db('website_owner') });
		try {
			const { ownerBrowser } = world;
			const { merchantId } = await world.signup('owner@shop.test', 'Shop & Co');
			const site = await world.addWebsite(merchantId, 'shop.example.com');
			const websiteId = String(site.websiteId);
			await world.connect();
			await world.connect({ id: 'chatty', name: 'Chatty', widgets: false });
			await world.connect({ id: 'gamma', name: 'Gamma' }, { active: false });
			await world.addProduct(merchantId, websiteId, 'notes');
			const open = vi.fn();
			vi.stubGlobal('open', open);
			const writeText = vi.fn(async () => undefined);
			vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
			ownerBrowser.use();
			const owner = world.owner;
			const detail = await admin.loadAdminWebsite(ownerBrowser.api, merchantId, websiteId, '', owner);
			if (!detail.ok) throw new Error('website');
			withToasts(<AdminWebsiteView detail={detail} admin={owner} />);
			expect(document.querySelector('h1')?.textContent).toBe('shop.example.com');
			expect(shows('No features on')).toBe(true);

			// ---------------------------------------------------------------- Open: password confirm, then the admin launch
			await press('Open Notes');
			const launched = await confirmOpen(ownerBrowser, '/v1/admin/products/notes/launch');
			expect(open).toHaveBeenCalledWith(launched.body.url, '_blank', 'noopener,noreferrer');
			expect(claimsOf(launched.body.url)).toMatchObject({ kind: 'admin', admin: { role: 'owner', websiteId } });

			// ---------------------------------------------------------------- a product's old address is the same home at its row; Open and Remove
			expect(document.querySelector('#product-notes')).not.toBeNull();
			cleanup();
			const notesPage = await admin.loadAdminWebsite(ownerBrowser.api, merchantId, websiteId, 'products/notes', owner);
			if (!notesPage.ok) throw new Error('product page');
			withToasts(<AdminWebsiteView detail={notesPage} admin={owner} />);
			expect(document.querySelector('#product-notes')).not.toBeNull();
			open.mockClear();
			await press('Open Notes');
			await confirmOpen(ownerBrowser, '/v1/admin/products/notes/launch');
			await until(() => open.mock.calls.length === 1);
			await pressMenu('Actions for Notes', 'Remove');
			expect(shows('Remove Notes')).toBe(true);
			await closeDialog();
			cleanup();
			withToasts(<AdminWebsiteView detail={detail} admin={owner} />);

			// ---------------------------------------------------------------- Remove website is disabled while products remain
			await menu('More actions');
			expect(menuItem('Remove website').disabled).toBe(true);
			expect(shows('Remove its products first')).toBe(true);
			await menu('More actions');
			expect(document.querySelector('[role="menu"]')).toBeNull();
			// Escape and a click outside close the menu
			await menu('More actions');
			keydown(document, 'Escape');
			expect(document.querySelector('[role="menu"]')).toBeNull();
			await menu('More actions');
			await act(async () => {
				document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
			});
			expect(document.querySelector('[role="menu"]')).toBeNull();
			// Visit website opens the domain in a new tab; Copy domain copies it
			await menu('More actions');
			await clickEl(menuItem('Visit website'));
			expect(open).toHaveBeenCalledWith('https://shop.example.com', '_blank', 'noopener,noreferrer');
			await menu('More actions');
			await clickEl(menuItem('Copy domain'));
			await until(() => shows('Copied.'));
			expect(writeText).toHaveBeenCalledWith('shop.example.com');

			// ---------------------------------------------------------------- Add product, in a drawer: active products not on it
			await press('Add product');
			expect(dialog().textContent).toContain('Chatty');
			expect(dialog().textContent).not.toContain('Gamma'); // inactive
			expect(dialog().textContent).not.toContain('Notes'); // already on
			// refused: the product was set inactive meanwhile
			await ownerBrowser.api.post('/v1/admin/products/chatty/status', { status: 'inactive' });
			await pressDialog('Add Chatty');
			await ownerBrowser.waitCall('POST', `/v1/merchants/${merchantId}/websites/${websiteId}/products`, (/** @type {any} */ st) => st === 409);
			expect(shows('This product is not offered: it is not connected or it is inactive.')).toBe(true);
			await ownerBrowser.api.post('/v1/admin/products/chatty/status', { status: 'active' });
			await pressDialog('Add Chatty');
			await ownerBrowser.waitCall('POST', `/v1/merchants/${merchantId}/websites/${websiteId}/products`, (/** @type {any} */ st) => st === 201);
			await until(() => shows('Chatty added.'));
			expect(testRouter.push).toHaveBeenLastCalledWith(`/admin/merchants/${merchantId}/websites/${websiteId}/products/chatty`);
			expect(buttons('Actions for Chatty')).toHaveLength(1);
			// nothing left to add
			await press('Add product');
			expect(
				shows(
					'No product to add: every active product is already on this website. A newly connected product starts inactive; set it active in Products first.',
				),
			).toBe(true);
			await closeDialog();

			// ---------------------------------------------------------------- Remove: typed confirmation of the product name
			await pressMenu('Actions for Chatty', 'Remove');
			expect(shows('Remove Chatty')).toBe(true);
			expect(button('Remove', dialog()).disabled).toBe(true);
			type(confirmInput(), 'chatty');
			expect(button('Remove', dialog()).disabled).toBe(true);
			type(confirmInput(), 'Chatty');
			await pressDialog('Remove');
			await ownerBrowser.waitCall(
				'DELETE',
				`/v1/merchants/${merchantId}/websites/${websiteId}/products/chatty`,
				(/** @type {any} */ st) => st === 200,
			);
			await until(() => shows('Chatty removed.'));
			expect(buttons('Actions for Chatty')).toHaveLength(0);
			cleanup();

			// ---------------------------------------------------------------- Install and Usage redirect away (A1)
			const installDetail = await admin.loadAdminWebsite(ownerBrowser.api, merchantId, websiteId, 'install', owner);
			withToasts(<AdminWebsiteView detail={installDetail} admin={owner} />);
			await settle(2);
			expect(testRouter.push).toHaveBeenLastCalledWith(`/admin/merchants/${merchantId}/websites/${websiteId}`);
			cleanup();
			const usageDetail = await admin.loadAdminWebsite(ownerBrowser.api, merchantId, websiteId, 'usage', owner);
			withToasts(<AdminWebsiteView detail={usageDetail} admin={owner} />);
			await settle(2);
			expect(testRouter.push).toHaveBeenLastCalledWith(`/admin/merchants/${merchantId}/websites/${websiteId}`);
			cleanup();

			// ---------------------------------------------------------------- Developer pack: OTP step-up -> pack JSON (A2 + A5)
			withToasts(<AdminWebsiteView detail={detail} admin={owner} />);
			expect(buttons('Share with developer')).toHaveLength(1);
			await press('Share with developer');
			expect(shows('Developer pack')).toBe(true);
			await ownerBrowser.api.post('/v1/me/step-up-otp', {});
			const packOtp = world.lastOtp(owner.email) || '123456';
			fillDialog('Two-step or recovery code', packOtp);
			await pressDialog('Download developer pack');
			const packCall = await ownerBrowser.waitCall(
				'POST',
				`/v1/merchants/${merchantId}/websites/${websiteId}/pack`,
				(/** @type {any} */ st) => st === 200,
			);
			expect(packCall.body).toMatchObject({
				docsHubUrl: expect.stringContaining('/docs'),
				domain: 'shop.example.com',
				products: expect.arrayContaining([
					expect.objectContaining({
						id: 'notes',
						name: 'Notes',
						browserToken: expect.any(String),
						serverToken: expect.any(String),
					}),
				]),
			});
			await until(() => shows('Developer pack downloaded.'));
			cleanup();

			// ---------------------------------------------------------------- Remove website once its products are removed
			const before = await admin.loadAdminWebsite(ownerBrowser.api, merchantId, websiteId, '', owner);
			withToasts(<AdminWebsiteView detail={before} admin={owner} />);
			await pressMenu('Actions for Notes', 'Remove');
			type(confirmInput(), 'Notes');
			await pressDialog('Remove');
			await ownerBrowser.waitCall(
				'DELETE',
				`/v1/merchants/${merchantId}/websites/${websiteId}/products/notes`,
				(/** @type {any} */ st) => st === 200,
			);
			await until(() => shows('No products on this website yet.'));
			cleanup();
			const emptyInstall = await admin.loadAdminWebsite(ownerBrowser.api, merchantId, websiteId, 'install', owner);
			withToasts(<AdminWebsiteView detail={emptyInstall} admin={owner} />);
			await until(() => shows('No products on this website yet.')); // no cards, so no tokens either
			cleanup();
			const empty = await admin.loadAdminWebsite(ownerBrowser.api, merchantId, websiteId, '', owner);
			withToasts(<AdminWebsiteView detail={empty} admin={owner} />);
			await menu('More actions');
			expect(menuItem('Remove website').disabled).toBe(false);
			await clickEl(menuItem('Remove website'));
			expect(shows('Remove shop.example.com')).toBe(true);
			await closeDialog();
			expect(dialog).toThrow();
			await menu('More actions');
			await clickEl(menuItem('Remove website'));
			type(confirmInput(), 'shop.example.co');
			expect(button('Remove website', dialog()).disabled).toBe(true);
			type(confirmInput(), 'shop.example.com');
			await pressDialog('Remove website');
			const removed = await ownerBrowser.waitCall('DELETE', `/v1/merchants/${merchantId}/websites/${websiteId}`);
			expect(removed.status).toBe(200);
			await until(() => shows('shop.example.com removed.'));
			expect(testRouter.push).toHaveBeenLastCalledWith(`/admin/merchants/${merchantId}`); // up to the merchant's page
			cleanup();

			// a refused removal (the website is gone) shows the problem in the dialog
			const stale = { ...detail, rows: detail.rows.map((r) => ({ ...r, cards: [] })) };
			withToasts(<AdminWebsiteView detail={stale} admin={owner} />);
			await menu('More actions');
			await clickEl(menuItem('Remove website'));
			type(confirmInput(), 'shop.example.com');
			await pressDialog('Remove website');
			await until(() => shows('No such website.'));
			cleanup();
		} finally {
			await world.close();
			restore();
		}
	});

	it('opens dashboards through the right launch route for the merchant, Support and Finance', async () => {
		const restore = quiet();
		const world = await createWorld({ db: mongo.db('website_roles') });
		try {
			const { b: merchant, merchantId } = await world.signup('owner@shop.test', 'Shop & Co');
			const site = await world.addWebsite(merchantId, 'shop.example.com');
			const websiteId = String(site.websiteId);
			await world.connect();
			await world.addProduct(merchantId, websiteId, 'notes');
			const open = vi.fn();
			vi.stubGlobal('open', open);

			// the merchant: product rows home; Add product (A3); Share with developer (A2); Open (A5)
			merchant.use();
			withToasts(<WebsiteView {...await loaders.loadWebsitePage(merchant.api, merchantId, websiteId, '')} />);
			expect(document.querySelector('h1')?.textContent).toBe('shop.example.com');
			expect(document.querySelector('nav[aria-label="Breadcrumb"] a')?.getAttribute('href')).toBe('/websites');
			expect(document.querySelector('#product-notes')).not.toBeNull();
			expect(buttons('Add product')).toHaveLength(1);
			expect(buttons('Share with developer')).toHaveLength(1);
			// the merchant's website menu: Visit website and Copy domain, never Remove website
			await menu('More actions');
			expect(menuItem('Visit website')).toBeTruthy();
			expect(menuItem('Remove website')).toBeUndefined();
			keydown(document, 'Escape');
			// a product's row: Open and Actions (A3 merchant removal)
			expect(buttons('Open Notes')).toHaveLength(1);
			expect(buttons('Actions for Notes')).toHaveLength(1);
			expect(shows('Your admin adds products to this website.')).toBe(false);
			await press('Open Notes');
			const mine = await confirmOpen(merchant, `/v1/merchants/${merchantId}/websites/${websiteId}/products/notes/launch`);
			expect(open).toHaveBeenLastCalledWith(mine.body.url, '_blank', 'noopener,noreferrer');
			cleanup();
			// Install ceremony redirects away (A1)
			withToasts(<WebsiteView {...await loaders.loadWebsitePage(merchant.api, merchantId, websiteId, 'install')} />);
			await settle(2);
			expect(testRouter.push).toHaveBeenLastCalledWith(`/websites/${websiteId}`);
			cleanup();
			// the list filters by domain
			withToasts(<WebsitesView {...await loaders.loadWebsites(merchant.api, merchantId)} />);
			expect(document.querySelector(`a[href="/websites/${websiteId}"]`)?.textContent).toBe('shop.example.com');
			const search = /** @type {HTMLInputElement} */ (document.querySelector('input[aria-label="Search domains"]'));
			await act(async () => {
				type(search, 'nothing');
				search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
			});
			expect(shows('No match for "nothing"')).toBe(true);
			expect(shows('Clear search')).toBe(true);
			cleanup();

			// Support: the admin launch with the website id; Share with developer and Setup as header actions
			const { admin: support, b: supportBrowser } = await world.adminOf('support');
			supportBrowser.use();
			withToasts(
				<AdminWebsiteView
					detail={await admin.loadAdminWebsite(supportBrowser.api, merchantId, websiteId, '', support)}
					admin={support}
				/>,
			);
			await press('Open Notes');
			const theirs = await confirmOpen(supportBrowser, '/v1/admin/products/notes/launch');
			expect(open).toHaveBeenLastCalledWith(theirs.body.url, '_blank', 'noopener,noreferrer');
			expect(buttons('Share with developer').length + buttons('Setup sheet').length).toBeGreaterThan(0);
			expect(buttons('Reveal')).toHaveLength(0);
			cleanup();

			// Finance: no Share pack, no Open, no admin actions
			const { admin: finance, b: financeBrowser } = await world.adminOf('finance');
			financeBrowser.use();
			withToasts(
				<AdminWebsiteView
					detail={await admin.loadAdminWebsite(financeBrowser.api, merchantId, websiteId, '', finance)}
					admin={finance}
				/>,
			);
			expect(shows('Notes')).toBe(true);
			expect(buttons('Actions for Notes')).toHaveLength(0);
			expect(buttons('Add product')).toHaveLength(0);
			await menu('More actions');
			expect(menuItem('Remove website')).toBeUndefined();
			keydown(document, 'Escape');
			expect(buttons('Open Notes')).toHaveLength(0);
			expect(buttons('Reveal')).toHaveLength(0);
			expect(buttons('Setup sheet')).toHaveLength(0);
			expect(buttons('Share with developer')).toHaveLength(0);
			expect(financeBrowser.calls.some((/** @type {any} */ c) => c.path.endsWith('/tokens'))).toBe(false);
			cleanup();
			// Finance has no Install page: the address redirects away (A1)
			withToasts(
				<AdminWebsiteView
					detail={await admin.loadAdminWebsite(financeBrowser.api, merchantId, websiteId, 'install', finance)}
					admin={finance}
				/>,
			);
			await settle(2);
			expect(testRouter.push).toHaveBeenLastCalledWith(`/admin/merchants/${merchantId}/websites/${websiteId}`);
			expect(financeBrowser.calls.some((/** @type {any} */ c) => c.path.endsWith('/tokens'))).toBe(false);
			cleanup();

			// a refused launch (the merchant is suspended: its sessions end) shows a toast and opens nothing
			const calls = open.mock.calls.length;
			merchant.use();
			withToasts(<WebsiteView {...await loaders.loadWebsitePage(merchant.api, merchantId, websiteId, '')} />);
			await world.ownerBrowser.api.post(`/v1/admin/merchants/${merchantId}/suspend`, { reason: 'check' });
			await press('Open Notes');
			await confirmOpen(merchant, `/v1/merchants/${merchantId}/websites/${websiteId}/products/notes/launch`);
			expect(open.mock.calls.length).toBe(calls);
			cleanup();
		} finally {
			await world.close();
			restore();
		}
	});

	it('lists the websites as rich rows beside the open page; chips and search narrow them; old addresses open at their section', async () => {
		const restore = quiet();
		const world = await createWorld({ db: mongo.db('website_list') });
		try {
			const { b: merchant, merchantId } = await world.signup('owner@shop.test', 'Shop & Co');
			const shop = await world.addWebsite(merchantId, 'shop.example.com');
			const bare = await world.addWebsite(merchantId, 'bare.example.com');
			const notes = await world.connect();
			await world.addProduct(merchantId, String(shop.websiteId), 'notes');
			await world.switchFeatures(notes, shop.websiteId, ['notes']);
			merchant.use();

			// the list's own address: a row per website (a link, its status, what it has or lacks), the first one open
			withToasts(<WebsitesView {...await loaders.loadWebsites(merchant.api, merchantId)} />);
			await settle(2);
			const rowOf = (/** @type {string} */ id) => document.querySelector(`a[href="/websites/${id}"]`);
			const rowText = (/** @type {string} */ id) =>
				rowOf(id)?.closest('li, [role="listitem"], div')?.parentElement?.textContent;
			expect(rowText(String(shop.websiteId))).toContain('Notes');
			expect(rowText(String(bare.websiteId))).toContain('No products yet');
			expect(document.querySelector('#product-notes')).not.toBeNull();
			expect(shows('Open Notes') || shows('Products')).toBe(true);
			// the chips filter by status, the search by domain
			expect(buttons('No features on1')).toHaveLength(1);
			await clickEl(/** @type {HTMLElement} */ (buttons('No features on1')[0]));
			expect(rowOf(String(shop.websiteId))).toBeNull();
			expect(rowOf(String(bare.websiteId))).not.toBeNull();
			await clickEl(/** @type {HTMLElement} */ (buttons('All2')[0]));
			expect(rowOf(String(shop.websiteId))).not.toBeNull();
			const search = /** @type {HTMLInputElement} */ (document.querySelector('input[aria-label="Search domains"]'));
			await act(async () => {
				type(search, 'bare');
			});
			expect(rowOf(String(shop.websiteId))).toBeNull();
			expect(rowOf(String(bare.websiteId))).not.toBeNull();
			cleanup();

			// Settings is a header action to its own address (Install was retired in A1)
			withToasts(<WebsiteView {...await loaders.loadWebsitePage(merchant.api, merchantId, String(shop.websiteId), '')} />);
			await settle(2);
			await press('Settings');
			expect(testRouter.push).toHaveBeenLastCalledWith(`/websites/${shop.websiteId}/settings`);
			cleanup();

			// on a phone the list stands alone until a website is picked
			const listeners = new Set();
			vi.stubGlobal('matchMedia', () => ({
				matches: true,
				addEventListener: (/** @type {string} */ _type, /** @type {() => void} */ fn) => listeners.add(fn),
				removeEventListener: (/** @type {string} */ _type, /** @type {() => void} */ fn) => listeners.delete(fn),
			}));
			withToasts(<WebsitesView {...await loaders.loadWebsites(merchant.api, merchantId)} />);
			await settle(2);
			expect(rowOf(String(shop.websiteId))).not.toBeNull();
			expect(listeners.size).toBeGreaterThan(0);
			cleanup();
			// ...and a picked website has a Back button to it
			withToasts(<WebsiteView {...await loaders.loadWebsitePage(merchant.api, merchantId, String(shop.websiteId), '')} />);
			await settle(2);
			await press('Back to the list');
			expect(testRouter.push).toHaveBeenLastCalledWith('/websites');
			cleanup();
			expect(listeners.size).toBe(0);
			vi.unstubAllGlobals();

			// an old product address opens the page at that product's card
			const scrolled = vi.fn();
			/** @this {HTMLElement} */
			const scrollIntoView = function () {
				scrolled(this.id);
			};
			Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: scrollIntoView, configurable: true });
			try {
				withToasts(
					<WebsiteView
						{...await loaders.loadWebsitePage(merchant.api, merchantId, String(shop.websiteId), 'products/notes')}
					/>,
				);
				await settle(2);
				expect(scrolled).toHaveBeenCalledWith('product-notes');
				cleanup();
				scrolled.mockClear();
				withToasts(
					<WebsiteView {...await loaders.loadWebsitePage(merchant.api, merchantId, String(shop.websiteId), 'changes')} />,
				);
				await settle(2);
				expect(testRouter.push).toHaveBeenLastCalledWith(`/websites/${shop.websiteId}`);
				cleanup();
			} finally {
				// @ts-expect-error jsdom has no scrollIntoView of its own
				delete HTMLElement.prototype.scrollIntoView;
			}

			// a website that is not there says so and leaves the list
			withToasts(<WebsiteView {...await loaders.loadWebsitePage(merchant.api, merchantId, 'web_none', '')} />);
			await settle(2);
			expect(shows('This website does not exist or was removed.')).toBe(true);
			expect(rowOf(String(shop.websiteId))).not.toBeNull();
		} finally {
			await world.close();
			restore();
		}
	});

	it('redirects old install and usage addresses to the website home', async () => {
		stubApi(async () => ({ ok: false, status: 500, problem: { status: 500, title: 'Boom' } }));
		const props = {
			website: { websiteId: 'web_1', merchantId: 'mer_1', domain: 'shop.com' },
			cards: [],
			crumbs: [{ label: 'Websites', href: '/websites' }],
			hrefOf: (/** @type {string} */ part) => `/websites/web_1${part ? `/${part}` : ''}`,
			can: { manage: true, removeWebsite: false, tokens: true, open: false, settings: false },
			pills: SITE_PILLS,
			launch: () => ({ path: '/x' }),
			afterRemoved: '/websites',
		};
		withToasts(<WebsitePageView {...props} part="" />);
		expect(shows('No products on this website yet.')).toBe(true);
		// Add product with nothing to offer (no list passed)
		await press('Add product');
		expect(
			shows(
				'No product to add: every active product is already on this website. A newly connected product starts inactive; set it active in Products first.',
			),
		).toBe(true);
		await closeDialog();
		cleanup();
		withToasts(<WebsitePageView {...props} part="install" />);
		await settle(2);
		expect(testRouter.push).toHaveBeenLastCalledWith('/websites/web_1');
		cleanup();
		withToasts(<WebsitePageView {...props} part="usage" />);
		await settle(2);
		expect(testRouter.push).toHaveBeenLastCalledWith('/websites/web_1');
	});

	it('shows `Cannot be shown: regenerate` and other token failures', async () => {
		const entry = {
			productId: 'notes',
			name: 'Notes',
			widgetScriptUrl: null,
			widgetScriptLoading: /** @type {const} */ ('async'),
			docsUrl: null,
			browserToken: 'browser-token',
			serverToken: { canShow: true },
		};
		/** @type {(path: string, init?: any) => Promise<any>} */
		let answer = async () => ({ ok: false, status: 409, problem: { status: 409, detail: 'Cannot be shown: regenerate.' } });
		const seen = stubApi((path, init) => answer(path, init));
		withToasts(<InstallBlock entry={entry} domain="shop.com" merchantId="mer_1" websiteId="web_1" />);
		expect(shows('Widget script tag')).toBe(false); // no widgets
		expect(document.querySelector('a')).toBeNull(); // no docs
		await press('Reveal');
		fillDialog('Your password', 'secret pass');
		await pressDialog('Show token');
		await until(() => shows('Cannot be shown: regenerate'));
		expect(buttons('Reveal')).toHaveLength(0);
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		// the password goes with the request, and nothing else is asked of a person without two-step
		expect(seen[0]).toEqual([
			'/v1/merchants/mer_1/websites/web_1/tokens/notes/reveal',
			{ method: 'POST', body: { password: 'secret pass' } },
		]);
		// a failed regenerate keeps the dialog open with the problem
		answer = async () => ({ ok: false, status: 500, problem: { status: 500, title: 'Boom' } });
		await press('Regenerate');
		type(confirmInput(), 'Notes');
		fillDialog('Your password', 'secret pass');
		await pressDialog('Regenerate');
		await until(() => dialog().textContent?.includes('Something went wrong on our side.'));
		answer = async () => ({ ok: true, status: 200, data: { productId: 'notes', kind: 'server', token: 'fresh-server-token' } });
		await pressDialog('Regenerate');
		await until(() => shows('fresh-server-token'));
		expect(seen.at(-1)).toEqual([
			'/v1/merchants/mer_1/websites/web_1/tokens/notes/regenerate',
			{ method: 'POST', body: { kind: 'server', password: 'secret pass' } },
		]);
		// copying the shown token needs no new reveal
		vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => undefined) } });
		const before = seen.length;
		await press('Copy', /** @type {HTMLElement} */ (button('Regenerate').parentElement));
		expect(seen.length).toBe(before);
		cleanup();

		// a stored token that cannot be decrypted shows the message at once; another reveal failure is shown in the dialog
		withToasts(
			<InstallBlock
				entry={{ ...entry, serverToken: { canShow: false } }}
				domain="shop.com"
				merchantId="mer_1"
				websiteId="web_1"
			/>,
		);
		expect(shows('Cannot be shown: regenerate')).toBe(true);
		cleanup();
		answer = async () => ({ ok: false, status: 403, problem: { status: 403, detail: 'Not yours.', type: 'forbidden' } });
		withToasts(<InstallBlock entry={entry} domain="shop.com" merchantId="mer_1" websiteId="web_1" />);
		await press('Copy', /** @type {HTMLElement} */ (button('Regenerate').parentElement));
		fillDialog('Your password', 'secret pass');
		await pressDialog('Show token');
		await until(() => dialog().textContent?.includes('Not yours.'));
		await settle(1);
	});

	it('asks for the password, then the two-step code while two-step is on, and says plainly what was wrong', async () => {
		const entry = {
			productId: 'notes',
			name: 'Notes',
			widgetScriptUrl: null,
			widgetScriptLoading: /** @type {const} */ ('async'),
			docsUrl: null,
			browserToken: 'browser-token',
			serverToken: { canShow: true },
		};
		/** @type {(path: string, init?: any) => Promise<any>} */
		let answer = async () => ({ ok: true, status: 200, data: { serverToken: 'the-server-token' } });
		const seen = stubApi((path, init) => answer(path, init));
		const writeText = vi.fn(async () => undefined);
		vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
		// a wrong password or code answers 401 too, but the session is fine: the person stays on the form
		const assign = vi.fn();
		vi.stubGlobal('location', { ...window.location, pathname: '/websites', search: '', assign });
		// without a code the Portal asks for one; the field appears with the reason
		answer = async () => ({
			ok: false,
			status: 422,
			problem: {
				status: 422,
				type: 'validation_failed',
				errors: [{ path: '/code', message: 'is required while two-step is on' }],
			},
		});
		withToasts(<InstallBlock entry={entry} domain="shop.com" merchantId="mer_1" websiteId="web_1" />);
		await press('Copy', /** @type {HTMLElement} */ (button('Regenerate').parentElement));
		expect(shows('Two-step or recovery code')).toBe(false);
		fillDialog('Your password', 'right pass');
		await pressDialog('Show token');
		await until(() => shows('Two-step sign-in is on for you: enter a code from your app, or a recovery code.'));
		expect(shows('Two-step or recovery code')).toBe(true);
		// a wrong code is said as a wrong code, not as a wrong password
		answer = async () => ({
			ok: false,
			status: 401,
			problem: { status: 401, type: 'invalid_credentials', detail: 'The code is incorrect.' },
		});
		fillDialog('Two-step or recovery code', '123456');
		await pressDialog('Show token');
		await until(() => shows('That code is not right.'));
		expect(shows('That password is not right')).toBe(false);
		// ... and a wrong password is said under the password
		answer = async () => ({
			ok: false,
			status: 401,
			problem: { status: 401, type: 'invalid_credentials', detail: 'The email or password is incorrect.' },
		});
		await pressDialog('Show token');
		await until(() => shows('That password is not right. Check it and try again.'));
		expect(assign).not.toHaveBeenCalled();
		// too many tries: said under the fields
		answer = async () => ({ ok: false, status: 429, problem: { status: 429, type: 'rate_limited', title: 'Too many' } });
		await pressDialog('Show token');
		await until(() => shows('Too many attempts. Wait a moment, then try again.'));
		// a six-digit code goes as a code, a longer one as a recovery code, with the password; the token is then copied
		answer = async () => ({ ok: true, status: 200, data: { serverToken: 'the-server-token' } });
		fillDialog('Two-step or recovery code', '654321');
		await pressDialog('Show token');
		await until(() => writeText.mock.calls.length === 1);
		expect(writeText).toHaveBeenCalledWith('the-server-token');
		expect(seen.at(-1)).toEqual([
			'/v1/merchants/mer_1/websites/web_1/tokens/notes/reveal',
			{ method: 'POST', body: { password: 'right pass', code: '654321' } },
		]);
		await until(() => shows('Copied to the clipboard.'));
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		// only an ended session goes to sign-in (the token is not shown yet in a new block)
		cleanup();
		answer = async () => ({ ok: false, status: 401, problem: { status: 401, type: 'unauthorized' } });
		withToasts(<InstallBlock entry={entry} domain="shop.com" merchantId="mer_1" websiteId="web_1" twoStepOn />);
		await press('Reveal');
		expect(shows('Two-step or recovery code')).toBe(true); // two-step on: the code is asked for at once
		fillDialog('Your password', 'right pass');
		fillDialog('Two-step or recovery code', '654321');
		await pressDialog('Show token');
		await until(() => assign.mock.calls.length === 1);
		expect(assign).toHaveBeenCalledWith('/login?next=%2Fwebsites&expired=1');
	});

	it('knows from the signed-in person’s answer whether two-step is on', () => {
		const ok = (/** @type {object} */ data) => ({ ok: /** @type {const} */ (true), status: 200, data });
		expect(twoStepOnOf(ok({ kind: 'admin', admin: { twoStep: { enabled: true } } }))).toBe(true);
		expect(twoStepOnOf(ok({ kind: 'merchant', merchant: { twoStep: { enabled: true } } }))).toBe(true);
		expect(twoStepOnOf(ok({ kind: 'merchant', merchant: { twoStep: { enabled: false } } }))).toBe(false);
		expect(twoStepOnOf(ok({ kind: 'admin', admin: {} }))).toBe(false);
		expect(twoStepOnOf(null)).toBe(false);
		expect(twoStepOnOf({ ok: false, status: 401, problem: { status: 401 } })).toBe(false);
	});
});
