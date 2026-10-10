import { describe, expect, it } from 'vitest';
import { IMPORT_LIMITS, defineRoute } from '../src/index.js';
import { openDb, productRoutes, setup } from './helpers.js';

/** @type {{ product: any }} */
const holder = { product: null };

/** Notes import: the product's own check in import mode (given ids and past times allowed). */
const IMPORTS = {
	collections: {
		notes: {
			check: (/** @type {Record<string, unknown>} */ record) => {
				if (typeof record.text !== 'string' || record.text === '')
					return { ok: /** @type {const} */ (false), errors: [{ path: '/text', message: 'text is required' }] };
				if (record.text === 'empty-errors') return { ok: /** @type {const} */ (false), errors: [] };
				const createdAt = typeof record.createdAt === 'string' ? new Date(record.createdAt) : null;
				return {
					ok: /** @type {const} */ (true),
					value: {
						id: record.id,
						text: record.text,
						websiteId: 'ignored',
						...(createdAt ? { createdAt } : {}),
					},
				};
			},
		},
		labels: {
			collection: 'note_labels',
			check: async (/** @type {Record<string, unknown>} */ record) => ({ ok: /** @type {const} */ (true), value: record }),
		},
	},
	finish: async (/** @type {any} */ ctx) => ({
		notes: await (await ctx.data()).collection('notes').countDocuments({ websiteId: ctx.websiteId }),
	}),
};

const routes = () => [
	...productRoutes(),
	defineRoute({
		method: 'POST',
		path: '/v1/import/:collection',
		auth: 'server',
		feature: 'notes',
		rawBody: true,
		maxBodyBytes: IMPORT_LIMITS.bytes + 1024,
		handler: (ctx) => holder.product.imports.upsert(ctx),
	}),
	defineRoute({
		method: 'POST',
		path: '/v1/import/finish',
		auth: 'server',
		feature: 'notes',
		handler: (ctx) => holder.product.imports.finish(ctx),
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/import/status',
		auth: 'server',
		feature: 'notes',
		handler: (ctx) => holder.product.imports.status(ctx),
	}),
];

const start = async () => {
	const ctx = await setup({ routes: routes(), imports: IMPORTS });
	holder.product = ctx.product;
	await ctx.switchOn(['notes']);
	const dbName = await ctx.connectDatabase();
	/** @param {string} collection @param {string} body @param {{ dryRun?: boolean, type?: string, headers?: Record<string, string> }} [options] */
	const send = async (collection, body, { dryRun = false, type = 'application/x-ndjson', headers = {} } = {}) => {
		const response = await ctx.call('POST', `/v1/import/${collection}${dryRun ? '?dryRun=1' : ''}`, {
			token: ctx.server.token,
			body,
			headers: { 'content-type': type, ...headers },
		});
		await ctx.settle();
		return { status: response.status, json: await response.json() };
	};
	return { ...ctx, dbName, send };
};

/** @param {unknown[]} records */
const ndjson = (records) => `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;

describe('import routes (K10)', () => {
	it('check every record, upsert by the given id, and change nothing on a dry run', async () => {
		const { send, dbName, call, server, websiteId } = await start();
		const records = [
			{ id: 'not_0123456789abcdef01234567', text: 'old note', createdAt: '2024-01-02T03:04:05Z' },
			{ id: 'not_0123456789abcdef01234568', text: 'second' },
			{ id: 'not_0123456789abcdef01234568', text: 'twice' },
			{ id: 'not_0123456789abcdef01234569', text: '' },
			{ text: 'no id' },
			{ id: 'not_0123456789abcdef0123456a', text: 'empty-errors' },
		];
		const body = `${ndjson(records)}not json\n\n`;
		const dry = await send('notes', body, { dryRun: true });
		expect(dry.status).toBe(200);
		expect(dry.json).toEqual({
			inserted: 2,
			updated: 0,
			dryRun: true,
			failed: [
				{
					line: 3,
					id: 'not_0123456789abcdef01234568',
					errors: [{ path: '/id', message: 'The same id appears twice in this call.' }],
				},
				{ line: 4, id: 'not_0123456789abcdef01234569', errors: [{ path: '/text', message: 'text is required' }] },
				{ line: 5, id: null, errors: [{ path: '/id', message: 'Each record is an object with an id (<prefix>_<id>).' }] },
				{ line: 6, id: 'not_0123456789abcdef0123456a', errors: [{ path: '', message: 'The record is not valid.' }] },
				{ line: 7, id: null, errors: [{ path: '', message: 'The line is not JSON.' }] },
			],
		});
		const { client, db } = await openDb(dbName);
		const notes = db.collection('ss_notes_notes');
		expect(await notes.countDocuments({})).toBe(0);

		const real = await send('notes', ndjson(records.slice(0, 2)), {
			headers: { 'ss-actor-id': 'usr_1', 'ss-actor-name': 'Importer' },
		});
		expect(real.json).toMatchObject({ inserted: 2, updated: 0, failed: [], dryRun: false });
		expect(await notes.findOne({ id: records[0]?.id })).toMatchObject({
			websiteId,
			merchantId: 'mer_0123456789abcdefghjkmnpq',
			text: 'old note',
			createdAt: new Date('2024-01-02T03:04:05Z'),
		});
		// re-runnable: the same ids update
		const again = await send('notes', ndjson(records.slice(0, 2)));
		expect(again.json).toMatchObject({ inserted: 0, updated: 2 });
		expect((await send('notes', ndjson(records.slice(0, 2)), { dryRun: true })).json).toMatchObject({
			inserted: 0,
			updated: 2,
		});
		expect(await notes.countDocuments({})).toBe(2);
		// one activity entry per call, never copied
		const entries = await db.collection('ss_notes_activity').find({}).sort({ at: 1 }).toArray();
		expect(entries.map((entry) => [entry.action, entry.detail, entry.copy])).toEqual([
			['import.notes', '2 inserted, 0 updated, 0 failed', 'none'],
			['import.notes', '0 inserted, 2 updated, 0 failed', 'none'],
		]);
		expect(entries[0]?.actor).toEqual({ kind: 'user', id: 'usr_1', name: 'Importer' });
		expect(entries[1]?.actor).toEqual({ kind: 'server', id: 'server', name: 'Server' });
		// another collection, its own table; status counts each
		expect((await send('labels', ndjson([{ id: 'lab_0123456789abcdef01234567', name: 'vip' }]))).json.inserted).toBe(1);
		expect(await db.collection('ss_notes_note_labels').countDocuments({})).toBe(1);
		const status = await call('GET', '/v1/import/status', { token: server.token });
		expect(await status.json()).toEqual({ collections: { notes: 2, labels: 1 } });
		const finished = await call('POST', '/v1/import/finish', { token: server.token });
		expect(await finished.json()).toEqual({ finished: true, notes: 2 });
		expect(await db.collection('ss_notes_activity').countDocuments({ action: 'import.finish' })).toBe(1);
		await client.close();
	});

	it('take NDJSON of at most 1,000 records and 4 MB, into the collections the product names', async () => {
		const { send } = await start();
		expect((await send('notes', '{}', { type: 'application/json' })).status).toBe(415);
		expect((await send('nope', ndjson([]))).status).toBe(404);
		const many = Array.from({ length: IMPORT_LIMITS.records + 1 }, (_, i) => ({
			id: `not_${String(i).padStart(24, '0')}`,
			text: 'x',
		}));
		expect((await send('notes', ndjson(many), { dryRun: true })).status).toBe(413);
		const big = ndjson([{ id: 'not_0123456789abcdef01234567', text: 'y'.repeat(IMPORT_LIMITS.bytes) }]);
		expect((await send('notes', big, { dryRun: true })).status).toBe(413);
		expect((await send('notes', ndjson(many.slice(0, 3)), { type: 'application/ndjson; charset=utf-8' })).json.inserted).toBe(
			3,
		);
	});

	it('report unique values already taken, and a product without imports answers nothing', async () => {
		const { send, dbName, product } = await start();
		const { client, db } = await openDb(dbName);
		await db.collection('ss_notes_notes').createIndex({ websiteId: 1, text: 1 }, { unique: true });
		const result = await send(
			'notes',
			ndjson([
				{ id: 'not_0123456789abcdef01234567', text: 'same' },
				{ id: 'not_0123456789abcdef01234568', text: 'same' },
			]),
		);
		expect(result.json).toMatchObject({
			inserted: 1,
			failed: [{ line: 2, errors: [{ message: 'A unique value is already taken.' }] }],
		});
		await client.close();
		expect(product.imports).toBeDefined();
		const plain = await setup();
		const status = await plain.product.imports.status({
			data: async () => ({ collection: () => null }),
			websiteId: plain.websiteId,
		});
		expect(status).toEqual({ collections: {} });
		await expect(plain.product.imports.upsert({ params: { collection: 'notes' } })).rejects.toMatchObject({
			code: 'not_found',
		});
	});

	it('refuse definitions that cannot work', async () => {
		await expect(
			setup({ imports: { collections: { 'Bad Name': { check: () => ({ ok: true, value: {} }) } } } }),
		).rejects.toThrow(/import collection names/);
		await expect(setup({ imports: { collections: { notes: {} } } })).rejects.toThrow(/needs a check/);
	});
});
