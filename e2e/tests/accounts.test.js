/**
 * PLAN 0.12 step 7: Accounts against the REAL Portal, with the real Notifications next to it — connect (manifest and
 * price list), price and feature reports, a sign-up with e-mail and password through the browser token the Portal
 * issued, the sign-in verified offline with the public keys (by the merchant's server and by Notifications through the
 * pasted Accounts token), Notifications' activity-log copies arriving in Accounts, "delete my account" erased in
 * Notifications through the pasted Notifications token, and the hourly charge.
 */
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
		expect(await sys.setPrices({ email_password: 1000, data_rights: 250, activity_copies: 250 })).toMatchObject({ version: 2 });
		const support = await sys.admin('support');
		const cookie = await sys.adminSession(support.client, websiteId);
		const on = ['activity_copies', 'data_rights', 'email_password', 'roles'];
		const report = await sys.switchFeatures(cookie, websiteId, on);
		expect(report.version).toBe(1);
		expect([...report.on].sort()).toEqual(on);
		const [entry] = await sys.activity('product.features_changed');
		expect(entry?.after).toMatchObject({ on });
	});

	it('signs up with e-mail and password through the Portal-issued browser token', async () => {
		const cookie = await sys.adminSession(await sys.owner(), websiteId);
		await sys.connectDatabase(cookie, websiteId);
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

	it('the sign-in verifies offline: the merchant’s server with the public keys, Notifications with the pasted Accounts token', async () => {
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
		// Notifications trusts Accounts sign-ins once the Accounts server token is pasted into its Connections
		const notify = sys.others.notifications;
		expect(await notify.accounts.verify({ websiteId, token: signedUp.signIn })).toEqual({
			ok: false,
			code: 'accounts_not_connected',
		});
		const cookie = await sys.adminSession(await sys.owner(), websiteId, 'notifications');
		const pasted = await sys.dashboard(
			cookie,
			'PUT',
			`/v1/dashboard/websites/${websiteId}/connections/accounts`,
			{ value: accountsTokens.server },
			NOTIFY,
		);
		expect(pasted.json).toMatchObject({ status: 'connected' });
		expect(await notify.accounts.verify({ websiteId, token: signedUp.signIn })).toEqual({
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
		await sys.connectDatabase(cookie, websiteId, NOTIFY);
		const ticket = await sys.call('POST', '/v1/tickets', {
			base: NOTIFY,
			token: notifyTokens.server,
			body: {
				user: { id: 'u_9', name: 'Sam Staff', email: 'sam@people.example.com' },
				permissions: ['templates.edit'],
				origin: ADMIN_ORIGIN,
			},
		});
		const saved = await sys.call('PUT', '/v1/admin/templates', {
			base: NOTIFY,
			token: String(ticket.json.ticket),
			origin: ADMIN_ORIGIN,
			body: { key: 'welcome', channel: 'email', subject: 'Hi', text: 'Hello' },
		});
		expect(saved.status).toBe(200);
		const copies = await sys.call('GET', '/v1/activity-copies', { token: accountsTokens.server });
		expect(copies.json.items).toEqual([
			expect.objectContaining({
				productId: 'notifications',
				action: 'template.saved',
				actor: { kind: 'staff', id: 'u_9', name: 'Sam Staff' },
			}),
		]);

		// Accounts calls Notifications' data-rights routes with the pasted Notifications token
		const accountsCookie = await sys.adminSession(await sys.owner(), websiteId);
		const pasted = await sys.dashboard(accountsCookie, 'PUT', `/v1/dashboard/websites/${websiteId}/connections/notifications`, {
			value: notifyTokens.server,
		});
		expect(pasted.json).toMatchObject({ status: 'connected' });
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
					featuresOn: ['activity_copies', 'data_rights', 'email_password', 'roles'],
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
