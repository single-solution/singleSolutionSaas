// @vitest-environment jsdom
/**
 * Website settings in the browser (jsdom) against a live in-process Portal with a fake product: the page of a website
 * (the inner sidebar with what a product still needs, one section at a time), a save through the floating Save bar that
 * changes the Portal's document and clears what was missing, a value the Portal refuses shown under its field, the
 * address and the hours in right drawers, a save made from an older version (Reload), Recent changes, the website
 * card's menu and the admin's page.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@ss/ui';
import { act, byLabel, cleanup, render, type } from '@ss/ui/testing';
import { closeMongoClients } from '../../src/testing.js';
import { MerchantsView } from '../../src/console/admin/views/merchants.js';
import * as admin from '../../src/console/admin/loaders.js';
import * as loaders from '../../src/console/loaders.js';
import { WebsiteSettingsView, readinessLines } from '../../src/console/views/website-settings.js';
import { hoursSummary } from '../../src/console/views/website-settings-sections.js';
import { WebsiteCard } from '../../src/console/views/website.js';
import { startMongo } from '../helpers.js';
import {
	buttons,
	createWorld,
	dialog,
	menuItems,
	openSection,
	press,
	pressDialog,
	quiet,
	resetHash,
	settle,
	shows,
	until,
} from './merchant-harness.js';

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
	resetHash();
	vi.unstubAllGlobals();
});

/** @param {import('react').ReactNode} node */
const withToasts = (node) => render(<ToastProvider durationMs={600_000}>{node}</ToastProvider>);

/** A merchant with a website that has Notes, which needs a currency and a country. @param {string} name */
const world = async (name) => {
	const w = await createWorld({ db: mongo.db(name) });
	const { b, merchantId } = await w.signup('owner@shop.test', 'Shop & Co');
	const site = await w.addWebsite(merchantId, 'shop.example.com');
	const websiteId = String(site.websiteId);
	const notes = await w.connect({ requires: ['region.currency', 'region.country'] });
	await w.addProduct(merchantId, websiteId, 'notes');
	const settingsUrl = `/v1/merchants/${merchantId}/websites/${websiteId}/settings`;
	return { w, b, merchantId, websiteId, notes, settingsUrl };
};

/** Render the page as the server component of the merchant console does. @param {Awaited<ReturnType<typeof world>>} x */
const openPage = async ({ b, merchantId, websiteId }) => {
	b.use();
	const loaded = await loaders.loadWebsiteSettings(b.api, merchantId, websiteId);
	if (!loaded.ok) throw new Error('settings');
	withToasts(
		<WebsiteSettingsView
			data={loaded.data}
			changes={loaded.changes}
			merchantId={merchantId}
			websiteId={websiteId}
			domain={loaded.domain}
			back={{ href: `/websites/${websiteId}`, label: 'Back to the website' }}
		/>,
	);
	await settle(2);
};

/** The label's input or select. @param {string} label @param {ParentNode} [root] @returns {any} */
const field = (label, root = document) => byLabel(root, label);

/** Choose a value of a native select. @param {HTMLSelectElement} select @param {string} value */
const choose = async (select, value) => {
	await act(async () => {
		select.value = value;
		select.dispatchEvent(new Event('change', { bubbles: true }));
	});
};

describe('Website settings (jsdom)', () => {
	it('says what a product still needs, one section at a time, and the sections of the inner sidebar', async () => {
		const restore = quiet();
		try {
			const x = await world('wsp_open');
			await openPage(x);
			expect(shows('Website settings · shop.example.com')).toBe(true);
			expect(shows('Version 0')).toBe(true);
			expect(shows('Not saved yet')).toBe(true);
			// what Notes needs, on the page and as a dot on the section that holds it
			expect(shows('Notes needs: currency, country.')).toBe(true);
			const nav = /** @type {HTMLElement} */ (document.querySelector('nav'));
			const links = [...nav.querySelectorAll('a')].map((a) => a.textContent?.replace(/\s+/g, ' ').trim());
			expect(links).toEqual([
				'Business',
				'Brand and look',
				'Region and formatNeeded by Notes',
				'Domains, pages and legal',
				'Team and alerts',
				'Recent changes',
			]);
			expect(
				nav.querySelector('a[href="#region"] [title="Needed by Notes"], a[href="#region"] [aria-label="Needed by Notes"]'),
			).not.toBeNull();
			// one section at a time: only Business is on the page
			expect(shows('Business name')).toBe(true);
			expect(shows('Store currency')).toBe(false);
			await openSection('Region and format');
			expect(shows('Store currency')).toBe(true);
			expect(readinessLines([{ productId: 'a', name: 'A', requires: ['x'], missing: [] }])).toEqual([]);
		} finally {
			restore();
		}
	});

	it('saves a section through the floating Save bar: the Portal keeps it, what was missing is cleared, the change is listed', async () => {
		const restore = quiet();
		try {
			const x = await world('wsp_save');
			await openPage(x);
			await openSection('Region and format');
			expect(buttons('Save changes')).toHaveLength(0);
			await choose(/** @type {HTMLSelectElement} */ (field('Country')), 'US');
			// the country filled what was empty: the calling code and the units
			expect(field('Calling code').value).toBe('+1');
			await type(field('Time zone'), 'America/New_York');
			await type(field('Store currency'), 'usd');
			await until(() => buttons('Save changes').length === 1);
			await press('Save changes');
			await x.b.waitCall('PUT', `${x.settingsUrl}/region`, (status) => status === 200);
			await until(() => shows('Saved. Your products pick it up within moments.'));
			// the Portal holds it, tidied, and the readiness line is gone
			const kept = await x.b.api.get(x.settingsUrl);
			expect(kept.ok && kept.data.settings).toMatchObject({
				version: 1,
				region: {
					country: 'US',
					timeZone: 'America/New_York',
					currency: 'USD',
					currencies: ['USD'],
					phone: { callingCode: '+1' },
					units: { weight: 'lb', size: 'in' },
				},
			});
			expect(shows('Notes needs')).toBe(false);
			expect(shows('Version 1')).toBe(true);
			expect(buttons('Save changes')).toHaveLength(0);
			// Recent changes names the section and the fields
			await openSection('Recent changes');
			await until(() => shows('Region and format · version 1'));
			expect(shows('currency')).toBe(true);
			expect(shows('by Shop & Co')).toBe(true);
			// the preview of the Format follows the currency
			await openSection('Region and format');
			expect(document.querySelector('[data-preview="money"]')?.textContent).toContain('USD');
		} finally {
			restore();
		}
	});

	it('shows a value the Portal refuses under its field and saves nothing; Discard goes back to what was saved', async () => {
		const restore = quiet();
		try {
			const x = await world('wsp_refuse');
			await openPage(x);
			await openSection('Region and format');
			await type(field('Time zone'), 'Mars/Base');
			await press('Save changes');
			await x.b.waitCall('PUT', `${x.settingsUrl}/region`, (status) => status === 422);
			await until(() => shows('Must be an IANA time zone name'));
			const kept = await x.b.api.get(x.settingsUrl);
			expect(kept.ok && kept.data.settings.version).toBe(0);
			await press('Discard');
			expect(field('Time zone').value).toBe('');
			expect(shows('Must be an IANA time zone name')).toBe(false);
		} finally {
			restore();
		}
	});

	it('edits the address and the opening hours in right drawers; their changes are saved with the section', async () => {
		const restore = quiet();
		try {
			const x = await world('wsp_drawers');
			await openPage(x);
			await type(field('Business name'), 'Example Shop');
			// the address drawer
			const row = /** @type {HTMLElement} */ (
				[...document.querySelectorAll('[role="group"]')].find((g) => g.textContent?.includes('Postal address'))
			);
			await press('Edit', row);
			expect(dialog().textContent).toContain('Postal address');
			await choose(/** @type {HTMLSelectElement} */ (field('Country', dialog())), 'US');
			await type(field('Street address', dialog()), '1 Example Street');
			await type(field('City', dialog()), 'Springfield');
			await pressDialog('Done');
			await until(() => shows('1 Example Street, Springfield'));
			// the hours drawer: Monday 09:00-17:00
			const hours = /** @type {HTMLElement} */ (
				[...document.querySelectorAll('[role="group"]')].find((g) => g.textContent?.includes('Hours'))
			);
			await press('Edit', hours);
			await press('Add hours: Monday', dialog());
			await pressDialog('Done');
			await until(() => shows('Mon 09:00–17:00'));
			await press('Save changes');
			await x.b.waitCall('PUT', `${x.settingsUrl}/business`, (status) => status === 200);
			const kept = await x.b.api.get(x.settingsUrl);
			expect(kept.ok && kept.data.settings.business).toMatchObject({
				name: 'Example Shop',
				address: { line1: '1 Example Street', city: 'Springfield', country: 'US' },
				hours: { weekly: [{ day: 1, start: '09:00', end: '17:00' }] },
			});
			expect(
				hoursSummary({
					weekly: [
						{ day: 1, start: '09:00', end: '17:00' },
						{ day: 2, start: '09:00', end: '17:00' },
					],
					exceptions: [{ date: '2026-12-25', name: '', hours: [] }],
				}),
			).toBe('Mon–Tue 09:00–17:00 · 1 date differs');
		} finally {
			restore();
		}
	});

	it('offers a reload when someone saved the settings meanwhile, and the reload shows their change', async () => {
		const restore = quiet();
		try {
			const x = await world('wsp_stale');
			await openPage(x);
			// the Owner saves another section in the Portal while the page is open
			const owner = await x.w.ownerBrowser.api.request('PUT', `${x.settingsUrl}/pages`, {
				version: 0,
				value: { hosts: ['www.shop.example.com'], signIn: '', privacy: '', documents: [] },
			});
			expect(owner.ok).toBe(true);
			await type(field('Business name'), 'Example Shop');
			await press('Save changes');
			await x.b.waitCall('PUT', `${x.settingsUrl}/business`, (status) => status === 409);
			await until(() => shows('These settings were saved by someone else meanwhile.'));
			await press('Reload');
			await until(() => shows('Version 1'));
			await openSection('Domains, pages and legal');
			expect(field('Host name').value).toBe('www.shop.example.com');
		} finally {
			restore();
		}
	});

	it('is in the website card’s More menu, and in the admin console for Owner and Support', async () => {
		const restore = quiet();
		try {
			const x = await world('wsp_menu');
			x.b.use();
			const websites = await loaders.loadWebsiteRows(x.b.api, x.merchantId);
			const row = websites.rows[0];
			if (!row) throw new Error('no website');
			withToasts(
				<WebsiteCard
					website={row.website}
					cards={row.cards}
					can={{ manage: false, removeWebsite: false, tokens: true, open: true }}
					settingsHref={`/websites/${x.websiteId}/settings`}
					launch={() => ({ path: '/x' })}
				/>,
			);
			await press('Actions for shop.example.com');
			expect(menuItems()[0]).toBe('Website settings');
			cleanup();
			// the admin's merchant page: the same item for the Owner, and for Support; Finance has no such item
			const owner = x.w.owner;
			x.w.ownerBrowser.use();
			const list = await admin.loadMerchants(x.w.ownerBrowser.api, {});
			const detail = await admin.loadMerchant(x.w.ownerBrowser.api, x.merchantId, owner);
			if (!detail.ok) throw new Error('merchant');
			withToasts(<MerchantsView {...list} detail={detail} selectedId={x.merchantId} admin={owner} />);
			await press('Actions for shop.example.com');
			expect(menuItems()).toContain('Website settings');
			cleanup();
			const { admin: finance, b: financeBrowser } = await x.w.adminOf('finance');
			financeBrowser.use();
			const financeDetail = await admin.loadMerchant(financeBrowser.api, x.merchantId, finance);
			if (!financeDetail.ok) throw new Error('merchant');
			withToasts(
				<MerchantsView
					{...await admin.loadMerchants(financeBrowser.api, {})}
					detail={financeDetail}
					selectedId={x.merchantId}
					admin={finance}
				/>,
			);
			await press('Actions for shop.example.com');
			expect(menuItems()).not.toContain('Website settings');
		} finally {
			restore();
		}
	});
});
