/**
 * Product structured data (pure): schema.org `Product` JSON-LD with `AggregateRating` and `Review` nodes built **only
 * from approved reviews** (ported from ibrahimMobiles `aggregateRatingNode` / `reviewNode`). Without enough approved
 * reviews the rating and the reviews are left out — never invented. The scale is the merchant's (`bestRating`).
 * @module
 */

/**
 * Drop null, undefined, empty strings and empty arrays.
 * @param {Record<string, unknown>} node
 * @returns {Record<string, unknown>}
 */
export const compact = (node) =>
	Object.fromEntries(
		Object.entries(node).filter(
			([, value]) => value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0),
		),
	);

/**
 * `AggregateRating` of a summary (undefined below `minReviews` or without a valid average).
 * @param {{ count: number, average: number, scale: number }} summary
 * @param {number} minReviews
 * @returns {Record<string, unknown> | undefined}
 */
export const aggregateRatingNode = (summary, minReviews) => {
	if (!(summary.count >= Math.max(1, minReviews)) || !(summary.average >= 1 && summary.average <= summary.scale))
		return undefined;
	return {
		'@type': 'AggregateRating',
		ratingValue: summary.average,
		reviewCount: Math.floor(summary.count),
		ratingCount: Math.floor(summary.count),
		bestRating: summary.scale,
		worstRating: 1,
	};
};

/**
 * @typedef {object} ReviewInput
 * @property {number} rating
 * @property {number} scale the scale the review was given on
 * @property {string | null} title
 * @property {string | null} body
 * @property {string} authorName public attribution (never a full name unless the merchant chose it)
 * @property {string} submittedAt ISO
 */

/**
 * A `Review` node (null for invalid ratings).
 * @param {ReviewInput} review
 * @returns {Record<string, unknown> | null}
 */
export const reviewNode = (review) => {
	if (!(Number.isInteger(review.rating) && review.rating >= 1 && review.rating <= review.scale)) return null;
	return compact({
		'@type': 'Review',
		reviewRating: { '@type': 'Rating', ratingValue: review.rating, bestRating: review.scale, worstRating: 1 },
		author: { '@type': 'Person', name: review.authorName },
		datePublished: review.submittedAt.slice(0, 10),
		name: review.title ?? undefined,
		reviewBody: review.body?.trim() || undefined,
	});
};

/**
 * Pick the reviews shown in structured data.
 * @template {{ body: string | null, submittedAt: string }} R
 * @param {readonly R[]} reviews approved reviews, newest first
 * @param {{ limit: number, selection: 'newest' | 'most_detailed' }} options
 * @returns {R[]}
 */
export const selectReviews = (reviews, { limit, selection }) => {
	const sorted =
		selection === 'most_detailed'
			? [...reviews].sort(
					(a, b) => (b.body?.length ?? 0) - (a.body?.length ?? 0) || b.submittedAt.localeCompare(a.submittedAt),
				)
			: [...reviews];
	return sorted.slice(0, Math.max(0, limit));
};

/**
 * The `Product` JSON-LD of an item.
 * @param {{ item: { itemId: string, name: string, url?: string | null, sku?: string | null, image?: string | null },
 *   brand?: string | null, summary: { count: number, average: number, scale: number }, reviews: readonly ReviewInput[],
 *   minReviews: number }} input
 * @returns {Record<string, unknown>}
 */
export const productJsonLd = ({ item, brand = null, summary, reviews, minReviews }) => {
	const aggregateRating = aggregateRatingNode(summary, minReviews);
	return compact({
		'@context': 'https://schema.org',
		'@type': 'Product',
		'@id': item.url ? `${item.url}#product` : undefined,
		name: item.name,
		sku: item.sku ?? item.itemId,
		url: item.url ?? undefined,
		image: item.image ?? undefined,
		brand: brand ? { '@type': 'Brand', name: brand } : undefined,
		aggregateRating,
		review: aggregateRating
			? reviews.map(reviewNode).filter((/** @type {Record<string, unknown> | null} */ node) => node !== null)
			: undefined,
	});
};
