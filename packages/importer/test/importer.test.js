import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ObjectId } from 'mongodb';
import { afterEach, describe, expect, it } from 'vitest';
import { IMPORT_LIMITS } from '@ss/contracts';
import {
	IDMAP_FILE,
	MANIFEST_FILE,
	MAPPINGS,
	USAGE,
	chunk,
	defineMapping,
	hexOf,
	legacyId,
	linesOf,
	main,
	read,
	send,
	toNdjson,
	verify,
} from '../src/index.js';
import { EXPECTED, FEEDBACK, FIXTURE_MAPPING, seed } from '../src/fixture/index.js';
import { fakeProduct, freshDb, removeDir, tempDir } from './helpers.js';

/** @type {Array<() => Promise<unknown>>} */
const cleanups = [];
afterEach(async () => {
	while (cleanups.length > 0) await /** @type {() => Promise<unknown>} */ (cleanups.pop())();
});

/** A seeded source database and an empty folder. */
const prepare = async () => {
	const source = await freshDb();
	await seed(source.db);
	const dir = await tempDir();
	cleanups.push(async () => {
		await source.db.dropDatabase();
		await source.client.close();
		await removeDir(dir);
	});
	return { source, dir };
};

describe('mappings', () => {
	const step = { product: 'notes', collection: 'notes', source: 'feedback', prefix: 'note', map: () => null };

	it('are checked', () => {
		expect(MAPPINGS.fixture).toBe(FIXTURE_MAPPING);
		expect(Object.isFrozen(FIXTURE_MAPPING.steps[0])).toBe(true);
		expect(() => defineMapping(/** @type {any} */ (null))).toThrow(/object/);
		expect(() => defineMapping({ name: 'Bad Name', description: '', steps: [step] })).toThrow(/names/);
		expect(() => defineMapping({ name: 'x1', description: '', steps: [] })).toThrow(/no steps/);
		for (const [field, value, message] of /** @type {Array<[string, unknown, RegExp]>} */ ([
			['product', 'Notes', /product/],
			['collection', 'Bad-Name', /collection/],
			['source', '1x', /source/],
			['prefix', 'n', /prefix/],
			['map', 'nope', /map/],
			['mergeKey', 'nope', /mergeKey/],
			['countPath', '/v1/notes', /countPath/],
		]))
			expect(() => defineMapping({ name: 'x1', description: '', steps: [{ ...step, [field]: value }] })).toThrow(message);
		expect(() => defineMapping({ name: 'x1', description: '', steps: [step, step] })).toThrow(/two steps/);
	});

	it('give deterministic ids from ObjectIds', () => {
		const objectId = new ObjectId('64b0c0ffee00000000000001');
		expect(hexOf(objectId)).toBe('64b0c0ffee00000000000001');
		expect(hexOf('64B0C0FFEE00000000000001')).toBe('64b0c0ffee00000000000001');
		expect(legacyId('ord', objectId)).toBe('ord_64b0c0ffee00000000000001');
		expect(() => hexOf(42)).toThrow(/ObjectId/);
		expect(() => hexOf('short')).toThrow(/ObjectId/);
		expect(() => legacyId('Ord', objectId)).toThrow(/not an id/);
	});
});

describe('NDJSON', () => {
	it('writes, reads and cuts files into calls that fit the import routes', () => {
		const lines = linesOf(toNdjson([{ a: 1 }, { b: 2 }, { c: 3 }]) + '\n\n');
		expect(lines).toEqual([
			{ line: 1, text: '{"a":1}' },
			{ line: 2, text: '{"b":2}' },
			{ line: 3, text: '{"c":3}' },
		]);
		expect(chunk(lines, { records: 2 }).map((call) => [call.firstLine, call.lines, call.body])).toEqual([
			[1, [1, 2], '{"a":1}\n{"b":2}\n'],
			[3, [3], '{"c":3}\n'],
		]);
		expect(chunk(lines, { bytes: 16 }).map((call) => call.lines)).toEqual([[1, 2], [3]]);
		expect(chunk([])).toEqual([]);
		expect(() => chunk(lines, { bytes: 5 })).toThrow(/larger than one import call/);
		expect(chunk(linesOf(toNdjson(Array.from({ length: IMPORT_LIMITS.records + 1 }, (_, i) => ({ i })))))).toHaveLength(2);
	});
});

describe('ss-import read', () => {
	it('reads the fixture store read only into NDJSON, the id map and the manifest', async () => {
		const { source, dir } = await prepare();
		const manifest = await read({
			mapping: FIXTURE_MAPPING,
			db: source.db,
			dir,
			now: () => Date.parse('2026-10-10T10:00:00Z'),
		});
		expect(manifest).toEqual({
			mapping: 'fixture',
			readAt: '2026-10-10T10:00:00.000Z',
			steps: [
				{
					product: 'notes',
					collection: 'notes',
					source: 'feedback',
					file: '01-notes.notes.ndjson',
					...EXPECTED,
					countPath: '/v1/notes/count',
				},
			],
		});
		const records = linesOf(await readFile(path.join(dir, '01-notes.notes.ndjson'), 'utf8')).map((line) =>
			JSON.parse(line.text),
		);
		expect(records).toEqual([
			{
				id: 'note_64b0c0ffee00000000000001',
				text: 'Love the new pedestal fans',
				email: 'ayesha@example.com',
				createdAt: '2024-01-05T10:00:00.000Z',
			},
			{
				id: 'note_64b0c0ffee00000000000002',
				text: 'When is the 56 inch model back?',
				email: null,
				createdAt: '2024-02-01T09:30:00.000Z',
			},
			{
				id: 'note_64b0c0ffee00000000000006',
				text: 'Delivery was quick, thank you',
				email: 'bilal@example.com',
				createdAt: '2024-04-10T15:45:00.000Z',
			},
		]);
		expect(JSON.parse(await readFile(path.join(dir, IDMAP_FILE), 'utf8'))).toEqual({
			'feedback/64b0c0ffee00000000000001': 'note_64b0c0ffee00000000000001',
			'feedback/64b0c0ffee00000000000002': 'note_64b0c0ffee00000000000002',
			// the duplicate points at the note it joined
			'feedback/64b0c0ffee00000000000003': 'note_64b0c0ffee00000000000001',
			'feedback/64b0c0ffee00000000000006': 'note_64b0c0ffee00000000000006',
		});
		expect(JSON.parse(await readFile(path.join(dir, MANIFEST_FILE), 'utf8'))).toEqual(manifest);
		// nothing in the source changed
		expect(await source.db.collection('feedback').countDocuments({})).toBe(FEEDBACK.length);
	});

	it('lets later steps refer to earlier records, and refuses records without ids', async () => {
		const { source, dir } = await prepare();
		await source.db.collection('replies').insertMany([
			{ _id: new ObjectId('64b0c0ffee00000000000101'), feedback: new ObjectId('64b0c0ffee00000000000003'), text: 'Thanks!' },
			{ _id: new ObjectId('64b0c0ffee00000000000102'), feedback: new ObjectId('64b0c0ffee00000000000005'), text: 'Lost' },
			{ _id: new ObjectId('64b0c0ffee00000000000103'), feedback: 'not-an-id', text: 'Broken' },
		]);
		const mapping = defineMapping({
			name: 'with-replies',
			description: '',
			steps: [
				...FIXTURE_MAPPING.steps,
				{
					product: 'notes',
					collection: 'replies',
					source: 'replies',
					prefix: 'rep',
					map: (doc, ctx) => ({ id: ctx.id('rep', doc._id), noteId: ctx.ref('feedback', doc.feedback), text: doc.text }),
				},
			],
		});
		const manifest = await read({ mapping, db: source.db, dir });
		expect(manifest.steps[1]).toMatchObject({ file: '02-notes.replies.ndjson', records: 3 });
		const replies = linesOf(await readFile(path.join(dir, '02-notes.replies.ndjson'), 'utf8')).map((line) =>
			JSON.parse(line.text),
		);
		expect(replies.map((reply) => reply.noteId)).toEqual(['note_64b0c0ffee00000000000001', null, null]);

		const broken = defineMapping({
			name: 'broken',
			description: '',
			steps: [
				{ product: 'notes', collection: 'notes', source: 'feedback', prefix: 'note', map: (doc) => ({ text: doc.message }) },
			],
		});
		await expect(read({ mapping: broken, db: source.db, dir })).rejects.toThrow(/without an id/);
	});
});

describe('ss-import send and verify', () => {
	it('dry-runs the fixture, imports it, finishes, re-runs safely and verifies the counts', async () => {
		const { source, dir } = await prepare();
		await read({ mapping: FIXTURE_MAPPING, db: source.db, dir });
		const product = fakeProduct();
		const products = { notes: { url: 'https://notes.test/', token: product.token } };
		const dry = await send({ dir, products, dryRun: true, fetch: product.fetch });
		expect(dry).toEqual({
			dryRun: true,
			ok: true,
			steps: [
				{
					product: 'notes',
					collection: 'notes',
					file: '01-notes.notes.ndjson',
					calls: 1,
					inserted: 3,
					updated: 0,
					failed: [],
				},
			],
			finished: [],
		});
		expect(product.stored.size).toBe(0);
		expect(product.finished()).toBe(0);
		const before = await verify({ dir, products, fetch: product.fetch });
		expect(before).toEqual({
			ok: false,
			steps: [{ product: 'notes', collection: 'notes', expected: 3, imported: null, counted: 0, match: false }],
		});

		const real = await send({ dir, products, fetch: product.fetch });
		expect(real.steps[0]).toMatchObject({ inserted: 3, updated: 0 });
		expect(real.finished).toEqual([{ product: 'notes', summary: { finished: true, notes: 3 } }]);
		expect((await send({ dir, products, fetch: product.fetch })).steps[0]).toMatchObject({ inserted: 0, updated: 3 });
		expect(product.stored.get('notes')?.size).toBe(3);
		expect(await verify({ dir, products, fetch: product.fetch })).toEqual({
			ok: true,
			steps: [{ product: 'notes', collection: 'notes', expected: 3, imported: 3, counted: 3, match: true }],
		});
	});

	it('reports failed records by file line and stops on a refused call', async () => {
		const { source, dir } = await prepare();
		await read({ mapping: FIXTURE_MAPPING, db: source.db, dir });
		const file = path.join(dir, '01-notes.notes.ndjson');
		const lines = linesOf(await readFile(file, 'utf8'));
		await writeFile(
			file,
			`${lines.map((line, i) => (i === 1 ? JSON.stringify({ id: 'note_64b0c0ffee00000000000002', text: 'x'.repeat(50) }) : line.text)).join('\n')}\n`,
		);
		const product = fakeProduct();
		const report = await send({
			dir,
			products: { notes: { url: 'https://notes.test', token: product.token } },
			fetch: product.fetch,
		});
		expect(report.ok).toBe(false);
		expect(report.steps[0]?.failed).toEqual([
			{ line: 2, id: 'note_64b0c0ffee00000000000002', errors: [{ path: '/text', message: 'text is 1–40 characters' }] },
		]);
		await expect(
			send({ dir, products: { notes: { url: 'https://notes.test', token: 'wrong' } }, fetch: product.fetch }),
		).rejects.toThrow(/answered 401: The token is not valid/);
		const failing = fakeProduct({ failOn: 'notes' });
		await expect(
			send({ dir, products: { notes: { url: 'https://notes.test', token: failing.token } }, fetch: failing.fetch }),
		).rejects.toThrow(/answered 500$/);
		await expect(send({ dir, products: {}, fetch: product.fetch })).rejects.toThrow(/No address or server token for notes/);
		await expect(
			send({
				dir,
				products: { notes: { url: 'https://notes.test', token: product.token } },
				fetch: async () => new Response('not json', { status: 200 }),
			}),
		).resolves.toMatchObject({
			steps: [{ inserted: 0, updated: 0, failed: [] }],
			finished: [{ product: 'notes', summary: {} }],
		});
	});
});

describe('the ss-import command', () => {
	/** @param {string[]} argv @param {Partial<import('../src/cli.js').CliDeps>} [deps] */
	const run = async (argv, deps = {}) => {
		let out = '';
		let err = '';
		const code = await main(argv, {
			io: { out: (text) => void (out += text), err: (text) => void (err += text) },
			env: {},
			fetch: async () => new Response(null, { status: 599 }),
			connect: async () => {
				throw new Error('no database');
			},
			...deps,
		});
		return { code, out, err };
	};

	it('prints its usage', async () => {
		expect(await run([])).toEqual({ code: 2, out: USAGE, err: '' });
		expect((await run(['--help'])).code).toBe(0);
		expect((await run(['nope'])).err).toMatch(/unknown command nope/);
		expect((await run(['read', '--what'])).code).toBe(2);
		expect((await run(['read', '--mapping', 'nope', '--out', 'x'])).err).toMatch(/--mapping is one of: fixture/);
		expect((await run(['read', '--mapping', 'fixture'])).err).toMatch(/--out/);
		expect((await run(['read', '--mapping', 'fixture', '--out', 'x'])).err).toMatch(/SS_IMPORT_SOURCE_URI/);
		expect((await run(['send'])).err).toMatch(/--dir/);
		expect((await run(['send', '--dir', 'x', '--product', 'notes'])).err).toMatch(/<id>=<url>/);
		expect((await run(['verify', '--dir', 'x', '--product', 'notes=https://notes.test'])).err).toMatch(/SS_IMPORT_TOKEN_NOTES/);
	});

	it('reads, dry-runs, sends and verifies the fixture with tokens from the environment', async () => {
		const { source, dir } = await prepare();
		let closed = false;
		const connect = async (/** @type {string} */ uri) => {
			expect(uri).toBe('mongodb://store.example/shop');
			return { db: source.db, close: async () => void (closed = true) };
		};
		const readRun = await run(['read', '--mapping', 'fixture', '--out', dir], {
			env: { SS_IMPORT_SOURCE_URI: 'mongodb://store.example/shop' },
			connect,
		});
		expect(readRun).toEqual({ code: 0, out: '01-notes.notes.ndjson: 3 records (5 read, 1 merged, 1 left out)\n', err: '' });
		expect(closed).toBe(true);
		const product = fakeProduct();
		const env = { SS_IMPORT_TOKEN_NOTES: product.token };
		const args = ['--dir', dir, '--product', 'notes=https://notes.test'];
		expect(await run(['send', ...args, '--dry-run'], { env, fetch: product.fetch })).toEqual({
			code: 0,
			out: '[dry run] notes notes: 3 inserted, 0 updated, 0 failed\n',
			err: '',
		});
		expect((await run(['verify', ...args], { env, fetch: product.fetch })).out).toBe(
			'DIFF notes notes: read 3, imported ?, counted 0\n',
		);
		expect((await run(['verify', ...args], { env, fetch: product.fetch })).code).toBe(1);
		const sent = await run(['send', ...args, '--json'], { env, fetch: product.fetch });
		expect(JSON.parse(sent.out)).toMatchObject({ dryRun: false, ok: true });
		const verified = await run(['verify', ...args], { env, fetch: product.fetch });
		expect(verified).toEqual({ code: 0, out: 'ok   notes notes: read 3, imported 3, counted 3\n', err: '' });
		expect(JSON.parse((await run(['verify', ...args, '--json'], { env, fetch: product.fetch })).out).ok).toBe(true);
		// failed records are listed with their file line; a refused call is an error
		const file = path.join(dir, '01-notes.notes.ndjson');
		await writeFile(file, `${JSON.stringify({ id: 'note_64b0c0ffee00000000000009', text: '' })}\n`);
		const failed = await run(['send', ...args], { env, fetch: product.fetch });
		expect(failed.code).toBe(1);
		expect(failed.out).toContain('01-notes.notes.ndjson:1 note_64b0c0ffee00000000000009 /text text is 1–40 characters');
		const refused = await run(['send', ...args], { env: { SS_IMPORT_TOKEN_NOTES: 'wrong' }, fetch: product.fetch });
		expect(refused).toMatchObject({ code: 1, err: expect.stringMatching(/answered 401/) });
		expect((await run(['read', '--mapping', 'fixture', '--out', dir, '--source', 'mongodb://x/y'])).err).toMatch(/no database/);
	});
});
