'use client';
/**
 * Usage and credits (PLAN 0.8.2 Merchant), a page of its own with two sub-pages as addresses: Usage (`/credits`: the
 * spend per UTC day as a chart above one row per product × website × day × feature, filtered by period, dates and
 * website) and Receipts (`/credits/receipts`: every credit receipt; the amount paid is shown to admins only). The balance,
 * the days left and the spend are the header's numbers. Credits are added by an admin; the page shows the support
 * contact in the frame's banner instead of a payment form.
 * @module
 */
import {
	BarChart,
	Callout,
	DataTable,
	EmptyState,
	Page,
	Pagination,
	Toolbar,
	describeProblem,
	formatCredits,
	usePaged,
} from '@ss/ui';
import { BILLING, MORE } from '../../texts/console.js';
import { Link } from '../link.js';
import { useNavigation } from '../navigation.js';
import { query, routes } from '../paths.js';
import { DaysLeft, creditDayBars, formatChartCredits, merchantPill, receiptColumns, usageColumns } from './billing.js';
import { PageProblem } from './common.js';
import { FrameBilling } from './frame-billing.js';
import { DateFields, periodFilter } from './range.js';

/**
 * The page around both parts: the header (title, status, the money numbers), the sub-page navigation and the part's
 * toolbar, body and footer.
 * @param {{ props: any, part: 'usage' | 'receipts', toolbar: import('react').ReactNode, footer?: import('react').ReactNode,
 *   flush?: boolean, children: import('react').ReactNode }} input
 */
function CreditsFrame({ props, part, toolbar, footer, flush = true, children }) {
	const billing = props.billing;
	return (
		<>
			<FrameBilling billing={billing} />
			<Page
				linkAs={Link}
				flush={flush}
				bodyKey={part}
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
				nav={{
					value: part,
					label: BILLING.parts,
					items: [
						{ id: 'usage', label: BILLING.usageSection, icon: 'trendingUp', href: routes.credits() },
						{
							id: 'receipts',
							label: BILLING.receiptsTitle,
							icon: 'receipt',
							count: props.receipts.length,
							href: routes.creditsReceipts(),
						},
					],
				}}
				toolbar={toolbar}
				{...(footer ? { footer } : {})}>
				{children}
			</Page>
		</>
	);
}

/**
 * Usage: the chart of the period and its rows.
 * @param {any} props loader result of `loadCredits`
 */
function UsagePage(props) {
	const nav = useNavigation();
	const filter = props.filter;
	const usage = props.usage;
	const rows = /** @type {any[]} */ (usage?.rows ?? []);
	const paged = usePaged(rows, {
		pageSize: 50,
		text: (r) => `${r.day} ${r.domain} ${r.product} ${r.featureName}`,
	});
	/** @param {{ from?: string | null, to?: string | null, websiteId?: string | null }} next */
	const hrefFor = (next) =>
		`${routes.credits()}${query({ from: filter.from, to: filter.to, websiteId: filter.websiteId, ...next })}`;
	return (
		<CreditsFrame
			props={props}
			part="usage"
			toolbar={
				<Toolbar
					label={BILLING.usageSection}
					search={{
						value: paged.query,
						label: BILLING.searchUsage,
						placeholder: BILLING.searchUsage,
						onSearch: paged.setQuery,
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
							options: props.websites.map((/** @type {any} */ w) => ({
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
			{...(paged.found.length > 0 ? { footer: <Pagination {...paged.pagination} /> } : {})}>
			{props.usageProblem ? (
				<div className="p-4">
					<Callout tone="danger">{describeProblem(props.usageProblem)}</Callout>
				</div>
			) : (
				<>
					<div className="shrink-0 border-b border-line-soft px-4 py-3">
						<p className="mb-2 text-label text-muted">
							{BILLING.usageChartIntro(`${usage?.from ?? ''} – ${usage?.to ?? ''}`, formatCredits(usage?.total ?? 0))}
						</p>
						<BarChart
							label={BILLING.usageChart}
							data={creditDayBars(usage?.days)}
							format={formatChartCredits}
							height={132}
						/>
					</div>
					<DataTable
						caption={BILLING.usageTitle}
						rows={paged.rows}
						rowKey={(r) => `${r.day}:${r.websiteId}:${r.productId}:${r.feature}`}
						defaultSort={{ key: 'day', dir: 'desc' }}
						empty={<EmptyState compact icon="trendingUp" kind="credit" title={BILLING.noUsage} />}
						columns={usageColumns()}
					/>
				</>
			)}
		</CreditsFrame>
	);
}

/**
 * Receipts: every credit receipt, newest first.
 * @param {any} props loader result of `loadCredits`
 */
function ReceiptsPage(props) {
	const receipts = /** @type {any[]} */ (props.receipts);
	const paged = usePaged(receipts, {
		pageSize: 50,
		text: (r) => `${r.method ?? ''} ${r.reference ?? ''} ${r.credits}`,
	});
	return (
		<CreditsFrame
			props={props}
			part="receipts"
			toolbar={
				<Toolbar
					label={BILLING.receiptsTitle}
					search={{
						value: paged.query,
						label: BILLING.searchReceipts,
						placeholder: BILLING.searchReceipts,
						onSearch: paged.setQuery,
					}}
				/>
			}
			{...(paged.found.length > 0 ? { footer: <Pagination {...paged.pagination} /> } : {})}>
			<DataTable
				caption={BILLING.receiptsTitle}
				rows={paged.rows}
				rowKey={(r) => r.receiptId}
				defaultSort={{ key: 'at', dir: 'desc' }}
				empty={<EmptyState compact icon="receipt" kind="credit" title={BILLING.noReceipts} />}
				columns={receiptColumns({ receipts })}
			/>
		</CreditsFrame>
	);
}

/**
 * @param {any} props loader result of `loadCredits` plus the `part` of the address
 */
export function CreditsView(props) {
	if (!props.ok) return <PageProblem problem={props.problem} />;
	return props.part === 'receipts' ? <ReceiptsPage {...props} /> : <UsagePage {...props} />;
}
