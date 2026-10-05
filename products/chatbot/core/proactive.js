/**
 * Proactive messages (pure): the first matching rule by priority whose frequency caps allow it — per session, per
 * visitor per rolling day, cooldown between showings, dismissal memory — plus a global daily cap across rules.
 * Visitor memory is `{ shown: { ruleId: [ms…] }, dismissed: { ruleId: ms }, sessions: { ruleId: { sessionId: n } } }`.
 * @module
 */
import { conditionMatches } from './rules.js';
import { DAY_MS, MINUTE_MS } from './time.js';

/**
 * @typedef {object} ProactiveRule
 * @property {string} id
 * @property {string} [name]
 * @property {boolean} [enabled]
 * @property {number} [priority]
 * @property {string} [when]
 * @property {string} message
 * @property {number} [delay_seconds]
 * @property {boolean} [open_window]
 * @property {number} [max_per_session]
 * @property {number} [max_per_day]
 * @property {number} [cooldown_minutes]
 * @property {number} [dismiss_days]
 */
/** @typedef {{ shown: Record<string, number[]>, dismissed: Record<string, number>, sessions: Record<string, Record<string, number>> }} VisitorMemory */

/** @returns {VisitorMemory} */
export const emptyMemory = () => ({ shown: {}, dismissed: {}, sessions: {} });

/**
 * Can the rule be shown now?
 * @param {ProactiveRule} rule
 * @param {VisitorMemory} memory
 * @param {{ now: number, sessionId: string | null }} options
 */
export const capsAllow = (rule, memory, { now, sessionId }) => {
	const dismissedAt = memory.dismissed[rule.id];
	if (dismissedAt !== undefined && (rule.dismiss_days ?? 0) > 0 && now - dismissedAt < (rule.dismiss_days ?? 0) * DAY_MS)
		return false;
	const shown = (memory.shown[rule.id] ?? []).filter((at) => now - at < DAY_MS);
	if ((rule.max_per_day ?? 0) > 0 && shown.length >= (rule.max_per_day ?? 0)) return false;
	const lastShown = Math.max(0, ...(memory.shown[rule.id] ?? []));
	if ((rule.cooldown_minutes ?? 0) > 0 && lastShown > 0 && now - lastShown < (rule.cooldown_minutes ?? 0) * MINUTE_MS)
		return false;
	if (
		(rule.max_per_session ?? 0) > 0 &&
		sessionId &&
		(memory.sessions[rule.id]?.[sessionId] ?? 0) >= (rule.max_per_session ?? 0)
	)
		return false;
	return true;
};

/**
 * Pick the message to show.
 * @param {{ rules: ProactiveRule[], memory: VisitorMemory, context: Record<string, unknown>, now: number, timeZone: string,
 *   sessionId: string | null, maxPerDay: number }} input
 * @returns {ProactiveRule | null}
 */
export const pickProactive = ({ rules, memory, context, now, timeZone, sessionId, maxPerDay }) => {
	const today = Object.values(memory.shown)
		.flat()
		.filter((at) => now - at < DAY_MS).length;
	if (today >= maxPerDay) return null;
	const ordered = rules
		.filter((rule) => rule.enabled !== false)
		.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id));
	for (const rule of ordered) {
		if (!capsAllow(rule, memory, { now, sessionId })) continue;
		if (conditionMatches(rule.when, context, { now, timeZone }).matched) return rule;
	}
	return null;
};

/**
 * Memory after a showing (old entries pruned).
 * @param {VisitorMemory} memory
 * @param {string} ruleId
 * @param {{ now: number, sessionId: string | null }} options
 * @returns {VisitorMemory}
 */
export const recordShown = (memory, ruleId, { now, sessionId }) => {
	const shown = {
		...memory.shown,
		[ruleId]: [...(memory.shown[ruleId] ?? []).filter((at) => now - at < 30 * DAY_MS), now].slice(-50),
	};
	const sessions = { ...memory.sessions };
	if (sessionId) {
		const current = { ...(sessions[ruleId] ?? {}) };
		current[sessionId] = (current[sessionId] ?? 0) + 1;
		// keep the 20 most recent sessions per rule
		sessions[ruleId] = Object.fromEntries(Object.entries(current).slice(-20));
	}
	return { shown, dismissed: { ...memory.dismissed }, sessions };
};

/**
 * Memory after a dismissal.
 * @param {VisitorMemory} memory
 * @param {string} ruleId
 * @param {number} now
 * @returns {VisitorMemory}
 */
export const recordDismissed = (memory, ruleId, now) => ({ ...memory, dismissed: { ...memory.dismissed, [ruleId]: now } });

/**
 * Proactive evaluation context from untrusted client input (numbers and short strings only).
 * @param {unknown} raw
 */
export const sanitiseVisitorContext = (raw) => {
	const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {Record<string, any>} */ (raw) : {};
	const str = (/** @type {unknown} */ v, max = 1024) => (typeof v === 'string' ? v.slice(0, max) : null);
	const num = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
	const page = r.page && typeof r.page === 'object' ? r.page : {};
	const visitor = r.visitor && typeof r.visitor === 'object' ? r.visitor : {};
	const cart = r.cart && typeof r.cart === 'object' ? r.cart : {};
	return {
		page: { path: str(page.path), url: str(page.url, 2048), referrer: str(page.referrer, 2048), type: str(page.type, 64) },
		visitor: {
			returning: visitor.returning === true,
			visits: num(visitor.visits) ?? 0,
			secondsOnPage: num(visitor.secondsOnPage) ?? 0,
		},
		cart: { value: num(cart.value) ?? 0, items: num(cart.items) ?? 0, currency: str(cart.currency, 3) },
	};
};
