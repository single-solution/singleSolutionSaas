/**
 * Mode B core of the `faq` element: per-item questions from the page data / JSON source, the merchant's manual
 * entries, or both, capped; plus the matching `FAQPage` JSON-LD for exactly the questions that are shown.
 * @module
 */
import { normaliseItem } from '../core/item.js';
import { faqJsonLd, scriptJson } from '../core/jsonld.js';
import { bool, int, oneOf, text } from '../core/util.js';
import { createItemElement, instance, ok } from './base.js';

export const FAQ_SOURCES = Object.freeze(/** @type {const} */ (['item', 'manual', 'both']));

/** @param {Record<string, unknown>} config */
export const faqSettings = (config) => ({
	source: oneOf(config.source, FAQ_SOURCES, 'both'),
	manual: normaliseItem({ faq: config.entries }).faq,
	count: int(config.count, 1, 50, 10),
	structuredData: bool(config.structured_data, true),
	openFirst: bool(config.open_first, false),
});

/**
 * @param {import('./base.js').ElementOptions} options
 */
export const createFaq = (options) => {
	const settings = faqSettings(options.config ?? {});
	let pageUrl = '';
	/** @param {import('../core/item.js').Item | null} item */
	const build = (item) => {
		const fromItem = settings.source === 'manual' ? [] : (item?.faq ?? []);
		const manual = settings.source === 'item' ? [] : settings.manual;
		const seen = new Set();
		const entries = Object.freeze(
			[...fromItem, ...manual]
				.filter((entry) => !seen.has(entry.question.toLowerCase()) && seen.add(entry.question.toLowerCase()))
				.slice(0, settings.count),
		);
		const node = settings.structuredData ? faqJsonLd(entries, pageUrl) : null;
		return { entries, json: node ? scriptJson(node) : '' };
	};
	const core = createItemElement({
		...options,
		prefix: 'faq',
		extra: {
			...settings,
			entries: /** @type {readonly import('../core/item.js').FaqEntry[]} */ (Object.freeze([])),
			json: '',
		},
		usable: () => true,
		derive: build,
	});
	const actions = {
		...core.actions,
		/** @param {import('./base.js').ItemSource} [source] */
		load: (source = {}) => {
			pageUrl = text(source.context?.url, 2048);
			return core.actions.load(source);
		},
		/**
		 * The visitor opened a question.
		 * @param {number} index
		 */
		opened: async (index) => {
			if (core.store.get().entries[index]) core.emit('opened', { index });
			return ok(index);
		},
	};
	return instance({ ...core, actions, strings: options.strings ?? {} });
};
