/**
 * Mode A default renderer of the `offer_apply` element: the code field (a real form: Enter applies), applied codes with
 * their savings and a remove button, and the automatic deals. Design tokens only.
 */
import { createTranslator } from '../headless/strings.js';
import { el, on, statusLine } from './dom.js';

/** Token-only stylesheet. */
export const styles = `
.ss-offers { color: var(--ss-color-text); font: var(--ss-font-body); display: grid; gap: var(--ss-space-2); }
.ss-offers__form { display: flex; gap: var(--ss-space-2); flex-wrap: wrap; }
.ss-offers input { flex: 1 1 10rem; font: inherit; color: inherit; background: var(--ss-color-surface); border: 1px solid var(--ss-color-border); border-radius: var(--ss-radius-sm); padding: var(--ss-space-2); }
.ss-offers button { background: var(--ss-color-primary); color: var(--ss-color-on-primary); border: 0; border-radius: var(--ss-radius-sm); padding: var(--ss-space-2) var(--ss-space-3); font: inherit; cursor: pointer; }
.ss-offers :focus-visible { outline: 2px solid var(--ss-color-focus); outline-offset: 2px; }
.ss-offers__list { list-style: none; margin: 0; padding: 0; }
.ss-offers__status { color: var(--ss-color-danger); }
`;

/**
 * @param {{ state: import('../headless/offerApply.js').OfferState, actions: { setCode: (c: string) => unknown, apply: () => unknown, remove: (c: string) => unknown },
 *   strings: Record<string, string>, theme?: Record<string, unknown>, slots?: Record<string, any>, dom: import('./dom.js').DomLike }} params
 */
export const render = ({ state, actions, strings, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const input = on(
		el(dom, 'input', {
			id: 'ss-offers-code',
			type: 'text',
			name: 'code',
			autocomplete: 'off',
			maxlength: '64',
			value: state.code,
			...(state.error ? { 'aria-invalid': 'true' } : {}),
		}),
		'input',
		(event) => actions.setCode(String(event.target?.value ?? '')),
	);
	const form = on(
		el(dom, 'form', { class: 'ss-offers__form', novalidate: '' }, [
			el(dom, 'label', { for: 'ss-offers-code' }, [t('offers.label')]),
			input,
			el(
				dom,
				'button',
				{ type: 'submit', ...(state.status === 'loading' || state.codes.length >= state.maxCodes ? { disabled: '' } : {}) },
				[t('offers.apply')],
			),
		]),
		'submit',
		(event) => {
			event.preventDefault?.();
			actions.apply();
		},
	);
	return el(
		dom,
		'section',
		{ class: 'ss-offers', role: 'region', 'aria-label': t('offers.title'), 'aria-busy': String(state.status === 'loading') },
		[
			slots.before ?? null,
			form,
			el(dom, 'ul', { class: 'ss-offers__list' }, [
				...state.applied.map((entry) =>
					el(dom, 'li', {}, [
						entry.text,
						on(
							el(dom, 'button', { type: 'button', 'aria-label': t('offers.remove', { code: entry.code }) }, [
								t('offers.remove_short'),
							]),
							'click',
							() => actions.remove(entry.code),
						),
					]),
				),
				...state.deals.map((deal) => el(dom, 'li', {}, [deal.text])),
			]),
			statusLine(dom, 'ss-offers', state.error),
			slots.after ?? null,
		],
	);
};
