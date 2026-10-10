/**
 * `@ss/importer/fixture` — the fixture mapping and its source documents: a small store-like `feedback` collection
 * (ObjectId ids, mixed-case e-mails, a duplicate, a hidden message and an empty one) mapped into the e2e test product
 * Notes (`notes` import collection). Used by this unit's tests and by the e2e dry run; the store mappings come in Phase
 * 5 (PLAN 0.8.10 Build phases).
 * @module
 */
import { ObjectId } from 'mongodb';
import { defineMapping } from '../mapping.js';

/** The source documents (ids as hex; `seed` stores them as ObjectIds). */
export const FEEDBACK = Object.freeze([
	{
		_id: '64b0c0ffee00000000000001',
		message: 'Love the new pedestal fans',
		email: 'Ayesha@Example.com',
		createdAt: '2024-01-05T10:00:00Z',
	},
	{
		_id: '64b0c0ffee00000000000002',
		message: 'When is the 56 inch model back?',
		email: null,
		createdAt: '2024-02-01T09:30:00Z',
	},
	{
		_id: '64b0c0ffee00000000000003',
		message: 'Love the new pedestal fans',
		email: 'ayesha@example.com',
		createdAt: '2024-01-05T10:05:00Z',
	},
	{
		_id: '64b0c0ffee00000000000004',
		message: 'Spam',
		email: 'spam@example.com',
		createdAt: '2024-03-01T00:00:00Z',
		hidden: true,
	},
	{ _id: '64b0c0ffee00000000000005', message: '', email: 'empty@example.com', createdAt: '2024-03-02T00:00:00Z' },
	{
		_id: '64b0c0ffee00000000000006',
		message: 'Delivery was quick, thank you',
		email: 'bilal@example.com',
		createdAt: '2024-04-10T15:45:00Z',
	},
]);

/** What the fixture should import: the duplicate merges, the hidden one is not read, the empty one is left out. */
export const EXPECTED = Object.freeze({ read: 5, records: 3, merged: 1, skipped: 1 });

/**
 * Store the source documents in a (test) database.
 * @param {import('mongodb').Db} db
 */
export const seed = async (db) => {
	await db
		.collection('feedback')
		.insertMany(FEEDBACK.map((doc) => ({ ...doc, _id: new ObjectId(doc._id), createdAt: new Date(doc.createdAt) })));
};

/** The fixture mapping: feedback messages → Notes' `notes`. */
export const FIXTURE_MAPPING = defineMapping({
	name: 'fixture',
	description: "Test mapping: a store's feedback messages into the test product Notes (e2e).",
	steps: [
		{
			product: 'notes',
			collection: 'notes',
			source: 'feedback',
			prefix: 'note',
			filter: { hidden: { $ne: true } },
			// the same message twice from one address is one note (the oldest)
			mergeKey: (doc) => `${String(doc.email ?? '').toLowerCase()}|${doc.message}`,
			map: (doc, ctx) =>
				doc.message
					? {
							id: ctx.id('note', doc._id),
							text: doc.message,
							email: typeof doc.email === 'string' ? doc.email.toLowerCase() : null,
							createdAt: new Date(doc.createdAt).toISOString(),
						}
					: null,
			countPath: '/v1/notes/count',
		},
	],
});
