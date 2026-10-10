/**
 * PLAN 0.8.10 K3 and K4 against the real Portal, on the test product Notes: the merchant's server calls a visitor route
 * with the Portal-issued server token (no Origin) for one visitor named by `SS-Visitor-IP`; those calls count in their
 * own window, not the browser one, but keep the per-visitor limits; a write needs the visitor's address; and a list's
 * count equals its length, for the server and the admin widget.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeOf, startSystem } from './helpers.js';

const SITE = 'https://calls.example.com';
const ADMIN_ORIGIN = 'https://admin.calls.example.com';

/** @type {import('./helpers.js').System} */
let sys;
let websiteId = '';
/** @type {{ browser: string, server: string }} */
let tokens;

beforeAll(async () => {
	sys = await startSystem();
	await sys.connect();
	const m = await sys.merchant('calls@shop.test', ['calls.example.com']);
	websiteId = m.websiteIds[0] ?? '';
	await sys.addProduct(m.merchantId, websiteId);
	const cookie = await sys.adminSession(await sys.owner(), websiteId);
	await sys.connectDatabase(cookie, websiteId);
	await sys.switchFeatures(cookie, websiteId, ['notes']);
	tokens = await sys.tokens(m.merchantId, websiteId);
});
afterAll(async () => {
	await sys?.stop();
});

/**
 * A visitor's note sent by the merchant's server (the clock stays still, so every call is inside one rate window).
 * @param {string | null} ip @param {string} [text]
 */
const fromServer = (ip, text = 'Sent from the store server') =>
	sys.call('POST', '/v1/notes', {
		token: tokens.server,
		body: { text },
		headers: ip ? { 'ss-visitor-ip': ip } : {},
		tick: false,
	});

/** A visitor's note sent from a page of the website, from one address. @param {string} ip */
const fromBrowser = (ip) =>
	sys.call('POST', '/v1/notes', {
		token: tokens.browser,
		origin: SITE,
		body: { text: 'From a page' },
		headers: { 'x-forwarded-for': ip },
		tick: false,
	});

describe('visitor calls from the merchant’s server (K3)', () => {
	it('answer exactly as for the visitor, without an Origin and without CORS', async () => {
		const sent = await fromServer('203.0.113.10');
		expect(sent.status).toBe(201);
		expect(sent.json).toMatchObject({ id: expect.stringMatching(/^note_/) });
		expect(sent.headers.get('access-control-allow-origin')).toBeNull();
		const config = await sys.call('GET', '/v1/widget/config', { token: tokens.server });
		expect(config.status).toBe(200);
		expect(config.json).toMatchObject({ features: ['notes'], format: { currencyDisplay: 'code' }, timeZone: 'UTC' });
		// a server token with an Origin is still refused; a browser token without one too
		expect((await sys.call('POST', '/v1/notes', { token: tokens.server, origin: SITE, body: { text: 'x' } })).status).toBe(401);
		expect((await sys.call('POST', '/v1/notes', { token: tokens.browser, body: { text: 'x' } })).status).toBe(401);
	});

	it("need the visitor's address on writes", async () => {
		const missing = await fromServer(null);
		expect([missing.status, codeOf(missing)]).toEqual([400, 'visitor_ip_required']);
		expect((await fromServer('not-an-address')).status).toBe(400);
	});

	it('count in their own window: past the browser limit of the website, while the browser window stays its own', async () => {
		sys.clock.advance(60_000);
		// Notes allows 120 visitor notes a minute per website from browsers, and 5 per visitor
		for (let i = 0; i < 121; i += 1) expect((await fromServer(`198.51.100.${i + 1}`, `Note ${i}`)).status).toBe(201);
		// the same minute: the browser window is untouched by them, and still ends at 120
		for (let i = 0; i < 120; i += 1) expect((await fromBrowser(`203.0.113.${i + 1}`)).status).toBe(201);
		const limited = await fromBrowser('203.0.113.200');
		expect([limited.status, codeOf(limited)]).toEqual([429, 'rate_limited']);
		// … while the server's window (3,000 a minute per route per website) goes on
		expect((await fromServer('198.51.100.200')).status).toBe(201);
	});

	it('keep the per-visitor limits, by the visitor’s address', async () => {
		sys.clock.advance(60_000);
		const answers = [];
		for (let i = 0; i < 6; i += 1) answers.push((await fromServer('192.0.2.77', `Again ${i}`)).status);
		// earlier in this minute 192.0.2.77 sent nothing; the sixth note is one too many
		expect(answers).toEqual([201, 201, 201, 201, 201, 429]);
		expect((await fromServer('192.0.2.78')).status).toBe(201);
	});
});

describe('counts equal list lengths (K4)', () => {
	it('for the merchant’s server and for the admin widget', async () => {
		/** @type {string[]} */
		const ids = [];
		/** @type {string | null} */
		let cursor = null;
		do {
			const page = await sys.call('GET', `/v1/notes?limit=100${cursor ? `&cursor=${cursor}` : ''}`, { token: tokens.server });
			ids.push(...page.json.items.map((/** @type {{ id: string }} */ note) => note.id));
			cursor = page.json.nextCursor;
		} while (cursor);
		expect(ids.length).toBeGreaterThan(125);
		const count = await sys.call('GET', '/v1/notes/count', { token: tokens.server });
		expect(count.json).toEqual({ count: ids.length, capped: false });
		const ticket = await sys.call('POST', '/v1/tickets', {
			token: tokens.server,
			body: {
				user: { id: 'u_1', name: 'Sam Staff', email: 'sam@calls.example.com' },
				permissions: ['notes.read'],
				origin: ADMIN_ORIGIN,
			},
		});
		const admin = await sys.call('GET', '/v1/admin/notes/count', { token: ticket.json.ticket, origin: ADMIN_ORIGIN });
		expect(admin.json).toEqual({ count: ids.length, capped: false });
	});
});
