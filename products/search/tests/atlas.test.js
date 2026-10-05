/**
 * Atlas Search: the query builder and the index-state logic as pure functions (Atlas Search cannot run in
 * mongodb-memory-server), the adapter against fake driver collections, and the real driver path on the in-memory
 * MongoDB (which has no Atlas Search → `unavailable`).
 */
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createData, noopLogger } from '@ss/app-kit';
import {
	ATLAS_INDEX,
	atlasDefinition,
	atlasPipeline,
	classifyAtlasError,
	indexStateOf,
	pinsTenant,
	tokenClause,
} from '../core/atlas.js';
import { effectiveConfig } from '../core/config.js';
import { planQuery, rankingOf } from '../core/query.js';
import { matchableFields, typesOf } from '../core/schema.js';
import { definitionFor, ensureAtlasIndex, errorDetail, rawCollection, runSearch } from '../adapters/atlas.js';
import ranking from '../schemas/ranking.features.json' with { type: 'json' };
import { evaluate } from './atlas-sim.js';
import { mongoUri } from './harness.js';

const TYPES = typesOf([
	{
		key: 'item',
		label: 'Item',
		fields: [
			{ key: 'title', prefix: true },
			{ key: 'code', private: true },
			{ key: 'body', searchable: false },
		],
	},
	{ key: 'page', label: 'Page', fields: [{ key: 'title', prefix: true }, { key: 'code' }] },
]);
const RANK = rankingOf({
	...effectiveConfig(ranking, {}),
	synonyms: [{ terms: ['tv', 'television'] }],
	field_boosts: [
		{ field: 'title', weight: 4 },
		{ field: 'code', weight: 0 },
	],
});

describe('atlas query builder', () => {
	it('pins the tenant, visibility and types in the search filter and after it', () => {
		const plan = planQuery('tv stand', RANK, { maxChars: 100 });
		const pipeline = atlasPipeline({
			websiteId: 'web_1',
			plan,
			allowed: matchableFields(TYPES, { owner: false }),
			ranking: RANK,
			limit: 50,
			mode: 'all',
		});
		expect(pipeline[0]).toMatchObject({
			$search: {
				index: ATLAS_INDEX,
				compound: {
					filter: [
						{ equals: { path: 'websiteId', value: 'web_1' } },
						{ equals: { path: 'status', value: 'active' } },
						{ in: { path: 'type', value: ['item', 'page'] } },
					],
				},
			},
		});
		expect(/** @type {any} */ (pipeline[0])?.$search.compound.must).toHaveLength(2);
		expect(pipeline.slice(1, 3)).toEqual([{ $match: { websiteId: 'web_1' } }, { $limit: 50 }]);
		expect(pinsTenant(pipeline, 'web_1')).toBe(true);
		expect(pinsTenant(pipeline, 'web_2')).toBe(false);
		expect(pinsTenant([], 'web_1')).toBe(false);
		const any = atlasPipeline({
			websiteId: 'web_1',
			plan,
			allowed: matchableFields(TYPES, { owner: false }),
			ranking: RANK,
			limit: 5,
			mode: 'any',
			index: 'x',
		});
		expect(any[0]).toMatchObject({ $search: { index: 'x', compound: { minimumShouldMatch: 1 } } });
	});

	it('matches each word in the allowed fields with boosts, synonyms, fuzziness and autocomplete', () => {
		const [tv, stand] = planQuery('tv stand', RANK, { maxChars: 100 }).tokens;
		const pkFields = matchableFields(TYPES, { owner: false });
		const clause = tokenClause(/** @type {any} */ (tv), pkFields, RANK);
		expect(clause.compound.should).toEqual([
			{ text: { query: 'tv', path: 'fields.title', score: { boost: { value: 4 } } } },
			{ text: { query: ['television'], path: 'fields.title', score: { boost: { value: 3.6 } } } },
		]);
		const last = tokenClause(/** @type {any} */ (stand), pkFields, RANK);
		expect(last.compound.should).toContainEqual({
			text: {
				query: 'stand',
				path: 'fields.title',
				fuzzy: { maxEdits: 1, maxExpansions: 50 },
				score: { boost: { value: 4 } },
			},
		});
		expect(last.compound.should).toContainEqual({
			autocomplete: {
				query: 'stand',
				path: 'suggest',
				fuzzy: { maxEdits: 1, prefixLength: 1 },
				score: { boost: { value: 2.8 } },
			},
		});
		// `code` is private for items, public for pages: scoped to pages for browsers; weight 0 drops it entirely
		const weighted = rankingOf({ ...effectiveConfig(ranking, {}), field_boosts: [{ field: 'code', weight: 2 }] });
		const scoped = tokenClause(/** @type {any} */ (tv), pkFields, weighted);
		expect(scoped.compound.should).toContainEqual({
			compound: {
				filter: [{ in: { path: 'type', value: ['page'] } }],
				must: [{ text: { query: 'tv', path: 'fields.code', score: { boost: { value: 2 } } } }],
			},
		});
		const noPrefix = tokenClause(
			{ term: 'x', synonyms: [], prefix: true, maxEdits: 0 },
			new Map([['item', new Map([['body', { prefix: false }]])]]),
			RANK,
		);
		expect(noPrefix.compound.should.some((c) => 'autocomplete' in c)).toBe(false);
	});

	it('is evaluated by the simulator as Atlas would', () => {
		const plan = planQuery('televison', RANK, { maxChars: 100 });
		const [search] = atlasPipeline({
			websiteId: 'w',
			plan,
			allowed: matchableFields(TYPES, { owner: true }),
			ranking: RANK,
			limit: 5,
			mode: 'all',
		});
		const doc = {
			websiteId: 'w',
			status: 'active',
			type: 'page',
			fields: { title: 'Television stand' },
			suggest: 'Television stand',
		};
		expect(evaluate({ compound: /** @type {any} */ (search)?.$search.compound }, doc)).toBeGreaterThan(0);
		expect(evaluate({ compound: /** @type {any} */ (search)?.$search.compound }, { ...doc, websiteId: 'other' })).toBeNull();
		expect(() => evaluate({ near: {} }, doc)).toThrow('unsupported');
	});

	it('defines one generic index and classifies states and errors', () => {
		expect(atlasDefinition().mappings.fields).toMatchObject({
			websiteId: { type: 'token' },
			fields: { type: 'document', dynamic: true },
		});
		expect(definitionFor()).toEqual({ name: ATLAS_INDEX, definition: atlasDefinition() });
		expect(indexStateOf([])).toBe('missing');
		expect(indexStateOf([{ name: ATLAS_INDEX, queryable: true, status: 'STALE' }])).toBe('ready');
		expect(indexStateOf([{ name: ATLAS_INDEX, status: 'FAILED' }])).toBe('failed');
		expect(indexStateOf([{ name: ATLAS_INDEX, status: 'BUILDING' }])).toBe('building');
		expect(classifyAtlasError({ code: 13 })).toBe('permission_denied');
		expect(classifyAtlasError({ codeName: 'Unauthorized' })).toBe('permission_denied');
		expect(classifyAtlasError({ message: 'user is not authorized on db' })).toBe('permission_denied');
		expect(classifyAtlasError({ code: 31082 })).toBe('unavailable');
		expect(classifyAtlasError({ codeName: 'CommandNotFound' })).toBe('unavailable');
		expect(classifyAtlasError({ message: "Unrecognized pipeline stage name: '$listSearchIndexes'" })).toBe('unavailable');
		expect(classifyAtlasError({ code: 1 })).toBe('failed');
		expect(classifyAtlasError(null)).toBe('failed');
		expect(errorDetail({ codeName: 'X' })).toBe('X');
		expect(errorDetail({ code: 7 })).toBe('code 7');
		expect(errorDetail(undefined)).toBe('error');
	});
});

describe('atlas adapter', () => {
	/** @param {{ list?: any, create?: any }} behaviour */
	const fake = ({ list = async () => [], create = async () => 'ok' }) => {
		/** @type {any[]} */
		const created = [];
		return {
			created,
			listSearchIndexes: () => ({ toArray: list }),
			createSearchIndex: async (/** @type {any} */ spec) => {
				created.push(spec);
				return create();
			},
			aggregate: (/** @type {any} */ pipeline, /** @type {any} */ options) => ({
				toArray: async () => [{ pipeline, options }],
			}),
		};
	};
	it('creates the index when missing, and reports permission or availability problems with the definition', async () => {
		const missing = fake({});
		expect(await ensureAtlasIndex(missing)).toEqual({ state: 'building', detail: null });
		expect(missing.created[0]).toEqual({ name: ATLAS_INDEX, definition: atlasDefinition() });
		expect(await ensureAtlasIndex(fake({}), { create: false })).toEqual({ state: 'missing', detail: null });
		expect(await ensureAtlasIndex(fake({ list: async () => [{ name: ATLAS_INDEX, queryable: true }] }))).toEqual({
			state: 'ready',
			detail: null,
		});
		const denied = await ensureAtlasIndex(
			fake({
				create: async () =>
					Promise.reject(Object.assign(new Error('not authorized'), { code: 13, codeName: 'Unauthorized' })),
			}),
		);
		expect(denied).toEqual({ state: 'permission_denied', detail: 'Unauthorized', definition: definitionFor() });
		expect(await ensureAtlasIndex(fake({ list: async () => Promise.reject({ code: 13 }) }))).toMatchObject({
			state: 'permission_denied',
			definition: definitionFor(),
		});
		expect(
			await ensureAtlasIndex(fake({ list: async () => Promise.reject({ code: 31082, codeName: 'SearchNotEnabled' }) })),
		).toEqual({ state: 'unavailable', detail: 'SearchNotEnabled' });
		expect(await ensureAtlasIndex(fake({ create: async () => Promise.reject(new Error('Index already exists')) }))).toEqual({
			state: 'building',
			detail: null,
		});
		expect(await ensureAtlasIndex(fake({ create: async () => Promise.reject({ code: 59 }) }))).toMatchObject({
			state: 'unavailable',
		});
		expect(await ensureAtlasIndex(fake({ create: async () => Promise.reject({ code: 2 }) }))).toMatchObject({
			state: 'failed',
			detail: 'code 2',
		});
	});

	it('runs only tenant-pinned pipelines', async () => {
		const collection = fake({});
		const plan = planQuery('x', RANK, { maxChars: 10 });
		const pipeline = atlasPipeline({
			websiteId: 'w',
			plan,
			allowed: matchableFields(TYPES, { owner: true }),
			ranking: RANK,
			limit: 1,
			mode: 'all',
		});
		expect(await runSearch(collection, pipeline, 'w')).toEqual([{ pipeline, options: { maxTimeMS: 5000 } }]);
		await expect(runSearch(collection, pipeline, 'other')).rejects.toThrow('tenant_guard');
	});

	describe('on a MongoDB without Atlas Search', () => {
		/** @type {any} */
		let data;
		const dbName = `atlas_${Date.now()}`;
		beforeAll(() => {
			data = createData({
				portal: {
					resolveResource: async () => ({
						descriptor: { uri: mongoUri(dbName) },
						expiresAt: new Date(Date.now() + 60_000).toISOString(),
					}),
				},
				slug: 'search',
				randomBytes: (n) => new Uint8Array(n),
				logger: noopLogger,
				outbound: { allowHosts: ['127.0.0.1', 'localhost'] },
				autoSweep: false,
			});
		});
		afterAll(async () => {
			const client = await new MongoClient(mongoUri(dbName)).connect();
			await client.db(dbName).dropDatabase();
			await client.close();
			await data.closeAll();
		});
		it('reaches the driver collection behind the guard and reports unavailable', async () => {
			const scope = await data.forWebsite('web_1');
			const raw = rawCollection(scope.collection('documents'), 'web_1');
			expect(raw.collectionName).toBe('ss_search_documents');
			expect(raw.dbName).toBe(dbName);
			const status = await ensureAtlasIndex(raw);
			expect(['unavailable', 'failed']).toContain(status.state);
		});
	});
});
