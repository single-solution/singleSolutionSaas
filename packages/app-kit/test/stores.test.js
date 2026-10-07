import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryStore, createMongoStore } from '../src/index.js';
import { freshDb } from './helpers.js';

/** @type {MongoClient} */
let client;
beforeAll(async () => {
	client = await new MongoClient(/** @type {string} */ (process.env.TEST_MONGODB_URI)).connect();
});
afterAll(async () => {
	await client.close();
});

/** @type {Array<[string, (now: () => number) => import('../src/index.js').Store]>} */
const kinds = [
	['memory', (now) => createMemoryStore({ now })],
	['mongo', (now) => createMongoStore({ db: client.db(freshDb('store')), now })],
];

describe.each(kinds)('%s store', (_name, make) => {
	it('gets, puts, inserts if absent and deletes documents', async () => {
		let t = 1000;
		const store = make(() => t);
		expect(await store.get('state', 'a')).toBeNull();
		expect(await store.insert('state', 'a', { v: 1 })).toBe(true);
		expect(await store.insert('state', 'a', { v: 2 })).toBe(false);
		expect(await store.get('state', 'a')).toEqual({ v: 1 });
		await store.put('state', 'a', { v: 3, nested: { x: [1] } });
		expect(await store.get('state', 'a')).toEqual({ v: 3, nested: { x: [1] } });
		await store.delete('state', 'a');
		expect(await store.get('state', 'a')).toBeNull();
		// expired documents vanish and can be taken over
		await store.put('sessions', 's1', { subject: 'x', expiresAt: 2000 });
		expect(await store.get('sessions', 's1')).toMatchObject({ subject: 'x' });
		t = 2000;
		expect(await store.get('sessions', 's1')).toBeNull();
		expect(await store.insert('sessions', 's1', { subject: 'y', expiresAt: 5000 })).toBe(true);
		expect(await store.get('sessions', 's1')).toMatchObject({ subject: 'y' });
	});

	it('lists newest first by equality filters (arrays match members) and deletes by filter', async () => {
		const store = make(() => 1000);
		await store.put('changes', 'c1', { websiteId: 'w1', at: 1 });
		await store.put('changes', 'c2', { websiteId: 'w1', at: 3 });
		await store.put('changes', 'c3', { websiteId: null, at: 2 });
		await store.put('changes', 'c4', { websiteId: 'w2', at: 4 });
		expect((await store.list('changes', { websiteId: 'w1' })).map((d) => d.at)).toEqual([3, 1]);
		expect((await store.list('changes', { websiteId: null })).map((d) => d.at)).toEqual([2]);
		expect(await store.list('changes', { websiteId: 'w1' }, { limit: 1 })).toHaveLength(1);
		await store.put('sessions', 's1', { subject: 'a', websiteIds: ['w1', 'w2'] });
		await store.put('sessions', 's2', { subject: 'b', websiteIds: ['w3'] });
		await store.put('sessions', 's3', { subject: 'old', websiteIds: ['w1'], expiresAt: 500 });
		expect((await store.list('sessions', { websiteIds: 'w1' })).map((d) => d.subject)).toEqual(['a']);
		expect(await store.deleteWhere('sessions', { websiteIds: 'w2' })).toBe(1);
		expect(await store.deleteWhere('changes', { websiteId: 'w1' })).toBe(2);
		expect(await store.list('changes', {})).toHaveLength(2);
	});

	it('records replays, forgets them and counts fixed windows', async () => {
		let t = 1000;
		const store = make(() => t);
		expect(await store.seen('n1', 2000)).toBe(false);
		expect(await store.seen('n1', 2000)).toBe(true);
		await store.forget('n1');
		expect(await store.seen('n1', 2000)).toBe(false);
		t = 2500;
		expect(await store.seen('n1', 9000)).toBe(false);
		expect(await store.hit('k', 60_000, 1000)).toEqual({ count: 1, resetAt: 60_000 });
		expect(await store.hit('k', 60_000, 2000)).toEqual({ count: 2, resetAt: 60_000 });
		expect(await store.hit('k', 60_000, 61_000)).toEqual({ count: 1, resetAt: 120_000 });
	});
});

describe('mongo store', () => {
	it('needs a database and knows its collections', () => {
		expect(() => createMongoStore({ db: /** @type {any} */ (null) })).toThrow(/Db/);
		const store = createMongoStore({ db: client.db(freshDb('store')) });
		return expect(store.get(/** @type {any} */ ('nope'), 'x')).rejects.toThrow(/unknown collection/);
	});

	it('fills a memory store past its window cap without growing forever', async () => {
		const store = createMemoryStore({ now: () => 0 });
		for (let i = 0; i < 10_002; i += 1) await store.hit(`k${i}`, 1000, i < 10_000 ? 0 : 5000);
		expect((await store.hit('k10001', 1000, 5000)).count).toBe(2);
	});
});
