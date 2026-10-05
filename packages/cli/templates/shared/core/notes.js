/**
 * Notes domain core: pure validation, creation, updates and paging helpers. No I/O, no DOM, no clock — time and ids
 * are always passed in, so every rule is testable and identical in Mode A, B and C.
 */

export const NOTE_SCHEMA_VERSION = 1;

/** @typedef {{ max_notes: number, max_length: number, show_timestamps: boolean }} NotesConfig */
/**
 * @typedef {object} Note
 * @property {string} id
 * @property {string} websiteId
 * @property {string} text
 * @property {boolean} pinned
 * @property {string | null} sourceEventId event that created the note (idempotent consumption), if any
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string | null} deletedAt
 * @property {number} schemaVersion
 */
/** @typedef {{ path: string, code: 'text_required' | 'text_too_long' | 'text_invalid' | 'pinned_invalid' | 'limit_reached' | 'unknown_field' }} NoteProblem */

/** Product defaults; the effective values always come from the signed entitlement document. */
export const DEFAULT_CONFIG = Object.freeze({ max_notes: 50, max_length: 500, show_timestamps: true });

/**
 * Effective configuration: entitlement config values over the product defaults (unknown or mistyped values ignored).
 * @param {Partial<Record<string, unknown>>} [config]
 * @returns {NotesConfig}
 */
export const resolveConfig = (config = {}) => ({
	max_notes: Number.isInteger(config.max_notes) ? /** @type {number} */ (config.max_notes) : DEFAULT_CONFIG.max_notes,
	max_length: Number.isInteger(config.max_length) ? /** @type {number} */ (config.max_length) : DEFAULT_CONFIG.max_length,
	show_timestamps: typeof config.show_timestamps === 'boolean' ? config.show_timestamps : DEFAULT_CONFIG.show_timestamps,
});

const FIELDS = new Set(['text', 'pinned']);

/**
 * Validate a create (or, with `partial`, a JSON Merge Patch) payload.
 * @param {unknown} input
 * @param {NotesConfig} [config]
 * @param {{ partial?: boolean }} [options]
 * @returns {NoteProblem[]}
 */
export const validateNoteInput = (input, config = DEFAULT_CONFIG, { partial = false } = {}) => {
	if (typeof input !== 'object' || input === null || Array.isArray(input)) return [{ path: '', code: 'text_invalid' }];
	const value = /** @type {Record<string, unknown>} */ (input);
	/** @type {NoteProblem[]} */
	const problems = [];
	for (const key of Object.keys(value)) if (!FIELDS.has(key)) problems.push({ path: `/${key}`, code: 'unknown_field' });
	if (!partial || 'text' in value) {
		if (typeof value.text !== 'string')
			problems.push({ path: '/text', code: value.text === undefined ? 'text_required' : 'text_invalid' });
		else if (value.text.trim().length === 0) problems.push({ path: '/text', code: 'text_required' });
		else if ([...value.text.trim()].length > config.max_length) problems.push({ path: '/text', code: 'text_too_long' });
	}
	if ('pinned' in value && typeof value.pinned !== 'boolean') problems.push({ path: '/pinned', code: 'pinned_invalid' });
	return problems;
};

/**
 * True when one more note fits the `max_notes` limit.
 * @param {number} count active notes of the website
 * @param {NotesConfig} config
 * @returns {boolean}
 */
export const canAddNote = (count, config) => count < config.max_notes;

/**
 * Time-ordered opaque id: `note_<time base36><random>`.
 * @param {number} nowMs
 * @param {string} random lowercase alphanumerics
 * @returns {string}
 */
export const newNoteId = (nowMs, random) =>
	`note_${nowMs.toString(36).padStart(9, '0')}${random.toLowerCase().replace(/[^a-z0-9]/g, '')}`;

/**
 * Build a stored note (always keyed by `websiteId`).
 * @param {{ input: { text: string, pinned?: boolean }, websiteId: string, id: string, nowMs: number, sourceEventId?: string | null }} params
 * @returns {Note}
 */
export const createNote = ({ input, websiteId, id, nowMs, sourceEventId = null }) => {
	const at = new Date(nowMs).toISOString();
	return {
		id,
		websiteId,
		text: input.text.trim(),
		pinned: input.pinned === true,
		sourceEventId,
		createdAt: at,
		updatedAt: at,
		deletedAt: null,
		schemaVersion: NOTE_SCHEMA_VERSION,
	};
};

/**
 * Apply a validated JSON Merge Patch.
 * @param {Note} note
 * @param {{ text?: string, pinned?: boolean }} patch
 * @param {number} nowMs
 * @returns {Note}
 */
export const applyPatch = (note, patch, nowMs) => ({
	...note,
	...(patch.text === undefined ? {} : { text: patch.text.trim() }),
	...(patch.pinned === undefined ? {} : { pinned: patch.pinned }),
	updatedAt: new Date(nowMs).toISOString(),
});

/**
 * Public representation (no tenant keys, no internals).
 * @param {Note} note
 * @returns {{ id: string, text: string, pinned: boolean, createdAt: string, updatedAt: string }}
 */
export const toPublic = (note) => ({
	id: note.id,
	text: note.text,
	pinned: note.pinned,
	createdAt: note.createdAt,
	updatedAt: note.updatedAt,
});

/**
 * Display order: pinned first, then newest first.
 * @template {{ id: string, pinned: boolean }} T
 * @param {readonly T[]} notes
 * @returns {T[]}
 */
export const sortNotes = (notes) =>
	[...notes].sort((a, b) => Number(b.pinned) - Number(a.pinned) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

/**
 * Clamp a requested page size.
 * @param {unknown} limit
 * @param {{ fallback?: number, max?: number }} [options]
 * @returns {number}
 */
export const pageSize = (limit, { fallback = 20, max = 100 } = {}) => {
	const parsed = typeof limit === 'string' ? Number.parseInt(limit, 10) : limit;
	return typeof parsed === 'number' && Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
};

/**
 * Note text for an `order.placed@1` event (standard event data: orderId, number?, lines[]).
 * @param {{ orderId: string, number?: string, lines?: readonly unknown[] }} data
 * @returns {string}
 */
export const noteFromOrder = (data) =>
	`Order ${data.number ?? data.orderId} placed (${data.lines?.length ?? 0} line${data.lines?.length === 1 ? '' : 's'})`;
