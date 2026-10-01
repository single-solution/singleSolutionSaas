/**
 * Mode A renderer of `showcase`. Variants: `cards`, `compare` (table) and `single` (tabs). Videos are links (no
 * third-party embeds); images are lazy with a reserved aspect ratio.
 */
import { createTranslator } from '../headless/strings.js';
import { BADGE_STYLES, badgeNode } from './badge.js';
import { el, paint, statusLine } from './dom.js';

/** Token-only stylesheet; the Loader adopts it once per page (CSP-safe). */
export const styles = `${BADGE_STYLES}
.ss-grades-showcase { color: var(--ss-color-text); font: var(--ss-font-body); min-height: var(--ss-grades-showcase-min-height, 6rem); }
.ss-grades-showcase__cards { display: grid; gap: var(--ss-space-3); grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); }
.ss-grades-showcase__card { background: var(--ss-color-surface); border: 1px solid var(--ss-color-border);
  border-top: 3px solid var(--ss-grades-tier, var(--ss-color-primary)); border-radius: var(--ss-radius-md); padding: var(--ss-space-3); }
.ss-grades-showcase__card h3 { margin: var(--ss-space-2) 0 var(--ss-space-1); }
.ss-grades-showcase__images { display: flex; gap: var(--ss-space-1); flex-wrap: wrap; }
.ss-grades-showcase__images img { width: 6rem; aspect-ratio: var(--ss-grades-image-ratio, 4 / 3); object-fit: cover; border-radius: var(--ss-radius-sm); }
.ss-grades-showcase__table { width: 100%; border-collapse: collapse; }
.ss-grades-showcase__table th, .ss-grades-showcase__table td { text-align: start; padding: var(--ss-space-2); border-bottom: 1px solid var(--ss-color-border); vertical-align: top; }
.ss-grades-showcase__tabs { display: flex; gap: var(--ss-space-1); flex-wrap: wrap; margin-bottom: var(--ss-space-2); }
.ss-grades-showcase__tab { background: none; border: 1px solid var(--ss-color-border); border-radius: var(--ss-radius-sm); color: var(--ss-color-text); padding: var(--ss-space-1) var(--ss-space-2); }
.ss-grades-showcase__tab[aria-selected="true"] { border-color: var(--ss-grades-tier, var(--ss-color-primary)); font-weight: var(--ss-font-weight-bold, 700); }
.ss-grades-showcase a:focus-visible, .ss-grades-showcase button:focus-visible { outline: 2px solid var(--ss-color-focus); }
`;

/**
 * @param {import('./dom.js').DomLike} dom
 * @param {import('../headless/showcase.js').ShowcaseEntry} entry
 * @param {(key: string, params?: Record<string, string | number>) => string} t
 */
const card = (dom, entry, t) =>
	paint(
		el(dom, 'article', { class: 'ss-grades-showcase__card', 'data-tier': entry.tier.key }, [
			badgeNode(dom, entry.tier),
			el(dom, 'h3', {}, [entry.headline]),
			entry.body ? el(dom, 'p', {}, [entry.body]) : null,
			entry.bullets.length > 0
				? el(
						dom,
						'ul',
						{},
						entry.bullets.map((line) => el(dom, 'li', {}, [line])),
					)
				: null,
			entry.warrantyText ? el(dom, 'p', { class: 'ss-grades-muted' }, [entry.warrantyText]) : null,
			entry.images.length > 0
				? el(
						dom,
						'div',
						{ class: 'ss-grades-showcase__images' },
						entry.images.map((image) =>
							el(dom, 'img', { src: image.url, alt: image.alt, loading: 'lazy', decoding: 'async' }),
						),
					)
				: null,
			entry.video
				? el(dom, 'p', {}, [
						el(dom, 'a', { href: entry.video, target: '_blank', rel: 'noopener noreferrer' }, [
							t('showcase.video', { tier: entry.tier.label }),
						]),
					])
				: null,
		]),
		entry.tier.color,
	);

/**
 * @param {{ state: import('../headless/showcase.js').ShowcaseState, actions: { select: (tier: string) => unknown },
 *   strings: Record<string, string>, theme?: { variant?: string }, slots?: Record<string, any>, dom: import('./dom.js').DomLike }} params
 */
export const render = ({ state, actions, strings, theme = {}, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const requested = theme.variant ?? state.layout;
	const variant = requested === 'compare' || requested === 'single' ? requested : 'cards';
	/** @type {any[]} */
	let body;
	if (state.entries.length === 0) body = [slots.empty ?? el(dom, 'p', { class: 'ss-grades-muted' }, [t('showcase.empty')])];
	else if (variant === 'compare')
		body = [
			el(dom, 'table', { class: 'ss-grades-showcase__table' }, [
				el(dom, 'caption', { class: 'ss-grades-muted' }, [t('showcase.compare.caption')]),
				el(dom, 'thead', {}, [
					el(dom, 'tr', {}, [
						el(dom, 'th', { scope: 'col' }, [t('showcase.compare.tier')]),
						el(dom, 'th', { scope: 'col' }, [t('showcase.compare.meaning')]),
						el(dom, 'th', { scope: 'col' }, [t('showcase.compare.warranty')]),
					]),
				]),
				el(
					dom,
					'tbody',
					{},
					state.entries.map((entry) =>
						el(dom, 'tr', {}, [
							el(dom, 'th', { scope: 'row' }, [badgeNode(dom, entry.tier)]),
							el(dom, 'td', {}, [entry.body || entry.headline]),
							el(dom, 'td', {}, [entry.warrantyText ?? '—']),
						]),
					),
				),
			]),
		];
	else if (variant === 'single') {
		const current = state.current;
		body = [
			el(
				dom,
				'div',
				{ class: 'ss-grades-showcase__tabs', role: 'tablist', 'aria-label': t('showcase.title') },
				state.entries.map((entry) => {
					const selected = entry.tier.key === current?.tier.key;
					const tab = paint(
						el(
							dom,
							'button',
							{
								type: 'button',
								role: 'tab',
								class: 'ss-grades-showcase__tab',
								'aria-selected': String(selected),
								tabindex: selected ? '0' : '-1',
							},
							[entry.tier.label],
						),
						entry.tier.color,
					);
					tab.addEventListener('click', () => actions.select(entry.tier.key));
					return tab;
				}),
			),
			current ? el(dom, 'div', { role: 'tabpanel' }, [card(dom, current, t)]) : null,
		];
	} else
		body = [
			el(
				dom,
				'div',
				{ class: 'ss-grades-showcase__cards' },
				state.entries.map((entry) => card(dom, entry, t)),
			),
		];
	return el(
		dom,
		'section',
		{
			class: `ss-grades-showcase ss-grades-showcase--${variant}`,
			role: 'region',
			'aria-label': t('showcase.title'),
			'aria-busy': String(state.status === 'loading'),
		},
		[
			slots.before ?? null,
			el(dom, 'h2', { class: 'ss-grades-showcase__title' }, [t('showcase.title')]),
			...body,
			statusLine(dom, state.error),
			slots.after ?? null,
		],
	);
};
