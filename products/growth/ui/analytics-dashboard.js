/**
 * The analytics dashboard (admin widget `analytics_dashboard`, ticket `analytics.read`; PLAN 0.8.9): for a range of
 * days (the last 30 by default), visits as the hero card with a bar per day, page views, top pages, sources, devices
 * and countries; with the other features on, the funnel and revenue, searches and 404s, and Web Vitals. In the
 * dashboards' style (PLAN 0.6 "A + B"); every word is a widget text.
 * @module
 */
import { mountWidget } from '@ss/app-kit/widget';
import { toMajor } from '../core/money.js';
import { DIRECT, UNKNOWN } from '../core/events.js';
import { adminCall } from './tickets.js';
import { element } from './dom.js';
import { WIDGET_CSS } from './styles.js';

/** @typedef {import('../core/analytics.js').Report} Report */

/**
 * Fill `{name}` placeholders.
 * @param {string} text @param {Record<string, string | number>} values
 */
const fill = (text, values) =>
	text.replace(/\{(\w+)\}/g, (match, key) => (Object.hasOwn(values, key) ? String(values[key]) : match));

/** @param {number} at */
const dayText = (at) => new Date(at).toISOString().slice(0, 10);

/**
 * @param {{ host: HTMLElement, api: import('./tickets.js').AdminApi, config: import('./widget.js').WidgetConfig,
 *   now: () => number }} input
 */
export const mountAnalyticsDashboard = ({ host, api, config, now }) => {
	/** @param {string} key @param {Record<string, string | number>} [values] */
	const t = (key, values) => fill(config.texts[key] ?? key, values ?? {});
	return mountWidget({
		host,
		theme: config.theme,
		customCss: config.customCss,
		css: WIDGET_CSS,
		render: (root) => {
			const doc = root.ownerDocument;
			/** @param {string} tag @param {Record<string, string>} [attributes] @param {string} [text] */
			const h = (tag, attributes, text) => element(doc, tag, attributes, text);
			const from = /** @type {HTMLInputElement} */ (h('input', { type: 'date', id: 'ss-growth-from' }));
			const to = /** @type {HTMLInputElement} */ (h('input', { type: 'date', id: 'ss-growth-to' }));
			to.value = dayText(now());
			from.value = dayText(now() - 29 * 86_400_000);
			const show = h('button', { type: 'submit' }, t('analytics.show'));
			const form = h('form', { class: 'row' });
			const fromField = h('div');
			fromField.append(h('label', { for: 'ss-growth-from' }, t('analytics.from')), from);
			const toField = h('div');
			toField.append(h('label', { for: 'ss-growth-to' }, t('analytics.to')), to);
			form.append(fromField, toField, show);
			const head = h('div', { class: 'head' });
			head.append(h('h2', {}, t('analytics.title')), form);
			const status = h('p', { class: 'status', role: 'status' });
			const body = h('div');
			const box = h('section', { class: 'box' });
			box.append(head, status, body);
			root.append(box);

			/** @param {string} label @param {string | number} value @param {string} tone @param {string} badge */
			const tile = (label, value, tone, badge) => {
				const node = h('div', { class: `tile ${tone}` });
				node.append(
					h('span', { class: 'badge', 'aria-hidden': 'true' }, badge),
					h('span', { class: 'value' }, String(value)),
				);
				node.append(h('span', { class: 'label' }, label));
				return node;
			};
			/** @param {string} title @param {Array<{ key: string, count: number }>} rows @param {(key: string) => string} [name] @param {string} [tone] */
			const list = (title, rows, name = (key) => key, tone = 'sky') => {
				const node = h('div', { class: `tile ${tone}` });
				node.append(h('h3', {}, title));
				const items = h('ul', { class: 'list' });
				if (rows.length === 0) items.append(h('li', {}, t('analytics.none')));
				for (const row of rows) {
					const item = h('li');
					item.append(h('span', {}, name(row.key)), h('span', {}, String(row.count)));
					items.append(item);
				}
				node.append(items);
				return node;
			};
			/** @param {string} title @param {HTMLElement[]} nodes */
			const section = (title, nodes) => {
				const node = h('div', { class: 'section' });
				const grid = h('div', { class: 'grid' });
				grid.append(...nodes);
				node.append(h('h3', {}, title), grid);
				return node;
			};

			/** @param {Report} report */
			const draw = (report) => {
				const hero = h('div', { class: 'hero' });
				hero.append(
					h('span', { class: 'label' }, t('analytics.visits')),
					h('span', { class: 'value' }, String(report.totals.visits)),
				);
				const bars = h('div', { class: 'bars', role: 'img', 'aria-label': t('analytics.perDay') });
				const most = Math.max(1, ...report.days.map((day) => day.visits));
				for (const day of report.days)
					bars.append(
						h('span', {
							style: `height: ${Math.max(2, Math.round((day.visits / most) * 100))}%`,
							title: `${day.day}: ${day.visits}`,
						}),
					);
				hero.append(bars);
				const overview = h('div', { class: 'grid' });
				overview.append(
					hero,
					tile(t('analytics.pageViews'), report.totals.pageViews, 'teal', 'P'),
					...(report.funnel
						? report.funnel.revenue.map((entry) =>
								tile(
									`${t('analytics.revenue')} · ${t('analytics.orders', { count: entry.orders })}`,
									`${entry.currency} ${toMajor(entry.value, entry.currency).toLocaleString()}`,
									'pink',
									'$',
								),
							)
						: []),
				);
				const parts = [overview];
				if (report.totals.visits === 0 && report.totals.pageViews === 0)
					parts.push(h('p', { class: 'lead' }, t('analytics.empty')));
				parts.push(
					section(t('analytics.visits'), [
						list(t('analytics.pages'), report.pages, undefined, 'sky'),
						list(t('analytics.sources'), report.sources, (key) => (key === DIRECT ? t('analytics.direct') : key), 'violet'),
						list(t('analytics.devices'), report.devices, (key) => t(`device.${key}`), 'teal'),
						list(
							t('analytics.countries'),
							report.countries,
							(key) => (key === UNKNOWN ? t('analytics.unknown') : key),
							'amber',
						),
					]),
				);
				if (report.funnel)
					parts.push(
						section(
							t('analytics.funnel'),
							report.funnel.steps.map((step, index) =>
								tile(
									t(`funnel.${step.step}`),
									step.count,
									['sky', 'violet', 'amber', 'pink'][index] ?? 'sky',
									String(index + 1),
								),
							),
						),
					);
				if (report.searches && report.notFound && report.emptySearches)
					parts.push(
						section(t('analytics.searches'), [
							list(t('analytics.searches'), report.searches, undefined, 'violet'),
							list(t('analytics.emptySearches'), report.emptySearches, undefined, 'amber'),
							list(t('analytics.notFound'), report.notFound, undefined, 'coral'),
						]),
					);
				if (report.vitals)
					parts.push(
						section(
							t('analytics.vitals'),
							report.vitals.map((vital) => {
								const total = vital.good + vital.needsImprovement + vital.poor;
								/** @param {number} n */
								const share = (n) => (total > 0 ? Math.round((n / total) * 100) : 0);
								const value =
									vital.average === null
										? '—'
										: vital.name === 'CLS'
											? (vital.average / 1000).toFixed(2)
											: `${vital.average} ms`;
								const node = tile(
									t(`vital.${vital.name}`),
									value,
									vital.poor > vital.good ? 'coral' : 'teal',
									vital.name.slice(0, 1),
								);
								node.append(
									h(
										'span',
										{ class: 'meta' },
										t('analytics.share', {
											good: share(vital.good),
											needsImprovement: share(vital.needsImprovement),
											poor: share(vital.poor),
										}),
									),
								);
								return node;
							}),
						),
					);
				body.replaceChildren(...parts);
			};

			const load = async () => {
				status.textContent = t('analytics.loading');
				const query = new URLSearchParams({ from: from.value, to: to.value });
				const answer = await adminCall(api, 'GET', `/v1/admin/analytics?${query.toString()}`);
				if (!answer.ok) {
					status.textContent =
						answer.status === 0 && !api.tickets.current()
							? t('analytics.signedOut')
							: answer.data?.detail
								? `${t('analytics.failed')} ${answer.data.detail}`
								: t('analytics.failed');
					return;
				}
				status.textContent = '';
				draw(answer.data);
			};
			form.addEventListener('submit', (event) => {
				event.preventDefault();
				void load();
			});
			const stop = api.tickets.onChange((signedIn) => {
				if (!signedIn) {
					body.replaceChildren();
					status.textContent = t('analytics.signedOut');
				}
			});
			void load();
			return () => {
				stop();
			};
		},
	});
};
