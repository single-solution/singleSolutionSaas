/**
 * The analytics dashboard (admin widget `analytics_dashboard`, ticket `analytics.read`; PLAN 0.8.9, 0.8.10 G3, 0.6):
 * range chips (today, 7, 30 or 90 days, this month, last month, 12 months; a custom range and Refresh in the More
 * menu), visits as the hero card with a bar per day, page views, revenue; with the `sessions` detail also live
 * visitors, sessions, bounce rate, average time and pages per session. Then masonries of ranked lists (top pages,
 * sources, devices, countries; browsers, systems and cities with sessions), each with See all in a dialog; the funnel
 * with each step's share of the one before; with the conversion funnel, each product's views, add-to-carts, checkouts,
 * purchases, units, revenue and rates in a table sorted by any column, with its CSV file (R7 #113); searches and 404s
 * (and 404 referrers); Web Vitals (and the slowest pages);
 * the latest journeys, each opening its steps and every event of the visit in a dialog; and the event log with a
 * filter chip per event type and its count. Every word is a widget text; days are days of the business time zone and
 * the widget says which zone; money and times follow the website's Format (PLAN 0.8.10 K7, K8).
 * @module
 */
import {
	adminCall,
	block,
	element,
	fieldGrid,
	formatDate,
	formatMoney,
	formatText,
	loadingState,
	moreMenu,
	mountWidget,
	openDialog,
} from '@ss/app-kit/widget';
import { PRESETS, dayStart, presetRange } from '../core/analytics.js';
import { DIRECT, EVENT_FEATURES, UNKNOWN } from '../core/events.js';
import { PROBLEM_TEXTS, chipGroup, rankList, problemKey } from './admin-kit.js';
import { WIDGET_CSS } from './styles.js';

/** @typedef {import('../core/analytics.js').Report} Report */

/** Rows of each top list the widget asks for (the cards show the first {@link SHOWN}; See all shows them all). */
const TOP = 50;
/** Rows a ranked card shows. */
const SHOWN = 6;
/** Events of the log per page. */
const LOG_PAGE = 25;
/** Products the table shows (the CSV file has them all). */
const PRODUCTS = 50;
/** The products table's columns: the sort key and the widget text of each (R7 #113). */
const PRODUCT_COLUMNS = Object.freeze([
	'name',
	'views',
	'carts',
	'checkouts',
	'purchases',
	'units',
	'revenue',
	'cartRate',
	'conversion',
]);
/** The event types, in the order of the log's chips. */
const EVENT_TYPES = Object.freeze(Object.keys(EVENT_FEATURES));
/** The widget texts of refused calls (a range the report does not take: its days out of order or too many). */
export const ANALYTICS_PROBLEMS = Object.freeze({ ...PROBLEM_TEXTS, 'validation_failed:from': 'analytics.problem.range' });

/**
 * @param {{ host: HTMLElement, api: import('@ss/app-kit/widget').AdminApi, config: import('./widget.js').WidgetConfig,
 *   viewer: import('./widget.js').Viewer, now: () => number, download?: (name: string, bytes: ArrayBuffer) => void }} input
 *   `viewer`: the browser's language and time zone; `download`: save a file the widget made (the products' CSV file)
 */
export const mountAnalyticsDashboard = ({ host, api, config, viewer, now, download = () => {} }) => {
	/** @param {string} key @param {Record<string, string | number>} [values] */
	const t = (key, values) => formatText(config.texts[key] ?? key, values);
	/**
	 * A day of the report in the website's Format: always the business day, whatever the viewer's own zone.
	 * @param {string} day @param {string} timeZone
	 */
	const dayText = (day, timeZone) =>
		formatDate(dayStart(day, timeZone), { ...config.format, times: 'business' }, { timeZone, style: 'date', viewer });
	/** @param {string} at an ISO time */
	const timeText = (at) => formatDate(at, config.format, { timeZone: config.timeZone, style: 'datetime', viewer });
	/** @param {number} amount @param {string} currency */
	const money = (amount, currency) => formatMoney(amount, currency, config.format, viewer);
	/** @param {number} seconds */
	const durationText = (seconds) =>
		seconds < 60
			? t('analytics.seconds', { seconds })
			: t('analytics.duration', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
	/** @param {string} key @param {string} prefix */
	const label = (key, prefix) => (config.texts[`${prefix}.${key}`] === undefined ? key : t(`${prefix}.${key}`));
	// the dashboard mounts only with Visitor analytics, whose retention the admin config always carries
	const retention = Number(config.settings.admin?.retentionMonths);

	return mountWidget({
		host,
		theme: config.theme,
		customCss: config.customCss,
		css: WIDGET_CSS,
		render: (root) => {
			const doc = root.ownerDocument;
			/** @param {string} tag @param {Record<string, string>} [attributes] @param {string} [text] */
			const h = (tag, attributes, text) => element(doc, tag, attributes, text);
			/** @type {{ preset: string, from: string, to: string }} */
			let range = { preset: '30d', ...presetRange('30d', now(), config.timeZone) };

			const chips = chipGroup(
				doc,
				t('analytics.days'),
				PRESETS.map((preset) => ({ value: preset, label: t(`analytics.range.${preset}`) })),
				range.preset,
				(preset) => {
					range = { preset, ...presetRange(preset, now(), config.timeZone) };
					void load();
				},
			);
			// the title with its More menu; the range chips under it
			const head = h('div', { class: 'head' });
			head.append(
				h('h2', {}, t('analytics.title')),
				moreMenu(doc, t('analytics.more'), [
					{ label: t('analytics.custom'), onSelect: () => customRange() },
					{ label: t('analytics.refresh'), onSelect: () => void refresh() },
				]),
			);
			const span = h('p', { class: 'sub' });
			const status = h('p', { class: 'status', role: 'status' });
			const body = h('div', { class: 'body' });
			const log = h('div', { class: 'section' });
			const box = h('section', { class: 'box admin' });
			box.append(block(doc, { body: [head, chips, span, status] }), body, log);
			root.append(box);

			/** @param {{ ok: boolean, status: number, data: any }} answer */
			const failure = (answer) =>
				answer.status === 0 && !api.tickets.current()
					? t('analytics.signedOut')
					: t(problemKey(answer, ANALYTICS_PROBLEMS, 'analytics.failed'));
			/** @param {{ from: string, to: string }} days */
			const fetchReport = (days) =>
				adminCall(
					api,
					'GET',
					`/v1/admin/analytics?${new URLSearchParams({ from: days.from, to: days.to, top: String(TOP) }).toString()}`,
				);

			/**
			 * A section: its heading, a lighter line under it, and its content.
			 * @param {string} title @param {string} help @param {Node[]} nodes
			 */
			const section = (title, help, nodes) => block(doc, { title, sub: help, body: nodes });
			/** @param {Node[]} cards */
			const masonry = (cards) => {
				const node = h('div', { class: 'masonry' });
				node.append(...cards);
				return node;
			};
			/**
			 * A tile: a round badge, the figure and its label (and a hint).
			 * @param {string} name @param {string | number} value @param {string} badge
			 * @param {{ tone?: 'good' | 'poor' | null, hint?: string }} [options]
			 */
			const tile = (name, value, badge, { tone = null, hint } = {}) => {
				const node = h('div', { class: tone ? `tile ${tone}` : 'tile' });
				node.append(
					h('span', { class: 'badge', 'aria-hidden': 'true' }, badge),
					h('span', { class: 'value' }, String(value)),
					h('span', { class: 'label' }, name),
				);
				if (hint) node.append(h('span', { class: 'hint' }, hint));
				return node;
			};
			/**
			 * A ranked card: its first rows, and See all in a dialog when there are more.
			 * @param {string} title
			 * @param {Array<{ name: string, count: number, figure?: string, meta?: string }>} rows
			 */
			const rankCard = (title, rows) => {
				const card = h('div', { class: 'card' });
				const top = h('div', { class: 'card-head' });
				top.append(h('h4', {}, title));
				if (rows.length > SHOWN) {
					const all = h('button', { type: 'button', class: 'link small' }, t('analytics.seeAll', { count: rows.length }));
					all.addEventListener('click', () =>
						openDialog(root, {
							title,
							body: [rankList(doc, rows, t('analytics.none'))],
							closeLabel: t('analytics.close'),
						}),
					);
					top.append(all);
				}
				card.append(top, rankList(doc, rows.slice(0, SHOWN), t('analytics.none')));
				return card;
			};
			/**
			 * Put a card after the tiles of a grid, taking the rest of their last row (or a row of its own).
			 * @param {HTMLElement} tiles @param {HTMLElement} card
			 */
			const rest = (tiles, card) => {
				// the hero card has a row of its own
				const n = [...tiles.children].filter((child) => !child.classList.contains('hero')).length;
				card.classList.add('rest');
				card.style.setProperty('--rest2', String((2 - (n % 2)) % 2 || 2));
				card.style.setProperty('--rest4', String((4 - (n % 4)) % 4 || 4));
				tiles.append(card);
				return tiles;
			};
			/** @param {Array<{ key: string, count: number }>} rows @param {(key: string) => string} [name] */
			const ranked = (rows, name = (key) => key) => rows.map((row) => ({ name: name(row.key), count: row.count }));

			/** @param {Report} report */
			const overview = (report) => {
				const zone = report.timeZone;
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
							title: `${dayText(day.day, zone)}: ${day.visits}`,
						}),
					);
				hero.append(bars);
				const tiles = h('div', { class: 'tiles' });
				tiles.append(hero, tile(t('analytics.pageViews'), report.totals.pageViews, 'P'));
				const sessions = report.sessions;
				if (sessions)
					tiles.append(
						tile(t('analytics.sessions'), sessions.count, 'S', {
							hint: t('analytics.bounces', { bounces: sessions.bounces, count: sessions.count }),
						}),
						tile(
							t('analytics.bounceRate'),
							sessions.bounceRate === null ? '—' : t('analytics.percent', { value: sessions.bounceRate }),
							'B',
						),
						tile(
							t('analytics.averageDuration'),
							sessions.averageDuration === null ? '—' : durationText(sessions.averageDuration),
							'T',
						),
						tile(t('analytics.pagesPerSession'), sessions.pagesPerSession ?? '—', '#'),
					);
				for (const entry of report.revenue ?? [])
					tiles.append(
						tile(t('analytics.revenue'), money(entry.value, entry.currency), '$', {
							hint: t('analytics.orders', { count: entry.orders }),
						}),
					);
				return tiles;
			};

			/** @param {NonNullable<Report['live']>} live */
			const liveCard = (live) => {
				const card = h('div', { class: 'card' });
				const line = h('div', { class: 'live' });
				line.append(
					h('span', { class: live.visitors > 0 ? 'pulse' : 'pulse idle', 'aria-hidden': 'true' }),
					h('span', { class: 'value' }, String(live.visitors)),
					h('span', {}, t('analytics.live')),
				);
				card.append(line, h('p', { class: 'sub' }, live.visitors > 0 ? t('analytics.liveHelp') : t('analytics.liveNone')));
				if (live.pages.length > 0) card.append(rankList(doc, ranked(live.pages), t('analytics.none')));
				return card;
			};

			/** @param {NonNullable<Report['funnels']>[number]} funnel */
			const funnelSteps = (funnel) => {
				const list = h('div', { class: 'steps card' });
				list.append(h('h3', {}, funnel.name));
				const first = Math.max(1, funnel.steps[0]?.count ?? 0);
				funnel.steps.forEach((step, index) => {
					const before = index > 0 ? (funnel.steps[index - 1]?.count ?? 0) : 0;
					const node = h('div', { class: 'step' });
					const line = h('div', { class: 'line' });
					line.append(h('span', {}, step.name), h('span', { class: 'figure' }, String(step.count)));
					const bar = h('span', { class: 'bar', 'aria-hidden': 'true' });
					bar.style.setProperty('--share', `${Math.max(2, Math.round((step.count / first) * 100))}%`);
					node.append(line, bar);
					if (index > 0)
						node.append(
							h(
								'span',
								{ class: 'meta' },
								t('analytics.stepRate', { rate: before > 0 ? Math.round((step.count / before) * 1000) / 10 : 0 }),
							),
						);
					list.append(node);
				});
				return list;
			};

			/** @param {NonNullable<Report['vitals']>} vitals */
			const vitalTiles = (vitals) => {
				const tiles = h('div', { class: 'tiles' });
				for (const vital of vitals) {
					const total = vital.good + vital.needsImprovement + vital.poor;
					/** @param {number} n */
					const share = (n) => (total > 0 ? Math.round((n / total) * 100) : 0);
					const value =
						vital.average === null ? '—' : vital.name === 'CLS' ? (vital.average / 1000).toFixed(2) : `${vital.average} ms`;
					tiles.append(
						tile(t(`vital.${vital.name}`), value, vital.name.slice(0, 1), {
							tone: vital.average === null ? null : vital.poor > vital.good ? 'poor' : 'good',
							hint: t('analytics.share', {
								good: share(vital.good),
								needsImprovement: share(vital.needsImprovement),
								poor: share(vital.poor),
							}),
						}),
					);
				}
				return tiles;
			};

			/** @param {NonNullable<Report['vitalPages']>} pages */
			const slowPages = (pages) =>
				rankCard(
					t('analytics.slowPages'),
					pages.map((page) => ({
						name: page.path,
						count: page.averages.LCP ?? 0,
						figure: page.averages.LCP === null ? '—' : `${page.averages.LCP} ms`,
						meta: Object.entries(page.averages)
							.filter(([, average]) => average !== null)
							.map(([name, average]) =>
								name === 'CLS' ? `${name} ${(Number(average) / 1000).toFixed(2)}` : `${name} ${average} ms`,
							)
							.join(' · '),
					})),
				);

			/**
			 * A raw event in one line: what happened and its facts.
			 * @param {any} event
			 */
			const eventFacts = (event) => {
				const data = event.data ?? {};
				return [
					typeof data.term === 'string' ? `“${data.term}”` : null,
					typeof data.value === 'number' && data.currency ? money(data.value, data.currency) : null,
					event.type === 'vital' ? `${data.name} ${data.value} (${label(String(data.rating), 'rating')})` : null,
					typeof data.source === 'string' ? (data.source === DIRECT ? t('analytics.direct') : data.source) : null,
					typeof data.from === 'string' ? t('analytics.cameFromShort', { from: data.from }) : null,
					event.browser ? label(event.browser, 'browser') : null,
					event.os ? label(event.os, 'os') : null,
					event.city ?? null,
				]
					.filter(Boolean)
					.join(' · ');
			};

			/**
			 * A list of raw events (newest first) with Load more; each opens its fields in a dialog.
			 * @param {string} query the filter (`type=`, `session=`)
			 * @param {(count: number) => void} [onFirst]
			 */
			const eventList = (query, onFirst) => {
				const wrap = h('div');
				const list = h('ul', { class: 'rows' });
				const more = h('button', { type: 'button', class: 'secondary', hidden: '' }, t('analytics.loadMore'));
				const note = h('p', { class: 'status', role: 'status' });
				/** @type {string | null} */
				let cursor = null;
				const page = async () => {
					const params = new URLSearchParams(query);
					params.set('limit', String(LOG_PAGE));
					if (cursor) params.set('cursor', cursor);
					const answer = await adminCall(api, 'GET', `/v1/admin/events?${params.toString()}`);
					if (!answer.ok) {
						note.textContent = failure(answer);
						return;
					}
					note.textContent = '';
					cursor = answer.data.nextCursor ?? null;
					more.toggleAttribute('hidden', !answer.data.hasMore);
					if (list.children.length === 0 && answer.data.items.length === 0)
						list.append(h('li', { class: 'empty' }, t('analytics.noEvents')));
					for (const event of answer.data.items) {
						const item = h('li', { tabindex: '0', role: 'button' });
						item.append(
							h('span', {}, `${label(event.type, 'event')} · ${event.path}`),
							h('span', { class: 'figure' }, timeText(event.at)),
						);
						const facts = eventFacts(event);
						if (facts) item.append(h('span', { class: 'meta' }, facts));
						const show = () =>
							openDialog(root, {
								title: label(event.type, 'event'),
								body: [
									fieldGrid(doc, [
										[t('analytics.field.path'), event.path],
										[t('analytics.field.at'), timeText(event.at)],
										[t('analytics.field.facts'), facts],
										[t('analytics.field.session'), event.session],
										[t('analytics.field.expires'), timeText(event.expiresAt)],
										[t('analytics.field.id'), event.id],
									]),
								],
								closeLabel: t('analytics.close'),
							});
						item.addEventListener('click', show);
						item.addEventListener('keydown', (key) => {
							if (key.key === 'Enter' || key.key === ' ') {
								key.preventDefault();
								show();
							}
						});
						list.append(item);
					}
					onFirst?.(list.children.length);
				};
				more.addEventListener('click', () => void page());
				wrap.append(list, more, note);
				void page();
				return wrap;
			};

			/** @param {import('../core/analytics.js').Journey} journey */
			const openJourney = (journey) => {
				const steps = h('ol', { class: 'timeline' });
				for (const step of journey.steps) {
					const item = h('li');
					item.append(
						h('strong', {}, label(step.type, 'event')),
						' ',
						step.path,
						h(
							'span',
							{ class: 'meta' },
							[
								timeText(step.at),
								step.term ? `“${step.term}”` : null,
								step.value !== undefined && step.currency ? money(step.value, step.currency) : null,
							]
								.filter(Boolean)
								.join(' · '),
						),
					);
					steps.append(item);
				}
				const all = h('button', { type: 'button', class: 'secondary' }, t('analytics.allEvents'));
				const holder = h('div');
				all.addEventListener('click', () => {
					all.remove();
					holder.append(eventList(`session=${encodeURIComponent(journey.session)}`));
				});
				openDialog(root, {
					title: t('analytics.journeyTitle', { time: timeText(journey.startedAt) }),
					wide: true,
					body: [
						fieldGrid(doc, [
							[t('analytics.field.started'), timeText(journey.startedAt)],
							[t('analytics.field.lastSeen'), timeText(journey.endedAt)],
							[t('analytics.field.duration'), durationText(journey.duration)],
							[t('analytics.field.pages'), String(journey.pages)],
							[t('analytics.field.events'), String(journey.events)],
							[t('analytics.field.device'), journey.device ? t(`device.${journey.device}`) : null],
							[t('analytics.field.browser'), journey.browser ? label(journey.browser, 'browser') : null],
							[t('analytics.field.os'), journey.os ? label(journey.os, 'os') : null],
							[t('analytics.field.place'), placeOf(journey)],
							[t('analytics.field.source'), journey.source === DIRECT ? t('analytics.direct') : journey.source],
							[t('analytics.field.session'), journey.session],
						]),
						h('h4', {}, t('analytics.steps')),
						steps,
						all,
						holder,
					],
					closeLabel: t('analytics.close'),
				});
			};
			/** @param {import('../core/analytics.js').Journey} journey */
			const placeOf = (journey) =>
				[journey.city, journey.country && journey.country !== UNKNOWN ? journey.country : null].filter(Boolean).join(', ') ||
				null;

			/** @param {NonNullable<Report['journeys']>} journeys */
			const journeyList = (journeys) => {
				const list = h('ul', { class: 'rows card' });
				if (journeys.length === 0) list.append(h('li', { class: 'empty' }, t('analytics.noJourneys')));
				for (const journey of journeys) {
					const item = h('li', { tabindex: '0', role: 'button' });
					item.append(
						h('span', {}, timeText(journey.startedAt)),
						h('span', { class: 'figure' }, durationText(journey.duration)),
						h(
							'span',
							{ class: 'meta' },
							[
								t('analytics.journeyPages', { count: journey.pages }),
								journey.device ? t(`device.${journey.device}`) : null,
								journey.browser ? label(journey.browser, 'browser') : null,
								placeOf(journey),
								journey.source === DIRECT ? t('analytics.direct') : journey.source,
							]
								.filter(Boolean)
								.join(' · '),
						),
					);
					item.addEventListener('click', () => openJourney(journey));
					item.addEventListener('keydown', (key) => {
						if (key.key === 'Enter' || key.key === ' ') {
							key.preventDefault();
							openJourney(journey);
						}
					});
					list.append(item);
				}
				return list;
			};

			// ------------------------------------------------------------------------- products (R7 #113)
			/** @type {{ sort: string, order: 'asc' | 'desc' }} */
			let productOrder = { sort: 'views', order: 'desc' };
			const productsPart = h('div');
			/** The query of the products report: the dashboard's days and the table's order. @param {number} [limit] */
			const productQuery = (limit) =>
				new URLSearchParams({
					from: range.from,
					to: range.to,
					sort: productOrder.sort,
					order: productOrder.order,
					...(limit ? { limit: String(limit) } : {}),
				}).toString();
			/** Load the table in the dashboard's days and order. */
			const loadProducts = async () => {
				const answer = await adminCall(api, 'GET', `/v1/admin/analytics/products?${productQuery(PRODUCTS)}`);
				productsPart.replaceChildren(answer.ok ? productsTable(answer.data) : h('p', { class: 'sub' }, failure(answer)));
			};
			/** Save the CSV file of every product, in the table's order. */
			const productsCsv = async () => {
				const ticket = api.tickets.current();
				if (!ticket) return;
				const response = await api
					.fetch(`${api.base}/v1/admin/analytics/products/csv?${productQuery()}`, {
						headers: { authorization: `Bearer ${ticket}` },
					})
					.catch(() => null);
				// the bytes as sent (text() would drop the byte order mark spreadsheets need to read UTF-8)
				if (response?.ok) download(`products-${range.from}-${range.to}.csv`, await response.arrayBuffer());
				else productsPart.append(h('p', { class: 'sub' }, t('analytics.failed')));
			};
			/** @param {any} report the products report */
			const productsTable = (report) => {
				/** @type {import('../core/product-performance.js').ProductRow[]} */
				const items = report.items;
				if (items.length === 0) return h('p', { class: 'lead' }, t('analytics.products.none'));
				/** @param {number | null} value */
				const percent = (value) => (value === null ? '—' : t('analytics.percent', { value }));
				const table = h('table', { class: 'products-table' });
				const head = h('tr');
				for (const key of PRODUCT_COLUMNS) {
					const sorted = productOrder.sort === key;
					const cell = h('th', {
						scope: 'col',
						'aria-sort': sorted ? (productOrder.order === 'asc' ? 'ascending' : 'descending') : 'none',
					});
					const sort = h('button', { type: 'button', class: 'link' }, t(`analytics.products.${key}`));
					sort.addEventListener('click', () => {
						// a column sorts the most first (names A to Z); again, the other way
						const first = key === 'name' ? 'asc' : 'desc';
						productOrder = {
							sort: key,
							order: sorted ? (productOrder.order === 'asc' ? 'desc' : 'asc') : first,
						};
						void loadProducts();
					});
					cell.append(sort);
					head.append(cell);
				}
				const thead = h('thead');
				thead.append(head);
				const tbody = h('tbody');
				for (const item of items) {
					const row = h('tr');
					for (const text of [
						item.name || item.id,
						String(item.views),
						String(item.carts),
						String(item.checkouts),
						String(item.purchases),
						String(item.units),
						item.revenue.map((entry) => money(entry.amount, entry.currency)).join(', ') || '—',
						percent(item.cartRate),
						percent(item.conversion),
					])
						row.append(h('td', {}, text));
					tbody.append(row);
				}
				table.append(thead, tbody);
				const scroll = h('div', { class: 'table-scroll' });
				scroll.append(table);
				const save = h('button', { type: 'button', class: 'secondary' }, t('analytics.products.csv'));
				save.addEventListener('click', () => void productsCsv());
				const foot = h('div', { class: 'actions' });
				foot.append(
					h('span', { class: 'sub' }, t('analytics.products.shown', { shown: items.length, total: report.total })),
					save,
				);
				const box = h('div');
				box.append(scroll, foot);
				return box;
			};

			/** @param {Report} report */
			const draw = (report) => {
				span.textContent = `${t('analytics.span', { from: dayText(report.from, report.timeZone), to: dayText(report.to, report.timeZone) })} · ${t('analytics.timeZone', { timeZone: report.timeZone })}`;
				const parts = [];
				const tiles = overview(report);
				// live visitors take the rest of the tiles' last row
				parts.push(report.live ? rest(tiles, liveCard(report.live)) : tiles);
				if (report.totals.visits === 0 && report.totals.pageViews === 0)
					parts.push(h('p', { class: 'lead' }, t('analytics.empty')));
				const named = {
					source: (/** @type {string} */ key) => (key === DIRECT ? t('analytics.direct') : key),
					device: (/** @type {string} */ key) => t(`device.${key}`),
					country: (/** @type {string} */ key) => (key === UNKNOWN ? t('analytics.unknown') : key),
				};
				parts.push(
					section(t('analytics.traffic'), t('analytics.trafficHelp'), [
						masonry([
							rankCard(t('analytics.pages'), ranked(report.pages)),
							rankCard(t('analytics.sources'), ranked(report.sources, named.source)),
							rankCard(t('analytics.devices'), ranked(report.devices, named.device)),
							rankCard(t('analytics.countries'), ranked(report.countries, named.country)),
							...(report.browsers
								? [
										rankCard(
											t('analytics.browsers'),
											ranked(report.browsers, (key) => label(key, 'browser')),
										),
									]
								: []),
							...(report.systems
								? [
										rankCard(
											t('analytics.systems'),
											ranked(report.systems, (key) => label(key, 'os')),
										),
									]
								: []),
							...(report.cities ? [rankCard(t('analytics.cities'), ranked(report.cities))] : []),
						]),
					]),
				);
				// G1: the merchant's goals, then each of their funnels
				if (report.goals && report.goals.length > 0)
					parts.push(
						section(t('analytics.goals'), t('analytics.goalsHelp'), [
							rankCard(
								t('analytics.goals'),
								report.goals.map((goal) => ({ name: goal.name, count: goal.count })),
							),
						]),
					);
				if (report.funnels && report.funnels.length > 0)
					parts.push(section(t('analytics.funnel'), t('analytics.funnelHelp'), report.funnels.map(funnelSteps)));
				// each product's funnel, loaded in the same days (R7 #113)
				if (config.features.includes('conversion_funnel')) {
					const products = section(t('analytics.products'), t('analytics.productsHelp'), [productsPart]);
					products.classList.add('products');
					parts.push(products);
					productsPart.replaceChildren(loadingState(doc, t('analytics.loading')));
					void loadProducts();
				}
				if (report.searches && report.emptySearches && report.notFound)
					parts.push(
						section(t('analytics.searches'), t('analytics.searchesHelp'), [
							masonry([
								rankCard(t('analytics.siteSearches'), ranked(report.searches)),
								rankCard(t('analytics.emptySearches'), ranked(report.emptySearches)),
								rankCard(t('analytics.notFound'), ranked(report.notFound)),
								...(report.notFoundFrom
									? [
											rankCard(
												t('analytics.notFoundFrom'),
												report.notFoundFrom.map((row) => ({
													name: row.path,
													count: row.count,
													meta: t('analytics.cameFrom', {
														from: row.from === DIRECT ? t('analytics.direct') : row.from,
													}),
												})),
											),
										]
									: []),
							]),
						]),
					);
				if (report.vitals)
					parts.push(
						section(t('analytics.vitals'), t('analytics.vitalsHelp'), [
							report.vitalPages
								? rest(vitalTiles(report.vitals), slowPages(report.vitalPages))
								: vitalTiles(report.vitals),
						]),
					);
				if (report.journeys)
					parts.push(section(t('analytics.journeys'), t('analytics.journeysHelp'), [journeyList(report.journeys)]));
				const swap = h('div', { class: 'swap' });
				swap.append(...parts);
				body.replaceChildren(swap);
			};

			/** The event log: a chip per event type with its count, and the events newest first. */
			const drawLog = async () => {
				const counts = await adminCall(api, 'GET', '/v1/admin/events/counts?by=type');
				const groups = counts.ok ? counts.data.groups : {};
				const holder = h('div');
				const pick = (/** @type {string} */ type) =>
					holder.replaceChildren(eventList(type ? `type=${encodeURIComponent(type)}` : ''));
				log.replaceChildren(
					h('h3', {}, t('analytics.events')),
					h('p', { class: 'sub' }, t('analytics.eventsHelp', { months: retention })),
					chipGroup(
						doc,
						t('analytics.events'),
						[
							{ value: '', label: t('analytics.allTypes'), count: counts.ok ? counts.data.total : null },
							...EVENT_TYPES.filter((type) => (groups[type] ?? 0) > 0).map((type) => ({
								value: type,
								label: label(type, 'event'),
								count: groups[type],
							})),
						],
						'',
						pick,
					),
					holder,
				);
				pick('');
			};

			const load = async () => {
				status.textContent = t('analytics.loading');
				const answer = await fetchReport(range);
				if (!answer.ok) {
					status.textContent = failure(answer);
					return;
				}
				status.textContent = '';
				draw(answer.data);
			};
			const refresh = async () => {
				await load();
				if (api.tickets.current()) await drawLog();
			};

			const customRange = () => {
				const from = /** @type {HTMLInputElement} */ (h('input', { type: 'date', value: range.from }));
				const to = /** @type {HTMLInputElement} */ (h('input', { type: 'date', value: range.to }));
				const grid = h('div', { class: 'form-grid' });
				for (const [text, input] of /** @type {const} */ ([
					[t('analytics.from'), from],
					[t('analytics.to'), to],
				])) {
					const field = h('label', {}, text);
					field.append(input);
					grid.append(field);
				}
				openDialog(root, {
					title: t('analytics.customTitle'),
					body: [grid],
					submitLabel: t('analytics.show'),
					closeLabel: t('analytics.cancel'),
					onSubmit: async () => {
						const answer = await fetchReport({ from: from.value, to: to.value });
						if (!answer.ok) return failure(answer);
						range = { preset: 'custom', from: from.value, to: to.value };
						for (const chip of chips.querySelectorAll('.chip')) chip.setAttribute('aria-pressed', 'false');
						status.textContent = '';
						draw(answer.data);
						return null;
					},
				});
			};

			const stop = api.tickets.onChange((signedIn) => {
				if (!signedIn) {
					body.replaceChildren();
					log.replaceChildren();
					status.textContent = t('analytics.signedOut');
				}
			});
			void refresh();
			return () => {
				stop();
			};
		},
	});
};
