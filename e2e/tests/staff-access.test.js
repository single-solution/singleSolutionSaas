/**
 * A stolen server token on the real Portal (SEC): the token the Portal issued runs the shop, but it changes no
 * configuration and reads no staff data on its own. Every change is a signed-in staff member's, with the permission, and
 * the dashboard's own session still changes everything it did.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeOf, startSystem } from './helpers.js';

const ORIGIN = 'https://secure.example.com';

/** @type {import('./helpers.js').System} */
let sys;
let websiteId = '';
/** @type {{ browser: string, server: string }} */
let tokens;
/** @type {string} */
let cookie;
beforeAll(async () => {
	sys = await startSystem();
	await sys.connect();
	const m = await sys.merchant('secure@shop.test', ['secure.example.com']);
	websiteId = m.websiteIds[0] ?? '';
	await sys.addProduct(m.merchantId, websiteId);
	await sys.addCredits(m.merchantId, 100);
	cookie = await sys.adminSession(await sys.owner(), websiteId);
	await sys.connectDatabase(cookie, websiteId);
	await sys.switchFeatures(cookie, websiteId, ['notes']);
	tokens = await sys.tokens(m.merchantId, websiteId);
});
afterAll(async () => {
	await sys?.stop();
});

describe('the Portal-issued server token alone', () => {
	it('runs the shop: features, settings and the visitors’ notes', async () => {
		for (const path of ['/v1/features', '/v1/settings', '/v1/texts', '/v1/theme', '/v1/format']) {
			expect([path, (await sys.call('GET', path, { token: tokens.server, bare: true })).status]).toEqual([path, 200]);
		}
		const note = await sys.call('POST', '/v1/notes', {
			token: tokens.server,
			bare: true,
			headers: { 'ss-visitor-ip': '203.0.113.7' },
			body: { text: 'From the server' },
		});
		expect(note.status).toBe(201);
	});

	it('changes no setting, text, theme, Format, list or connection and reads no staff data: 403 needs_signed_in_staff', async () => {
		for (const [method, path, body] of /** @type {Array<[string, string, unknown]>} */ ([
			['PUT', '/v1/settings/notes.maxLength', { value: 20 }],
			['PUT', '/v1/texts/form.title', { value: 'x' }],
			['PUT', '/v1/theme', { radius: 2 }],
			['PUT', '/v1/format', { wholeUnits: true }],
			['PUT', '/v1/connections/database', { value: 'mongodb://attacker.example.com/db' }],
			['DELETE', '/v1/connections/database', undefined],
			['GET', '/v1/connections', undefined],
			['GET', '/v1/activity', undefined],
			['GET', '/v1/notes', undefined],
			['POST', '/v1/tickets', { permissions: ['notes.read'], origin: 'https://admin.secure.example.com' }],
		])) {
			const refused = await sys.call(method, path, {
				token: tokens.server,
				bare: true,
				...(body === undefined ? {} : { body }),
			});
			expect([method, path, refused.status, codeOf(refused)]).toEqual([method, path, 403, 'needs_signed_in_staff']);
		}
	});

	it('is not helped by a sign-in of another website, an expired one or a customer’s', async () => {
		const other = await sys.staffIssuer.signIn({ websiteId: 'web_someone_else', sub: 'usr_x', permissions: ['*'] });
		const expired = await sys.staffIssuer.signIn({ websiteId, sub: 'usr_x', permissions: ['*'], ttlSeconds: 1 });
		sys.clock.advance(5 * 60_000);
		const customer = await sys.staffIssuer.signIn({
			websiteId,
			sub: 'usr_cal',
			name: 'Cal',
			role: 'customer',
			permissions: [],
		});
		for (const [signIn, status, code] of /** @type {Array<[string, number, string]>} */ ([
			[other, 401, 'invalid_sign_in'],
			[expired, 401, 'invalid_sign_in'],
			[customer, 403, 'forbidden'],
		])) {
			const answer = await sys.call('PUT', '/v1/theme', {
				token: tokens.server,
				bare: true,
				headers: { 'ss-sign-in': signIn },
				body: { radius: 2 },
			});
			expect([answer.status, codeOf(answer)]).toEqual([status, code]);
		}
	});
});

describe('a signed-in staff member with the permission', () => {
	it('changes a setting, and the change is theirs in Recent changes; the theme is the Portal’s, theirs too is refused', async () => {
		const staff = { id: 'usr_sam', name: 'Sam Staff', permissions: ['notes:settings.manage'] };
		const saved = await sys.call('PUT', '/v1/settings/notes.maxLength', { token: tokens.server, staff, body: { value: 70 } });
		expect(saved.status).toBe(200);
		const overview = await sys.dashboard(cookie, 'GET', `/v1/dashboard/websites/${websiteId}/overview`);
		expect(overview.json.recentChanges[0]).toMatchObject({
			what: 'settings',
			who: { kind: 'user', id: 'usr_sam', name: 'Sam Staff' },
		});
		// the theme is the website's, set once in the Portal: a signed-in staff member cannot change it here either
		const theme = await sys.call('PUT', '/v1/theme', { token: tokens.server, staff, body: { radius: 7 } });
		expect([theme.status, codeOf(theme)]).toEqual([409, 'managed_by_portal']);
		// and not the connections, which are their own permission
		const refused = await sys.call('PUT', '/v1/connections/database', {
			token: tokens.server,
			staff,
			body: { value: 'mongodb://attacker.example.com/db' },
		});
		expect([refused.status, codeOf(refused)]).toEqual([403, 'forbidden']);
	});
});

describe('the dashboard session', () => {
	it('still changes what it changed, with no sign-in, from the product’s own address only', async () => {
		const path = `/v1/dashboard/websites/${websiteId}/settings/notes.maxLength`;
		expect((await sys.dashboard(cookie, 'PUT', path, { value: 50 })).status).toBe(204);
		const foreign = await sys.call('PUT', path, { cookie, origin: ORIGIN, body: { value: 60 } });
		expect(foreign.status).toBe(403);
	});
});
