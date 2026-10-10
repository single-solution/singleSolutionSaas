import { describe, expect, it } from 'vitest';
import { COUNT_CAP, COUNT_TIMEOUT_MS, MAX_GROUPS, countHandlers, defineRoute, problem } from '../src/index.js';
import { productRoutes, setup } from './helpers.js';

/** A list of notes with a status filter, and its counts by status and by whether it is long. */
const notes = countHandlers({
	source: async (ctx) => {
		if (ctx.query.status === 'bad') throw problem('validation_failed', 'status is open or done.');
		return {
			collection: (await ctx.data()).collection('notes'),
			filter: { websiteId: ctx.websiteId, ...(ctx.query.status ? { status: ctx.query.status } : {}) },
		};
	},
	by: {
		status: 'status',
		long: { path: 'length', map: (value) => (Number(value) > 10 ? 'true' : 'false') },
		tag: { path: 'tag', map: () => null },
	},
});

const routes = () => [
	...productRoutes(),
	defineRoute({ method: 'GET', path: '/v1/server/notes/count', auth: 'server', feature: 'notes', handler: notes.count }),
	defineRoute({ method: 'GET', path: '/v1/server/notes/counts', auth: 'server', feature: 'notes', handler: notes.counts }),
	defineRoute({
		method: 'POST',
		path: '/v1/server/notes',
		auth: 'server',
		feature: 'notes',
		handler: async (ctx) => {
			const db = await ctx.data();
			await db.collection('notes').insertMany(/** @type {any[]} */ (ctx.body));
			return { saved: true };
		},
	}),
];

/** @param {Response} response */
const json = async (response) => ({ status: response.status, json: await response.json() });

describe('counts (K4)', () => {
	it('count a list with its own filters, and group it by the fields the product names', async () => {
		const { call, server, switchOn, connectDatabase } = await setup({ routes: routes() });
		await switchOn(['notes']);
		await connectDatabase();
		const docs = [
			...Array.from({ length: 3 }, (_, i) => ({ id: `n${i}`, status: 'open', length: 5 })),
			...Array.from({ length: 2 }, (_, i) => ({ id: `d${i}`, status: 'done', length: 20 })),
			{ id: 'x', length: 30 },
		];
		expect((await call('POST', '/v1/server/notes', { token: server.token, body: docs })).status).toBe(200);
		expect(await json(await call('GET', '/v1/server/notes/count', { token: server.token }))).toEqual({
			status: 200,
			json: { count: 6, capped: false },
		});
		expect((await json(await call('GET', '/v1/server/notes/count?status=open', { token: server.token }))).json.count).toBe(3);
		expect((await call('GET', '/v1/server/notes/count?status=bad', { token: server.token })).status).toBe(422);
		expect((await json(await call('GET', '/v1/server/notes/counts?by=status', { token: server.token }))).json).toEqual({
			total: 6,
			groups: { open: 3, done: 2, none: 1 },
		});
		expect((await json(await call('GET', '/v1/server/notes/counts?by=long', { token: server.token }))).json).toEqual({
			total: 6,
			groups: { false: 3, true: 3 },
		});
		expect((await json(await call('GET', '/v1/server/notes/counts?by=tag', { token: server.token }))).json.groups).toEqual({
			none: 6,
		});
		const unknown = await json(await call('GET', '/v1/server/notes/counts?by=colour', { token: server.token }));
		expect(unknown.status).toBe(422);
		expect(unknown.json.detail).toBe('by is one of: status, long, tag.');
	});

	it('cap at 100,000, keep the 50 largest groups and give up after 3 seconds', async () => {
		expect([COUNT_CAP, MAX_GROUPS, COUNT_TIMEOUT_MS]).toEqual([100_000, 50, 3_000]);
		/** @type {any[]} */
		const calls = [];
		const many = countHandlers({
			source: async () => ({
				collection: {
					countDocuments: async (/** @type {any} */ filter, /** @type {any} */ options) => {
						calls.push(options);
						return COUNT_CAP + 1;
					},
					aggregate: () => ({
						toArray: async () =>
							Array.from({ length: 60 }, (_, i) => ({ _id: `g${String(i).padStart(2, '0')}`, n: 100 - i })),
					}),
				},
				filter: { websiteId: 'w' },
			}),
			by: { group: 'group' },
		});
		expect(await many.count({ query: {} })).toEqual({ count: COUNT_CAP, capped: true });
		expect(calls[0]).toEqual({ limit: COUNT_CAP + 1, maxTimeMS: COUNT_TIMEOUT_MS });
		const grouped = await many.counts({ query: { by: 'group' } });
		expect(Object.keys(grouped.groups)).toHaveLength(MAX_GROUPS);
		expect(grouped.groups.g00).toBe(100);
		expect(grouped.total).toBe(Array.from({ length: 60 }, (_, i) => 100 - i).reduce((a, b) => a + b, 0));

		const timeout = Object.assign(new Error('operation exceeded time limit'), { code: 50 });
		const slow = countHandlers({
			source: async () => ({
				collection: {
					countDocuments: async () => {
						throw timeout;
					},
					aggregate: () => ({
						toArray: async () => {
							throw Object.assign(new Error('timeout'), { codeName: 'MaxTimeMSExpired' });
						},
					}),
				},
				filter: {},
			}),
			by: { group: 'group' },
		});
		await expect(slow.count({ query: {} })).rejects.toMatchObject({ code: 'count_timeout' });
		await expect(slow.counts({ query: { by: 'group' } })).rejects.toMatchObject({ code: 'count_timeout' });
		const broken = countHandlers({
			source: async () => ({
				collection: {
					countDocuments: async () => {
						throw new Error('other');
					},
					aggregate: () => ({ toArray: async () => [] }),
				},
				filter: {},
			}),
		});
		await expect(broken.count({ query: {} })).rejects.toThrow('other');
		await expect(broken.counts({ query: { by: 'x' } })).rejects.toMatchObject({
			code: 'validation_failed',
			detail: 'This list has no fields to count by.',
		});
	});

	it('answer 503 count_timeout through the request handler', async () => {
		const slow = countHandlers({
			source: async () => ({
				collection: {
					countDocuments: async () => {
						throw Object.assign(new Error('slow'), { name: 'MongoOperationTimeoutError' });
					},
					aggregate: () => ({ toArray: async () => [] }),
				},
				filter: {},
			}),
		});
		const { call, server } = await setup({
			routes: [
				...productRoutes(),
				defineRoute({ method: 'GET', path: '/v1/slow/count', auth: 'server', database: false, handler: slow.count }),
			],
		});
		const response = await call('GET', '/v1/slow/count', { token: server.token });
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ type: 'https://notes.example.dev/problems/count_timeout' });
	});
});
