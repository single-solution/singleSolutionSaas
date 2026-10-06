/**
 * Billing composition (pure): turns `@ss/entitlements` settlement plans into ledger drafts, metered inputs, burn
 * rates and spend-cap decisions. All amounts are integer millicredits.
 * @module
 */
import { burnRate, findPriceBook, planMeteredSettlement, priceBookResolver, spendCapDecision } from '@ss/entitlements';

/** @typedef {ReturnType<typeof import('@ss/entitlements').normaliseProduct>} Product */
/** @typedef {Product['priceBooks'][number]} PriceBook */
/** @typedef {ReturnType<typeof import('@ss/entitlements').planSettlement>['buckets'][number]} Bucket */
/** @typedef {import('./ledger.js').EntryDraft} EntryDraft */

/**
 * @typedef {object} SubscriptionRef
 * @property {string} _id
 * @property {string} websiteId
 * @property {string} appId
 */

/**
 * Ledger draft of one settled hour (amount negated: a charge).
 * @param {SubscriptionRef} sub
 * @param {Bucket} bucket
 * @returns {EntryDraft}
 */
export const settlementDraft = (sub, bucket) => ({
	type: 'settlement',
	amount: bucket.amount === 0 ? 0 : -bucket.amount,
	entryKey: bucket.periodKey,
	periodKey: bucket.periodKey,
	periodStart: new Date(bucket.bucketStart),
	subscriptionId: sub._id,
	websiteId: sub.websiteId,
	appId: sub.appId,
	details: {
		bucketStart: bucket.bucketStart,
		bucketEnd: bucket.bucketEnd,
		sampledAt: bucket.sampledAt,
		priceBookVersion: bucket.priceBookVersion,
		breakdown: bucket.breakdown,
	},
});

/**
 * Metered draft of one hour, or null when no priced unit was used in that hour.
 * @param {object} input
 * @param {SubscriptionRef} input.sub
 * @param {Bucket} input.bucket
 * @param {PriceBook} input.book the book the bucket was priced with
 * @param {string | null} input.planCode plan in effect at the bucket
 * @param {Readonly<Record<string, number>>} input.quantities units used in the bucket
 * @param {Readonly<Record<string, number>>} input.before period-to-date usage before the bucket, per unit
 * @returns {EntryDraft | null}
 */
export const meteredDraft = ({ sub, bucket, book, planCode, quantities, before }) => {
	/** @type {Record<string, { before: number, delta: number }>} */
	const usageByUnit = {};
	/** @type {Record<string, number | null>} */
	const included = {};
	/** @type {Record<string, { millicredits: number, per: number }>} */
	const overageRate = {};
	for (const [unit, delta] of Object.entries(quantities)) {
		const priced = book.metered[unit];
		if (!priced || delta <= 0) continue;
		usageByUnit[unit] = { before: before[unit] ?? 0, delta };
		included[unit] = planCode === null ? 0 : (priced.included[planCode] ?? 0);
		overageRate[unit] = priced.overage;
	}
	if (Object.keys(usageByUnit).length === 0) return null;
	const metered = planMeteredSettlement({
		usageByUnit,
		included,
		overageRate,
		bucket: { subscriptionId: sub._id, bucketStart: bucket.bucketStart },
	});
	return {
		type: 'metered',
		amount: metered.amount === 0 ? 0 : -metered.amount,
		entryKey: metered.periodKey,
		periodKey: metered.periodKey,
		periodStart: new Date(bucket.bucketStart),
		subscriptionId: sub._id,
		websiteId: sub.websiteId,
		appId: sub.appId,
		details: { bucketStart: metered.bucketStart, priceBookVersion: book.version, planCode, lines: metered.lines },
	};
};

/**
 * Hourly burn of a subscription right now: base + enabled elements under the book pinned at `at`.
 * @param {{ product: Product, pins: readonly { version: string, at: Date | string | number }[], startedAt: Date | string | number,
 *   elements: readonly string[], at: number }} input
 * @returns {number}
 */
export const subscriptionBurn = ({ product, pins, startedAt, elements, at }) => {
	const bookAt = priceBookResolver(
		{
			id: 'burn',
			startedAt: new Date(startedAt).toISOString(),
			pins: pins.map((p) => ({ version: p.version, at: new Date(p.at).toISOString() })),
		},
		product.priceBooks,
	);
	const book = bookAt(at);
	if (!book) return 0;
	return burnRate({ priceBook: book, elements: elements.filter((e) => book.elements[e] !== undefined) });
};

/**
 * @param {Product} product
 * @param {string} version
 * @returns {PriceBook}
 */
export const bookOrThrow = (product, version) => {
	const book = findPriceBook(product, version);
	if (!book) throw Object.assign(new Error(`unknown price book ${version}`), { code: 'billing/unknown_price_book' });
	return book;
};

/**
 * @typedef {object} SpendPolicy
 * @property {'website' | 'merchant'} scope
 * @property {string | null} websiteId
 * @property {'day' | 'month'} window
 * @property {number} limit
 * @property {string} timeZone
 */

/**
 * Hours of burn a cap decision looks ahead. Settlement runs after the hour, so when caps are evaluated the hour in
 * progress is already committed (it has active instants and will be billed in full); pausing now only saves the hours
 * after it. Pausing when `spent + 2 × burn > limit` therefore keeps the period's spend within the cap (F.1 "use the
 * upcoming hour's cost to pause first"), and the same condition decides resuming, so holds never flap.
 */
export const SPEND_LOOKAHEAD_HOURS = 2;

/**
 * Spend-cap decisions per website of one merchant. A website pauses when one of its own caps, or a merchant cap,
 * would be exceeded by the committed and next hours (`upcoming` = {@link SPEND_LOOKAHEAD_HOURS} × the website's or the
 * merchant's hourly burn).
 * @param {{ merchantId: string, policies: readonly SpendPolicy[], entries: readonly { at: Date | string | number, amount: number,
 *   websiteId: string | null }[], burnByWebsite: Readonly<Record<string, number>>, now: number }} input
 * @returns {Record<string, { pause: boolean, resumeAt: string | null }>}
 */
export const spendDecisions = ({ merchantId, policies, entries, burnByWebsite, now }) => {
	const spend = entries.map((e) => ({
		at: e.at instanceof Date ? e.at.getTime() : e.at,
		amount: e.amount,
		merchantId,
		...(e.websiteId ? { websiteId: e.websiteId } : {}),
	}));
	const merchantCaps = policies
		.filter((p) => p.scope === 'merchant')
		.map((p) => ({
			scope: /** @type {const} */ ('merchant'),
			scopeId: merchantId,
			window: p.window,
			limit: p.limit,
			timeZone: p.timeZone,
		}));
	const totalBurn = Object.values(burnByWebsite).reduce((s, n) => s + n, 0);
	const merchantDecision = spendCapDecision({
		caps: merchantCaps,
		entries: spend,
		now,
		upcoming: SPEND_LOOKAHEAD_HOURS * totalBurn,
	});
	/** @type {Record<string, { pause: boolean, resumeAt: string | null }>} */
	const out = {};
	for (const [websiteId, burn] of Object.entries(burnByWebsite)) {
		const caps = policies
			.filter((p) => p.scope === 'website' && p.websiteId === websiteId)
			.map((p) => ({
				scope: /** @type {const} */ ('website'),
				scopeId: websiteId,
				window: p.window,
				limit: p.limit,
				timeZone: p.timeZone,
			}));
		const own = spendCapDecision({ caps, entries: spend, now, upcoming: SPEND_LOOKAHEAD_HOURS * burn });
		const pause = own.shouldPause || merchantDecision.shouldPause;
		const ends = [own.resumeAt, merchantDecision.resumeAt]
			.filter((x) => x !== null)
			.map((x) => Date.parse(/** @type {string} */ (x)));
		out[websiteId] = { pause, resumeAt: pause && ends.length > 0 ? new Date(Math.max(...ends)).toISOString() : null };
	}
	return out;
};
