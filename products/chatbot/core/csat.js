/**
 * CSAT (pure): when to ask, rating validation for the configured scale and the satisfaction summary (share of
 * positive ratings: the top half of the scale, as usual for CSAT).
 * @module
 */

/** @typedef {{ scale: number, ask_when: 'on_close' | 'after_human' | 'manual', follow_up: boolean, comment_max_length: number, target: number }} CsatConfig */

/**
 * Ask now? (`on_close`: when the conversation is resolved or closed; `after_human`: only when a person took part).
 * @param {CsatConfig | null} config
 * @param {{ event: 'resolved' | 'closed', humanInvolved: boolean, alreadyAsked: boolean }} input
 */
export const shouldAsk = (config, { event, humanInvolved, alreadyAsked }) => {
	if (!config || alreadyAsked) return false;
	if (config.ask_when === 'manual') return false;
	if (config.ask_when === 'after_human') return humanInvolved && (event === 'resolved' || event === 'closed');
	return event === 'resolved' || event === 'closed';
};

/**
 * @param {unknown} body
 * @param {CsatConfig} config
 * @returns {Array<{ path: string, code: string }>}
 */
export const validateRating = (body, config) => {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return [{ path: '', code: 'object_required' }];
	const b = /** @type {Record<string, any>} */ (body);
	/** @type {Array<{ path: string, code: string }>} */
	const problems = [];
	if (typeof b.conversationId !== 'string' || !b.conversationId) problems.push({ path: '/conversationId', code: 'required' });
	if (!Number.isInteger(b.score) || b.score < 1 || b.score > config.scale)
		problems.push({ path: '/score', code: 'out_of_range' });
	if (b.comment !== undefined && b.comment !== null) {
		if (!config.follow_up) problems.push({ path: '/comment', code: 'not_allowed' });
		else if (typeof b.comment !== 'string' || [...b.comment].length > config.comment_max_length)
			problems.push({ path: '/comment', code: 'too_long' });
	}
	return problems;
};

/**
 * Is a score positive on its scale? Up to 3 points only the top score; above, the top quarter rounded up
 * (4–5 of 5, 8–10 of 10).
 * @param {number} score
 * @param {number} scale
 */
export const isPositive = (score, scale) => score >= (scale <= 3 ? scale : Math.ceil(scale * 0.75));

/**
 * Summary of ratings.
 * @param {Array<{ score: number, scale: number }>} ratings
 * @param {number} target
 */
export const summarise = (ratings, target) => {
	const count = ratings.length;
	const positive = ratings.filter((r) => isPositive(r.score, r.scale)).length;
	const normalised = ratings.reduce((sum, r) => sum + (r.scale > 1 ? (r.score - 1) / (r.scale - 1) : 0), 0);
	const csat = count > 0 ? positive / count : null;
	return {
		count,
		positive,
		csat: csat === null ? null : Math.round(csat * 1000) / 1000,
		average: count > 0 ? Math.round((normalised / count) * 1000) / 1000 : null,
		target,
		onTarget: csat === null ? null : csat >= target,
	};
};
