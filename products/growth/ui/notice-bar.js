/**
 * The notice bar (visitor widget `notice_bar`; PLAN 0.8.9): the merchant's text and optional link, shown while the
 * dates of its settings say so (the server checks them when the page loads). A visitor who closes it does not see the
 * same text again during the visit (sessionStorage).
 * @module
 */
import { mountWidget } from '@ss/app-kit/widget';
import { element } from './dom.js';
import { WIDGET_CSS } from './styles.js';

/** Where a closed notice is remembered for the visit. */
export const NOTICE_STORAGE_KEY = 'ss-growth-notice-closed';

/**
 * @param {{ host: HTMLElement, config: import('./widget.js').WidgetConfig, visits: import('./consent.js').KeyValue }} input
 * @returns {boolean} whether it is shown
 */
export const mountNoticeBar = ({ host, config, visits }) => {
	const notice = config.settings.notice;
	if (!notice || visits.getItem(NOTICE_STORAGE_KEY) === notice.text) return false;
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
					try {
						visits.setItem(NOTICE_STORAGE_KEY, notice.text);
					} catch {
						// closed for this page only
					}
					mounted.unmount();
					host.remove();
				});
				bar.append(close);
			}
			root.append(bar);
		},
	});
	return true;
};
