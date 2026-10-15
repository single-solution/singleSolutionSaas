/**
 * The notice bar (visitor widget `notice_bar`; PLAN 0.8.9, G4): the first of the merchant's announcements showing now
 * (the server checks their times when the page loads) that applies to the page — its pages name it and its hidden
 * pages do not (also after a single-page app's own navigation, SG-4) — and that the visitor has not closed. A closed
 * announcement stays closed until the visitor opens another page, for the rest of the visit (sessionStorage) or for
 * its number of days (localStorage), as the merchant set.
 * @module
 */
import { element, mountWidget } from '@ss/app-kit/widget';
import { appliesTo } from '../core/notices.js';
import { WIDGET_CSS } from './styles.js';

/** Where closed announcements are remembered (with their text, so a changed one shows again). */
export const NOTICE_STORAGE_KEY = 'ss-growth-notice-closed';

const DAY_MS = 86_400_000;

/** @typedef {import('../core/notices.js').Notice} Notice */

/**
 * The closed announcements a store remembers: `{ <key>: { text, until? } }`.
 * @param {import('./consent.js').KeyValue} store
 * @returns {Record<string, { text: string, until?: number }>}
 */
const closedIn = (store) => {
	try {
		const value = JSON.parse(store.getItem(NOTICE_STORAGE_KEY) ?? '{}');
		return typeof value === 'object' && value !== null ? value : {};
	} catch {
		return {};
	}
};

/**
 * Whether the visitor closed this announcement (as it reads now) and it stays closed.
 * @param {Notice} notice
 * @param {{ visits: import('./consent.js').KeyValue, kept: import('./consent.js').KeyValue, now: number }} stores
 */
export const isClosed = (notice, { visits, kept, now }) => {
	if (notice.dismiss === 'page') return false;
	const found = closedIn(notice.dismiss === 'days' ? kept : visits)[notice.key];
	return found?.text === notice.text && (notice.dismiss !== 'days' || Number(found.until) > now);
};

/**
 * The announcement a page shows: the first that applies to it and is not closed.
 * @param {ReadonlyArray<Notice>} notices
 * @param {string} path
 * @param {{ visits: import('./consent.js').KeyValue, kept: import('./consent.js').KeyValue, now: number }} stores
 * @returns {Notice | null}
 */
export const noticeOnPage = (notices, path, stores) =>
	notices.find((notice) => appliesTo(notice, path) && !isClosed(notice, stores)) ?? null;

/**
 * @param {{ host: HTMLElement, config: import('./widget.js').WidgetConfig, notice: Notice,
 *   stores: { visits: import('./consent.js').KeyValue, kept: import('./consent.js').KeyValue, now: number },
 *   onClose: () => void }} input `onClose`: the visitor closed it
 * @returns {() => void} takes the bar away (its host stays for the next page)
 */
export const mountNoticeBar = ({ host, config, notice, stores, onClose }) => {
	/** @param {string} key */
	const t = (key) => config.texts[key] ?? key;
	const mounted = mountWidget({
		host,
		theme: config.theme,
		customCss: config.customCss,
		css: WIDGET_CSS,
		render: (root) => {
			const doc = root.ownerDocument;
			const bar = element(doc, 'div', { class: 'notice', role: 'region', 'aria-label': t('notice.label') });
			bar.append(element(doc, 'span', {}, notice.text));
			if (notice.linkUrl) bar.append(element(doc, 'a', { href: notice.linkUrl }, notice.linkText || notice.linkUrl));
			if (notice.dismissible) {
				const close = element(doc, 'button', { type: 'button', 'aria-label': t('notice.close') }, '×');
				close.addEventListener('click', () => {
					if (notice.dismiss !== 'page') {
						const store = notice.dismiss === 'days' ? stores.kept : stores.visits;
						try {
							store.setItem(
								NOTICE_STORAGE_KEY,
								JSON.stringify({
									...closedIn(store),
									[notice.key]: {
										text: notice.text,
										...(notice.dismiss === 'days' ? { until: stores.now + notice.dismissDays * DAY_MS } : {}),
									},
								}),
							);
						} catch {
							// closed for this page only
						}
					}
					mounted.unmount();
					host.remove();
					onClose();
				});
				bar.append(close);
			}
			root.append(bar);
		},
	});
	return () => mounted.unmount();
};
