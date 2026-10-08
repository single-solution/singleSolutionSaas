/**
 * Bookings (PLAN 0.8.8: services booked in simple slots — a duration, weekly hours, no double booking). The merchant
 * keeps the weekly hours as the `booking_hours` list: `[{ day: 0–6 (0 = Sunday), from: 'HH:MM', to: 'HH:MM' }]`, in
 * the time zone of the website's business.json. A product's slots are back-to-back periods of its `durationMinutes`
 * from the start of each opening period, ending inside it. Booked slots are kept with a unique index (the ledger), so
 * one start of one product is booked once. Time-zone arithmetic uses `Intl` (no I/O); an unknown zone is read as UTC.
 * @module
 */

/** @typedef {{ day: number, from: string, to: string }} OpeningHours */

/** At most this many opening periods. */
const MAX_PERIODS = 70;
/** A slot list covers at most this many days. */
export const MAX_SLOT_DAYS = 14;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 86_400_000;

/** @param {string} time 'HH:MM' @returns {number} minutes after midnight ('24:00' = 1440) */
const minutesOf = (time) => (time === '24:00' ? 1440 : Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)));

/**
 * Check the list the merchant saves.
 * @param {unknown} value
 * @returns {{ ok: true, value: OpeningHours[] } | { ok: false, errors: string[] }}
 */
export const checkBookingHours = (value) => {
	if (!Array.isArray(value)) return { ok: false, errors: ['A list of opening hours is expected.'] };
	/** @type {string[]} */
	const errors = [];
	if (value.length > MAX_PERIODS) errors.push(`At most ${MAX_PERIODS} opening periods.`);
	/** @type {OpeningHours[]} */
	const out = [];
	for (const [index, raw] of value.slice(0, MAX_PERIODS).entries()) {
		const period = typeof raw === 'object' && raw !== null ? /** @type {Record<string, unknown>} */ (raw) : {};
		const label = `Opening period ${index + 1}`;
		const { day, from, to } = period;
		if (!Number.isSafeInteger(day) || Number(day) < 0 || Number(day) > 6) {
			errors.push(`${label}: the day is 0 (Sunday) to 6 (Saturday).`);
			continue;
		}
		if (typeof from !== 'string' || !TIME.test(from) || typeof to !== 'string' || !(TIME.test(to) || to === '24:00')) {
			errors.push(`${label}: times are HH:MM (24 hours).`);
			continue;
		}
		if (minutesOf(from) >= minutesOf(to)) {
			errors.push(`${label}: it must end after it starts.`);
			continue;
		}
		const overlaps = out.some(
			(other) => other.day === day && minutesOf(other.from) < minutesOf(to) && minutesOf(from) < minutesOf(other.to),
		);
		if (overlaps) errors.push(`${label} overlaps another period of the same day.`);
		out.push({ day: Number(day), from, to });
	}
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, value: out };
};

/** @type {Map<string, Intl.DateTimeFormat>} */
const formats = new Map();

/** @param {string} timeZone */
const newFormat = (timeZone) =>
	new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	});

/**
 * The wall-clock format of a time zone (an unknown zone reads as UTC).
 * @param {string} timeZone
 * @returns {Intl.DateTimeFormat}
 */
const formatOf = (timeZone) => {
	const known = formats.get(timeZone);
	if (known) return known;
	/** @type {Intl.DateTimeFormat} */
	let format;
	try {
		format = newFormat(timeZone);
	} catch {
		format = newFormat('UTC');
	}
	formats.set(timeZone, format);
	return format;
};

/**
 * The wall-clock date and time of an instant in a time zone.
 * @param {number} at epoch ms
 * @param {string} timeZone
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number, weekday: number }}
 */
export const wallClock = (at, timeZone) => {
	/** @type {Record<string, number>} */
	const parts = {};
	for (const part of formatOf(timeZone).formatToParts(new Date(at)))
		if (part.type !== 'literal') parts[part.type] = Number(part.value);
	const year = parts.year ?? 1970;
	const month = parts.month ?? 1;
	const day = parts.day ?? 1;
	return {
		year,
		month,
		day,
		hour: parts.hour ?? 0,
		minute: parts.minute ?? 0,
		second: parts.second ?? 0,
		weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
	};
};

/** The zone's offset from UTC at an instant, in ms. @param {number} at @param {string} timeZone */
const offsetAt = (at, timeZone) => {
	const w = wallClock(at, timeZone);
	return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - (at - (((at % 1000) + 1000) % 1000));
};

/**
 * The instant of a wall-clock time in a time zone (a time skipped by a clock change moves forward).
 * @param {{ year: number, month: number, day: number }} date
 * @param {number} minutes after midnight
 * @param {string} timeZone
 */
export const instantOf = (date, minutes, timeZone) => {
	const guess = Date.UTC(date.year, date.month - 1, date.day, 0, minutes);
	const first = guess - offsetAt(guess, timeZone);
	const second = guess - offsetAt(first, timeZone);
	return second;
};

/**
 * Every slot of a product between two instants: back-to-back periods of `durationMinutes` from the start of each
 * opening period, ending inside it, starting at or after `from` and before `to`.
 * @param {{ hours: OpeningHours[], durationMinutes: number, from: number, to: number, timeZone: string }} input epoch ms
 * @returns {Array<{ start: number, end: number }>}
 */
export const slotsBetween = ({ hours, durationMinutes, from, to, timeZone }) => {
	if (!(durationMinutes > 0) || to <= from || hours.length === 0) return [];
	/** @type {Array<{ start: number, end: number }>} */
	const out = [];
	const first = wallClock(from - DAY_MS, timeZone);
	const days = Math.ceil((to - from) / DAY_MS) + 2;
	for (let n = 0; n <= days; n += 1) {
		const noon = new Date(Date.UTC(first.year, first.month - 1, first.day + n, 12));
		const date = { year: noon.getUTCFullYear(), month: noon.getUTCMonth() + 1, day: noon.getUTCDate() };
		const weekday = noon.getUTCDay();
		for (const period of hours.filter((p) => p.day === weekday).sort((a, b) => minutesOf(a.from) - minutesOf(b.from))) {
			const close = minutesOf(period.to);
			for (let m = minutesOf(period.from); m + durationMinutes <= close; m += durationMinutes) {
				const start = instantOf(date, m, timeZone);
				if (start >= from && start < to) out.push({ start, end: start + durationMinutes * 60_000 });
			}
		}
	}
	const seen = new Set();
	return out.filter((slot) => (seen.has(slot.start) ? false : (seen.add(slot.start), true))).sort((a, b) => a.start - b.start);
};

/**
 * Whether `start` is the start of one of the product's slots.
 * @param {{ hours: OpeningHours[], durationMinutes: number, start: number, timeZone: string }} input
 * @returns {{ start: number, end: number } | null}
 */
export const slotAt = ({ hours, durationMinutes, start, timeZone }) =>
	slotsBetween({ hours, durationMinutes, from: start, to: start + 1, timeZone })[0] ?? null;
