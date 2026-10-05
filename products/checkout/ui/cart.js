/**
 * Mode A default renderer of the `cart` element: lines (image, title, unit and line price, quantity stepper, remove),
 * notices of what changed, the subtotal. A pure function of (state, actions, strings, theme, slots) returning DOM built
 * with the injected `dom`; design tokens only; keyboard operable; reserves its minimum height. Variants: `page`, `drawer`.
 */
import { createTranslator } from '../headless/strings.js';
import { el, on, statusLine } from './dom.js';

/** Token-only stylesheet; the Loader adopts it once per page (CSP-safe). */
export const styles = `
.ss-cart { color: var(--ss-color-text); background: var(--ss-color-surface); font: var(--ss-font-body); padding: var(--ss-space-3);
  border-radius: var(--ss-radius-md); min-height: var(--ss-cart-min-height, 8rem); }
.ss-cart__lines { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--ss-space-2); }
.ss-cart__line { display: grid; grid-template-columns: auto 1fr auto; gap: var(--ss-space-2); align-items: center; }
.ss-cart__line--unavailable { opacity: 0.6; }
.ss-cart__image { width: var(--ss-cart-image, 3.5rem); height: var(--ss-cart-image, 3.5rem); object-fit: cover; border-radius: var(--ss-radius-sm); }
.ss-cart__qty { display: inline-flex; gap: var(--ss-space-1); align-items: center; }
.ss-cart button { background: none; border: 1px solid var(--ss-color-border); border-radius: var(--ss-radius-sm); color: inherit; font: inherit; cursor: pointer; padding: 0 var(--ss-space-2); }
.ss-cart button:focus-visible { outline: 2px solid var(--ss-color-focus); outline-offset: 2px; }
.ss-cart__subtotal { font-weight: var(--ss-font-weight-bold, 700); margin-top: var(--ss-space-3); }
.ss-cart__notice, .ss-cart__status { color: var(--ss-color-text-muted); }
@media (prefers-reduced-motion: reduce) { .ss-cart * { transition: none; } }
`;

/**
 * @param {{ state: import('../headless/cart.js').CartState, actions: { setQuantity: (id: string, q: number) => unknown, remove: (id: string) => unknown },
 *   strings: Record<string, string>, theme?: { variant?: string }, slots?: Record<string, any>, dom: import('./dom.js').DomLike }} params
 */
export const render = ({ state, actions, strings, theme = {}, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const variant = theme.variant === 'drawer' ? 'drawer' : 'page';
	const lines = state.cart?.lines ?? [];
	const body =
		lines.length === 0
			? [slots.empty ?? el(dom, 'p', { class: 'ss-cart__empty' }, [t('cart.empty')])]
			: [
					el(
						dom,
						'ul',
						{ class: 'ss-cart__lines', 'aria-label': t('cart.title') },
						lines.map((/** @type {any} */ line) =>
							el(dom, 'li', { class: `ss-cart__line${line.available ? '' : ' ss-cart__line--unavailable'}` }, [
								line.image
									? el(dom, 'img', { class: 'ss-cart__image', src: line.image, alt: '', loading: 'lazy' })
									: el(dom, 'span'),
								el(dom, 'div', {}, [
									line.url ? el(dom, 'a', { href: line.url }, [line.title]) : el(dom, 'span', {}, [line.title]),
									line.variantTitle ? el(dom, 'p', { class: 'ss-cart__notice' }, [line.variantTitle]) : null,
									line.available ? null : el(dom, 'p', { class: 'ss-cart__notice' }, [t('cart.unavailable')]),
									el(dom, 'span', { class: 'ss-cart__qty' }, [
										on(
											el(dom, 'button', { type: 'button', 'aria-label': t('cart.decrease', { title: line.title }) }, [
												'−',
											]),
											'click',
											() => actions.setQuantity(line.lineId, line.quantity - 1),
										),
										el(dom, 'span', { 'aria-live': 'polite' }, [String(line.quantity)]),
										on(
											el(
												dom,
												'button',
												{
													type: 'button',
													'aria-label': t('cart.increase', { title: line.title }),
													...(line.maxQuantity !== null && line.quantity >= line.maxQuantity
														? { disabled: '' }
														: {}),
												},
												['+'],
											),
											'click',
											() => actions.setQuantity(line.lineId, line.quantity + 1),
										),
									]),
								]),
								on(
									el(dom, 'button', { type: 'button', 'aria-label': t('cart.remove', { title: line.title }) }, [
										t('cart.remove_short'),
									]),
									'click',
									() => actions.remove(line.lineId),
								),
							]),
						),
					),
					state.subtotalText
						? el(dom, 'p', { class: 'ss-cart__subtotal' }, [t('cart.subtotal', { amount: state.subtotalText })])
						: null,
				];
	return el(
		dom,
		'section',
		{
			class: `ss-cart ss-cart--${variant}`,
			role: 'region',
			'aria-label': t('cart.title'),
			'aria-busy': String(state.status === 'loading'),
		},
		[
			slots.before ?? null,
			...body,
			...state.notices.map((text) => el(dom, 'p', { class: 'ss-cart__notice' }, [text])),
			statusLine(dom, 'ss-cart', state.error),
			slots.after ?? null,
		],
	);
};
