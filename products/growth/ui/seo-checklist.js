/**
 * The SEO checklist (admin widget `seo_checklist`; PLAN 0.8.9, 0.8.10 G5, 0.6; SEO audit §3.2 B). With the SEO
 * checklist on (ticket `seo.check`) it opens on the last full check of the site (kept by Growth) and checks the site by
 * itself when there is none or it is more than a day old; Check my pages checks the pages of its settings and sample
 * pages from the sitemap (a run within 5 minutes of the last one answers that one), and the More menu checks other
 * pages (a dialog). A run shows the passed, to-improve and to-fix counts as tiles, filter chips with counts, and a
 * masonry of cards (the whole site, then each page with its kind) whose checks carry the reason and their fix steps;
 * each page's More menu opens it, tests it in Google's Rich Results Test, checks it again or submits it to IndexNow,
 * and the 404 log's check opens the redirects widget when it is on the page. With IndexNow on (ticket
 * `indexnow.submit`) a card names the key file address (G5) and submits pages in a dialog. Every word is a widget
 * text; the time of a run follows the website's Format and time zone (PLAN 0.8.10 K7).
 * @module
 */
import { adminCall, element, formatDate, formatText, moreMenu, mountWidget, openDialog } from '@ss/app-kit/widget';
import { SITE_CHECKS, richResultsTestOf } from '../core/seo-checks.js';
import { WIDGET_ATTRIBUTE } from '../core/widgets.js';
import { PROBLEM_TEXTS, chipGroup, problemKey } from './admin-kit.js';
import { WIDGET_CSS } from './styles.js';

/** Order of the statuses in a card: what to fix first. */
const ORDER = Object.freeze({ fail: 0, warn: 1, pass: 2 });

/** The kept check is run again by itself when the widget opens after this long. */
const STALE_MS = 86_400_000;

/** The widget texts of the checklist's refused runs. */
export const SEO_PROBLEMS = Object.freeze({
	...PROBLEM_TEXTS,
	'validation_failed:paths': 'seo.problem.paths',
	rate_limited: 'seo.problem.rate_limited',
});
/** The widget texts of refused IndexNow submissions (what was wrong with them). */
export const INDEXNOW_PROBLEMS = Object.freeze({
	...PROBLEM_TEXTS,
	'validation_failed:key': 'indexnow.noKey',
	'validation_failed:keyPath': 'indexnow.badPath',
	'validation_failed:urls': 'indexnow.problem.urls',
	rate_limited: 'indexnow.problem.rate_limited',
});
/** What IndexNow answered when it refused a submission (the problem's `indexNowStatus`) → its widget text. */
export const INDEXNOW_REFUSED = Object.freeze({
	403: 'indexnow.refused.key',
	422: 'indexnow.refused.host',
	429: 'indexnow.refused.busy',
});

/**
 * The widget texts of a refused IndexNow submission: with IndexNow's own refusal, its text.
 * @param {{ data?: any }} answer
 * @returns {Readonly<Record<string, string>>}
 */
const indexNowProblems = (answer) => {
	const status = String(answer.data?.indexNowStatus);
	return Object.hasOwn(INDEXNOW_REFUSED, status)
		? { ...INDEXNOW_PROBLEMS, indexnow_refused: INDEXNOW_REFUSED[/** @type {'403' | '422' | '429'} */ (status)] }
		: INDEXNOW_PROBLEMS;
};

/**
 * @typedef {{ id: string, status: 'pass' | 'warn' | 'fail', page: string | null, title: string, reason: string,
 *   fix: string }} Check
 */
/** @typedef {{ url: string, kind: string, sampled: boolean }} Page */
/**
 * @typedef {{ checkedAt: string, cached: boolean, summary: { pass: number, warn: number, fail: number },
 *   checks: Check[], pages: Page[] }} Report
 */

/**
 * The path of a page address (`https://shop.example.com/a` → `/a`).
 * @param {string} url
 */
const pathOf = (url) => {
	try {
		return new URL(url).pathname;
	} catch {
		return url;
	}
};

/**
 * @param {{ host: HTMLElement, api: import('@ss/app-kit/widget').AdminApi, config: import('./widget.js').WidgetConfig,
 *   viewer: import('./widget.js').Viewer, open?: (url: string) => void, now?: () => number }} input `viewer`: the
 *   browser's language and time zone; `open`: open a page in a new tab
 */
export const mountSeoChecklist = ({ host, api, config, viewer, open = () => {}, now = Date.now }) => {
	/** @param {string} key @param {Record<string, string | number>} [values] */
	const t = (key, values) => formatText(config.texts[key] ?? key, values);
	const on = (/** @type {string} */ feature) => config.features.includes(feature);
	const admin = config.settings.admin;
	return mountWidget({
		host,
		theme: config.theme,
		customCss: config.customCss,
		css: WIDGET_CSS,
		render: (root) => {
			const doc = root.ownerDocument;
			/** @param {string} tag @param {Record<string, string>} [attributes] @param {string} [text] */
			const h = (tag, attributes, text) => element(doc, tag, attributes, text);
			/**
			 * @param {{ ok: boolean, status: number, data: any }} answer
			 * @param {Readonly<Record<string, string>>} keys
			 * @param {string} fallback
			 */
			const failure = (answer, keys, fallback) =>
				answer.status === 0 && !api.tickets.current() ? t('seo.signedOut') : t(problemKey(answer, keys, fallback));
			/** @param {string} label @param {HTMLElement} control */
			const field = (label, control) => {
				const node = h('label', {}, label);
				node.append(control);
				return node;
			};
			const parts = [];

			/** Where the outcome of an IndexNow submission is said: the IndexNow card's, else the checklist's. */
			const indexNowNote = h('p', { class: 'status', role: 'status' });
			/**
			 * Submit page addresses to IndexNow: an error text, or null.
			 * @param {string[]} urls
			 */
			const submit = async (urls) => {
				const answer = await adminCall(api, 'POST', '/v1/admin/indexnow', { urls });
				if (!answer.ok)
					return t('indexnow.failed', { reason: failure(answer, indexNowProblems(answer), 'indexnow.refused.other') });
				indexNowNote.textContent = t('indexnow.done', { count: answer.data.submitted });
				return null;
			};
			/** @param {string[]} [urls] the addresses to offer */
			const submitDialog = (urls = []) => {
				const box = /** @type {HTMLTextAreaElement} */ (h('textarea', { rows: '6' }));
				box.value = urls.join('\n');
				openDialog(root, {
					title: t('indexnow.title'),
					body: [h('p', { class: 'sub' }, t('indexnow.help')), field(t('indexnow.urls'), box)],
					submitLabel: t('indexnow.submit'),
					closeLabel: t('seo.cancel'),
					onSubmit: () =>
						submit(
							box.value
								.split(/\s+/)
								.map((url) => url.trim())
								.filter(Boolean),
						),
				});
			};

			if (on('seo_checklist')) {
				const run = h('button', { type: 'button' }, t('seo.run'));
				const status = h('p', { class: 'status', role: 'status' });
				const pages = admin?.seoPages ?? ['/'];
				const lead = h('p', { class: 'sub' }, t('seo.pages', { count: pages.length, pages: pages.join(', ') }));
				const results = h('div');
				results.append(h('p', { class: 'lead' }, t('seo.notRun')));
				const actions = h('div', { class: 'actions' });
				actions.append(
					run,
					moreMenu(doc, t('seo.more'), [
						{ label: t('seo.otherPages'), onSelect: () => otherPages() },
						...(on('indexnow') ? [{ label: t('indexnow.open'), onSelect: () => submitDialog() }] : []),
					]),
				);
				const head = h('div', { class: 'head' });
				head.append(h('h2', {}, t('seo.title')), actions);
				const box = h('section', { class: 'box' });
				box.append(head, lead, status, results);

				/** @param {string} at */
				const timeOf = (at) => formatDate(at, config.format, { timeZone: config.timeZone, style: 'datetime', viewer });

				/**
				 * Run the checks: the settings' pages and sample pages, or the paths asked for.
				 * @param {string[]} [paths]
				 * @returns {Promise<string | null>} an error text, or null
				 */
				const check = async (paths) => {
					run.setAttribute('disabled', '');
					status.textContent = t('seo.running');
					const answer = await adminCall(api, 'POST', '/v1/admin/seo/checks', paths ? { paths } : {});
					run.removeAttribute('disabled');
					if (!answer.ok) {
						status.textContent = failure(answer, SEO_PROBLEMS, 'seo.failed');
						return status.textContent;
					}
					const report = /** @type {Report} */ (answer.data);
					status.textContent = t(report.cached ? 'seo.recent' : 'seo.checkedAt', { time: timeOf(report.checkedAt) });
					draw(report);
					return null;
				};

				/** The last full check when the widget opens; a new one when there is none or it is a day old. */
				const start = async () => {
					const answer = await adminCall(api, 'GET', '/v1/admin/seo/report');
					if (!answer.ok) {
						status.textContent = failure(answer, SEO_PROBLEMS, 'seo.failed');
						return;
					}
					const kept = /** @type {Report | null} */ (answer.data);
					if (kept) {
						status.textContent = t('seo.checkedAt', { time: timeOf(kept.checkedAt) });
						draw(kept);
					}
					if (!kept || now() - Date.parse(kept.checkedAt) > STALE_MS) await check();
				};

				/**
				 * The redirects widget on this page while Redirects is on (the 404 log's check scrolls to it).
				 * @returns {Element | null}
				 */
				const redirectsWidget = () =>
					on('redirects') ? host.ownerDocument.querySelector(`[${WIDGET_ATTRIBUTE}="redirects"]`) : null;

				/** @param {Report} report */
				const draw = (report) => {
					const tiles = h('div', { class: 'tiles' });
					for (const [status, tone, badge] of /** @type {const} */ ([
						['fail', 'poor', '!'],
						['warn', null, '~'],
						['pass', 'good', '✓'],
					])) {
						const tile = h('div', { class: tone ? `tile ${tone}` : 'tile' });
						tile.append(
							h('span', { class: 'badge', 'aria-hidden': 'true' }, badge),
							h('span', { class: 'value' }, String(report.summary[status])),
							h('span', { class: 'label' }, t(`seo.count.${status}`)),
						);
						tiles.append(tile);
					}
					/** @type {Map<string, Page>} */
					const known = new Map(report.pages.map((page) => [page.url, page]));
					/** @type {Map<string, Check[]>} each card's checks: the whole site (''), then each page */
					const groups = new Map([['', []]]);
					for (const url of known.keys()) groups.set(url, []);
					for (const item of report.checks) {
						const site = /** @type {ReadonlyArray<string>} */ (SITE_CHECKS).includes(item.id);
						groups.get(!site && item.page && groups.has(item.page) ? item.page : '')?.push(item);
					}
					const cards = h('div', { class: 'masonry' });
					/** @param {string} filter */
					const fillCards = (filter) => {
						cards.replaceChildren();
						for (const [url, checks] of groups) {
							const shown = checks
								.filter((item) => filter === '' || item.status === filter)
								.sort((a, b) => ORDER[a.status] - ORDER[b.status]);
							if (shown.length === 0) continue;
							const card = h('div', { class: 'card' });
							const top = h('div', { class: 'card-head' });
							const name = h('div');
							name.append(h('h4', {}, url === '' ? t('seo.site') : pathOf(url)));
							const page = known.get(url);
							if (page)
								name.append(
									h(
										'span',
										{ class: 'kind' },
										page.sampled ? `${t(`seo.kind.${page.kind}`)} · ${t('seo.sampled')}` : t(`seo.kind.${page.kind}`),
									),
								);
							top.append(name);
							if (url !== '')
								top.append(
									moreMenu(doc, t('seo.pageMenu', { page: pathOf(url) }), [
										{ label: t('seo.openPage'), onSelect: () => open(url) },
										{ label: t('seo.richResults'), onSelect: () => open(richResultsTestOf(url)) },
										{ label: t('seo.checkAgain'), onSelect: () => void check([pathOf(url)]) },
										...(on('indexnow') ? [{ label: t('seo.submitPage'), onSelect: () => submitDialog([url]) }] : []),
									]),
								);
							const list = h('ul', { class: 'checks' });
							for (const item of shown) {
								const row = h('li');
								const line = h('div');
								line.append(
									h('span', { class: `pill ${item.status}` }, t(`seo.status.${item.status}`)),
									h('strong', {}, item.title),
								);
								row.append(line);
								if (item.reason) row.append(h('p', { class: 'reason' }, item.reason));
								if (item.fix) {
									const fix = h('p', { class: 'fix' });
									fix.append(h('strong', {}, `${t('seo.fix')}: `), item.fix);
									const target = item.id === 'redirect_suggestions' ? redirectsWidget() : null;
									if (target) {
										const go = h('button', { type: 'button', class: 'secondary' }, t('seo.openRedirects'));
										go.addEventListener('click', () => target.scrollIntoView({ behavior: 'smooth', block: 'start' }));
										fix.append(go);
									}
									row.append(fix);
								}
								list.append(row);
							}
							card.append(top, list);
							cards.append(card);
						}
					};
					const chips = chipGroup(
						doc,
						t('seo.filter'),
						[
							{ value: '', label: t('seo.all'), count: report.checks.length },
							{ value: 'fail', label: t('seo.status.fail'), count: report.summary.fail },
							{ value: 'warn', label: t('seo.status.warn'), count: report.summary.warn },
							{ value: 'pass', label: t('seo.status.pass'), count: report.summary.pass },
						],
						'',
						fillCards,
					);
					fillCards('');
					const swap = h('div', { class: 'swap' });
					const spacer = h('div', { class: 'section' });
					spacer.append(chips);
					swap.append(tiles, spacer, h('div', { class: 'section' }), cards);
					results.replaceChildren(swap);
				};

				const otherPages = () => {
					const paths = /** @type {HTMLTextAreaElement} */ (h('textarea', { rows: '6' }));
					paths.value = pages.join('\n');
					openDialog(root, {
						title: t('seo.pagesTitle'),
						body: [h('p', { class: 'sub' }, t('seo.pagesHelp')), field(t('seo.paths'), paths)],
						submitLabel: t('seo.check'),
						closeLabel: t('seo.cancel'),
						onSubmit: () =>
							check(
								paths.value
									.split(/\s+/)
									.map((path) => path.trim())
									.filter(Boolean),
							),
					});
				};

				run.addEventListener('click', () => void check());
				parts.push(box);
				void start();
			}

			if (on('indexnow')) {
				const key = admin?.indexNow;
				const card = h('section', { class: 'box' });
				const send = h('button', { type: 'button' }, t('indexnow.open'));
				send.addEventListener('click', () => submitDialog());
				const head = h('div', { class: 'head' });
				head.append(h('h2', {}, t('indexnow.title')), send);
				card.append(
					head,
					h('p', { class: 'sub' }, t('indexnow.help')),
					h(
						'p',
						{},
						key?.keySet
							? key.keyLocation
								? t('indexnow.keyAt', { url: key.keyLocation })
								: t('indexnow.badPath')
							: t('indexnow.noKey'),
					),
					indexNowNote,
				);
				parts.push(card);
			}

			const wrap = h('div', { class: 'stack' });
			wrap.append(...parts);
			root.append(wrap);
			const stop = api.tickets.onChange((signedIn) => {
				if (!signedIn) for (const node of root.querySelectorAll('[role="status"]')) node.textContent = t('seo.signedOut');
			});
			return () => {
				stop();
			};
		},
	});
};
