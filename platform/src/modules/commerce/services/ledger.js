/**
 * The merchant ledger: append-only, hash-chained, integer millicredits, with a cached balance on the account.
 *
 * Appends run under a per-merchant lease lock (`commerce.ledger:<merchantId>`) and, inside it, in **one database
 * transaction** (`ctx.withTransaction`): the entries (unique `merchantId+seq` and `merchantId+entryKey`) and the account's conditional `$inc` commit together or not at all. The ledger stays the source of
 * truth and the account (balance, seq, head hash) a cache: an append still first **rolls forward** any entries
 * beyond the account's `seq` (left by a crash or by a writer outside this path), so the cache can always be repaired from the chain. A repeated check finds its day keys already present;
 * the unique `seq` index keeps the chain linear even if a lease expired.
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

	/** @param {string} merchantId @param {Session} [session] @returns {Promise<Account>} */
	const accountOf = async (merchantId, session) => {
		const doc = await repo.accountOps(merchantId).findOne({ merchantId, _id: merchantId }, session ? { session } : {});
		return doc
			? { seq: doc.seq, headHash: doc.headHash, balance: doc.balance }
			: { seq: 0, headHash: genesisHash(merchantId), balance: 0, missing: true };
	};

	/**
	 * Move the cached account from `from` to `to` (conditional on `from.seq`).
	 * @param {string} merchantId @param {Account} from @param {{ seq: number, headHash: string, balance: number }} to
	 * @param {Session} [session]
	 */
	const saveAccount = async (merchantId, from, to, session) => {
		const ops = repo.accountOps(merchantId);
		const opts = session ? { session } : {};
		if (from.missing) {
			try {
				await ops.insertOne({ _id: merchantId, seq: to.seq, headHash: to.headHash, balance: to.balance }, opts);
			} catch (error) {
				if (repo.isDuplicateKey(error)) throw retry();
				throw error;
			}
			return;
		}
		const res = await ops.updateOne(
			{ merchantId, _id: merchantId, seq: from.seq },
			{ $set: { seq: to.seq, headHash: to.headHash }, $inc: { balance: to.balance - from.balance } },
			opts,
		);
		if (res.matchedCount !== 1) throw retry();
	};

	/** @param {string} merchantId @param {Account} account @param {Session} [session] @returns {Promise<Doc[]>} */
	const pendingOf = (merchantId, account, session) =>
		repo
			.ledgerOf(merchantId)
			.find({ merchantId, seq: { $gt: account.seq } }, session ? { session } : {})
			.sort({ seq: 1 })
			.toArray();

	/**
	 * Apply ledger entries beyond the account (left by a crashed writer). Throws when they do not chain.
	 * @param {string} merchantId @param {Account} account @param {Session} [session] @returns {Promise<Account>}
	 */
	const rollForward = async (merchantId, account, session) => {
		const pending = await pendingOf(merchantId, account, session);
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
		await saveAccount(merchantId, account, next, session);
		return next;
	};

	/**
	 * Append drafts. Drafts whose `entryKey` already exists are skipped (idempotent).
	 * @param {string} merchantId
	 * @param {readonly EntryDraft[]} drafts
	 * @returns {Promise<{ appended: LedgerEntry[], duplicates: string[], balance: number }>}
	 */
	const append = async (merchantId, drafts) => {
		for (let attempt = 1; ; attempt += 1) {
			const lock = await acquire(merchantId);
			try {
				// entries and the account move commit together (one transaction under the lock)
				return await ctx.withTransaction(async (session) => {
					const opts = { session };
					const account = await rollForward(merchantId, await accountOf(merchantId, session), session);
					const keys = [...new Set(drafts.map((d) => d.entryKey))];
					const existing = new Set(
						(
							await repo
								.ledgerOf(merchantId)
								.find({ merchantId, entryKey: { $in: keys } }, { projection: { entryKey: 1 }, session })
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
					try {
						for (const entry of entries) await repo.ledgerOf(merchantId).insertOne(entry, opts);
					} catch (error) {
						// a concurrent writer took this seq or key: the transaction aborts, retry from the new head
						if (repo.isDuplicateKey(error)) throw retry();
						throw error;
					}
					const delta = entries.reduce((sum, e) => sum + e.amount, 0);
					const last = /** @type {LedgerEntry} */ (entries[entries.length - 1]);
					await saveAccount(
						merchantId,
						account,
						{ seq: last.seq, headHash: last.hash, balance: account.balance + delta },
						session,
					);
					return { appended: entries, duplicates, balance: account.balance + delta };
				});
			} catch (error) {
				if (!isRetry(error) || attempt >= ATTEMPTS)
					throw isRetry(error) ? problem('conflict', 'Ledger contention; retry.') : error;
			} finally {
				await lock.release();
			}
		}
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

	return Object.freeze({ append, verify, sum });
};
/** @typedef {Record<string, any>} Doc */
/** @typedef {import('mongodb').ClientSession} Session */
/** @typedef {ReturnType<typeof createLedger>} Ledger */
