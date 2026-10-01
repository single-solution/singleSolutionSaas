/**
 * Database-backed job queue and cron runner (PLAN §13: "Vercel Cron → signed routes; Atlas-backed queues with
 * leases"). No worker processes: cron invocations drain the queue in bounded batches (`runBatch({ deadlineMs })`)
 * that stop leasing before the function time limit.
 *
 * Queue semantics (`platform_jobs`):
 * - `enqueue` is idempotent on an optional job `key` (unique while the job document exists: done jobs are kept for
 *   `doneRetentionMs`, dead ones for `deadRetentionMs`, then removed by TTL).
 * - `lease` atomically claims one due job (`queued` with `runAt ≤ now`, or `running` whose lease expired — the
 *   worker died) and gives it a visibility timeout; every lease counts an attempt.
 * - `complete` / `fail` only act while the caller still holds the lease (`leaseToken`), so a slow worker whose
 *   lease was taken over cannot overwrite the new owner's outcome. `complete(job, { dropPayload: true })` unsets the
 *   payload of the done record (jobs enqueued with `dropPayload: true` are completed that way by `runBatch`), so
 *   payloads that must not outlive their delivery are gone as soon as the job succeeds.
 * - failures retry with exponential backoff and jitter (5 s · 2^(attempt-1), capped at 1 h) until `maxAttempts`,
 *   then the job is dead-lettered; `permanentFailure()` dead-letters at once. Dead jobs can be replayed.
 *
 * Cron runs (`platform_cron_runs`, append-only, 30-day TTL): one record per invocation with status and stats; a
 * per-job lease lock prevents overlapping runs of the same cron.
 * @module
 */
import { createId } from '@ss/contracts';
import { platformError } from './errors.js';
import { defaultRandomBytes, isDuplicateKey, isObject, randomToken } from './util.js';

/** @typedef {import('./db.js').MutableOps} MutableOps */
/** @typedef {import('./db.js').ReadOps} ReadOps */
/** @typedef {import('./db.js').Locks} Locks */
/** @typedef {import('./logger.js').Logger} Logger */

/**
 * @typedef {object} Job
 * @property {string} id
 * @property {string} name
 * @property {string | null} key
 * @property {unknown} payload
 * @property {number} attempts attempts so far, including the current one
 * @property {number} maxAttempts
 * @property {string} leaseToken
 * @property {Date} createdAt
 * @property {boolean} dropPayload the payload is removed when the job completes
 */

/**
 * @typedef {(payload: any, ctx: { job: Job, signal: AbortSignal, deadline: number, logger: Logger }) => Promise<unknown>} JobHandler
 */

const NAME = /^[a-z][a-z0-9_.-]{0,63}$/;
const PERMANENT = Symbol.for('ss.platform.permanent-failure');

/**
 * An error that dead-letters the job without further retries (e.g. invalid payload).
 * @param {string} message
 * @returns {Error}
 */
export const permanentFailure = (message) => {
	const error = new Error(message);
	/** @type {any} */ (error)[PERMANENT] = true;
	return error;
};

/**
 * Backoff before retry `attempt` (1-based): `base · 2^(attempt-1)` capped at `max`, with ±25 % jitter.
 * @param {number} attempt
 * @param {{ baseMs?: number, maxMs?: number, random?: () => number }} [options]
 */
export const backoffDelay = (attempt, { baseMs = 5_000, maxMs = 60 * 60_000, random = Math.random } = {}) => {
	const raw = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
	return Math.round(raw * (0.75 + random() * 0.5));
};

/**
 * @param {unknown} error
 * @returns {{ message: string, code?: string }}
 */
const describeError = (error) => {
	const message = error instanceof Error ? error.message : String(error);
	const code = isObject(error) && typeof error.code === 'string' ? error.code : undefined;
	return { message: message.slice(0, 500), ...(code ? { code } : {}) };
};

/**
 * @param {Record<string, any>} doc
 * @returns {Job}
 */
const toJob = (doc) => ({
	id: String(doc._id),
	name: doc.name,
	key: doc.key ?? null,
	payload: doc.payload,
	attempts: doc.attempts,
	maxAttempts: doc.maxAttempts,
	leaseToken: doc.leaseToken,
	createdAt: doc.createdAt,
	dropPayload: doc.dropPayload === true,
});

/**
 * @param {{ repo: MutableOps, now?: () => number, randomBytes?: (n: number) => Uint8Array, random?: () => number,
 *   logger: Logger, doneRetentionMs?: number, deadRetentionMs?: number, defaultMaxAttempts?: number }} options
 */
export const createJobs = ({
	repo,
	now = Date.now,
	randomBytes = defaultRandomBytes,
	random = Math.random,
	logger,
	doneRetentionMs = 7 * 24 * 60 * 60_000,
	deadRetentionMs = 30 * 24 * 60 * 60_000,
	defaultMaxAttempts = 8,
}) => {
	/**
	 * Enqueue a job. With a `key`, enqueueing the same key again returns the existing job (`inserted: false`).
	 * `dropPayload: true` removes the payload once the job succeeds.
	 * @param {{ name: string, payload?: unknown, key?: string, runAt?: Date | number, maxAttempts?: number, dropPayload?: boolean }} input
	 * @returns {Promise<{ id: string, inserted: boolean }>}
	 */
	const enqueue = async ({ name, payload = null, key, runAt, maxAttempts = defaultMaxAttempts, dropPayload = false }) => {
		if (typeof name !== 'string' || !NAME.test(name)) throw platformError('invalid_argument', `invalid job name: ${name}`);
		if (key !== undefined && (typeof key !== 'string' || key.length === 0 || key.length > 256))
			throw platformError('invalid_argument', 'job key must be 1..256 chars');
		if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100)
			throw platformError('invalid_argument', 'maxAttempts must be 1..100');
		const t = new Date(now());
		const id = createId('job', { randomBytes });
		try {
			await repo.insertOne({
				_id: id,
				name,
				...(key === undefined ? {} : { key }),
				payload,
				...(dropPayload ? { dropPayload: true } : {}),
				status: 'queued',
				attempts: 0,
				maxAttempts,
				runAt: runAt === undefined ? t : new Date(runAt),
				createdAt: t,
				updatedAt: t,
			});
			return { id, inserted: true };
		} catch (error) {
			if (!isDuplicateKey(error) || key === undefined) throw error;
			const existing = await repo.findOne({ key }, { projection: { _id: 1 } });
			if (!existing) throw error;
			return { id: String(existing._id), inserted: false };
		}
	};

	/**
	 * Mark a job dead.
	 * @param {string} id
	 * @param {string | null} leaseToken
	 * @param {{ message: string, code?: string }} error
	 */
	const markDead = async (id, leaseToken, error) => {
		const t = now();
		const result = await repo.updateOne(
			{ _id: id, ...(leaseToken ? { leaseToken } : {}) },
			{
				$set: {
					status: 'dead',
					lastError: error,
					finishedAt: new Date(t),
					updatedAt: new Date(t),
					expireAt: new Date(t + deadRetentionMs),
				},
				$unset: { leaseToken: '', leaseUntil: '' },
			},
		);
		logger.warn('job dead-lettered', { jobId: id, error });
		return result.modifiedCount === 1;
	};

	/**
	 * Claim one due job.
	 * @param {{ names?: string[], leaseMs: number, owner?: string }} options
	 * @returns {Promise<Job | null>}
	 */
	const lease = async ({ names, leaseMs, owner = 'worker' }) => {
		for (;;) {
			const t = new Date(now());
			const doc = await repo.findOneAndUpdate(
				{
					$or: [
						{ status: 'queued', runAt: { $lte: t } },
						{ status: 'running', leaseUntil: { $lte: t } },
					],
					...(names ? { name: { $in: names } } : {}),
				},
				{
					$set: {
						status: 'running',
						leaseUntil: new Date(t.getTime() + leaseMs),
						leaseToken: randomToken(randomBytes, 16),
						leasedBy: owner,
						updatedAt: t,
					},
					$inc: { attempts: 1 },
				},
				{ sort: { runAt: 1 }, returnDocument: 'after' },
			);
			if (!doc) return null;
			if (doc.attempts > doc.maxAttempts) {
				// its previous lease expired (the worker died) on the last allowed attempt
				await markDead(String(doc._id), doc.leaseToken, {
					message: 'lease expired on the last attempt',
					code: 'lease_expired',
				});
				continue;
			}
			return toJob(doc);
		}
	};

	/**
	 * @param {Job} job
	 * @param {{ dropPayload?: boolean }} [options] `dropPayload`: unset the payload of the done record
	 * @returns {Promise<boolean>} false when the lease was lost
	 */
	const complete = async (job, { dropPayload = false } = {}) => {
		const t = now();
		const result = await repo.updateOne(
			{ _id: job.id, leaseToken: job.leaseToken, status: 'running' },
			{
				$set: { status: 'done', finishedAt: new Date(t), updatedAt: new Date(t), expireAt: new Date(t + doneRetentionMs) },
				$unset: { leaseToken: '', leaseUntil: '', ...(dropPayload ? { payload: '' } : {}) },
			},
		);
		return result.modifiedCount === 1;
	};

	/**
	 * @param {Job} job
	 * @param {unknown} error
	 * @returns {Promise<'retry' | 'dead' | 'lost'>}
	 */
	const fail = async (job, error) => {
		const described = describeError(error);
		const permanent = isObject(error) && /** @type {any} */ (error)[PERMANENT] === true;
		if (permanent || job.attempts >= job.maxAttempts)
			return (await markDead(job.id, job.leaseToken, described)) ? 'dead' : 'lost';
		const t = now();
		const result = await repo.updateOne(
			{ _id: job.id, leaseToken: job.leaseToken, status: 'running' },
			{
				$set: {
					status: 'queued',
					runAt: new Date(t + backoffDelay(job.attempts, { random })),
					lastError: described,
					updatedAt: new Date(t),
				},
				$unset: { leaseToken: '', leaseUntil: '' },
			},
		);
		return result.modifiedCount === 1 ? 'retry' : 'lost';
	};

	/**
	 * Drain due jobs until the queue is empty or the deadline approaches. Jobs without a handler are not leased.
	 * @param {{ handlers: Record<string, JobHandler>, deadlineMs: number, owner?: string, concurrency?: number, safetyMs?: number }} options
	 */
	const runBatch = async ({ handlers, deadlineMs, owner = 'cron', concurrency = 1, safetyMs = 2_000 }) => {
		const names = Object.keys(handlers);
		const deadline = now() + deadlineMs;
		const stats = {
			leased: 0,
			succeeded: 0,
			retried: 0,
			dead: 0,
			lost: 0,
			stoppedBy: /** @type {'empty' | 'deadline'} */ ('empty'),
		};
		if (names.length === 0) return stats;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), Math.max(0, deadlineMs - safetyMs));
		const worker = async () => {
			for (;;) {
				if (now() >= deadline - safetyMs) {
					stats.stoppedBy = 'deadline';
					return;
				}
				const job = await lease({ names, owner, leaseMs: Math.max(deadline - now(), 0) + 30_000 });
				if (!job) return;
				stats.leased += 1;
				const handler = /** @type {JobHandler} */ (handlers[job.name]);
				try {
					await handler(job.payload, {
						job,
						signal: controller.signal,
						deadline,
						logger: logger.child({ jobId: job.id, job: job.name }),
					});
					if (await complete(job, { dropPayload: job.dropPayload })) stats.succeeded += 1;
					else stats.lost += 1;
				} catch (error) {
					logger.warn('job failed', { jobId: job.id, job: job.name, attempt: job.attempts, error });
					const outcome = await fail(job, error);
					if (outcome === 'retry') stats.retried += 1;
					else if (outcome === 'dead') stats.dead += 1;
					else stats.lost += 1;
				}
			}
		};
		try {
			await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
		} finally {
			clearTimeout(timer);
		}
		return stats;
	};

	return Object.freeze({
		enqueue,
		lease,
		complete,
		fail,
		runBatch,
		/**
		 * @param {{ name?: string, limit?: number }} [query]
		 */
		deadLetters: async ({ name, limit = 50 } = {}) =>
			(
				await repo
					.find({ status: 'dead', ...(name ? { name } : {}) })
					.sort({ finishedAt: -1 })
					.limit(Math.min(limit, 200))
					.toArray()
			).map((doc) => ({
				id: String(doc._id),
				name: doc.name,
				key: doc.key ?? null,
				attempts: doc.attempts,
				lastError: doc.lastError ?? null,
				finishedAt: doc.finishedAt,
			})),
		/**
		 * Re-queue a dead job with a fresh attempt budget.
		 * @param {string} id
		 * @returns {Promise<boolean>}
		 */
		replay: async (id) => {
			const t = new Date(now());
			const result = await repo.updateOne(
				{ _id: id, status: 'dead' },
				{ $set: { status: 'queued', attempts: 0, runAt: t, updatedAt: t }, $unset: { expireAt: '', finishedAt: '' } },
			);
			return result.modifiedCount === 1;
		},
		/** Counts by status. */
		stats: async () => {
			const rows = await repo.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray();
			/** @type {Record<'queued' | 'running' | 'done' | 'dead', number>} */
			const out = { queued: 0, running: 0, done: 0, dead: 0 };
			for (const row of rows) if (Object.hasOwn(out, row._id)) out[/** @type {'queued'} */ (row._id)] = row.n;
			return out;
		},
	});
};
/** @typedef {ReturnType<typeof createJobs>} Jobs */

/**
 * @typedef {(ctx: { deadline: number, signal: AbortSignal, logger: Logger, trigger: string }) => Promise<Record<string, unknown> | void>} CronHandler
 */

/**
 * Cron runner: resolves a cron name to its handler, prevents overlapping runs with a lease lock and records every
 * invocation in the append-only `cron_runs` collection.
 * @param {{ crons: Record<string, CronHandler>, locks: Locks, runs: ReadOps, logger: Logger, deadlineMs: number,
 *   now?: () => number, randomBytes?: (n: number) => Uint8Array }} options
 */
export const createCronRunner = ({
	crons,
	locks,
	runs,
	logger,
	deadlineMs,
	now = Date.now,
	randomBytes = defaultRandomBytes,
}) => {
	for (const name of Object.keys(crons)) if (!NAME.test(name)) throw new TypeError(`invalid cron name: ${name}`);
	return Object.freeze({
		names: () => Object.keys(crons),
		/** @param {string} name */
		has: (name) => Object.hasOwn(crons, name),
		/**
		 * @param {string} name
		 * @param {{ trigger?: string }} [options]
		 * @returns {Promise<{ id: string, status: 'ok' | 'failed' | 'locked', stats?: Record<string, unknown> } | null>} null = unknown cron
		 */
		run: async (name, { trigger = 'cron' } = {}) => {
			if (!Object.hasOwn(crons, name)) return null;
			const handler = /** @type {CronHandler} */ (crons[name]);
			const id = createId('crn', { randomBytes });
			const startedAt = now();
			const log = logger.child({ cron: name, cronRunId: id });
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), deadlineMs);
			/** @type {'ok' | 'failed' | 'locked'} */
			let status = 'ok';
			/** @type {Record<string, unknown> | undefined} */
			let stats;
			/** @type {{ message: string, code?: string } | undefined} */
			let error;
			try {
				const outcome = await locks.withLock(`cron:${name}`, { ttlMs: deadlineMs + 30_000, owner: id }, async () =>
					handler({ deadline: startedAt + deadlineMs, signal: controller.signal, logger: log, trigger }),
				);
				if (outcome.locked) status = 'locked';
				else stats = outcome.value ?? undefined;
			} catch (cause) {
				status = 'failed';
				error = describeError(cause);
				log.error('cron failed', { error: cause });
			} finally {
				clearTimeout(timer);
			}
			await runs.insertOne({
				_id: id,
				name,
				trigger,
				status,
				startedAt: new Date(startedAt),
				finishedAt: new Date(now()),
				durationMs: now() - startedAt,
				...(stats ? { stats } : {}),
				...(error ? { error } : {}),
			});
			log.info('cron finished', { status, ms: now() - startedAt });
			return { id, status, ...(stats ? { stats } : {}) };
		},
	});
};
/** @typedef {ReturnType<typeof createCronRunner>} CronRunner */
