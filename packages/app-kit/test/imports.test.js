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
		// a collection found by two fields (Growth's day + part), with something every check of a call needs
		days: {
			key: ['day', 'part'],
			prepare: async (/** @type {any} */ ctx) => ({ tenant: ctx.websiteId, dryRun: ctx.dryRun }),
			check: (/** @type {Record<string, unknown>} */ record, /** @type {any} */ ctx) =>
				record.day === '2024-13-01'
					? { ok: /** @type {const} */ (true), value: { ...record, day: '2024-12-01' } }
					: {
							ok: /** @type {const} */ (true),
							value: { ...record, checkedFor: ctx.prepared.tenant === ctx.websiteId, dryRunSeen: ctx.prepared.dryRun },
						},
		},
	},
	finish: async (/** @type {any} */ ctx) => ({
		notes: await (await ctx.data()).collection('notes').countDocuments({ websiteId: ctx.websiteId }),
	}),
	totals: async () => ({ 'notes.words': 3 }),
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
		path: '/v1/import/:collection/prune',
		auth: 'server',
		feature: 'notes',
		rawBody: true,
		maxBodyBytes: IMPORT_LIMITS.bytes + 1024,
		handler: (ctx) => holder.product.imports.upsert.prune(ctx),
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
	/** @param {string} collection @param {unknown} body @param {{ dryRun?: boolean, type?: string }} [options] */
	const prune = async (collection, body, { dryRun = false, type = 'application/json' } = {}) => {
		const response = await ctx.call('POST', `/v1/import/${collection}/prune${dryRun ? '?dryRun=1' : ''}`, {
			token: ctx.server.token,
			body: typeof body === 'string' ? body : JSON.stringify(body),
			headers: { 'content-type': type },
		});
		await ctx.settle();
		return { status: response.status, json: await response.json() };
	};
	return { ...ctx, dbName, send, prune };
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
		expect(await status.json()).toEqual({
			collections: { notes: 2, labels: 1, days: 0 },
			imported: { notes: 2, labels: 1, days: 0 },
			totals: { 'notes.words': 3 },
		});
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
			data: async () => ({ collection: () => null, ensureIndexes: async () => ({ created: [] }) }),
			websiteId: plain.websiteId,
		});
		expect(status).toEqual({ collections: {}, imported: {}, totals: {} });
		await expect(plain.product.imports.upsert({ params: { collection: 'notes' } })).rejects.toMatchObject({
			code: 'not_found',
		});
	});

	it('replace the stored record, so fields the source no longer has go, and keep createdAt', async () => {
		const { send, dbName, clock } = await start();
		const { client, db } = await openDb(dbName);
		const notes = db.collection('ss_notes_notes');
		const id = 'not_0123456789abcdef01234567';
		await send('notes', ndjson([{ id, text: 'first', createdAt: '2024-01-02T03:04:05Z' }]));
		await send('notes', ndjson([{ id: 'not_0123456789abcdef01234568', text: 'no time' }]));
		const madeAt = (await notes.findOne({ id: 'not_0123456789abcdef01234568' }))?.createdAt;
		expect(madeAt).toEqual(new Date(clock.now()));
		clock.advance(60_000);
		await notes.updateOne({ id }, { $set: { stale: true } });
		// the source changed the text and no longer has a time: the stored time stays, the stale field goes
		expect((await send('notes', ndjson([{ id, text: 'second' }]))).json).toMatchObject({ inserted: 0, updated: 1 });
		await send('notes', ndjson([{ id: 'not_0123456789abcdef01234568', text: 'no time, again' }]));
		const stored = await notes.findOne({ id });
		expect(stored).toMatchObject({ id, text: 'second', createdAt: new Date('2024-01-02T03:04:05Z') });
		expect(stored).not.toHaveProperty('stale');
		expect((await notes.findOne({ id: 'not_0123456789abcdef01234568' }))?.createdAt).toEqual(madeAt);
		await client.close();
	});

	it('find records by the collection’s own key, which the check must keep', async () => {
		const { send, dbName, call, server } = await start();
		const { client, db } = await openDb(dbName);
		const days = db.collection('ss_notes_days');
		const records = [
			{ day: '2024-01-01', part: 0, visits: 3 },
			{ day: '2024-01-01', part: 1, visits: 1 },
			{ day: '2024-01-02', part: 0, visits: 5 },
			{ day: '2024-01-01', part: 0, visits: 9 },
			{ day: '2024-01-03', part: -1 },
			{ day: '', part: 0 },
			{ day: 'x\u0001', part: 0 },
			{ day: '2024-13-01', part: 0 },
		];
		const dry = await send('days', ndjson(records), { dryRun: true });
		expect(dry.json).toEqual({
			inserted: 3,
			updated: 0,
			dryRun: true,
			failed: [
				{ line: 4, id: '2024-01-01/0', errors: [{ path: '/day', message: 'The same key appears twice in this call.' }] },
				...[5, 6, 7].map((line) => ({
					line,
					id: null,
					errors: [{ path: '/day', message: 'Each record is an object with its key: day, part.' }],
				})),
				{ line: 8, id: '2024-13-01/0', errors: [{ path: '/day', message: 'The check changed the record’s key.' }] },
			],
		});
		const real = await send('days', ndjson(records.slice(0, 3)));
		expect(real.json).toMatchObject({ inserted: 3, updated: 0, failed: [] });
		expect(await days.findOne({ day: '2024-01-01', part: 1 })).toMatchObject({
			visits: 1,
			checkedFor: true,
			dryRunSeen: false,
		});
		expect((await send('days', ndjson([{ day: '2024-01-01', part: 1, visits: 2 }]))).json).toMatchObject({ updated: 1 });
		expect(await days.countDocuments({})).toBe(3);
		const status = await call('GET', '/v1/import/status', { token: server.token });
		expect((await status.json()).imported).toMatchObject({ days: 3 });
		await client.close();
	});

	it('prune the records an import wrote and the source no longer has, range by range, dry run first', async () => {
		const { send, prune, dbName, call, server, websiteId } = await start();
		const { client, db } = await openDb(dbName);
		const notes = db.collection('ss_notes_notes');
		const ids = ['01', '02', '03', '04', '05'].map((n) => `not_0123456789abcdef012345${n}`);
		await send('notes', ndjson(ids.map((id) => ({ id, text: id }))));
		// a note the merchant made in the product itself: never an import's to remove
		await notes.insertOne({ websiteId, id: 'not_0123456789abcdef01234599', text: 'own' });
		// the source now holds 01, 03 and 05: two calls, the first up to 03, the last open
		const first = await prune('notes', { keep: [ids[0], ids[2]], through: ids[2] }, { dryRun: true });
		expect(first.json).toEqual({ removed: 1, keys: [ids[1]], more: false, dryRun: true });
		const last = await prune('notes', { keep: [{ id: ids[4] }], after: ids[2] }, { dryRun: true });
		expect(last.json).toEqual({ removed: 1, keys: [ids[3]], more: false, dryRun: true });
		expect(await notes.countDocuments({})).toBe(6);
		expect((await prune('notes', { keep: [ids[0], ids[2]], through: ids[2] })).json).toEqual({
			removed: 1,
			keys: [ids[1]],
			more: false,
			dryRun: false,
		});
		expect((await prune('notes', { keep: [ids[4]], after: ids[2] })).json).toMatchObject({ removed: 1, keys: [ids[3]] });
		expect((await notes.find({}).toArray()).map((note) => note.id).sort()).toEqual([
			ids[0],
			ids[2],
			ids[4],
			'not_0123456789abcdef01234599',
		]);
		// again: nothing left to remove; an empty source removes every imported note, the merchant's own stays
		expect((await prune('notes', { keep: [ids[0], ids[2], ids[4]] })).json).toMatchObject({ removed: 0, keys: [] });
		expect((await prune('notes', { keep: [] })).json).toMatchObject({ removed: 3 });
		expect((await notes.find({}).toArray()).map((note) => note.id)).toEqual(['not_0123456789abcdef01234599']);
		const status = await call('GET', '/v1/import/status', { token: server.token });
		expect((await status.json()).imported).toMatchObject({ notes: 0 });
		const entries = await db.collection('ss_notes_activity').find({ action: 'import.notes.prune' }).toArray();
		expect(entries.map((entry) => entry.detail)).toEqual(['1 removed', '1 removed', '0 removed', '3 removed']);
		await client.close();
	});

	it('prune keys of several fields, at most 1,000 a call', async () => {
		const { send, prune, dbName } = await start();
		const { client, db } = await openDb(dbName);
		const days = Array.from({ length: IMPORT_LIMITS.records + 2 }, (_, i) => ({
			day: `2024-01-${String(i).padStart(4, '0')}`,
			part: 0,
		}));
		await send('days', ndjson(days.slice(0, IMPORT_LIMITS.records)));
		await send('days', ndjson(days.slice(IMPORT_LIMITS.records)));
		// re-sent keys are already noted
		await send('days', ndjson(days.slice(IMPORT_LIMITS.records)));
		const dry = await prune('days', { keep: [days[0]] }, { dryRun: true });
		expect(dry.json).toMatchObject({ removed: IMPORT_LIMITS.records + 1, more: false });
		expect(dry.json.keys).toHaveLength(IMPORT_LIMITS.records);
		expect(dry.json.keys[0]).toBe('2024-01-0001/0');
		const once = await prune('days', { keep: [days[0]] });
		expect(once.json).toMatchObject({ removed: IMPORT_LIMITS.records, more: true });
		expect((await prune('days', { keep: [days[0]] })).json).toMatchObject({ removed: 1, more: false });
		expect(
			await db
				.collection('ss_notes_days')
				.find({}, { projection: { _id: 0, day: 1, part: 1 } })
				.toArray(),
		).toEqual([days[0]]);
		await client.close();
	});

	it('refuse a prune that is not a list of keys', async () => {
		const { prune } = await start();
		expect((await prune('notes', { keep: [] }, { type: 'application/x-ndjson' })).status).toBe(415);
		for (const body of ['not json', { keep: 'x' }, { keep: ['nope'] }, { keep: [], after: 'x' }, { keep: [], through: 3 }])
			expect((await prune('notes', body)).json).toMatchObject({
				status: 422,
				detail: 'Send { keep: [the id of each record], after?, through? }.',
			});
		expect((await prune('days', { keep: ['2024-01-01'] })).json.detail).toBe(
			'Send { keep: [{ day, part } of each record], after?, through? }.',
		);
		const many = Array.from({ length: IMPORT_LIMITS.records + 1 }, (_, i) => `not_${String(i).padStart(24, '0')}`);
		expect((await prune('notes', { keep: many })).status).toBe(413);
		expect((await prune('notes', { keep: [], after: null, through: null })).status).toBe(200);
		expect((await prune('notes', 'x'.repeat(IMPORT_LIMITS.bytes + 1))).status).toBe(413);
		expect((await prune('nope', { keep: [] })).status).toBe(404);
	});

	it('refuse definitions that cannot work', async () => {
		await expect(
			setup({ imports: { collections: { 'Bad Name': { check: () => ({ ok: true, value: {} }) } } } }),
		).rejects.toThrow(/import collection names/);
		await expect(setup({ imports: { collections: { notes: {} } } })).rejects.toThrow(/needs a check/);
		const check = () => ({ ok: /** @type {const} */ (true), value: {} });
		for (const key of [[], ['a', 'b', 'c', 'd', 'e'], ['totals.visits'], 'id'])
			await expect(setup({ imports: { collections: { notes: { check, key: /** @type {any} */ (key) } } } })).rejects.toThrow(
				/key is 1–4 top-level field names/,
			);
		await expect(setup({ imports: { collections: { notes: { check, prepare: /** @type {any} */ ('x') } } } })).rejects.toThrow(
			/prepare is a function/,
		);
	});
});
