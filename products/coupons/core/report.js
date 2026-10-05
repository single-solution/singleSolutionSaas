/**
 * Reporting (pure): shapes the aggregates the repositories compute in the merchant database into the report views —
 * redemptions, discount given and revenue per currency (money is never summed across currencies), average order value,
 * discount rate, top codes and per-coupon figures.
 * @module
 */

/**
 * @typedef {object} OrderRow aggregate of redeemed reservations of one currency
 * @property {string} currency
 * @property {number} count
 * @property {number} discount line + shipping discounts
 * @property {number} revenue amounts paid (after discounts)
 */
/**
 * @typedef {object} CodeRow aggregate of redeemed codes
 * @property {string} couponId
 * @property {string} code
 * @property {string} currency
 * @property {number} redemptions
 * @property {number} discount
 */

/**
 * @param {{ from: string, to: string, orders: readonly OrderRow[], codes: readonly CodeRow[], released: number, top: number }} input
 */
export const summarise = ({ from, to, orders, codes, released, top }) => {
	const currencies = [...orders]
		.sort((a, b) => a.currency.localeCompare(b.currency))
		.map((row) => ({
			currency: row.currency,
			orders: row.count,
			discount: row.discount,
			revenue: row.revenue,
			averageOrder: row.count > 0 ? Math.round(row.revenue / row.count) : 0,
			discountRate:
				row.revenue + row.discount > 0 ? Math.round((10_000 * row.discount) / (row.revenue + row.discount)) / 100 : 0,
		}));
	const topCodes = [...codes]
		.sort((a, b) => b.redemptions - a.redemptions || b.discount - a.discount || a.code.localeCompare(b.code))
		.slice(0, Math.max(0, top))
		.map((row) => ({ ...row }));
	/** @type {Map<string, { couponId: string, redemptions: number, codes: number }>} */
	const coupons = new Map();
	for (const row of codes) {
		const entry = coupons.get(row.couponId) ?? { couponId: row.couponId, redemptions: 0, codes: 0 };
		entry.redemptions += row.redemptions;
		entry.codes += 1;
		coupons.set(row.couponId, entry);
	}
	return {
		from,
		to,
		redemptions: codes.reduce((sum, row) => sum + row.redemptions, 0),
		orders: orders.reduce((sum, row) => sum + row.count, 0),
		released,
		currencies,
		topCodes,
		coupons: [...coupons.values()].sort((a, b) => b.redemptions - a.redemptions || a.couponId.localeCompare(b.couponId)),
	};
};

/**
 * The reporting window: `from`/`to` from the query when valid (ISO), else the last `days` days.
 * @param {{ from?: unknown, to?: unknown, now: number, days: number }} input
 * @returns {{ from: string, to: string } | null} null when the range is invalid or inverted
 */
export const reportWindow = ({ from, to, now, days }) => {
	const end = typeof to === 'string' && to ? Date.parse(to) : now;
	const start = typeof from === 'string' && from ? Date.parse(from) : end - days * 24 * 3_600_000;
	if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return null;
	return { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
};
