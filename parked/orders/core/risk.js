/**
 * Risk at intake (pure; ported from the store's pay-on-delivery safety rules, review A12): blocked customers, the
 * open-order cap (pay-on-delivery orders waiting for confirmation count), pay-on-delivery caps and advances per
 * currency, and return-to-origin (RTO) flags. Every threshold is a setting; amounts are minor units of the order's
 * own currency, so no currency is assumed.
 * @module
 */
import { amountFor } from './money.js';

/**
 * @typedef {object} RiskSettings
 * @property {number} open_order_cap
 * @property {'review' | 'reject'} cap_action
 * @property {'review' | 'reject'} blocked_action
 * @property {Array<{ currency: string, amount: number }>} cod_max_total
 * @property {'review' | 'reject'} cod_over_cap_action
 * @property {number} cod_advance_percent
 * @property {Array<{ currency: string, amount: number }>} cod_advance_amount
 * @property {number} rto_warning_threshold
 * @property {boolean} rto_require_advance
 */

/**
 * @typedef {{ flags: string[], decision: 'accept' | 'review' | 'reject', advance: number, rtoCount: number }} RiskResult
 */

/**
 * The advance a pay-on-delivery order pays first: a flat amount for its currency wins, else a percentage rounded up;
 * never more than the total.
 * @param {number} total
 * @param {string} currency
 * @param {Pick<RiskSettings, 'cod_advance_percent' | 'cod_advance_amount'>} settings
 */
export const codAdvance = (total, currency, settings) => {
	if (total <= 0) return 0;
	const flat = amountFor(settings.cod_advance_amount, currency);
	if (flat > 0) return Math.min(flat, total);
	const percent = Math.min(100, Math.max(0, settings.cod_advance_percent));
	return percent > 0 ? Math.min(total, Math.ceil((total * percent) / 100)) : 0;
};

/**
 * True when a customer's RTO count crosses the warning threshold (0 disables flagging).
 * @param {number} count
 * @param {number} threshold
 */
export const isRtoFlagged = (count, threshold) => threshold > 0 && count >= threshold;

/**
 * Evaluate a new order.
 * @param {{ total: number, currency: string, cod: boolean, profiles: ReadonlyArray<{ blocked?: boolean, rtoCount?: number }>,
 *   openCount: number }} input
 * @param {RiskSettings} settings
 * @returns {RiskResult}
 */
export const evaluateRisk = ({ total, currency, cod, profiles, openCount }, settings) => {
	/** @type {Array<[string, 'review' | 'reject' | 'flag']>} */
	const found = [];
	if (profiles.some((profile) => profile.blocked === true)) found.push(['blocked', settings.blocked_action]);
	if (settings.open_order_cap > 0 && openCount >= settings.open_order_cap) found.push(['open_cap', settings.cap_action]);
	const rtoCount = Math.max(0, ...profiles.map((profile) => profile.rtoCount ?? 0));
	const flagged = isRtoFlagged(rtoCount, settings.rto_warning_threshold);
	if (flagged) found.push(['rto_flagged', 'flag']);
	let advance = 0;
	if (cod) {
		const cap = amountFor(settings.cod_max_total, currency);
		if (cap > 0 && total > cap) found.push(['cod_over_cap', settings.cod_over_cap_action]);
		advance = codAdvance(total, currency, settings);
		if (flagged && settings.rto_require_advance && advance <= 0) found.push(['advance_unavailable', 'review']);
	}
	const decision = found.some(([, action]) => action === 'reject')
		? 'reject'
		: found.some(([, action]) => action === 'review')
			? 'review'
			: 'accept';
	return { flags: found.map(([flag]) => flag), decision, advance, rtoCount };
};
