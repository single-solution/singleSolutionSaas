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
import { WebsiteView } from '../../src/console/views/websites.js';
import { startMongo } from '../helpers.js';
import { buttons, createWorld, dialog, fillDialog, pressDialog, quiet, settle, shows, until } from './merchant-harness.js';

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
		needs: { database: true, storage: 'none', ai: true },
	});
	await w.addProduct(merchantId, websiteId, 'ecommerce');
	await w.addProduct(merchantId, websiteId, 'payments');
	return { w, b, merchantId, websiteId };
};

/** @param {import('react').ReactNode} node */
const withToasts = (node) => render(<ToastProvider durationMs={600_000}>{node}</ToastProvider>);

/**
 * Show a part of the website page as the server component of the Portal does (Data and files is `settings/connections`,
 * Between your products `settings/links`).
 * @param {Awaited<ReturnType<typeof world>>} x
 * @param {string} part
 */
const openPage = async ({ b, merchantId, websiteId }, part) => {
	cleanup();
	b.use();
	withToasts(<WebsiteView {...await loaders.loadWebsitePage(b.api, merchantId, websiteId, part)} />);
	await settle(2);
};

/**
 * Press the n-th button with this text (the database card comes first, then the storage card).
 * @param {string} label @param {number} [at]
 */
const pressNth = async (label, at = 0) => {
	const found = buttons(label, document.body)[at];
	if (!found) throw new Error(`no button “${label}” at ${at}`);
	await until(() => !found.disabled);
	await act(async () => found.click());
	await settle(1);
};

/**
 * @param {Awaited<ReturnType<typeof world>>} x
 * @param {boolean} [bad]
 */
const fillOtp = async (x, bad = false) => {
	await x.b.api.post('/v1/me/step-up-otp', {});
	if (bad) {
		fillDialog('Two-step or recovery code', '000000');
		return;
	}
	const code = x.w.lastOtp('owner@shop.test');
	fillDialog('Two-step or recovery code', String(code));
};

/** The label's input. @param {string} label @returns {any} */
const field = (label) => byLabel(document, label);

describe('Data and files (jsdom)', () => {
	it('the database is entered once: a password again, a wrong one refused, and the value is never on the page again', async () => {
		const restore = quiet();
		try {
			const x = await world('dcp_db');
			await openPage(x, 'settings/connections');
			expect(shows('Database (MongoDB)')).toBe(true);
			expect(shows('Not set')).toBe(true);
			// each product on the website has its own database and folder
			expect(shows('Database ss_ecommerce')).toBe(true);
			expect(shows('Database ss_payments')).toBe(true);
			expect(shows('Folder payments/')).toBe(true);
			// the value goes in a password field; nothing is saved without the person's OTP
			type(field('Connection string'), URI);
			await pressNth('Save');
			expect(dialog().textContent).toContain('Save Database (MongoDB)');
			await fillOtp(x, true);
			await pressDialog('Save');
			await until(() => dialog().textContent?.includes('That code is not right'));
			x.b.use();
			const unchanged = await x.b.api.get(`/v1/merchants/${x.merchantId}/websites/${x.websiteId}/connections`);
			expect(unchanged.ok && /** @type {any} */ (unchanged).data.database.set).toBe(false);
			await fillOtp(x);
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
			expect(stored.ok && /** @type {any} */ (stored).data.database.set).toBe(true);
			expect(JSON.stringify(/** @type {any} */ (stored).data)).not.toContain('Sup3rSecret');
			// the Portal e-mailed the merchant, without the value
			expect(x.w.mail.some((/** @type {any} */ mail) => mail.template === 'connection_changed')).toBe(true);
			expect(JSON.stringify(x.w.mail)).not.toContain('Sup3rSecret');
		} finally {
			restore();
		}
	});

	it('a value the Portal does not accept is shown under the form, after the OTP was right', async () => {
		const restore = quiet();
		try {
			const x = await world('dcp_bad');
			await openPage(x, 'settings/connections');
			type(field('Connection string'), 'postgres://nope');
			await pressNth('Save');
			await fillOtp(x);
			await pressDialog('Save');
			await until(() => !document.querySelector('[role="dialog"]'));
			await until(() => shows('A MongoDB connection string starts with'));
			expect(shows('Not set')).toBe(true);
		} finally {
			restore();
		}
	});

	it('the storage: four parts needed, saved with the OTP, removed with the OTP', async () => {
		const restore = quiet();
		try {
			const x = await world('dcp_storage');
			await openPage(x, 'settings/connections');
			// not enough to save
			expect(/** @type {HTMLButtonElement} */ (buttons('Save', document.body)[1]).disabled).toBe(true);
			type(field('Region'), 'auto');
			type(field('Bucket'), 'shop-media');
			type(field('Access key ID'), 'AKIAEXAMPLE');
			type(field('Secret access key'), 'sTorAgeSecret');
			expect(shows('Leave empty to show images through your website’s /media route.')).toBe(true);
			type(field('Public address of your files (optional)'), ' https://cdn.example.com/files/ ');
			// (the first Save button is the database's, the second the storage's)
			await pressNth('Save', 1);
			await fillOtp(x);
			await pressDialog('Save');
			await until(() => !document.querySelector('[role="dialog"]'));
			x.b.use();
			const stored = await x.b.api.get(`/v1/merchants/${x.merchantId}/websites/${x.websiteId}/connections`);
			expect(stored.ok && /** @type {any} */ (stored).data.storage).toMatchObject({
				set: true,
				publicBaseUrl: 'https://cdn.example.com/files',
			});
			expect(document.body.textContent).not.toContain('sTorAgeSecret');
			// the public address is not a secret: the field shows what was saved, the secrets are empty again
			expect(field('Public address of your files (optional)').value).toBe('https://cdn.example.com/files');
			expect(field('Secret access key').value).toBe('');
			// Remove asks for the OTP too (the database is not set: the storage's Remove is the only one)
			await pressNth('Remove');
			await fillOtp(x);
			await pressDialog('Remove');
			await until(() => !document.querySelector('[role="dialog"]'));
			const gone = await x.b.api.get(`/v1/merchants/${x.merchantId}/websites/${x.websiteId}/connections`);
			expect(gone.ok && /** @type {any} */ (gone).data.storage.set).toBe(false);
		} finally {
			restore();
		}
	});
});

describe('the AI provider key (jsdom)', () => {
	it('is entered once with its provider and model, never shown again (the provider and model are), and a refused key is shown under the form', async () => {
		const restore = quiet();
		try {
			const x = await world('dcp_ai');
			await openPage(x, 'settings/connections');
			expect(shows('AI provider key')).toBe(true);
			// the AI key column is there because Ecommerce asks for the key; the database and the storage come first
			expect(shows('AI key')).toBe(true);
			// not enough to save: the key and the model are needed (the AI card's Save is the third)
			expect(/** @type {HTMLButtonElement} */ (buttons('Save', document.body)[2]).disabled).toBe(true);
			// a key the Portal refuses is shown under the form after the password was right
			type(field('API key'), 'short');
			type(field('Model'), 'gpt-4.1-mini');
			await pressNth('Save', 2);
			await fillOtp(x);
			await pressDialog('Save');
			await until(() => !document.querySelector('[role="dialog"]'));
			await until(() => shows('Enter the API key.'));
			// saved: the key is nowhere on the page again; the provider and the model stay
			type(field('API key'), 'sk-test-AiSecret0123456789');
			await pressNth('Save', 2);
			await fillOtp(x);
			await pressDialog('Save');
			await until(() => !document.querySelector('[role="dialog"]'));
			await until(() => shows('Saved. Your products pick it up within moments.'));
			x.b.use();
			const stored = await x.b.api.get(`/v1/merchants/${x.merchantId}/websites/${x.websiteId}/connections`);
			expect(stored.ok && /** @type {any} */ (stored).data.ai).toMatchObject({
				set: true,
				provider: 'openai',
				model: 'gpt-4.1-mini',
			});
			expect(document.body.textContent).not.toContain('AiSecret');
			expect(field('API key').value).toBe('');
			expect(field('Model').value).toBe('gpt-4.1-mini');
			expect(field('Provider').value).toBe('openai');
			// Ecommerce is waiting for its own test of the key
			expect(shows('Waiting for the product')).toBe(true);
			// another OpenAI-compatible service needs its https address
			expect(shows('Service address')).toBe(false);
			type(field('Provider'), 'compatible');
			await settle(1);
			expect(shows('Service address')).toBe(true);
			type(field('API key'), 'sk-test-AiSecret0123456789');
			expect(/** @type {HTMLButtonElement} */ (buttons('Replace', document.body)[0]).disabled).toBe(true);
			type(field('Service address'), 'https://llm.example.com/v1/');
			await pressNth('Replace');
			await fillOtp(x);
			await pressDialog('Save');
			await until(() => !document.querySelector('[role="dialog"]'));
			await until(async () => {
				const next = await x.b.api.get(`/v1/merchants/${x.merchantId}/websites/${x.websiteId}/connections`);
				return next.ok && /** @type {any} */ (next).data.ai.baseUrl === 'https://llm.example.com/v1';
			});
			// Remove asks for the OTP too
			await pressNth('Remove');
			await fillOtp(x);
			await pressDialog('Remove');
			await until(() => !document.querySelector('[role="dialog"]'));
			const gone = await x.b.api.get(`/v1/merchants/${x.merchantId}/websites/${x.websiteId}/connections`);
			expect(gone.ok && /** @type {any} */ (gone).data.ai.set).toBe(false);
		} finally {
			restore();
		}
	});

	it('shows no AI key column while no product here asks for the key', async () => {
		const restore = quiet();
		try {
			const w = await createWorld({ db: mongo.db('dcp_noai') });
			const { b, merchantId } = await w.signup('owner@shop.test', 'Shop & Co');
			const site = await w.addWebsite(merchantId, 'shop.example.com');
			await w.connect({ widgets: false, needs: { database: true, storage: 'none' } });
			await w.addProduct(merchantId, String(site.websiteId), 'notes');
			await openPage({ w, b, merchantId, websiteId: String(site.websiteId) }, 'settings/connections');
			expect(shows('AI provider key')).toBe(true);
			expect(shows('AI key')).toBe(false);
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
			await openPage(x, 'settings/links');
			expect(shows('Ecommerce may use Payments')).toBe(true);
			expect(shows('Create payments, Refund payments')).toBe(true);
			expect(shows('On')).toBe(true);
			// the page never holds a key
			expect(document.body.textContent).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
			/** @param {string} item */
			const menuAction = async (item) => {
				await act(async () => {
					/** @type {HTMLButtonElement} */ (
						document.querySelector('button[aria-label="Actions for Ecommerce may use Payments"]')
					).click();
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
			await fillOtp(x, true);
			await pressDialog('Switch off');
			await until(() => dialog().textContent?.includes('That code is not right'));
			await fillOtp(x);
			await pressDialog('Switch off');
			await until(() => !document.querySelector('[role="dialog"]'));
			await until(() => shows('Switched off'));
			expect(shows('Create payments')).toBe(false);
			// and on again
			await menuAction('Switch on');
			await fillOtp(x);
			await pressDialog('Switch on');
			await until(() => !document.querySelector('[role="dialog"]'));
			await until(() => shows('Create payments'));
			// a new key
			await menuAction('Regenerate the key');
			await fillOtp(x);
			await pressDialog('Regenerate the key');
			await until(() => !document.querySelector('[role="dialog"]'));
			x.b.use();
			const changes = /** @type {any} */ (
				await x.b.api.get(`/v1/merchants/${x.merchantId}/websites/${x.websiteId}/connections`)
			).data;
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
			await openPage({ w, b, merchantId, websiteId: String(site.websiteId) }, 'settings/links');
			expect(shows('No product here needs another one yet.')).toBe(true);
		} finally {
			restore();
		}
	});
});
