import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { validateBlueprint } from '@ss/contracts';
import { manifest as notesManifest, productBlueprint } from '@ss/contracts/testing';
import { closeMongoClients } from '../../../src/testing.js';
import { SHARE_LINKS_MAX, SHEET_CACHE_MS } from '../../../src/modules/catalog/setup.js';
import { parseShareLink, parseSwitchOn, productEntry, sharedCopy } from '../../../src/modules/catalog/core/setup.js';
import { adviceOf, parseProfile } from '../../../src/modules/catalog/core/advisor.js';
import { startMongo } from '../../helpers.js';
import { PASSWORD, bootPortal, codeOf } from './boot.js';

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

/** A second product, `chat`, with one feature and no widgets. */
const chatManifest = () => ({
	...notesManifest(),
	id: 'chat',
	name: 'Chat',
	widgetScriptUrl: null,
	features: [
		{
			key: 'chat',
			name: 'Chat',
			description: 'Talk to visitors.',
			dependsOn: [],
			settings: { type: 'object', properties: {} },
		},
	],
	permissions: [],
	widgets: [],
});

/**
 * A merchant with one website that has notes and chat (connected and active), and a second website without products.
 * @param {string} name
 */
const setUp = async (name) => {
	const h = await bootPortal({ db: mongo.db(name) });
	cleanups.push(h.close);
	const owner = await h.owner();
	const notes = await h.connect(notesManifest());
	const chat = await h.connect(chatManifest());
	const m = await h.merchant('m@shop.test', ['shop.example.com', 'blog.example.com']);
	const [w1, w2] = m.websiteIds.map(String);
	for (const productId of ['notes', 'chat'])
		expect((await owner.post(`/v1/merchants/${m.merchantId}/websites/${w1}/products`, { productId })).status).toBe(201);
	const base = `/v1/merchants/${m.merchantId}/websites/${w1}`;
	return { h, owner, notes, chat, m, w1: String(w1), w2: String(w2), base };
};

describe('Setup sheet', () => {
	it('gathers every product of the website for the merchant and the admin, with the website facts and never a server token', async () => {
		const { h, owner, notes, chat, m, w1, base } = await setUp('setup_sheet');
		chat.tamper.blueprint = 'status_500';
		const res = await m.client.get(`${base}/setup`);
		expect(res.status).toBe(200);
		const sheet = res.json;
		expect(validateBlueprint(sheet).ok).toBe(true);
		expect(sheet).toMatchObject({
			schema: 'ss.blueprint/1',
			generatedAt: '2026-10-01T10:00:00.000Z',
			website: {
				id: w1,
				domain: 'shop.example.com',
				status: 'active',
				business: { found: true, name: 'Example Shop', country: 'US', timeZone: 'America/New_York' },
			},
			access: {
				allowedOrigins: ['https://shop.example.com'],
				testingOrigins: ['localhost', '*.localhost', '127.0.0.1', '[::1]'],
			},
		});
		expect(sheet.products.map((/** @type {any} */ p) => [p.productId, p.reachable])).toEqual([
			['chat', false],
			['notes', true],
		]);
		expect(sheet.products[0]).toEqual({ productId: 'chat', name: 'Chat', reachable: false, reason: 'unreachable' });
		const tokens = await owner.get(`${base}/tokens`);
		const browserToken = tokens.json.items.find((/** @type {any} */ i) => i.productId === 'notes').browserToken;
		expect(sheet.products[1].install).toEqual({
			scriptUrl: 'https://notes.example.dev/widget.js',
			scriptLoading: 'async',
			installed: false,
			lastSeenAt: null,
			browserToken,
			snippet: `<script src="https://notes.example.dev/widget.js" data-token="${browserToken}" async></script>`,
		});
		expect(sheet.products[1].serverToken).toEqual({ issued: true });
		// the address the product was connected with, which its API paths go after
		expect(sheet.products[1].apiBase).toBe(notes.url);
		const server = (await owner.post(`${base}/tokens/notes/reveal`, {})).json.serverToken;
		expect(JSON.stringify(sheet)).not.toContain(server);
		expect(notes.blueprintCalls).toEqual([w1]);
		// the admin sees the same sheet (kept a minute)
		const admin = await owner.get(`${base}/setup`);
		expect(admin.json).toEqual(sheet);
		expect(notes.blueprintCalls).toEqual([w1]);
		const opened = await h.activity('website.setup_opened');
		expect(opened.map((entry) => entry.actor.type).sort()).toEqual(['admin', 'merchant']);
		expect(opened[0]?.target).toMatchObject({ type: 'website', id: w1, websiteId: w1 });
		// the status the website's products have: a suspended merchant's are suspended
		expect((await owner.post(`/v1/admin/merchants/${m.merchantId}/suspend`, { reason: 'Checks' })).status).toBe(200);
		expect((await owner.get(`${base}/setup?fresh=1`)).json.website.status).toBe('suspended');
	});

	it('keeps a sheet a minute, gathers it again on Refresh or after, and offers it as a JSON file', async () => {
		const { h, notes, m, w1, base } = await setUp('setup_cache');
		await m.client.get(`${base}/setup`);
		await m.client.get(`${base}/setup`);
		expect(notes.blueprintCalls).toHaveLength(1);
		await m.client.get(`${base}/setup?fresh=1`);
		expect(notes.blueprintCalls).toHaveLength(2);
		h.clock.advance(SHEET_CACHE_MS + 1);
		const file = await m.client.get(`${base}/setup?download=1`);
		expect(notes.blueprintCalls).toEqual([w1, w1, w1]);
		expect(file.headers.get('content-disposition')).toBe('attachment; filename="setup-shop.example.com.json"');
		expect(file.json.schema).toBe('ss.blueprint/1');
		expect(await h.activity('website.setup_downloaded')).toHaveLength(1);
	});

	it('shows a product that times out, refuses or answers no blueprint as not reachable, and the sheet still renders', async () => {
		const { notes, chat, m, base } = await setUp('setup_unreachable');
		const reasons = async () =>
			(await m.client.get(`${base}/setup?fresh=1`)).json.products.map((/** @type {any} */ p) => p.reason ?? 'ok');
		notes.tamper.blueprint = 'invalid';
		chat.tamper.blueprint = 'refuse';
		expect(await reasons()).toEqual(['refused', 'invalid']);
		notes.tamper.blueprint = 'other_id';
		chat.tamper.blueprint = 'hang';
		expect(await reasons()).toEqual(['timeout', 'invalid']);
		delete chat.tamper.blueprint;
		await notes.close();
		expect(await reasons()).toEqual(['ok', 'unreachable']);
	});

	it('is for the merchant of the website, Owner and Support only', async () => {
		const { h, m, w2, base } = await setUp('setup_rights');
		const finance = await h.admin('finance');
		expect(codeOf(await finance.client.get(`${base}/setup`))).toEqual([403, 'forbidden']);
		const other = await h.merchant('other@shop.test', ['other.example.com']);
		expect(codeOf(await other.client.get(`${base}/setup`))).toEqual([403, 'forbidden']);
		expect(codeOf(await other.client.get(`/v1/merchants/${other.merchantId}/websites/${w2}/setup`))).toEqual([
			404,
			'not_found',
		]);
		const support = await h.admin('support');
		expect((await support.client.get(`${base}/setup`)).status).toBe(200);
		// a website without products has an empty sheet
		const empty = await m.client.get(`/v1/merchants/${m.merchantId}/websites/${w2}/setup`);
		expect(empty.json.products).toEqual([]);
		expect(empty.json.website.business.found).toBe(false);
	});
});

describe('business profile and advisor', () => {
	it('keeps a tidy business profile per website and adds the advice for it to every sheet, shared copies too', async () => {
		const { h, owner, notes, m, base } = await setUp('setup_profile');
		expect((await m.client.get(`${base}/setup`)).json.website.profile).toBeNull();
		const saved = await m.client.put(`${base}/setup/profile`, {
			chat: ['people'],
			sells: ['digital', 'physical'],
			delivers: [],
			countries: ['US', 'CA'],
		});
		expect(saved.status).toBe(200);
		expect(validateBlueprint(saved.json).ok).toBe(true);
		// unanswered questions are left out; options in the order people see them
		expect(saved.json.website.profile).toEqual({ sells: ['physical', 'digital'], chat: ['people'], countries: ['US', 'CA'] });
		const part = saved.json.products.find((/** @type {any} */ p) => p.productId === 'notes');
		expect(part.recommended).toEqual([
			{ feature: 'notes', on: true, because: ['chat.people'], why: 'Your staff answer visitors in chat.' },
		]);
		expect(part.notRecommended).toEqual([]);
		// the products were not asked again for it
		expect(notes.blueprintCalls).toHaveLength(1);
		const [entry] = await h.activity('website.setup_profile_saved');
		expect(entry?.actor.type).toBe('merchant');
		expect(entry?.after).toEqual({ profile: saved.json.website.profile });

		// the admin changes it: notes is on although the profile now rules it out
		const ruled = await owner.put(`${base}/setup/profile`, { chat: ['none'], messages: ['sms'], signIn: ['email'] });
		expect(ruled.json.products.find((/** @type {any} */ p) => p.productId === 'notes')).toMatchObject({
			recommended: [],
			notRecommended: [
				{
					feature: 'notes',
					missing: ['chat.people', 'messages.email'],
					why: 'Not in the business profile: your staff answer visitors in chat or you message customers by email.',
				},
			],
		});
		// a share link copies the profile and the advice
		const link = await m.client.post(`${base}/setup/links`, { values: false });
		const key = String(link.json.url).split('#key=')[1];
		const copy = (await h.api.call('POST', '/v1/setup/shared', { body: { key } })).json;
		expect(copy.website.profile).toEqual({ signIn: ['email'], chat: ['none'], messages: ['sms'] });
		expect(copy.products[1].notRecommended).toHaveLength(1);
		// clearing every answer removes it
		expect((await m.client.put(`${base}/setup/profile`, {})).json.website.profile).toBeNull();
		expect(await h.db.collection('catalog_setup_profiles').countDocuments()).toBe(0);
	});

	it('refuses answers it does not know, none with other answers, and other merchants', async () => {
		const { h, m, base } = await setUp('setup_profile_rules');
		for (const [body, path] of /** @type {Array<[unknown, string]>} */ ([
			[{ pays: ['gold'] }, '/pays/0'],
			[{ sells: ['physical', 'none'] }, '/sells'],
			[{ countries: ['us'] }, '/countries/0'],
			[{ moving: 'yes' }, '/moving'],
			[{ budget: 'high' }, '/budget'],
		])) {
			const res = await m.client.put(`${base}/setup/profile`, body);
			expect(codeOf(res)).toEqual([422, 'validation_failed']);
			expect(res.json.errors[0].path).toBe(path);
		}
		const other = await h.merchant('other@shop.test', []);
		expect(codeOf(await other.client.put(`${base}/setup/profile`, { chat: ['ai'] }))).toEqual([403, 'forbidden']);
		const finance = await h.admin('finance');
		expect(codeOf(await finance.client.put(`${base}/setup/profile`, { chat: ['ai'] }))).toEqual([403, 'forbidden']);
	});

	it('switches a feature on for Owner and Support through the product, then gathers the sheet again', async () => {
		const { h, owner, notes, m, w1, base } = await setUp('setup_switch');
		const done = await owner.post(`${base}/setup/features`, { productId: 'notes', feature: 'inbox' });
		expect(done.status).toBe(200);
		expect(done.json.added).toEqual(['inbox']);
		expect(validateBlueprint(done.json.sheet).ok).toBe(true);
		expect(notes.switchCalls).toEqual([
			{
				websiteId: w1,
				body: { features: ['inbox'], admin: { id: expect.any(String), name: expect.any(String), role: 'owner' } },
			},
		]);
		expect(notes.blueprintCalls).toEqual([w1]);
		const support = await h.admin('support');
		expect((await support.client.post(`${base}/setup/features`, { productId: 'notes', feature: 'notes' })).status).toBe(200);
		expect(notes.switchCalls[1]?.body.admin.role).toBe('support');

		// the merchant and Finance cannot; a product not on the website, a malformed body
		expect((await m.client.post(`${base}/setup/features`, { productId: 'notes', feature: 'inbox' })).status).toBe(401);
		const finance = await h.admin('finance');
		expect(codeOf(await finance.client.post(`${base}/setup/features`, { productId: 'notes', feature: 'inbox' }))).toEqual([
			403,
			'forbidden',
		]);
		expect(codeOf(await owner.post(`${base}/setup/features`, { productId: 'payments', feature: 'stripe' }))).toEqual([
			404,
			'not_found',
		]);
		const bad = await owner.post(`${base}/setup/features`, { productId: 'Notes', feature: 'in box', extra: 1 });
		expect(codeOf(bad)).toEqual([422, 'validation_failed']);
		expect(bad.json.errors.map((/** @type {any} */ e) => e.path)).toEqual(['/extra', '/productId', '/feature']);
		expect(parseSwitchOn('x')).toEqual({ ok: false, errors: [{ path: '', message: 'body must be a JSON object' }] });

		// the product refuses (its words), fails or cannot be reached: nothing changes
		notes.tamper.switchOn = 'refuse';
		const refused = await owner.post(`${base}/setup/features`, { productId: 'notes', feature: 'inbox' });
		expect(codeOf(refused)).toEqual([422, 'catalog_switch_refused']);
		expect(refused.json.detail).toBe('The Portal refused the change (forbidden). Nothing was changed.');
		notes.tamper.switchOn = 'status_500';
		expect(codeOf(await owner.post(`${base}/setup/features`, { productId: 'notes', feature: 'inbox' }))).toEqual([
			502,
			'upstream_error',
		]);
		await notes.close();
		const down = await owner.post(`${base}/setup/features`, { productId: 'notes', feature: 'inbox' });
		expect(codeOf(down)).toEqual([502, 'upstream_error']);
		expect(down.json.detail).toBe('The product did not answer. Refresh to see whether the feature is on, then try again.');
	});

	it('writes the install snippet as the product loads its widget script: async by default, blocking without async', async () => {
		const entry = { productId: 'notes', name: 'Notes', browserToken: 'tok' };
		const blueprint = productBlueprint();
		const asyncPart = productEntry(/** @type {any} */ (entry), {
			ok: true,
			blueprint,
			apiBase: 'https://notes.example.dev',
		});
		expect(asyncPart.reachable && asyncPart.install.snippet).toBe(
			'<script src="https://notes.example.dev/widget.js" data-token="tok" async></script>',
		);
		const blocking = productEntry(/** @type {any} */ (entry), {
			ok: true,
			blueprint: { ...blueprint, install: { ...blueprint.install, scriptLoading: 'blocking' } },
			apiBase: 'https://notes.example.dev',
		});
		expect(blocking.reachable && blocking.install.snippet).toBe(
			'<script src="https://notes.example.dev/widget.js" data-token="tok"></script>',
		);

		// the Install and tokens page gets the manifest's loading with each product
		const h = await bootPortal({ db: mongo.db('setup_loading') });
		cleanups.push(h.close);
		const owner = await h.owner();
		await h.connect({ ...notesManifest(), widgetScriptLoading: 'blocking' });
		await h.connect(chatManifest());
		const m = await h.merchant('m@shop.test', ['shop.example.com']);
		const site = `/v1/merchants/${m.merchantId}/websites/${m.websiteIds[0]}`;
		for (const productId of ['notes', 'chat']) expect((await owner.post(`${site}/products`, { productId })).status).toBe(201);
		const items = (await owner.get(`${site}/tokens`)).json.items;
		expect(items.map((/** @type {any} */ i) => [i.productId, i.widgetScriptLoading])).toEqual(
			expect.arrayContaining([
				['notes', 'blocking'],
				['chat', 'async'],
			]),
		);
	});

	it('parses a profile and words the advice', () => {
		expect(parseProfile({ offers: [], moving: false })).toEqual({ ok: true, value: { moving: false } });
		// own answers where the options cannot list everything: trimmed, kept in the order given; the tax question
		expect(
			parseProfile({ pays: ['cod'], other: { pays: ['  Mobile   wallet ', 'Store credit'], offers: [] }, taxes: true }),
		).toEqual({ ok: true, value: { pays: ['cod'], other: { pays: ['Mobile wallet', 'Store credit'] }, taxes: true } });
		expect(parseProfile({ other: { pays: [' '] } })).toMatchObject({
			ok: false,
			errors: [{ path: '/other/pays', message: 'each own answer once, not empty' }],
		});
		expect(parseProfile({ delivers: ['none'], other: { delivers: ['Drone'] } })).toMatchObject({
			ok: false,
			errors: [{ path: '/delivers', message: 'none stands alone' }],
		});
		expect(parseProfile({})).toEqual({ ok: true, value: null });
		expect(parseProfile([])).toMatchObject({ ok: false });
		const features = [
			{ key: 'cod', on: false, recommendFor: ['pays.cod+countries.many', 'languages.many'] },
			{ key: 'gateway', on: true, recommendFor: ['pays.online+countries.za'] },
			{ key: 'import', on: true, recommendFor: ['moving.yes'] },
		];
		expect(adviceOf(features, null)).toEqual({ recommended: [], notRecommended: [] });
		expect(adviceOf(features, { pays: ['cod'], countries: ['US', 'GB'], languages: ['en'], moving: false })).toEqual({
			recommended: [
				{
					feature: 'cod',
					on: false,
					because: ['pays.cod', 'countries.many'],
					why: 'Shoppers pay cash on delivery and you sell in more than one country.',
				},
			],
			notRecommended: [
				{ feature: 'gateway', missing: ['pays.online'], why: 'Not in the business profile: shoppers pay online.' },
				{
					feature: 'import',
					missing: ['moving.yes'],
					why: 'Not in the business profile: you are moving from another website or system.',
				},
			],
		});
		expect(
			adviceOf([{ key: 'gateway', on: false, recommendFor: ['pays.online+countries.za+languages.af'] }], {
				pays: ['online'],
				countries: ['ZA'],
				languages: ['af'],
			}).recommended[0]?.why,
		).toBe('Shoppers pay online and your countries include ZA and your languages include af.');
		// a region, an own answer and the tax question in words
		expect(
			adviceOf([{ key: 'banner', on: false, recommendFor: ['marketing.google+countries.eea', 'pays.other+taxes.yes'] }], {
				marketing: ['google'],
				countries: ['DE'],
			}).recommended[0]?.why,
		).toBe(
			'You advertise on Google and you sell in the European Economic Area, the UK or Switzerland, where tracking needs consent.',
		);
		expect(
			adviceOf([{ key: 'banner', on: false, recommendFor: ['pays.other+taxes.yes'] }], {
				other: { pays: ['Mobile wallet'] },
				taxes: true,
			}).recommended[0]?.why,
		).toBe('You gave your own answer to “How do shoppers pay?” and you charge tax at checkout.');
	});
});

describe('share links', () => {
	it('shares a read-only copy by a key kept only as its hash, with or without values and install details, until revoked', async () => {
		const { h, owner, m, w1, base } = await setUp('setup_share');
		const made = await m.client.post(`${base}/setup/links`, {});
		expect(made.status).toBe(201);
		expect(made.json.link).toMatchObject({
			createdBy: 'merchant',
			expiresAt: '2026-10-08T10:00:00.000Z',
			status: 'active',
			values: true,
			install: true,
			openedAt: null,
			opens: 0,
		});
		const key = String(made.json.url).split('#key=')[1] ?? '';
		expect(made.json.url).toBe(`https://portal.test/shared-setup#key=${key}`);
		expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const stored = await h.db.collection('catalog_setup_links').findOne({ _id: made.json.link.linkId });
		expect(JSON.stringify(stored)).not.toContain(key);

		const opened = await h.api.call('POST', '/v1/setup/shared', { body: { key } });
		expect(opened.status).toBe(200);
		expect(opened.headers.get('x-robots-tag')).toBe('noindex, nofollow');
		expect(opened.headers.get('cache-control')).toBe('no-store');
		expect(validateBlueprint(opened.json).ok).toBe(true);
		expect(opened.json.share).toEqual({ expiresAt: '2026-10-08T10:00:00.000Z', values: true, install: true });
		expect(opened.json.products[1].features[0].settings[0]).toHaveProperty('value', 10);
		expect(opened.json.products[1].install).toHaveProperty('browserToken');

		// a link without values or install details
		const bare = await owner.post(`${base}/setup/links`, { days: 1, values: false, install: false });
		expect(bare.json.link).toMatchObject({
			createdBy: 'admin',
			expiresAt: '2026-10-02T10:00:00.000Z',
			values: false,
			install: false,
		});
		const bareKey = String(bare.json.url).split('#key=')[1];
		const copy = (await h.api.call('POST', '/v1/setup/shared', { body: { key: bareKey } })).json;
		expect(validateBlueprint(copy).ok).toBe(true);
		expect(copy.products[1].features[0].settings[0]).toEqual({
			key: 'maxNotes',
			title: 'Notes per visitor per day',
			default: false,
		});
		expect(copy.products[1].install).toEqual({
			scriptUrl: 'https://notes.example.dev/widget.js',
			scriptLoading: 'async',
			installed: false,
			lastSeenAt: null,
		});

		// listed (newest first); each opened once so far
		const list = await m.client.get(`${base}/setup/links`);
		expect(list.json.items.map((/** @type {any} */ l) => [l.linkId, l.opens]).sort()).toEqual(
			[
				[bare.json.link.linkId, 1],
				[made.json.link.linkId, 1],
			].sort(),
		);

		// revoked: refused at once, and the same answer as a key that never existed or a malformed one
		const revoked = await m.client.del(`${base}/setup/links/${made.json.link.linkId}`);
		expect(revoked.json.link).toMatchObject({ status: 'revoked', revokedAt: '2026-10-01T10:00:00.000Z' });
		expect((await m.client.del(`${base}/setup/links/${made.json.link.linkId}`)).status).toBe(200);
		for (const body of [{ key }, { key: 'A'.repeat(43) }, { key: 'short' }, {}])
			expect(codeOf(await h.api.call('POST', '/v1/setup/shared', { body }))).toEqual([404, 'not_found']);
		expect(codeOf(await m.client.del(`${base}/setup/links/shl_unknown0123456789`))).toEqual([404, 'not_found']);

		// Activity: shared twice, revoked once, each link opened once (written at most once an hour per link)
		expect(await h.activity('website.setup_shared')).toHaveLength(2);
		expect(await h.activity('website.setup_share_revoked')).toHaveLength(1);
		await h.api.call('POST', '/v1/setup/shared', { body: { key: bareKey } });
		expect(await h.activity('website.setup_share_opened')).toHaveLength(2);
		h.clock.advance(61 * 60_000);
		await h.api.call('POST', '/v1/setup/shared', { body: { key: bareKey } });
		const openings = await h.activity('website.setup_share_opened');
		expect(openings).toHaveLength(3);
		expect(openings[0]?.actor).toEqual({ type: 'system', id: 'setup_share' });
		expect(openings[0]?.target.websiteId).toBe(w1);

		// expired after its days
		h.clock.advance(24 * 60 * 60_000);
		expect(codeOf(await h.api.call('POST', '/v1/setup/shared', { body: { key: bareKey } }))).toEqual([404, 'not_found']);
		// (signed in again: the session of a day ago has ended)
		const again = await h.api.signIn('m@shop.test', PASSWORD);
		// the expired link is gone from the list; the revoked one stays until it would have expired
		expect((await again.get(`${base}/setup/links`)).json.items.map((/** @type {any} */ l) => [l.linkId, l.status])).toEqual([
			[made.json.link.linkId, 'revoked'],
		]);
	});

	it('checks what a new link asks for, caps the links of a website and keeps them to their merchant', async () => {
		const { h, m, w1, base } = await setUp('setup_share_rules');
		for (const [body, path] of /** @type {Array<[unknown, string]>} */ ([
			[{ days: 0 }, '/days'],
			[{ days: 31 }, '/days'],
			[{ days: 1.5 }, '/days'],
			[{ values: 'yes' }, '/values'],
			[{ other: 1 }, '/other'],
		])) {
			const res = await m.client.post(`${base}/setup/links`, body);
			expect(codeOf(res)).toEqual([422, 'validation_failed']);
			expect(res.json.errors[0].path).toBe(path);
		}
		expect(parseShareLink(null)).toEqual({ ok: false, errors: [{ path: '', message: 'body must be a JSON object' }] });
		const thirty = await m.client.post(`${base}/setup/links`, { days: 30 });
		expect(thirty.json.link.expiresAt).toBe('2026-10-31T10:00:00.000Z');
		const other = await h.merchant('other@shop.test', []);
		expect(codeOf(await other.client.get(`${base}/setup/links`))).toEqual([403, 'forbidden']);
		expect(codeOf(await other.client.del(`${base}/setup/links/${thirty.json.link.linkId}`))).toEqual([403, 'forbidden']);
		const links = h.db.collection('catalog_setup_links');
		await links.insertMany(
			/** @type {any[]} */ (
				Array.from({ length: SHARE_LINKS_MAX - 1 }, (_, i) => ({
					_id: `shl_filler${String(i).padStart(10, '0')}`,
					merchantId: m.merchantId,
					websiteId: w1,
					keyHash: `filler-${i}`,
					values: true,
					install: true,
					expiresAt: new Date('2026-10-05T00:00:00Z'),
					revokedAt: null,
					createdBy: 'merchant',
					openedAt: null,
					opens: 0,
					createdAt: new Date('2026-10-01T00:00:00Z'),
				}))
			),
		);
		expect(codeOf(await m.client.post(`${base}/setup/links`, {}))).toEqual([409, 'conflict']);
	});

	it('limits how often a shared sheet is asked for', async () => {
		const { h } = await setUp('setup_share_limit');
		const answers = [];
		for (let i = 0; i < 31; i += 1) answers.push((await h.api.call('POST', '/v1/setup/shared', { body: { key: 'x' } })).status);
		expect(answers.slice(0, 30).every((status) => status === 404)).toBe(true);
		expect(answers[30]).toBe(429);
	});

	it('leaves every reachable product alone in a copy with everything shown, and missing ones as they are', () => {
		const sheet = /** @type {any} */ ({
			schema: 'ss.blueprint/1',
			products: [{ productId: 'chat', name: 'Chat', reachable: false, reason: 'timeout' }],
		});
		expect(sharedCopy(sheet, { values: true, install: true, expiresAt: '2026-10-08T00:00:00Z' }).products).toEqual(
			sheet.products,
		);
	});
});
