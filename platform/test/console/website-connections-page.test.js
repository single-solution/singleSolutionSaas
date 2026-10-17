// @vitest-environment jsdom
/**
 * Data and files and Between your products in the browser (jsdom) against a live in-process Portal with fake products:
 * the merchant enters the database once (a password again, a wrong one refused), the value is never on the page again,
 * a value the Portal refuses is shown under the form, the storage and Remove, what each product gets, and the links
 * (switch off and on, regenerate, each after the password) with the words of what a link allows.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@ss/ui';
import { act, byLabel, cleanup, render, type } from '@ss/ui/testing';
import { closeMongoClients } from '../../src/testing.js';
import * as loaders from '../../src/console/loaders.js';
import { WebsiteSettingsView } from '../../src/console/views/website-settings.js';
import { startMongo } from '../helpers.js';
import {
	buttons,
	createWorld,
	dialog,
	fillDialog,
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

const URI = 'mongodb+srv://app:Sup3rSecret@cluster0.example.net/?retryWrites=true';

/**
 * Ecommerce needs Payments to create and refund payments while its feature `notes` is on; Payments offers them.
 * @param {string} name
 */
const world = async (name) => {
	const w = await createWorld({ db: mongo.db(name) });
	const { b, merchantId } = await w.signup('owner@shop.test', 'Shop & Co');
	const site = await w.addWebsite(merchantId, 'shop.example.com');
	const websiteId = String(site.websiteId);
	const offers = [
		{ scope: 'payments.create', name: 'Create payments', description: 'Start a payment.' },
		{ scope: 'payments.refund', name: 'Refund payments', description: 'Refund a payment.' },
	];
	await w.connect({
		id: 'payments',
		name: 'Payments',
		widgets: false,
		links: { offers },
		needs: { database: true, storage: 'optional' },
	});
	await w.connect({
		id: 'ecommerce',
		name: 'Ecommerce',
		widgets: false,
		links: { needs: [{ product: 'payments', scopes: ['payments.create', 'payments.refund'], features: [] }] },
		needs: { database: true, storage: 'none' },
	});
	await w.addProduct(merchantId, websiteId, 'ecommerce');
	await w.addProduct(merchantId, websiteId, 'payments');
	return { w, b, merchantId, websiteId };
};

/** @param {import('react').ReactNode} node */
const withToasts = (node) => render(<ToastProvider durationMs={600_000}>{node}</ToastProvider>);

/** Render the page as the server component of the merchant console does. @param {Awaited<ReturnType<typeof world>>} x */
const openPage = async ({ b, merchantId, websiteId }) => {
	b.use();
	const loaded = await loaders.loadWebsiteSettings(b.api, merchantId, websiteId);
	if (!loaded.ok) throw new Error('settings');
	withToasts(
		<WebsiteSettingsView
			data={loaded.data}
			changes={loaded.changes}
			connections={loaded.connections}
			merchantId={merchantId}
			websiteId={websiteId}
			domain={loaded.domain}
			back={{ href: `/websites/${websiteId}`, label: 'Back to the website' }}
		/>,
	);
	await settle(2);
};

/** The label's input. @param {string} label @returns {any} */
const field = (label) => byLabel(document, label);

describe('Data and files (jsdom)', () => {
	it('the database is entered once: a password again, a wrong one refused, and the value is never on the page again', async () => {
		const restore = quiet();
		try {
			const x = await world('dcp_db');
			await openPage(x);
			await openSection('Data and files');
			expect(shows('Database (MongoDB)')).toBe(true);
			expect(shows('Not set')).toBe(true);
			// each product on the website has its own database and folder
			expect(shows('Database ss_ecommerce')).toBe(true);
			expect(shows('Database ss_payments')).toBe(true);
			expect(shows('Folder payments/')).toBe(true);
			// the value goes in a password field; nothing is saved without the person's password
			type(field('Connection string'), URI);
			await press('Save', document.body);
			expect(dialog().textContent).toContain('Save Database (MongoDB)');
			fillDialog('Your password', 'not my password');
			await pressDialog('Save');
			await until(() => dialog().textContent?.includes('That password is not right'));
			x.b.use();
			const unchanged = await x.b.api.get(`/v1/merchants/${x.merchantId}/websites/${x.websiteId}/connections`);
			expect(unchanged.ok && unchanged.data.database.set).toBe(false);
			fillDialog('Your password', 'correct horse battery');
			await pressDialog('Save');
			await until(() => !document.querySelector('[role="dialog"]'));
			await until(() => shows('Saved. Your products pick it up within moments.'));
			// set now: the field is empty again and the string is nowhere on the page
			expect(field('Connection string').value).toBe('');
			expect(document.body.textContent).not.toContain('Sup3rSecret');
			expect(document.body.textContent).not.toContain('cluster0');
			expect(buttons('Replace').length).toBe(1);
			expect(buttons('Remove').length).toBeGreaterThan(0);
			const stored = await x.b.api.get(`/v1/merchants/${x.merchantId}/websites/${x.websiteId}/connections`);
			expect(stored.ok && stored.data.database.set).toBe(true);
			expect(JSON.stringify(stored.data)).not.toContain('Sup3rSecret');
			// the Portal e-mailed the merchant, without the value
			expect(x.w.mail.some((mail) => mail.template === 'connection_changed')).toBe(true);
			expect(JSON.stringify(x.w.mail)).not.toContain('Sup3rSecret');
		} finally {
			restore();
		}
	});

	it('a value the Portal does not accept is shown under the form, after the password was right', async () => {
		const restore = quiet();
		try {
			const x = await world('dcp_bad');
			await openPage(x);
			await openSection('Data and files');
			type(field('Connection string'), 'postgres://nope');
			await press('Save', document.body);
			fillDialog('Your password', 'correct horse battery');
			await pressDialog('Save');
			await until(() => !document.querySelector('[role="dialog"]'));
			await until(() => shows('A MongoDB connection string starts with'));
			expect(shows('Not set')).toBe(true);
		} finally {
			restore();
		}
	});

	it('the storage: four parts needed, saved with the password, removed with the password', async () => {
		const restore = quiet();
		try {
			const x = await world('dcp_storage');
			await openPage(x);
			await openSection('Data and files');
			// not enough to save
			expect(/** @type {HTMLButtonElement} */ (buttons('Save', document.body)[1]).disabled).toBe(true);
			type(field('Region'), 'auto');
			type(field('Bucket'), 'shop-media');
			type(field('Access key ID'), 'AKIAEXAMPLE');
			type(field('Secret access key'), 'sTorAgeSecret');
			await press('Save', document.body);
			// (the first Save button is the database's; the storage's is the enabled one)
			const save = buttons('Save', document.body).find((b) => !b.disabled);
			if (save) await act(async () => save.click());
			await settle(1);
			fillDialog('Your password', 'correct horse battery');
			await pressDialog('Save');
			await until(() => !document.querySelector('[role="dialog"]'));
			x.b.use();
			const stored = await x.b.api.get(`/v1/merchants/${x.merchantId}/websites/${x.websiteId}/connections`);
			expect(stored.ok && stored.data.storage.set).toBe(true);
			expect(document.body.textContent).not.toContain('sTorAgeSecret');
			// Remove asks for the password too
			await press('Remove', document.body);
			fillDialog('Your password', 'correct horse battery');
			await pressDialog('Remove');
			await until(() => !document.querySelector('[role="dialog"]'));
			const gone = await x.b.api.get(`/v1/merchants/${x.merchantId}/websites/${x.websiteId}/connections`);
			expect(gone.ok && gone.data.storage.set).toBe(false);
		} finally {
			restore();
		}
	});
});

describe('Between your products (jsdom)', () => {
	it('shows the link in words with what it allows; a switch off, a switch on and a new key each ask for the password', async () => {
		const restore = quiet();
		try {
			const x = await world('dcp_links');
			await openPage(x);
			await openSection('Between your products');
			expect(shows('Ecommerce may use Payments')).toBe(true);
			expect(shows('It may: Create payments, Refund payments')).toBe(true);
			expect(shows('On')).toBe(true);
			// the page never holds a key
			expect(document.body.textContent).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
			/** @param {string} item */
			const menuAction = async (item) => {
				await act(async () => {
					/** @type {HTMLButtonElement} */ (document.querySelector('button[aria-haspopup="menu"]')).click();
				});
				await settle(1);
				const items = /** @type {HTMLElement[]} */ ([...document.querySelectorAll('[role="menu"] [role^="menuitem"]')]);
				const found = items.find((el) => el.textContent?.trim() === item);
				if (!found) throw new Error(`no menu item ${item}`);
				await act(async () => found.click());
				await settle(1);
			};
			// switch off
			await menuAction('Switch off');
			expect(dialog().textContent).toContain('Switch off “Ecommerce may use Payments”');
			fillDialog('Your password', 'not it');
			await pressDialog('Switch off');
			await until(() => dialog().textContent?.includes('That password is not right'));
			fillDialog('Your password', 'correct horse battery');
			await pressDialog('Switch off');
			await until(() => !document.querySelector('[role="dialog"]'));
			await until(() => shows('Switched off'));
			expect(shows('It may:')).toBe(false);
			// and on again
			await menuAction('Switch on');
			fillDialog('Your password', 'correct horse battery');
			await pressDialog('Switch on');
			await until(() => !document.querySelector('[role="dialog"]'));
			await until(() => shows('It may: Create payments'));
			// a new key
			await menuAction('Regenerate the key');
			fillDialog('Your password', 'correct horse battery');
			await pressDialog('Regenerate the key');
			await until(() => !document.querySelector('[role="dialog"]'));
			const changes = await x.w.portal.modules
				.service('website')
				.connectionsView({ merchantId: x.merchantId, websiteId: x.websiteId });
			expect(changes.links[0]).toMatchObject({ state: 'on', caller: 'ecommerce', callee: 'payments' });
		} finally {
			restore();
		}
	});

	it('says so when no product here needs another', async () => {
		const restore = quiet();
		try {
			const w = await createWorld({ db: mongo.db('dcp_nolinks') });
			const { b, merchantId } = await w.signup('owner@shop.test', 'Shop & Co');
			const site = await w.addWebsite(merchantId, 'shop.example.com');
			await w.connect({ widgets: false, needs: { database: true, storage: 'none' } });
			await w.addProduct(merchantId, String(site.websiteId), 'notes');
			await openPage({ w, b, merchantId, websiteId: String(site.websiteId) });
			await openSection('Between your products');
			expect(shows('No product here needs another one yet.')).toBe(true);
		} finally {
			restore();
		}
	});
});
