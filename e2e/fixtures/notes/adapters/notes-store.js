/**
 * Notes in the merchant database (collection `ss_<product id>_notes`, through the kit's tenant guard: every query
 * carries the website id, inserts are stamped with `websiteId`, `merchantId` and `createdAt`).
 * @module
 */
import { createId } from '@ss/contracts';

/** Unprefixed collection name. */
export const NOTES = 'notes';

/** Merchant database indexes (created on a website's first use). @type {import('@ss/app-kit').IndexDefinition[]} */
export const NOTE_INDEXES = [
	{ collection: NOTES, keys: { websiteId: 1, createdAt: -1, id: -1 }, name: 'newest' },
	{ collection: NOTES, keys: { websiteId: 1, email: 1 }, name: 'by_email' },
];

/** @typedef {import('../core/notes.js').NoteRecord} NoteRecord */

/**
 * The filter of the notes list and its count (PLAN 0.8.10 K4: a count takes exactly the list's filters).
 * @param {string} websiteId
 */
export const notesFilter = (websiteId) => ({ websiteId });

/**
 * @param {import('@ss/app-kit').WebsiteData} data the website's guarded merchant database (`ctx.data()`)
 */
export const createNotesStore = (data) => {
	const notes = data.collection(NOTES);
	const websiteId = data.websiteId;
	const projection = { _id: 0, id: 1, text: 1, email: 1, createdAt: 1 };
	return Object.freeze({
		/**
		 * @param {import('../core/notes.js').NoteInput} note
		 * @returns {Promise<NoteRecord>}
		 */
		add: async ({ text, email }) => {
			const id = createId('note');
			await notes.insertOne({ id, text, email });
			return /** @type {NoteRecord} */ (/** @type {unknown} */ (await notes.findOne({ websiteId, id }, { projection })));
		},
		/**
		 * Newest first, keyset-paged by `[createdAt, id]`.
		 * @param {{ after: unknown, limit: number }} page `after` from the kit's `paginate`
		 * @returns {Promise<NoteRecord[]>}
		 */
		list: async ({ after, limit }) => {
			const [at, id] = Array.isArray(after) ? after : [];
			const filter =
				typeof at === 'string' && typeof id === 'string'
					? {
							...notesFilter(websiteId),
							$or: [{ createdAt: { $lt: new Date(at) } }, { createdAt: new Date(at), id: { $lt: id } }],
						}
					: notesFilter(websiteId);
			const rows = await notes.find(filter, { projection, sort: { createdAt: -1, id: -1 }, limit }).toArray();
			return /** @type {NoteRecord[]} */ (/** @type {unknown} */ (rows));
		},
		/** @param {string} email @returns {Promise<NoteRecord[]>} */
		byEmail: async (email) =>
			/** @type {NoteRecord[]} */ (
				/** @type {unknown} */ (await notes.find({ websiteId, email }, { projection, sort: { createdAt: -1 } }).toArray())
			),
		/** @param {string} email @returns {Promise<number>} notes deleted */
		deleteByEmail: async (email) => (await notes.deleteMany({ websiteId, email })).deletedCount,
	});
};
