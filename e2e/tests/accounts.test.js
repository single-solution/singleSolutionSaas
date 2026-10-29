/**
 * PLAN 0.12 step 7: Accounts against the REAL Portal, with the real Notifications next to it — connect (manifest and
 * price list), price and feature reports, a sign-up with email and password through the browser token the Portal
 * issued, the sign-in verified offline with the public keys (by the merchant's server and by Notifications through the
 * Portal's link to Accounts), Notifications' activity-log copies arriving in Accounts, "delete my account" erased in
 * Notifications through the Portal's link to Notifications, and the hourly charge.
 */
import { staffSignIns } from '@ss/product-accounts/testing';
import { createPublicKey, verify } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	createProductInstance as createAccounts,
	manifest as accountsManifest,
	strings as accountsStrings,
} from '@ss/product-accounts/product';
import { createRoutes as accountsRoutes } from '@ss/product-accounts/routes';
import {
	createProductInstance as createNotifications,
	manifest as notifyManifest,
	strings as notifyStrings,
} from '@ss/product-notifications/product';
import { createRoutes as notifyRoutes } from '@ss/product-notifications/routes';
import { HOUR, startSystem } from './helpers.js';

const ACCOUNTS = 'https://accounts.test';
const NOTIFY = 'https://notifications.test';
const DOMAIN = 'people.example.com';
const ORIGIN = `https://${DOMAIN}`;
const ADMIN_ORIGIN = 'https://admin.people.example.com';

/** @type {import('./helpers.js').System} */
let sys;
/** @type {Awaited<ReturnType<import('./helpers.js').System['merchant']>>} */
let m;
let websiteId = '';
/** @type {{ browser: string, server: string }} */
let accountsTokens;
/** @type {{ browser: string, server: string }} */
let notifyTokens;
/** @type {any} */
let signedUp;
/** The sign-in of a staff Owner of the website, once its database is connected. @type {(who?: { id?: string, name?: string, role?: string, email?: string }) => Promise<string>} */
let staffSignIn;
/** The headers of a staff member’s call from the website’s server. */
const asStaff = async () => ({ 'ss-sign-in': await staffSignIn() });

beforeAll(async () => {
	sys = await startSystem({
		unit: {
			createProductInstance: createAccounts,
			createRoutes: accountsRoutes,
			manifest: accountsManifest,
			strings: accountsStrings,
			url: ACCOUNTS,
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

describe('Accounts on the real Portal', () => {
	it('connects: the Portal keeps its manifest and price list version 1, every feature at 0', async () => {
		expect(await sys.connect()).toMatchObject({ productId: 'accounts' });
		await sys.connect({ base: NOTIFY });
		const page = await (await sys.owner()).get('/v1/admin/products/accounts');
		expect(page.json.priceListVersion).toBe(1);
		expect(page.json.features.map((/** @type {{ key: string }} */ f) => f.key)).toEqual(
			accountsManifest.features.map((f) => f.key),
		);
		expect(page.json.features.every((/** @type {{ millicreditsPerHour: number }} */ f) => f.millicreditsPerHour === 0)).toBe(
			true,
		);
		m = await sys.merchant('people@shop.test', [DOMAIN]);
		websiteId = m.websiteIds[0] ?? '';
		await sys.addProduct(m.merchantId, websiteId, 'accounts');
		await sys.addProduct(m.merchantId, websiteId, 'notifications');
		await sys.addCredits(m.merchantId, 100);
		accountsTokens = await sys.tokens(m.merchantId, websiteId, 'accounts');
		notifyTokens = await sys.tokens(m.merchantId, websiteId, 'notifications');
	});

	it('an Owner prices features and a Support admin switches them on: both reports are accepted', async () => {
		expect(await sys.setPrices({ sign_in: 1000, data_rights: 250, activity_copies: 250 })).toMatchObject({ version: 2 });
		const support = await sys.admin('support');
		const cookie = await sys.adminSession(support.client, websiteId);
		const on = ['activity_copies', 'data_rights', 'roles', 'sign_in'];
		const report = await sys.switchFeatures(cookie, websiteId, on);
		expect(report.version).toBe(1);
		expect([...report.on].sort()).toEqual(on);
		const [entry] = await sys.activity('product.features_changed');
		expect(entry?.after).toMatchObject({ on });
	});

	it('signs up with email and password through the Portal-issued browser token', async () => {
		await sys.connectDatabase(websiteId);
		staffSignIn = staffSignIns(/** @type {any} */ (sys.product), {
			websiteId,
			merchantId: m.merchantId,
			domain: DOMAIN,
			base: ACCOUNTS,
		});
		const up = await sys.call('POST', '/v1/sign-up/password', {
			token: accountsTokens.browser,
			origin: ORIGIN,
			body: { email: 'reader@example.com', password: 'a long enough password', name: 'Rea Der' },
		});
		expect(up.status).toBe(200);
		expect(up.json).toMatchObject({ status: 'signed_in', user: { email: 'reader@example.com', role: 'customer' } });
		signedUp = up.json;
		// another website's origin is refused with the same answer as a bad token
		const elsewhere = await sys.call('POST', '/v1/sign-in/password', {
			token: accountsTokens.browser,
			origin: 'https://elsewhere.example.org',
			body: { email: 'reader@example.com', password: 'a long enough password' },
		});
		expect(elsewhere.status).toBe(401);
		const me = await sys.call('GET', '/v1/me', { token: accountsTokens.browser, origin: ORIGIN });
		expect(me.status).toBe(401);
	});

	it('the sign-in verifies offline: the merchant’s server with the public keys, Notifications with the Portal’s link to Accounts', async () => {
		const keys = await sys.call('GET', `/v1/websites/${websiteId}/keys`);
		expect(keys.json.issuer).toBe(ACCOUNTS);
		const [header, payload, signature] = String(signedUp.signIn).split('.');
		const jwk = keys.json.keys[0];
		expect(
			verify(
				null,
				Buffer.from(`${header}.${payload}`),
				createPublicKey({ key: jwk, format: 'jwk' }),
				Buffer.from(String(signature), 'base64url'),
			),
		).toBe(true);
		const claims = JSON.parse(Buffer.from(String(payload), 'base64url').toString('utf8'));
		expect(claims).toMatchObject({ iss: ACCOUNTS, aud: websiteId, sub: signedUp.user.id, role: 'customer', permissions: [] });
		// Notifications trusts Accounts sign-ins because the Portal linked the two products of the website: nothing is pasted
		const notify = sys.others.notifications;
		expect(await notify.accounts.verify({ websiteId, token: signedUp.signIn })).toMatchObject({
			ok: true,
			user: { id: signedUp.user.id, email: 'reader@example.com', name: 'Rea Der', role: 'customer', permissions: [] },
		});
	});

	it('Notifications sends its activity-log copies to Accounts, and Accounts erases a user in Notifications', async () => {
		const cookie = await sys.adminSession(await sys.owner(), websiteId, 'notifications');
		const switched = await sys.dashboard(
			cookie,
			'PUT',
			`/v1/dashboard/websites/${websiteId}/features`,
			{ on: ['send_api', 'email'] },
			NOTIFY,
		);
		expect(switched.status).toBe(200);
		await sys.connectDatabase(websiteId, NOTIFY);
		const ticket = await sys.call('POST', '/v1/tickets', {
			base: NOTIFY,
			token: notifyTokens.server,
			staff: { id: 'u_9', name: 'Sam Staff', email: 'sam@people.example.com' },
			body: { permissions: ['templates.edit'], origin: ADMIN_ORIGIN },
		});
		const saved = await sys.call('PUT', '/v1/admin/templates', {
			base: NOTIFY,
			token: String(ticket.json.ticket),
			origin: ADMIN_ORIGIN,
			body: { key: 'welcome', channel: 'email', subject: 'Hi', text: 'Hello' },
		});
		expect(saved.status).toBe(200);
		const copies = await sys.call('GET', '/v1/activity-copies', { token: accountsTokens.server, headers: await asStaff() });
		expect(copies.json.items).toEqual([
			expect.objectContaining({
				productId: 'notifications',
				action: 'template.saved',
				actor: { kind: 'staff', id: 'u_9', name: 'Sam Staff' },
				label: expect.stringContaining('welcome'),
			}),
		]);
		// the copies carry the label and are read with the activity filters and counts (PLAN 0.8.10 K9, K4)
		const found = await sys.call('GET', '/v1/activity-copies?q=welcome&productId=notifications&actor=u_9', {
			token: accountsTokens.server,
			headers: await asStaff(),
		});
		expect(found.json.items).toHaveLength(1);
		expect(
			(
				await sys.call('GET', '/v1/activity-copies?q=nothing-like-it', {
					token: accountsTokens.server,
					headers: await asStaff(),
				})
			).json.items,
		).toEqual([]);
		const copyCount = await sys.call('GET', '/v1/activity-copies/count', {
			token: accountsTokens.server,
			headers: await asStaff(),
		});
		expect(copyCount.json).toEqual({ count: copies.json.items.length, capped: false });
		const users = await sys.call('GET', '/v1/users?limit=100', { token: accountsTokens.server, headers: await asStaff() });
		const userCount = await sys.call('GET', '/v1/users/count', { token: accountsTokens.server, headers: await asStaff() });
		expect(userCount.json).toEqual({ count: users.json.items.length, capped: false });
		expect(users.json.items.length).toBeGreaterThan(0);

		// Accounts calls Notifications' data-rights routes with the Portal's link to Notifications (scoped to data rights)
		const fresh = await sys.call('POST', '/v1/sign-in/password', {
			token: accountsTokens.browser,
			origin: ORIGIN,
			body: { email: 'reader@example.com', password: 'a long enough password' },
		});
		const exported = await sys.call('POST', '/v1/me/export', {
			token: accountsTokens.browser,
			origin: ORIGIN,
			headers: { 'ss-sign-in': fresh.json.signIn },
		});
		expect(exported.json.url).toContain(`/v1/exports/${websiteId}/`);
		const file = await sys.call('GET', new URL(exported.json.url).pathname);
		expect(file.json.records).toMatchObject({ accounts: { user: { email: 'reader@example.com' } }, notifications: {} });
		const asked = await sys.call('POST', '/v1/me/delete', {
			token: accountsTokens.browser,
			origin: ORIGIN,
			headers: { 'ss-sign-in': fresh.json.signIn },
		});
		expect(asked.status).toBe(202);
		const approved = await sys.call('POST', `/v1/users/${signedUp.user.id}/deletion/approve`, {
			token: accountsTokens.server,
			headers: await asStaff(),
			body: {},
		});
		expect(approved.json).toEqual({ deleted: true, pending: [] });
		const gone = await sys.call('POST', '/v1/sign-in/password', {
			token: accountsTokens.browser,
			origin: ORIGIN,
			body: { email: 'reader@example.com', password: 'a long enough password' },
		});
		expect(gone.status).toBe(401);
	});

	it('the Portal charges the switched-on features every clock hour', async () => {
		const cards = await m.client.get(`/v1/merchants/${m.merchantId}/websites/${websiteId}/products`);
		expect(cards.json.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					productId: 'accounts',
					featuresOn: ['activity_copies', 'data_rights', 'roles', 'sign_in'],
					hourlyCost: 1500,
					dailyCost: 36_000,
				}),
			]),
		);
		const cookie = await sys.merchantSession(m, websiteId);
		const before = await sys.dashboard(cookie, 'GET', `/v1/dashboard/websites/${websiteId}/overview`);
		expect(before.json).toMatchObject({ status: { status: 'active' } });
		sys.clock.advance(HOUR);
		const after = await sys.dashboard(cookie, 'GET', `/v1/dashboard/websites/${websiteId}/overview`);
		expect(after.json.todayMillicredits).toBe(before.json.todayMillicredits + 1500);
	});
});
