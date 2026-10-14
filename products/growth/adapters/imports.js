/**
 * The `import` feature (PLAN 0.8.10 K10, Migration step 8, G8): what the kit's import routes take into Growth — one
 * collection, `totals`, the days of daily totals rebuilt from another system's analytics, found by `day` and `part`
 * and written as the day's document in `ss_growth_totals` (keys escaped as {@link fieldOf} writes them). A re-imported
 * day replaces the day's first document, so totals Growth recorded live for that day before are replaced too.
 * `finish` has nothing to derive; the sums are what `ss-import verify` compares. Nothing is sent and no raw events are
 * made.
 * @module
 */
import { checkDay } from '../core/imports.js';
import { fieldOf } from './store.js';

/**
 * The kit's `imports` option.
 * @returns {import('@ss/app-kit').ImportOptions}
 */
export const createImportOptions = () => ({
	collections: {
		totals: {
			key: ['day', 'part'],
			check: (record) => {
				const checked = checkDay(record);
				if (!checked.ok) return checked;
				const { day, part, totals } = checked.value;
				return {
					ok: true,
					value: {
						day,
						part,
						totals: Object.fromEntries(
							Object.entries(totals).map(([metric, keys]) => [
								metric,
								Object.fromEntries(Object.entries(keys).map(([key, total]) => [fieldOf(key), total])),
							]),
						),
					},
				};
			},
		},
	},
	finish: async () => ({}),
	totals: (ctx) => totals(ctx),
});

/**
 * The sums `ss-import verify` compares (`GET /v1/import/status`): the days with totals, and their visits and page
 * views.
 * @param {any} ctx
 */
const totals = async (ctx) => {
	/** @type {import('@ss/app-kit').WebsiteData} */
	const data = await ctx.data();
	const [row] = await data
		.collection('totals')
		.aggregate([
			{ $match: { websiteId: String(ctx.websiteId) } },
			{
				$group: {
					_id: '$day',
					visits: { $sum: `$totals.visits.${fieldOf('')}.c` },
					pageViews: { $sum: `$totals.page_views.${fieldOf('')}.c` },
				},
			},
			{ $group: { _id: null, days: { $sum: 1 }, visits: { $sum: '$visits' }, pageViews: { $sum: '$pageViews' } } },
		])
		.toArray();
	return { days: Number(row?.days ?? 0), visits: Number(row?.visits ?? 0), page_views: Number(row?.pageViews ?? 0) };
};
