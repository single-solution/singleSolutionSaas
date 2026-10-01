/**
 * Small pure checks shared by the service: scheduled instants, reasons, template names.
 * @module
 */

/** Scheduled changes may be at most this far ahead. */
export const MAX_SCHEDULE_AHEAD_MS = 366 * 24 * 60 * 60_000;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Parse a schedule instant (ISO-8601 with zone, or epoch ms) that must lie in the future.
 * @param {unknown} at
 * @param {number} now
 * @returns {{ ok: true, value: number } | { ok: false, message: string }}
 */
export const parseScheduleAt = (at, now) => {
	const ms = typeof at === 'number' ? at : typeof at === 'string' && ISO.test(at) ? Date.parse(at) : Number.NaN;
	if (!Number.isFinite(ms)) return { ok: false, message: 'at must be an ISO-8601 instant with a zone or epoch milliseconds' };
	if (ms <= now) return { ok: false, message: 'at must be in the future' };
	if (ms > now + MAX_SCHEDULE_AHEAD_MS) return { ok: false, message: 'at must be within 366 days' };
	return { ok: true, value: ms };
};

/**
 * Optional free-text reason (required for staff levels): trimmed, 1..500 characters.
 * @param {unknown} reason
 * @param {boolean} required
 * @returns {{ ok: true, value: string | null } | { ok: false, message: string }}
 */
export const parseReason = (reason, required) => {
	if (reason === undefined || reason === null || reason === '') {
		return required
			? { ok: false, message: 'a reason is required for staff overrides and policies' }
			: { ok: true, value: null };
	}
	if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 500)
		return { ok: false, message: 'reason must be 1..500 characters' };
	return { ok: true, value: reason.trim() };
};

/**
 * @param {unknown} name
 * @returns {{ ok: true, value: string } | { ok: false, message: string }}
 */
export const parseName = (name) =>
	typeof name === 'string' && name.trim().length > 0 && name.length <= 120
		? { ok: true, value: name.trim() }
		: { ok: false, message: 'name must be 1..120 characters' };
