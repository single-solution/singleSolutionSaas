/**
 * Deal schedules (pure). A schedule is an optional `[startsAt, endsAt)` range of UTC instants plus optional weekly
 * windows in a time zone:
 *
 *   { startsAt?, endsAt?, timeZone?, windows?: [{ days?: ['mon', …], start: 'HH:MM', end: 'HH:MM' }] }
 *
 * - A window is `[start, end)` local time. `start > end` wraps past midnight (18:00–02:00) and the after-midnight part
 *   **belongs to the day the window started on** (Friday 18:00–02:00 is active on Saturday 01:30, not on Friday
 *   01:30) — the ibrahimMobiles rule, also used by the Loader's placement schedule. `start == end` is a full 24 h.
 * - `days` empty or absent = every day. No windows = always (within the date range).
 * - The zone is the schedule's `timeZone`, else the website's zone (quote_api.time_zone), else UTC.
 * - `scheduleState` also gives the end of the running window instance (chained across back-to-back windows) and the
 *   next start, which drive countdowns ("ends in 2 h") and "starts at" copy.
 * @module
 */
import { DAYS, DAY_MS, addDays, clockMinutes, isTimeZone, localParts, parseInstant, zonedToUtc } from './time.js';

/** @typedef {{ days?: string[], start: string, end: string }} WeeklyWindow */
/** @typedef {{ startsAt?: string | null, endsAt?: string | null, timeZone?: string | null, windows?: WeeklyWindow[] }} Schedule */
/**
 * @typedef {object} ScheduleState
 * @property {boolean} active
 * @property {'scheduled' | 'active' | 'ended' | 'outside_window'} phase
 * @property {number | null} activeUntil epoch ms the current activity ends (window end or endsAt), null = open-ended
 * @property {number | null} nextStart epoch ms of the next activation when not active, null = none
 * @property {string} timeZone the zone windows were evaluated in
 */

/** How many days ahead the next window start is searched (a weekly schedule always repeats within 8). */
const LOOKAHEAD_DAYS = 8;
/** Back-to-back window instances followed when computing where an activity ends. */
const MAX_CHAIN = 14;

/**
 * The zone of a schedule.
 * @param {Schedule | null | undefined} schedule
 * @param {string} fallback website zone
 */
export const scheduleZone = (schedule, fallback) =>
	isTimeZone(schedule?.timeZone) ? /** @type {string} */ (schedule?.timeZone) : isTimeZone(fallback) ? fallback : 'UTC';

/**
 * Window instances `[start, end)` (epoch ms) whose start day lies within `fromDay..toDay` local days around `ms`.
 * @param {WeeklyWindow[]} windows
 * @param {number} ms
 * @param {string} timeZone
 * @param {number} fromDay
 * @param {number} toDay
 * @returns {Array<[number, number]>}
 */
export const windowInstances = (windows, ms, timeZone, fromDay, toDay) => {
	const today = localParts(ms, timeZone);
	/** @type {Array<[number, number]>} */
	const out = [];
	for (let offset = fromDay; offset <= toDay; offset += 1) {
		const date = addDays(today, offset);
		const dayKey = DAYS[date.weekday];
		for (const slot of windows) {
			const days = Array.isArray(slot.days) && slot.days.length > 0 ? slot.days : null;
			if (days && !days.includes(/** @type {string} */ (dayKey))) continue;
			const start = clockMinutes(slot.start);
			const end = clockMinutes(slot.end);
			if (start === null || end === null) continue;
			const startMs = zonedToUtc({ ...date, hour: Math.floor(start / 60), minute: start % 60 }, timeZone);
			const endDate = end <= start ? addDays(date, 1) : date;
			const endMs = zonedToUtc({ ...endDate, hour: Math.floor(end / 60), minute: end % 60 }, timeZone);
			if (endMs > startMs) out.push([startMs, endMs]);
		}
	}
	return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
};

/**
 * State of a schedule at `now`.
 * @param {Schedule | null | undefined} schedule
 * @param {number} now epoch ms
 * @param {string} [fallbackZone] the website zone
 * @returns {ScheduleState}
 */
export const scheduleState = (schedule, now, fallbackZone = 'UTC') => {
	const timeZone = scheduleZone(schedule, fallbackZone);
	const startsAt = parseInstant(schedule?.startsAt);
	const endsAt = parseInstant(schedule?.endsAt);
	const windows = Array.isArray(schedule?.windows) ? schedule.windows : [];
	if (endsAt !== null && now >= endsAt) return { active: false, phase: 'ended', activeUntil: null, nextStart: null, timeZone };
	const capEnd = (/** @type {number | null} */ t) => (endsAt === null ? t : t === null ? endsAt : Math.min(t, endsAt));
	const afterRange = (/** @type {number} */ t) => endsAt === null || t < endsAt;
	if (windows.length === 0) {
		if (startsAt !== null && now < startsAt)
			return { active: false, phase: 'scheduled', activeUntil: null, nextStart: startsAt, timeZone };
		return { active: true, phase: 'active', activeUntil: endsAt, nextStart: null, timeZone };
	}
	const from = Math.max(now, startsAt ?? now);
	const instances = windowInstances(windows, from, timeZone, -1, LOOKAHEAD_DAYS);
	const running = startsAt !== null && now < startsAt ? null : instances.find(([s, e]) => s <= now && now < e);
	if (running) {
		let end = running[1];
		for (let i = 0; i < MAX_CHAIN; i += 1) {
			const next = instances.find(([s, e]) => s <= end && e > end);
			if (!next) break;
			end = next[1];
		}
		return { active: true, phase: 'active', activeUntil: capEnd(end), nextStart: null, timeZone };
	}
	const upcoming = instances
		.map(([s, e]) => (s >= from ? s : startsAt !== null && s < startsAt && e > startsAt ? startsAt : -1))
		.filter((s) => s > now && afterRange(s))
		.sort((a, b) => a - b)[0];
	return {
		active: false,
		phase: startsAt !== null && now < startsAt ? 'scheduled' : 'outside_window',
		activeUntil: null,
		nextStart: upcoming ?? null,
		timeZone,
	};
};

/**
 * Convenience: is the schedule active at `now`?
 * @param {Schedule | null | undefined} schedule
 * @param {number} now
 * @param {string} [fallbackZone]
 */
export const isScheduleActive = (schedule, now, fallbackZone = 'UTC') => scheduleState(schedule, now, fallbackZone).active;

/**
 * Validation problems of a schedule (paths relative to the schedule).
 * @param {unknown} schedule
 * @param {{ maxWindows: number, maxDurationDays?: number }} limits
 * @returns {Array<{ path: string, code: string }>}
 */
export const validateSchedule = (schedule, { maxWindows, maxDurationDays = 0 }) => {
	if (schedule === undefined || schedule === null) return [];
	if (typeof schedule !== 'object' || Array.isArray(schedule)) return [{ path: '', code: 'object_invalid' }];
	const s = /** @type {Record<string, unknown>} */ (schedule);
	/** @type {Array<{ path: string, code: string }>} */
	const problems = [];
	for (const key of Object.keys(s))
		if (!['startsAt', 'endsAt', 'timeZone', 'windows'].includes(key)) problems.push({ path: `/${key}`, code: 'unknown_field' });
	const startsAt = s.startsAt === undefined || s.startsAt === null ? null : parseInstant(s.startsAt);
	const endsAt = s.endsAt === undefined || s.endsAt === null ? null : parseInstant(s.endsAt);
	if (s.startsAt !== undefined && s.startsAt !== null && startsAt === null)
		problems.push({ path: '/startsAt', code: 'instant_invalid' });
	if (s.endsAt !== undefined && s.endsAt !== null && endsAt === null)
		problems.push({ path: '/endsAt', code: 'instant_invalid' });
	if (startsAt !== null && endsAt !== null && endsAt <= startsAt) problems.push({ path: '/endsAt', code: 'range_invalid' });
	if (maxDurationDays > 0 && startsAt !== null && endsAt !== null && endsAt - startsAt > maxDurationDays * DAY_MS)
		problems.push({ path: '/endsAt', code: 'duration_exceeded' });
	if (s.timeZone !== undefined && s.timeZone !== null && !isTimeZone(s.timeZone))
		problems.push({ path: '/timeZone', code: 'time_zone_invalid' });
	if (s.windows !== undefined) {
		if (!Array.isArray(s.windows)) problems.push({ path: '/windows', code: 'array_invalid' });
		else {
			if (s.windows.length > maxWindows) problems.push({ path: '/windows', code: 'too_many' });
			s.windows.forEach((/** @type {unknown} */ slot, /** @type {number} */ index) => {
				const at = `/windows/${index}`;
				if (!slot || typeof slot !== 'object' || Array.isArray(slot)) {
					problems.push({ path: at, code: 'object_invalid' });
					return;
				}
				const w = /** @type {Record<string, unknown>} */ (slot);
				for (const key of Object.keys(w))
					if (!['days', 'start', 'end'].includes(key)) problems.push({ path: `${at}/${key}`, code: 'unknown_field' });
				if (clockMinutes(w.start) === null || w.start === '24:00')
					problems.push({ path: `${at}/start`, code: 'time_invalid' });
				if (clockMinutes(w.end) === null) problems.push({ path: `${at}/end`, code: 'time_invalid' });
				if (w.days !== undefined) {
					const valid =
						Array.isArray(w.days) &&
						w.days.length <= 7 &&
						new Set(w.days).size === w.days.length &&
						w.days.every((day) => DAYS.includes(/** @type {any} */ (day)));
					if (!valid) problems.push({ path: `${at}/days`, code: 'days_invalid' });
				}
			});
		}
	}
	return problems;
};
