/**
 * Mode A default renderer of the `tiers` element: a pure function of (state, actions, strings, theme, slots) that
 * returns DOM built with the injected `dom`. Variants: `badge` (the item's or selected variant's tier — product
 * cards, detail pages), `list` (every tier the item is offered in) and `legend` (all tiers with their notes).
 */
import { createTranslator } from '../headless/strings.js';
import { BADGE_STYLES, badgeNode } from './badge.js';
import { el, statusLine } from './dom.js';

/** Token-only stylesheet; the Loader adopts it once per page (CSP-safe). */
export const styles = `${BADGE_STYLES}
.ss-grades-tiers { color: var(--ss-color-text); font: var(--ss-font-body); min-height: var(--ss-grades-min-height, 1.6em); }
.ss-grades-tiers__list { display: flex; flex-wrap: wrap; gap: var(--ss-space-1); list-style: none; margin: 0; padding: 0; }
.ss-grades-tiers__legend { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--ss-space-2); }
.ss-grades-tiers__legend p { margin: var(--ss-space-1) 0 0; color: var(--ss-color-text-muted); }
`;

/**
 * @param {{ state: import('../headless/tiers.js').TiersState, actions?: Record<string, unknown>, strings: Record<string, string>,
 *   theme?: { variant?: string }, slots?: Record<string, any>, dom: import('./dom.js').DomLike }} params
 */
export const render = ({ state, strings, theme = {}, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const variant = theme.variant === 'list' || theme.variant === 'legend' ? theme.variant : 'badge';
	/** @type {any[]} */
	let body;
	if (variant === 'legend')
		body = [
			el(dom, 'h2', { class: 'ss-grades-tiers__title' }, [t('tiers.title')]),
			el(
				dom,
				'ul',
				{ class: 'ss-grades-tiers__legend' },
				state.legend.map((badge) =>
					el(dom, 'li', {}, [badgeNode(dom, badge), badge.description ? el(dom, 'p', {}, [badge.description]) : null]),
				),
			),
		];
	else if (variant === 'list')
		body =
			state.offered.length > 0
				? [
						el(
							dom,
							'ul',
							{ class: 'ss-grades-tiers__list', 'aria-label': t('tiers.offered') },
							state.offered.map((badge) => el(dom, 'li', {}, [badgeNode(dom, badge, { short: true })])),
						),
					]
				: [slots.empty ?? null];
	else body = state.current ? [badgeNode(dom, state.current)] : [slots.empty ?? null];
	return el(
		dom,
		variant === 'badge' ? 'span' : 'section',
		{
			class: `ss-grades-tiers ss-grades-tiers--${variant}`,
			'aria-busy': String(state.status === 'loading'),
			...(variant === 'badge' ? {} : { role: 'region', 'aria-label': t('tiers.title') }),
		},
		[slots.before ?? null, ...body, state.error ? statusLine(dom, state.error) : null, slots.after ?? null],
	);
};
