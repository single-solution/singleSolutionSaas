import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { validateWebsiteSettings } from '@ss/contracts';
import { manifest as notesManifest } from '@ss/contracts/testing';
import { closeMongoClients } from '../../../src/testing.js';
import { startMongo } from '../../helpers.js';
import { bootPortal, codeOf } from '../catalog/boot.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

/** @type {Awaited<ReturnType<typeof startMongo>>} */
let mongo;
/** @type {Array<() => Promise<unknown>>} */
const cleanups = [];
beforeAll(async () => {
	mongo = await startMongo();
}, 180_000);
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});
afterAll(async () => {
	await closeMongoClients();
	await mongo?.stop();
});

/** The Region & format form as the console sends it. */
const region = (over = {}) => ({
	country: 'US',
	timeZone: 'America/New_York',
	currency: 'USD',
	currencies: ['USD'],
	language: 'en-US',
	languages: ['en-US'],
	countriesServed: [],
	units: { weight: 'lb', size: 'in' },
	format: { locale: '', currencyDisplay: 'code', currencySymbols: {}, wholeUnits: false, times: 'viewer' },
	phone: { callingCode: '+1', trunkPrefix: '', countries: [] },
	address: { required: ['line1', 'city'], regions: [] },
	...over,
});

/** The Business form with a name. @param {Record<string, unknown>} [over] */
const business = (over = {}) => ({
	name: 'Example Shop',
	otherNames: [],
	tagline: '',
	legalName: '',
	taxNumber: '',
	businessType: '',
	email: 'hello@shop.test',
	phone: '',
	phones: [],
	whatsapp: '',
	address: { line1: '', line2: '', area: '', city: '', region: '', postalCode: '', country: '' },
	hours: { weekly: [], exceptions: [] },
	social: [],
	...over,
});

/** @param {string} name */
const setUp = async (name) => {
	const h = await bootPortal({ db: mongo.db(name) });
	cleanups.push(h.close);
	const owner = await h.owner();
	// Notes asks for a currency and a country; Chat needs nothing
	const notes = await h.connect({ ...notesManifest(), websiteSettings: { requires: ['region.currency', 'region.country'] } });
	const chat = await h.connect({ ...notesManifest(), id: 'chat', name: 'Chat' });
	const m = await h.merchant('m@shop.test', ['shop.example.com', 'blog.example.com']);
	const [w1 = '', w2 = ''] = m.websiteIds;
	await owner.post(`/v1/merchants/${m.merchantId}/websites/${w1}/products`, { productId: 'notes' });
	h.clock.advance(1000);
	await owner.post(`/v1/merchants/${m.merchantId}/websites/${w1}/products`, { productId: 'chat' });
	h.clock.advance(1000);
	await owner.post(`/v1/merchants/${m.merchantId}/websites/${w2}/products`, { productId: 'notes' });
	h.clock.advance(1000);
	notes.notices.splice(0);
	chat.notices.splice(0);
	const url = (/** @type {string} */ website = w1, suffix = '') =>
		`/v1/merchants/${m.merchantId}/websites/${website}/settings${suffix}`;
	return { h, owner, notes, chat, m, w1, w2, url };
};

/** @param {string} websiteId */
const changed = (websiteId) => ({ type: 'website.settings_changed', websiteId, what: 'settings' });

describe('Website settings: the Portal keeps the facts every product of a website shares', () => {
	it('answers an empty document (version 0) for a website nothing was saved for, and what each product needs', async () => {
		const { m, url, w1 } = await setUp('ws_empty');
		const res = await m.client.get(url());
		expect(res.status).toBe(200);
		expect(res.json.settings).toMatchObject({ schema: 'ss.website-settings/1', websiteId: w1, version: 0, updatedAt: null });
		expect(validateWebsiteSettings(res.json.settings).ok).toBe(true);
		expect(res.json.can).toEqual({ write: true });
		// the readiness line: Notes needs a currency and a country, Chat nothing
		expect(res.json.readiness).toEqual([
			{ productId: 'chat', name: 'Chat', requires: [], missing: [] },
			{
				productId: 'notes',
				name: 'Notes',
				requires: ['region.currency', 'region.country'],
				missing: ['region.currency', 'region.country'],
			},
		]);
	});

	it('the readiness line counts what a feature that is on asks for, and nothing for one that is off', async () => {
		const h = await bootPortal({ db: mongo.db('ws_feature_requires') });
		cleanups.push(h.close);
		const owner = await h.owner();
		const base = notesManifest();
		const notes = await h.connect({
			...base,
			features: [
				{ ...base.features[0], requires: ['pages.signIn'] },
				{ ...base.features[1], requires: ['team.recipients'] },
			],
		});
		const m = await h.merchant('m@shop.test', ['shop.example.com']);
		const w1 = m.websiteIds[0] ?? '';
		await owner.post(`/v1/merchants/${m.merchantId}/websites/${w1}/products`, { productId: 'notes' });
		const url = `/v1/merchants/${m.merchantId}/websites/${w1}/settings`;
		const readiness = async () => (await m.client.get(url)).json.readiness[0];
		// no feature on: nothing asked for
		expect(await readiness()).toMatchObject({ productId: 'notes', requires: [], missing: [] });
		const admin = await h.api.call('GET', '/v1/me', { cookie: owner.cookie });
		const report = async (/** @type {number} */ version, /** @type {string[]} */ on) => {
			h.clock.advance(1000);
			const sent = await h.productCall(notes, 'PUT', `/v1/product/websites/${w1}/features`, {
				version,
				on,
				adminId: admin.json.admin.adminId,
				adminName: 'Olivia',
			});
			expect([version, sent.status, JSON.stringify(sent.json)]).toEqual([version, 200, JSON.stringify({ version })]);
		};
		await report(1, ['notes']);
		expect(await readiness()).toMatchObject({ requires: ['pages.signIn'], missing: ['pages.signIn'] });
		await report(2, ['notes', 'inbox']);
		expect((await readiness()).requires.sort()).toEqual(['pages.signIn', 'team.recipients']);
		await report(3, ['notes']);
		expect((await readiness()).requires).toEqual(['pages.signIn']);
	});

	it('a merchant saves a section: the version rises, products on that website are told once each, and the change is logged', async () => {
		const { h, notes, chat, m, w1, w2, url } = await setUp('ws_save');
		const saved = await m.client.put(url(w1, '/region'), { version: 0, value: region() });
		expect(saved.status).toBe(200);
		expect(saved.json.settings).toMatchObject({ version: 1, region: { timeZone: 'America/New_York', currency: 'USD' } });
		expect(saved.json.settings.updatedAt).toEqual(expect.any(String));
		// the other sections stay as they were
		expect(saved.json.settings.business.name).toBe('');
		expect(validateWebsiteSettings(saved.json.settings).ok).toBe(true);
		expect((await m.client.get(url(w1))).json.settings.region.timeZone).toBe('America/New_York');
		// both products on the website were told; the other website's products were not
		expect(notes.notices).toEqual([changed(w1)]);
		expect(chat.notices).toEqual([changed(w1)]);
		expect((await m.client.get(url(w2))).json.settings.version).toBe(0);
		// the readiness line follows the document
		const ready = (await m.client.get(url(w1))).json.readiness.find((/** @type {any} */ r) => r.productId === 'notes');
		expect(ready.missing).toEqual([]);
		// Activity: who, what section, which fields (field names and small values), never the whole document
		const [entry] = await h.activity('website.settings_saved');
		if (!entry) throw new Error('no Activity entry');
		expect(entry).toMatchObject({
			actor: { type: 'merchant', id: m.merchantId },
			target: { type: 'website', id: w1, websiteId: w1 },
			merchantId: m.merchantId,
			after: { section: 'region', version: 1 },
		});
		expect(entry.after.changed).toEqual(expect.arrayContaining(['country', 'timeZone', 'currency', 'currencies']));
		expect(entry.after.values.timeZone).toEqual({ from: '', to: 'America/New_York' });
		expect(entry.requestId).toEqual(expect.any(String));
	});

	it('a second save sends a new notice; one the product has not taken yet is not queued twice', async () => {
		const { h, notes, m, w1, url } = await setUp('ws_notice_once');
		notes.tamper.noticeStatus = 503;
		await m.client.put(url(w1, '/region'), { version: 0, value: region() });
		h.clock.advance(1000);
		await m.client.put(url(w1, '/business'), { version: 1, value: business() });
		h.clock.advance(1000);
		expect(
			await h.db.collection('catalog_notices').countDocuments({ productId: 'notes', type: 'website.settings_changed' }),
		).toBe(1);
		// a product that cannot be reached never fails the save
		expect((await m.client.get(url(w1))).json.settings.version).toBe(2);
		delete notes.tamper.noticeStatus;
		await h.productCall(notes, 'GET', '/v1/product/directory/notes');
		h.clock.advance(1000);
		expect(notes.notices).toEqual([changed(w1)]);
	});

	it('refuses a save made from an older version (409), a bad value (422, saved nothing, told nobody) and a section that is not one (404)', async () => {
		const { h, notes, m, w1, url } = await setUp('ws_refuse');
		await m.client.put(url(w1, '/region'), { version: 0, value: region() });
		h.clock.advance(1000);
		notes.notices.splice(0);
		const stale = await m.client.put(url(w1, '/business'), { version: 0, value: business() });
		expect(codeOf(stale)).toEqual([409, 'conflict']);
		const wrong = await m.client.put(url(w1, '/region'), {
			version: 1,
			value: region({ timeZone: 'Mars/Base', countriesServed: ['ZZ'] }),
		});
		expect(codeOf(wrong)).toEqual([422, 'validation_failed']);
		expect(wrong.json.errors.map((/** @type {any} */ e) => e.path)).toEqual(
			expect.arrayContaining(['/region/timeZone', '/region/countriesServed/0']),
		);
		// the shape is checked first
		const shape = await m.client.put(url(w1, '/region'), { version: 1, value: region({ country: 'USA' }) });
		expect(shape.json.errors.map((/** @type {any} */ e) => e.path)).toEqual(['/region/country']);
		expect(codeOf(await m.client.put(url(w1, '/billing'), { version: 1, value: {} }))).toEqual([404, 'not_found']);
		// a body that is not { version, value }
		expect((await m.client.put(url(w1, '/region'), region())).status).toBe(422);
		expect((await m.client.put(url(w1, '/region'), { version: 1, value: region(), extra: true })).status).toBe(422);
		// a value for another section's members is not accepted either
		expect((await m.client.put(url(w1, '/pages'), { version: 1, value: region() })).status).toBe(422);
		expect((await m.client.get(url(w1))).json.settings.version).toBe(1);
		expect(notes.notices).toEqual([]);
		expect(await h.activity('website.settings_saved')).toHaveLength(1);
	});

	it('tidies the form before it checks it: codes in capitals, the store currency and default language first, hosts in lower case', async () => {
		const { m, w1, url } = await setUp('ws_tidy');
		const saved = await m.client.put(url(w1, '/region'), {
			version: 0,
			value: region({ country: ' us', currency: 'usd', currencies: ['eur', 'USD'], language: 'en-us', languages: ['fr-fr'] }),
		});
		expect(saved.status).toBe(200);
		expect(saved.json.settings.region).toMatchObject({
			country: 'US',
			currency: 'USD',
			currencies: ['USD', 'EUR'],
			language: 'en-US',
			languages: ['en-US', 'fr-FR'],
		});
		const pages = await m.client.put(url(w1, '/pages'), {
			version: 1,
			value: { hosts: ['WWW.Shop.Example.com'], signIn: '', privacy: '', documents: [] },
		});
		expect(pages.json.settings.pages.hosts).toEqual(['www.shop.example.com']);
	});

	it('keeps each section apart: one save changes only its own section', async () => {
		const { m, w1, url } = await setUp('ws_sections');
		await m.client.put(url(w1, '/business'), { version: 0, value: business({ name: 'Acme' }) });
		const second = await m.client.put(url(w1, '/region'), { version: 1, value: region() });
		expect(second.json.settings).toMatchObject({ version: 2, business: { name: 'Acme' }, region: { currency: 'USD' } });
	});

	describe('who may read and change them', () => {
		it('the merchant (own website), Owner and Support may; Finance, another merchant and a signed-out visitor may not', async () => {
			const { h, owner, m, w1, url } = await setUp('ws_rights');
			const support = await h.admin('support');
			const finance = await h.admin('finance');
			const other = await h.merchant('other@shop.test', ['other.example.com']);

			// Owner and Support read and write any merchant's website; their names are kept in Activity
			const byOwner = await owner.put(url(w1, '/region'), { version: 0, value: region() });
			expect(byOwner.status).toBe(200);
			h.clock.advance(1000);
			expect((await support.client.put(url(w1, '/business'), { version: 1, value: business() })).status).toBe(200);
			expect((await support.client.get(url(w1))).status).toBe(200);
			const entries = await h.activity('website.settings_saved');
			expect(entries.map((e) => [e.actor.type, e.after.section])).toEqual([
				['admin', 'business'],
				['admin', 'region'],
			]);
			expect(entries[0]?.actor.name).toEqual(expect.any(String));

			// Finance never
			expect(codeOf(await finance.client.get(url(w1)))).toEqual([403, 'forbidden']);
			expect(
				codeOf(
					await finance.client.put(url(w1, '/pages'), {
						version: 2,
						value: { hosts: [], signIn: '', privacy: '', documents: [] },
					}),
				),
			).toEqual([403, 'forbidden']);
			expect(codeOf(await finance.client.get(url(w1, '/changes')))).toEqual([403, 'forbidden']);

			// another merchant: not its website, by its own id or by the owner's
			expect(codeOf(await other.client.get(url(w1)))).toEqual([403, 'forbidden']);
			expect(codeOf(await other.client.put(url(w1, '/region'), { version: 2, value: region() }))).toEqual([403, 'forbidden']);
			const ownIdWrongSite = `/v1/merchants/${other.merchantId}/websites/${w1}/settings`;
			expect(codeOf(await other.client.get(ownIdWrongSite))).toEqual([404, 'not_found']);
			expect(codeOf(await other.client.put(`${ownIdWrongSite}/region`, { version: 2, value: region() }))).toEqual([
				404,
				'not_found',
			]);

			// signed out
			expect((await h.api.call('GET', url(w1))).status).toBe(401);
			expect((await h.api.call('PUT', url(w1, '/region'), { body: { version: 2, value: region() } })).status).toBe(401);
			// the document did not change by any of the refusals
			expect((await m.client.get(url(w1))).json.settings.version).toBe(2);
		});

		it('a product (its client assertion) can read the document of its websites but changes nothing through any route', async () => {
			const { h, notes, m, w1, url } = await setUp('ws_product_cannot_write');
			const bearer = await notes.assertion();
			const put = await h.api.call('PUT', url(w1, '/region'), { bearer, body: { version: 0, value: region() } });
			expect(put.status).toBe(401);
			expect((await h.api.call('GET', url(w1), { bearer })).status).toBe(401);
			// no product route writes it either
			// the product route answers GET only (405 for anything else, whatever the credentials)
			expect(
				(await h.api.call('PUT', `/v1/product/websites/${w1}/settings`, { bearer, body: { version: 0, value: region() } }))
					.status,
			).toBe(405);
			expect((await h.api.call('POST', `/v1/product/websites/${w1}/settings`, { bearer, body: {} })).status).toBe(405);
			expect(
				(
					await h.api.call('PUT', `/v1/product/websites/${w1}/settings/region`, {
						bearer,
						body: { version: 0, value: region() },
					})
				).status,
			).toBe(404);
			expect((await m.client.get(url(w1))).json.settings.version).toBe(0);
		});

		it('refuses a website that was removed', async () => {
			const { h, owner, m, w2, url } = await setUp('ws_removed');
			await owner.del(`/v1/merchants/${m.merchantId}/websites/${w2}/products/notes`);
			h.clock.advance(1000);
			const gone = await owner.del(`/v1/merchants/${m.merchantId}/websites/${w2}`, { confirm: 'blog.example.com' });
			expect(gone.status).toBeLessThan(300);
			expect(codeOf(await m.client.get(url(w2)))).toEqual([404, 'not_found']);
			expect(codeOf(await m.client.put(url(w2, '/region'), { version: 0, value: region() }))).toEqual([404, 'not_found']);
		});
	});

	describe('what products get (GET /v1/product/websites/:websiteId/settings)', () => {
		it('the status answer carries settingsVersion and the product pulls the document only when it is behind', async () => {
			const { h, notes, m, w1, url } = await setUp('ws_pull');
			const status = async () => (await h.productCall(notes, 'GET', `/v1/product/websites/${w1}/status`)).json;
			expect((await status()).settingsVersion).toBe(0);
			const none = await h.productCall(notes, 'GET', `/v1/product/websites/${w1}/settings`);
			expect(none.json).toEqual({ version: 0, settings: null });
			await m.client.put(url(w1, '/region'), { version: 0, value: region() });
			h.clock.advance(1000);
			expect((await status()).settingsVersion).toBe(1);
			const pull = await h.productCall(notes, 'GET', `/v1/product/websites/${w1}/settings?since=0`);
			expect(pull.status).toBe(200);
			expect(pull.json.version).toBe(1);
			expect(validateWebsiteSettings(pull.json.settings).ok).toBe(true);
			expect(pull.json.settings.region.timeZone).toBe('America/New_York');
			expect(pull.headers.get('cache-control')).toContain('no-store');
			// holding the version: nothing to send
			const same = await h.productCall(notes, 'GET', `/v1/product/websites/${w1}/settings?since=1`);
			expect(same.json).toEqual({ version: 1, settings: null });
			expect((await h.productCall(notes, 'GET', `/v1/product/websites/${w1}/settings?since=x`)).status).toBe(400);
		});

		it('only for a website that has the product: another product, a removed product, an unknown website', async () => {
			const { h, owner, chat, notes, m, w1, w2, url } = await setUp('ws_pull_scope');
			await m.client.put(url(w1, '/region'), { version: 0, value: region() });
			// Chat is on w1 but not on w2
			expect((await h.productCall(chat, 'GET', `/v1/product/websites/${w1}/settings`)).status).toBe(200);
			expect(codeOf(await h.productCall(chat, 'GET', `/v1/product/websites/${w2}/settings`))).toEqual([
				404,
				'website_not_found',
			]);
			expect(codeOf(await h.productCall(notes, 'GET', '/v1/product/websites/web_0000000000000000000000000/settings'))).toEqual(
				[404, 'website_not_found'],
			);
			// removed from the website: no longer served
			await owner.del(`/v1/merchants/${m.merchantId}/websites/${w1}/products/chat`);
			h.clock.advance(1000);
			expect(codeOf(await h.productCall(chat, 'GET', `/v1/product/websites/${w1}/settings`))).toEqual([
				404,
				'website_not_found',
			]);
			// a browser session is not a product
			expect((await m.client.get(`/v1/product/websites/${w1}/settings`)).status).toBe(401);
		});
	});

	it('Recent changes: who, when, which section and which fields; values only for the fields themselves, never a secret', async () => {
		const { h, owner, m, w1, url } = await setUp('ws_changes');
		await m.client.put(url(w1, '/region'), { version: 0, value: region() });
		h.clock.advance(1000);
		await owner.put(url(w1, '/business'), { version: 1, value: business({ name: 'Acme' }) });
		const merchantView = await m.client.get(url(w1, '/changes'));
		expect(merchantView.status).toBe(200);
		expect(merchantView.json.items).toHaveLength(2);
		const [latest, first] = merchantView.json.items;
		expect(first).toMatchObject({ section: 'region', version: 1, who: { type: 'merchant', name: 'Shop m@shop.test' } });
		// the merchant sees an admin under the Branding name, as Activity does
		expect(latest).toMatchObject({ section: 'business', version: 2, who: { type: 'admin' } });
		expect(latest.who.name).not.toBe('Olivia Owner');
		expect(latest.changed).toEqual(expect.arrayContaining(['name', 'email']));
		const adminView = await owner.get(url(w1, '/changes'));
		expect(adminView.json.items[0].who.name).toBe('Olivia Owner');
		expect(JSON.stringify(merchantView.json)).not.toMatch(/Acme/);
	});

	it('repeating a save with the same version is refused (409), so a retry can never overwrite a newer change', async () => {
		const { m, w1, url } = await setUp('ws_repeat');
		const body = { version: 0, value: region() };
		expect((await m.client.put(url(w1, '/region'), body)).status).toBe(200);
		expect((await m.client.put(url(w1, '/region'), body)).status).toBe(409);
	});
});
