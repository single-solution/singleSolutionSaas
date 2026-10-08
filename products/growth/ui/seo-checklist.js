/**
 * The SEO checklist (admin widget `seo_checklist`; PLAN 0.8.9): with the SEO checklist on (ticket `seo.check`), a
 * button checks the website's pages on request and lists every check (passed, improve, fix) with its fix steps; with
 * IndexNow on (ticket `indexnow.submit`), a box submits page addresses. Every word is a widget text.
 * @module
 */
import { mountWidget } from '@ss/app-kit/widget';
import { adminCall } from './tickets.js';
import { element } from './dom.js';
import { WIDGET_CSS } from './styles.js';

/**
 * Fill `{name}` placeholders.
 * @param {string} text @param {Record<string, string | number>} values
 */
const fill = (text, values) =>
	text.replace(/\{(\w+)\}/g, (match, key) => (Object.hasOwn(values, key) ? String(values[key]) : match));

/** Order of the statuses in the list: what to fix first. */
const ORDER = Object.freeze({ fail: 0, warn: 1, pass: 2 });

/**
 * @param {{ host: HTMLElement, api: import('./tickets.js').AdminApi, config: import('./widget.js').WidgetConfig }} input
 */
export const mountSeoChecklist = ({ host, api, config }) => {
	/** @param {string} key @param {Record<string, string | number>} [values] */
	const t = (key, values) => fill(config.texts[key] ?? key, values ?? {});
	const on = (/** @type {string} */ feature) => config.features.includes(feature);
	return mountWidget({
		host,
		theme: config.theme,
		customCss: config.customCss,
		css: WIDGET_CSS,
		render: (root) => {
			const doc = root.ownerDocument;
			/** @param {string} tag @param {Record<string, string>} [attributes] @param {string} [text] */
			const h = (tag, attributes, text) => element(doc, tag, attributes, text);
			/** @param {{ ok: boolean, status: number, data: any }} answer @param {string} fallback */
			const failure = (answer, fallback) =>
				answer.status === 0 && !api.tickets.current() ? t('seo.signedOut') : (answer.data?.detail ?? t(fallback));
			const parts = [];

			if (on('seo_checklist')) {
				const run = h('button', { type: 'button' }, t('seo.run'));
				const status = h('p', { class: 'status', role: 'status' });
				const summary = h('p', { class: 'lead' });
				const list = h('ul', { class: 'checks' });
				const head = h('div', { class: 'head' });
				head.append(h('h2', {}, t('seo.title')), run);
				const box = h('section', { class: 'box' });
				box.append(head, status, summary, list);
				run.addEventListener('click', async () => {
					run.setAttribute('disabled', '');
					status.textContent = t('seo.running');
					const answer = await adminCall(api, 'POST', '/v1/admin/seo/checks', {});
					run.removeAttribute('disabled');
					if (!answer.ok) {
						status.textContent = failure(answer, 'seo.failed');
						return;
					}
					const report = answer.data;
					status.textContent = t('seo.checkedAt', { time: new Date(report.checkedAt).toLocaleString() });
					summary.textContent = t('seo.summary', report.summary);
					const checks = [...report.checks].sort(
						(a, b) =>
							ORDER[/** @type {keyof typeof ORDER} */ (a.status)] - ORDER[/** @type {keyof typeof ORDER} */ (b.status)],
					);
					list.replaceChildren(
						...checks.map((check) => {
							const item = h('li');
							const line = h('div');
							line.append(h('span', { class: `pill ${check.status}` }, t(`seo.status.${check.status}`)));
							line.append(h('strong', {}, check.title));
							item.append(line);
							if (check.page) item.append(h('span', { class: 'meta' }, check.page));
							if (check.fix) {
								const fix = h('p', { class: 'fix' });
								fix.append(h('strong', {}, `${t('seo.fix')}: `), check.fix);
								item.append(fix);
							}
							return item;
						}),
					);
				});
				parts.push(box);
			}

			if (on('indexnow')) {
				const urls = /** @type {HTMLTextAreaElement} */ (h('textarea', { id: 'ss-growth-urls', rows: '4' }));
				const submit = h('button', { type: 'submit' }, t('indexnow.submit'));
				const status = h('p', { class: 'status', role: 'status' });
				const form = h('form', { class: 'box' });
				form.append(
					h('h2', {}, t('indexnow.title')),
					h('p', { class: 'lead' }, t('indexnow.help')),
					h('label', { for: 'ss-growth-urls' }, t('indexnow.urls')),
					urls,
					h('div', { class: 'actions' }),
					status,
				);
				form.querySelector('.actions')?.append(submit);
				form.addEventListener('submit', async (event) => {
					event.preventDefault();
					const list = urls.value
						.split(/\s+/)
						.map((url) => url.trim())
						.filter(Boolean);
					submit.setAttribute('disabled', '');
					const answer = await adminCall(api, 'POST', '/v1/admin/indexnow', { urls: list });
					submit.removeAttribute('disabled');
					if (!answer.ok) {
						status.textContent = t('indexnow.failed', { reason: failure(answer, 'seo.failed') });
						return;
					}
					status.textContent = t('indexnow.done', { count: answer.data.submitted });
					urls.value = '';
				});
				parts.push(form);
			}
			const wrap = h('div', { class: 'grid' });
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
