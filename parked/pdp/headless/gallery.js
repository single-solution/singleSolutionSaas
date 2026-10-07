/**
 * Mode B core of the `gallery` element: the item's images and videos with alt text from the merchant's template,
 * the active image, keyboard-style navigation (next/previous/first/last wrap around) and the zoom view.
 * @module
 */
import { altText } from '../core/display.js';
import { bool, int, oneOf } from '../core/util.js';
import { createItemElement, fail, instance, ok } from './base.js';

export const LAYOUTS = Object.freeze(/** @type {const} */ (['carousel', 'grid', 'stacked']));
export const ASPECTS = Object.freeze(/** @type {const} */ (['1:1', '4:3', '3:4', '4:5', '16:9', 'auto']));
export const LAZY = Object.freeze(/** @type {const} */ (['first_eager', 'all_lazy', 'all_eager']));

/**
 * @param {Record<string, unknown>} config
 */
export const gallerySettings = (config) => ({
	layout: oneOf(config.layout, LAYOUTS, 'carousel'),
	thumbnails: bool(config.thumbnails, true),
	maxImages: int(config.max_images, 1, 50, 12),
	zoom: bool(config.zoom, true),
	video: bool(config.video, true),
	aspect: oneOf(config.aspect_ratio, ASPECTS, '1:1'),
	lazy: oneOf(config.lazy, LAZY, 'first_eager'),
	priority: int(config.priority_index, 0, 49, 0),
});

/**
 * @param {import('./base.js').ElementOptions} options
 */
export const createGallery = (options) => {
	const settings = gallerySettings(options.config ?? {});
	/** @type {(item: import('../core/item.js').Item | null) => import('../core/item.js').Image[]} */
	const imagesOf = (item) => {
		const list = (item?.images ?? []).filter((image) => settings.video || image.type === 'image').slice(0, settings.maxImages);
		return list.map((image, index) =>
			Object.freeze({
				...image,
				alt: altText({
					stored: image.alt,
					title: item?.title ?? '',
					brand: item?.brand ?? '',
					index,
					total: list.length,
					template: core.t('gallery.alt'),
					single: core.t('gallery.alt_single'),
				}),
			}),
		);
	};
	const core = createItemElement({
		...options,
		prefix: 'gallery',
		extra: {
			images: /** @type {readonly import('../core/item.js').Image[]} */ (Object.freeze([])),
			index: 0,
			zoomed: false,
			...settings,
		},
		usable: (item) => imagesOf(item).length > 0,
		derive: (item) => {
			const images = Object.freeze(imagesOf(item));
			return { images, index: Math.min(settings.priority, Math.max(images.length - 1, 0)), zoomed: false };
		},
	});
	const { store } = core;

	/**
	 * @param {number} index
	 * @returns {Promise<import('./base.js').Result<number>>}
	 */
	const select = async (index) => {
		const count = store.get().images.length;
		if (count === 0) return fail('no_images');
		const next = ((Math.trunc(index) % count) + count) % count;
		if (next !== store.get().index) {
			store.set({ index: next });
			core.emit('image_changed', { index: next });
		}
		return ok(next);
	};

	const actions = {
		...core.actions,
		select,
		next: () => select(store.get().index + 1),
		prev: () => select(store.get().index - 1),
		first: () => select(0),
		last: () => select(store.get().images.length - 1),
		/** @returns {Promise<import('./base.js').Result<boolean>>} */
		openZoom: async () => {
			if (!settings.zoom || store.get().images.length === 0) return fail('zoom_unavailable');
			store.set({ zoomed: true });
			core.emit('zoom_opened', { index: store.get().index });
			return ok(true);
		},
		/** @returns {Promise<import('./base.js').Result<boolean>>} */
		closeZoom: async () => {
			store.set({ zoomed: false });
			return ok(false);
		},
	};
	return instance({ ...core, actions, strings: options.strings ?? {} });
};
