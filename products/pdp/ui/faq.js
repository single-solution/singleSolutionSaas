/**
 * Mode A renderer of the `faq` element: native `<details>` disclosures (keyboard operable without script), the
 * `FAQPage` JSON-LD of exactly the visible questions. Hidden without questions. Design tokens only.
 * @module
 */
import { createTranslator } from '../headless/strings.js';
import { BASE_STYLES, el, listen, once } from './dom.js';
import { pageSource } from './page.js';

/** @typedef {ReturnType<import('../headless/faq.js').createFaq>} Faq */

export const styles = `${BASE_STYLES}
.ss-faq__title{font-size:var(--ss-font-size-md,1.125em);margin:0 0 var(--ss-space-2)}
.ss-faq__list{border:1px solid var(--ss-color-border);border-radius:var(--ss-radius-md);background:var(--ss-color-surface)}
.ss-faq__entry+.ss-faq__entry{border-top:1px solid var(--ss-color-border)}
.ss-faq__entry{padding:var(--ss-space-2) var(--ss-space-3)}
.ss-faq__question{cursor:pointer;font-weight:var(--ss-font-weight-bold)}
.ss-faq__question h3{display:inline;font-size:inherit;margin:0}
.ss-faq__answer{margin:var(--ss-space-2) 0 0;color:var(--ss-color-text-muted)}`;

/**
 * @param {{ state: ReturnType<Faq['state']>, actions: Faq['actions'], strings: Record<string, string>,
 *   dom: import('./dom.js').DomLike }} props
 * @returns {any}
 */
export const render = ({ state, actions, strings, dom }) => {
	const t = createTranslator(strings);
	once(actions, () => actions.load(pageSource(dom, 'faq')));
	const shown = state.status === 'ready' && state.entries.length > 0;
	const title = state.item?.title ? t('faq.title_item', { title: state.item.title }) : t('faq.title');
	const root = el(dom, 'section', { class: 'ss-pdp ss-faq', role: 'region', 'aria-label': title, hidden: !shown });
	if (!shown) return root;
	const list = el(dom, 'div', { class: 'ss-faq__list' });
	state.entries.forEach((entry, index) => {
		const details = el(dom, 'details', { class: 'ss-faq__entry', open: state.openFirst && index === 0 }, [
			el(dom, 'summary', { class: 'ss-faq__question' }, [el(dom, 'h3', {}, [entry.question])]),
			el(dom, 'p', { class: 'ss-faq__answer' }, [entry.answer]),
		]);
		listen(details, 'toggle', () => {
			if (details.open) void actions.opened(index);
		});
		list.append(details);
	});
	root.append(el(dom, 'h2', { class: 'ss-faq__title' }, [title]), list);
	if (state.json !== '') {
		const script = el(dom, 'script', { type: 'application/ld+json', 'data-ss-pdp': true });
		script.textContent = state.json;
		root.append(script);
	}
	return root;
};
