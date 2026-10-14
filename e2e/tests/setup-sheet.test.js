/**
 * The website Setup sheet (owner request 2026-10-14, `ss.blueprint/1`) against the REAL Portal, the test product Notes
 * and Notifications, in this process: the Portal gathers each product's part through a signed Portal call
 * (`GET /v1/blueprint`), the merchant and the admin read and download it, a product that cannot be reached shows as
 * not reachable while the sheet still renders, and a share link gives a read-only copy (without values when asked)
 * until it is revoked. No secret is ever in a sheet: not a connection value, not a server token. The email provider
 * (Resend) is a fake in this process.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBlueprint } from '@ss/contracts';
import {
	createProductInstance as createNotifications,
	manifest as notifyManifest,
	strings as notifyStrings,
} from '@ss/product-notifications/product';
import { createRoutes as notifyRoutes } from '@ss/product-notifications/routes';
import { createProductInstance, manifest, strings } from '../fixtures/notes/adapters/product.js';
import { createRoutes } from '../fixtures/notes/server/routes.js';
import { PRODUCT_URL, codeOf, startSystem } from './helpers.js';

const NOTIFY = 'https://notifications-setup.test';
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
});
