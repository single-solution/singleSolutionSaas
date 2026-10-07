/**
 * Mode A default renderer of the `warranty` element. Variants: `inline` (one line for the selected tier — next to the
 * price or the variant picker), `terms` (the selected tier's period, text and exclusions) and `table` (every tier).
 */
import { createTranslator } from '../headless/strings.js';
import { el, statusLine } from './dom.js';

/** Token-only stylesheet; the Loader adopts it once per page (CSP-safe). */
export const styles = `
.ss-grades-warranty { color: var(--ss-color-text); font: var(--ss-font-body); min-height: var(--ss-grades-warranty-min-height, 1.5em); }
.ss-grades-warranty__period { font-weight: var(--ss-font-weight-bold, 700); }
.ss-grades-warranty__exclusions { color: var(--ss-color-text-muted); }
.ss-grades-warranty__table { width: 100%; border-collapse: collapse; }
.ss-grades-warranty__table th, .ss-grades-warranty__table td { text-align: start; padding: var(--ss-space-2); border-bottom: 1px solid var(--ss-color-border); vertical-align: top; }
.ss-grades-error { color: var(--ss-color-danger); }
`;

/**
 * @param {import('./dom.js').DomLike} dom
 * @param {import('../headless/warranty.js').Term} term
 * @param {(key: string, params?: Record<string, string | number>) => string} t
 */
const exclusions = (dom, term, t) =>
	term.exclusions.length > 0
		? el(dom, 'div', { class: 'ss-grades-warranty__exclusions' }, [
				el(dom, 'p', {}, [t('warranty.exclusions')]),
				el(
					dom,
					'ul',
					{},
					term.exclusions.map((line) => el(dom, 'li', {}, [line])),
				),
			])
		: null;

/**
 * @param {{ state: import('../headless/warranty.js').WarrantyState, actions?: Record<string, unknown>,
 *   strings: Record<string, string>, theme?: { variant?: string }, slots?: Record<string, any>, dom: import('./dom.js').DomLike }} params
 */
export const render = ({ state, strings, theme = {}, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const variant = theme.variant === 'terms' || theme.variant === 'table' ? theme.variant : 'inline';
	const term = state.current;
	/** @type {any[]} */
	let body;
	if (variant === 'table')
		body = [
			el(dom, 'table', { class: 'ss-grades-warranty__table' }, [
				el(dom, 'caption', {}, [t('warranty.title')]),
				el(dom, 'tbody', {}, [
					...state.terms.map((row) =>
						el(dom, 'tr', {}, [
							el(dom, 'th', { scope: 'row' }, [row.label]),
							el(dom, 'td', {}, [el(dom, 'span', { class: 'ss-grades-warranty__period' }, [row.periodText])]),
							el(dom, 'td', {}, [row.text, exclusions(dom, row, t)]),
						]),
					),
				]),
			]),
		];
	else if (!term) body = [slots.empty ?? null];
	else if (variant === 'terms')
		body = [
			el(dom, 'h3', {}, [t('warranty.for_tier', { tier: term.label })]),
			el(dom, 'p', { class: 'ss-grades-warranty__period' }, [term.periodText]),
			el(dom, 'p', {}, [term.text]),
			exclusions(dom, term, t),
		];
	else body = [t('warranty.inline', { period: term.periodText })];
	return el(
		dom,
		variant === 'inline' ? 'p' : 'section',
		{
			class: `ss-grades-warranty ss-grades-warranty--${variant}`,
			'aria-busy': String(state.status === 'loading'),
			...(variant === 'inline' ? {} : { role: 'region', 'aria-label': t('warranty.title') }),
		},
		[slots.before ?? null, ...body, state.error ? statusLine(dom, state.error) : null, slots.after ?? null],
	);
};
