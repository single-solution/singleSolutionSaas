/**
 * Renderer of `gallery`: carousel with thumbnails, grid or stacked; images and videos; zoom dialog. Keys: arrows,
 * Home and End move (viewer, thumbnails, dialog), Enter/Space zooms, Escape closes and focus returns; swipe on touch.
 * The priority image loads eagerly (high fetch priority), the rest lazily; the frame keeps its aspect ratio (no CLS).
 */
import { createTranslator } from '../headless/strings.js';
import { BASE_STYLES, el, listen, once, refocusing } from './dom.js';
import { pageSource } from './page.js';

/** @typedef {ReturnType<import('../headless/gallery.js').createGallery>} Gallery */
/** @typedef {import('../core/item.js').Image} Image */

export const styles = `${BASE_STYLES}
.ss-gallery{display:grid;gap:var(--ss-space-2)}
.ss-gallery__viewer{position:relative;overflow:hidden;background:var(--ss-color-surface-2,var(--ss-color-surface));border-radius:var(--ss-radius-md);touch-action:pan-y}
.ss-gallery__frame{display:block;width:100%}.ss-gallery--r1x1 .ss-gallery__frame{aspect-ratio:1/1}.ss-gallery--r4x3 .ss-gallery__frame{aspect-ratio:4/3}
.ss-gallery--r3x4 .ss-gallery__frame{aspect-ratio:3/4}.ss-gallery--r4x5 .ss-gallery__frame{aspect-ratio:4/5}.ss-gallery--r16x9 .ss-gallery__frame{aspect-ratio:16/9}
.ss-gallery__media{display:block;width:100%;height:100%;object-fit:contain}.ss-gallery--rauto .ss-gallery__media{height:auto}
.ss-gallery__btn{position:absolute;border:0;border-radius:var(--ss-radius-full);background:var(--ss-color-surface);color:var(--ss-color-text);padding:var(--ss-space-2);box-shadow:var(--ss-shadow-md)}
.ss-gallery__btn--prev{left:var(--ss-space-2);top:45%}.ss-gallery__btn--next{right:var(--ss-space-2);top:45%}.ss-gallery__btn--zoom,.ss-gallery__btn--close{right:var(--ss-space-2);top:var(--ss-space-2)}
.ss-gallery__count{position:absolute;bottom:var(--ss-space-2);left:var(--ss-space-2);margin:0;font-size:var(--ss-font-size-xs);background:var(--ss-color-surface);border-radius:var(--ss-radius-full);padding:0 var(--ss-space-2)}
.ss-gallery__list{display:flex;gap:var(--ss-space-2);list-style:none;margin:0;padding:0;overflow-x:auto}
.ss-gallery--grid .ss-gallery__list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.ss-gallery--stacked .ss-gallery__list{flex-direction:column}
.ss-gallery__thumb{width:4.5rem;height:4.5rem;padding:0;border:1px solid var(--ss-color-border);border-radius:var(--ss-radius-sm);background:var(--ss-color-surface);overflow:hidden}
.ss-gallery__thumb[aria-current="true"]{border:2px solid var(--ss-color-primary)}.ss-gallery__thumb img{width:100%;height:100%;object-fit:cover}
.ss-gallery__item{padding:0;border:0;background:none;width:100%}
.ss-gallery__dialog{position:fixed;inset:0;z-index:var(--ss-z-overlay,1000);display:grid;place-items:center;background:var(--ss-color-backdrop,var(--ss-color-text))}
.ss-gallery__dialog .ss-gallery__media{max-width:92vw;max-height:86vh;width:auto;height:auto}`;

const RATIO = { '1:1': 'r1x1', '4:3': 'r4x3', '3:4': 'r3x4', '4:5': 'r4x5', '16:9': 'r16x9', auto: 'rauto' };

/**
 * @param {import('./dom.js').DomLike} dom
 * @param {Image} image
 * @param {boolean} eager
 * @param {boolean} [zoom]
 */
const media = (dom, image, eager, zoom = false) =>
	el(dom, image.type === 'video' ? 'video' : 'img', {
		class: 'ss-gallery__media',
		src: zoom ? image.zoom || image.src : image.src,
		alt: image.type === 'video' ? null : image.alt,
		'aria-label': image.type === 'video' ? image.alt : null,
		width: image.width || null,
		height: image.height || null,
		...(image.type === 'video'
			? { poster: image.poster || null, controls: true, playsinline: true, preload: eager ? 'metadata' : 'none' }
			: {
					srcset: zoom ? null : image.srcset || null,
					sizes: !zoom && image.srcset ? '(max-width: 767px) 100vw, 50vw' : null,
					loading: eager ? 'eager' : 'lazy',
					decoding: 'async',
					fetchpriority: eager && !zoom ? 'high' : null,
				}),
	});

/**
 * @param {{ state: ReturnType<Gallery['state']>, actions: Gallery['actions'], strings: Record<string, string>,
 *   slots?: Record<string, any>, dom: import('./dom.js').DomLike }} props
 * @returns {any}
 */
export const render = ({ state, actions, strings, slots = {}, dom }) => {
	const t = createTranslator(strings);
	once(actions, () => actions.load(pageSource(dom, 'gallery')));
	const { images, index } = state;
	const total = images.length;
	const root = el(dom, 'section', {
		class: `ss-pdp ss-gallery ss-gallery--${state.layout} ss-gallery--${RATIO[state.aspect]}`,
		role: 'region',
		'aria-label': t('gallery.label'),
		'aria-busy': state.status === 'idle' || state.status === 'loading' ? 'true' : null,
		hidden: state.status === 'empty',
	});
	if (state.status !== 'ready' || total === 0) {
		root.append(el(dom, 'div', { class: 'ss-gallery__frame' }));
		return root;
	}
	const at = { index: index + 1, total };
	const eager = (/** @type {number} */ i) =>
		state.lazy === 'all_eager' || (state.lazy === 'first_eager' && i === state.priority);
	/** @param {any} event */
	const keys = (event) => {
		const move = { ArrowRight: actions.next, ArrowLeft: actions.prev, Home: actions.first, End: actions.last }[
			/** @type {'Home'} */ (event.key)
		];
		if (move) {
			event.preventDefault?.();
			void move();
		}
	};
	/** @param {string} kind @param {string} label @param {string} glyph @param {() => unknown} run @param {string} focus */
	const button = (kind, label, glyph, run, focus) => {
		const node = el(
			dom,
			'button',
			{ type: 'button', class: `ss-gallery__btn ss-gallery__btn--${kind}`, 'aria-label': label, 'data-ss-focus': focus },
			[glyph],
		);
		listen(node, 'click', () => void run());
		return node;
	};
	const zoom = (/** @type {number} */ i) => () => actions.select(i).then(() => actions.openZoom());

	if (state.layout === 'carousel') {
		const image = /** @type {Image} */ (images[index]);
		const viewer = el(
			dom,
			'div',
			{
				class: 'ss-gallery__viewer',
				tabindex: '0',
				role: 'group',
				'aria-roledescription': t('gallery.carousel'),
				'aria-label': t('gallery.position', at),
				'data-ss-focus': 'viewer',
			},
			[el(dom, 'div', { class: 'ss-gallery__frame' }, [media(dom, image, eager(index))])],
		);
		listen(viewer, 'keydown', (event) => {
			if ((event.key === 'Enter' || event.key === ' ') && event.target === viewer) {
				event.preventDefault?.();
				void actions.openZoom();
			} else keys(event);
		});
		/** @type {any} */
		let start = null;
		listen(viewer, 'touchstart', (event) => (start = event.touches?.[0] ?? null));
		listen(viewer, 'touchend', (event) => {
			const end = event.changedTouches?.[0];
			const dx = end && start ? end.clientX - start.clientX : 0;
			if (Math.abs(dx) >= 40 && Math.abs(end.clientY - start.clientY) <= 60) void (dx < 0 ? actions.next() : actions.prev());
			start = null;
		});
		if (total > 1)
			viewer.append(
				button('prev', t('gallery.prev'), '‹', actions.prev, 'prev'),
				button('next', t('gallery.next'), '›', actions.next, 'next'),
			);
		if (state.zoom && image.type === 'image') viewer.append(button('zoom', t('gallery.zoom', at), '⤢', zoom(index), 'zoom'));
		viewer.append(el(dom, 'p', { class: 'ss-gallery__count', 'aria-live': 'polite' }, [t('gallery.count', at)]));
		root.append(viewer);
		if (state.thumbnails && total > 1) {
			const thumbs = el(dom, 'ul', { class: 'ss-gallery__list', 'aria-label': t('gallery.thumbnails') });
			images.forEach((entry, i) => {
				const thumb = el(
					dom,
					'button',
					{
						type: 'button',
						class: 'ss-gallery__thumb',
						'aria-label': t('gallery.show', { index: i + 1, total }),
						'aria-current': String(i === index),
						'data-ss-focus': `thumb-${i}`,
					},
					[entry.type === 'video' ? '▶' : el(dom, 'img', { src: entry.src, alt: '', loading: 'lazy', decoding: 'async' })],
				);
				listen(thumb, 'click', () => void actions.select(i));
				listen(thumb, 'keydown', keys);
				thumbs.append(el(dom, 'li', {}, [thumb]));
			});
			root.append(thumbs);
		}
	} else {
		const list = el(dom, 'ul', { class: 'ss-gallery__list' });
		images.forEach((image, i) => {
			const frame = el(dom, 'span', { class: 'ss-gallery__frame' }, [media(dom, image, eager(i))]);
			const item =
				state.zoom && image.type === 'image'
					? el(
							dom,
							'button',
							{
								type: 'button',
								class: 'ss-gallery__item',
								'aria-label': t('gallery.zoom', { index: i + 1, total }),
								'data-ss-focus': `zoom-${i}`,
							},
							[frame],
						)
					: frame;
			if (item !== frame) listen(item, 'click', zoom(i));
			list.append(el(dom, 'li', {}, [item]));
		});
		root.append(list);
	}
	if (slots.after) root.append(slots.after);

	if (state.zoomed) {
		// focus moves to the close button; closing returns it to the control that opened the zoom
		const close = button(
			'close',
			t('gallery.close'),
			'×',
			actions.closeZoom,
			state.layout === 'carousel' ? 'zoom' : `zoom-${index}`,
		);
		close.setAttribute('data-ss-autofocus', '');
		const dialog = el(
			dom,
			'div',
			{ class: 'ss-gallery__dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('gallery.dialog') },
			[
				media(dom, /** @type {Image} */ (images[index]), true, true),
				close,
				el(dom, 'p', { class: 'ss-gallery__count', 'aria-live': 'polite' }, [t('gallery.count', at)]),
			],
		);
		listen(dialog, 'keydown', (event) => {
			if (event.key === 'Escape' || event.key === 'Tab') event.preventDefault?.();
			if (event.key === 'Escape') void actions.closeZoom();
			else if (event.key === 'Tab') close.focus?.();
			else keys(event);
		});
		root.append(dialog);
	}
	return root;
};

/** In-place update for the Loader that keeps (or moves) keyboard focus. */
export const update = refocusing(render);
