import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAudit } from '../src/infra/audit.js';
import { createRegistry, createRepositories, ensureIndexes } from '../src/infra/db.js';
import { COLLECTIONS, INFRA_COLLECTIONS } from '../src/infra/schema.js';
import { MERCHANT, createClock, startMongo } from './helpers.js';

/** Append-only fake recording inserts and the last query. */
const fakeRepo = () => {
	/** @type {any[]} */
	const docs = [];
	/** @type {any} */
	const last = {};
	return {
		docs,
		last,
		repo: /** @type {any} */ ({
			insertOne: async (/** @type {any} */ doc) => {
				docs.push(doc);
				return { insertedId: doc._id };
			},
			find: (/** @type {any} */ filter) => {
				last.filter = filter;
				const cursor = {
					sort: (/** @type {any} */ sort) => ((last.sort = sort), cursor),
					limit: (/** @type {number} */ n) => ((last.limit = n), cursor),
					toArray: async () => docs,
				};
				return cursor;
			},
		}),
	};
};

describe('audit', () => {
	it('records normalised, redacted entries', async () => {
		const { repo, docs } = fakeRepo();
		const audit = createAudit({ repo, now: () => 0 });
		const id = await audit.record({
			actor: { type: 'merchant_user', id: 'usr_1', roles: ['owner'] },
			action: 'connector.updated',
			target: { type: 'connector', id: 'con_1', merchantId: MERCHANT, websiteId: 'web_1' },
			before: { uri: 'mongodb://u:p@h/db' },
			after: { apiKey: 'secret', name: 'Atlas' },
			ip: '192.0.2.1',
			reason: 'support ticket 42',
		});
		expect(id).toMatch(/^aud_/);
		expect(docs[0]).toEqual({
			_id: id,
			at: new Date(0),
			actor: { type: 'merchant_user', id: 'usr_1' },
			action: 'connector.updated',
			target: { type: 'connector', id: 'con_1', websiteId: 'web_1' },
			merchantId: MERCHANT,
			before: { uri: '[redacted]' },
			after: { apiKey: '[redacted]', name: 'Atlas' },
			requestId: null,
			ip: '192.0.2.1',
			reason: 'support ticket 42',
		});
		await audit.record({
			actor: { type: 'system', id: 'cron' },
			action: 'credits.reconciled',
			target: { type: 'merchant', id: MERCHANT },
		});
		expect(docs[1]).not.toHaveProperty('before');
	});

	it('rejects invalid actors, actions and targets', async () => {
		const audit = createAudit({ repo: fakeRepo().repo });
		const target = { type: 't', id: 'x' };
		await expect(
			audit.record({ actor: /** @type {any} */ ({ type: 'website', id: 'k' }), action: 'a.b', target }),
		).rejects.toThrow(/actor type/);
		await expect(audit.record({ actor: /** @type {any} */ ({ type: 'staff' }), action: 'a.b', target })).rejects.toThrow(
			/actor/,
		);
		await expect(audit.record({ actor: { type: 'staff', id: 's' }, action: 'Created', target })).rejects.toThrow(/action/);
		await expect(
			audit.record({ actor: { type: 'staff', id: 's' }, action: 'a.b', target: /** @type {any} */ ({ id: 'x' }) }),
		).rejects.toThrow(/target/);
	});

	it('lists newest first with keyset cursors and filters', async () => {
		const fake = fakeRepo();
		const audit = createAudit({ repo: fake.repo });
		await audit.list({
			merchantId: MERCHANT,
			targetId: 'con_1',
			actorId: 'usr_1',
			before: { at: 5, id: 'aud_x' },
			limit: 1000,
		});
		expect(fake.last).toEqual({
			filter: {
				merchantId: MERCHANT,
				'target.id': 'con_1',
				'actor.id': 'usr_1',
				$or: [{ at: { $lt: new Date(5) } }, { at: new Date(5), _id: { $lt: 'aud_x' } }],
			},
			sort: { at: -1, _id: -1 },
			limit: 200,
		});
		await audit.list();
		expect(fake.last.filter).toEqual({});
		expect(fake.last.limit).toBe(50);
		await audit.list({ merchantId: null, limit: 0 });
		expect(fake.last).toMatchObject({ filter: { merchantId: null }, limit: 1 });
	});
});

describe('audit (MongoDB)', () => {
	/** @type {Awaited<ReturnType<typeof startMongo>>} */
	let mongo;
	beforeAll(async () => {
		mongo = await startMongo();
	});
	afterAll(async () => {
		await mongo.stop();
	});

	it('appends JSON-normalised entries through the append-only repository', async () => {
		const db = mongo.db('audit');
		const registry = createRegistry(INFRA_COLLECTIONS);
		await ensureIndexes(db, registry);
		const clock = createClock();
		const repos = createRepositories(db, registry, { now: clock.now });
		const audit = createAudit({ repo: repos.appendOnly(COLLECTIONS.audit), now: clock.now });
		await Promise.all(
			Array.from({ length: 6 }, (_, i) =>
				audit.record({
					actor: { type: 'staff', id: 'stf_1' },
					action: 'thing.changed',
					target: { type: 'thing', id: `t_${i}`, merchantId: i % 2 === 0 ? null : MERCHANT },
					after: { i, nested: { at: new Date(0), skip: undefined } },
				}),
			),
		);
		expect(await audit.list({ merchantId: MERCHANT })).toHaveLength(3);
		// stored values are JSON-normalised (dates as ISO, undefined members dropped)
		const one = await db.collection(COLLECTIONS.audit).findOne({ 'target.id': 't_1' });
		expect(one?.after).toEqual({ i: 1, nested: { at: '1970-01-01T00:00:00.000Z' } });
	});
});
