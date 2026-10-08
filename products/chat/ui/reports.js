/**
 * The admin widget `reports` (permission `reports.read`): for a date range (default the last 30 days) the numbers of
 * Chat — conversations per day as a simple bar list, visitor messages, answered only by AI vs handed to a person,
 * median first staff reply, resolved, average rating, leads and AI tokens.
 * @module
 */
import { formatText, mountWidget } from '@ss/app-kit/widget';
import { fieldMaker, invalidText, textsOf } from './common.js';
import { element } from './dom.js';
import { WIDGET_CSS } from './styles.js';
import { adminCall } from './tickets.js';

const DAY_MS = 86_400_000;

/**
 * `YYYY-MM-DD` of a time in the browser's time zone.
 * @param {number} time
 */
const isoDate = (time) => {
	const date = new Date(time);
	const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/**
 * @param {{ host: HTMLElement, api: import('./tickets.js').AdminApi, config: import('./common.js').WidgetConfig,
 *   now: () => number }} input
 */
export const mountReports = ({ host, api, config, now }) => {
	const t = textsOf(config);
	/** @param {unknown} value */
	const number = (value) => (typeof value === 'number' ? value.toLocaleString() : t('reports.none'));
	/** @param {unknown} seconds */
	const duration = (seconds) => {
		if (typeof seconds !== 'number') return t('reports.none');
		const minutes = Math.floor(seconds / 60);
		return minutes > 0
			? formatText(t('reports.minutes'), { minutes, seconds: Math.round(seconds % 60) })
			: formatText(t('reports.seconds'), { seconds: Math.round(seconds) });
	};

	return mountWidget({
		host,
		theme: config.theme,
		customCss: config.customCss,
		css: WIDGET_CSS,
		render: (root) => {
			const doc = /** @type {Document} */ (root.ownerDocument);
			const make = fieldMaker(doc, 'ss-reports');
			const form = element(doc, 'form', { class: 'row' });
			const from = make.field('input', t('reports.from'), { type: 'date', required: '' });
			const to = make.field('input', t('reports.to'), { type: 'date', required: '' });
			from.input.value = isoDate(now() - 29 * DAY_MS);
			to.input.value = isoDate(now());
			form.append(from.wrap, to.wrap, element(doc, 'button', { type: 'submit' }, t('reports.show')));
			const note = element(doc, 'p', { class: 'status', role: 'status' });
			const numbers = element(doc, 'dl', { class: 'numbers' });
			const days = element(doc, 'ul', { class: 'bars' });
			const box = element(doc, 'section', { class: 'box' });
			box.append(element(doc, 'h2', {}, t('reports.title')), form, note, numbers, days);
			root.append(box);

			const load = async () => {
				const query = new URLSearchParams({ from: from.input.value, to: to.input.value });
				const answer = await adminCall(api, 'GET', `/v1/admin/reports?${query.toString()}`);
				if (!answer.ok) {
					numbers.replaceChildren();
					days.replaceChildren();
					note.textContent =
						answer.status === 0 && !api.tickets.current()
							? t('reports.signedOut')
							: answer.status === 403
								? t('reports.noAccess')
								: invalidText(answer) || t('common.error');
					return;
				}
				const data = answer.data;
				/** @type {Array<{ date: string, conversations: number }>} */
				const perDay = Array.isArray(data.days) ? data.days : [];
				const rating = data.rating ?? {};
				/** @type {Array<[string, string]>} */
				const rows = [
					[t('reports.conversations'), number(perDay.reduce((sum, day) => sum + day.conversations, 0))],
					[t('reports.visitorMessages'), number(data.visitorMessages)],
					[t('reports.aiOnly'), number(data.aiOnly)],
					[t('reports.handedOff'), number(data.handedOff)],
					[t('reports.firstReply'), duration(data.medianFirstReplySeconds)],
					[t('reports.resolved'), number(data.resolved)],
					[
						t('reports.rating'),
						typeof rating.average === 'number'
							? formatText(t('reports.ratingValue'), { average: rating.average.toFixed(1), count: rating.count })
							: t('reports.none'),
					],
					[t('reports.leads'), number(data.leads)],
					[t('reports.aiTokens'), number(data.aiTokens)],
				];
				numbers.replaceChildren(
					...rows.flatMap(([label, value]) => [element(doc, 'dt', {}, label), element(doc, 'dd', {}, value)]),
				);
				const most = Math.max(1, ...perDay.map((day) => day.conversations));
				days.replaceChildren(
					element(doc, 'li', { class: 'meta' }, t('reports.perDay')),
					...perDay.map((day) => {
						const item = element(doc, 'li');
						const bar = element(doc, 'span', { class: 'bar' });
						bar.style.width = `${Math.round((day.conversations / most) * 100)}%`;
						item.append(
							element(doc, 'span', { class: 'date' }, day.date),
							bar,
							element(doc, 'span', {}, String(day.conversations)),
						);
						return item;
					}),
				);
				note.textContent = data.timeZone ? formatText(t('reports.timeZone'), { zone: data.timeZone }) : '';
			};
			form.addEventListener('submit', (event) => {
				event.preventDefault();
				void load();
			});
			void load();
		},
	});
};
