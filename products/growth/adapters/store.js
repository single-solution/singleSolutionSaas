/**
 * Growth's records in the merchant database (collections `ss_growth_<name>`, through the kit's tenant guard: every
 * query carries the website id; inserts are stamped with `websiteId`, `merchantId`, `createdAt` and `updatedAt`).
 * Nothing names a person: events are anonymous (PLAN 0.8.9 Privacy).
 *
 * - `events`: raw events, removed by the database's expiry index at their `expiresAt` (the retention the merchant set
 *   when they were recorded; 13 months by default). No timer deletes anything.
 * - `daily`: daily totals `{ day, metric, key, count, sum }` (`day`: the day in the business time zone), kept forever,
 *   updated as events arrive (`$inc` upserts).
 *
 * With the `sessions` detail (PLAN 0.8.10 G3) raw events also keep `session`, `browser`, `os` and `city`; live visitors
 * and journeys are read from them when asked (nothing is kept per session besides the events).
 * @module
 */
import { createId } from '@ss/contracts';

/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('../core/events.js').KeptEvent} KeptEvent */
/**
 * @typedef {{ id: string, type: string, path: string, at: Date, expiresAt: Date, data: Record<string, unknown>,
 *   session?: string, browser?: string | null, os?: string | null, city?: string | null }} EventRecord
 */
/** @typedef {import('../core/analytics.js').Journey} Journey */

/** Steps of a journey shown in the report (the event log has them all). */
const JOURNEY_STEPS = 30;

const EVENTS = 'events';
const DAILY = 'daily';

/** Merchant database indexes (created on a website's first use). @type {import('@ss/app-kit').IndexDefinition[]} */
export const INDEXES = [
	{ collection: EVENTS, keys: { expiresAt: 1 }, name: 'expiry', expireAfterSeconds: 0 },
	{ collection: EVENTS, keys: { websiteId: 1, at: -1, id: -1 }, name: 'newest' },
	{ collection: EVENTS, keys: { websiteId: 1, type: 1, at: -1, id: -1 }, name: 'by_type' },
	{
		collection: EVENTS,
		keys: { websiteId: 1, session: 1, at: -1, id: -1 },
		name: 'by_session',
		partialFilterExpression: { session: { $exists: true } },
	},
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

	/**
	 * The raw events' filter of a list or count request.
	 * @param {{ type?: string, session?: string }} query
	 * @returns {Record<string, unknown>}
	 */
	const eventFilter = ({ type, session }) => ({ websiteId, ...(type ? { type } : {}), ...(session ? { session } : {}) });

	return Object.freeze({
		/**
		 * Keep a batch: its raw events (with their expiry) and the daily totals (one `$inc` upsert per metric × key).
		 * @param {KeptEvent[]} kept
		 * @param {{ at: number, day: string, expiresAt: Date, totals: Array<{ metric: string, key: string, count: number, sum: number }> }} batch
		 */
		record: async (kept, { at, day, expiresAt, totals }) => {
			if (kept.length === 0) return;
			await events.insertMany(
				kept.map((event, index) => ({
					id: createId('evt'),
					type: event.type,
					path: event.path,
					// a millisecond apart, so the events of one batch keep their order (journeys)
					at: new Date(at + index),
					expiresAt,
					data: event.data,
					...(event.visitor ?? {}),
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
		 * The raw events' collection and filter of `GET /v1/events` and its counts (one filter for the list and the counts).
		 * @param {{ type?: string, session?: string }} query `type`: one event type; `session`: one session (G3)
		 */
		eventSource: (query) => ({ collection: events, filter: eventFilter(query) }),

		/**
		 * A page of raw events, newest first.
		 * @param {{ after: unknown, limit: number, type?: string, session?: string }} query `after`: the cursor's `[at, id]`
		 * @returns {Promise<EventRecord[]>}
		 */
		list: async ({ after, limit, type, session }) => {
			const filter = eventFilter({ type, session });
			if (Array.isArray(after) && after.length === 2) {
				const at = new Date(String(after[0]));
				filter.$or = [{ at: { $lt: at } }, { at, id: { $lt: String(after[1]) } }];
			}
			return /** @type {EventRecord[]} */ (
				/** @type {unknown} */ (await events.find(filter, NO_ID).sort({ at: -1, id: -1 }).limit(limit).toArray())
			);
		},

		/**
		 * Live visitors (G3): the sessions seen since a time, and the page each last viewed there.
		 * @param {Date} since
		 * @returns {Promise<{ visitors: number, pages: Array<{ key: string, count: number }> }>}
		 */
		live: async (since) => {
			const rows = await events
				.find(
					{ websiteId, at: { $gte: since }, session: { $exists: true } },
					{ projection: { _id: 0, session: 1, type: 1, path: 1 } },
				)
				.sort({ at: 1, id: 1 })
				.limit(50_000)
				.toArray();
			/** @type {Map<string, string | null>} the page each session last viewed */
			const current = new Map();
			for (const row of rows) {
				if (!current.has(String(row.session))) current.set(String(row.session), null);
				if (row.type === 'page_view') current.set(String(row.session), String(row.path));
			}
			/** @type {Map<string, number>} */
			const pages = new Map();
			for (const path of current.values()) if (path !== null) pages.set(path, (pages.get(path) ?? 0) + 1);
			return {
				visitors: current.size,
				pages: [...pages]
					.map(([key, count]) => ({ key, count }))
					.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
					.slice(0, 10),
			};
		},

		/**
		 * The latest sessions seen between two times, newest first, each with its first steps (G3).
		 * @param {Date} from
		 * @param {Date} to excluded
		 * @param {number} limit
		 * @returns {Promise<Journey[]>}
		 */
		journeys: async (from, to, limit) => {
			const range = { websiteId, session: { $exists: true }, at: { $gte: from, $lt: to } };
			const latest = await events
				.aggregate([
					{ $match: range },
					{ $group: { _id: '$session', first: { $min: '$at' }, last: { $max: '$at' }, events: { $sum: 1 } } },
					{ $sort: { last: -1, _id: 1 } },
					{ $limit: limit },
				])
				.toArray();
			if (latest.length === 0) return [];
			const ids = latest.map((row) => String(row._id));
			const rows = /** @type {EventRecord[]} */ (
				/** @type {unknown} */ (
					await events
						.find({ ...range, session: { $in: ids }, type: { $ne: 'vital' } }, NO_ID)
						.sort({ at: 1, id: 1 })
						.limit(limit * 200)
						.toArray()
				)
			);
			return latest.map((row) => {
				const own = rows.filter((event) => event.session === row._id);
				const visit = own.find((event) => event.type === 'page_view' && event.data.visit === true);
				const last = own.at(-1);
				const first = /** @type {Date} */ (row.first);
				const end = /** @type {Date} */ (row.last);
				/** @param {string} name */
				const fact = (name) => (typeof visit?.data[name] === 'string' ? String(visit.data[name]) : null);
				return {
					session: String(row._id),
					startedAt: first.toISOString(),
					endedAt: end.toISOString(),
					duration: Math.round((end.getTime() - first.getTime()) / 1000),
					events: Number(row.events),
					pages: own.filter((event) => event.type === 'page_view').length,
					device: fact('device'),
					browser: last?.browser ?? null,
					os: last?.os ?? null,
					country: fact('country'),
					city: last?.city ?? null,
					source: fact('source'),
					steps: own.slice(0, JOURNEY_STEPS).map((event) => ({
						type: event.type,
						path: event.path,
						at: event.at.toISOString(),
						...(typeof event.data.term === 'string' ? { term: event.data.term } : {}),
						...(typeof event.data.value === 'number' && event.data.currency
							? { value: event.data.value, currency: /** @type {string} */ (event.data.currency) }
							: {}),
					})),
				};
			});
		},
	});
};

/** @typedef {ReturnType<typeof createStore>} Store */
