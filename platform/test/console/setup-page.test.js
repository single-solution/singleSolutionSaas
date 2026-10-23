// @vitest-environment jsdom
/**
 * The Setup sheet part of the website page in the browser (jsdom) against a live in-process Portal with fake products
 * (owner request 2026-10-14): the merchant's sheet (the website's facts, a product's panel, a product that did not
 * answer), Refresh, Copy and Download JSON in the header, share links (create once-shown, list, revoke), the admin's
 * page and who gets it, the public shared page (key from the address fragment; without values; a link that does not
 * work), and the advisor: the business profile filled out by the merchant, recommendations with why, Switch on for the
 * admin.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@ss/ui';
import { productBlueprint } from '@ss/contracts/testing';
import { act, byLabel, cleanup, render, type } from '@ss/ui/testing';
import { closeMongoClients } from '../../src/testing.js';
import * as admin from '../../src/console/admin/loaders.js';
import { AdminWebsiteView } from '../../src/console/admin/views/website.js';
import * as loaders from '../../src/console/loaders.js';
import { SharedSetupView, neededOff, profileLines, valueText } from '../../src/console/views/setup.js';
import { WebsiteView } from '../../src/console/views/websites.js';
import { startMongo } from '../helpers.js';
import {
	browserOf,
	buttons,
	clickEl,
	createWorld,
	dialog,
	menuItems,
	press,
	pressDialog,
	pressMenu,
	quiet,
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
	vi.unstubAllGlobals();
});

/** @param {import('react').ReactNode} node */
const withToasts = (node) => render(<ToastProvider durationMs={600_000}>{node}</ToastProvider>);

/** Close the open drawer or dialog. */
const closeDialog = () => clickEl(/** @type {Element} */ (dialog().querySelector('button[aria-label="Close"]')));

/** A merchant with one website that has Notes (answers) and Chatty (refuses with 500). @param {string} name */
const world = async (name) => {
	const w = await createWorld({ db: mongo.db(name) });
	const { b, merchantId } = await w.signup('owner@shop.test', 'Shop & Co');
	const site = await w.addWebsite(merchantId, 'shop.example.com');
	const websiteId = String(site.websiteId);
	const notes = await w.connect();
	const chatty = await w.connect({ id: 'chatty', name: 'Chatty', widgets: false });
	chatty.tamper.blueprint = 'status_500';
	await w.addProduct(merchantId, websiteId, 'notes');
	await w.addProduct(merchantId, websiteId, 'chatty');
	return { w, b, merchantId, websiteId, notes };
};

/**
 * Show the Setup sheet part of the website page as the Portal's server component does.
 * @param {Awaited<ReturnType<typeof world>>} x
 */
const openSetup = async ({ b, merchantId, websiteId }) => {
	b.use();
	const page = await loaders.loadWebsitePage(b.api, merchantId, websiteId, 'setup');
	withToasts(<WebsiteView {...page} />);
	return page;
};

/** The Region and format section as the console sends it. @param {Record<string, unknown>} [over] */
const region = (over = {}) => ({
	country: 'US',
	timeZone: 'America/New_York',
	currency: 'USD',
	currencies: ['USD'],
	language: 'en-US',
	languages: ['en-US'],
	countriesServed: [],
	units: { weight: 'lb', size: 'in' },
	format: { locale: '', currencyDisplay: 'code', currencySymbols: {}, wholeUnits: false, times: 'viewer' },
	phone: { callingCode: '+1', trunkPrefix: '', countries: [] },
	address: { required: ['line1', 'city'], regions: [] },
	...over,
});

describe('Setup page (jsdom)', () => {
	it('shows the merchant the sheet, gathers it again, copies it, and makes, lists and revokes share links', async () => {
		const restore = quiet();
		const { w, b, merchantId, websiteId, notes } = await world('setup_page_merchant');
		// a setting whose value holds a secret saved in Connections comes without its value
		notes.setBlueprint(() => {
			const part = productBlueprint();
			/** @type {any} */ (part.features[0]).settings[0] = {
				key: 'maxNotes',
				title: 'Notes per visitor per day',
				set: true,
				default: false,
			};
			return part;
		});
		try {
			const writeText = vi.fn(async () => undefined);
			vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
			b.use();
			// the merchant has set the business facts once in the Portal's Website settings: the header shows them
			const settings = `/v1/merchants/${merchantId}/websites/${websiteId}/settings`;
			await b.api.request('PUT', `${settings}/region`, { version: 0, value: region() });
			await b.api.request('PUT', `${settings}/business`, {
				version: 1,
				value: {
					name: 'Example Shop',
					otherNames: [],
					tagline: '',
					legalName: '',
					taxNumber: '',
					businessType: '',
					email: 'hello@shop.test',
					phone: '',
					phones: [],
					whatsapp: '',
					address: { line1: '', line2: '', area: '', city: '', region: '', postalCode: '', country: '' },
					hours: { weekly: [], exceptions: [] },
					social: [],
				},
			});
			const page = await openSetup({ w, b, merchantId, websiteId, notes });
			if (!page.ok || !page.setup?.ok) throw new Error('setup');
			expect(page.setup.sheet.website.business).toEqual({
				found: true,
				name: 'Example Shop',
				country: 'US',
				timeZone: 'America/New_York',
			});
			expect(document.querySelector('h1')?.textContent).toBe('shop.example.com');
			expect(shows('Set: Example Shop')).toBe(true);
			expect(shows('https://shop.example.com')).toBe(true);
			// the product that did not answer says so, the one that did has its panel
			expect(shows('Chatty did not answer')).toBe(true);
			expect(shows('It could not be reached. Try Refresh in a moment.')).toBe(true);
			// the product's panel: what is left to do, a feature on with its settings, one off, connections, install, events
			expect(shows('Add the widget script to every page of your website.')).toBe(true);
			expect(shows('Notes per visitor per daySet (holds a secret, not shown)')).toBe(true);
			expect(shows('GreetingLeave us a noteDefault')).toBe(true);
			expect(shows('Off: Notes inbox')).toBe(true);
			expect(shows('Database (MongoDB)')).toBe(true);
			expect(shows('Connected')).toBe(true);
			expect(shows('notes.settings.changed')).toBe(true);
			expect(shows('A server token is issued; it is never shown here.')).toBe(true);
			// the status of the website's products and each product's API address
			expect(shows('StatusActive')).toBe(true);
			expect(shows('API address: http')).toBe(true);
			// labels in sentence case, never all caps (PLAN 0.6); the inner nav's group titles are the frame's own
			expect([...document.querySelectorAll('.uppercase')].filter((el) => !el.closest('nav'))).toEqual([]);
			// what the website builds for each feature that is on, with its docs
			expect(shows('What your website builds')).toBe(true);
			expect(shows('Add the note form widget to the pages where visitors leave notes.')).toBe(true);
			// Download JSON, Copy JSON and Refresh are in the header
			const clicked = /** @type {string[]} */ ([]);
			vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
				/** @this {HTMLAnchorElement} */ function () {
					clicked.push(String(this.getAttribute('href')));
				},
			);
			await press('Download JSON');
			expect(clicked).toEqual([`/v1/merchants/${merchantId}/websites/${websiteId}/setup?download=1`]);

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
			await closeDialog();
			expect(shows('Made by the merchant · Without settings values')).toBe(true);
			await press(`Actions for Expires ${made.body.link.expiresAt}`);
			await press('Revoke', /** @type {ParentNode} */ (document.querySelector('[role="menu"]')));
			await b.waitCall('DELETE', `/v1/merchants/${merchantId}/websites/${websiteId}/setup/links/${made.body.link.linkId}`);
			await until(() => shows('Share link revoked. It stops working at once.'));
			expect(shows('Revoked')).toBe(true);
		} finally {
			restore();
			await w.close();
		}
	});

	it('shows the admin the same sheet with the admin client; Finance has no Setup sheet', async () => {
		const restore = quiet();
		const { w, merchantId, websiteId } = await world('setup_page_admin');
		try {
			const { ownerBrowser, owner } = w;
			ownerBrowser.use();
			// the Setup sheet is a header action (secondary or More when Settings + Install fill the two slots)
			withToasts(
				<AdminWebsiteView
					detail={await admin.loadAdminWebsite(ownerBrowser.api, merchantId, websiteId, '', owner)}
					admin={owner}
				/>,
			);
			if (buttons('Setup sheet').length === 0) {
				await press('More actions');
				expect(menuItems()).toContain('Setup sheet');
			} else expect(buttons('Setup sheet').length).toBeGreaterThan(0);
			cleanup();
			withToasts(
				<AdminWebsiteView
					detail={await admin.loadAdminWebsite(ownerBrowser.api, merchantId, websiteId, 'setup', owner)}
					admin={owner}
				/>,
			);
			await press('Create share link');
			await pressDialog('Create link');
			await ownerBrowser.waitCall('POST', `/v1/merchants/${merchantId}/websites/${websiteId}/setup/links`, (s) => s === 201);
			await until(() => dialog().textContent?.includes('Share link created'));
			await closeDialog();
			await until(() => shows('Made by an admin · Shows everything'));
			// Finance sees no Setup sheet (no Install and tokens either): not in the header, no page, no request for it
			cleanup();
			const finance = await w.adminOf('finance');
			finance.b.use();
			const financeDetail = await admin.loadAdminWebsite(finance.b.api, merchantId, websiteId, '', finance.admin);
			withToasts(<AdminWebsiteView detail={financeDetail} admin={finance.admin} />);
			expect(buttons('Setup sheet')).toHaveLength(0);
			expect(shows('Server token')).toBe(false);
			cleanup();
			const financeSetup = await admin.loadAdminWebsite(finance.b.api, merchantId, websiteId, 'setup', finance.admin);
			withToasts(<AdminWebsiteView detail={financeSetup} admin={finance.admin} />);
			expect(shows('This page does not exist.')).toBe(true);
			expect(finance.b.calls.some((c) => c.path.includes('/setup'))).toBe(false);
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

			// a reload of the same tab opens it again (the key never returns to the address bar)
			window.history.replaceState(null, '', '/shared-setup');
			render(<SharedSetupView brand="Single Solution" />);
			await until(() => shows('Setup of shop.example.com'));
			expect(window.location.hash).toBe('');
			cleanup();

			// no key in this tab, and a revoked link (forgotten by the tab)
			window.sessionStorage.clear();
			render(<SharedSetupView brand="Single Solution" />);
			await until(() => shows('This share link does not work'));
			cleanup();
			await b.api.request('DELETE', `/v1/merchants/${merchantId}/websites/${websiteId}/setup/links/${made.data.link.linkId}`);
			window.history.replaceState(null, '', `/shared-setup#key=${key}`);
			render(<SharedSetupView brand="Single Solution" />);
			await until(() => shows('It may have expired or been revoked.'));
			await settle();
			expect(window.sessionStorage.getItem('ss-shared-setup-key')).toBeNull();
		} finally {
			restore();
			await w.close();
		}
	});

	it('lets the merchant fill out the business profile and shows the recommendations; the admin switches one on', async () => {
		const restore = quiet();
		const { w, b, merchantId, websiteId, notes } = await world('setup_page_advisor');
		// the Notes inbox (off) suits a website whose staff answer the chat
		notes.setBlueprint(() => {
			const part = productBlueprint();
			/** @type {any} */ (part.features[1]).recommendFor = ['chat.people'];
			return part;
		});
		try {
			await openSetup({ w, b, merchantId, websiteId, notes });
			// the header takes the website's facts from its settings in the Portal: nothing saved there yet
			expect(shows('Not set yet')).toBe(true);
			expect(
				[...document.querySelectorAll('a')].find((a) => a.textContent === 'Open Website settings')?.getAttribute('href'),
			).toBe(`/websites/${websiteId}/settings`);
			expect(shows('Not filled out yet.')).toBe(true);
			expect(shows('Fill out the business profile to see which features this website should use.')).toBe(true);
			await press('Fill out the profile');
			const pick = async (/** @type {string} */ label) => clickEl(byLabel(dialog(), label));
			await pick('Your staff');
			await pick('SMS');
			await pick('Physical goods');
			await pick('Nothing (information only)');
			// none stands alone: picking it cleared Physical goods
			expect(/** @type {HTMLInputElement} */ (byLabel(dialog(), 'Physical goods')).checked).toBe(false);
			await pick('Physical goods');
			expect(/** @type {HTMLInputElement} */ (byLabel(dialog(), 'Nothing (information only)')).checked).toBe(false);
			await pick('No');
			// the countries and languages are the website's settings: a note with a link, no field
			expect(dialog().textContent).toContain(
				'The countries and languages come from the website’s settings (Region and format)',
			);
			expect(dialog().querySelector('a')?.getAttribute('href')).toBe(`/websites/${websiteId}/settings/region`);
			expect(() => byLabel(dialog(), 'Languages of the website')).toThrow();
			// own answers where the options cannot list everything, typed once each
			const ownPays = /** @type {HTMLInputElement} */ (
				dialog().querySelector('[aria-label="Other answers: How do shoppers pay?"]')
			);
			await type(ownPays, 'Mobile wallet, mobile wallet , Store credit');
			await pressDialog('Save profile');
			const saved = await b.waitCall(
				'PUT',
				`/v1/merchants/${merchantId}/websites/${websiteId}/setup/profile`,
				(s) => s === 200,
			);
			expect(saved.body.website.profile).toEqual({
				sells: ['physical'],
				chat: ['people'],
				messages: ['sms'],
				other: { pays: ['Mobile wallet', 'Store credit'] },
				moving: false,
			});
			await until(() => shows('Business profile saved. The recommendations are updated.'));
			expect(shows('Who answers visitors in chat?Your staff')).toBe(true);
			// what the merchant sets once in the website's settings joins the profile, in the one place it lives
			await b.api.request('PUT', `/v1/merchants/${merchantId}/websites/${websiteId}/settings/region`, {
				version: 0,
				value: {
					country: 'US',
					timeZone: 'America/New_York',
					currency: 'USD',
					currencies: ['USD'],
					language: 'en-US',
					languages: ['en-US', 'fr-FR'],
					countriesServed: ['US', 'GB'],
					units: { weight: 'lb', size: 'in' },
					format: { locale: '', currencyDisplay: 'code', currencySymbols: {}, wholeUnits: false, times: 'viewer' },
					phone: { callingCode: '+1', trunkPrefix: '', countries: [] },
					address: { required: ['line1', 'city'], regions: [] },
				},
			});
			await press('Refresh');
			await until(() => shows('Languages of the websiteen, fr'));
			expect(shows('Countries you sell inUnited States, United Kingdom')).toBe(true);
			// Notes is on and recommended; its inbox is recommended and off: the merchant asks for it
			expect(shows('1 recommended feature is on.')).toBe(true);
			expect(shows('Recommended, not on')).toBe(true);
			expect(shows('Your staff answer visitors in chat.')).toBe(true);
			expect(shows('To switch these on, ask your account manager.')).toBe(true);
			expect(buttons('Switch on')).toEqual([]);

			// no chat and SMS only: Notes is on but the profile no longer calls for it
			await press('Edit profile');
			await pick('No chat');
			await pressDialog('Save profile');
			await until(() => shows('On, not recommended'));
			expect(shows('Not in the business profile: your staff answer visitors in chat or you message customers by email.')).toBe(
				true,
			);
			cleanup();

			// the admin switches the inbox on with one click
			await b.api.request('PUT', `/v1/merchants/${merchantId}/websites/${websiteId}/setup/profile`, { chat: ['people'] });
			const { ownerBrowser } = w;
			ownerBrowser.use();
			withToasts(
				<AdminWebsiteView
					detail={await admin.loadAdminWebsite(ownerBrowser.api, merchantId, websiteId, 'setup', w.owner)}
					admin={w.owner}
				/>,
			);
			expect(shows('Features are billed by the hour while they are on.')).toBe(true);
			await pressMenu('Actions for Notes inbox', 'Switch on');
			const switched = await ownerBrowser.waitCall(
				'POST',
				`/v1/merchants/${merchantId}/websites/${websiteId}/setup/features`,
				(s) => s === 200,
			);
			expect(switched.body.added).toEqual(['inbox']);
			await until(() => shows('Switched on: Notes inbox.'));
			expect(notes.switchCalls.map((call) => call.body.features)).toEqual([['inbox']]);
			// the product refuses: said in a toast
			notes.tamper.switchOn = 'refuse';
			await pressMenu('Actions for Notes inbox', 'Switch on');
			await until(() => shows('The Portal refused the change (forbidden). Nothing was changed.'));
			await settle();
		} finally {
			restore();
			await w.close();
		}
	});

	it('words a business profile and finds the features a feature needs that are off', () => {
		expect(
			profileLines({
				chat: ['ai', 'people'],
				moving: true,
				taxes: false,
				countries: ['US', 'ZZ'],
				languages: ['en'],
				pays: [],
				delivers: ['courier'],
				other: { delivers: ['Drone'], offers: ['Gift wrapping'] },
			}),
		).toEqual([
			{ question: 'How do orders reach shoppers?', answer: 'By courier, Drone' },
			{ question: 'Who answers visitors in chat?', answer: 'An AI assistant, Your staff' },
			{ question: 'What do you offer shoppers?', answer: 'Gift wrapping' },
			{ question: 'Are you moving from another website or system?', answer: 'Yes' },
			{ question: 'Do you charge tax (VAT, GST or sales tax) at checkout?', answer: 'No' },
			{ question: 'Countries you sell in', answer: 'United States, ZZ' },
			{ question: 'Languages of the website', answer: 'en' },
		]);
		const part = /** @type {any} */ ({ ...productBlueprint(), reachable: true, serverToken: { issued: true } });
		part.features.push({ ...part.features[1], key: 'tags', title: 'Tags', dependsOn: ['inbox'] });
		expect(neededOff(part, 'tags')).toEqual(['Notes inbox']);
		expect(neededOff(part, 'notes')).toEqual([]);
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
