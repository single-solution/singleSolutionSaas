/**
 * The merchant ledger: append-only, hash-chained, integer millicredits, with a cached balance on the account.
 *
 * Appends run under a per-merchant lease lock (`commerce.ledger:<merchantId>`). The ledger is the source of truth and
 * the account (balance, seq, head hash) is a cache that is **rolled forward** from the ledger: an append first applies
 * any entries a crashed writer left beyond the account's `seq`, then inserts its entries (unique `merchantId+seq`,
 * `merchantId+entryKey`, global `periodKey`), then moves the account with one conditional `$inc`. A crash at any point
 * therefore never loses or double-counts money: the next append (or reconciliation) repairs the cache, and a retried
 * settlement finds its keys already present. The unique `seq` index keeps the chain linear even if a lease expired.
 * @module
 */
import { createId } from '@ss/contracts';
import { problem } from '../../../infra/http.js';
import { chainEntries, createChainVerifier, entryHash, genesisHash } from '../core/ledger.js';

/** @typedef {import('../../../infra/modules.js').ModuleContext} ModuleContext */
/** @typedef {import('../repo.js').CommerceRepo} CommerceRepo */
/** @typedef {import('../core/ledger.js').EntryDraft} EntryDraft */
/** @typedef {import('../core/ledger.js').LedgerEntry} LedgerEntry */
/** @typedef {{ seq: number, headHash: string, balance: number, missing?: boolean }} Account */

const LOCK_TTL_MS = 30_000;
const LOCK_WAIT_MS = 15_000;
const ATTEMPTS = 4;

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const retry = () => Object.assign(new Error('ledger append raced; retrying'), { code: 'ledger/retry' });
/** @param {unknown} error */
const isRetry = (error) => error instanceof Error && /** @type {any} */ (error).code === 'ledger/retry';

/**
 * @param {{ ctx: ModuleContext, repo: CommerceRepo, onChainBroken: (merchantId: string, message: string) => Promise<void> }} deps
 */
export const createLedger = ({ ctx, repo, onChainBroken }) => {
	/** @param {string} merchantId */
	const acquire = async (merchantId) => {
		const until = Date.now() + LOCK_WAIT_MS;
		for (;;) {
			const lock = await ctx.locks.acquire(`commerce.ledger:${merchantId}`, { ttlMs: LOCK_TTL_MS, owner: 'commerce.ledger' });
			if (lock) return lock;
			if (Date.now() > until)
				throw problem('unavailable', 'The ledger is busy; retry shortly.', { headers: { 'retry-after': '1' } });
			await sleep(3 + Math.floor(Math.random() * 15));
		}
	};

	/** @param {string} merchantId @returns {Promise<Account>} */
	const accountOf = async (merchantId) => {
		const doc = await repo.accountOps(merchantId).findOne({ merchantId, _id: merchantId });
		return doc
			? { seq: doc.seq, headHash: doc.headHash, balance: doc.balance }
			: { seq: 0, headHash: genesisHash(merchantId), balance: 0, missing: true };
	};

	/**
	 * Move the cached account from `from` to `to` (conditional on `from.seq`).
	 * @param {string} merchantId @param {Account} from @param {{ seq: number, headHash: string, balance: number }} to
	 */
	const saveAccount = async (merchantId, from, to) => {
		const ops = repo.accountOps(merchantId);
		if (from.missing) {
			try {
				await ops.insertOne({ _id: merchantId, seq: to.seq, headHash: to.headHash, balance: to.balance });
			} catch (error) {
				if (repo.isDuplicateKey(error)) throw retry();
				throw error;
			}
			return;
		}
		const res = await ops.updateOne(
			{ merchantId, _id: merchantId, seq: from.seq },
			{ $set: { seq: to.seq, headHash: to.headHash }, $inc: { balance: to.balance - from.balance } },
		);
		if (res.matchedCount !== 1) throw retry();
	};

	/** @param {string} merchantId @param {Account} account @returns {Promise<Doc[]>} */
	const pendingOf = (merchantId, account) =>
		repo
			.ledgerOf(merchantId)
			.find({ merchantId, seq: { $gt: account.seq } })
			.sort({ seq: 1 })
			.toArray();

	/**
	 * Apply ledger entries beyond the account (left by a crashed writer). Throws when they do not chain.
	 * @param {string} merchantId @param {Account} account @returns {Promise<Account>}
	 */
	const rollForward = async (merchantId, account) => {
		const pending = await pendingOf(merchantId, account);
		if (pending.length === 0) return account;
		let { seq, headHash, balance } = account;
		for (const entry of pending) {
			if (entry.seq !== seq + 1 || entry.prevHash !== headHash || entryHash(entry.prevHash, entry) !== entry.hash) {
				const message = `ledger chain broken at seq ${entry.seq}`;
				await onChainBroken(merchantId, message);
				throw problem('internal_error', 'The merchant ledger failed verification.');
			}
			seq = entry.seq;
			headHash = entry.hash;
			balance += entry.amount;
		}
		const next = { seq, headHash, balance };
		await saveAccount(merchantId, account, next);
		return next;
	};

	/**
	 * Append drafts. Drafts whose `entryKey` already exists are skipped (idempotent). `guard(account)` runs under the
	 * lock after roll-forward and may throw a problem (e.g. a refund larger than the balance).
	 * @param {string} merchantId
	 * @param {readonly EntryDraft[]} drafts
	 * @param {{ guard?: (account: Account) => void }} [options]
	 * @returns {Promise<{ appended: LedgerEntry[], duplicates: string[], balance: number }>}
	 */
	const append = async (merchantId, drafts, { guard } = {}) => {
		for (let attempt = 1; ; attempt += 1) {
			const lock = await acquire(merchantId);
			try {
				const account = await rollForward(merchantId, await accountOf(merchantId));
				guard?.(account);
				const keys = [...new Set(drafts.map((d) => d.entryKey))];
				const existing = new Set(
					(
						await repo
							.ledgerOf(merchantId)
							.find({ merchantId, entryKey: { $in: keys } }, { projection: { entryKey: 1 } })
							.toArray()
					).map((e) => String(e.entryKey)),
				);
				/** @type {Set<string>} */
				const seen = new Set();
				/** @type {string[]} */
				const duplicates = [];
				/** @type {EntryDraft[]} */
				const fresh = [];
				for (const draft of drafts) {
					if (existing.has(draft.entryKey) || seen.has(draft.entryKey)) duplicates.push(draft.entryKey);
					else {
						seen.add(draft.entryKey);
						fresh.push(draft);
					}
				}
				if (fresh.length === 0) return { appended: [], duplicates, balance: account.balance };
				const entries = chainEntries({
					merchantId,
					head: { seq: account.seq, hash: account.headHash },
					drafts: fresh,
					at: new Date(ctx.now()),
					ids: () => createId('led', { randomBytes: ctx.randomBytes }),
				});
				/** @type {LedgerEntry[]} */
				const written = [];
				for (const entry of entries) {
					try {
						await repo.ledgerOf(merchantId).insertOne(entry);
						written.push(entry);
					} catch (error) {
						if (!repo.isDuplicateKey(error)) throw error;
						// a concurrent writer took this seq or key: keep what we wrote (it chains) and retry the rest
						if (written.length > 0) await rollForward(merchantId, account).catch(() => undefined);
						throw retry();
					}
				}
				const last = /** @type {LedgerEntry} */ (written[written.length - 1]);
				const delta = written.reduce((sum, e) => sum + e.amount, 0);
				await saveAccount(merchantId, account, { seq: last.seq, headHash: last.hash, balance: account.balance + delta });
				return { appended: written, duplicates, balance: account.balance + delta };
			} catch (error) {
				if (!isRetry(error) || attempt >= ATTEMPTS)
					throw isRetry(error) ? problem('conflict', 'Ledger contention; retry.') : error;
			} finally {
				await lock.release();
			}
		}
	};

	/**
	 * Current balance: the cached account plus any entries not yet rolled into it (no lock needed).
	 * @param {string} merchantId
	 * @returns {Promise<number>}
	 */
	const balance = async (merchantId) => {
		const account = await accountOf(merchantId);
		const pending = await pendingOf(merchantId, account);
		return account.balance + pending.reduce((sum, e) => sum + e.amount, 0);
	};

	/**
	 * Verify the full chain and the cached account (after repairing a crashed append when the chain allows it).
	 * @param {string} merchantId
	 */
	const verify = async (merchantId) => {
		const lock = await acquire(merchantId);
		try {
			let account = await accountOf(merchantId);
			try {
				account = await rollForward(merchantId, account);
			} catch {
				// reported below by the full verification
			}
			const verifier = createChainVerifier(merchantId);
			const cursor = repo.ledgerOf(merchantId).find({ merchantId }).sort({ seq: 1 });
			for await (const entry of cursor) verifier.push(entry);
			return {
				merchantId,
				...verifier.finish(account.missing ? { seq: 0, headHash: genesisHash(merchantId), balance: 0 } : account),
			};
		} finally {
			await lock.release();
		}
	};

	/**
	 * Entries of a merchant (ascending `at`), optionally for one website, in `[from, to)`.
	 * @param {string} merchantId
	 * @param {{ from?: number | null, to?: number | null, websiteId?: string | null, types?: readonly string[] | null,
	 *   afterSeq?: number | null, limit?: number }} [query]
	 * @returns {Promise<Doc[]>}
	 */
	const entries = (
		merchantId,
		{ from = null, to = null, websiteId = null, types = null, afterSeq = null, limit = 1000 } = {},
	) => {
		/** @type {Record<string, any>} */
		const filter = { merchantId };
		if (from !== null || to !== null)
			filter.at = { ...(from !== null ? { $gte: new Date(from) } : {}), ...(to !== null ? { $lt: new Date(to) } : {}) };
		if (websiteId) filter.websiteId = websiteId;
		if (types) filter.type = { $in: [...types] };
		if (afterSeq !== null) filter.seq = { $gt: afterSeq };
		return repo.ledgerOf(merchantId).find(filter).sort({ seq: 1 }).limit(limit).toArray();
	};

	/**
	 * Σ amounts of matching entries.
	 * @param {string} merchantId
	 * @param {Record<string, any>} match extra filter (merchantId is added)
	 * @returns {Promise<number>}
	 */
	const sum = async (merchantId, match) => {
		const rows = await repo
			.ledgerOf(merchantId)
			.aggregate([{ $match: { merchantId, ...match } }, { $group: { _id: null, total: { $sum: '$amount' } } }])
			.toArray();
		return Number(rows[0]?.total ?? 0);
	};

	/** @param {string} merchantId @param {string} entryKey @returns {Promise<Doc | null>} */
	const byKey = (merchantId, entryKey) => repo.ledgerOf(merchantId).findOne({ merchantId, entryKey });

	return Object.freeze({ append, balance, verify, entries, sum, accountOf, byKey });
};
/** @typedef {Record<string, any>} Doc */
/** @typedef {ReturnType<typeof createLedger>} Ledger */
