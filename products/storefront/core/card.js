/**
 * Item cards: which fields show, the badges, and the rotating attribute chips (ported from the proven storefront
 * card: one "slide" of chips per variant, cycling on a shared, staggered ticker only while the card is on screen).
 * Pure: the timer and visibility live in the renderer.
 */
import { bool, hash, int, isObject, oneOf, strings } from './util.js';

/** Image aspect ratios a card may reserve (no layout shift while images load). */
export const RATIOS = Object.freeze(/** @type {const} */ (['1/1', '4/3', '3/4', '16/9']));
/** Phase buckets: cards advance on one of N sub-ticks so a grid never flips in lock-step. */
export const PHASES = 4;

/**
 * @typedef {object} CardConfig
 * @property {boolean} brand
 * @property {boolean} price
 * @property {boolean} compareAt
 * @property {string[]} chips attribute keys shown as chips
 * @property {number} maxChips
 * @property {boolean} cycle
 * @property {number} cycleMs
 * @property {boolean} badges
 * @property {boolean} stock show an "out of stock" badge
 * @property {typeof RATIOS[number]} ratio
 */

/**
 * @param {unknown} value the element's `card` feature
 * @returns {CardConfig}
 */
export const cardConfig = (value) => {
	const c = isObject(value) ? value : {};
	return {
		brand: bool(c.show_brand, true),
		price: bool(c.show_price, true),
		compareAt: bool(c.show_compare_at, true),
		chips: strings(c.chip_attributes, 10, 64),
		maxChips: int(c.max_chips, 4, 1, 12),
		cycle: bool(c.cycle_chips, true),
		cycleMs: int(c.cycle_ms, 2000, 1000, 10_000),
		badges: bool(c.show_badges, true),
		stock: bool(c.show_stock, true),
		ratio: oneOf(c.image_ratio, RATIOS, '1/1'),
	};
};

/**
 * Chip slides of an item: one per distinct variant chip set (variants first, the item's own attributes otherwise).
 * @param {import('./items.js').Item} item
 * @param {CardConfig} config
 * @returns {string[][]} each slide's chip labels
 */
export const chipSlides = (item, config) => {
	if (config.chips.length === 0) return [];
	/** @param {Record<string, string[]>} attrs */
	const chipsOf = (attrs) => config.chips.flatMap((key) => attrs[key] ?? []).slice(0, config.maxChips);
	const sources = item.variants.length > 0 ? item.variants.map((variant) => variant.attrs) : [item.attrs];
	const seen = new Set();
	/** @type {string[][]} */
	const slides = [];
	for (const attrs of sources) {
		const chips = chipsOf({ ...item.attrs, ...attrs });
		const id = chips.join('\u0000');
		if (chips.length > 0 && !seen.has(id)) {
			seen.add(id);
			slides.push(chips);
		}
	}
	return slides.slice(0, 12);
};

/**
 * The view model of one card.
 * @param {import('./items.js').Item} item
 * @param {CardConfig} config
 */
export const cardView = (item, config) => ({
	id: item.id,
	title: item.title,
	href: item.href,
	image: item.image,
	imageAlt: item.imageAlt,
	brand: config.brand ? item.brand : '',
	price: config.price ? item.price : null,
	compareAt:
		config.price && config.compareAt && item.compareAt !== null && item.price !== null && item.compareAt > item.price
			? item.compareAt
			: null,
	currency: item.currency,
	badges: config.badges ? item.badges : [],
	soldOut: config.stock && item.inStock === false,
	slides: chipSlides(item, config),
	phase: hash(item.id, PHASES),
});

/** @typedef {ReturnType<typeof cardView>} CardView */
