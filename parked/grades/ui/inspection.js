/**
 * Mode A default renderer of the `inspection` element: the shareable unit report. Variants: `report` (tier, score,
 * every checklist answer with notes and photos, a keyboard-closable photo viewer) and `summary` (tier and score).
 */
import { createTranslator } from '../headless/strings.js';
import { BADGE_STYLES, badgeNode } from './badge.js';
import { el, statusLine } from './dom.js';

/** Token-only stylesheet; the Loader adopts it once per page (CSP-safe). */
export const styles = `${BADGE_STYLES}
.ss-grades-report { color: var(--ss-color-text); background: var(--ss-color-surface); font: var(--ss-font-body);
  border: 1px solid var(--ss-color-border); border-radius: var(--ss-radius-md); padding: var(--ss-space-3); min-height: var(--ss-grades-report-min-height, 4rem); }
.ss-grades-report__head { display: flex; flex-wrap: wrap; gap: var(--ss-space-2); align-items: center; }
.ss-grades-report__rows { list-style: none; margin: var(--ss-space-3) 0 0; padding: 0; }
.ss-grades-report__row { border-top: 1px solid var(--ss-color-border); padding: var(--ss-space-2) 0; }
.ss-grades-report__answer--pass { color: var(--ss-color-success); }
.ss-grades-report__answer--fail { color: var(--ss-color-danger); }
.ss-grades-report__thumbs { display: flex; gap: var(--ss-space-1); flex-wrap: wrap; }
.ss-grades-report__thumb { padding: 0; border: 1px solid var(--ss-color-border); border-radius: var(--ss-radius-sm); background: none; cursor: zoom-in; }
.ss-grades-report__thumb img { width: 5rem; aspect-ratio: 1; object-fit: cover; display: block; }
.ss-grades-report__viewer img { max-width: 100%; height: auto; }
.ss-grades-report button:focus-visible { outline: 2px solid var(--ss-color-focus); }
`;

/**
 * @param {{ state: import('../headless/inspection.js').InspectionState,
 *   actions: { openPhoto: (item: string, index: number) => unknown, closePhoto: () => unknown },
 *   strings: Record<string, string>, theme?: { variant?: string }, slots?: Record<string, any>, dom: import('./dom.js').DomLike }} params
 */
export const render = ({ state, actions, strings, theme = {}, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const variant = theme.variant === 'summary' ? 'summary' : 'report';
	const head = el(dom, 'div', { class: 'ss-grades-report__head' }, [
		state.tier ? badgeNode(dom, state.tier) : null,
		state.scoreText ? el(dom, 'span', {}, [state.scoreText]) : null,
		state.dateText ? el(dom, 'span', { class: 'ss-grades-muted' }, [t('inspection.date', { date: state.dateText })]) : null,
	]);
	/** @type {any[]} */
	const body = state.status === 'ready' ? [head] : [slots.empty ?? null];
	if (variant === 'report' && state.status === 'ready') {
		if (state.serial) body.push(el(dom, 'p', { class: 'ss-grades-muted' }, [t('inspection.serial', { serial: state.serial })]));
		if (state.inspector)
			body.push(el(dom, 'p', { class: 'ss-grades-muted' }, [t('inspection.inspector', { name: state.inspector })]));
		body.push(
			el(
				dom,
				'ul',
				{ class: 'ss-grades-report__rows', 'aria-label': state.checklist ?? t('inspection.title') },
				state.rows.map((row) =>
					el(dom, 'li', { class: 'ss-grades-report__row' }, [
						el(dom, 'strong', {}, [row.label]),
						' ',
						el(
							dom,
							'span',
							{
								class:
									row.passed === null
										? 'ss-grades-report__answer'
										: `ss-grades-report__answer ss-grades-report__answer--${row.passed ? 'pass' : 'fail'}`,
							},
							[row.answer],
						),
						row.note ? el(dom, 'p', { class: 'ss-grades-muted' }, [row.note]) : null,
						row.photos.length > 0
							? el(
									dom,
									'div',
									{ class: 'ss-grades-report__thumbs' },
									row.photos.map((photo, index) => {
										const label = t('inspection.photo.alt', { item: row.label, number: index + 1 });
										const thumb = el(
											dom,
											'button',
											{ type: 'button', class: 'ss-grades-report__thumb', 'aria-label': label },
											[el(dom, 'img', { src: photo.url, alt: '', loading: 'lazy', decoding: 'async' })],
										);
										thumb.addEventListener('click', () => actions.openPhoto(row.item, index));
										return thumb;
									}),
								)
							: null,
					]),
				),
			),
		);
		if (state.photo) {
			const close = el(dom, 'button', { type: 'button' }, [t('inspection.photo.close')]);
			close.addEventListener('click', () => actions.closePhoto());
			const viewer = el(dom, 'div', { class: 'ss-grades-report__viewer', role: 'dialog', 'aria-label': state.photo.alt }, [
				el(dom, 'img', { src: state.photo.url, alt: state.photo.alt }),
				close,
			]);
			viewer.addEventListener('keydown', (/** @type {{ key?: string }} */ event) => {
				if (event.key === 'Escape') actions.closePhoto();
			});
			body.push(viewer);
		}
	}
	return el(
		dom,
		'section',
		{
			class: `ss-grades-report ss-grades-report--${variant}`,
			role: 'region',
			'aria-label': t('inspection.title'),
			'aria-busy': String(state.status === 'loading'),
		},
		[
			slots.before ?? null,
			el(dom, 'h2', {}, [t('inspection.title')]),
			...body,
			statusLine(dom, state.error),
			slots.after ?? null,
		],
	);
};
