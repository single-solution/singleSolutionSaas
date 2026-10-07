/**
 * Mode A default renderer of the `fulfilment` element: a tracking lookup form (order number + e-mail or phone) and the
 * result (status, carrier link, timeline), as a `card` or `inline`. Design tokens only.
 */
import { createTranslator } from '../headless/strings.js';
import { el, on, statusLine } from './dom.js';

/** Token-only stylesheet. */
export const styles = `
.ss-tracking { color: var(--ss-color-text); font: var(--ss-font-body); min-height: var(--ss-tracking-min-height, 5rem); }
.ss-tracking--card { background: var(--ss-color-surface); border: 1px solid var(--ss-color-border); border-radius: var(--ss-radius-md); padding: var(--ss-space-3); }
.ss-tracking__form { display: flex; flex-wrap: wrap; gap: var(--ss-space-2); align-items: end; }
.ss-tracking__input { border: 1px solid var(--ss-color-border); border-radius: var(--ss-radius-sm); padding: var(--ss-space-1); }
.ss-tracking__button { background: var(--ss-color-primary); border: 0; border-radius: var(--ss-radius-sm); color: var(--ss-color-on-primary); padding: var(--ss-space-1) var(--ss-space-3); }
.ss-tracking__input:focus-visible, .ss-tracking__button:focus-visible { outline: 2px solid var(--ss-color-focus); }
`;

/**
 * @param {{ state: import('../headless/tracking.js').TrackingState,
 *   actions: { setNumber: (v: string) => unknown, setContact: (v: string) => unknown, lookup: () => unknown },
 *   strings: Record<string, string>, theme?: { variant?: string }, slots?: Record<string, any>, dom: import('./dom.js').DomLike }} params
 */
export const render = ({ state, actions, strings, theme = {}, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const variant = theme.variant === 'inline' ? 'inline' : 'card';
	/**
	 * @param {string} id
	 * @param {string} label
	 * @param {string} value
	 * @param {(v: string) => unknown} set
	 */
	const field = (id, label, value, set) =>
		el(dom, 'label', { for: id }, [
			label,
			' ',
			on(el(dom, 'input', { id, class: 'ss-tracking__input', value, required: '' }), 'input', (event) =>
				set(event?.target?.value ?? ''),
			),
		]);
	const result = state.result;
	return el(
		dom,
		'section',
		{
			class: `ss-tracking ss-tracking--${variant}`,
			role: 'region',
			'aria-label': t('tracking.title'),
			'aria-busy': String(state.status === 'loading'),
		},
		[
			slots.before ?? null,
			on(
				el(dom, 'form', { class: 'ss-tracking__form' }, [
					field('ss-tracking-number', t('tracking.number'), state.number, actions.setNumber),
					field('ss-tracking-contact', t('tracking.contact'), state.contact, actions.setContact),
					el(dom, 'button', { type: 'submit', class: 'ss-tracking__button' }, [t('tracking.submit')]),
				]),
				'submit',
				(event) => {
					event?.preventDefault?.();
					actions.lookup();
				},
			),
			result
				? el(dom, 'div', { class: 'ss-tracking__result' }, [
						el(dom, 'p', {}, [el(dom, 'strong', {}, [result.statusLabel])]),
						result.tracking?.trackingNumber
							? el(dom, 'p', {}, [
									result.tracking.trackingUrl
										? el(
												dom,
												'a',
												{ href: result.tracking.trackingUrl, rel: 'noopener noreferrer', target: '_blank' },
												[
													t('tracker.track', {
														carrier: result.tracking.carrier ?? '',
														number: result.tracking.trackingNumber,
													}),
												],
											)
										: t('tracker.track', {
												carrier: result.tracking.carrier ?? '',
												number: result.tracking.trackingNumber,
											}),
								])
							: null,
						el(
							dom,
							'ol',
							{},
							(result.timeline ?? []).map((/** @type {any} */ e) =>
								el(dom, 'li', {}, [`${e.statusLabel} — ${String(e.at ?? '').slice(0, 10)}`]),
							),
						),
					])
				: null,
			statusLine(dom, 'ss-tracking', state.error),
			slots.after ?? null,
		],
	);
};
