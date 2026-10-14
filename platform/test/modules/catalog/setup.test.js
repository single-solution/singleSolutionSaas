import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { validateBlueprint } from '@ss/contracts';
import { manifest as notesManifest } from '@ss/contracts/testing';
import { closeMongoClients } from '../../../src/testing.js';
import { SHARE_LINKS_MAX, SHEET_CACHE_MS } from '../../../src/modules/catalog/setup.js';
import { parseShareLink, sharedCopy } from '../../../src/modules/catalog/core/setup.js';
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
			installed: false,
			lastSeenAt: null,
			browserToken,
			snippet: `<script src="https://notes.example.dev/widget.js" data-token="${browserToken}" async></script>`,
		});
		expect(sheet.products[1].serverToken).toEqual({ issued: true });
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
