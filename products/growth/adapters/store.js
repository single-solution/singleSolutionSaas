/**
 * Growth's records in the merchant database (collections `ss_growth_<name>`, through the kit's tenant guard: every
 * query carries the website id; inserts are stamped with `websiteId`, `merchantId`, `createdAt` and `updatedAt`).
 * Nothing names a person: events are anonymous (PLAN 0.8.9 Privacy).
 *
 * - `events`: raw events, removed by the database's expiry index at their `expiresAt` (the retention the merchant set
 *   when they were recorded; 13 months by default). No timer deletes anything.
 * - `totals`: the daily totals, kept forever: one document per day (`day`: the day in the business time zone) holding
 *   `totals.<metric>.<key>` `{ c: count, s: sum }` (the key escaped, see {@link fieldOf}; no `s` while the sum is 0).
 *   A batch of events costs one insert of its raw events and one `$inc` upsert of the day's document (RT-2: Atlas's
 *   free tier allows about 100 operations a second for the whole cluster). A day whose document would grow past
 *   MongoDB's 16 MB goes on in a next `part`; the parts of a day are read as one. The ceilings of `day-caps.js`
 *   (SR-7-9) keep a flood from filling the database: a day's `rawEvents` counts the raw events stored, and a metric's
 *   keys past its most are counted under "(other)".
 *
 * With the `sessions` detail (PLAN 0.8.10 G3) raw events also keep `session`, `browser`, `os` and `city`; live visitors
 * and journeys are read from them when asked (nothing is kept per session besides the events).
 * @module
 */
import { createId } from '@ss/contracts';
import { noopLogger } from '@ss/net';
import { PRODUCT_METRICS } from '../core/product-performance.js';
import { createDayCaps } from './day-caps.js';

/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('../core/events.js').KeptEvent} KeptEvent */
/**
 * @typedef {{ id: string, type: string, path: string, at: Date, expiresAt: Date, data: Record<string, unknown>,
 *   session?: string, browser?: string | null, os?: string | null, city?: string | null }} EventRecord
 */
/** @typedef {import('../core/analytics.js').Journey} Journey */

/** Steps of a journey shown in the report (the event log has them all). */
const JOURNEY_STEPS = 30;

/**
 * The raw analytics events (`ss_growth_analytics_events`): not `events`, the collection the kit keeps for the events a
 * product publishes (`ss_<product>_events`), so Growth can publish events of its own without the two mixing.
 */
const EVENTS = 'analytics_events';
const TOTALS = 'totals';

/** MongoDB's codes for an update that would grow a document past 16 MB. */
const TOO_LARGE = Object.freeze([17419, 10334]);
/** Most parts of one day's totals. */
const MAX_PARTS = 64;
/** Most rows of metric × key one report reads. */
const MAX_ROWS = 20_000;
/** The metrics a report also gives per day. */
const DAY_METRICS = Object.freeze(['visits', 'page_views']);

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
	{ collection: TOTALS, keys: { websiteId: 1, day: 1, part: 1 }, name: 'by_day', unique: true },
];

const NO_ID = { projection: { _id: 0, websiteId: 0, merchantId: 0, createdAt: 0, updatedAt: 0 } };

/**
 * The field of a total's key in a day's document: `_` and the key with `%`, `.` and `$` written as `%25`, `%2E` and
 * `%24` (a field name may be neither empty nor hold a dot, and MongoDB reads a leading `$` as an operator).
 * @param {string} key
 */
export const fieldOf = (key) => `_${key.replace(/[%.$]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`;

/**
 * The key of a field of a day's document ({@link fieldOf} undone).
 * @param {string} field
 */
export const keyOf = (field) => field.slice(1).replace(/%(25|2E|24)/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));

/**
 * The `$inc` of a batch's totals: each metric × key's count, and its sum when there is one.
 * @param {Array<{ metric: string, key: string, count: number, sum: number }>} totals merged per metric and key
 */
const incrementsOf = (totals) => {
	/** @type {Record<string, number>} */
	const inc = {};
	for (const { metric, key, count, sum } of totals) {
		const field = `totals.${metric}.${fieldOf(key)}`;
		inc[`${field}.c`] = count;
		if (sum !== 0) inc[`${field}.s`] = sum;
	}
	return inc;
};

/**
 * @param {WebsiteData} data the guarded merchant database of one website
 * @param {{ merchantId: string, caps?: import('./day-caps.js').DayCaps }} context `caps`: the instance's ceilings on a day
 *   (it keeps the counts it read, so it is the same for every request; without it each batch reads them)
 */
export const createStore = (data, { merchantId, caps = createDayCaps({ now: Date.now, logger: noopLogger }) }) => {
	const events = data.collection(EVENTS);
	const totals = data.collection(TOTALS);
	const websiteId = data.websiteId;

	/**
	 * Add a batch's increments to a day's totals: one upsert of the day's document, or of its next part when it is full.
	 * @param {string} day
	 * @param {Record<string, number>} inc
	 * @param {Date} createdAt
	 * @param {number} [part]
	 * @returns {Promise<void>}
	 */
	const addTotals = async (day, inc, createdAt, part = 0) => {
		try {
			await totals.updateOne(
				{ websiteId, day, part },
				{ $inc: inc, $setOnInsert: { merchantId, createdAt } },
				{ upsert: true },
			);
		} catch (error) {
			const code = Number(/** @type {{ code?: unknown }} */ (error)?.code);
			if (!TOO_LARGE.includes(code) || part + 1 >= MAX_PARTS) throw error;
			await addTotals(day, inc, createdAt, part + 1);
		}
	};

	/**
	 * The totals of the days a filter finds, per metric × key (most counted first, at most {@link MAX_ROWS}): of every
	 * metric, or only of those named.
	 * @param {Record<string, unknown>} range
	 * @param {string[] | null} metrics
	 * @param {ReadonlyArray<string>} [except] metrics left out when every metric is read
	 * @returns {Promise<Array<{ metric: string, key: string, count: number, sum: number }>>}
	 */
	const groupedTotals = async (range, metrics, except = []) => {
		const all =
			except.length === 0
				? { $objectToArray: '$totals' }
				: { $filter: { input: { $objectToArray: '$totals' }, cond: { $not: [{ $in: ['$$this.k', except] }] } } };
		const rows = await totals
			.aggregate([
				{ $match: range },
				{
					$project: {
						_id: 0,
						metrics: metrics === null ? all : { $filter: { input: all, cond: { $in: ['$$this.k', metrics] } } },
					},
				},
				{ $unwind: '$metrics' },
				{ $project: { metric: '$metrics.k', keys: { $objectToArray: '$metrics.v' } } },
				{ $unwind: '$keys' },
				{ $group: { _id: { metric: '$metric', key: '$keys.k' }, count: { $sum: '$keys.v.c' }, sum: { $sum: '$keys.v.s' } } },
				{ $sort: { count: -1 } },
				{ $limit: MAX_ROWS },
			])
			.toArray();
		return rows.map((row) => ({
			metric: String(row._id.metric),
			key: keyOf(String(row._id.key)),
			count: Number(row.count),
			sum: Number(row.sum),
		}));
	};

	/**
	 * What a day holds for the ceilings: the raw events stored and the keys of each metric (the parts of the day added up).
	 * @param {string} day
	 * @returns {Promise<{ rawEvents: number, sizes: Record<string, number> }>}
	 */
	const readDay = async (day) => {
		const parts = await totals
			.aggregate([
				{ $match: { websiteId, day } },
				{
					$project: {
						_id: 0,
						rawEvents: { $ifNull: ['$rawEvents', 0] },
						sizes: {
							$map: {
								input: { $objectToArray: { $ifNull: ['$totals', {}] } },
								in: {
									k: '$$this.k',
									n: {
										$cond: [{ $eq: [{ $type: '$$this.v' }, 'object'] }, { $size: { $objectToArray: '$$this.v' } }, 0],
									},
								},
							},
						},
					},
				},
			])
			.toArray();
		/** @type {Record<string, number>} */
		const sizes = {};
		let rawEvents = 0;
		for (const part of parts) {
			rawEvents += Number(part.rawEvents) || 0;
			for (const { k, n } of part.sizes) sizes[String(k)] = (sizes[String(k)] ?? 0) + Number(n);
		}
		return { rawEvents, sizes };
	};

	/**
	 * Which of some metric × key rows a day's totals hold already (one read of just those keys).
	 * @param {string} day
	 * @param {Array<{ metric: string, key: string }>} rows
	 * @returns {Promise<Set<string>>} `<metric>\n<key>`
	 */
	const existing = async (day, rows) => {
		/** @type {Record<string, number>} */
		const projection = { _id: 0 };
		for (const { metric, key } of rows) projection[`totals.${metric}.${fieldOf(key)}.c`] = 1;
		const parts = await totals.find({ websiteId, day }, { projection }).toArray();
		return new Set(
			rows
				.filter(({ metric, key }) => parts.some((part) => part.totals?.[metric]?.[fieldOf(key)] !== undefined))
				.map(({ metric, key }) => `${metric}\n${key}`),
		);
	};

	/**
	 * The raw events' filter of a list or count request.
	 * @param {{ type?: string, session?: string }} query
	 * @returns {Record<string, unknown>}
	 */
	const eventFilter = ({ type, session }) => ({ websiteId, ...(type ? { type } : {}), ...(session ? { session } : {}) });

	return Object.freeze({
		/**
		 * Keep a batch: its raw events (with their expiry; one insert) and the day's totals (one `$inc` upsert), within
		 * the day's ceilings: no raw row past the day's most (the totals still count the event), and a new key of a full
		 * metric counted under "(other)". An instance reads the day's counts once per {@link REFRESH_MS} (one aggregate).
		 * @param {KeptEvent[]} kept
		 * @param {{ at: number, day: string, expiresAt: Date, totals: Array<{ metric: string, key: string, count: number, sum: number }> }} batch
		 *   `totals`: merged per metric and key
		 */
		record: async (kept, { at, day, expiresAt, totals: increments }) => {
			if (kept.length === 0) return;
			const plan = await caps.plan(
				{ websiteId, day, events: kept.length, totals: increments },
				{ read: readDay, exists: existing },
			);
			if (plan.events > 0)
				await events.insertMany(
					kept.slice(0, plan.events).map((event, index) => ({
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
			await addTotals(
				day,
				{ ...incrementsOf(plan.totals), ...(plan.events > 0 ? { rawEvents: plan.events } : {}) },
				new Date(at),
			);
		},

		/**
		 * The totals of a range of days: per metric × key (most counted first, at most {@link MAX_ROWS}), and visits and
		 * page views per day (the parts of a day added up).
		 * @param {string} from
		 * @param {string} to
		 */
		totals: async (from, to) => {
			const range = { websiteId, day: { $gte: from, $lte: to } };
			const [grouped, documents] = await Promise.all([
				// the products' totals are their own report's (R7 #113)
				groupedTotals(range, null, PRODUCT_METRICS),
				totals.find(range, { projection: { _id: 0, day: 1, 'totals.visits': 1, 'totals.page_views': 1 } }).toArray(),
			]);
			/** @type {Map<string, Record<string, number>>} visits and page views of each day */
			const perDay = new Map();
			/** @param {string} day @param {string} metric @param {number} count */
			const addDay = (day, metric, count) => {
				const counts = perDay.get(day) ?? {};
				counts[metric] = (counts[metric] ?? 0) + count;
				perDay.set(day, counts);
			};
			for (const doc of documents)
				for (const metric of DAY_METRICS)
					addDay(String(doc.day), metric, Number(doc.totals?.[metric]?.[fieldOf('')]?.c ?? 0));
			return {
				totals: grouped,
				days: [...perDay].flatMap(([day, counts]) =>
					Object.entries(counts)
						.filter(([, count]) => count > 0)
						.map(([metric, count]) => ({ day, metric, count })),
				),
			};
		},

		/**
		 * The totals of some metrics over a range of days, per metric × key (most counted first, at most
		 * {@link MAX_ROWS}; one read), for example the 404s and the pages of Redirects' suggestions.
		 * @param {string} from
		 * @param {string} to
		 * @param {string[]} metrics
		 */
		metricTotals: (from, to, metrics) => groupedTotals({ websiteId, day: { $gte: from, $lte: to } }, metrics),

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
