/**
 * Mode A default renderer of the `media` element: the current image (responsive srcset, alt text) or video with
 * previous / next buttons and thumbnails (`gallery`), or a scrollable `strip` of every image. Width and height
 * attributes reserve space (no layout shift). Design tokens only; keyboard operable.
 */
import { createTranslator } from '../headless/strings.js';
import { el, on, statusLine } from './dom.js';

/** Token-only stylesheet. */
export const styles = `
.ss-gallery { color: var(--ss-color-text); font: var(--ss-font-body); min-height: var(--ss-gallery-min-height, 12rem); }
.ss-gallery__main { width: 100%; height: auto; border-radius: var(--ss-radius-md); background: var(--ss-color-surface); }
.ss-gallery__strip { display: flex; gap: var(--ss-space-2); overflow-x: auto; list-style: none; margin: 0; padding: 0; }
.ss-gallery__thumb { background: none; border: 1px solid var(--ss-color-border); border-radius: var(--ss-radius-sm); padding: 0; }
.ss-gallery__thumb[aria-current="true"] { border-color: var(--ss-color-primary); }
.ss-gallery__thumb img { width: var(--ss-gallery-thumb, 4rem); height: var(--ss-gallery-thumb, 4rem); object-fit: cover; }
.ss-gallery__nav { background: var(--ss-color-surface); border: 1px solid var(--ss-color-border); border-radius: var(--ss-radius-sm); color: inherit; }
.ss-gallery button:focus-visible { outline: 2px solid var(--ss-color-focus); }
.ss-gallery__position { color: var(--ss-color-text-muted); }
@media (prefers-reduced-motion: reduce) { .ss-gallery * { scroll-behavior: auto; transition: none; } }
`;

/**
 * @param {import('./dom.js').DomLike} dom
 * @param {import('../headless/gallery.js').GalleryState['media'][number]} media
 * @param {string} className
 */
const mediaNode = (dom, media, className) =>
	media.kind === 'video'
		? el(dom, 'video', {
				class: className,
				src: media.url,
				controls: 'controls',
				preload: 'metadata',
				'aria-label': media.alt,
				width: media.width ? String(media.width) : null,
				height: media.height ? String(media.height) : null,
			})
		: el(dom, 'img', {
				class: className,
				src: media.url,
				srcset: media.srcset,
				alt: media.alt,
				width: media.width ? String(media.width) : null,
				height: media.height ? String(media.height) : null,
				loading: 'lazy',
			});

/**
 * @param {{ state: import('../headless/gallery.js').GalleryState, actions: { next: () => unknown, previous: () => unknown, show: (index: number) => unknown },
 *   strings: Record<string, string>, theme?: { variant?: string }, slots?: Record<string, any>, dom: import('./dom.js').DomLike }} params
 */
export const render = ({ state, actions, strings, theme = {}, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const variant = theme.variant === 'strip' ? 'strip' : 'gallery';
	const current = state.media[state.index] ?? null;
	/** @type {any[]} */
	const body =
		variant === 'strip'
			? [
					el(
						dom,
						'ul',
						{ class: 'ss-gallery__strip' },
						state.media.map((m) => el(dom, 'li', {}, [mediaNode(dom, m, 'ss-gallery__main')])),
					),
				]
			: [
					current
						? mediaNode(dom, current, 'ss-gallery__main')
						: el(dom, 'p', { class: 'ss-gallery__position' }, [t('catalog.gallery.empty')]),
					state.media.length > 1
						? el(dom, 'div', {}, [
								on(
									el(
										dom,
										'button',
										{ type: 'button', class: 'ss-gallery__nav', 'aria-label': t('catalog.gallery.previous') },
										['‹'],
									),
									'click',
									() => actions.previous(),
								),
								el(
									dom,
									'span',
									{ class: 'ss-gallery__position', 'aria-live': 'polite' },
									state.positionText ? [state.positionText] : [],
								),
								on(
									el(
										dom,
										'button',
										{ type: 'button', class: 'ss-gallery__nav', 'aria-label': t('catalog.gallery.next') },
										['›'],
									),
									'click',
									() => actions.next(),
								),
							])
						: null,
					state.media.length > 1
						? el(
								dom,
								'ul',
								{ class: 'ss-gallery__strip', 'aria-label': t('catalog.gallery.thumbnails') },
								state.media.map((m, index) =>
									el(dom, 'li', {}, [
										on(
											el(
												dom,
												'button',
												{
													type: 'button',
													class: 'ss-gallery__thumb',
													'aria-label': t('catalog.gallery.show', { index: index + 1 }),
													...(index === state.index ? { 'aria-current': 'true' } : {}),
												},
												[
													m.kind === 'image'
														? el(dom, 'img', { src: m.url, alt: '', loading: 'lazy' })
														: t('catalog.gallery.video'),
												],
											),
											'click',
											() => actions.show(index),
										),
									]),
								),
							)
						: null,
				];
	return el(
		dom,
		'section',
		{
			class: `ss-gallery ss-gallery--${variant}`,
			role: 'region',
			'aria-label': state.title ? t('catalog.gallery.title_of', { title: state.title }) : t('catalog.gallery.title'),
			'aria-busy': String(state.status === 'loading'),
		},
		[slots.before ?? null, ...body, statusLine(dom, 'ss-gallery', state.error), slots.after ?? null],
	);
};
