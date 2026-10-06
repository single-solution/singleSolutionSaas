import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLocks, createRegistry, createRepositories } from '../src/infra/db.js';
import { backoffDelay, createJobs, createOperationRunner, permanentFailure } from '../src/infra/jobs.js';
import { COLLECTIONS, INFRA_COLLECTIONS } from '../src/infra/schema.js';
import { createClock, createTestLogger, startMongo } from './helpers.js';
import { ensureIndexes } from '../src/infra/db.js';

/** @type {Awaited<ReturnType<typeof startMongo>>} */
let mongo;
beforeAll(async () => {
	mongo = await startMongo();
}, 120_000);
afterAll(async () => {
	await mongo?.stop();
});

let dbSeq = 0;
const setup = async () => {
	const clock = createClock();
	const db = mongo.db(`jobs_${(dbSeq += 1)}`);
	const registry = createRegistry(INFRA_COLLECTIONS);
	await ensureIndexes(db, registry);
	const r = createRepositories(db, registry, { now: clock.now });
	const { logger, entries } = createTestLogger();
	const jobs = createJobs({ repo: r.mutable(COLLECTIONS.jobs), now: clock.now, random: () => 0.5, logger });
	const locks = createLocks(r.mutable(COLLECTIONS.locks), { now: clock.now });
	return { clock, db, r, jobs, locks, logger, entries };
};

describe('backoffDelay', () => {
	it('doubles with jitter and caps', () => {
		expect(backoffDelay(1, { random: () => 0.5 })).toBe(5000);
		expect(backoffDelay(3, { random: () => 0.5 })).toBe(20_000);
		expect(backoffDelay(3, { random: () => 0 })).toBe(15_000);
		expect(backoffDelay(3, { random: () => 1 })).toBe(25_000);
		expect(backoffDelay(30, { random: () => 0.5 })).toBe(3_600_000);
		expect(backoffDelay(0)).toBeGreaterThan(0);
	});
});

describe('job queue', () => {
	it('enqueues idempotently by key and validates input', async () => {
		const { jobs } = await setup();
		const first = await jobs.enqueue({ name: 'demo.send', payload: { a: 1 }, key: 'send:1' });
		expect(first.inserted).toBe(true);
		expect(await jobs.enqueue({ name: 'demo.send', payload: { a: 2 }, key: 'send:1' })).toEqual({
			id: first.id,
			inserted: false,
		});
		expect((await jobs.enqueue({ name: 'demo.send' })).inserted).toBe(true);
		await expect(jobs.enqueue({ name: 'Bad Name' })).rejects.toThrow();
		await expect(jobs.enqueue({ name: 'demo.x', key: '' })).rejects.toThrow();
		await expect(jobs.enqueue({ name: 'demo.x', maxAttempts: 0 })).rejects.toThrow();
		expect(await jobs.stats()).toEqual({ queued: 2, running: 0, done: 0, dead: 0 });
	});

	it('leases due jobs once, completes, and ignores lost leases', async () => {
		const { jobs, clock } = await setup();
		await jobs.enqueue({ name: 'demo.later', runAt: clock.now() + 60_000 });
		const { id } = await jobs.enqueue({ name: 'demo.now', payload: { n: 1 } });
		const job = await jobs.lease({ leaseMs: 10_000 });
		expect(job).toMatchObject({ id, name: 'demo.now', payload: { n: 1 }, attempts: 1 });
		expect(await jobs.lease({ leaseMs: 10_000 })).toBeNull(); // the other is not due; this one is leased
		expect(await jobs.lease({ leaseMs: 10_000, names: ['demo.other'] })).toBeNull();
		// lease expires → re-leased (worker died); the first holder can no longer complete
		clock.advance(11_000);
		const again = await jobs.lease({ leaseMs: 10_000, names: ['demo.now'] });
		expect(again?.attempts).toBe(2);
		expect(await jobs.complete(/** @type {any} */ (job))).toBe(false);
		expect(await jobs.fail(/** @type {any} */ (job), new Error('late'))).toBe('lost');
		expect(await jobs.complete(/** @type {any} */ (again))).toBe(true);
		expect((await jobs.stats()).done).toBe(1);
	});

	it('retries with backoff, dead-letters after maxAttempts and replays', async () => {
		const { jobs, clock, entries } = await setup();
		const { id } = await jobs.enqueue({ name: 'demo.flaky', maxAttempts: 2 });
		const first = /** @type {any} */ (await jobs.lease({ leaseMs: 1000 }));
		expect(await jobs.fail(first, Object.assign(new Error('timeout'), { code: 'E_TIMEOUT' }))).toBe('retry');
		expect(await jobs.lease({ leaseMs: 1000 })).toBeNull(); // backing off 5 s
		clock.advance(5000);
		const second = /** @type {any} */ (await jobs.lease({ leaseMs: 1000 }));
		expect(second.attempts).toBe(2);
		expect(await jobs.fail(second, 'string failure')).toBe('dead');
		expect(entries.some((e) => e.msg === 'job dead-lettered')).toBe(true);
		const dead = await jobs.deadLetters({ name: 'demo.flaky' });
		expect(dead).toEqual([expect.objectContaining({ id, attempts: 2, lastError: { message: 'string failure' } })]);
		expect(await jobs.replay(id)).toBe(true);
		expect(await jobs.replay(id)).toBe(false);
		const replayed = /** @type {any} */ (await jobs.lease({ leaseMs: 1000 }));
		expect(replayed.attempts).toBe(1);
		expect(await jobs.fail(replayed, permanentFailure('invalid payload'))).toBe('dead');
		expect((await jobs.deadLetters()).length).toBe(1);
	});

	it('dead-letters a job whose lease expired on its last attempt', async () => {
		const { jobs, clock } = await setup();
		await jobs.enqueue({ name: 'demo.crash', maxAttempts: 1 });
		expect(await jobs.lease({ leaseMs: 1000 })).not.toBeNull();
		clock.advance(2000);
		expect(await jobs.lease({ leaseMs: 1000 })).toBeNull();
		expect((await jobs.deadLetters())[0]?.lastError).toEqual({
			message: 'lease expired on the last attempt',
			code: 'lease_expired',
		});
	});

	it('runBatch drains handled jobs until empty or the deadline', async () => {
		const { jobs, clock } = await setup();
		for (let i = 0; i < 4; i += 1) await jobs.enqueue({ name: 'demo.work', payload: { i } });
		await jobs.enqueue({ name: 'demo.fail' });
		await jobs.enqueue({ name: 'demo.unhandled' });
		/** @type {number[]} */
		const seen = [];
		const stats = await jobs.runBatch({
			handlers: {
				'demo.work': async (payload, { job, signal, deadline }) => {
					expect(job.name).toBe('demo.work');
					expect(signal.aborted).toBe(false);
					expect(deadline).toBeGreaterThan(clock.now());
					seen.push(payload.i);
				},
				'demo.fail': async () => Promise.reject(new Error('nope')),
			},
			deadlineMs: 30_000,
			concurrency: 2,
		});
		expect(seen.sort()).toEqual([0, 1, 2, 3]);
		expect(stats).toMatchObject({ leased: 5, succeeded: 4, retried: 1, dead: 0, lost: 0, stoppedBy: 'empty' });
		expect((await jobs.stats()).queued).toBe(2); // the retry + the unhandled job

		// deadline: each job "takes" 10 s of the 25 s budget (2 s safety)
		for (let i = 0; i < 5; i += 1) await jobs.enqueue({ name: 'demo.slow' });
		const slow = await jobs.runBatch({ handlers: { 'demo.slow': async () => void clock.advance(10_000) }, deadlineMs: 25_000 });
		expect(slow).toMatchObject({ succeeded: 3, stoppedBy: 'deadline' });
		expect(await jobs.runBatch({ handlers: {}, deadlineMs: 1000 })).toMatchObject({ leased: 0 });
	});
});

describe('targeted runs (F.19: no drains)', () => {
	it('runBatch runs only the given ids, keys or groups, at most maxJobs; makeDue pulls waiting retries forward', async () => {
		const { jobs, clock } = await setup();
		/** @type {string[]} */
		const ran = [];
		const handlers = { 'demo.x': async (/** @type {any} */ p) => void ran.push(p.n) };
		const one = await jobs.enqueue({ name: 'demo.x', key: 'k1', payload: { n: 1 } });
		for (const n of [2, 3]) await jobs.enqueue({ name: 'demo.x', key: `k${n}`, payload: { n }, group: 'g' });
		await jobs.enqueue({ name: 'demo.x', key: 'k4', payload: { n: 4 }, group: 'g', runAt: clock.now() + 60_000 });
		expect(await jobs.runBatch({ handlers, deadlineMs: 60_000, ids: [one.id] })).toMatchObject({ succeeded: 1 });
		expect(await jobs.runBatch({ handlers, deadlineMs: 60_000, keys: [] })).toMatchObject({ leased: 0 });
		expect(await jobs.runBatch({ handlers, deadlineMs: 60_000, ids: [] })).toMatchObject({ leased: 0 });
		expect(await jobs.runBatch({ handlers, deadlineMs: 60_000, groups: ['g'], maxJobs: 1 })).toMatchObject({
			succeeded: 1,
			stoppedBy: 'limit',
		});
		expect(await jobs.runBatch({ handlers, deadlineMs: 60_000, groups: ['g'] })).toMatchObject({ succeeded: 1 });
		expect(ran).toEqual([1, 2, 3]); // k4 waits for its time
		expect(await jobs.makeDue({ group: 'other' })).toBe(0);
		expect(await jobs.makeDue({ name: 'demo.x', group: 'g' })).toBe(1);
		expect(await jobs.runBatch({ handlers, deadlineMs: 60_000, groups: ['g'] })).toMatchObject({ succeeded: 1 });
		expect(ran).toEqual([1, 2, 3, 4]);
		await expect(jobs.enqueue({ name: 'demo.x', group: '' })).rejects.toThrow(/group/);
	});

	it('hands a new job that is due now to onEnqueued, never a future one or a duplicate', async () => {
		const { r, logger, clock } = await setup();
		/** @type {string[]} */
		const seen = [];
		const jobs = createJobs({
			repo: r.mutable(COLLECTIONS.jobs),
			now: clock.now,
			logger,
			onEnqueued: ({ name }) => void seen.push(name),
		});
		await jobs.enqueue({ name: 'demo.now', key: 'n' });
		await jobs.enqueue({ name: 'demo.now', key: 'n' });
		await jobs.enqueue({ name: 'demo.later', runAt: clock.now() + 1000 });
		expect(seen).toEqual(['demo.now']);
	});
});

describe('payload dropping', () => {
	it('complete(job, { dropPayload }) unsets the payload; runBatch does it for jobs enqueued with dropPayload', async () => {
		const { jobs, db } = await setup();
		const raw = db.collection(COLLECTIONS.jobs);
		const kept = await jobs.enqueue({ name: 'demo.keep', payload: { secret: 'kept' } });
		const dropped = await jobs.enqueue({ name: 'demo.drop', payload: { secret: 'sealed' }, dropPayload: true });
		const stats = await jobs.runBatch({
			handlers: {
				'demo.keep': async () => undefined,
				'demo.drop': async (payload) => expect(payload).toEqual({ secret: 'sealed' }),
			},
			deadlineMs: 60_000,
		});
		expect(stats.succeeded).toBe(2);
		expect(await raw.findOne({ _id: /** @type {any} */ (kept.id) })).toMatchObject({
			status: 'done',
			payload: { secret: 'kept' },
		});
		const done = await raw.findOne({ _id: /** @type {any} */ (dropped.id) });
		expect(done?.status).toBe('done');
		expect(done).not.toHaveProperty('payload');

		// explicit completion
		const manual = await jobs.enqueue({ name: 'demo.manual', payload: { secret: 'x' } });
		const job = /** @type {import('../src/infra/jobs.js').Job} */ (await jobs.lease({ names: ['demo.manual'], leaseMs: 1000 }));
		expect(job.dropPayload).toBe(false);
		expect(await jobs.complete(job, { dropPayload: true })).toBe(true);
		expect(await raw.findOne({ _id: /** @type {any} */ (manual.id) })).not.toHaveProperty('payload');
	});
});

describe('operation runner', () => {
	it('runs known operations under a lock with their input and records every run', async () => {
		const { r, locks, logger, clock } = await setup();
		const runs = r.appendOnly(COLLECTIONS.operationRuns);
		let release = () => {};
		const runner = createOperationRunner({
			operations: {
				ok: async ({ deadline, trigger, input }) => ({ deadline, trigger, input }),
				empty: async () => undefined,
				boom: async () => Promise.reject(Object.assign(new Error('exploded'), { code: 'E_BOOM' })),
				slow: () => new Promise((resolve) => (release = () => resolve({ done: true }))),
			},
			locks,
			runs,
			logger,
			deadlineMs: 10_000,
			now: clock.now,
		});
		expect(runner.names()).toEqual(['ok', 'empty', 'boom', 'slow']);
		expect(runner.has('ok')).toBe(true);
		expect(await runner.run('missing')).toBeNull();
		const okRun = await runner.run('ok', { trigger: 'staff:stf_1', input: { after: 'x' } });
		expect(okRun).toMatchObject({
			status: 'ok',
			stats: { deadline: clock.now() + 10_000, trigger: 'staff:stf_1', input: { after: 'x' } },
		});
		expect(await runner.run('empty')).toMatchObject({ status: 'ok' });
		expect(await runner.run('boom')).toMatchObject({ status: 'failed' });
		const pending = runner.run('slow');
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(await runner.run('slow')).toMatchObject({ status: 'locked' });
		release();
		expect(await pending).toMatchObject({ status: 'ok', stats: { done: true } });
		const records = await runs.find({}).sort({ startedAt: 1, _id: 1 }).toArray();
		expect(records.map((x) => x.status).sort()).toEqual(['failed', 'locked', 'ok', 'ok', 'ok']);
		expect(records.find((x) => x.name === 'boom')?.error).toEqual({ message: 'exploded', code: 'E_BOOM' });
		expect(() =>
			createOperationRunner({ operations: { 'Bad Name': async () => {} }, locks, runs, logger, deadlineMs: 1 }),
		).toThrow();
	});
});
