/**
 * Mode B core of the embed elements (`configurator_embed`, `deal_pill`, `grade_showcase`, `reviews_block`,
 * `alerts_block`): each hosts another subscribed product's element inside the detail page. Presence is read through
 * the Loader's public element API only (`SS.elements.list/get`, `SS.on('<key>.shown')`) — never by importing that
 * product — so an embed is `active` while the target element is mounted on this website and `absent` (renders
 * nothing) when the product is not subscribed or the element is off.
 * @module
 */
import { elementStatus } from '../core/page.js';
import { bool, isObject, text } from '../core/util.js';
import { createStore, fail, instance, ok } from './base.js';
import { createTranslator } from './strings.js';

/** Default target element of each embed: the UI element the other product's manifest declares. */
export const EMBED_TARGETS = Object.freeze({
	configurator_embed: 'widget',
	deal_pill: 'badges',
	grade_showcase: 'showcase',
	reviews_block: 'display',
	alerts_block: 'capture',
});

const ELEMENT_KEY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/**
 * The Loader's public element API (`window.SS`), or the merchant's equivalent.
 * @typedef {object} ElementsApi
 * @property {() => ReadonlyArray<{ key: string, status: string }>} list
 * @property {(key: string) => any} get
 * @property {(type: string, handler: (event: unknown) => void) => () => void} [on]
 */

/**
 * @param {keyof typeof EMBED_TARGETS} key
 */
const createEmbed = (key) => {
	/** @param {import('./base.js').ElementOptions} options */
	const factory = ({ config = {}, strings = {}, emit = () => {} }) => {
		const configured = text(config.target, 40);
		const target = ELEMENT_KEY.test(configured) ? configured : EMBED_TARGETS[key];
		const t = createTranslator(strings);
		const store = createStore({
			key,
			target,
			refresh: bool(config.refresh, true),
			/** @type {'idle' | 'absent' | 'waiting' | 'active'} */
			status: /** @type {'idle' | 'absent' | 'waiting' | 'active'} */ ('idle'),
		});
		/** @type {ElementsApi | null} */
		let api = null;
		/** @type {(() => void) | null} */
		let off = null;
		const check = () => {
			if (!api) return;
			let status = elementStatus(api.list(), target);
			if (status === 'active' && api.get(target) === undefined) status = 'waiting';
			if (status !== store.get().status) {
				store.set({ status });
				if (status === 'active') emit('embedded', { target });
			}
			if (status === 'waiting' && !off && typeof api.on === 'function') off = api.on(`${target}.shown`, () => check());
		};
		const actions = {
			/**
			 * Attach to the Loader's element API and follow the target element.
			 * @param {unknown} elements
			 * @returns {Promise<import('./base.js').Result<string>>}
			 */
			connect: async (elements) => {
				if (!isObject(elements) || typeof elements.list !== 'function' || typeof elements.get !== 'function') {
					store.set({ status: 'absent' });
					return fail('elements_unavailable');
				}
				api = /** @type {ElementsApi} */ (/** @type {unknown} */ (elements));
				check();
				return ok(store.get().status);
			},
			/** Re-check the target (e.g. after a single-page navigation). */
			recheck: async () => {
				check();
				return ok(store.get().status);
			},
		};
		/** @param {unknown} input */
		const validate = (input) =>
			isObject(input) && typeof input.target === 'string' && !ELEMENT_KEY.test(input.target)
				? [{ path: '/target', code: 'target_invalid', message: t(`${key}.invalid`, { field: 'target' }) }]
				: [];
		return instance({
			store,
			actions,
			validate,
			strings,
			t,
			onDestroy: () => {
				off?.();
				off = null;
				api = null;
			},
		});
	};
	return factory;
};

export const createConfiguratorEmbed = createEmbed('configurator_embed');
export const createDealPill = createEmbed('deal_pill');
export const createGradeShowcase = createEmbed('grade_showcase');
export const createReviewsBlock = createEmbed('reviews_block');
export const createAlertsBlock = createEmbed('alerts_block');
