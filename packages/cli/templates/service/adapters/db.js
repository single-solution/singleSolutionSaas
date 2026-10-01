/**
 * Notes repository over the client-owned database (Part E §7). Every query carries `websiteId`; app-kit's data guard
 * rejects any that does not. Collections are prefixed by app-kit (`ss_<slug>_notes`).
 */

export const NOTES_COLLECTION = 'notes';

/** Indexes (websiteId first in every compound index), created idempotently on first connect. */
export const NOTES_INDEXES = Object.freeze([
	{ key: { websiteId: 1, deletedAt: 1, id: -1 }, name: 'website_active_id' },
	{ key: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{
		key: { websiteId: 1, sourceEventId: 1 },
		name: 'website_source_event',
		unique: true,
		partialFilterExpression: { sourceEventId: { $type: 'string' } },
	},
]);

/** @typedef {import('../core/notes.js').Note} Note */
/**
 * The subset of a MongoDB collection the repository uses (app-kit's guarded collection has the same shape).
 * @typedef {object} CollectionLike
 * @property {(filter: object, options?: object) => { toArray: () => Promise<any[]> }} find
 * @property {(filter: object) => Promise<any>} findOne
 * @property {(doc: object) => Promise<unknown>} insertOne
 * @property {(filter: object, update: object, options?: object) => Promise<{ matchedCount?: number, upsertedCount?: number }>} updateOne
 * @property {(filter: object) => Promise<number>} countDocuments
 * @property {(filter: object) => Promise<{ deletedCount?: number }>} [deleteMany]
 */

/**
 * @param {any} doc
 * @returns {Note}
 */
const toNote = (doc) => /** @type {Note} */ (Object.fromEntries(Object.entries(doc).filter(([key]) => key !== '_id')));

/**
 * @param {CollectionLike} collection
 * @param {string} websiteId
 */
export const createNotesRepository = (collection, websiteId) => {
	if (typeof websiteId !== 'string' || websiteId.length === 0) throw new TypeError('websiteId is required');
	const active = { websiteId, deletedAt: null };
	return Object.freeze({
		/**
		 * Newest first. `after` is the decoded cursor (last id of the previous page); fetch `fetchLimit` rows so the
		 * caller (app-kit `paginate`) can tell whether another page exists.
		 * @param {{ after?: unknown, fetchLimit: number }} page
		 * @returns {Promise<Note[]>}
		 */
		list: async ({ after, fetchLimit }) => {
			const filter = typeof after === 'string' && after ? { ...active, id: { $lt: after } } : active;
			return (await collection.find(filter, { sort: { id: -1 }, limit: fetchLimit }).toArray()).map(toNote);
		},
		/** @returns {Promise<number>} */
		count: () => collection.countDocuments(active),
		/**
		 * @param {string} id
		 * @returns {Promise<Note | null>}
		 */
		get: async (id) => {
			const doc = await collection.findOne({ ...active, id });
			return doc ? toNote(doc) : null;
		},
		/**
		 * Insert; notes with a `sourceEventId` are upserted so a replayed event never creates a second note.
		 * @param {Note} note
		 * @returns {Promise<boolean>} true when a new note was stored
		 */
		insert: async (note) => {
			if (note.websiteId !== websiteId) throw new TypeError('note belongs to another website');
			if (note.sourceEventId) {
				const insertOnly = Object.fromEntries(Object.entries(note).filter(([key]) => key !== 'updatedAt')); // the guard sets updatedAt
				const result = await collection.updateOne(
					{ websiteId, sourceEventId: note.sourceEventId },
					{ $setOnInsert: insertOnly },
					{ upsert: true },
				);
				return (result.upsertedCount ?? 0) > 0;
			}
			await collection.insertOne({ ...note });
			return true;
		},
		/**
		 * @param {Note} note
		 * @returns {Promise<void>}
		 */
		save: async (note) => {
			await collection.updateOne(
				{ websiteId, id: note.id },
				{ $set: { text: note.text, pinned: note.pinned, updatedAt: note.updatedAt } },
			);
		},
		/**
		 * Soft delete (Part E §5: DELETE is soft by default).
		 * @param {string} id
		 * @param {string} at ISO time
		 * @returns {Promise<boolean>}
		 */
		remove: async (id, at) => {
			const result = await collection.updateOne({ ...active, id }, { $set: { deletedAt: at, updatedAt: at } });
			return (result.matchedCount ?? 0) > 0;
		},
		/**
		 * Hard-delete soft-deleted notes older than `before` (retention job).
		 * @param {string} before ISO time
		 * @returns {Promise<number>}
		 */
		purgeDeleted: async (before) => {
			if (!collection.deleteMany) return 0;
			const result = await collection.deleteMany({ websiteId, deletedAt: { $lt: before } });
			return result.deletedCount ?? 0;
		},
	});
};

/** @typedef {ReturnType<typeof createNotesRepository>} NotesRepository */

/**
 * Repository for a website through app-kit's client-owned data access (`product.data.forWebsite`). Indexes are
 * ensured once per website (map form: `{ [collection]: [...] }`).
 * @param {{ data: { forWebsite: (websiteId: string) => Promise<any> } }} product
 * @returns {(websiteId: string) => Promise<NotesRepository>}
 */
export const notesRepositories = (product) => {
	/** @type {Set<string>} */
	const indexed = new Set();
	return async (websiteId) => {
		const scope = await product.data.forWebsite(websiteId);
		if (!indexed.has(websiteId)) {
			await scope.ensureIndexes({ [NOTES_COLLECTION]: NOTES_INDEXES });
			indexed.add(websiteId);
		}
		return createNotesRepository(scope.collection(NOTES_COLLECTION), websiteId);
	};
};
