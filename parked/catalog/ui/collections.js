/**
 * Mode A default renderer of the `collections` element: a navigable `tree` (expand / collapse buttons with
 * `aria-expanded`, the active collection marked `aria-current`) or top-level `cards`. Design tokens only.
 */
import { createTranslator } from '../headless/strings.js';
import { el, on, statusLine } from './dom.js';

/** Token-only stylesheet. */
export const styles = `
.ss-collections { color: var(--ss-color-text); font: var(--ss-font-body); min-height: var(--ss-collections-min-height, 3rem); }
.ss-collections ul { list-style: none; margin: 0; padding-inline-start: var(--ss-space-3); }
.ss-collections--cards > ul { display: grid; gap: var(--ss-space-2); grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr)); padding: 0; }
.ss-collections--cards > ul > li { border: 1px solid var(--ss-color-border); border-radius: var(--ss-radius-md); padding: var(--ss-space-2); background: var(--ss-color-surface); }
.ss-collections__link { background: none; border: 0; color: inherit; text-align: start; }
.ss-collections__link[aria-current="true"] { color: var(--ss-color-primary); font-weight: var(--ss-font-weight-bold, 700); }
.ss-collections__toggle { background: none; border: 0; color: var(--ss-color-text-muted); }
.ss-collections button:focus-visible { outline: 2px solid var(--ss-color-focus); }
`;

/**
 * @param {{ state: import('../headless/collections.js').CollectionsState, actions: { toggle: (id: string) => unknown, select: (id: string) => unknown },
 *   strings: Record<string, string>, theme?: { variant?: string }, slots?: Record<string, any>, dom: import('./dom.js').DomLike }} params
 */
export const render = ({ state, actions, strings, theme = {}, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const variant = theme.variant === 'cards' ? 'cards' : 'tree';
	/** @param {ReadonlyArray<import('../headless/collections.js').TreeNode>} nodes @param {boolean} nested @returns {any} */
	const list = (nodes, nested) =>
		el(
			dom,
			'ul',
			{},
			nodes.map((node) =>
				el(dom, 'li', {}, [
					variant === 'tree' && node.children.length > 0
						? on(
								el(
									dom,
									'button',
									{
										type: 'button',
										class: 'ss-collections__toggle',
										'aria-expanded': String(node.expanded),
										'aria-label': t(node.expanded ? 'catalog.collections.collapse' : 'catalog.collections.expand', {
											title: node.title,
										}),
									},
									[node.expanded ? '−' : '+'],
								),
								'click',
								() => actions.toggle(node.id),
							)
						: null,
					on(
						el(
							dom,
							'button',
							{ type: 'button', class: 'ss-collections__link', ...(node.active ? { 'aria-current': 'true' } : {}) },
							[node.title],
						),
						'click',
						() => actions.select(node.id),
					),
					variant === 'tree' && node.expanded && node.children.length > 0 && nested ? list(node.children, true) : null,
				]),
			),
		);
	return el(
		dom,
		'nav',
		{
			class: `ss-collections ss-collections--${variant}`,
			role: 'navigation',
			'aria-label': t('catalog.collections.title'),
			'aria-busy': String(state.status === 'loading'),
		},
		[
			slots.before ?? null,
			list(state.tree, variant === 'tree'),
			statusLine(dom, 'ss-collections', state.error),
			slots.after ?? null,
		],
	);
};
