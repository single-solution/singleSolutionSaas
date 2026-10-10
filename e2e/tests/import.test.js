/**
 * PLAN 0.8.10 Migration (Phase 1): an import dry run on a fixture. `ss-import read` reads a store-like database (the
 * importer's fixture) read only into NDJSON files; `ss-import send --dry-run` posts them to the test product Notes'
 * import routes (the kit's K10 helper, feature `import`) with the Portal-issued server token: everything is checked and
 * nothing is written. The real run then upserts the records with their given ids (re-runnable), `finish` runs, and
 * `verify` matches the source with `GET /v1/import/status` and the count route (K4).
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { read, send, verify } from '@ss/importer';
import { EXPECTED, FIXTURE_MAPPING, seed } from '@ss/importer/fixture';
import { PRODUCT_URL, codeOf, startSystem } from './helpers.js';

/** @type {import('./helpers.js').System} */
let sys;
let websiteId = '';
/** @type {{ browser: string, server: string }} */
let tokens;
/** @type {MongoClient} */
let client;
/** @type {import('mongodb').Db} */
let store;
let dir = '';
/** @type {import('mongodb').Db} */
let merchantDb;
let cookie = '';

/**
 * The importer's fetch, routed to the product in process (the same requests a real `ss-import` sends over https).
 * @type {typeof globalThis.fetch}
 */
const fetch = async (input, init) => {
	const request = new Request(input, init);
	const url = new URL(request.url);
	const answer = await sys.call(request.method, `${url.pathname}${url.search}`, {
		base: url.origin,
		headers: Object.fromEntries(request.headers.entries()),
		...(request.method === 'GET' ? {} : { body: await request.text() }),
	});
	return new Response(answer.json === null ? null : JSON.stringify(answer.json), { status: answer.status });
};

beforeAll(async () => {
	sys = await startSystem();
	await sys.connect();
	const m = await sys.merchant('import@shop.test', ['import.example.com']);
	websiteId = m.websiteIds[0] ?? '';
	await sys.addProduct(m.merchantId, websiteId);
	cookie = await sys.adminSession(await sys.owner(), websiteId);
	merchantDb = await sys.connectDatabase(cookie, websiteId);
	tokens = await sys.tokens(m.merchantId, websiteId);
	// the store's database: a copy, read only
	client = await new MongoClient(/** @type {string} */ (process.env.TEST_MONGODB_URI)).connect();
	store = client.db(`e2e_store_${randomBytes(4).toString('hex')}`);
	await seed(store);
	dir = await mkdtemp(path.join(tmpdir(), 'ss-import-e2e-'));
});
afterAll(async () => {
	await store?.dropDatabase();
	await client?.close();
	if (dir) await rm(dir, { recursive: true, force: true });
	await sys?.stop();
});

describe('importing a store into a product (K10, ss-import)', () => {
	it('is refused while the import feature is off', async () => {
		await sys.switchFeatures(cookie, websiteId, ['notes']);
		const refused = await sys.call('POST', '/v1/import/notes?dryRun=1', {
			token: tokens.server,
			body: '{}\n',
			headers: { 'content-type': 'application/x-ndjson' },
		});
		expect([refused.status, codeOf(refused)]).toEqual([403, 'feature_off']);
	});

	it('dry-runs the fixture: every record checked, nothing written', async () => {
		await sys.switchFeatures(cookie, websiteId, ['notes', 'import']);
		const manifest = await read({ mapping: FIXTURE_MAPPING, db: store, dir });
		expect(manifest.steps[0]).toMatchObject({ product: 'notes', collection: 'notes', ...EXPECTED });
		const products = { notes: { url: PRODUCT_URL, token: tokens.server } };
		const dry = await send({ dir, products, dryRun: true, fetch });
		expect(dry).toMatchObject({ dryRun: true, ok: true, finished: [] });
		expect(dry.steps[0]).toMatchObject({ inserted: EXPECTED.records, updated: 0, failed: [] });
		expect(await merchantDb.collection('ss_notes_notes').countDocuments({})).toBe(0);
		expect(await merchantDb.collection('ss_notes_activity').countDocuments({})).toBe(0);
		const before = await verify({ dir, products, fetch });
		expect(before).toMatchObject({ ok: false, steps: [{ expected: 3, imported: 0, counted: 0, match: false }] });
	});

	it('imports for real with the given ids, finishes, re-runs safely and verifies', async () => {
		const products = { notes: { url: PRODUCT_URL, token: tokens.server } };
		const real = await send({ dir, products, fetch });
		expect(real.steps[0]).toMatchObject({ inserted: 3, updated: 0, failed: [] });
		expect(real.finished).toEqual([{ product: 'notes', summary: { finished: true } }]);
		expect((await send({ dir, products, fetch })).steps[0]).toMatchObject({ inserted: 0, updated: 3 });
		const list = await sys.call('GET', '/v1/notes?limit=10', { token: tokens.server });
		expect(list.json.items.map((/** @type {{ id: string }} */ note) => note.id)).toEqual([
			'note_64b0c0ffee00000000000006',
			'note_64b0c0ffee00000000000002',
			'note_64b0c0ffee00000000000001',
		]);
		expect(list.json.items[2]).toMatchObject({ email: 'ayesha@example.com', createdAt: '2024-01-05T10:00:00.000Z' });
		expect(await verify({ dir, products, fetch })).toEqual({
			ok: true,
			steps: [{ product: 'notes', collection: 'notes', expected: 3, imported: 3, counted: 3, match: true }],
		});
		// each call wrote one activity entry, never copied to Accounts; the dry run wrote none
		const activity = await sys.call('GET', '/v1/activity?action=import.notes', { token: tokens.server });
		expect(activity.json.items.map((/** @type {{ detail: string }} */ entry) => entry.detail)).toEqual([
			'0 inserted, 3 updated, 0 failed',
			'3 inserted, 0 updated, 0 failed',
		]);
		expect(await merchantDb.collection('ss_notes_activity').countDocuments({ copy: { $ne: 'none' } })).toBe(0);
	});

	it('reports a record the product refuses, by line', async () => {
		const answer = await sys.call('POST', '/v1/import/notes?dryRun=1', {
			token: tokens.server,
			body: `${JSON.stringify({ id: 'note_64b0c0ffee00000000000007', text: '', createdAt: '2024-01-01T00:00:00Z' })}\n`,
			headers: { 'content-type': 'application/x-ndjson' },
		});
		expect(answer.json).toEqual({
			inserted: 0,
			updated: 0,
			dryRun: true,
			failed: [
				{ line: 1, id: 'note_64b0c0ffee00000000000007', errors: [{ path: '/text', message: 'text is not valid (empty)' }] },
			],
		});
	});
});
