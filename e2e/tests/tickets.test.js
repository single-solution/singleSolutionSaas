/**
 * PLAN 0.4.5: tickets for admin widgets, asked for with the server token Portal issued, bound to one origin, refused
 * while the product is stopped, and ended by regenerating the server token in the Portal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAY, codeOf, startSystem } from './helpers.js';

const ADMIN_ORIGIN = 'https://admin.tickets.example.com';
const USER = { id: 'u_1', name: 'Sam Staff', email: 'sam@tickets.example.com' };

/** @type {import('./helpers.js').System} */
let sys;
/** @type {Awaited<ReturnType<import('./helpers.js').System['merchant']>>} */
let m;
let websiteId = '';
/** @type {{ browser: string, server: string }} */
let tokens;
beforeAll(async () => {
	sys = await startSystem({ graceDays: 1 });
	await sys.connect();
	await sys.setPrices({ notes: 1000 });
	m = await sys.merchant('tickets@shop.test', ['tickets.example.com']);
	websiteId = m.websiteIds[0] ?? '';
	await sys.addProduct(m.merchantId, websiteId);
	await sys.addCredits(m.merchantId, 100);
	const cookie = await sys.adminSession(await sys.owner(), websiteId);
	await sys.connectDatabase(cookie, websiteId);
	await sys.switchFeatures(cookie, websiteId, ['notes']);
	tokens = await sys.tokens(m.merchantId, websiteId);
});
afterAll(async () => {
	await sys?.stop();
});

/** Ask for a ticket with a server token. @param {string} token @param {string} [origin] */
const ask = (token, origin = ADMIN_ORIGIN) =>
	sys.call('POST', '/v1/tickets', { token, body: { user: USER, permissions: ['notes.read'], origin } });

/** The admin widget's call with a ticket (null: no Origin). @param {string} ticket @param {string | null} [origin] */
const inbox = (ticket, origin = ADMIN_ORIGIN) =>
	sys.call('GET', '/v1/admin/notes', { token: ticket, ...(origin ? { origin } : {}) });

describe('tickets', () => {
	it('the server token gets a 15-minute ticket bound to one origin', async () => {
		const res = await ask(tokens.server);
		expect(res.status).toBe(200);
		expect(Date.parse(res.json.expiresAt) - sys.clock.now()).toBeGreaterThan(14 * 60_000);
		expect(Date.parse(res.json.expiresAt) - sys.clock.now()).toBeLessThanOrEqual(15 * 60_000);
		const ok = await inbox(res.json.ticket);
		expect(ok.status).toBe(200);
		expect(ok.headers.get('access-control-allow-origin')).toBe(ADMIN_ORIGIN);
		for (const origin of ['https://tickets.example.com', 'https://evil.example', null]) {
			const refused = await inbox(res.json.ticket, origin);
			expect([origin, refused.status, codeOf(refused)]).toEqual([origin, 401, 'invalid_token']);
		}
		// only the server token asks: not the browser token, not a ticket, never for a non-https origin
		expect((await ask(tokens.browser)).status).toBe(401);
		expect((await ask(res.json.ticket)).status).toBe(401);
		expect((await ask(tokens.server, 'http://admin.tickets.example.com')).status).toBe(422);
		expect((await ask(tokens.server, 'http://localhost:3000')).status).toBe(200);
		// and it lasts 15 minutes
		sys.clock.advance(15 * 60_000);
		expect((await inbox(res.json.ticket)).status).toBe(401);
	});

	it('tickets are refused while the product is stopped, and work again once credits restart it', async () => {
		const { json } = await ask(tokens.server);
		await sys.dashboard(await sys.adminSession(await sys.owner(), null), 'PUT', '/v1/dashboard/prices', {
			prices: { notes: 1_000_000 },
		});
		sys.clock.advance(DAY + 2 * 3_600_000); // the balance runs out in an hour, then one day of grace
		const stopped = await ask(tokens.server);
		expect([stopped.status, codeOf(stopped), stopped.json.reason]).toEqual([403, 'product_unavailable', 'stopped']);
		expect((await inbox(json.ticket)).status).toBe(401); // expired anyway; a fresh one cannot be had
		await sys.dashboard(await sys.adminSession(await sys.owner(), null), 'PUT', '/v1/dashboard/prices', {
			prices: { notes: 1000 },
		});
		await sys.addCredits(m.merchantId, 100_000);
		const again = await ask(tokens.server);
		expect(again.status).toBe(200);
		expect((await inbox(again.json.ticket)).status).toBe(200);
	});

	it('a ticket already issued is refused while stopped', async () => {
		const { json } = await ask(tokens.server);
		expect((await inbox(json.ticket)).status).toBe(200);
		await (await sys.owner()).post(`/v1/admin/merchants/${m.merchantId}/suspend`, { reason: 'Checks' });
		const refused = await inbox(json.ticket);
		expect([refused.status, refused.json.reason]).toEqual([403, 'suspended']);
		await (await sys.owner()).post(`/v1/admin/merchants/${m.merchantId}/resume`, {});
		expect((await inbox(json.ticket)).status).toBe(200);
	});

	it('regenerating the server token ends every ticket made with it', async () => {
		const { json } = await ask(tokens.server);
		expect((await inbox(json.ticket)).status).toBe(200);
		// (the suspension above ended the merchant's Portal sessions: an Owner regenerates)
		const regenerated = await (
			await sys.owner()
		).post(`/v1/merchants/${m.merchantId}/websites/${websiteId}/tokens/notes/regenerate`, {
			kind: 'server',
		});
		expect(regenerated.status).toBe(200);
		const ended = await inbox(json.ticket);
		expect([ended.status, codeOf(ended)]).toEqual([401, 'invalid_token']);
		const fresh = await ask(regenerated.json.token);
		expect((await inbox(fresh.json.ticket)).status).toBe(200);
	});
});
