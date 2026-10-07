/**
 * Ledger chain (pure). Every merchant has one append-only ledger of integer-millicredit entries. Entries are numbered
 * `seq = 1, 2, …` per merchant and hash-chained: `hash = sha256(prevHash + canonical(entry))`, where the first entry
 * links to the merchant's genesis hash. Any edit, deletion, insertion or reordering of a stored entry breaks the chain
 * and is reported by {@link verifyChain}.
 *
 * Amounts are signed: credits (deposits, positive adjustments) are positive, charges (settlement, metered, refunds of
 * credits back to the merchant's bank) are negative. The balance is the sum of all amounts.
 * @module
 */
import { sha256Hex, stableStringify } from '@ss/entitlements';

export const LEDGER_TYPES = Object.freeze(/** @type {const} */ (['deposit', 'settlement', 'metered', 'adjustment', 'refund']));
/** @typedef {typeof LEDGER_TYPES[number]} LedgerType */

/** Charge types (spend): what settlement writes. */
export const CHARGE_TYPES = Object.freeze(/** @type {const} */ (['settlement', 'metered']));

/**
 * @typedef {object} LedgerActor
 * @property {string} type
 * @property {string} id
 */

/**
 * An entry before it is chained (what callers append).
 * @typedef {object} EntryDraft
 * @property {LedgerType} type
 * @property {number} amount signed integer millicredits
 * @property {string} entryKey unique per merchant (periodKey for settlements, `<type>:<reference>` for staff entries)
 * @property {string | null} [periodKey]
 * @property {Date | null} [periodStart] bucket start (settlement/metered)
 * @property {string | null} [subscriptionId]
 * @property {string | null} [websiteId]
 * @property {string | null} [appId]
 * @property {string | null} [reference]
 * @property {string | null} [note]
 * @property {LedgerActor | null} [actor]
 * @property {unknown} [details] breakdown lines, metered lines … (JSON)
 */

/**
 * A chained entry as stored.
 * @typedef {Required<Omit<EntryDraft, 'details'>> & { details: unknown, _id: string, merchantId: string, seq: number,
 *   at: Date, prevHash: string, hash: string }} LedgerEntry
 */

/**
 * Genesis hash of a merchant's chain.
 * @param {string} merchantId
 * @returns {string}
 */
export const genesisHash = (merchantId) => sha256Hex(`ss-ledger-genesis\u0000${merchantId}`);

/**
 * @param {unknown} value
 * @returns {string | null}
 */
const iso = (value) => {
	if (value === null || value === undefined) return null;
	const date = value instanceof Date ? value : new Date(/** @type {string | number} */ (value));
	return date.toISOString();
};

/**
 * @param {LedgerActor | null | undefined} actor
 * @returns {LedgerActor | null}
 */
export const ledgerActor = (actor) => (actor ? { type: actor.type, id: actor.id } : null);

/**
 * The canonical form hashed for an entry: every field that carries meaning, with absent fields as `null`, instants
 * as ISO strings and objects with sorted keys. Storage metadata (`_id`, `createdAt`, `hash`) is excluded.
 * @param {Record<string, any>} entry
 * @returns {string}
 */
export const canonicalEntry = (entry) =>
	stableStringify({
		merchantId: entry.merchantId,
		seq: entry.seq,
		type: entry.type,
		amount: entry.amount,
		entryKey: entry.entryKey,
		periodKey: entry.periodKey ?? null,
		periodStart: iso(entry.periodStart),
		subscriptionId: entry.subscriptionId ?? null,
		websiteId: entry.websiteId ?? null,
		appId: entry.appId ?? null,
		reference: entry.reference ?? null,
		note: entry.note ?? null,
		actor: ledgerActor(entry.actor),
		at: iso(entry.at),
		details: entry.details ?? null,
		prevHash: entry.prevHash,
	});

/**
 * @param {string} prevHash
 * @param {Record<string, any>} entry
 * @returns {string}
 */
export const entryHash = (prevHash, entry) => sha256Hex(`${prevHash}${canonicalEntry({ ...entry, prevHash })}`);

/**
 * Validate a draft (types, integer amounts, keys).
 * @param {EntryDraft} draft
 * @returns {string | null} problem description, or null when valid
 */
export const draftProblem = (draft) => {
	if (!LEDGER_TYPES.includes(draft.type)) return `unknown ledger type ${String(draft.type)}`;
	if (!Number.isSafeInteger(draft.amount)) return 'amount must be an integer number of millicredits';
	if (typeof draft.entryKey !== 'string' || draft.entryKey.length === 0 || draft.entryKey.length > 300)
		return 'entryKey is required';
	if ((draft.type === 'settlement' || draft.type === 'metered') && draft.amount > 0) return 'charges cannot be positive';
	if (draft.type === 'deposit' && draft.amount <= 0) return 'deposits must be positive';
	if (draft.type === 'refund' && draft.amount >= 0) return 'refunds must be negative';
	if (draft.type === 'adjustment' && draft.amount === 0) return 'adjustments cannot be zero';
	return null;
};

/**
 * Chain drafts onto a head. Pure: ids and the clock are passed in.
 * @param {{ merchantId: string, head: { seq: number, hash: string }, drafts: readonly EntryDraft[], at: Date,
 *   ids: () => string }} input
 * @returns {LedgerEntry[]}
 */
export const chainEntries = ({ merchantId, head, drafts, at, ids }) => {
	/** @type {LedgerEntry[]} */
	const out = [];
	let { seq, hash } = head;
	for (const draft of drafts) {
		const problem = draftProblem(draft);
		if (problem) throw Object.assign(new Error(problem), { code: 'ledger/invalid_entry' });
		seq += 1;
		const base = {
			merchantId,
			seq,
			type: draft.type,
			amount: draft.amount,
			entryKey: draft.entryKey,
			periodKey: draft.periodKey ?? null,
			periodStart: draft.periodStart ?? null,
			subscriptionId: draft.subscriptionId ?? null,
			websiteId: draft.websiteId ?? null,
			appId: draft.appId ?? null,
			reference: draft.reference ?? null,
			note: draft.note ?? null,
			actor: ledgerActor(draft.actor),
			at,
			details: draft.details ?? null,
			prevHash: hash,
		};
		hash = entryHash(base.prevHash, base);
		out.push({ _id: ids(), ...base, hash });
	}
	return out;
};

/**
 * @typedef {object} ChainProblem
 * @property {number | null} seq
 * @property {'gap' | 'link' | 'hash' | 'merchant' | 'account'} kind
 * @property {string} message
 */

/**
 * Incremental chain verifier (entries pushed in ascending `seq`), so a long ledger can be streamed.
 * @param {string} merchantId
 */
export const createChainVerifier = (merchantId) => {
	/** @type {ChainProblem[]} */
	const problems = [];
	let prev = genesisHash(merchantId);
	let balance = 0;
	let expectedSeq = 1;
	let count = 0;
	let lastSeq = 0;
	return Object.freeze({
		/** @param {Record<string, any>} entry */
		push: (entry) => {
			const seq = typeof entry.seq === 'number' ? entry.seq : null;
			if (entry.merchantId !== merchantId)
				problems.push({ seq, kind: 'merchant', message: 'entry belongs to another merchant' });
			if (seq !== expectedSeq) problems.push({ seq, kind: 'gap', message: `expected seq ${expectedSeq}` });
			if (entry.prevHash !== prev)
				problems.push({ seq, kind: 'link', message: 'prevHash does not link to the previous entry' });
			if (entryHash(String(entry.prevHash), entry) !== entry.hash)
				problems.push({ seq, kind: 'hash', message: 'entry content does not match its hash' });
			balance += Number.isSafeInteger(entry.amount) ? entry.amount : 0;
			prev = String(entry.hash);
			expectedSeq = (seq ?? expectedSeq) + 1;
			lastSeq = seq ?? lastSeq;
			count += 1;
		},
		/**
		 * @param {{ seq: number, headHash: string, balance: number } | null} [account]
		 * @returns {{ ok: boolean, entries: number, balance: number, headHash: string, seq: number, problems: ChainProblem[] }}
		 */
		finish: (account) => {
			/** @type {ChainProblem[]} */
			const all = [...problems];
			if (account) {
				if (account.seq !== lastSeq)
					all.push({ seq: null, kind: 'account', message: `account seq ${account.seq} differs from ledger seq ${lastSeq}` });
				if (account.headHash !== prev)
					all.push({ seq: null, kind: 'account', message: 'account head hash differs from the ledger' });
				if (account.balance !== balance)
					all.push({
						seq: null,
						kind: 'account',
						message: `cached balance ${account.balance} differs from ledger sum ${balance}`,
					});
			}
			return { ok: all.length === 0, entries: count, balance, headHash: prev, seq: lastSeq, problems: all };
		},
	});
};

/**
 * Verify a merchant's chain (entries in ascending `seq`) and optionally the cached account.
 * @param {{ merchantId: string, entries: readonly Record<string, any>[], account?: { seq: number, headHash: string,
 *   balance: number } | null }} input
 */
export const verifyChain = ({ merchantId, entries, account }) => {
	const verifier = createChainVerifier(merchantId);
	for (const entry of entries) verifier.push(entry);
	return verifier.finish(account ?? null);
};

/**
 * Sum of amounts.
 * @param {readonly { amount: number }[]} entries
 * @returns {number}
 */
export const sumAmounts = (entries) => entries.reduce((sum, e) => sum + e.amount, 0);
