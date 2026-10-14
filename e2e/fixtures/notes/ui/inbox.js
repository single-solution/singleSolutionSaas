/**
 * The admin widget `inbox`: the merchant's staff read the notes in their own admin, with a ticket from the page's
 * `getTicket()` (kept in memory only; the first one comes from `admin()`, which used it for the widget config). It
 * asks for a new ticket 1 minute before one expires, reloading the notes each time, and shows `Signed out` when the
 * page cannot give one.
 * @module
 */
import { formatText, mountWidget } from '@ss/app-kit/widget';
import { element } from './dom.js';
import { WIDGET_CSS } from './styles.js';

/** A new ticket is asked for this long before the current one expires. */
export const REFRESH_BEFORE_MS = 60_000;

/** @typedef {{ id: string, text: string, email: string | null, createdAt: string }} Note */

/**
 * @param {{ host: HTMLElement, base: string, first: import('./widget.js').Ticket, getTicket: import('./widget.js').GetTicket,
 *   config: import('./widget.js').WidgetConfig, fetch: typeof fetch, schedule: (task: () => void, ms: number) => number,
 *   cancel: (id: number) => void, now: () => number }} input
 */
export const mountInbox = ({ host, base, first, getTicket, config, fetch, schedule, cancel, now }) => {
	/** @param {string} key */
	const t = (key) => config.texts[key] ?? key;
	return mountWidget({
		host,
		theme: config.theme,
		customCss: config.customCss,
		css: WIDGET_CSS,
		render: (root) => {
			const doc = /** @type {Document} */ (root.ownerDocument);
			const box = element(doc, 'section', { class: 'box' });
			const status = element(doc, 'p', { class: 'status', role: 'status' });
			const list = element(doc, 'ul');
			box.append(element(doc, 'h2', {}, t('inbox.title')), status, list);
			root.append(box);
			/** @type {number | null} */
			let timer = null;
			/** @type {import('./widget.js').Ticket | null} */
			let pending = first;

			const cycle = async () => {
				/** @type {string} */
				let ticket;
				try {
					const got = pending ?? (await getTicket());
					pending = null;
					if (typeof got?.ticket !== 'string') throw new Error('no ticket');
					ticket = got.ticket;
					timer = schedule(() => void cycle(), Math.max(0, Date.parse(got.expiresAt) - now() - REFRESH_BEFORE_MS));
				} catch {
					list.replaceChildren();
					status.textContent = t('inbox.signedOut');
					return;
				}
				try {
					const response = await fetch(`${base}/v1/admin/notes`, { headers: { authorization: `Bearer ${ticket}` } });
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const { items } = /** @type {{ items: Note[] }} */ (await response.json());
					status.textContent = items.length === 0 ? t('inbox.empty') : formatText(t('inbox.count'), { count: items.length });
					list.replaceChildren(
						...items.map((note) => {
							const item = element(doc, 'li', {}, note.text);
							item.append(
								element(
									doc,
									'span',
									{ class: 'meta' },
									`${note.email ?? t('inbox.anonymous')} · ${new Date(note.createdAt).toLocaleString()}`,
								),
							);
							return item;
						}),
					);
				} catch {
					status.textContent = t('inbox.failed');
				}
			};

			void cycle();
			return () => {
				if (timer !== null) cancel(timer);
			};
		},
	});
};
