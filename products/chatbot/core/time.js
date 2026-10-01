/**
 * Time in a zone (pure; `Intl` only): wall-clock parts, weekly working-hour windows (overnight windows belong to their
 * start day, `24:00` = end of day), the next opening, working-time arithmetic for SLAs and calendar month keys for
 * budgets.
 * @module
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Week days in `Intl` short English order, as working-hour windows name them. */
export const WEEK_DAYS = Object.freeze(/** @type {const} */ (['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']));

/** @typedef {(typeof WEEK_DAYS)[number]} WeekDay */
/** @typedef {{ days: string[], start: string, end: string }} HoursWindow */
/** @typedef {{ year: number, month: number, day: number, hour: number, minute: number, weekday: number }} LocalParts */

/** @type {Map<string, Intl.DateTimeFormat>} */
const formats = new Map();

/** @param {string} timeZone */
const formatFor = (timeZone) => {
	let format = formats.get(timeZone);
	if (!format) {
		format = new Intl.DateTimeFormat('en-US', {
			timeZone,
			hourCycle: 'h23',
			year: 'numeric',
			month: 'numeric',
			day: 'numeric',
			hour: 'numeric',
			minute: 'numeric',
			weekday: 'short',
		});
		formats.set(timeZone, format);
	}
	return format;
};

/**
 * True when the runtime knows `timeZone`.
 * @param {unknown} timeZone
 * @returns {timeZone is string}
 */
export const isTimeZone = (timeZone) => {
	if (typeof timeZone !== 'string' || timeZone.length === 0 || timeZone.length > 64) return false;
	try {
		formatFor(timeZone);
		return true;
	} catch {
		return false;
	}
};

/**
 * A known zone, else the fallback, else UTC.
 * @param {unknown} timeZone
 * @param {unknown} [fallback]
 * @returns {string}
 */
export const zoneOr = (timeZone, fallback = 'UTC') => {
	if (isTimeZone(timeZone)) return timeZone;
	return isTimeZone(fallback) ? fallback : 'UTC';
};

/**
 * Wall-clock parts of an instant in a zone.
 * @param {number} ms
 * @param {string} timeZone
 * @returns {LocalParts}
 */
export const localParts = (ms, timeZone) => {
	/** @type {Record<string, string>} */
	const parts = {};
	for (const part of formatFor(zoneOr(timeZone)).formatToParts(new Date(ms))) parts[part.type] = part.value;
	return {
		year: Number(parts.year),
		month: Number(parts.month),
		day: Number(parts.day),
		hour: Number(parts.hour),
		minute: Number(parts.minute),
		weekday: WEEK_DAYS.indexOf(/** @type {WeekDay} */ (String(parts.weekday).slice(0, 3).toLowerCase())),
	};
};

/**
 * `HH:MM` → minutes of the day (`24:00` = 1440), or null.
 * @param {unknown} text
 * @returns {number | null}
 */
export const minutesOf = (text) => {
	const match = typeof text === 'string' ? /^(\d{2}):(\d{2})$/.exec(text) : null;
	if (!match) return null;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (hours > 24 || minutes > 59 || (hours === 24 && minutes > 0)) return null;
	return hours * 60 + minutes;
};

/**
 * Is an instant inside the weekly windows? An empty list means always open. A window whose end is not after its start
 * runs past midnight and belongs to its start day.
 * @param {readonly HoursWindow[] | null | undefined} windows
 * @param {number} ms
 * @param {string} timeZone
 * @returns {boolean}
 */
export const isOpenAt = (windows, ms, timeZone) => {
	if (!windows || windows.length === 0) return true;
	const now = localParts(ms, timeZone);
	const minute = now.hour * 60 + now.minute;
	const today = WEEK_DAYS[now.weekday];
	const yesterday = WEEK_DAYS[(now.weekday + 6) % 7];
	return windows.some((slot) => {
		const start = minutesOf(slot.start);
		const end = minutesOf(slot.end);
		if (start === null || end === null || !Array.isArray(slot.days)) return false;
		if (end > start) return slot.days.includes(/** @type {string} */ (today)) && minute >= start && minute < end;
		// overnight (or 24 h when start === end): today's part and the tail of yesterday's slot
		return (
			(slot.days.includes(/** @type {string} */ (today)) && minute >= start) ||
			(slot.days.includes(/** @type {string} */ (yesterday)) && minute < end)
		);
	});
};

/**
 * The first open minute at or after `ms` (within `horizonDays`), or null when the windows never open.
 * @param {readonly HoursWindow[] | null | undefined} windows
 * @param {number} ms
 * @param {string} timeZone
 * @param {{ horizonDays?: number }} [options]
 * @returns {number | null}
 */
export const nextOpenAt = (windows, ms, timeZone, { horizonDays = 8 } = {}) => {
	if (isOpenAt(windows, ms, timeZone)) return ms;
	// minute steps: windows are minute-aligned, so a one-minute window is never skipped (≈ 11 520 checks for 8 days)
	for (let t = Math.ceil(ms / MINUTE_MS) * MINUTE_MS; t <= ms + horizonDays * DAY_MS; t += MINUTE_MS) {
		if (isOpenAt(windows, t, timeZone)) return t;
	}
	return null;
};

/**
 * `ms` plus `minutes` of working time (minute resolution, bounded); with no windows plain addition.
 * @param {readonly HoursWindow[] | null | undefined} windows
 * @param {number} ms
 * @param {number} minutes
 * @param {string} timeZone
 * @returns {number}
 */
export const addWorkingMinutes = (windows, ms, minutes, timeZone) => {
	if (!windows || windows.length === 0 || minutes <= 0) return ms + Math.max(0, minutes) * MINUTE_MS;
	let left = minutes;
	let t = ms;
	const limit = ms + 366 * DAY_MS;
	while (left > 0 && t < limit) {
		const open = nextOpenAt(windows, t, timeZone, { horizonDays: 8 });
		if (open === null) return ms + minutes * MINUTE_MS;
		t = open;
		while (left > 0 && isOpenAt(windows, t, timeZone) && t < limit) {
			t += MINUTE_MS;
			left -= 1;
		}
	}
	return t;
};

/**
 * Calendar month key `YYYY-MM` of an instant in a zone (monthly budgets).
 * @param {number} ms
 * @param {string} timeZone
 */
export const monthKey = (ms, timeZone) => {
	const { year, month } = localParts(ms, timeZone);
	return `${year}-${String(month).padStart(2, '0')}`;
};

/**
 * Calendar day key `YYYY-MM-DD` of an instant in a zone.
 * @param {number} ms
 * @param {string} timeZone
 */
export const dayKey = (ms, timeZone) => {
	const { year, month, day } = localParts(ms, timeZone);
	return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

/**
 * ISO timestamp.
 * @param {number} ms
 */
export const iso = (ms) => new Date(ms).toISOString();
