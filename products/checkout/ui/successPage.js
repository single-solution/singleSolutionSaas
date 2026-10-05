/**
 * Mode A default renderer of the `success_page` element: the order number and total, the next steps (the current one
 * marked), bank details for an unpaid transfer, a cancel button while the shopper may cancel, and the continue link.
 * Design tokens only.
 */
import { createTranslator } from '../headless/strings.js';
import { el, on, statusLine } from './dom.js';

/** Token-only stylesheet. */
export const styles = `
.ss-success { color: var(--ss-color-text); font: var(--ss-font-body); display: grid; gap: var(--ss-space-3); min-height: var(--ss-success-min-height, 10rem); }
.ss-success__steps { margin: 0; padding-inline-start: var(--ss-space-4); display: grid; gap: var(--ss-space-2); }
.ss-success__step--current { font-weight: var(--ss-font-weight-bold, 700); }
.ss-success__when { color: var(--ss-color-text-muted); }
.ss-success button { background: none; border: 1px solid var(--ss-color-border); border-radius: var(--ss-radius-sm); color: inherit; font: inherit; cursor: pointer; }
.ss-success :focus-visible { outline: 2px solid var(--ss-color-focus); outline-offset: 2px; }
.ss-success__status { color: var(--ss-color-danger); }
`;

/**
 * @param {{ state: import('../headless/successPage.js').SuccessState, actions: { cancel: () => unknown },
 *   strings: Record<string, string>, theme?: Record<string, unknown>, slots?: Record<string, any>, dom: import('./dom.js').DomLike }} params
 */
export const render = ({ state, actions, strings, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const view = state.view;
	if (!view)
		return el(dom, 'section', { class: 'ss-success', 'aria-busy': 'true' }, [statusLine(dom, 'ss-success', state.error)]);
	return el(dom, 'section', { class: 'ss-success', role: 'region', 'aria-label': view.title }, [
		slots.before ?? null,
		el(dom, 'h2', {}, [view.title]),
		el(dom, 'p', {}, [t('success.number', { number: view.order.number, total: state.totalText ?? '' })]),
		el(
			dom,
			'ol',
			{ class: 'ss-success__steps' },
			view.steps.map((/** @type {any} */ step) =>
				el(
					dom,
					'li',
					{
						class: step.current ? 'ss-success__step--current' : 'ss-success__step',
						...(step.current ? { 'aria-current': 'step' } : {}),
					},
					[step.when ? el(dom, 'span', { class: 'ss-success__when' }, [`${step.when} · `]) : null, step.text],
				),
			),
		),
		view.bankDetails.length > 0
			? el(
					dom,
					'dl',
					{},
					view.bankDetails.flatMap((/** @type {any} */ row) => [
						el(dom, 'dt', {}, [row.label]),
						el(dom, 'dd', {}, [row.value]),
					]),
				)
			: null,
		view.order.cancellable
			? on(el(dom, 'button', { type: 'button' }, [t('success.cancel')]), 'click', () => actions.cancel())
			: null,
		el(dom, 'a', { href: view.continueUrl }, [t('success.continue')]),
		statusLine(dom, 'ss-success', state.error),
		slots.after ?? null,
	]);
};
