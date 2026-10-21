'use client';
/**
 * Credits and billing pieces shared by the merchant and admin consoles (PLAN 0.5, 0.6): status badges with their
 * colors, days left, the billing banners, the usage chart and table, and the columns of the usage and receipt tables. Days, months and charts
 * are UTC and labeled so; single timestamps show in the viewer's local time.
 * @module
 */
import { Badge, BarChart, Callout, Card, EmptyState, FiguresTable, LocalTime, Stat, StatGrid, formatCredits } from '@ss/ui';
import { BILLING } from '../../texts/console.js';

/** @typedef {Array<{ key: string, header: string, kind?: 'number' | 'money' | 'date' | 'status', sortable?: boolean, low?: boolean, render?: (row: any) => import('react').ReactNode }>} Columns */
/** @typedef {'active' | 'low_balance' | 'grace' | 'stopped' | 'suspended'} MerchantStatus */
/** @typedef {'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info'} Tone */

/** @type {Record<string, Tone>} */
const MERCHANT_TONES = { active: 'success', low_balance: 'warning', grace: 'warning', stopped: 'danger', suspended: 'danger' };

/** How a merchant's status looks as a pill in the header of a page. */
const MERCHANT_PILLS = /** @type {Record<string, 'active' | 'warning' | 'error'>} */ ({
	active: 'active',
	low_balance: 'warning',
	grace: 'warning',
	stopped: 'error',
	suspended: 'error',
});

/**
 * The pill of a merchant status (Active green, Low balance and In grace amber, Stopped and Suspended red).
 * @param {string} status
 * @returns {{ status: 'active' | 'warning' | 'error', label: string }}
 */
export const merchantPill = (status) => ({
	status: MERCHANT_PILLS[status] ?? 'active',
	label: BILLING.merchantStatus[/** @type {MerchantStatus} */ (status)] ?? status,
});

/**
 * Merchant status (Active green, Low balance and In grace amber, Stopped and Suspended red).
 * @param {{ status: string }} props
 */
export function MerchantStatusBadge({ status }) {
	return (
		<Badge tone={MERCHANT_TONES[status] ?? 'neutral'} dot>
			{BILLING.merchantStatus[/** @type {MerchantStatus} */ (status)] ?? status}
		</Badge>
	);
}

/**
 * Color of a product-on-website status (PLAN 0.6): Active green, In grace amber, Stopped and Suspended red, and gray
 * `No features on` for an active product with no features on.
 * @param {{ status: string, featuresOn?: readonly string[] }} card
 * @returns {Tone}
 */
export const productTone = ({ status, featuresOn = [] }) =>
	status === 'active' && featuresOn.length === 0 ? 'neutral' : (MERCHANT_TONES[status] ?? 'neutral');

/**
 * Label of a product-on-website status.
 * @param {{ status: string, featuresOn?: readonly string[] }} card
 * @returns {string}
 */
export const productStatusLabel = ({ status, featuresOn = [] }) =>
	status === 'active' && featuresOn.length === 0
		? BILLING.productStatus.noFeatures
		: (BILLING.productStatus[/** @type {'active' | 'grace' | 'stopped' | 'suspended'} */ (status)] ?? status);

/**
 * The pill of a product-on-website status (Active green, In grace amber, Stopped and Suspended red, gray when no
 * feature is on).
 * @param {{ status: string, featuresOn?: readonly string[] }} card
 * @returns {{ status: 'active' | 'warning' | 'error' | 'off', label: string }}
 */
export const productPill = (card) => ({
	status: {
		success: /** @type {const} */ ('active'),
		warning: /** @type {const} */ ('warning'),
		danger: /** @type {const} */ ('error'),
		neutral: /** @type {const} */ ('off'),
		primary: /** @type {const} */ ('active'),
		info: /** @type {const} */ ('active'),
	}[productTone(card)],
	label: productStatusLabel(card),
});

/**
 * Product-on-website status badge.
 * @param {{ status: string, featuresOn?: readonly string[] }} props
 */
export function ProductStatusBadge({ status, featuresOn = [] }) {
	return (
		<Badge tone={productTone({ status, featuresOn })} dot>
			{productStatusLabel({ status, featuresOn })}
		</Badge>
	);
}

/**
 * Days left (0.5.4): `Grace ends …` in grace, `Stopped since …` when stopped, `—` without spend.
 * @param {{ summary: any }} props
 */
export function DaysLeft({ summary }) {
	if (summary?.graceEnd)
		return (
			<>
				{BILLING.graceEnds} <LocalTime value={summary.graceEnd} />
			</>
		);
	if (summary?.stoppedAt)
		return (
			<>
				{BILLING.stoppedSince} <LocalTime value={summary.stoppedAt} />
			</>
		);
	if (typeof summary?.daysLeft !== 'number') return <>—</>;
	return <>{summary.daysLeft < 1 ? BILLING.lessThanOneDay : BILLING.days(summary.daysLeft)}</>;
}

/**
 * The money numbers of a merchant: balance, days left, daily spend and spent this month.
 * @param {{ summary: any }} props
 */
export function BillingStats({ summary }) {
	return (
		<StatGrid>
			<Stat
				label={BILLING.balance}
				value={formatCredits(summary.balance)}
				tone={summary.balance <= 0 ? 'danger' : summary.lowBalance ? 'warning' : 'neutral'}
				hint={<MerchantStatusBadge status={summary.status} />}
				icon="wallet"
				kind="credit"
			/>
			<Stat label={BILLING.daysLeft} value={<DaysLeft summary={summary} />} icon="clock" kind="credit" />
			<Stat label={BILLING.dailySpend} value={formatCredits(summary.dailySpend)} icon="trendingUp" kind="credit" />
			<Stat label={BILLING.spentThisMonth} value={formatCredits(summary.spentThisMonth)} icon="calendar" kind="credit" />
		</StatGrid>
	);
}

/**
 * Credits per UTC day as chart bars (credits in thousandths, shown as credits).
 * @param {ReadonlyArray<{ day: string, amount: number }> | undefined} days
 */
export const creditDayBars = (days) => (days ?? []).map((d) => ({ label: d.day.slice(5), value: d.amount / 1000, hint: d.day }));

/** @param {number} v credits */
export const formatChartCredits = (v) => formatCredits(Math.round(v * 1000));

/**
 * The billing banner of the merchant console (low balance, grace, stopped), with the support contact; it cannot be
 * dismissed and stays until the state ends.
 * @param {{ summary: any, contact: string }} props
 */
export function BillingBanner({ summary, contact }) {
	if (!summary) return null;
	if (summary.status === 'stopped')
		return (
			<Callout tone="danger" title={BILLING.banner.stopped}>
				{BILLING.banner.stoppedBody} {contact}
			</Callout>
		);
	if (summary.status === 'grace')
		return (
			<Callout tone="warning" title={BILLING.banner.grace}>
				{BILLING.graceEnds} <LocalTime value={summary.graceEnd} />. {BILLING.banner.graceBody} {contact}
			</Callout>
		);
	if (summary.status === 'low_balance')
		return (
			<Callout tone="warning" title={BILLING.banner.low}>
				{BILLING.banner.lowBody(
					typeof summary.daysLeft === 'number' && summary.daysLeft >= 1
						? BILLING.days(summary.daysLeft)
						: BILLING.lessThanOneDay,
				)}{' '}
				{contact}
			</Callout>
		);
	return null;
}

/**
 * Usage (0.5.11): spend per UTC day and one row per product × website × day × feature.
 * @param {{ usage: any, showWebsite?: boolean, chartTitle?: string, chart?: boolean }} props `chart`: false when the page
 *   draws the chart itself and this shows the rows only
 */
export function UsageView({ usage, showWebsite = true, chartTitle = BILLING.usageChart, chart = true }) {
	const rows = /** @type {any[]} */ (usage?.rows ?? []);
	return (
		<div className="space-y-6">
			{chart ? (
				<Card
					title={chartTitle}
					subtitle={BILLING.usageChartIntro(`${usage?.from ?? ''} – ${usage?.to ?? ''}`, formatCredits(usage?.total ?? 0))}>
					<BarChart label={chartTitle} data={creditDayBars(usage?.days)} format={formatChartCredits} />
				</Card>
			) : null}
			<FiguresTable
				caption={BILLING.usageTitle}
				rows={rows}
				rowKey={(r) => `${r.day}:${r.websiteId}:${r.productId}:${r.feature}`}
				empty={<EmptyState compact icon="trendingUp" kind="credit" title={BILLING.noUsage} />}
				defaultSort={{ key: 'day', dir: 'desc' }}
				columns={[
					{ key: 'day', header: BILLING.usageColumns.day, kind: 'date', sortable: true, rowHeader: true },
					...(showWebsite ? [{ key: 'domain', header: BILLING.usageColumns.website, sortable: true }] : []),
					{ key: 'product', header: BILLING.usageColumns.product, sortable: true },
					{ key: 'featureName', header: BILLING.usageColumns.feature, sortable: true },
					{ key: 'hours', header: BILLING.usageColumns.hours, kind: 'number', sortable: true },
					{
						key: 'amount',
						header: BILLING.usageColumns.credits,
						kind: 'money',
						sortable: true,
						render: (r) => formatCredits(r.amount),
					},
				]}
				totals={{
					amount: formatCredits(usage?.total ?? 0),
				}}
			/>
		</div>
	);
}

/**
 * The columns of the usage table: one row per product × website × UTC day × feature.
 * @param {boolean} [showWebsite] false on a website's own page
 * @returns {Columns}
 */
export const usageColumns = (showWebsite = true) => [
	{ key: 'day', header: BILLING.usageColumns.day, kind: /** @type {const} */ ('date'), sortable: true },
	...(showWebsite ? [{ key: 'domain', header: BILLING.usageColumns.website, sortable: true }] : []),
	{ key: 'product', header: BILLING.usageColumns.product, sortable: true },
	{ key: 'featureName', header: BILLING.usageColumns.feature, sortable: true, low: true },
	{ key: 'hours', header: BILLING.usageColumns.hours, kind: /** @type {const} */ ('number'), sortable: true, low: true },
	{
		key: 'amount',
		header: BILLING.usageColumns.credits,
		kind: /** @type {const} */ ('money'),
		sortable: true,
		render: (r) => formatCredits(r.amount),
	},
];

/**
 * The columns of the receipts table; the amount paid shows to admins only (present only in admin responses).
 * @param {{ receipts: any[], showMerchant?: boolean }} input
 * @returns {Columns}
 */
export const receiptColumns = ({ receipts, showMerchant = false }) => [
	{
		key: 'at',
		header: BILLING.receiptColumns.date,
		kind: /** @type {const} */ ('date'),
		sortable: true,
		render: (r) => <LocalTime value={r.at} />,
	},
	...(showMerchant ? [{ key: 'merchantName', header: BILLING.receiptColumns.merchant, sortable: true }] : []),
	{
		key: 'credits',
		header: BILLING.receiptColumns.credits,
		kind: /** @type {const} */ ('money'),
		sortable: true,
		render: (r) => formatCredits(r.credits),
	},
	...(receipts.some((r) => 'amountPaid' in r)
		? [{ key: 'amountPaid', header: BILLING.receiptColumns.amountPaid, low: true }]
		: []),
	{ key: 'method', header: BILLING.receiptColumns.method, sortable: true, low: true },
	{ key: 'reference', header: BILLING.receiptColumns.reference, low: true, render: (r) => r.reference ?? '—' },
];
