/**
 * Append-only audit log (`platform_audit`, PLAN §11 "audit immutability"). The repository is append-only, so no
 * code path in the Portal can update or delete an entry; retention is governed by backups, not by TTL.
 *
 * Every entry records who (`actor`, including the staff member behind an impersonation), what (`action`, `target`),
 * the change (`before`/`after`, redacted with the logger rules so credentials never land in the log), and where
 * from (`requestId`, `ip`). `merchantId` is denormalised so merchant consoles can list their own history.
 *
 * **Hash chain.** Entries form one chain per scope — `global` for entries without a merchant (staff/platform
 * actions) and `merchant:<merchantId>` for each merchant — so a merchant's history verifies on its own. Each entry
 * carries `scope`, `seq` (1, 2, …), `prevHash` (the previous entry's `hash`, or the scope's genesis hash) and
 * `hash = sha256(prevHash ‖ "\n" ‖ canonical JSON of the entry without hash)`. Appends run under a per-scope lease
 * lock and the unique `{ scope, seq }` index keeps the chain linear even if a lease expired. `verifyChain(scope)`
 * recomputes a scope (admin operation `audit_verify`, on demand); an edited, deleted or reordered entry breaks it.
 * @module
 */
import { createId } from '@ss/contracts';
import { platformError } from './errors.js';
import { redact } from './logger.js';
import { defaultRandomBytes, isDuplicateKey, isObject, sha256Hex, stableJson } from './util.js';

/** @typedef {import('./db.js').ReadOps} ReadOps */
/** @typedef {import('./db.js').Locks} Locks */
/** @typedef {import('./logger.js').Logger} Logger */
/** @typedef {import('./rbac.js').Actor} Actor */

export const AUDIT_ACTOR_TYPES = Object.freeze(['staff', 'merchant_user', 'product', 'system']);

/**
 * @typedef {object} AuditInput
 * @property {{ type: 'staff' | 'merchant_user' | 'product' | 'system', id: string, via?: { type: 'staff', id: string } | null } | Actor} actor
 * @property {string} action dotted verb, e.g. `website.created`, `credits.adjusted`
 * @property {{ type: string, id: string, merchantId?: string | null, websiteId?: string | null }} target
 * @property {unknown} [before]
 * @property {unknown} [after]
 * @property {string | null} [requestId]
 * @property {string | null} [ip]
 * @property {string | null} [reason] free-text justification (required by some staff actions)
 */

const ACTION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/**
 * @param {unknown} actor
 * @returns {{ type: string, id: string, via: { type: 'staff', id: string } | null }}
 */
const normaliseActor = (actor) => {
	if (!isObject(actor) || typeof actor.id !== 'string' || actor.id.length === 0)
		throw platformError('invalid_argument', 'audit actor needs an id');
	// website-key actors are recorded as the product/system boundary they crossed: callers map them first
	if (!AUDIT_ACTOR_TYPES.includes(String(actor.type)))
		throw platformError('invalid_argument', `audit actor type must be one of ${AUDIT_ACTOR_TYPES.join(', ')}`);
	const via =
		isObject(actor.via) && typeof actor.via.id === 'string'
			? { type: /** @type {'staff'} */ ('staff'), id: actor.via.id }
			: null;
	return { type: String(actor.type), id: actor.id, via };
};

/** Global (non-merchant) audit scope. */
export const GLOBAL_SCOPE = 'global';

/**
 * Chain scope of an entry.
 * @param {string | null | undefined} merchantId
 */
export const auditScopeOf = (merchantId) => (merchantId ? `merchant:${merchantId}` : GLOBAL_SCOPE);

/** @param {string} scope */
export const genesisHashOf = (scope) => sha256Hex(`ss-audit.v1|genesis|${scope}`);

/**
 * JSON-normalised value (what MongoDB stores and returns unchanged): `undefined` members dropped, Dates as ISO.
 * @param {unknown} value
 */
const jsonValue = (value) => {
	const text = JSON.stringify(value);
	return text === undefined ? null : JSON.parse(text);
};

/**
 * Hash of an entry as stored (any `hash` member is ignored; `at` is hashed as ISO-8601).
 * @param {Record<string, any>} entry
 * @returns {string}
 */
export const auditEntryHash = (entry) => {
	const rest = { ...entry };
	delete rest.hash;
	const at = rest.at instanceof Date ? rest.at.toISOString() : rest.at;
	return sha256Hex(`${rest.prevHash}\n${stableJson({ ...rest, at })}`);
};

/**
 * @typedef {object} ChainReport
 * @property {string} scope
 * @property {boolean} ok
 * @property {number} entries entries checked
 * @property {number} seq last verified sequence number
 * @property {string} headHash hash of the last verified entry (genesis when empty)
 * @property {{ seq: number, id: string, reason: 'seq_gap' | 'prev_hash' | 'hash' } | null} broken first broken link
 */

/**
 * @param {{ repo: ReadOps, locks: Locks, now?: () => number, randomBytes?: (n: number) => Uint8Array,
 *   logger?: Logger, lockTtlMs?: number, lockWaitMs?: number, attempts?: number }} options
 */
export const createAudit = ({
	repo,
	locks,
	now = Date.now,
	randomBytes = defaultRandomBytes,
	logger,
	lockTtlMs = 10_000,
	lockWaitMs = 10_000,
	attempts = 4,
}) => {
	/**
	 * Acquire the scope lock, waiting briefly for the current holder.
	 * @param {string} scope
	 */
	const acquire = async (scope) => {
		const until = Date.now() + lockWaitMs;
		for (;;) {
			const lock = await locks.acquire(`audit:${scope}`, { ttlMs: lockTtlMs, owner: 'audit' });
			if (lock) return lock;
			if (Date.now() > until) throw platformError('locked', `audit scope ${scope} is busy`);
			await new Promise((resolve) => setTimeout(resolve, 2 + Math.floor(Math.random() * 10)));
		}
	};

	/** @param {string} scope */
	const headOf = async (scope) => {
		const last = await repo.findOne({ scope }, { sort: { seq: -1 }, projection: { seq: 1, hash: 1 } });
		return last ? { seq: Number(last.seq), hash: String(last.hash) } : { seq: 0, hash: genesisHashOf(scope) };
	};

	/**
	 * @param {AuditInput} input
	 * @returns {Promise<string>} the entry id
	 */
	const record = async ({ actor, action, target, before, after, requestId = null, ip = null, reason = null }) => {
		if (typeof action !== 'string' || !ACTION.test(action))
			throw platformError('invalid_argument', 'audit action must be a dotted lower-case verb');
		if (!isObject(target) || typeof target.type !== 'string' || typeof target.id !== 'string') {
			throw platformError('invalid_argument', 'audit target needs a type and an id');
		}
		const id = createId('aud', { randomBytes });
		const merchantId = target.merchantId ?? null;
		const scope = auditScopeOf(merchantId);
		const body = {
			_id: id,
			at: new Date(now()),
			actor: normaliseActor(actor),
			action,
			target: { type: target.type, id: target.id, websiteId: target.websiteId ?? null },
			merchantId,
			...(before === undefined ? {} : { before: jsonValue(redact(before)) }),
			...(after === undefined ? {} : { after: jsonValue(redact(after)) }),
			requestId,
			ip,
			reason,
		};
		for (let attempt = 1; ; attempt += 1) {
			const lock = await acquire(scope);
			try {
				const head = await headOf(scope);
				const entry = { ...body, scope, seq: head.seq + 1, prevHash: head.hash };
				await repo.insertOne({ ...entry, hash: auditEntryHash(entry) });
				return id;
			} catch (error) {
				// a writer whose lease expired took this seq: re-read the head and chain after it
				if (!isDuplicateKey(error) || attempt >= attempts) throw error;
			} finally {
				await lock.release();
			}
		}
	};

	/**
	 * Recompute the chain of a scope from its genesis.
	 * @param {string} scope
	 * @param {{ signal?: AbortSignal }} [options]
	 * @returns {Promise<ChainReport>}
	 */
	const verifyChain = async (scope, { signal } = {}) => {
		let seq = 0;
		let headHash = genesisHashOf(scope);
		let entries = 0;
		const cursor = repo.find({ scope }).sort({ seq: 1 });
		try {
			for await (const doc of cursor) {
				if (signal?.aborted) throw platformError('aborted', 'audit verification was aborted');
				/** @type {ChainReport['broken']} */
				let broken = null;
				if (doc.seq !== seq + 1) broken = { seq: seq + 1, id: String(doc._id), reason: 'seq_gap' };
				else if (doc.prevHash !== headHash) broken = { seq: doc.seq, id: String(doc._id), reason: 'prev_hash' };
				else if (auditEntryHash(doc) !== doc.hash) broken = { seq: doc.seq, id: String(doc._id), reason: 'hash' };
				if (broken) return { scope, ok: false, entries, seq, headHash, broken };
				entries += 1;
				seq = doc.seq;
				headHash = doc.hash;
			}
		} finally {
			await cursor.close();
		}
		return { scope, ok: true, entries, seq, headHash, broken: null };
	};

	/**
	 * Verify every scope in order, from the first scope after `after` (a pass cut by its deadline resumes there).
	 * Broken chains are logged as errors; scopes not reached before the deadline are reported as `skipped`, and
	 * `resumeAfter` is the last scope verified then (null when the pass completed).
	 * @param {{ deadline?: number, signal?: AbortSignal, after?: string | null }} [options]
	 */
	const verifyAll = async ({ deadline = Number.POSITIVE_INFINITY, signal, after = null } = {}) => {
		const scopes = (await repo.aggregate([{ $group: { _id: '$scope' } }, { $sort: { _id: 1 } }]).toArray())
			.map((row) => row._id)
			.filter((scope) => typeof scope === 'string' && (after === null || scope > after));
		/** @type {ChainReport[]} */
		const broken = [];
		let verified = 0;
		let entries = 0;
		let skipped = 0;
		/** @type {string | null} */
		let last = after;
		for (const scope of scopes) {
			if (now() >= deadline || signal?.aborted) {
				skipped += 1;
				continue;
			}
			const report = await verifyChain(scope, signal ? { signal } : {});
			verified += 1;
			entries += report.entries;
			last = scope;
			if (!report.ok) {
				broken.push(report);
				logger?.error('audit chain broken', { scope, broken: report.broken });
			}
		}
		return {
			scopes: scopes.length,
			verified,
			skipped,
			entries,
			broken: broken.map((r) => ({ scope: r.scope, ...r.broken })),
			resumeAfter: skipped > 0 ? last : null,
		};
	};

	/**
	 * Newest-first entries. `before` is the `{ at, id }` of the last entry of the previous page (keyset pagination
	 * over the `{ at: -1, _id: -1 }` order).
	 * `scope` filters one chain; `action` is an exact action or a dotted prefix ending in `.*` (`credits.*`).
	 * @param {{ merchantId?: string | null, scope?: string, action?: string, targetId?: string, actorId?: string,
	 *   before?: { at: Date | number, id: string } | null, limit?: number }} [query]
	 */
	const list = async ({ merchantId, scope, action, targetId, actorId, before = null, limit = 50 } = {}) => {
		/** @type {Record<string, unknown>} */
		const filter = {};
		if (merchantId !== undefined) filter.merchantId = merchantId;
		if (scope) filter.scope = scope;
		if (action)
			filter.action = action.endsWith('.*')
				? { $regex: `^${action.slice(0, -2).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.` }
				: action;
		if (targetId) filter['target.id'] = targetId;
		if (actorId) filter['actor.id'] = actorId;
		if (before) {
			const at = new Date(before.at);
			filter.$or = [{ at: { $lt: at } }, { at, _id: { $lt: before.id } }];
		}
		const n = Math.min(Math.max(1, Math.floor(limit)), 200);
		return repo.find(filter).sort({ at: -1, _id: -1 }).limit(n).toArray();
	};

	return Object.freeze({ record, list, verifyChain, verifyAuditChain: verifyChain, verifyAll });
};
/** @typedef {ReturnType<typeof createAudit>} Audit */
