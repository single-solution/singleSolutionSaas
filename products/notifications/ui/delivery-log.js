/**
 * The admin widget `delivery_log` (permission `log.read`): the merchant's staff read the delivery log in their own
 * admin, newest first, filtered by status, channel and recipient, page by page, with the number of messages per status
 * (the log's counts, PLAN 0.8.10 K4). Each message opens to its words and every attempt. Times follow the website's
 * Format and business time zone from the widget config (PLAN 0.8.10 K7). A skip's reason shows in the website's words;
 * a failure shows the provider's own error.
 * @module
 */
import { adminCall, element, formatDate, formatText, mountWidget, viewerOf } from '@ss/app-kit/widget';
import { CHANNELS } from '../core/channels.js';
import { STATUSES } from '../core/log.js';
import { logReason } from './problems.js';
import { WIDGET_CSS } from './styles.js';

/**
 * @param {{ host: HTMLElement, api: import('@ss/app-kit/widget').AdminApi, config: import('./widget.js').WidgetConfig }} input
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
			const to = /** @type {HTMLInputElement} */ (
				element(doc, 'input', { type: 'search', 'aria-label': t('log.to'), placeholder: t('log.to'), maxlength: '254' })
			);
			const total = element(doc, 'p', { class: 'count' });
			const note = element(doc, 'p', { class: 'status', role: 'status' });
			const list = element(doc, 'ul');
			const more = element(doc, 'button', { type: 'button', class: 'secondary', hidden: '' }, t('log.more'));
			const filters = element(doc, 'div', { class: 'row' });
			filters.append(status, channel, to);
			const box = element(doc, 'section', { class: 'box' });
			box.append(element(doc, 'h2', {}, t('log.title')), filters, total, note, list, more);
			/** The status options' own names, before their counts. */
			const statusNames = new Map(STATUSES.map((value) => [String(value), t(`status.${value}`)]));

			/**
			 * The number of messages per status for the channel and recipient picked (badges on the status filter) and the
			 * total of the list shown.
			 * @param {URLSearchParams} query the list's filters
			 */
			const count = async (query) => {
				const filters = new URLSearchParams(query);
				filters.delete('status');
				filters.delete('limit');
				filters.set('by', 'status');
				const answer = await adminCall(api, 'GET', `/v1/admin/messages/counts?${filters.toString()}`);
				if (!answer.ok) {
					total.textContent = '';
					return;
				}
				/** @type {{ total: number, groups: Record<string, number> }} */
				const counts = answer.data;
				for (const option of status.querySelectorAll('option'))
					option.textContent =
						option.value === ''
							? formatText(t('log.allCount'), { count: counts.total })
							: formatText(t('log.statusCount'), {
									status: statusNames.get(option.value) ?? option.value,
									count: counts.groups[option.value] ?? 0,
								});
				total.textContent = formatText(t('log.total'), {
					count: status.value ? (counts.groups[status.value] ?? 0) : counts.total,
				});
			};

			/**
			 * A message, opened: its words and every attempt.
			 * @param {{ id: string, source: string, subject: string, text: string, reason: string | null, dueAt: string,
			 *   sentAt: string | null, attempts: Array<{ channel: string, provider: string, at: string, outcome: string, error?: string }> }} message
			 */
			const detailOf = (message) => {
				const fields = element(doc, 'dl');
				/** @param {string} label @param {string} value */
				const row = (label, value) => {
					if (value !== '') fields.append(element(doc, 'dt', {}, label), element(doc, 'dd', {}, value));
				};
				row(t('log.subject'), message.subject);
				row(t('log.text'), message.text);
				row(t('log.source'), t(`log.source.${message.source}`));
				row(t('log.due'), message.sentAt ? '' : when(message.dueAt));
				row(t('log.sentAt'), message.sentAt ? when(message.sentAt) : '');
				row(t('log.reason'), logReason(config.texts, message));
				row(
					t('log.attemptList'),
					message.attempts
						.map((attempt) =>
							[
								when(attempt.at),
								t(`channel.${attempt.channel}`),
								attempt.provider,
								t(`log.outcome.${attempt.outcome}`),
								attempt.error ?? '',
							]
								.filter((part) => part !== '')
								.join(' · '),
						)
						.join('\n'),
				);
				row(t('log.id'), message.id);
				return fields;
			};
			root.append(box);
			/** @type {string | null} */
			let cursor = null;

			/** @param {boolean} reset */
			const load = async (reset) => {
				const query = new URLSearchParams({ limit: '25' });
				if (status.value) query.set('status', status.value);
				if (channel.value) query.set('channel', channel.value);
				if (to.value.trim()) query.set('to', to.value.trim());
				if (reset) void count(query);
				if (!reset && cursor) query.set('cursor', cursor);
				const answer = await adminCall(api, 'GET', `/v1/admin/messages?${query.toString()}`);
				if (reset) list.replaceChildren();
				if (!answer.ok) {
					note.textContent = answer.status === 0 && !api.tickets.current() ? t('log.signedOut') : t('log.failed');
					more.setAttribute('hidden', '');
					return;
				}
				/** @type {Array<Parameters<typeof detailOf>[0] & { template: string | null, channel: string, to: string, status: string, createdAt: string }>} */
				const items = answer.data.items;
				cursor = answer.data.nextCursor;
				note.textContent = reset && items.length === 0 ? t('log.empty') : '';
				for (const message of items) {
					const item = element(doc, 'li');
					const opened = element(doc, 'details');
					const summary = element(doc, 'summary', {}, `${message.to} · ${message.template ?? t('log.oneOff')}`);
					opened.append(summary, detailOf(message));
					item.append(opened);
					summary.append(
						element(
							doc,
							'span',
							{ class: 'meta' },
							[
								t(`channel.${message.channel}`),
								t(`status.${message.status}`),
								formatText(t(message.attempts.length === 1 ? 'log.attempt' : 'log.attempts'), {
									count: message.attempts.length,
								}),
								when(message.createdAt),
								logReason(config.texts, message),
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
			to.addEventListener('change', () => void load(true));
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
