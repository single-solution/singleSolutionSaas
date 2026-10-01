/**
 * Pure placement evaluation (PLAN Part D §0 L7, `@ss/contracts` placement v1): paths, page types, devices, referrers,
 * schedule windows in the website's time zone, consent categories, selectors and the audience rule. Triggers and
 * frequency caps are stateful and live in the Loader. Every failure to evaluate means "does not match".
 * @module
 */
import { globMatch } from './util.js';

/** Default device breakpoints (CSS px, viewport width): below `tablet` is mobile, below `desktop` is tablet. */
export const DEFAULT_BREAKPOINTS = Object.freeze({ tablet: 768, desktop: 1024 });

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/**
 * @param {string} path
 * @returns {string}
 */
const normalisePath = (path) => {
	const bare = path.split(/[?#]/, 1)[0] || '/';
	return bare.length > 1 ? bare.replace(/\/+$/, '') || '/' : bare;
};

/**
 * Path globs: `*` matches within one segment, `**` across segments; trailing slashes are ignored.
 * @param {{ include?: ReadonlyArray<string>, exclude?: ReadonlyArray<string> } | undefined} paths
 * @param {string} path
 * @returns {boolean}
 */
export const matchPath = (paths, path) => {
	if (!paths) return true;
	const target = normalisePath(path);
	const hit = (/** @type {string} */ glob) => globMatch(normalisePath(glob), target, '/');
	if (paths.include && paths.include.length > 0 && !paths.include.some(hit)) return false;
	return !(paths.exclude ?? []).some(hit);
};

/**
 * @param {number} width viewport width in CSS px
 * @param {{ tablet: number, desktop: number }} [breakpoints]
 * @returns {'mobile' | 'tablet' | 'desktop'}
 */
export const deviceOf = (width, breakpoints = DEFAULT_BREAKPOINTS) =>
	width < breakpoints.tablet ? 'mobile' : width < breakpoints.desktop ? 'tablet' : 'desktop';

/**
 * Referrer host rules: `example.com` is exact, `*.example.com` matches any subdomain (not the apex).
 * An include list never matches a visit without a referrer.
 * @param {{ include?: ReadonlyArray<string>, exclude?: ReadonlyArray<string> } | undefined} referrers
 * @param {string | undefined} host lowercase referrer hostname
 * @returns {boolean}
 */
export const matchReferrer = (referrers, host) => {
	if (!referrers) return true;
	const hit = (/** @type {string} */ rule) =>
		host !== undefined &&
		(rule.startsWith('*.') ? host.endsWith(rule.slice(1)) && host.length > rule.length - 1 : host === rule);
	if (referrers.include && referrers.include.length > 0 && !referrers.include.some(hit)) return false;
	return !(referrers.exclude ?? []).some(hit);
};

/** @type {Map<string, Intl.DateTimeFormat>} */
const formatters = new Map();

/**
 * Local weekday (0 = Monday) and minute of day of `ms` in an IANA zone; throws on an unknown zone.
 * @param {number} ms
 * @param {string} timeZone
 * @returns {{ day: number, minute: number }}
 */
export const localTime = (ms, timeZone) => {
	let format = formatters.get(timeZone);
	if (!format) {
		format = new Intl.DateTimeFormat('en-US', {
			timeZone,
			weekday: 'short',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
		});
		formatters.set(timeZone, format);
	}
	/** @type {Record<string, string>} */
	const parts = {};
	for (const part of format.formatToParts(new Date(ms))) parts[part.type] = part.value;
	return {
		day: WEEKDAYS.indexOf(String(parts.weekday).slice(0, 3).toLowerCase()),
		minute: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
	};
};

/** @param {string} hhmm */
const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * Schedule: `[from, until)` instants plus optional weekly windows in `timezone`. A window with `start > end` crosses
 * midnight and belongs to the day it starts on (`fri 22:00–02:00` includes Saturday 01:00).
 * @param {{ timezone: string, from?: string, until?: string, windows?: ReadonlyArray<{ days?: ReadonlyArray<string>, start: string, end: string }> } | undefined} schedule
 * @param {number} now epoch ms
 * @returns {boolean}
 */
export const inSchedule = (schedule, now) => {
	if (!schedule) return true;
	try {
		if (schedule.from !== undefined && !(now >= Date.parse(schedule.from))) return false;
		if (schedule.until !== undefined && !(now < Date.parse(schedule.until))) return false;
		const { day, minute } = localTime(now, schedule.timezone);
		if (!schedule.windows || schedule.windows.length === 0) return true;
		const onDay = (/** @type {ReadonlyArray<string> | undefined} */ days, /** @type {number} */ index) =>
			days === undefined || days.includes(/** @type {string} */ (WEEKDAYS[(index + 7) % 7]));
		return schedule.windows.some(({ days, start, end }) => {
			const from = minutes(start);
			const to = minutes(end);
			if (from < to) return onDay(days, day) && minute >= from && minute < to;
			if (from > to) return (onDay(days, day) && minute >= from) || (onDay(days, day - 1) && minute < to);
			return false;
		});
	} catch {
		return false;
	}
};

/**
 * @typedef {object} PlacementEnv
 * @property {string} path
 * @property {string} [pageType]
 * @property {'mobile' | 'tablet' | 'desktop'} device
 * @property {string} [referrerHost]
 * @property {number} now epoch ms
 * @property {Readonly<Record<string, boolean>>} consent
 * @property {(selector: string) => boolean} [hasSelector]
 * @property {((audience: unknown, context: Record<string, unknown>, options: { now: number, timeZone: string }) => boolean) | undefined} [audience]
 * @property {Record<string, unknown>} [audienceContext]
 * @property {string} [timeZone] website time zone for the audience rule (default: schedule zone, else UTC)
 */

/**
 * @typedef {'path' | 'page_type' | 'device' | 'referrer' | 'schedule' | 'consent' | 'selector' | 'audience'} PlacementReason
 */

/**
 * Evaluate the static part of a placement (everything except triggers and frequency).
 * Checks run cheapest first; the first failing check is the reason.
 * @param {Record<string, any>} placement
 * @param {PlacementEnv} env
 * @returns {{ ok: true } | { ok: false, reason: PlacementReason }}
 */
export const matchPlacement = (placement, env) => {
	/** @param {PlacementReason} reason @returns {{ ok: false, reason: PlacementReason }} */
	const no = (reason) => ({ ok: false, reason });
	if (!matchPath(placement.paths, env.path)) return no('path');
	if (Array.isArray(placement.pageTypes) && placement.pageTypes.length > 0 && !placement.pageTypes.includes(env.pageType))
		return no('page_type');
	if (Array.isArray(placement.devices) && placement.devices.length > 0 && !placement.devices.includes(env.device))
		return no('device');
	if (!matchReferrer(placement.referrers, env.referrerHost)) return no('referrer');
	if (!inSchedule(placement.schedule, env.now)) return no('schedule');
	if (Array.isArray(placement.consent) && !placement.consent.every((category) => env.consent[category] === true))
		return no('consent');
	if (Array.isArray(placement.selectors) && placement.selectors.length > 0) {
		const present = placement.selectors.some((entry) => {
			try {
				return env.hasSelector?.(entry.selector) === true;
			} catch {
				return false;
			}
		});
		if (!present) return no('selector');
	}
	if (placement.audience !== undefined) {
		if (typeof env.audience !== 'function') return no('audience');
		try {
			const timeZone = env.timeZone ?? placement.schedule?.timezone ?? 'UTC';
			if (env.audience(placement.audience, env.audienceContext ?? {}, { now: env.now, timeZone }) !== true)
				return no('audience');
		} catch {
			return no('audience');
		}
	}
	return { ok: true };
};
