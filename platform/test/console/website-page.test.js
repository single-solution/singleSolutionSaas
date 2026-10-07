// @vitest-environment jsdom
/**
 * The website page in the browser (jsdom) against a live in-process Portal with fake products (PLAN 0.8.2, 0.5.9,
 * 0.4.4): Products (cards, Open through the right launch route, Add product with its refusals, Remove with a typed
 * confirmation of the product name), Remove website (disabled with `Remove its products first` while products remain,
 * then a typed confirmation of the domain), Install and tokens (script tag, browser token, server token reveal / copy /
 * regenerate with a typed confirmation, `Cannot be shown: regenerate`), Usage, and what each role sees.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@ss/ui';
import { act, cleanup, keydown, render, type } from '@ss/ui/testing';
import { closeMongoClients } from '../../src/infra/db.js';
import * as admin from '../../src/console/admin/loaders.js';
import { AdminWebsiteView } from '../../src/console/admin/views/website.js';
import * as loaders from '../../src/console/loaders.js';
import { WebsiteView } from '../../src/console/views/websites.js';
import { InstallBlock } from '../../src/console/views/website.js';
import { startMongo } from '../helpers.js';
import {
	button,
	buttons,
	clickEl,
	createWorld,
	dialog,
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

/** Open a tab of the page. @param {string} label */
const tab = (label) =>
	clickEl(/** @type {Element} */ ([...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent === label)));

/** Open an actions menu by its label. @param {string} label */
const menu = (label) => clickEl(/** @type {Element} */ (document.querySelector(`button[aria-label="${label}"]`)));

/** @param {string} label */
const menuItem = (label) =>
	/** @type {HTMLButtonElement} */ ([...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent === label));

describe('website page (jsdom)', () => {
	it('drives Products, Install and tokens, Usage and Remove website as the Owner', async () => {
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
			const page = await admin.loadWebsite(ownerBrowser.api, { merchantId, websiteId, admin: owner });
			withToasts(<AdminWebsiteView {...page} admin={owner} />);
			expect(shows('shop.example.com') && shows('Shop & Co') && shows('No features on')).toBe(true);

			// ---------------------------------------------------------------- Open: the admin launch for this website
			await press('Open Notes');
			const launched = await ownerBrowser.waitCall('POST', '/v1/admin/products/notes/launch', (st) => st === 200);
			expect(open).toHaveBeenCalledWith(launched.body.url, '_blank', 'noopener,noreferrer');
			expect(claimsOf(launched.body.url)).toMatchObject({ kind: 'admin', admin: { role: 'owner', websiteId } });

			// ---------------------------------------------------------------- Remove website is disabled while products remain
			await menu('Website actions');
			expect(menuItem('Remove website').disabled).toBe(true);
			expect(shows('Remove its products first')).toBe(true);
			await menu('Website actions');
			expect(document.querySelector('[role="menu"]')).toBeNull();
			// Escape and a click outside close the menu
			await menu('Website actions');
			keydown(document, 'Escape');
			expect(document.querySelector('[role="menu"]')).toBeNull();
			await menu('Website actions');
			await act(async () => {
				document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
			});
			expect(document.querySelector('[role="menu"]')).toBeNull();

			// ---------------------------------------------------------------- Add product: active connected products not on the website
			await press('Add product');
			expect(shows('Chatty')).toBe(true);
			expect(dialog().textContent).not.toContain('Gamma'); // inactive
			expect(dialog().textContent).not.toContain('Notes'); // already on
			// refused: the product was set inactive meanwhile
			await ownerBrowser.api.post('/v1/admin/products/chatty/status', { status: 'inactive' });
			await pressDialog('Add Chatty');
			await ownerBrowser.waitCall('POST', `/v1/merchants/${merchantId}/websites/${websiteId}/products`, (st) => st === 409);
			expect(shows('This product is not offered: it is not connected or it is inactive.')).toBe(true);
			await ownerBrowser.api.post('/v1/admin/products/chatty/status', { status: 'active' });
			await pressDialog('Add Chatty');
			await ownerBrowser.waitCall('POST', `/v1/merchants/${merchantId}/websites/${websiteId}/products`, (st) => st === 201);
			await until(() => shows('Chatty added.'));
			await ownerBrowser.waitCall('GET', `/v1/merchants/${merchantId}/websites/${websiteId}/tokens`);
			// nothing left to add
			await press('Add product');
			expect(shows('Every active product is already on this website.')).toBe(true);
			await clickEl(/** @type {Element} */ (dialog().querySelector('button[aria-label="Close"]')));

			// ---------------------------------------------------------------- Remove: typed confirmation of the product name
			await menu('Actions for Chatty');
			await clickEl(menuItem('Remove'));
			expect(shows('Remove Chatty')).toBe(true);
			expect(button('Remove', dialog()).disabled).toBe(true);
			type(confirmInput(), 'chatty');
			expect(button('Remove', dialog()).disabled).toBe(true);
			type(confirmInput(), 'Chatty');
			await pressDialog('Remove');
			await ownerBrowser.waitCall(
				'DELETE',
				`/v1/merchants/${merchantId}/websites/${websiteId}/products/chatty`,
				(st) => st === 200,
			);
			await until(() => shows('Chatty removed.'));
			expect(buttons('Open Chatty')).toHaveLength(0);

			// ---------------------------------------------------------------- Install and tokens
			await tab('Install and tokens');
			const tag = /** @type {HTMLElement} */ (
				[...document.querySelectorAll('pre')].find((p) => p.textContent?.startsWith('<script'))
			);
			expect(tag.textContent).toMatch(
				/^<script src="https:\/\/notes\.example\.dev\/widget\.js" data-token="ey[^"]+" async><\/script>$/,
			);
			expect(shows('Accepted only from https://shop.example.com and from localhost')).toBe(true);
			expect(document.querySelector('a[href$="/docs"]')?.textContent).toContain('Docs');
			await press('Reveal');
			const revealed = await ownerBrowser.waitCall(
				'POST',
				`/v1/merchants/${merchantId}/websites/${websiteId}/tokens/notes/reveal`,
			);
			expect(revealed.status).toBe(200);
			expect(shows(revealed.body.serverToken)).toBe(true);
			await press('Hide');
			expect(shows(revealed.body.serverToken)).toBe(false);
			await press('Copy', /** @type {HTMLElement} */ (button('Regenerate').parentElement));
			await until(() => shows('Copied to the clipboard.'));
			expect(writeText).toHaveBeenLastCalledWith(revealed.body.serverToken);
			// a failing copy says so
			writeText.mockRejectedValueOnce(new Error('denied'));
			await press('Copy', /** @type {HTMLElement} */ (button('Regenerate').parentElement));
			await until(() => shows('Copy failed.'));
			// regenerate: typed confirmation with the product name; the old token stops at once
			await press('Regenerate');
			expect(shows('the old one stops at once')).toBe(true);
			expect(button('Regenerate', dialog()).disabled).toBe(true);
			type(confirmInput(), 'Notes');
			await pressDialog('Regenerate');
			const regenerated = await ownerBrowser.waitCall(
				'POST',
				`/v1/merchants/${merchantId}/websites/${websiteId}/tokens/notes/regenerate`,
				(st) => st === 200,
			);
			expect(regenerated.body).toMatchObject({ productId: 'notes', kind: 'server' });
			expect(regenerated.body.token).not.toBe(revealed.body.serverToken);
			await until(() => shows('New server token made. The old one no longer works.'));
			expect(shows(regenerated.body.token)).toBe(true);
			const activity = await world.ownerBrowser.api.get(`/v1/merchants/${merchantId}/activity`);
			expect(activity.ok && activity.data.items.map((/** @type {any} */ e) => e.action)).toEqual(
				expect.arrayContaining(['token.revealed', 'token.regenerated', 'product.removed', 'product.added']),
			);

			// ---------------------------------------------------------------- Usage
			await tab('Usage');
			expect(shows('Spend per UTC day')).toBe(true);
			await tab('Products');

			// ---------------------------------------------------------------- Remove website once its products are removed
			await menu('Actions for Notes');
			await clickEl(menuItem('Remove'));
			type(confirmInput(), 'Notes');
			await pressDialog('Remove');
			await ownerBrowser.waitCall(
				'DELETE',
				`/v1/merchants/${merchantId}/websites/${websiteId}/products/notes`,
				(st) => st === 200,
			);
			await until(() => shows('No products on this website yet.'));
			await tab('Install and tokens');
			expect(shows('Tokens appear here once a product is on this website.')).toBe(true);
			await tab('Products');
			await menu('Website actions');
			expect(menuItem('Remove website').disabled).toBe(false);
			await clickEl(menuItem('Remove website'));
			expect(shows('Remove shop.example.com')).toBe(true);
			type(confirmInput(), 'shop.example.co');
			expect(button('Remove website', dialog()).disabled).toBe(true);
			type(confirmInput(), 'shop.example.com');
			await pressDialog('Remove website');
			const removed = await ownerBrowser.waitCall('DELETE', `/v1/merchants/${merchantId}/websites/${websiteId}`);
			expect(removed.status).toBe(200);
			cleanup();

			// a refused removal (the website is gone) shows the problem in the dialog
			withToasts(<AdminWebsiteView {...page} cards={[]} admin={owner} />);
			await menu('Website actions');
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

			// the merchant: the merchant launch route; Install and tokens; no admin actions
			merchant.use();
			withToasts(<WebsiteView {...await loaders.loadWebsite(merchant.api, merchantId, websiteId, 'install')} />);
			expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Install and tokens');
			await press('Reveal');
			await merchant.waitCall(
				'POST',
				`/v1/merchants/${merchantId}/websites/${websiteId}/tokens/notes/reveal`,
				(st) => st === 200,
			);
			await tab('Products');
			expect(buttons('Add product')).toHaveLength(0);
			expect(document.querySelector('button[aria-label="Website actions"]')).toBeNull();
			expect(document.querySelector('button[aria-label="Actions for Notes"]')).toBeNull();
			expect(shows('Your admin adds products to this website.')).toBe(false);
			await press('Open Notes');
			const mine = await merchant.waitCall(
				'POST',
				`/v1/merchants/${merchantId}/websites/${websiteId}/products/notes/launch`,
				(st) => st === 200,
			);
			expect(open).toHaveBeenLastCalledWith(mine.body.url, '_blank', 'noopener,noreferrer');
			cleanup();

			// Support: the admin launch with the website id
			const { admin: support, b: supportBrowser } = await world.adminOf('support');
			supportBrowser.use();
			withToasts(
				<AdminWebsiteView
					{...await admin.loadWebsite(supportBrowser.api, { merchantId, websiteId, admin: support })}
					admin={support}
				/>,
			);
			await press('Open Notes');
			const theirs = await supportBrowser.waitCall('POST', '/v1/admin/products/notes/launch', (st) => st === 200);
			expect(open).toHaveBeenLastCalledWith(theirs.body.url, '_blank', 'noopener,noreferrer');
			expect([...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual([
				'Products',
				'Install and tokens',
				'Usage',
			]);
			cleanup();

			// Finance: no Install and tokens, no Open, no admin actions (a tab=install link opens Products)
			const { admin: finance, b: financeBrowser } = await world.adminOf('finance');
			financeBrowser.use();
			withToasts(
				<AdminWebsiteView
					{...await admin.loadWebsite(financeBrowser.api, { merchantId, websiteId, tab: 'install', admin: finance })}
					admin={finance}
				/>,
			);
			expect([...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(['Products', 'Usage']);
			expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Products');
			expect(shows('Notes')).toBe(true);
			expect(buttons('Open Notes')).toHaveLength(0);
			expect(buttons('Add product')).toHaveLength(0);
			expect(document.querySelector('button[aria-label="Website actions"]')).toBeNull();
			expect(financeBrowser.calls.some((c) => c.path.endsWith('/tokens'))).toBe(false);
			cleanup();

			// a refused launch (the merchant is suspended: its sessions end) shows a toast and opens nothing
			const calls = open.mock.calls.length;
			merchant.use();
			withToasts(<WebsiteView {...await loaders.loadWebsite(merchant.api, merchantId, websiteId)} />);
			await world.ownerBrowser.api.post(`/v1/admin/merchants/${merchantId}/suspend`, { reason: 'check' });
			await press('Open Notes');
			await merchant.waitCall(
				'POST',
				`/v1/merchants/${merchantId}/websites/${websiteId}/products/notes/launch`,
				(st) => st === 401,
			);
			expect(open.mock.calls.length).toBe(calls);
			cleanup();
		} finally {
			await world.close();
			restore();
		}
	});

	it('shows `Cannot be shown: regenerate` and other token failures', async () => {
		const entry = {
			productId: 'notes',
			name: 'Notes',
			widgetScriptUrl: null,
			docsUrl: null,
			browserToken: 'browser-token',
			serverToken: { canShow: true },
		};
		/** @type {Array<[string, any]>} */
		const seen = [];
		/** @type {(path: string, init?: any) => Promise<any>} */
		let answer = async () => ({ ok: false, status: 409, problem: { status: 409, detail: 'Cannot be shown: regenerate.' } });
		const fetcher = async (/** @type {string} */ path, /** @type {any} */ init) => {
			seen.push([path, init]);
			return answer(path, init);
		};
		withToasts(<InstallBlock entry={entry} domain="shop.com" merchantId="mer_1" websiteId="web_1" fetcher={fetcher} />);
		expect(shows('Widget script tag')).toBe(false); // no widgets
		expect(document.querySelector('a')).toBeNull(); // no docs
		await press('Reveal');
		await until(() => shows('Cannot be shown: regenerate'));
		expect(buttons('Reveal')).toHaveLength(0);
		expect(seen[0]).toEqual(['/v1/merchants/mer_1/websites/web_1/tokens/notes/reveal', { method: 'POST' }]);
		// a failed regenerate keeps the dialog open with the problem
		answer = async () => ({ ok: false, status: 500, problem: { status: 500, title: 'Boom' } });
		await press('Regenerate');
		type(confirmInput(), 'Notes');
		await pressDialog('Regenerate');
		await until(() => dialog().textContent?.includes('Something went wrong on our side.'));
		answer = async () => ({ ok: true, status: 200, data: { productId: 'notes', kind: 'server', token: 'fresh-server-token' } });
		await pressDialog('Regenerate');
		await until(() => shows('fresh-server-token'));
		expect(seen.at(-1)).toEqual([
			'/v1/merchants/mer_1/websites/web_1/tokens/notes/regenerate',
			{ method: 'POST', body: { kind: 'server' } },
		]);
		// copying the shown token needs no new reveal
		vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => undefined) } });
		const before = seen.length;
		await press('Copy', /** @type {HTMLElement} */ (button('Regenerate').parentElement));
		expect(seen.length).toBe(before);
		cleanup();

		// a stored token that cannot be decrypted shows the message at once; another reveal failure is shown as a problem
		withToasts(
			<InstallBlock
				entry={{ ...entry, serverToken: { canShow: false } }}
				domain="shop.com"
				merchantId="mer_1"
				websiteId="web_1"
				fetcher={fetcher}
			/>,
		);
		expect(shows('Cannot be shown: regenerate')).toBe(true);
		cleanup();
		answer = async () => ({ ok: false, status: 403, problem: { status: 403, detail: 'Not yours.', type: 'forbidden' } });
		withToasts(<InstallBlock entry={entry} domain="shop.com" merchantId="mer_1" websiteId="web_1" fetcher={fetcher} />);
		await press('Copy', /** @type {HTMLElement} */ (button('Regenerate').parentElement));
		await until(() => shows('Not yours.'));
		await settle(1);
	});
});
