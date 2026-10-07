/**
 * Mode B core of the `hosted_page` element: a composed detail page on a merchant sub-path (`/p/{slug}`) for sites
 * that have no page for the item. The route parameters fill the JSON source URL; the page renders the item and
 * empty, named slots that the other PDP elements (and other products' elements) target with their placement, and
 * sets the document metadata (title, description, canonical, robots).
 * @module
 */
import { fillText } from '../core/display.js';
import { matchRoute } from '../core/page.js';
import { bool, fillUrl, isHttpsUrl, oneOf, text } from '../core/util.js';
import { createItemElement, fail, instance } from './base.js';
import { createTranslator } from './strings.js';

const SLOT = /^[a-z][a-z0-9-]{0,39}$/;

/** Default slots: the default placement targets of the other PDP elements, in page order. */
export const DEFAULT_SLOTS = Object.freeze([
	'gallery',
	'price',
	'deals',
	'configurator',
	'alerts',
	'grade',
	'share',
	'reviews',
	'faq',
	'related',
]);

/** @param {Record<string, unknown>} config */
export const hostedSettings = (config) => ({
	route: text(config.route_pattern, 200) || '/p/{slug}',
	setTitle: bool(config.set_title, true),
	setDescription: bool(config.set_description, true),
	canonical: text(config.canonical_url, 1000),
	robots: oneOf(config.robots, /** @type {const} */ (['index', 'noindex']), 'index'),
	slots: (Array.isArray(config.slots) ? config.slots : DEFAULT_SLOTS)
		.map((slot) => text(slot, 40))
		.filter((slot) => SLOT.test(slot))
		.slice(0, 20),
	showImage: bool(config.show_image, true),
	showAttributes: bool(config.show_attributes, true),
});

/**
 * @param {import('./base.js').ElementOptions} options
 */
export const createHostedPage = (options) => {
	const settings = hostedSettings(options.config ?? {});
	/** @type {Record<string, string>} */
	let params = {};
	let pageUrl = '';
	const t = createTranslator(options.strings ?? {});
	/**
	 * @param {import('../core/item.js').Item | null} item
	 * @returns {{ meta: Readonly<{ title: string, description: string, canonical: string, robots: string }> | null }}
	 */
	const build = (item) => {
		if (!item) return { meta: null };
		const template = t('hosted_page.title');
		const canonical = settings.canonical === '' ? (pageUrl.split(/[?#]/)[0] ?? '') : fillUrl(settings.canonical, params);
		return {
			meta: Object.freeze({
				title: settings.setTitle ? text(fillText(template, { title: item.title, brand: item.brand }), 300) : '',
				description: settings.setDescription ? text(item.description, 300) : '',
				canonical: isHttpsUrl(canonical) ? canonical : '',
				robots: settings.robots,
			}),
		};
	};
	const core = createItemElement({
		...options,
		prefix: 'hosted_page',
		extra: {
			...settings,
			matched: false,
			/** @type {Readonly<{ title: string, description: string, canonical: string, robots: string }> | null} */
			meta: null,
		},
		derive: build,
	});
	const actions = {
		...core.actions,
		/**
		 * Match the route, then read the item with the route parameters.
		 * @param {import('./base.js').ItemSource} [source]
		 */
		load: async (source = {}) => {
			const matched = matchRoute(settings.route, text(source.context?.path, 2048));
			core.store.set({ matched: matched !== null });
			if (matched === null) {
				core.store.set({ status: 'empty', item: null, meta: null });
				return fail('route_mismatch');
			}
			params = matched;
			pageUrl = text(source.context?.url, 2048);
			return core.actions.load({
				...source,
				context: { ...source.context, params: { ...source.context?.params, ...matched } },
			});
		},
	};
	return instance({ ...core, actions, strings: options.strings ?? {} });
};
