/**
 * AI token budgets (pure): what is left for one call given the per-conversation and monthly budgets, and when the
 * monthly cost alert threshold is crossed. Budgets are checked before every provider call and charged after it.
 * @module
 */

/**
 * Tokens still allowed (Infinity when both budgets are open).
 * @param {{ conversationUsed: number, perConversation: number, monthUsed: number, monthly: number }} input
 */
export const remainingTokens = ({ conversationUsed, perConversation, monthUsed, monthly }) => {
	const conversation = perConversation > 0 ? perConversation - conversationUsed : Number.POSITIVE_INFINITY;
	const month = monthly > 0 ? monthly - monthUsed : Number.POSITIVE_INFINITY;
	return Math.max(0, Math.min(conversation, month));
};

/**
 * Did this spend cross the alert threshold of the monthly budget?
 * @param {{ before: number, after: number, monthly: number, percent: number }} input
 */
export const alertCrossed = ({ before, after, monthly, percent }) => {
	if (monthly <= 0) return false;
	const threshold = (monthly * percent) / 100;
	return before < threshold && after >= threshold;
};

/**
 * The output cap of one call: the configured maximum, never above what the budget still allows.
 * @param {number} maxOutput
 * @param {number} remaining
 */
export const outputCap = (maxOutput, remaining) =>
	Math.max(1, Math.min(maxOutput, Number.isFinite(remaining) ? Math.floor(remaining) : maxOutput));
