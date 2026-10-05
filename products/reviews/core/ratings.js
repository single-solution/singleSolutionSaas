/**
 * Rating rollups (pure). An item's summary is computed from **approved** reviews only — never invented — and stored
 * denormalised so lists, widgets and JSON-LD never scan reviews (ported from ibrahimMobiles
 * `recomputeProductRating` / `summarizeRatings`). Every review keeps the scale it was given on, so a merchant can change
 * `content.rating_scale` later: ratings are normalised to the current scale when the summary is read.
 * @module
 */

/**
 * @typedef {object} Rollup stored per item (from an aggregate over approved reviews)
 * @property {Array<{ rating: number, scale: number, count: number }>} ratings counts per (rating, scale)
 * @property {Record<string, { count: number, sum: number }>} attributes
 * @property {number} withPhotos approved reviews with photos
 * @property {number} verified approved reviews from verified buyers
 * @property {string | null} lastReviewAt
 */

/** An empty rollup. @returns {Rollup} */
export const emptyRollup = () => ({ ratings: [], attributes: {}, withPhotos: 0, verified: 0, lastReviewAt: null });

/**
 * Round half away from zero to one decimal.
 * @param {number} value
 */
export const round1 = (value) => (Math.sign(value) * Math.round(Math.abs(value) * 10)) / 10;

/**
 * Count and average of a rollup on a scale.
 * @param {Rollup} rollup
 * @param {number} scale
 * @returns {{ count: number, average: number }}
 */
export const averageOf = (rollup, scale) => {
	let count = 0;
	let sum = 0;
	for (const row of rollup.ratings) {
		if (!(row.count > 0) || !(row.scale > 0) || !(row.rating >= 1 && row.rating <= row.scale)) continue;
		count += row.count;
		sum += ((row.rating * scale) / row.scale) * row.count;
	}
	return { count, average: count > 0 ? round1(sum / count) : 0 };
};

/**
 * Public summary of an item.
 * @param {Rollup} rollup
 * @param {{ scale: number, attributes?: ReadonlyArray<{ key: string, label: string, min: number, max: number, low_label?: string, high_label?: string }> }} options
 */
export const summaryView = (rollup, { scale, attributes = [] }) => {
	const { count, average } = averageOf(rollup, scale);
	/** @type {number[]} */
	const buckets = Array.from({ length: scale }, () => 0);
	for (const row of rollup.ratings) {
		if (!(row.count > 0) || !(row.scale > 0) || !(row.rating >= 1 && row.rating <= row.scale)) continue;
		const value = Math.min(scale, Math.max(1, Math.round((row.rating * scale) / row.scale)));
		buckets[value - 1] = /** @type {number} */ (buckets[value - 1]) + row.count;
	}
	return {
		count,
		average,
		scale,
		distribution: buckets
			.map((n, index) => ({ rating: index + 1, count: n, percent: count > 0 ? Math.round((100 * n) / count) : 0 }))
			.reverse(),
		attributes: attributes
			.map((def) => {
				const stats = rollup.attributes[def.key];
				return {
					key: def.key,
					label: def.label,
					min: def.min,
					max: def.max,
					lowLabel: def.low_label ?? null,
					highLabel: def.high_label ?? null,
					count: stats?.count ?? 0,
					average: stats && stats.count > 0 ? round1(stats.sum / stats.count) : null,
				};
			})
			.filter((attribute) => attribute.count > 0),
		withPhotos: rollup.withPhotos,
		verified: rollup.verified,
		lastReviewAt: rollup.lastReviewAt,
	};
};

/** @typedef {ReturnType<typeof summaryView>} Summary */

/**
 * Compact stars for product lists.
 * @param {string} itemId
 * @param {Rollup | null} rollup
 * @param {number} scale
 */
export const starsView = (itemId, rollup, scale) => ({ itemId, ...averageOf(rollup ?? emptyRollup(), scale), scale });
