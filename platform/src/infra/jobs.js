/**
 * Database-backed job queue (PLAN F.19: event-driven only — no crons, no worker processes, no timers, no periodic
 * drains).
 *
 * A job runs right after the request that enqueued it (`onEnqueued` hands it to the request scope, which runs exactly
 * that job after the response). A job that fails stays queued with its next-attempt time (`runAt`) and is retried
 * when there is a natural reason: the module that owns it runs its due jobs of the same `group` when that group is
 * touched again (e.g. the Event Hub retries a product's due deliveries when an event is delivered to that product or
 * the product calls the Portal), or staff make them due now (`makeDue`, e.g. "Retry deliveries now").
 *
 * Queue semantics (`platform_jobs`):
 * - `enqueue` is idempotent on an optional job `key` (unique while the job document exists: done jobs are kept for
 *   `doneRetentionMs`, failed ones for `failedRetentionMs`, then removed by TTL); `group` tags jobs that are retried
 *   together (`runBatch({ groups })`).
 * - `lease` atomically claims one due job (`queued` with `runAt ≤ now`, or `running` whose lease expired — the
 *   worker died) and gives it a visibility timeout; every lease counts an attempt.
 * - `complete` / `fail` only act while the caller still holds the lease (`leaseToken`), so a slow worker whose
 *   lease was taken over cannot overwrite the new owner's outcome. `complete(job, { dropPayload: true })` unsets the
 *   payload of the done record (jobs enqueued with `dropPayload: true` are completed that way by `runBatch`), so
 *   payloads that must not outlive their delivery are gone as soon as the job succeeds.
 * - failures retry with exponential backoff and jitter (5 s · 2^(attempt-1), capped at 1 h) until `maxAttempts`,
 *   then the job stops as `failed` with its `lastError`; `permanentFailure()` stops it at once.
 * @module
 */
import { createId } from '@ss/contracts';
import { platformError } from './errors.js';
import { defaultRandomBytes, isDuplicateKey, isObject, randomToken } from './util.js';

/** @typedef {import('./db.js').MutableOps} MutableOps */
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
 * An error that fails the job without further retries (e.g. invalid payload).
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
 *   logger: Logger, doneRetentionMs?: number, failedRetentionMs?: number, defaultMaxAttempts?: number,
 *   onEnqueued?: (job: { id: string, name: string }) => void }} options `onEnqueued`: a new job that is due now was
 *   stored (the composition root runs it after the current request's response)
 */
export const createJobs = ({
	repo,
	now = Date.now,
	randomBytes = defaultRandomBytes,
	random = Math.random,
	logger,
	doneRetentionMs = 7 * 24 * 60 * 60_000,
	failedRetentionMs = 30 * 24 * 60 * 60_000,
	defaultMaxAttempts = 8,
	onEnqueued,
}) => {
	/**
	 * Enqueue a job. With a `key`, enqueueing the same key again returns the existing job (`inserted: false`).
	 * `dropPayload: true` removes the payload once the job succeeds; `group` tags jobs retried together. A new job that
	 * is due now is handed to `onEnqueued` (run after the current request).
	 * @param {{ name: string, payload?: unknown, key?: string, runAt?: Date | number, maxAttempts?: number,
	 *   dropPayload?: boolean, group?: string }} input
	 * @returns {Promise<{ id: string, inserted: boolean }>}
	 */
	const enqueue = async ({ name, payload = null, key, runAt, maxAttempts = defaultMaxAttempts, dropPayload = false, group }) => {
		if (typeof name !== 'string' || !NAME.test(name)) throw platformError('invalid_argument', `invalid job name: ${name}`);
		if (key !== undefined && (typeof key !== 'string' || key.length === 0 || key.length > 256))
			throw platformError('invalid_argument', 'job key must be 1..256 chars');
		if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100)
			throw platformError('invalid_argument', 'maxAttempts must be 1..100');
		if (group !== undefined && (typeof group !== 'string' || group.length === 0 || group.length > 256))
			throw platformError('invalid_argument', 'job group must be 1..256 chars');
		const t = new Date(now());
		const id = createId('job', { randomBytes });
		try {
			await repo.insertOne({
				_id: id,
				name,
				...(key === undefined ? {} : { key }),
				payload,
				...(dropPayload ? { dropPayload: true } : {}),
				...(group === undefined ? {} : { group }),
				status: 'queued',
				attempts: 0,
				maxAttempts,
				runAt: runAt === undefined ? t : new Date(runAt),
				createdAt: t,
				updatedAt: t,
			});
			if (onEnqueued && (runAt === undefined || new Date(runAt).getTime() <= t.getTime())) onEnqueued({ id, name });
			return { id, inserted: true };
		} catch (error) {
			if (!isDuplicateKey(error) || key === undefined) throw error;
			const existing = await repo.findOne({ key }, { projection: { _id: 1 } });
			if (!existing) throw error;
			return { id: String(existing._id), inserted: false };
		}
	};

	/**
	 * Mark a job failed (no more attempts).
	 * @param {string} id
	 * @param {string | null} leaseToken
	 * @param {{ message: string, code?: string }} error
	 */
	const markFailed = async (id, leaseToken, error) => {
		const t = now();
		const result = await repo.updateOne(
			{ _id: id, ...(leaseToken ? { leaseToken } : {}) },
			{
				$set: {
					status: 'failed',
					lastError: error,
					finishedAt: new Date(t),
					updatedAt: new Date(t),
					expireAt: new Date(t + failedRetentionMs),
				},
				$unset: { leaseToken: '', leaseUntil: '' },
			},
		);
		logger.warn('job failed permanently', { jobId: id, error });
		return result.modifiedCount === 1;
	};

	/**
	 * Claim one due job (`ids` / `keys` / `groups`: only those jobs).
	 * @param {{ names?: string[], ids?: string[], keys?: string[], groups?: string[], leaseMs: number, owner?: string }} options
	 * @returns {Promise<Job | null>}
	 */
	const lease = async ({ names, ids, keys, groups, leaseMs, owner = 'worker' }) => {
		for (;;) {
			const t = new Date(now());
			const doc = await repo.findOneAndUpdate(
				{
					$or: [
						{ status: 'queued', runAt: { $lte: t } },
						{ status: 'running', leaseUntil: { $lte: t } },
					],
					...(names ? { name: { $in: names } } : {}),
					...(ids ? { _id: { $in: ids } } : {}),
					...(keys ? { key: { $in: keys } } : {}),
					...(groups ? { group: { $in: groups } } : {}),
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
				await markFailed(String(doc._id), doc.leaseToken, {
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
	 * @returns {Promise<'retry' | 'failed' | 'lost'>}
	 */
	const fail = async (job, error) => {
		const described = describeError(error);
		const permanent = isObject(error) && /** @type {any} */ (error)[PERMANENT] === true;
		if (permanent || job.attempts >= job.maxAttempts)
			return (await markFailed(job.id, job.leaseToken, described)) ? 'failed' : 'lost';
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
	 * Run due jobs until none is left, `maxJobs` were leased or the deadline approaches. Jobs without a handler are not
	 * leased; `ids` / `keys` / `groups` limit the batch (e.g. the job a request just enqueued, or one product's due
	 * deliveries).
	 * @param {{ handlers: Record<string, JobHandler>, deadlineMs: number, owner?: string, concurrency?: number,
	 *   safetyMs?: number, maxJobs?: number, ids?: string[], keys?: string[], groups?: string[] }} options
	 */
	const runBatch = async ({
		handlers,
		deadlineMs,
		owner = 'operation',
		concurrency = 1,
		safetyMs = 2_000,
		maxJobs = Number.POSITIVE_INFINITY,
		ids,
		keys,
		groups,
	}) => {
		const names = Object.keys(handlers);
		const deadline = now() + deadlineMs;
		const stats = {
			leased: 0,
			succeeded: 0,
			retried: 0,
			failed: 0,
			lost: 0,
			stoppedBy: /** @type {'empty' | 'deadline' | 'limit'} */ ('empty'),
		};
		if (names.length === 0 || ids?.length === 0 || keys?.length === 0 || groups?.length === 0) return stats;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), Math.max(0, deadlineMs - safetyMs));
		let claimed = 0;
		const worker = async () => {
			for (;;) {
				if (now() >= deadline - safetyMs) {
					stats.stoppedBy = 'deadline';
					return;
				}
				if (claimed >= maxJobs) {
					stats.stoppedBy = 'limit';
					return;
				}
				claimed += 1;
				const job = await lease({ names, ids, keys, groups, owner, leaseMs: Math.max(deadline - now(), 0) + 30_000 });
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
					else if (outcome === 'failed') stats.failed += 1;
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
		 * Make queued jobs that wait for their retry time due now (staff "Retry now"), oldest first, bounded.
		 * @param {{ name?: string, group?: string, limit?: number }} [filter]
		 * @returns {Promise<number>} jobs made due
		 */
		makeDue: async ({ name, group, limit = 100 } = {}) => {
			const t = new Date(now());
			const filter = { status: 'queued', runAt: { $gt: t }, ...(name ? { name } : {}), ...(group ? { group } : {}) };
			const waiting = await repo
				.find(filter, { projection: { _id: 1 } })
				.sort({ runAt: 1 })
				.limit(Math.min(Math.max(1, limit), 1000))
				.toArray();
			if (waiting.length === 0) return 0;
			const result = await repo.updateMany(
				{ ...filter, _id: { $in: waiting.map((doc) => doc._id) } },
				{ $set: { runAt: t, updatedAt: t } },
			);
			return result.modifiedCount;
		},
	});
};
/** @typedef {ReturnType<typeof createJobs>} Jobs */
