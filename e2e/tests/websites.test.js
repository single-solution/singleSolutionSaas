/**
 * PLAN 0.4.11 and 0.5.9: the data-rights routes with the server token the Portal issued, and removing a website —
 * refused while products remain; then the domain is free, the tokens are revoked and the product deletes what its
 * product database holds for the website (`website.deleted`), never the merchant database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeOf, startSystem } from './helpers.js';

const DOMAIN = 'rights.example.com';
const ORIGIN = `https://${DOMAIN}`;

/** @type {import('./helpers.js').System} */
let sys;
/** @type {Awaited<ReturnType<import('./helpers.js').System['merchant']>>} */
let m;
let websiteId = '';
/** @type {{ browser: string, server: string }} */
let tokens;
/** @type {import('mongodb').Db} */
let merchantDb;
beforeAll(async () => {
	sys = await startSystem();
	await sys.connect();
	m = await sys.merchant('rights@shop.test', [DOMAIN]);
	websiteId = m.websiteIds[0] ?? '';
	await sys.addProduct(m.merchantId, websiteId);
	const cookie = await sys.adminSession(await sys.owner(), websiteId);
	merchantDb = await sys.connectDatabase(cookie, websiteId);
	await sys.switchFeatures(cookie, websiteId, ['notes']);
	tokens = await sys.tokens(m.merchantId, websiteId);
});
afterAll(async () => {
	await sys?.stop();
});

/** Rows the product database holds for a website (every kit collection). @param {string} id */
const productRows = async (id) => {
	let count = 0;
	for (const { name } of await sys.productDb.listCollections({}, { nameOnly: true }).toArray())
		count += await sys.productDb.collection(name).countDocuments({ websiteId: id });
	return count;
};

describe('data rights', () => {
	it('export and delete one end user’s records with the server token', async () => {
		for (const text of ['First note', 'Second note'])
			await sys.call('POST', '/v1/notes', { token: tokens.browser, origin: ORIGIN, body: { text, email: 'Ana@Example.com' } });
		await sys.call('POST', '/v1/notes', {
			token: tokens.browser,
			origin: ORIGIN,
			body: { text: 'Other', email: 'bo@example.com' },
		});

		const exported = await sys.call('POST', '/v1/data-rights/export', {
			token: tokens.server,
			body: { user: { email: 'ana@example.com' } },
		});
		expect(exported.status).toBe(200);
		expect(exported.json.records.notes.map((/** @type {{ text: string }} */ n) => n.text).sort()).toEqual([
			'First note',
			'Second note',
		]);
		// never with the browser token or from a browser
		expect(
			(
				await sys.call('POST', '/v1/data-rights/export', {
					token: tokens.browser,
					origin: ORIGIN,
					body: { user: { email: 'ana@example.com' } },
				})
			).status,
		).toBe(401);
		expect(
			(
				await sys.call('POST', '/v1/data-rights/export', {
					token: tokens.server,
					origin: ORIGIN,
					body: { user: { email: 'ana@example.com' } },
				})
			).status,
		).toBe(401);
		const invalid = await sys.call('POST', '/v1/data-rights/delete', { token: tokens.server, body: { user: {} } });
		expect([invalid.status, codeOf(invalid)]).toEqual([422, 'validation_failed']);

		const deleted = await sys.call('POST', '/v1/data-rights/delete', {
			token: tokens.server,
			body: { user: { email: 'ana@example.com' } },
		});
		expect(deleted.json).toEqual({ deleted: 2, anonymised: 0 });
		const after = await sys.call('POST', '/v1/data-rights/export', {
			token: tokens.server,
			body: { user: { email: 'ana@example.com' } },
		});
		expect(after.json.records).toEqual({ notes: [] });
		const rest = await sys.call('GET', '/v1/notes', { token: tokens.server });
		expect(rest.json.items.map((/** @type {{ text: string }} */ n) => n.text)).toEqual(['Other']);
	});
});

describe('removing a website', () => {
	it('is refused while a product is on it', async () => {
		const res = await (await sys.owner()).del(`/v1/merchants/${m.merchantId}/websites/${websiteId}`, { confirm: DOMAIN });
		expect([res.status, codeOf(res)]).toEqual([409, 'products_on_website']);
	});

	it('after its products are removed: frees the domain, revokes the tokens, and the product forgets the website', async () => {
		const owner = await sys.owner();
		const cookie = await sys.adminSession(owner, websiteId);
		const merchantCookie = await sys.merchantSession(m, websiteId);
		await sys.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${websiteId}/settings/notes.maxLength`, { value: 200 });
		expect(await productRows(websiteId)).toBeGreaterThan(0);
		const notesBefore = await merchantDb.listCollections().toArray();
		expect(notesBefore.length).toBeGreaterThan(0);

		await owner.del(`/v1/merchants/${m.merchantId}/websites/${websiteId}/products/notes`);
		const wrong = await owner.del(`/v1/merchants/${m.merchantId}/websites/${websiteId}`, { confirm: 'other.example.com' });
		expect(wrong.status).toBe(422);
		const removed = await owner.del(`/v1/merchants/${m.merchantId}/websites/${websiteId}`, { confirm: DOMAIN });
		expect(removed.status).toBe(200);
		expect(await sys.waitingNotices()).toEqual([]);

		// the product deleted the website's switches, settings, connections, changes and status; not the merchant database
		expect(await productRows(websiteId)).toBe(0);
		expect((await merchantDb.listCollections().toArray()).length).toBe(notesBefore.length);
		expect((await sys.dashboard(merchantCookie, 'GET', '/v1/dashboard/session')).status).toBe(401);
		const gone = await sys.dashboard(cookie, 'GET', `/v1/dashboard/websites/${websiteId}/overview`);
		expect([gone.status, codeOf(gone)]).toEqual([404, 'website_not_found']);

		// the tokens stop for good
		for (const [token, origin] of /** @type {const} */ ([
			[tokens.server, undefined],
			[tokens.browser, ORIGIN],
		])) {
			const res = await sys.call('GET', '/v1/widget/config', { token, ...(origin ? { origin } : {}) });
			expect([res.status, codeOf(res)]).toEqual([401, 'invalid_token']);
		}
		const revoked = await sys.productApi('GET', '/v1/product/revocations');
		expect(revoked.json.tokenIds).toHaveLength(2);

		// the domain is free at once: a new website, new tokens, nothing restored
		const again = await sys.addWebsite(m.merchantId, DOMAIN);
		expect(again).not.toBe(websiteId);
		await sys.addProduct(m.merchantId, again);
		const fresh = await sys.tokens(m.merchantId, again);
		expect(fresh.server).not.toBe(tokens.server);
		expect(await sys.product.featuresOn(again)).toEqual([]);
		const config = await sys.call('GET', '/v1/widget/config', { token: fresh.browser, origin: ORIGIN });
		expect([config.status, codeOf(config)]).toEqual([403, 'database_not_connected']);
	});
});
