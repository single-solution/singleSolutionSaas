'use client';
/**
 * Times shown to people (owner 2026-10-14: computed in UTC, shown in each person's local time). The server and the
 * first render in the browser print UTC, so both print the same text; right after, the same date style shows in the
 * viewer's own time zone (`Oct 4, 2026, 2:30 PM UTC` → `Oct 4, 2026, 10:30 AM EDT`), with the UTC time on hover.
 * @module
 */
import { createContext, useContext, useSyncExternalStore } from 'react';
import { formatDateTime } from './format.js';

/**
 * The locale dates and numbers are shown in (fixed-choices audit K2): a product dashboard gives its website Format's
 * `locale` (`DisplayLocale`), so a website in `en-GB` or `de-DE` reads its own dates and numbers; the words stay US
 * English. US English outside a website (Defaults, the Portal) and when the Format leaves it to the viewer.
 */
const DisplayLocaleContext = createContext(/** @type {string} */ ('en-US'));

/**
 * Shows the dates and numbers inside in `locale` (empty: US English).
 * @param {{ locale: string | null | undefined, children: import('react').ReactNode }} props
 */
export function DisplayLocale({ locale, children }) {
	return <DisplayLocaleContext.Provider value={locale || 'en-US'}>{children}</DisplayLocaleContext.Provider>;
}

/** The locale dates and numbers are shown in. @returns {string} */
export const useDisplayLocale = () => useContext(DisplayLocaleContext);

/** The viewer's time zone never changes while a page is open: nothing to subscribe to. */
const noSubscription = () => () => {};
/** The browser's IANA time zone. */
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
/** No viewer on the server (and in the first render in the browser): UTC. */
const noZone = () => undefined;

/**
 * The viewer's IANA time zone in the browser; `undefined` (UTC) on the server and in the first render.
 * @returns {string | undefined}
 */
export const useViewerTimeZone = () => useSyncExternalStore(noSubscription, browserZone, noZone);

/**
 * An instant in the viewer's local time, in the one date style of the consoles and dashboards.
 * @param {{ value: string | number | Date | null | undefined }} props
 */
export function LocalTime({ value }) {
	const timeZone = useViewerTimeZone();
	const locale = useDisplayLocale();
	if (value === null || value === undefined || value === '') return <>—</>;
	const d = value instanceof Date ? value : new Date(/** @type {any} */ (value));
	if (Number.isNaN(d.getTime())) return <>—</>;
	const iso = d.toISOString();
	return (
		<time dateTime={iso} title={formatDateTime(value, { locale })}>
			{formatDateTime(value, timeZone ? { timeZone, locale } : { locale })}
		</time>
	);
}
