import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryStores, createMongoStores } from '../src/index.js';
import { createClock } from './helpers.js';
import { startMongo } from './mongo.js';

/** @type {Awaited<ReturnType<typeof startMongo>>} */
let mongo;
let dbCounter = 0;

beforeAll(async () => {
	mongo = await startMongo();
}, 120_000);

afterAll(async () => {
	await mongo?.stop();
});

const factories = {
	memory: (/** @type {() => number} */ now) => createMemoryStores({ now }),
	mongo: (/** @type {() => number} */ now) => {
		dbCounter += 1;
		return createMongoStores({ db: mongo.client.db(`stores_${dbCounter}`), now });
	},
};

const record = (/** @type {string} */ key) => ({
	idempotencyKey: key,
	websiteId: 'web_1',
	subscriptionId: 'sub_1',
	unit: 'redemption',
	quantity: 1,
	occurredAt: '2026-10-01T10:00:00.000Z',
});

describe.each(Object.entries(factories))('%s stores', (_name, factory) => {
	it('replay: first sight false, then true, expiry and forget', async () => {
		const clock = createClock();
		const { replay, nonce } = factory(clock.now);
		expect(await replay.seen('a', clock.now() + 1000)).toBe(false);
		expect(await replay.seen('a', clock.now() + 1000)).toBe(true);
		expect(await nonce.seen('a', clock.now() + 1000)).toBe(false);
		clock.advance(2000);
		expect(await replay.seen('a', clock.now() + 1000)).toBe(false);
		await replay.forget('a');
		expect(await replay.seen('a', clock.now() + 1000)).toBe(false);
	});

	it('burned tokens burn once and keep annotations', async () => {
		const { burnedTokens } = factory(Date.now);
		expect(await burnedTokens.isBurned('h')).toBe(false);
		expect(await burnedTokens.get('h')).toBeNull();
		expect(await burnedTokens.burn('h')).toBe(true);
		expect(await burnedTokens.burn('h')).toBe(false);
		expect(await burnedTokens.isBurned('h')).toBe(true);
		await burnedTokens.annotate('h', { appId: 'app_1' });
		expect(await burnedTokens.get('h')).toMatchObject({ appId: 'app_1' });
		await burnedTokens.annotate('other', { appId: 'app_2' });
		expect(await burnedTokens.get('other')).toMatchObject({ appId: 'app_2' });
	});

	it('entitlements keep the newest version', async () => {
		const { entitlements } = factory(Date.now);
		expect(await entitlements.get('w')).toBeNull();
		expect(await entitlements.put('w', { token: 't2', version: 2, fetchedAt: 1 })).toBe(true);
		expect(await entitlements.put('w', { token: 't1', version: 1, fetchedAt: 2 })).toBe(false);
		expect(await entitlements.put('w', { token: 't2b', version: 2, fetchedAt: 3 })).toBe(true);
		expect(await entitlements.get('w')).toEqual({ token: 't2b', version: 2, fetchedAt: 3 });
		await entitlements.delete('w');
		expect(await entitlements.get('w')).toBeNull();
	});

	it('usage queue: unique keys, leases, ack, retry, dead letter', async () => {
		const clock = createClock();
		const { usageQueue } = factory(clock.now);
		expect(await usageQueue.enqueue(record('k1'))).toEqual({ inserted: true });
		expect(await usageQueue.enqueue(record('k1'))).toEqual({ inserted: false });
		await usageQueue.enqueue(record('k2'));
		await usageQueue.enqueue(record('k3'));
		const first = await usageQueue.lease({ now: clock.now(), limit: 2, leaseMs: 1000, owner: 'a' });
		expect(first).toHaveLength(2);
		expect(first[0]).toMatchObject({ websiteId: 'web_1', unit: 'redemption', quantity: 1, attempts: 0, status: 'pending' });
		const second = await usageQueue.lease({ now: clock.now(), limit: 10, leaseMs: 1000, owner: 'b' });
		expect(second.map((r) => r.idempotencyKey)).toEqual(
			['k1', 'k2', 'k3'].filter((k) => !first.some((r) => r.idempotencyKey === k)),
		);
		expect(await usageQueue.lease({ now: clock.now(), limit: 10, leaseMs: 1000, owner: 'c' })).toEqual([]);
		await usageQueue.ack([first[0]?.idempotencyKey ?? ''], { now: clock.now(), retainMs: 10_000 });
		await usageQueue.retry([first[1]?.idempotencyKey ?? ''], {
			now: clock.now(),
			nextAttemptAt: clock.now() + 5000,
			error: 'x',
		});
		await usageQueue.deadLetter([second[0]?.idempotencyKey ?? ''], { now: clock.now(), error: 'rejected' });
		await usageQueue.ack([], { now: clock.now(), retainMs: 1 });
		await usageQueue.retry([], { now: clock.now(), nextAttemptAt: 0, error: 'x' });
		await usageQueue.deadLetter([], { now: clock.now(), error: 'x' });
		await usageQueue.ack(['missing'], { now: clock.now(), retainMs: 1 });
		await usageQueue.retry(['missing'], { now: clock.now(), nextAttemptAt: 0, error: 'x' });
		await usageQueue.deadLetter(['missing'], { now: clock.now(), error: 'x' });
		expect(await usageQueue.stats()).toEqual({ pending: 1, sent: 1, dead: 1 });
		// sent records still dedupe
		expect(await usageQueue.enqueue(record(first[0]?.idempotencyKey ?? ''))).toEqual({ inserted: false });
		clock.advance(5000);
		const retried = await usageQueue.lease({ now: clock.now(), limit: 10, leaseMs: 1000, owner: 'd' });
		expect(retried).toHaveLength(1);
		expect(retried[0]).toMatchObject({ attempts: 1, lastError: 'x' });
	});

	it('queues lease only one website’s due records when asked', async () => {
		const clock = createClock();
		const { usageQueue, eventOutbox } = factory(clock.now);
		await usageQueue.enqueue(record('w1'));
		await usageQueue.enqueue({ ...record('w2'), websiteId: 'web_2' });
		const only = await usageQueue.lease({ now: clock.now(), limit: 10, leaseMs: 1000, owner: 'a', websiteId: 'web_2' });
		expect(only.map((r) => r.idempotencyKey)).toEqual(['w2']);
		await eventOutbox.enqueue({ id: 'e1', envelope: { id: 'e1', websiteId: 'web_1' } });
		await eventOutbox.enqueue({ id: 'e2', envelope: { id: 'e2', websiteId: 'web_2' } });
		const events = await eventOutbox.lease({ now: clock.now(), limit: 10, leaseMs: 1000, owner: 'a', websiteId: 'web_1' });
		expect(events.map((e) => e.id)).toEqual(['e1']);
	});

	it('event outbox: unique ids, leases, ack drops the envelope, retry, dead letter, retention', async () => {
		const clock = createClock();
		const { eventOutbox } = factory(clock.now);
		const envelope = (/** @type {string} */ id) => ({ id, type: 'coupon_box.created@1', data: { n: 1 } });
		expect(await eventOutbox.enqueue({ id: 'e1', envelope: envelope('e1') })).toEqual({ inserted: true });
		expect(await eventOutbox.enqueue({ id: 'e1', envelope: envelope('e1') })).toEqual({ inserted: false });
		await eventOutbox.enqueue({ id: 'e2', envelope: envelope('e2') });
		await eventOutbox.enqueue({ id: 'e3', envelope: envelope('e3') });
		const first = await eventOutbox.lease({ now: clock.now(), limit: 2, leaseMs: 1000, owner: 'a' });
		expect(first).toHaveLength(2);
		expect(first[0]).toMatchObject({ attempts: 0, status: 'pending', envelope: { type: 'coupon_box.created@1' } });
		const second = await eventOutbox.lease({ now: clock.now(), limit: 10, leaseMs: 1000, owner: 'b' });
		expect(second).toHaveLength(1);
		expect(await eventOutbox.lease({ now: clock.now(), limit: 10, leaseMs: 1000, owner: 'c' })).toEqual([]);
		await eventOutbox.ack([first[0]?.id ?? ''], { now: clock.now(), retainMs: 10_000 });
		await eventOutbox.retry([first[1]?.id ?? ''], { now: clock.now(), nextAttemptAt: clock.now() + 5000, error: 'x' });
		await eventOutbox.deadLetter([second[0]?.id ?? ''], { now: clock.now(), error: 'rejected', retainMs: 10_000 });
		for (const op of /** @type {const} */ (['ack', 'retry', 'deadLetter'])) {
			await /** @type {any} */ (eventOutbox)[op]([], { now: 0, retainMs: 1, nextAttemptAt: 0, error: 'x' });
			await /** @type {any} */ (eventOutbox)[op](['missing'], { now: 0, retainMs: 1, nextAttemptAt: 0, error: 'x' });
		}
		expect(await eventOutbox.stats()).toEqual({ pending: 1, sent: 1, dead: 1 });
		expect(await eventOutbox.enqueue({ id: first[0]?.id ?? '', envelope: envelope('x') })).toEqual({ inserted: false });
		clock.advance(5000);
		const retried = await eventOutbox.lease({ now: clock.now(), limit: 10, leaseMs: 1000, owner: 'd' });
		expect(retried).toHaveLength(1);
		expect(retried[0]).toMatchObject({ attempts: 1, lastError: 'x' });
	});

	it('revocations accumulate with the cursor', async () => {
		const { revocations } = factory(Date.now);
		expect(await revocations.get()).toEqual({ keyIds: [], cursor: null, syncedAt: null });
		await revocations.add(['k1', 'k2'], { cursor: '2', syncedAt: 100 });
		await revocations.add(['k2', 'k3']);
		await revocations.add([], { cursor: '3' });
		const state = await revocations.get();
		expect(state.keyIds.sort()).toEqual(['k1', 'k2', 'k3']);
		expect(state).toMatchObject({ cursor: '3', syncedAt: 100 });
	});

	it('sessions expire', async () => {
		const clock = createClock();
		const { sessions } = factory(clock.now);
		await sessions.create('s1', { role: 'merchant' }, clock.now() + 1000);
		expect(await sessions.get('s1')).toEqual({ role: 'merchant' });
		expect(await sessions.get('nope')).toBeNull();
		clock.advance(1001);
		expect(await sessions.get('s1')).toBeNull();
		await sessions.create('s2', {}, clock.now() + 1000);
		await sessions.delete('s2');
		expect(await sessions.get('s2')).toBeNull();
	});

	it('idempotency: new, pending, mismatch, done, release, expiry', async () => {
		const clock = createClock();
		const { idempotency } = factory(clock.now);
		expect(await idempotency.begin('k', 'f1', clock.now() + 1000)).toEqual({ state: 'new' });
		expect(await idempotency.begin('k', 'f1', clock.now() + 1000)).toEqual({ state: 'pending' });
		expect(await idempotency.begin('k', 'f2', clock.now() + 1000)).toEqual({ state: 'mismatch' });
		const response = { status: 201, headers: { 'content-type': 'application/json' }, replay: /** @type {const} */ ('website') };
		await idempotency.complete('k', response);
		await idempotency.complete('missing', response);
		expect(await idempotency.begin('k', 'f1', clock.now() + 1000)).toEqual({ state: 'done', response });
		await idempotency.release('k');
		expect(await idempotency.begin('k', 'f2', clock.now() + 1000)).toEqual({ state: 'new' });
		clock.advance(2000);
		expect(await idempotency.begin('k', 'f3', clock.now() + 1000)).toEqual({ state: 'new' });
	});

	it('rate limits count per window', async () => {
		const clock = createClock();
		const { rateLimits } = factory(clock.now);
		expect((await rateLimits.hit('k', 1000, clock.now())).count).toBe(1);
		const second = await rateLimits.hit('k', 1000, clock.now());
		expect(second.count).toBe(2);
		expect(second.resetAt).toBeGreaterThan(clock.now());
		clock.advance(1000);
		expect((await rateLimits.hit('k', 1000, clock.now())).count).toBe(1);
	});

	it('portal keys keep the last JWKS', async () => {
		const { portalKeys } = factory(Date.now);
		expect(await portalKeys.get()).toBeNull();
		await portalKeys.put({ keys: [1] }, 5);
		await portalKeys.put({ keys: [2] }, 6);
		expect(await portalKeys.get()).toEqual({ jwks: { keys: [2] }, fetchedAt: 6 });
	});

	it('pings', async () => {
		const stores = factory(Date.now);
		await expect(stores.ping?.()).resolves.toBeUndefined();
	});
});

describe('mongo stores specifics', () => {
	it('creates TTL indexes once and rejects a missing db', async () => {
		const db = mongo.client.db('stores_indexes');
		const stores = createMongoStores({ db, prefix: 'kit_' });
		await stores.ensureIndexes();
		await stores.ensureIndexes();
		const indexes = await db.collection('kit_replay').indexes();
		expect(indexes.find((index) => index.name === 'ttl')).toMatchObject({ expireAfterSeconds: 0 });
		expect(stores.collections.usageQueue).toBe('kit_usage_queue');
		expect(() => createMongoStores(/** @type {any} */ ({}))).toThrow(TypeError);
	});

	it('retries index creation after a failure and surfaces other errors', async () => {
		let fail = true;
		/** @type {any} */
		const db = {
			collection: () => ({
				createIndex: async () => {
					if (fail) throw new Error('down');
				},
				insertOne: async () => {
					throw Object.assign(new Error('other'), { code: 1 });
				},
				updateOne: async () => {
					throw Object.assign(new Error('other'), { code: 1 });
				},
			}),
		};
		const stores = createMongoStores({ db });
		await expect(stores.ensureIndexes()).rejects.toThrow('down');
		fail = false;
		await stores.ensureIndexes();
		await expect(stores.replay.seen('x', 1)).rejects.toThrow('other');
		await expect(stores.burnedTokens.burn('x')).rejects.toThrow('other');
		await expect(stores.entitlements.put('x', { token: 't', version: 1, fetchedAt: 1 })).rejects.toThrow('other');
		await expect(stores.usageQueue.enqueue(record('x'))).rejects.toThrow('other');
		await expect(stores.idempotency.begin('x', 'f', 1)).rejects.toThrow('other');
	});
});
