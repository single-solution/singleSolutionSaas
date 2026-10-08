/**
 * Ledger chain (pure). Every merchant has one append-only ledger of integer-millicredit entries. Entries are numbered
 * `seq = 1, 2, …` per merchant and hash-chained: `hash = sha256(prevHash + canonical(entry))`, where the first entry
 * links to the merchant's genesis hash. Any edit, deletion, insertion or reordering of a stored entry breaks the chain
 * and is reported by {@link verifyChain}.
 *
 * It holds exactly two kinds of entry (PLAN 0.5.7 b): **receipt** (+credits, 0.5.8) and **day charge** (−credits; one per
 * website × product × UTC day with per-feature lines). The sum of all amounts is the written balance; today's charges
 * are worked out live (`core/money.js`).
 * @module
 */
import { createHash } from 'node:crypto';

/**
 * JSON with object keys sorted recursively (arrays keep their order); `undefined` members are dropped.
 * @param {unknown} value
 * @returns {string}
 */
const stableStringify = (value) => {
	if (value === null || typeof value !== 'object') {
		const json = JSON.stringify(value);
		return json === undefined ? 'null' : json;
	}
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
	const record = /** @type {Record<string, unknown>} */ (value);
	const members = Object.keys(record)
		.filter((key) => record[key] !== undefined)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
	return `{${members.join(',')}}`;
};

/**
 * Hex SHA-256 of a UTF-8 string.
 * @param {string} text
 * @returns {string}
 */
const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

const LEDGER_TYPES = Object.freeze(/** @type {const} */ (['receipt', 'day_charge']));
/** @typedef {typeof LEDGER_TYPES[number]} LedgerType */

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
 * @property {string} entryKey unique per merchant (`day:<websiteId>:<productId>:<day>` for day charges)
 * @property {string | null} [day] UTC day `YYYY-MM-DD` (day charges)
 * @property {string | null} [websiteId]
 * @property {string | null} [productId]
 * @property {string | null} [reference] receipt reference
 * @property {LedgerActor | null} [actor]
 * @property {unknown} [details] receipt `{ amountPaid, method }` or day-charge `{ lines }` (JSON)
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
		day: entry.day ?? null,
		websiteId: entry.websiteId ?? null,
		productId: entry.productId ?? null,
		reference: entry.reference ?? null,
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
	if (draft.type === 'receipt' && draft.amount <= 0) return 'receipts must be positive';
	if (draft.type === 'day_charge' && draft.amount >= 0) return 'day charges must be negative';
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
			day: draft.day ?? null,
			websiteId: draft.websiteId ?? null,
			productId: draft.productId ?? null,
			reference: draft.reference ?? null,
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
