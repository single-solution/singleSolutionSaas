/**
 * Tier showcase (pure): the explainer entries of the `showcase` feature merged with the ladder (label, colour, notes)
 * and, when on, each tier's warranty period. Ported from the store's per-grade showcase (notes, warranty, inspection
 * video) without any trade-specific copy.
 * @module
 */
import { cleanText, isKey, isObject } from './text.js';
import { tierView } from './tiers.js';

/** Media links must be https. */
const HTTPS = /^https:\/\/[^\s]+$/;

/**
 * @param {unknown} value
 * @param {number} max
 */
const httpsUrl = (value, max) => (typeof value === 'string' && value.length <= max && HTTPS.test(value) ? value : null);

/**
 * Entries in ladder order.
 * @param {{ tiers: ReadonlyArray<import('./tiers.js').Tier>, config: Record<string, any>, badgeStyle: string,
 *   warranty: ReadonlyMap<string, { days: number, periodText: string }> | null, only?: ReadonlySet<string> | null }} input
 *   `only`: limit to these tier keys (an item's tiers or one selected tier)
 */
export const showcaseEntries = ({ tiers, config, badgeStyle, warranty, only = null }) => {
	/** @type {Map<string, Record<string, any>>} */
	const byTier = new Map();
	for (const entry of Array.isArray(config.entries) ? config.entries : [])
		if (isObject(entry) && isKey(entry.tier) && !byTier.has(entry.tier)) byTier.set(entry.tier, entry);
	return tiers
		.filter((tier) => tier.active && (only === null || only.has(tier.key)))
		.filter((tier) => byTier.has(tier.key) || config.include_tiers_without_entry !== false)
		.map((tier) => {
			const entry = byTier.get(tier.key);
			const images = (Array.isArray(entry?.images) ? entry.images : [])
				.filter(isObject)
				.map((/** @type {Record<string, unknown>} */ image) => ({
					url: httpsUrl(image.url, 1000),
					alt: cleanText(image.alt, 200) ?? '',
				}))
				.filter((/** @type {{ url: string | null }} */ image) => image.url !== null)
				.slice(0, 6);
			const term = config.show_warranty === false ? undefined : warranty?.get(tier.key);
			return {
				tier: tierView(tier, badgeStyle),
				headline: cleanText(entry?.headline, 120) ?? tier.label,
				body: cleanText(entry?.body, 2000) ?? tier.description,
				bullets: (Array.isArray(entry?.bullets) ? entry.bullets : [])
					.map((/** @type {unknown} */ line) => cleanText(line, 200))
					.filter((/** @type {string | null} */ line) => line !== null)
					.slice(0, 8),
				video: httpsUrl(entry?.video_url, 600),
				images,
				warranty: term ? { days: term.days, periodText: term.periodText } : null,
			};
		});
};
