/**
 * Mode A default renderer of the `mapping` element: the condition statement of an item or variant — its tier and how
 * it reads in the vocabularies the merchant displays (e.g. "Shopping feed condition: used"). Variants: `statement`
 * (one line) and `table` (a definition list).
 */
import { createTranslator } from '../headless/strings.js';
import { BADGE_STYLES, badgeNode } from './badge.js';
import { el, statusLine } from './dom.js';

/** Token-only stylesheet; the Loader adopts it once per page (CSP-safe). */
export const styles = `${BADGE_STYLES}
.ss-grades-mapping { color: var(--ss-color-text); font: var(--ss-font-body); min-height: var(--ss-grades-mapping-min-height, 1.5em); }
.ss-grades-mapping__list { display: grid; grid-template-columns: max-content 1fr; gap: var(--ss-space-1) var(--ss-space-3); margin: var(--ss-space-2) 0 0; }
.ss-grades-mapping__list dt { color: var(--ss-color-text-muted); }
.ss-grades-mapping__list dd { margin: 0; }
`;

/**
 * @param {{ state: import('../headless/mapping.js').MappingState, actions?: Record<string, unknown>,
 *   strings: Record<string, string>, theme?: { variant?: string }, slots?: Record<string, any>, dom: import('./dom.js').DomLike }} params
 */
export const render = ({ state, strings, theme = {}, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const variant = theme.variant === 'table' ? 'table' : 'statement';
	/** @type {any[]} */
	let body;
	if (!state.tier) body = [slots.empty ?? null];
	else if (variant === 'table')
		body = [
			badgeNode(dom, state.tier),
			el(
				dom,
				'dl',
				{ class: 'ss-grades-mapping__list' },
				state.rows.flatMap((row) => [el(dom, 'dt', {}, [row.name]), el(dom, 'dd', {}, [row.text])]),
			),
		];
	else
		body = [
			t('mapping.statement', { tier: state.tier.label }),
			...state.rows.map((row) => el(dom, 'span', { class: 'ss-grades-muted' }, [` · ${row.name}: ${row.text}`])),
		];
	return el(
		dom,
		variant === 'table' ? 'section' : 'p',
		{
			class: `ss-grades-mapping ss-grades-mapping--${variant}`,
			'aria-busy': String(state.status === 'loading'),
			...(variant === 'table' ? { role: 'region', 'aria-label': t('mapping.title') } : {}),
		},
		[slots.before ?? null, ...body, state.error ? statusLine(dom, state.error) : null, slots.after ?? null],
	);
};
