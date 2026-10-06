import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GLOBAL_SCOPE, auditEntryHash, auditScopeOf, createAudit, genesisHashOf } from '../src/infra/audit.js';
import { createLocks, createRegistry, createRepositories, ensureIndexes } from '../src/infra/db.js';
import { COLLECTIONS, INFRA_COLLECTIONS } from '../src/infra/schema.js';
import { MERCHANT, MERCHANT_2, createClock, createTestLogger, startMongo } from './helpers.js';

/** Locks that are always free. */
const freeLocks = /** @type {any} */ ({ acquire: async () => ({ release: async () => {} }) });

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
			findOne: async (/** @type {any} */ filter) =>
				docs.filter((d) => d.scope === filter.scope).sort((a, b) => b.seq - a.seq)[0] ?? null,
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
		const audit = createAudit({ repo, locks: freeLocks, now: () => 0 });
		const id = await audit.record({
			actor: { type: 'merchant_user', id: 'usr_1', via: { type: 'staff', id: 'stf_1' } },
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
			actor: { type: 'merchant_user', id: 'usr_1', via: { type: 'staff', id: 'stf_1' } },
			action: 'connector.updated',
			target: { type: 'connector', id: 'con_1', websiteId: 'web_1' },
			merchantId: MERCHANT,
			before: { uri: '[redacted]' },
			after: { apiKey: '[redacted]', name: 'Atlas' },
			requestId: null,
			ip: '192.0.2.1',
			reason: 'support ticket 42',
			scope: `merchant:${MERCHANT}`,
			seq: 1,
			prevHash: genesisHashOf(`merchant:${MERCHANT}`),
			hash: auditEntryHash(docs[0]),
		});
		await audit.record({
			actor: { type: 'system', id: 'cron' },
			action: 'credits.reconciled',
			target: { type: 'merchant', id: MERCHANT },
		});
		expect(docs[1]).not.toHaveProperty('before');
		expect(docs[1].actor.via).toBeNull();
	});

	it('rejects invalid actors, actions and targets', async () => {
		const audit = createAudit({ repo: fakeRepo().repo, locks: freeLocks });
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
		const audit = createAudit({ repo: fake.repo, locks: freeLocks });
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

describe('audit hash chain (MongoDB)', () => {
	/** @type {Awaited<ReturnType<typeof startMongo>>} */
	let mongo;
	beforeAll(async () => {
		mongo = await startMongo();
	});
	afterAll(async () => {
		await mongo.stop();
	});

	/** @param {string} name */
	const setup = async (name) => {
		const db = mongo.db(name);
		const registry = createRegistry(INFRA_COLLECTIONS);
		await ensureIndexes(db, registry);
		const clock = createClock();
		const repos = createRepositories(db, registry, { now: clock.now });
		const locks = createLocks(repos.mutable(COLLECTIONS.locks), { now: clock.now });
		const { logger, entries } = createTestLogger();
		const audit = createAudit({ repo: repos.appendOnly(COLLECTIONS.audit), locks, now: clock.now, logger });
		const raw = db.collection(COLLECTIONS.audit);
		return { audit, raw, clock, entries, locks };
	};

	const staff = /** @type {const} */ ({ type: 'staff', id: 'stf_1' });

	it('chains entries per scope (global + per merchant), concurrently, and verifies them', async () => {
		const { audit, raw } = await setup('chain');
		await Promise.all(
			Array.from({ length: 12 }, (_, i) =>
				audit.record({
					actor: staff,
					action: 'thing.changed',
					target: { type: 'thing', id: `t_${i}`, merchantId: i % 3 === 0 ? null : i % 3 === 1 ? MERCHANT : MERCHANT_2 },
					after: { i, nested: { at: new Date(0), skip: undefined } },
				}),
			),
		);
		const scopes = [GLOBAL_SCOPE, auditScopeOf(MERCHANT), auditScopeOf(MERCHANT_2)];
		for (const scope of scopes) {
			const report = await audit.verifyChain(scope);
			expect(report).toMatchObject({ scope, ok: true, entries: 4, seq: 4, broken: null });
			const seqs = (await raw.find({ scope }).sort({ seq: 1 }).toArray()).map((d) => d.seq);
			expect(seqs).toEqual([1, 2, 3, 4]);
		}
		expect(await audit.verifyAuditChain('merchant:mer_none')).toMatchObject({
			ok: true,
			entries: 0,
			headHash: genesisHashOf('merchant:mer_none'),
		});
		// stored values are JSON-normalised (dates as ISO, undefined members dropped)
		const one = await raw.findOne({ 'target.id': 't_1' });
		expect(one?.after).toEqual({ i: 1, nested: { at: '1970-01-01T00:00:00.000Z' } });
	});

	it('detects edited, deleted and reordered entries', async () => {
		const { audit, raw } = await setup('tamper');
		for (let i = 0; i < 4; i += 1)
			await audit.record({
				actor: staff,
				action: 'credits.adjusted',
				target: { type: 'merchant', id: MERCHANT, merchantId: MERCHANT },
				after: { amount: i },
			});
		await audit.record({ actor: staff, action: 'staff.created', target: { type: 'staff', id: 'stf_2' } });
		const scope = auditScopeOf(MERCHANT);

		// edit a field (bypassing the append-only repository, as an attacker with database access would)
		await raw.updateOne({ scope, seq: 2 }, { $set: { 'after.amount': 1000 } });
		expect((await audit.verifyChain(scope)).broken).toMatchObject({ seq: 2, reason: 'hash' });
		await raw.updateOne({ scope, seq: 2 }, { $set: { 'after.amount': 1 } });
		expect((await audit.verifyChain(scope)).ok).toBe(true);

		// recompute the hash of an edited entry: the next link breaks
		const second = /** @type {any} */ (await raw.findOne({ scope, seq: 2 }));
		const edited = { ...second, reason: 'rewritten' };
		await raw.replaceOne({ _id: second._id }, { ...edited, hash: auditEntryHash(edited) });
		expect((await audit.verifyChain(scope)).broken).toMatchObject({ seq: 3, reason: 'prev_hash' });
		await raw.replaceOne({ _id: second._id }, second);

		// delete an entry: a gap
		const third = /** @type {any} */ (await raw.findOne({ scope, seq: 3 }));
		await raw.deleteOne({ _id: third._id });
		expect((await audit.verifyChain(scope)).broken).toMatchObject({ seq: 3, reason: 'seq_gap' });
		await raw.insertOne(third);

		// swap two entries' sequence numbers
		await raw.updateOne({ scope, seq: 3 }, { $set: { seq: 30 } });
		await raw.updateOne({ scope, seq: 4 }, { $set: { seq: 3 } });
		await raw.updateOne({ scope, seq: 30 }, { $set: { seq: 4 } });
		expect((await audit.verifyChain(scope)).ok).toBe(false);
	});

	it('appends after the head when a lease expired, waits for busy scopes and aborts on a signal', async () => {
		const { audit, raw, clock, locks } = await setup('locks');
		const target = { type: 'staff', id: 'stf_9' };
		await audit.record({ actor: staff, action: 'staff.created', target });
		// another writer holds the scope lock: the append waits for the release
		const held = await locks.acquire(`audit:${GLOBAL_SCOPE}`, { ttlMs: 60_000 });
		const pending = audit.record({ actor: staff, action: 'staff.updated', target });
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(await raw.countDocuments({})).toBe(1);
		await held?.release();
		await pending;
		expect((await audit.verifyChain(GLOBAL_SCOPE)).seq).toBe(2);

		// a busy lock that never frees fails after the wait budget
		const impatient = createAudit({ repo: /** @type {any} */ ({}), locks, now: clock.now, lockWaitMs: 0 });
		await locks.acquire(`audit:${GLOBAL_SCOPE}`, { ttlMs: 60_000 });
		await expect(impatient.record({ actor: staff, action: 'staff.updated', target })).rejects.toThrow(/busy/);

		// verification aborts on a signal
		const controller = new AbortController();
		controller.abort();
		await expect(audit.verifyChain(GLOBAL_SCOPE, { signal: controller.signal })).rejects.toThrow(/aborted/);
	});

	it('retries on a duplicate sequence (expired lease) and gives up after the attempts', async () => {
		const docs = /** @type {any[]} */ ([]);
		let failures = 2;
		const repo = /** @type {any} */ ({
			findOne: async () => docs[docs.length - 1] ?? null,
			insertOne: async (/** @type {any} */ doc) => {
				if (failures > 0) {
					failures -= 1;
					throw Object.assign(new Error('E11000'), { code: 11000 });
				}
				docs.push(doc);
			},
		});
		const audit = createAudit({ repo, locks: freeLocks });
		await audit.record({ actor: staff, action: 'a.b', target: { type: 't', id: 'x' } });
		expect(docs).toHaveLength(1);
		failures = 10;
		await expect(audit.record({ actor: staff, action: 'a.b', target: { type: 't', id: 'x' } })).rejects.toThrow(/E11000/);
	});
});
