'use client';
/**
 * Usage and credits (flat layout 2026-10-21, K-4c): one page with balance, days left and spend as stats on top,
 * the 30-day chart, usage as a FiguresTable (K-1e) and receipts as rich Rows (amount as value, date as time).
 * The period filter stays in the toolbar.
 * @module
 */
import { useEffect } from 'react';
import {
	BarChart,
	Callout,
	Card,
	EmptyState,
	FiguresTable,
	LocalTime,
	Page,
	Pagination,
	Row,
	Toolbar,
	describeProblem,
	formatCredits,
	usePaged,
} from '@ss/ui';
import { BILLING, MORE } from '../../texts/console.js';
import { Link } from '../link.js';
import { useNavigation } from '../navigation.js';
import { query, routes } from '../paths.js';
import { DaysLeft, creditDayBars, formatChartCredits, merchantPill, usageColumns } from './billing.js';
import { PageProblem } from './common.js';
import { FrameBilling } from './shell.js';
import { DateFields, periodFilter } from './range.js';

/**
 * @param {any} props loader result of `loadCredits`
 */
export function CreditsView(props) {
	if (!props.ok) return <PageProblem problem={props.problem} />;

	const nav = useNavigation();
	const filter = props.filter ?? {};
	const usage = props.usage;
	const billing = props.billing;
	const receipts = /** @type {any[]} */ (props.receipts ?? []);
	const usageRows = /** @type {any[]} */ (usage?.rows ?? []);

	const usagePaged = usePaged(usageRows, {
		pageSize: 50,
		text: (r) => `${r.day} ${r.domain} ${r.product} ${r.featureName}`,
	});

	const receiptsPaged = usePaged(receipts, {
		pageSize: 50,
		text: (r) => `${r.method ?? ''} ${r.reference ?? ''} ${r.credits}`,
	});

	/** @param {{ from?: string | null, to?: string | null, websiteId?: string | null }} next */
	const hrefFor = (next) =>
		`${routes.credits()}${query({ from: filter.from, to: filter.to, websiteId: filter.websiteId, ...next })}`;

	useEffect(() => {
		if (props.part === 'receipts' && typeof window !== 'undefined' && !window.location.hash) {
			const el = document.getElementById('receipts');
			if (el) {
				el.scrollIntoView?.({ behavior: 'smooth' });
				window.history.replaceState?.(null, '', '#receipts');
			}
		}
	}, [props.part]);

	const sections = [
		{
			id: 'usage',
			label: BILLING.usageSection,
			icon: /** @type {const} */ ('trendingUp'),
			body: (
				<div className="space-y-6">
					{usage ? (
						<Card
							title={BILLING.usageChart}
							subtitle={BILLING.usageChartIntro(
								`${usage?.from ?? ''} – ${usage?.to ?? ''}`,
								formatCredits(usage?.total ?? 0),
							)}>
							<BarChart
								label={BILLING.usageChart}
								data={creditDayBars(usage?.days)}
								format={formatChartCredits}
								height={140}
							/>
						</Card>
					) : null}
					{props.usageProblem ? (
						<Callout tone="danger">{describeProblem(props.usageProblem)}</Callout>
					) : usage ? (
						<div className="space-y-3">
							<FiguresTable
								caption={BILLING.usageTitle}
								rows={usagePaged.rows}
								rowKey={(r) => `${r.day}:${r.websiteId}:${r.productId}:${r.feature}`}
								defaultSort={{ key: 'day', dir: 'desc' }}
								empty={<EmptyState compact icon="trendingUp" kind="credit" title={BILLING.noUsage} />}
								columns={usageColumns()}
								totals={{
									amount: formatCredits(usage?.total ?? 0),
								}}
							/>
							{usagePaged.found.length > 50 ? <Pagination {...usagePaged.pagination} /> : null}
						</div>
					) : null}
				</div>
			),
		},
		{
			id: 'receipts',
			label: BILLING.receiptsTitle,
			icon: /** @type {const} */ ('receipt'),
			body: (
				<Card title={BILLING.receiptsTitle} subtitle={BILLING.receiptsIntro}>
					<div className="space-y-4">
						<Toolbar
							label={BILLING.receiptsTitle}
							search={{
								value: receiptsPaged.query,
								label: BILLING.searchReceipts,
								placeholder: BILLING.searchReceipts,
								onSearch: receiptsPaged.setQuery,
							}}
						/>
						{receiptsPaged.rows.length === 0 ? (
							<EmptyState compact icon="receipt" kind="credit" title={BILLING.noReceipts} />
						) : (
							<div className="divide-y divide-line-soft rounded-card border border-line bg-surface">
								{receiptsPaged.rows.map((r) => (
									<Row
										key={r.receiptId}
										lead={{ icon: 'receipt' }}
										title={r.method ?? BILLING.receiptsTitle}
										meta={[r.reference].filter(Boolean)}
										value={formatCredits(r.credits)}
										time={<LocalTime value={r.at} />}
									/>
								))}
							</div>
						)}
						{receiptsPaged.found.length > 50 ? <Pagination {...receiptsPaged.pagination} /> : null}
					</div>
				</Card>
			),
		},
	];

	return (
		<>
			<FrameBilling billing={billing} />
			<Page
				linkAs={Link}
				crumbs={[{ label: BILLING.usageTitle }]}
				info={BILLING.usageIntro}
				{...(billing ? { status: [merchantPill(billing.status)] } : {})}
				{...(billing
					? {
							facts: [
								{
									label: BILLING.balance,
									value: formatCredits(billing.balance),
									tone: billing.balance <= 0 ? 'danger' : billing.lowBalance ? 'warning' : 'success',
								},
								{ label: BILLING.daysLeft, value: <DaysLeft summary={billing} /> },
								{ label: BILLING.dailySpend, value: formatCredits(billing.dailySpend) },
								{ label: BILLING.spentThisMonth, value: formatCredits(billing.spentThisMonth) },
							],
						}
					: {})}
				toolbar={
					<Toolbar
						label={BILLING.usageSection}
						search={{
							value: usagePaged.query,
							label: BILLING.searchUsage,
							placeholder: BILLING.searchUsage,
							onSearch: usagePaged.setQuery,
						}}
						filters={[
							periodFilter({
								from: filter.from,
								to: filter.to,
								emptyLabel: MORE.range.last30,
								omit: 'last30',
								hrefFor: (range) => hrefFor(range),
								go: nav.go,
							}),
							{
								id: 'website',
								label: BILLING.filters.website,
								allLabel: BILLING.filters.all,
								value: filter.websiteId ?? '',
								onChange: (websiteId) => nav.go(hrefFor({ websiteId: websiteId || null })),
								options: (props.websites ?? []).map((/** @type {any} */ w) => ({
									value: String(w.websiteId),
									label: String(w.domain),
								})),
							},
						]}>
						<DateFields
							from={filter.from}
							to={filter.to}
							fromLabel={BILLING.filters.from}
							toLabel={BILLING.filters.to}
							hrefFor={(range) => hrefFor(range)}
							go={nav.go}
						/>
					</Toolbar>
				}
				sections={sections}
			/>
		</>
	);
}
