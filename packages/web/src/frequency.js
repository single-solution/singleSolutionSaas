/**
 * Frequency caps for placements (`maxPerSession`, `maxPerDay` — rolling 24 h, `maxPerVisitor`, `cooldown`,
 * `dismissMemory`), persisted per website and element in storage with an in-memory mirror when storage is unavailable.
 * @module
 */
import { isPlainObject, parseDuration, safeStorage } from './util.js';

const DAY_MS = 864e5;

/**
 * @typedef {object} FrequencyRule
 * @property {number} [maxPerSession]
 * @property {number} [maxPerDay]
 * @property {number} [maxPerVisitor]
 * @property {string} [cooldown] ISO-8601 duration since the last show
 * @property {string} [dismissMemory] ISO-8601 duration a dismissal is remembered
 */

/** @typedef {{ shows: number[], total: number, session?: { id: string, count: number }, last?: number, dismissed?: number }} FrequencyRecord */

/**
 * @param {{ storage?: import('./util.js').StorageLike | null, websiteId: string, prefix?: string, now?: () => number, sessionId: () => string }} options
 */
export const createFrequency = ({ storage, websiteId, prefix = 'ss', now = Date.now, sessionId }) => {
	const store = safeStorage(storage);
	/** @type {Map<string, FrequencyRecord>} */
	const memory = new Map();
	const keyOf = (/** @type {string} */ element) => `${prefix}:${websiteId}:fq:${element}`;

	/** @param {string} element @returns {FrequencyRecord} */
	const read = (element) => {
		const saved = store.read(keyOf(element));
		if (isPlainObject(saved) && Array.isArray(saved.shows) && typeof saved.total === 'number')
			return /** @type {FrequencyRecord} */ (/** @type {unknown} */ (saved));
		return memory.get(element) ?? { shows: [], total: 0 };
	};
	/** @param {string} element @param {FrequencyRecord} record */
	const write = (element, record) => {
		memory.set(element, record);
		store.write(keyOf(element), record);
	};

	return Object.freeze({
		/**
		 * @param {string} element
		 * @param {FrequencyRule | undefined} rule
		 * @returns {boolean}
		 */
		allowed: (element, rule) => {
			if (!rule) return true;
			const record = read(element);
			const at = now();
			if (rule.maxPerVisitor !== undefined && record.total >= rule.maxPerVisitor) return false;
			if (rule.maxPerSession !== undefined && record.session?.id === sessionId() && record.session.count >= rule.maxPerSession)
				return false;
			if (rule.maxPerDay !== undefined && record.shows.filter((time) => at - time < DAY_MS).length >= rule.maxPerDay)
				return false;
			const cooldown = parseDuration(rule.cooldown);
			if (cooldown !== undefined && record.last !== undefined && at - record.last < cooldown) return false;
			const memoryMs = parseDuration(rule.dismissMemory);
			if (memoryMs !== undefined && record.dismissed !== undefined && at - record.dismissed < memoryMs) return false;
			return true;
		},
		/** @param {string} element */
		recordShow: (element) => {
			const record = read(element);
			const at = now();
			const session = sessionId();
			write(element, {
				...record,
				shows: [...record.shows.filter((time) => at - time < DAY_MS), at].slice(-1000),
				total: record.total + 1,
				session: { id: session, count: record.session?.id === session ? record.session.count + 1 : 1 },
				last: at,
			});
		},
		/** @param {string} element */
		recordDismiss: (element) => write(element, { ...read(element), dismissed: now() }),
	});
};
