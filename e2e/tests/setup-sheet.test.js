/**
 * The website Setup sheet (owner request 2026-10-14, `ss.blueprint/1`) against the REAL Portal, the test product Notes
 * and Notifications, in this process: the Portal gathers each product's part through a signed Portal call
 * (`GET /v1/blueprint`), the merchant and the admin read and download it, a product that cannot be reached shows as
 * not reachable while the sheet still renders, and a share link gives a read-only copy (without values when asked)
 * until it is revoked. No secret is ever in a sheet: not a connection value, not a server token. The setup advisor
 * on the real products: the merchant's business profile, the features each product recommends for it (by their
 * `recommendFor` tags) and the ones that are on although it rules them out, and the admin's Switch on through the
 * product's own feature report; every product names its OpenAPI document and says what the website builds. The email
 * provider (Resend) is a fake in this process.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBlueprint } from '@ss/contracts';
import {
	createProductInstance as createNotifications,
	manifest as notifyManifest,
	strings as notifyStrings,
} from '@ss/product-notifications/product';
import { createRoutes as notifyRoutes } from '@ss/product-notifications/routes';
import * as accounts from '@ss/product-accounts/product';
import { createRoutes as accountsRoutes } from '@ss/product-accounts/routes';
import * as chat from '@ss/product-chat/product';
import { createRoutes as chatRoutes } from '@ss/product-chat/routes';
import * as ecommerce from '@ss/product-ecommerce/product';
import { createRoutes as ecommerceRoutes } from '@ss/product-ecommerce/routes';
import * as growth from '@ss/product-growth/product';
import { createRoutes as growthRoutes } from '@ss/product-growth/routes';
import * as payments from '@ss/product-payments/product';
import { createRoutes as paymentsRoutes } from '@ss/product-payments/routes';
import { createProductInstance, manifest, strings } from '../fixtures/notes/adapters/product.js';
import { createRoutes } from '../fixtures/notes/server/routes.js';
import { PRODUCT_URL, codeOf, startSystem } from './helpers.js';

const NOTIFY = 'https://notifications-setup.test';
/** The other real products, each at its own address. */
const OTHERS = /** @type {const} */ ([
	['accounts', accounts, accountsRoutes],
	['chat', chat, chatRoutes],
	['ecommerce', ecommerce, ecommerceRoutes],
	['growth', growth, growthRoutes],
	['payments', payments, paymentsRoutes],
]);
/** @param {string} id */
const baseOf = (id) => `https://${id}-setup.test`;
const DOMAIN = 'setup.example.com';
const EMAIL_KEY = 're_live_setup_sheet_key_0123456789';

/** @type {import('./helpers.js').System} */
let sys;
let merchantId = '';
let websiteId = '';
/** @type {Awaited<ReturnType<import('./helpers.js').System['merchant']>>} */
let merchant;
/** @type {Record<string, { browser: string, server: string }>} */
const tokens = {};

beforeAll(async () => {
	sys = await startSystem({
		unit: {
			createProductInstance,
			createRoutes,
			manifest,
			strings,
			url: PRODUCT_URL,
			handlers: { 'https://api.resend.com': async () => Response.json({ data: [] }) },
		},
		extras: [
			{
				createProductInstance: createNotifications,
				createRoutes: notifyRoutes,
				manifest: notifyManifest,
				strings: notifyStrings,
				url: NOTIFY,
			},
			...OTHERS.map(([id, unit, routes]) => ({
				createProductInstance: /** @type {any} */ (unit.createProductInstance),
				createRoutes: /** @type {any} */ (routes),
				manifest: /** @type {any} */ (unit.manifest),
				strings: /** @type {any} */ (unit.strings),
				url: baseOf(id),
			})),
		],
	});
});
afterAll(async () => {
	await sys?.stop();
});

/** The website's sheet path. */
const sheetPath = () => `/v1/merchants/${merchantId}/websites/${websiteId}/setup`;

describe('Setup sheet (end to end)', () => {
	it('gathers Notes and Notifications for the merchant: features, settings with defaults marked, connections state, install', async () => {
		await sys.connect();
		await sys.connect({ base: NOTIFY });
		merchant = await sys.merchant('setup@shop.test', [DOMAIN]);
		merchantId = merchant.merchantId;
		websiteId = merchant.websiteIds[0] ?? '';
		for (const id of ['notes', 'notifications']) {
			await sys.addProduct(merchantId, websiteId, id);
			tokens[id] = await sys.tokens(merchantId, websiteId, id);
		}
		await sys.addCredits(merchantId, 100);
		const notes = await sys.adminSession(await sys.owner(), websiteId);
		await sys.switchFeatures(notes, websiteId, ['notes']);
		await sys.connectDatabase(notes, websiteId);
		expect(
			(await sys.dashboard(notes, 'PUT', `/v1/dashboard/websites/${websiteId}/settings/notes.maxLength`, { value: 300 }))
				.status,
		).toBe(204);
		const notify = await sys.adminSession(await sys.owner(), websiteId, 'notifications');
		expect(
			(await sys.dashboard(notify, 'PUT', `/v1/dashboard/websites/${websiteId}/features`, { on: ['email'] }, NOTIFY)).status,
		).toBe(200);
		const email = await sys.dashboard(
			notify,
			'PUT',
			`/v1/dashboard/websites/${websiteId}/connections/email`,
			{ value: { provider: 'resend', secret: EMAIL_KEY, from: `Shop <shop@${DOMAIN}>` } },
			NOTIFY,
		);
		expect(email.json).toMatchObject({ status: 'connected' });

		const res = await merchant.client.get(sheetPath());
		expect(res.status).toBe(200);
		const sheet = res.json;
		expect(validateBlueprint(sheet).ok).toBe(true);
		expect(sheet.website).toMatchObject({ id: websiteId, domain: DOMAIN });
		expect(sheet.access.allowedOrigins).toEqual([`https://${DOMAIN}`]);
		const [notesPart, notifyPart] = sheet.products;
		expect(notesPart).toMatchObject({
			productId: 'notes',
			reachable: true,
			status: 'active',
			serverToken: { issued: true },
			install: {
				scriptUrl: `${PRODUCT_URL}/widget.js`,
				browserToken: tokens.notes?.browser,
				snippet: `<script src="${PRODUCT_URL}/widget.js" data-token="${tokens.notes?.browser}" async></script>`,
			},
		});
		expect(notesPart.features[0]).toMatchObject({
			key: 'notes',
			on: true,
			settings: [{ key: 'maxLength', title: 'Longest note (characters)', value: 300, default: false }],
		});
		expect(notesPart.features[1]).toMatchObject({ key: 'import', on: false, settings: [] });
		expect(notesPart.widgets.find((/** @type {any} */ w) => w.key === 'note_form')).toMatchObject({ on: true, ready: true });
		expect(notifyPart).toMatchObject({ productId: 'notifications', reachable: true });
		expect(notifyPart.connections.find((/** @type {any} */ c) => c.key === 'email')).toMatchObject({
			needed: true,
			set: true,
			state: 'connected',
		});
		// never a secret: the email key, either server token
		const text = JSON.stringify(sheet);
		for (const secret of [EMAIL_KEY, tokens.notes?.server, tokens.notifications?.server])
			expect(text.includes(String(secret))).toBe(false);
		expect((await sys.activity('website.setup_opened')).length).toBe(1);
	});

	it('shows a product that cannot be reached, and the admin downloads the sheet as a file', async () => {
		sys.setReachable(false);
		const owner = await sys.owner();
		const res = await owner.get(`${sheetPath()}?fresh=1`);
		sys.setReachable(true);
		expect(res.status).toBe(200);
		expect(res.json.products[0]).toEqual({ productId: 'notes', name: 'Notes', reachable: false, reason: 'unreachable' });
		expect(res.json.products[1]).toMatchObject({ productId: 'notifications', reachable: true });
		const file = await owner.get(`${sheetPath()}?download=1&fresh=1`);
		expect(file.headers.get('content-disposition')).toBe(`attachment; filename="setup-${DOMAIN}.json"`);
		expect(file.json.products[0]).toMatchObject({ productId: 'notes', reachable: true });
		expect((await sys.activity('website.setup_downloaded')).length).toBe(1);
	});

	it('shares a read-only copy without values by a link until it is revoked', async () => {
		const made = await merchant.client.post(`${sheetPath()}/links`, { days: 2, values: false });
		expect(made.status).toBe(201);
		const key = String(made.json.url).split('#key=')[1];
		const shared = await sys.api.call('POST', '/v1/setup/shared', { body: { key } });
		expect(shared.status).toBe(200);
		expect(shared.headers.get('x-robots-tag')).toBe('noindex, nofollow');
		expect(validateBlueprint(shared.json).ok).toBe(true);
		expect(shared.json.share).toMatchObject({ values: false, install: true });
		expect(shared.json.products[0].features[0].settings).toEqual([
			{ key: 'maxLength', title: 'Longest note (characters)', default: false },
		]);
		expect((await merchant.client.get(`${sheetPath()}/links`)).json.items[0]).toMatchObject({ opens: 1, status: 'active' });
		expect((await merchant.client.del(`${sheetPath()}/links/${made.json.link.linkId}`)).status).toBe(200);
		expect(codeOf(await sys.api.call('POST', '/v1/setup/shared', { body: { key } }))).toBe('not_found');
		for (const action of ['website.setup_shared', 'website.setup_share_opened', 'website.setup_share_revoked'])
			expect((await sys.activity(action)).length).toBe(1);
	});

	it('gets a valid part from every real product on the website, with features on and a merchant database', async () => {
		for (const [id] of OTHERS) {
			await sys.connect({ base: baseOf(id) });
			await sys.addProduct(merchantId, websiteId, id);
			const cookie = await sys.adminSession(await sys.owner(), websiteId, id);
			const features = await sys.dashboard(
				cookie,
				'GET',
				`/v1/dashboard/websites/${websiteId}/features`,
				undefined,
				baseOf(id),
			);
			// every feature whose dependencies are free to switch on together: all of them
			const on = features.json.features.map((/** @type {{ key: string }} */ f) => f.key);
			expect(
				(await sys.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${websiteId}/features`, { on }, baseOf(id))).status,
			).toBe(200);
			await sys.connectDatabase(cookie, websiteId, baseOf(id));
		}
		const res = await merchant.client.get(`${sheetPath()}?fresh=1`);
		expect(res.status).toBe(200);
		const checked = validateBlueprint(res.json);
		expect(checked.ok, JSON.stringify(checked.ok ? [] : checked.problems.slice(0, 5))).toBe(true);
		expect(res.json.products.map((/** @type {any} */ p) => [p.productId, p.reachable])).toEqual([
			['accounts', true],
			['chat', true],
			['ecommerce', true],
			['growth', true],
			['notes', true],
			['notifications', true],
			['payments', true],
		]);
		for (const product of res.json.products) {
			expect(
				product.features.every(
					(/** @type {any} */ f) =>
						f.on ===
						(product.productId === 'notes'
							? f.key === 'notes'
							: product.productId === 'notifications'
								? f.key === 'email'
								: true),
				),
			).toBe(true);
			expect(product.checklist.length).toBeGreaterThan(0);
		}
		const text = JSON.stringify(res.json);
		for (const secret of [EMAIL_KEY, tokens.notes?.server, tokens.notifications?.server])
			expect(text.includes(String(secret))).toBe(false);
	});

	it('names each real product’s OpenAPI document and what the website builds for each feature on', async () => {
		const res = await merchant.client.get(sheetPath());
		for (const product of res.json.products) {
			const base =
				product.productId === 'notes'
					? PRODUCT_URL
					: product.productId === 'notifications'
						? NOTIFY
						: baseOf(product.productId);
			expect(product.docs.openapi, product.productId).toBe(`${base}/openapi.json`);
			expect((await sys.call('GET', '/openapi.json', { base })).status).toBe(200);
			const on = product.features.filter((/** @type {any} */ f) => f.on).map((/** @type {any} */ f) => f.key);
			expect(
				product.build.map((/** @type {any} */ b) => b.feature),
				product.productId,
			).toEqual(on);
			for (const entry of product.build) expect(entry.docs).toBe(`${base}/docs#feature-${entry.feature}`);
		}
	});

	it('recommends features from the merchant’s business profile, and the admin switches one on through the product', async () => {
		const saved = await merchant.client.put(`${sheetPath()}/profile`, {
			sells: ['physical'],
			pays: ['online'],
			signIn: ['email'],
			chat: ['people'],
			messages: ['sms'],
			moving: true,
			countries: ['US'],
		});
		expect(saved.status).toBe(200);
		const checked = validateBlueprint(saved.json);
		expect(checked.ok, JSON.stringify(checked.ok ? [] : checked.problems.slice(0, 5))).toBe(true);
		/** @param {any} sheet @param {string} id */
		const partOf = (sheet, id) => sheet.products.find((/** @type {any} */ p) => p.productId === id);
		const notes = partOf(saved.json, 'notes');
		expect(notes.recommended).toEqual([
			{ feature: 'notes', on: true, because: ['chat.people'], why: 'Your staff answer visitors in chat.' },
			{ feature: 'import', on: false, because: ['moving.yes'], why: 'You are moving from another website or system.' },
		]);
		// Notifications: SMS is recommended and off; Payments: a gateway of another country is on but not called for
		expect(partOf(saved.json, 'notifications').recommended).toContainEqual(
			expect.objectContaining({ feature: 'sms', on: false, because: ['messages.sms'] }),
		);
		expect(partOf(saved.json, 'payments').notRecommended).toContainEqual(
			expect.objectContaining({ feature: 'payfast_pk', missing: ['countries.pk'] }),
		);
		expect(partOf(saved.json, 'accounts').notRecommended).toContainEqual(
			expect.objectContaining({ feature: 'phone_code', missing: ['signIn.phone'] }),
		);
		// Ecommerce: the shop of physical goods with what it needs, and only what the profile asks for (it says nothing
		// about returns, wishlists, alerts, coupons, tax or courier booking); digital goods and bookings are on but not
		// called for
		const shop = partOf(saved.json, 'ecommerce');
		const recommended = shop.recommended.map((/** @type {any} */ entry) => entry.feature);
		expect(recommended).toEqual(expect.arrayContaining(['catalog', 'checkout', 'variants', 'staff_alerts', 'import']));
		for (const feature of ['returns', 'wishlist', 'alerts', 'coupons', 'bundles', 'taxes', 'courier_apis', 'invoices'])
			expect(recommended).not.toContain(feature);
		expect(shop.notRecommended.map((/** @type {any} */ entry) => entry.feature)).toEqual(
			expect.arrayContaining(['digital_goods', 'bookings']),
		);

		// the merchant cannot switch features; the Owner does it in one click, through the product's feature report
		expect((await merchant.client.post(`${sheetPath()}/features`, { productId: 'notes', feature: 'import' })).status).toBe(401);
		const before = (await sys.activity('product.features_changed')).length;
		const owner = await sys.owner();
		const switched = await owner.post(`${sheetPath()}/features`, { productId: 'notes', feature: 'import' });
		expect(switched.status).toBe(200);
		expect(switched.json.added).toEqual(['import']);
		expect(partOf(switched.json.sheet, 'notes').recommended[1]).toMatchObject({ feature: 'import', on: true });
		expect((await sys.activity('product.features_changed')).length).toBe(before + 1);
		// a feature with what it needs: Chat's language lock needs AI replies and visitor chat (all on already here)
		const again = await owner.post(`${sheetPath()}/features`, { productId: 'chat', feature: 'language_lock' });
		expect(again.json.added).toEqual([]);
		expect((await sys.activity('website.setup_profile_saved')).length).toBe(1);
	});
});
