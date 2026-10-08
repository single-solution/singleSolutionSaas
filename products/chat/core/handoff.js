/**
 * Handoff (pure, PLAN 0.8.3 Handoff), as in ibrahimMobiles: the visitor asks (button or phrases), a keyword matches, the
 * AI escalates, or N AI failures happen in a row. Office hours are lines such as `mon-fri 09:00-17:00` in the
 * business.json time zone; outside them the visitor is told when staff are back.
 * @module
 */
import { containsPhrase } from './text.js';
import { WEEK_DAYS, isOpenAt, nextOpenAt } from './time.js';

/** @typedef {import('./time.js').HoursWindow} HoursWindow */

/**
 * Why a visitor message hands off, or null: the visitor asks for a person, or a handoff keyword matches.
 * @param {string} text
 * @param {{ askPhrases: string[], keywords: string[] }} settings
 * @returns {'asked' | 'keyword' | null}
 */
export const handoffReason = (text, { askPhrases, keywords }) => {
	if (askPhrases.some((phrase) => containsPhrase(text, phrase))) return 'asked';
	if (keywords.some((keyword) => containsPhrase(text, keyword))) return 'keyword';
	return null;
};

/**
 * Parse office-hour lines (`mon-fri 09:00-17:00`, `sat 10:00-14:00`, `sun,wed 18:00-02:00`); bad lines are dropped.
 * @param {readonly string[]} lines
 * @returns {HoursWindow[]}
 */
export const parseOfficeHours = (lines) =>
	lines.flatMap((line) => {
		const match = /^\s*([a-z,-]+)\s+(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})\s*$/i.exec(line);
		if (!match) return [];
		/** @type {string[]} */
		const days = [];
		for (const part of String(match[1]).toLowerCase().split(',')) {
			const [from, to = from] = part.split('-');
			const a = WEEK_DAYS.indexOf(/** @type {any} */ (from));
			const b = WEEK_DAYS.indexOf(/** @type {any} */ (to));
			if (a < 0 || b < 0) return [];
			for (let i = a; ; i = (i + 1) % 7) {
				days.push(/** @type {string} */ (WEEK_DAYS[i]));
				if (i === b) break;
			}
		}
		return [{ days, start: String(match[2]), end: String(match[3]) }];
	});

/**
 * Whether staff are in now and, when not, when they are back.
 * @param {readonly HoursWindow[]} windows empty = always open
 * @param {number} now
 * @param {string} timeZone
 * @returns {{ open: boolean, backAt: number | null }}
 */
export const officeState = (windows, now, timeZone) =>
	isOpenAt(windows, now, timeZone) ? { open: true, backAt: null } : { open: false, backAt: nextOpenAt(windows, now, timeZone) };

/**
 * A time for the visitor, in the business time zone (`Mon 09:00`).
 * @param {number} ms
 * @param {string} timeZone
 */
export const backAtText = (ms, timeZone) =>
	new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
		new Date(ms),
	);
