/**
 * PLAN 0.4.4 and 0.5.9: the two tokens of a product on a website, created on Add product, shown in Install and tokens,
 * revealed and regenerated in the Portal, and obeyed by the product (browser token origins, server token without an
 * Origin, revocation after `token.revoked`, tokens of another product refused).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRODUCT_URL, codeOf, startSystem } from './helpers.js';

const DOMAIN = 'tokens.example.com';
const ORIGIN = `https://${DOMAIN}`;

/** @type {import('./helpers.js').System} */
let sys;
/** @type {Awaited<ReturnType<import('./helpers.js').System['merchant']>>} */
let m;
let websiteId = '';
beforeAll(async () => {
	sys = await startSystem();
	await sys.connect();
	m = await sys.merchant('tokens@shop.test', [DOMAIN]);
	websiteId = m.websiteIds[0] ?? '';
	await sys.addProduct(m.merchantId, websiteId);
	const owner = await sys.owner();
	const cookie = await sys.adminSession(owner, websiteId);
	await sys.connectDatabase(cookie, websiteId);
	await sys.switchFeatures(cookie, websiteId, ['notes']);
});
afterAll(async () => {
	await sys?.stop();
});

describe('tokens of a product on a website', () => {
	it('Add product issues both; Install and tokens shows the browser token and the script tag data', async () => {
		const list = await m.client.get(`/v1/merchants/${m.merchantId}/websites/${websiteId}/tokens`);
		expect(list.status).toBe(200);
		expect(list.json.items).toEqual([
			{
				productId: 'notes',
				name: 'Notes',
				widgetScriptUrl: `${PRODUCT_URL}/widget.js`,
				docsUrl: `${PRODUCT_URL}/docs`,
				browserToken: expect.any(String),
				serverToken: { canShow: true },
			},
		]);
		// the script tag the merchant pastes loads the product's widget script, which needs no Origin
		const script = await sys.call('GET', '/widget.js');
		expect(script.status).toBe(200);
		expect(script.headers.get('content-type')).toMatch(/javascript/);
		// and its browser token reads the website's widget config from the website
		const config = await sys.call('GET', '/v1/widget/config', { token: list.json.items[0].browserToken, origin: ORIGIN });
		expect(config.status).toBe(200);
		expect(config.json).toMatchObject({ features: ['notes'] });
	});

	it('Finance never sees tokens; reveals are logged and never cached', async () => {
		const finance = await sys.admin('finance');
		const base = `/v1/merchants/${m.merchantId}/websites/${websiteId}/tokens`;
		expect((await finance.client.get(base)).status).toBe(403);
		expect((await finance.client.post(`${base}/notes/reveal`, {})).status).toBe(403);
		expect((await finance.client.post(`${base}/notes/regenerate`, { kind: 'server' })).status).toBe(403);
		const revealed = await m.client.post(`${base}/notes/reveal`, {});
		expect(revealed.status).toBe(200);
		expect(revealed.headers.get('cache-control')).toMatch(/no-store/);
		expect((await sys.activity('token.revealed')).length).toBeGreaterThan(0);
	});

	it('the browser token works only from the exact https domain and local origins', async () => {
		const { browser } = await sys.tokens(m.merchantId, websiteId);
		/** @param {string | undefined} origin */
		const post = (origin) =>
			sys.call('POST', '/v1/notes', { token: browser, ...(origin ? { origin } : {}), body: { text: `From ${origin}` } });
		for (const origin of [
			ORIGIN,
			'http://localhost:5173',
			'https://shop.localhost:3000',
			'http://127.0.0.1:8080',
			'http://[::1]:4000',
		]) {
			const res = await post(origin);
			expect([origin, res.status]).toEqual([origin, 201]);
			expect(res.headers.get('access-control-allow-origin')).toBe(origin);
		}
		for (const origin of [
			`http://${DOMAIN}`,
			`https://www.${DOMAIN}`,
			`https://${DOMAIN}:8443`,
			'https://evil.example',
			undefined,
		]) {
			const res = await post(origin);
			expect([origin, res.status, codeOf(res)]).toEqual([origin, 401, 'invalid_token']);
		}
	});

	it('the server token works only without an Origin; tokens of another product or forged ones are refused', async () => {
		const { browser, server } = await sys.tokens(m.merchantId, websiteId);
		const ok = await sys.call('GET', '/v1/notes', { token: server });
		expect(ok.status).toBe(200);
		expect(ok.headers.get('access-control-allow-origin')).toBeNull();
		const withOrigin = await sys.call('GET', '/v1/notes', { token: server, origin: ORIGIN });
		expect([withOrigin.status, codeOf(withOrigin)]).toEqual([401, 'invalid_token']);
		// a browser token is not a server token
		expect((await sys.call('GET', '/v1/notes', { token: browser })).status).toBe(401);

		// another product on the same website: its tokens name it, so Notes refuses them
		const memo = sys.startOtherProduct('memo');
		await sys.connect({ base: memo.base });
		await sys.addProduct(m.merchantId, websiteId, 'memo');
		const other = await sys.tokens(m.merchantId, websiteId, 'memo');
		const wrongServer = await sys.call('GET', '/v1/notes', { token: other.server });
		expect([wrongServer.status, codeOf(wrongServer)]).toEqual([401, 'invalid_token']);
		const wrongBrowser = await sys.call('GET', '/v1/widget/config', { token: other.browser, origin: ORIGIN });
		expect([wrongBrowser.status, codeOf(wrongBrowser)]).toEqual([401, 'invalid_token']);
		// and the other product takes its own
		expect((await sys.call('POST', '/v1/tickets', { base: memo.base, token: other.server, body: {} })).status).toBe(422);
		// a token that only looks like one
		const [head = '', body = ''] = server.split('.');
		expect((await sys.call('GET', '/v1/notes', { token: `${head}.${body}.AAAA` })).status).toBe(401);
	});

	it('regenerating the server token revokes the old one at the product after token.revoked', async () => {
		const before = await sys.tokens(m.merchantId, websiteId);
		const base = `/v1/merchants/${m.merchantId}/websites/${websiteId}/tokens/notes`;
		const res = await m.client.post(`${base}/regenerate`, { kind: 'server' });
		expect(res.status).toBe(200);
		expect(res.json).toMatchObject({ productId: 'notes', kind: 'server', token: expect.any(String) });
		expect(res.json.token).not.toBe(before.server);
		expect((await sys.activity('token.regenerated')).length).toBeGreaterThan(0);
		expect(await sys.waitingNotices()).toEqual([]);

		const old = await sys.call('GET', '/v1/notes', { token: before.server });
		expect([old.status, codeOf(old)]).toEqual([401, 'invalid_token']);
		expect((await sys.call('GET', '/v1/notes', { token: res.json.token })).status).toBe(200);
		expect((await m.client.post(`${base}/reveal`, {})).json.serverToken).toBe(res.json.token);
		// the browser token is untouched
		expect((await sys.tokens(m.merchantId, websiteId)).browser).toBe(before.browser);
	});
});
