/**
 * The ceilings on what the page script's events add to a website's day (SR-7-9): the browser token is public, so
 * anyone who loads the shop could post made-up values until the merchant's database is full. A metric holds at most
 * {@link MAX_DAY_KEYS} distinct keys a day (later new ones are counted under "(other)") and a website stores at most
 * {@link MAX_DAY_EVENTS} raw events a day (later events still count in the totals).
 *
 * An instance keeps the day's counts it read (the raw events stored and the keys of each metric) for
 * {@link REFRESH_MS}, so a batch costs no extra database operation while the metrics have room: the first batch of a
 * website's day on an instance reads them once (RT-2: one aggregate), then again every {@link REFRESH_MS}. The
 * counts grow by the batch's own keys meanwhile (an upper bound, as a key may already exist). Only a metric that
 * could run out of room in a batch is looked at exactly: its counts are read again if they were only estimated, and
 * the batch's keys are looked up in the day's totals (one read), which tells the new ones apart.
 * @module
 */
import { MAX_DAY_EVENTS, MAX_DAY_KEYS, foldTotals } from '../core/events.js';

/** @typedef {{ metric: string, key: string, count: number, sum: number }} Total */
/** @typedef {{ rawEvents: number, sizes: Record<string, number> }} DayCounts what a website's day holds */
/**
 * @typedef {object} Source where the store reads a day
 * @property {(day: string) => Promise<DayCounts>} read the raw events stored and the keys of each metric
 * @property {(day: string, rows: Total[]) => Promise<Set<string>>} exists which of the rows' keys the day holds, as
 *   \`<metric>\n<key>\`
 */

/** How long an instance trusts the day's counts it read (ms). */
export const REFRESH_MS = 15_000;
/** Most website-days an instance keeps counts of. */
const KEPT = 2_000;

/**
 * @param {{ now: () => number, logger: import('@ss/net').Logger }} options
 */
export const createDayCaps = ({ now, logger }) => {
	/** @type {Map<string, DayCounts & { at: number, loose: Set<string>, told: Set<string> }>} */
	const days = new Map();

	/**
	 * What to keep of a batch: how many of its raw events are stored, and its increments with the new keys that
	 * their metric has no room for counted under (other).
	 * @param {{ websiteId: string, day: string, events: number, totals: Total[] }} batch
	 * @param {Source} source
	 * @returns {Promise<{ events: number, totals: Total[] }>}
	 */
	const plan = async ({ websiteId, day, events, totals }, { read, exists }) => {
		const id = `${websiteId}|${day}`;
		let counts = days.get(id);
		if (!counts) {
			if (days.size >= KEPT) days.delete(/** @type {string} */ (days.keys().next().value));
			counts = { rawEvents: 0, sizes: {}, at: Number.NEGATIVE_INFINITY, loose: new Set(), told: new Set() };
			days.set(id, counts);
		}
		const held = counts;
		const refresh = async () => {
			Object.assign(held, await read(day), { at: now(), loose: new Set() });
		};
		/**
		 * A ceiling that bites is logged, once for each website, day and metric.
		 * @param {string} message
		 * @param {{ metric?: string, max: number }} fields
		 */
		const tell = (message, fields) => {
			const once = `${message}|${fields.metric ?? ''}`;
			if (held.told.has(once)) return;
			held.told.add(once);
			logger.warn(message, { websiteId, day, ...fields });
		};
		if (now() - held.at >= REFRESH_MS) await refresh();

		// the raw events: the first ones that fit
		const stored = Math.min(events, Math.max(0, MAX_DAY_EVENTS - held.rawEvents));
		if (stored < events)
			tell('collect cap: the raw events of the day are full; later events count in the totals only', { max: MAX_DAY_EVENTS });

		// the keys: a metric that may run out of room in this batch is looked at exactly
		/** @type {Map<string, number>} */
		const rowsOf = new Map();
		for (const { metric } of totals) rowsOf.set(metric, (rowsOf.get(metric) ?? 0) + 1);
		const crowded = () =>
			[...rowsOf].filter(([metric, rows]) => (held.sizes[metric] ?? 0) + rows > MAX_DAY_KEYS).map(([metric]) => metric);
		let tight = crowded();
		if (tight.some((metric) => held.loose.has(metric))) {
			await refresh();
			tight = crowded();
		}
		let kept = totals;
		if (tight.length > 0) {
			const known = await exists(
				day,
				totals.filter(({ metric }) => tight.includes(metric)),
			);
			const folding = foldTotals(totals, {
				room: (metric) => Math.max(0, MAX_DAY_KEYS - (held.sizes[metric] ?? 0)),
				isNew: (metric, key) => tight.includes(metric) && !known.has(`${metric}\n${key}`),
			});
			kept = folding.totals;
			for (const [metric, added] of Object.entries(folding.added)) held.sizes[metric] = (held.sizes[metric] ?? 0) + added;
			for (const metric of folding.folded)
				tell('collect cap: a metric of the day holds the most keys; later new values are counted under (other)', {
					metric,
					max: MAX_DAY_KEYS,
				});
		}
		// a metric that had room took at most one new key for each of its rows (the exact number is not asked)
		for (const [metric, rows] of rowsOf)
			if (!tight.includes(metric)) {
				held.sizes[metric] = (held.sizes[metric] ?? 0) + rows;
				held.loose.add(metric);
			}
		held.rawEvents += stored;
		return { events: stored, totals: kept };
	};

	return Object.freeze({ plan });
};

/** @typedef {ReturnType<typeof createDayCaps>} DayCaps */
