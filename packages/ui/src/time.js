'use client';
/**
 * Times shown to people (owner 2026-10-14: computed in UTC, shown in each person's local time). The server and the
 * first render in the browser print UTC, so both print the same text; right after, the same date style shows in the
 * viewer's own time zone (`Oct 4, 2026, 2:30 PM UTC` → `Oct 4, 2026, 10:30 AM EDT`), with the UTC time on hover.
 * @module
 */
import { useSyncExternalStore } from 'react';
import { formatDateTime } from './format.js';

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
	if (value === null || value === undefined || value === '') return <>—</>;
	const iso = new Date(value).toISOString();
	return (
		<time dateTime={iso} title={formatDateTime(value)}>
			{formatDateTime(value, timeZone ? { timeZone } : {})}
		</time>
	);
}
