/**
 * Cash-on-delivery safety (PLAN 0.8.8): a largest COD order value, an optional advance
 * (a flat amount, else a percent of the total rounded up, never more than the total) paid through Payments before the
 * order is confirmed, and the returned-parcel (RTO) flag: a customer whose RTO count reaches the threshold may use
 * COD only with an advance (when `rtoRequireAdvance`), else not at all. The blocklist and the open-order cap apply to
 * every order and are checked by checkout. Settings are the `cod` feature's; amounts are minor units. No I/O.
 * @module
 */

/**
 * @typedef {{ maxOrderValue: number, advanceAmount: number, advancePercent: number, rtoThreshold: number,
 *   rtoRequireAdvance: boolean }} CodSettings
 */

/** @param {unknown} value */
const whole = (value) => (Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : 0);

/**
 * The advance a COD order pays first: the flat amount wins, else the percent rounded up; at most the total.
 * @param {number} total minor units
 * @param {Pick<CodSettings, 'advanceAmount' | 'advancePercent'>} settings
 */
export const codAdvance = (total, settings) => {
	if (total <= 0) return 0;
	const flat = whole(settings.advanceAmount);
	if (flat > 0) return Math.min(flat, total);
	const percent = Math.min(100, whole(settings.advancePercent));
	return percent > 0 ? Math.min(total, Math.ceil((total * percent) / 100)) : 0;
};

/**
 * True when a customer's RTO count reaches the threshold (0 = never).
 * @param {number} rtoCount @param {number} threshold
 */
export const isRtoFlagged = (rtoCount, threshold) => whole(threshold) > 0 && whole(rtoCount) >= whole(threshold);

/**
 * Whether an order may be paid on delivery and the advance it pays first.
 * @param {{ total: number, rtoCount: number, canCollectAdvance: boolean }} input `canCollectAdvance`: Payments is
 *   connected, so an advance can be paid
 * @param {CodSettings} settings
 * @returns {{ ok: true, advance: number, flagged: boolean } | { ok: false, reason: 'over_max' | 'advance_unavailable', flagged: boolean }}
 */
export const codDecision = ({ total, rtoCount, canCollectAdvance }, settings) => {
	const flagged = isRtoFlagged(rtoCount, settings.rtoThreshold);
	const max = whole(settings.maxOrderValue);
	if (max > 0 && total > max) return { ok: false, reason: 'over_max', flagged };
	const advance = codAdvance(total, settings);
	if (flagged && settings.rtoRequireAdvance && (advance <= 0 || !canCollectAdvance))
		return { ok: false, reason: 'advance_unavailable', flagged };
	// without Payments a shop-wide advance cannot be paid: the order falls back to plain COD confirmation
	return { ok: true, advance: canCollectAdvance ? advance : 0, flagged };
};
