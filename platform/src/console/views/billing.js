'use client';
/**
 * Credits and billing pieces shared by the merchant and admin consoles (PLAN 0.5, 0.6): status badges with their
 * colours, days left, the billing banners, the usage chart and table, and the receipts table. Days, months and charts
 * are UTC and labelled so; single timestamps show in the viewer's local time.
 * @module
 */
import { useEffect, useState } from 'react';
import { Badge, BarChart, Callout, Card, EmptyState, HeroCard, Stat, Table, formatCredits, formatDateTime } from '@ss/ui';
import { BILLING } from '../../texts/console.js';

/** @typedef {'active' | 'low_balance' | 'grace' | 'stopped' | 'suspended'} MerchantStatus */
/** @typedef {'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info'} Tone */

/** @type {Record<string, Tone>} */
const MERCHANT_TONES = { active: 'success', low_balance: 'warning', grace: 'warning', stopped: 'danger', suspended: 'danger' };

/**
 * An instant in the viewer's local time (UTC until the browser formats it).
 * @param {{ value: string | null | undefined }} props
 */
export function LocalTime({ value }) {
	const [text, setText] = useState(value ? formatDateTime(value) : '—');
	useEffect(() => {
		if (value) setText(new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));
	}, [value]);
	return value ? <time dateTime={value}>{text}</time> : <>—</>;
}

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
 * Colour of a product-on-website status (PLAN 0.6): Active green, In grace amber, Stopped and Suspended red, and grey
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
		<div className="@container">
			<div className="grid gap-5 @lg:grid-cols-2 @5xl:grid-cols-4">
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
			</div>
		</div>
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
 * The merchant's hero card (PLAN 0.6): the credit balance and days left, with the 30-day spend chart inside.
 * @param {{ summary: any, days: ReadonlyArray<{ day: string, amount: number }> | undefined, label: string,
 *   chartLabel: string }} props
 */
export function BalanceHero({ summary, days, label, chartLabel }) {
	return (
		<HeroCard
			label={label}
			value={formatCredits(summary.balance)}
			icon="wallet"
			details={[
				{ label: BILLING.daysLeft, value: <DaysLeft summary={summary} /> },
				{ label: BILLING.dailySpend, value: formatCredits(summary.dailySpend) },
			]}
			chart={{ label: chartLabel, data: creditDayBars(days), format: formatChartCredits }}>
			<div>
				<MerchantStatusBadge status={summary.status} />
			</div>
		</HeroCard>
	);
}

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
 * @param {{ usage: any, showWebsite?: boolean, chartTitle?: string }} props
 */
export function UsageView({ usage, showWebsite = true, chartTitle = BILLING.usageChart }) {
	const rows = /** @type {any[]} */ (usage?.rows ?? []);
	return (
		<div className="space-y-8">
			<Card
				title={chartTitle}
				subtitle={BILLING.usageChartIntro(`${usage?.from ?? ''} – ${usage?.to ?? ''}`, formatCredits(usage?.total ?? 0))}>
				<BarChart label={chartTitle} data={creditDayBars(usage?.days)} format={formatChartCredits} />
			</Card>
			<Table
				caption={BILLING.usageTitle}
				rows={rows}
				rowKey={(r) => `${r.day}:${r.websiteId}:${r.productId}:${r.feature}`}
				empty={<EmptyState compact icon="trendingUp" kind="credit" title={BILLING.noUsage} />}
				defaultSort={{ key: 'day', direction: 'desc' }}
				columns={[
					{ key: 'day', header: BILLING.usageColumns.day, sortable: true, rowHeader: true },
					...(showWebsite ? [{ key: 'domain', header: BILLING.usageColumns.website, sortable: true }] : []),
					{ key: 'product', header: BILLING.usageColumns.product, sortable: true },
					{ key: 'featureName', header: BILLING.usageColumns.feature, sortable: true },
					{ key: 'hours', header: BILLING.usageColumns.hours, align: 'right', sortable: true },
					{
						key: 'amount',
						header: BILLING.usageColumns.credits,
						align: 'right',
						sortable: true,
						render: (r) => formatCredits(r.amount),
					},
				]}
			/>
		</div>
	);
}

/**
 * Credit receipts; the amount paid is shown to admins only (present only in admin responses).
 * @param {{ receipts: any[], showMerchant?: boolean }} props
 */
export function ReceiptsTable({ receipts, showMerchant = false }) {
	const admin = receipts.some((r) => 'amountPaid' in r);
	return (
		<Table
			caption={BILLING.receiptsTitle}
			rows={receipts}
			rowKey={(r) => r.receiptId}
			empty={<EmptyState compact icon="receipt" kind="credit" title={BILLING.noReceipts} />}
			columns={[
				{ key: 'at', header: BILLING.receiptColumns.date, rowHeader: true, render: (r) => <LocalTime value={r.at} /> },
				...(showMerchant ? [{ key: 'merchantName', header: BILLING.receiptColumns.merchant, sortable: true }] : []),
				{
					key: 'credits',
					header: BILLING.receiptColumns.credits,
					align: /** @type {const} */ ('right'),
					sortable: true,
					render: (/** @type {any} */ r) => formatCredits(r.credits),
				},
				...(admin ? [{ key: 'amountPaid', header: BILLING.receiptColumns.amountPaid }] : []),
				{ key: 'method', header: BILLING.receiptColumns.method, sortable: true },
				{ key: 'reference', header: BILLING.receiptColumns.reference, render: (/** @type {any} */ r) => r.reference ?? '—' },
			]}
		/>
	);
}
