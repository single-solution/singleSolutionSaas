/**
 * Tier definitions (pure). The merchant's ladder comes from the `tiers` feature (`tiers.tiers`): stable key, label,
 * notes, colour (hex or design token), icon, order and an optional rules@1 applicability condition. Nothing about any
 * trade is assumed — the same ladder models condition grades, produce classes, room classes or service levels.
 * @module
 */
import { matches } from './rules.js';
import { cleanText, isKey, isObject } from './text.js';

/** A merchant hex colour. */
export const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
/** A CSS custom property name (design token). */
export const TOKEN_NAME = /^--[a-z][a-z0-9-]{0,62}$/;
/** An icon name. */
const ICON_NAME = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * @typedef {object} TierColor
 * @property {string | null} hex merchant hex value
 * @property {string | null} token design token name
 * @property {string | null} css the CSS value to use: `var(<token>)` when a token is set, else the hex value
 */

/**
 * @typedef {object} Tier
 * @property {string} key
 * @property {string} label
 * @property {string} shortLabel
 * @property {string} description
 * @property {TierColor} color
 * @property {string | null} icon
 * @property {number} order
 * @property {number} rank 0 = best, by order then position
 * @property {string} appliesWhen
 * @property {boolean} active
 */

/**
 * Colour of a tier: the token wins, the hex value is the fallback; anything else is dropped.
 * @param {unknown} hex
 * @param {unknown} token
 * @returns {TierColor}
 */
export const colorOf = (hex, token) => {
	const h = typeof hex === 'string' && HEX_COLOR.test(hex) ? hex.toLowerCase() : null;
	const t = typeof token === 'string' && TOKEN_NAME.test(token) ? token : null;
	return { hex: h, token: t, css: t ? `var(${t})` : h };
};

/**
 * The ladder from the feature value: well-formed entries only, first of a duplicate key wins, sorted by `order`
 * (position breaks ties).
 * @param {unknown} list `tiers.tiers`
 * @returns {ReadonlyArray<Tier>}
 */
export const normaliseTiers = (list) => {
	const seen = new Set();
	/** @type {Array<Omit<Tier, 'rank'> & { position: number }>} */
	const out = [];
	for (const [position, entry] of (Array.isArray(list) ? list : []).entries()) {
		if (!isObject(entry) || !isKey(entry.key) || seen.has(entry.key)) continue;
		const label = cleanText(entry.label, 60);
		if (!label) continue;
		seen.add(entry.key);
		out.push({
			key: entry.key,
			label,
			shortLabel: cleanText(entry.short_label, 16) ?? label,
			description: cleanText(entry.description, 1200) ?? '',
			color: colorOf(entry.color, entry.token),
			icon: typeof entry.icon === 'string' && ICON_NAME.test(entry.icon) ? entry.icon : null,
			order: Number.isInteger(entry.order) ? entry.order : 1000,
			appliesWhen: typeof entry.applies_when === 'string' ? entry.applies_when : '',
			active: entry.active !== false,
			position,
		});
	}
	out.sort((a, b) => a.order - b.order || a.position - b.position);
	return Object.freeze(
		out.map((tier, rank) =>
			Object.freeze({
				key: tier.key,
				label: tier.label,
				shortLabel: tier.shortLabel,
				description: tier.description,
				color: Object.freeze(tier.color),
				icon: tier.icon,
				order: tier.order,
				rank,
				appliesWhen: tier.appliesWhen,
				active: tier.active,
			}),
		),
	);
};

/**
 * @param {ReadonlyArray<Tier>} tiers
 * @returns {ReadonlyMap<string, Tier>}
 */
export const tierIndex = (tiers) => new Map(tiers.map((tier) => [tier.key, tier]));

/**
 * The tier a catalog value names: its key, or its label (case-insensitive).
 * @param {ReadonlyArray<Tier>} tiers
 * @param {unknown} value
 * @returns {Tier | null}
 */
export const tierNamed = (tiers, value) => {
	if (typeof value !== 'string' || value.length === 0 || value.length > 120) return null;
	const wanted = value.trim().toLowerCase();
	return tiers.find((tier) => tier.key === wanted || tier.label.toLowerCase() === wanted) ?? null;
};

/**
 * The rules@1 context of an item (catalog snapshot fields only).
 * @param {Record<string, any> | null | undefined} item
 */
export const itemContext = (item) => ({
	item: {
		itemId: item?.itemId ?? null,
		title: item?.title ?? null,
		brand: item?.brand ?? null,
		status: item?.status ?? null,
		collections: Array.isArray(item?.collections) ? item.collections : [],
		attributes: isObject(item?.attributes) ? item.attributes : {},
	},
});

/**
 * Whether a tier applies to an item. Standalone items (no catalog snapshot) are not checked: the merchant's own
 * system is the source of truth for them.
 * @param {Tier} tier
 * @param {Record<string, any> | null | undefined} item catalog snapshot (`known: true`) or null
 * @param {{ now: number, timeZone: string }} options
 */
export const appliesTo = (tier, item, options) =>
	!item?.known || tier.appliesWhen.trim() === '' || matches(tier.appliesWhen, itemContext(item), options);

/**
 * Public view of a tier.
 * @param {Tier} tier
 * @param {string} badgeStyle
 */
export const tierView = (tier, badgeStyle) => ({
	key: tier.key,
	label: tier.label,
	shortLabel: tier.shortLabel,
	description: tier.description,
	color: tier.color,
	icon: tier.icon,
	order: tier.order,
	rank: tier.rank,
	badge: badgeStyle,
});

/**
 * Tier keys sorted best first, unknown and inactive keys dropped, duplicates removed.
 * @param {ReadonlyMap<string, Tier>} index
 * @param {Iterable<unknown>} keys
 * @param {{ includeInactive?: boolean }} [options]
 * @returns {string[]}
 */
export const rankKeys = (index, keys, { includeInactive = false } = {}) =>
	[...new Set(keys)]
		.map((key) => (typeof key === 'string' ? index.get(key) : undefined))
		.filter((tier) => tier !== undefined && (includeInactive || tier.active))
		.sort((a, b) => /** @type {Tier} */ (a).rank - /** @type {Tier} */ (b).rank)
		.map((tier) => /** @type {Tier} */ (tier).key);
