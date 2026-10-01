/**
 * Hourly settlement simulator (`ss dev settle --hours N`): plans the ledger entries the Portal would write for the
 * fixture subscriptions over the last N complete UTC hours, using `@ss/entitlements` (started-hour rule, price book,
 * metered overage on cumulative period usage). Pure: time, usage and the resolver are inputs.
 * @module
 */
import { HOUR_MS, floorHour, planMeteredSettlement, planSettlement } from '@ss/entitlements';

/** @typedef {import('./fixture.js').Fixture} Fixture */
/** @typedef {import('./fixture.js').FixtureSubscription} FixtureSubscription */
/** @typedef {{ websiteId: string, subscriptionId?: string, unit: string, quantity: number, occurredAt: string }} UsageRecord */

/**
 * @typedef {object} LedgerEntry
 * @property {'hourly' | 'metered'} kind
 * @property {string} periodKey
 * @property {string} subscriptionId
 * @property {string} websiteId
 * @property {string} merchantId
 * @property {string} bucketStart
 * @property {number} amount millicredits
 * @property {string} detail human-readable breakdown
 */

/**
 * @typedef {object} SettlementRun
 * @property {string} from
 * @property {string} to
 * @property {LedgerEntry[]} entries
 * @property {Array<{ periodKey: string, reason: string }>} skipped
 * @property {Record<string, { before: number, charged: number, after: number }>} balances millicredits by merchant
 * @property {number} total millicredits
 */

/**
 * Start of the UTC calendar month of an instant (metered quota period).
 * @param {number} ms
 * @returns {number}
 */
const monthStart = (ms) => {
	const date = new Date(ms);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
};

/**
 * @param {{
 *   product: ReturnType<typeof import('@ss/entitlements').normaliseProduct>,
 *   fixture: Fixture,
 *   usage?: readonly UsageRecord[],
 *   enabledElements: (subscription: FixtureSubscription) => string[],
 *   now: number,
 *   hours: number,
 * }} input
 * @returns {SettlementRun}
 */
export const simulateSettlement = ({ product, fixture, usage = [], enabledElements, now, hours }) => {
	if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 31)
		throw new RangeError('hours must be an integer between 1 and 744');
	const to = floorHour(now);
	const from = to - hours * HOUR_MS;
	/** @type {LedgerEntry[]} */
	const entries = [];
	/** @type {Array<{ periodKey: string, reason: string }>} */
	const skipped = [];
	for (const subscription of fixture.subscriptions) {
		if (subscription.product !== null && subscription.product !== product.slug) continue;
		const website = fixture.websites.find((candidate) => candidate.id === subscription.websiteId);
		if (!website) continue;
		const startedAt = subscription.startedAt ?? new Date(from).toISOString();
		const timeline = enabledElements(subscription).map((element) => ({ at: from, element, enabled: true }));
		const pauses =
			subscription.status === 'paused' || subscription.status === 'suspended' || subscription.status === 'cancelled'
				? [{ from, reason: subscription.status === 'cancelled' ? 'suspended' : subscription.status }]
				: [];
		const plan = planSettlement({
			subscription: {
				id: subscription.id,
				startedAt,
				...(subscription.priceBookVersion ? { priceBookVersion: subscription.priceBookVersion } : {}),
			},
			priceBook: product,
			elementTimeline: timeline,
			pauses,
			from,
			to,
		});
		for (const skip of plan.skipped) skipped.push({ periodKey: skip.periodKey, reason: skip.reason });
		const records = usage.filter(
			(record) =>
				record.websiteId === subscription.websiteId &&
				(record.subscriptionId === undefined || record.subscriptionId === subscription.id),
		);
		for (const bucket of plan.buckets) {
			entries.push({
				kind: 'hourly',
				periodKey: bucket.periodKey,
				subscriptionId: subscription.id,
				websiteId: website.id,
				merchantId: website.merchantId,
				bucketStart: bucket.bucketStart,
				amount: bucket.amount,
				detail: bucket.breakdown.map((line) => `${line.kind === 'base' ? 'base' : line.element} ${line.amount}`).join(' + '),
			});
			const start = Date.parse(bucket.bucketStart);
			const book = product.priceBooks.find((candidate) => candidate.version === bucket.priceBookVersion);
			if (!book) continue;
			/** @type {Record<string, { before: number, delta: number }>} */
			const usageByUnit = {};
			/** @type {Record<string, number>} */
			const included = {};
			/** @type {Record<string, { millicredits: number, per: number }>} */
			const overageRate = {};
			for (const [unit, meter] of Object.entries(book.metered)) {
				const quantityIn = (/** @type {number} */ lo, /** @type {number} */ hi) =>
					records
						.filter(
							(record) =>
								record.unit === unit && Date.parse(record.occurredAt) >= lo && Date.parse(record.occurredAt) < hi,
						)
						.reduce((sum, record) => sum + record.quantity, 0);
				const delta = quantityIn(start, start + HOUR_MS);
				if (delta === 0) continue;
				usageByUnit[unit] = { before: quantityIn(monthStart(start), start), delta };
				included[unit] = (subscription.plan ? meter.included[subscription.plan] : undefined) ?? 0;
				overageRate[unit] = meter.overage;
			}
			if (Object.keys(usageByUnit).length === 0) continue;
			const metered = planMeteredSettlement({
				usageByUnit,
				included,
				overageRate,
				bucket: { subscriptionId: subscription.id, bucketStart: bucket.bucketStart },
			});
			entries.push({
				kind: 'metered',
				periodKey: metered.periodKey,
				subscriptionId: subscription.id,
				websiteId: website.id,
				merchantId: website.merchantId,
				bucketStart: metered.bucketStart,
				amount: metered.amount,
				detail: metered.lines
					.map((line) => `${line.unit} ${line.quantity} (billable ${line.billableQuantity}) ${line.amount}`)
					.join(', '),
			});
		}
	}
	entries.sort((a, b) => a.bucketStart.localeCompare(b.bucketStart) || a.periodKey.localeCompare(b.periodKey));
	/** @type {SettlementRun['balances']} */
	const balances = {};
	for (const merchant of fixture.merchants) {
		const charged = entries.filter((entry) => entry.merchantId === merchant.id).reduce((sum, entry) => sum + entry.amount, 0);
		const before = Math.round(merchant.balance * 1000);
		balances[merchant.id] = { before, charged, after: before - charged };
	}
	return {
		from: new Date(from).toISOString(),
		to: new Date(to).toISOString(),
		entries,
		skipped,
		balances,
		total: entries.reduce((sum, entry) => sum + entry.amount, 0),
	};
};

/**
 * @param {number} millicredits
 * @returns {string}
 */
const credits = (millicredits) => `${(millicredits / 1000).toFixed(3)} cr`;

/**
 * Printable ledger.
 * @param {SettlementRun} run
 * @returns {string}
 */
export const formatSettlement = (run) => {
	const lines = [`Settlement ${run.from} → ${run.to}`];
	for (const entry of run.entries) {
		lines.push(
			`  ${entry.periodKey.padEnd(58)} ${String(entry.amount).padStart(8)} mc  ${entry.kind.padEnd(7)} ${entry.detail}`,
		);
	}
	for (const skip of run.skipped) lines.push(`  ${skip.periodKey.padEnd(58)} ${'—'.padStart(8)}     skipped ${skip.reason}`);
	if (run.entries.length === 0 && run.skipped.length === 0) lines.push('  (no billable hours)');
	lines.push(`Total ${run.total} mc (${credits(run.total)})`);
	for (const [merchantId, balance] of Object.entries(run.balances)) {
		lines.push(`  ${merchantId}: ${credits(balance.before)} − ${credits(balance.charged)} = ${credits(balance.after)}`);
	}
	return `${lines.join('\n')}\n`;
};
