/**
 * The admin widget `inbox`: the merchant's staff read the notes in their own admin, with a ticket from the page's
 * `getTicket()` (the kit's ticket source: kept in memory only, the first one from `admin()`, which used it for the
 * widget config, renewed 1 minute before it expires). It reloads the notes with each new ticket and shows
 * `Signed out` when the page cannot give one.
 * @module
 */
import { adminCall, createTicketSource, element, formatText, mountWidget } from '@ss/app-kit/widget';
import { WIDGET_CSS } from './styles.js';

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
			const tickets = createTicketSource({ first, getTicket, schedule, cancel, now });

			const load = async () => {
				if (tickets.current() === null) {
					list.replaceChildren();
					status.textContent = t('inbox.signedOut');
					return;
				}
				const answer = await adminCall({ base, tickets, fetch }, 'GET', '/v1/admin/notes');
				if (!answer.ok) {
					status.textContent = t('inbox.failed');
					return;
				}
				const { items } = /** @type {{ items: Note[] }} */ (answer.data);
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
			};

			const stopReloading = tickets.onChange(() => void load());
			void load();
			return () => {
				stopReloading();
				tickets.stop();
			};
		},
	});
};
