/**
 * The deals page: deal cards from the Deals product's public `GET /v1/deals-page` (pk_ key) or the same shape from a
 * JSON file. Each deal has a name, an optional badge and description, when it ends, and a preview of its items
 * (priced with today's deals: `price`, struck-through `unitAmount`).
 */
import { toItem } from './items.js';
import { isObject, objects, str } from './util.js';

/** Item field map of deal previews (`itemId`, `url`, `unitAmount` → compare-at). */
const PREVIEW_FIELDS = Object.freeze({
	id: 'itemId|id',
	title: 'title|name',
	href: 'url|href',
	image: 'image',
	image_alt: 'imageAlt',
	price: 'price',
	compare_at: 'unitAmount|compareAtPrice',
	currency: 'currency',
	brand: 'brand',
	badges: 'badges',
	attributes: 'attributes',
	variants: 'variants',
	collections: 'collections',
	in_stock: 'inStock',
	rank: 'rank',
	created_at: 'createdAt',
});

/**
 * @param {unknown} json `{ items: [DealCard], nextCursor, hasMore }`
 * @param {{ currency?: string | null, max?: number }} [options]
 */
export const dealsOf = (json, { currency = null, max = 50 } = {}) => {
	const records = isObject(json) && Array.isArray(json.items) ? json.items : Array.isArray(json) ? json : [];
	return objects(records, max)
		.map((deal) => {
			const schedule = isObject(deal.schedule) ? deal.schedule : {};
			const until = str(schedule.activeUntil ?? deal.endsAt, '', 40);
			const own = str(deal.currency, '', 3) || currency;
			return {
				id: str(deal.id, '', 64),
				name: str(deal.name, '', 200),
				description: str(deal.description, '', 500),
				badge: isObject(deal.badge) ? str(deal.badge.label, '', 40) : '',
				endsAt: Number.isNaN(Date.parse(until)) ? null : until,
				items: objects(deal.items, 24)
					.map((raw, index) => toItem({ currency: own, ...raw }, PREVIEW_FIELDS, index))
					.filter((item) => item !== null),
			};
		})
		.filter((deal) => deal.id !== '' && deal.name !== '');
};

/** @typedef {ReturnType<typeof dealsOf>[number]} Deal */

/**
 * Time left until `endsAt` (whole minutes), or null when unknown or over.
 * @param {string | null} endsAt
 * @param {number} nowMs
 * @returns {{ days: number, hours: number, minutes: number } | null}
 */
export const timeLeft = (endsAt, nowMs) => {
	const left = endsAt === null ? 0 : Math.floor((Date.parse(endsAt) - nowMs) / 60_000);
	if (!(left > 0)) return null;
	return { days: Math.floor(left / 1440), hours: Math.floor((left % 1440) / 60), minutes: left % 60 };
};
