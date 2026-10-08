/**
 * Growth's records in the merchant database (collections `ss_growth_<name>`, through the kit's tenant guard: every
 * query carries the website id; inserts are stamped with `websiteId`, `merchantId`, `createdAt` and `updatedAt`).
 * Nothing names a person: events are anonymous (PLAN 0.8.9 Privacy).
 *
 * - `events`: raw events, removed by the database's expiry index at their `expiresAt` (the retention the merchant set
 *   when they were recorded; 13 months by default). No timer deletes anything.
 * - `daily`: daily totals `{ day, metric, key, count, sum }`, kept forever, updated as events arrive (`$inc` upserts).
 * @module
 */
import { createId } from '@ss/contracts';

/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('../core/events.js').KeptEvent} KeptEvent */
/**
 * @typedef {{ id: string, type: string, path: string, at: Date, expiresAt: Date, data: Record<string, unknown> }} EventRecord
 */

export const EVENTS = 'events';
export const DAILY = 'daily';

/** Merchant database indexes (created on a website's first use). @type {import('@ss/app-kit').IndexDefinition[]} */
export const INDEXES = [
	{ collection: EVENTS, keys: { expiresAt: 1 }, name: 'expiry', expireAfterSeconds: 0 },
	{ collection: EVENTS, keys: { websiteId: 1, at: -1, id: -1 }, name: 'newest' },
	{ collection: EVENTS, keys: { websiteId: 1, type: 1, at: -1, id: -1 }, name: 'by_type' },
	{ collection: DAILY, keys: { websiteId: 1, day: 1, metric: 1, key: 1 }, name: 'by_day', unique: true },
];

const NO_ID = { projection: { _id: 0, websiteId: 0, merchantId: 0, createdAt: 0, updatedAt: 0 } };

/**
 * @param {WebsiteData} data the guarded merchant database of one website
 * @param {{ merchantId: string }} context
 */
export const createStore = (data, { merchantId }) => {
	const events = data.collection(EVENTS);
	const daily = data.collection(DAILY);
	const websiteId = data.websiteId;
	return Object.freeze({
		/**
		 * Keep a batch: its raw events (with their expiry) and the daily totals (one `$inc` upsert per metric × key).
		 * @param {KeptEvent[]} kept
		 * @param {{ at: number, day: string, expiresAt: Date, totals: Array<{ metric: string, key: string, count: number, sum: number }> }} batch
		 */
		record: async (kept, { at, day, expiresAt, totals }) => {
			if (kept.length === 0) return;
			await events.insertMany(
				kept.map((event) => ({
					id: createId('evt'),
					type: event.type,
					path: event.path,
					at: new Date(at),
					expiresAt,
					data: event.data,
				})),
			);
			await Promise.all(
				totals.map((total) =>
					daily.updateOne(
						{ websiteId, day, metric: total.metric, key: total.key },
						{ $inc: { count: total.count, sum: total.sum }, $setOnInsert: { merchantId, createdAt: new Date(at) } },
						{ upsert: true },
					),
				),
			);
		},

		/**
		 * The totals of a range of days: per metric × key, and visits and page views per day.
		 * @param {string} from
		 * @param {string} to
		 */
		totals: async (from, to) => {
			const range = { websiteId, day: { $gte: from, $lte: to } };
			const [totals, days] = await Promise.all([
				daily
					.aggregate([
						{ $match: range },
						{ $group: { _id: { metric: '$metric', key: '$key' }, count: { $sum: '$count' }, sum: { $sum: '$sum' } } },
						{ $sort: { count: -1 } },
						{ $limit: 20_000 },
					])
					.toArray(),
				daily.find({ ...range, metric: { $in: ['visits', 'page_views'] } }, NO_ID).toArray(),
			]);
			return {
				totals: totals.map((row) => ({
					metric: String(row._id.metric),
					key: String(row._id.key),
					count: Number(row.count),
					sum: Number(row.sum),
				})),
				days: days.map((row) => ({ day: String(row.day), metric: String(row.metric), count: Number(row.count) })),
			};
		},

		/**
		 * A page of raw events, newest first.
		 * @param {{ after: unknown, limit: number, type?: string }} query `after`: the cursor's `[at, id]`
		 * @returns {Promise<EventRecord[]>}
		 */
		list: async ({ after, limit, type }) => {
			/** @type {Record<string, unknown>} */
			const filter = { websiteId, ...(type ? { type } : {}) };
			if (Array.isArray(after) && after.length === 2) {
				const at = new Date(String(after[0]));
				filter.$or = [{ at: { $lt: at } }, { at, id: { $lt: String(after[1]) } }];
			}
			return /** @type {EventRecord[]} */ (
				/** @type {unknown} */ (await events.find(filter, NO_ID).sort({ at: -1, id: -1 }).limit(limit).toArray())
			);
		},
	});
};

/** @typedef {ReturnType<typeof createStore>} Store */
