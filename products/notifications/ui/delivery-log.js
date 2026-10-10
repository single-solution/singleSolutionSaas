/**
 * The admin widget `delivery_log` (permission `log.read`): the merchant's staff read the delivery log in their own
 * admin, newest first, filtered by status and channel, page by page. Times follow the website's Format and business
 * time zone from the widget config (PLAN 0.8.10 K7).
 * @module
 */
import { formatDate, formatText, mountWidget, viewerOf } from '@ss/app-kit/widget';
import { CHANNELS } from '../core/channels.js';
import { STATUSES } from '../core/log.js';
import { element } from './dom.js';
import { WIDGET_CSS } from './styles.js';
import { adminCall } from './tickets.js';

/**
 * @param {{ host: HTMLElement, api: import('./tickets.js').AdminApi, config: import('./widget.js').WidgetConfig }} input
 */
export const mountDeliveryLog = ({ host, api, config }) => {
	/** @param {string} key */
	const t = (key) => config.texts[key] ?? key;
	const viewer = viewerOf(host.ownerDocument.defaultView);
	/** @param {string} value an ISO-8601 time */
	const when = (value) => formatDate(value, config.format, { timeZone: config.timeZone, style: 'datetime', viewer });
	return mountWidget({
		host,
		theme: config.theme,
		customCss: config.customCss,
		css: WIDGET_CSS,
		render: (root) => {
			const doc = /** @type {Document} */ (root.ownerDocument);
			/** @param {string} label @param {ReadonlyArray<string>} values @param {(value: string) => string} name */
			const select = (label, values, name) => {
				const field = element(doc, 'select', { 'aria-label': label });
				field.append(
					element(doc, 'option', { value: '' }, t('log.all')),
					...values.map((value) => element(doc, 'option', { value }, name(value))),
				);
				return /** @type {HTMLSelectElement} */ (field);
			};
			const status = select(t('log.status'), STATUSES, (value) => t(`status.${value}`));
			const channel = select(t('log.channel'), CHANNELS, (value) => t(`channel.${value}`));
			const note = element(doc, 'p', { class: 'status', role: 'status' });
			const list = element(doc, 'ul');
			const more = element(doc, 'button', { type: 'button', class: 'secondary', hidden: '' }, t('log.more'));
			const filters = element(doc, 'div', { class: 'row' });
			filters.append(status, channel);
			const box = element(doc, 'section', { class: 'box' });
			box.append(element(doc, 'h2', {}, t('log.title')), filters, note, list, more);
			root.append(box);
			/** @type {string | null} */
			let cursor = null;

			/** @param {boolean} reset */
			const load = async (reset) => {
				const query = new URLSearchParams({ limit: '25' });
				if (status.value) query.set('status', status.value);
				if (channel.value) query.set('channel', channel.value);
				if (!reset && cursor) query.set('cursor', cursor);
				const answer = await adminCall(api, 'GET', `/v1/admin/messages?${query.toString()}`);
				if (reset) list.replaceChildren();
				if (!answer.ok) {
					note.textContent = answer.status === 0 && !api.tickets.current() ? t('log.signedOut') : t('log.failed');
					more.setAttribute('hidden', '');
					return;
				}
				/** @type {Array<{ template: string | null, channel: string, to: string, status: string, reason: string | null, attempts: unknown[], createdAt: string }>} */
				const items = answer.data.items;
				cursor = answer.data.nextCursor;
				note.textContent = reset && items.length === 0 ? t('log.empty') : '';
				for (const message of items) {
					const item = element(doc, 'li', {}, `${message.to} · ${message.template ?? t('log.oneOff')}`);
					item.append(
						element(
							doc,
							'span',
							{ class: 'meta' },
							[
								t(`channel.${message.channel}`),
								t(`status.${message.status}`),
								formatText(t('log.attempts'), { count: message.attempts.length }),
								when(message.createdAt),
								message.reason ?? '',
							]
								.filter((part) => part !== '')
								.join(' · '),
						),
					);
					list.append(item);
				}
				if (answer.data.hasMore) more.removeAttribute('hidden');
				else more.setAttribute('hidden', '');
			};
			status.addEventListener('change', () => void load(true));
			channel.addEventListener('change', () => void load(true));
			more.addEventListener('click', () => void load(false));
			const off = api.tickets.onChange((signedIn) => {
				if (!signedIn) {
					list.replaceChildren();
					note.textContent = t('log.signedOut');
				}
			});
			void load(true);
			return () => void off();
		},
	});
};
