/**
 * Mode A default renderer of the `brands` element: brand `logos` (name as alt text, name shown without a logo) or a
 * plain `list`; the selected brand is `aria-pressed`. Design tokens only.
 */
import { createTranslator } from '../headless/strings.js';
import { el, on, statusLine } from './dom.js';

/** Token-only stylesheet. */
export const styles = `
.ss-brands { color: var(--ss-color-text); font: var(--ss-font-body); min-height: var(--ss-brands-min-height, 3rem); }
.ss-brands__list { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--ss-space-2); }
.ss-brands--list .ss-brands__list { display: block; }
.ss-brands__brand { background: var(--ss-color-surface); border: 1px solid var(--ss-color-border); border-radius: var(--ss-radius-sm); color: inherit; padding: var(--ss-space-1) var(--ss-space-2); }
.ss-brands__brand[aria-pressed="true"] { border-color: var(--ss-color-primary); }
.ss-brands__brand:focus-visible { outline: 2px solid var(--ss-color-focus); }
.ss-brands__logo { height: var(--ss-brands-logo-height, 2rem); width: auto; }
`;

/**
 * @param {{ state: import('../headless/brands.js').BrandsState, actions: { select: (id: string | null) => unknown },
 *   strings: Record<string, string>, theme?: { variant?: string }, slots?: Record<string, any>, dom: import('./dom.js').DomLike }} params
 */
export const render = ({ state, actions, strings, theme = {}, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const variant = theme.variant === 'list' ? 'list' : 'logos';
	return el(
		dom,
		'div',
		{
			class: `ss-brands ss-brands--${variant}`,
			role: 'list',
			'aria-label': t('catalog.brands.title'),
			'aria-busy': String(state.status === 'loading'),
		},
		[
			slots.before ?? null,
			el(
				dom,
				'ul',
				{ class: 'ss-brands__list' },
				state.brands.map((brand) =>
					el(dom, 'li', { role: 'listitem' }, [
						on(
							el(dom, 'button', { type: 'button', class: 'ss-brands__brand', 'aria-pressed': String(brand.selected) }, [
								variant === 'logos' && brand.logo?.url
									? el(dom, 'img', {
											class: 'ss-brands__logo',
											src: brand.logo.url,
											alt: brand.logo.alt ?? brand.name,
											loading: 'lazy',
										})
									: brand.name,
							]),
							'click',
							() => actions.select(brand.selected ? null : brand.id),
						),
					]),
				),
			),
			statusLine(dom, 'ss-brands', state.error),
			slots.after ?? null,
		],
	);
};
