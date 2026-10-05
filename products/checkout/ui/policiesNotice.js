/**
 * Mode A default renderer of the `policies_notice` element: links to the policies, a checkbox for each required one.
 * Design tokens only.
 */
import { createTranslator } from '../headless/strings.js';
import { el, on, statusLine } from './dom.js';

/** Token-only stylesheet. */
export const styles = `
.ss-policies { color: var(--ss-color-text); font: var(--ss-font-body); display: grid; gap: var(--ss-space-1); border: 0; padding: 0; }
.ss-policies a { color: var(--ss-color-primary); }
.ss-policies :focus-visible { outline: 2px solid var(--ss-color-focus); outline-offset: 2px; }
.ss-policies__status { color: var(--ss-color-text-muted); }
`;

/**
 * @param {{ state: import('../headless/policiesNotice.js').PoliciesState, actions: { setAccepted: (key: string, on: boolean) => unknown },
 *   strings: Record<string, string>, theme?: Record<string, unknown>, slots?: Record<string, any>, dom: import('./dom.js').DomLike }} params
 */
export const render = ({ state, actions, strings, slots = {}, dom }) => {
	const t = createTranslator(strings);
	return el(dom, 'fieldset', { class: 'ss-policies', role: 'group', 'aria-label': t('policies.title') }, [
		slots.before ?? null,
		...state.items.map((item) => {
			const link = item.url
				? el(dom, 'a', { href: item.url, target: '_blank', rel: 'noopener' }, [item.label])
				: el(dom, 'span', {}, [item.label]);
			if (!item.required) return el(dom, 'p', {}, [link]);
			const id = `ss-policy-${item.key}`;
			return el(dom, 'label', { for: id }, [
				on(
					el(dom, 'input', {
						id,
						type: 'checkbox',
						required: '',
						'aria-required': 'true',
						...(state.accepted.includes(item.key) ? { checked: '' } : {}),
					}),
					'change',
					(event) => actions.setAccepted(item.key, Boolean(event.target?.checked)),
				),
				el(dom, 'span', {}, [t('policies.accept')]),
				link,
			]);
		}),
		statusLine(dom, 'ss-policies', state.error),
		slots.after ?? null,
	]);
};
