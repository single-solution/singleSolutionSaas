'use client';
/**
 * Usage & spend of a website: live meter, hours remaining, spend per day, per product, per element and per
 * metered unit (from the ledger statement), and the entries themselves.
 * @module
 */
import {
	BarChart,
	Button,
	Callout,
	Card,
	Input,
	Meter,
	ShareBars,
	Stat,
	Table,
	creditsNumber,
	describeProblem,
	formatCredits,
	formatCreditsPerHour,
	formatDateTime,
	formatHours,
	formatNumber,
	humanize,
} from '@ss/ui';
import { PageProblem, WebsiteHeader, productName } from './common.js';

const CHARGES = new Set(['settlement', 'metered']);

/**
 * Spend aggregates of ledger entries (charges are negative amounts; spend is reported positive).
 * @param {any[]} entries
 */
export const spendBreakdown = (entries) => {
	/** @type {Map<string, number>} */
	const byDay = new Map();
	/** @type {Map<string, number>} */
	const byApp = new Map();
	/** @type {Map<string, number>} */
	const byElement = new Map();
	/** @type {Map<string, { amount: number, quantity: number }>} */
	const byUnit = new Map();
	let total = 0;
	for (const e of entries) {
		if (!CHARGES.has(e.type)) continue;
		const spend = -e.amountMillicredits;
		total += spend;
		const day = String(e.periodStart ?? e.at).slice(0, 10);
		byDay.set(day, (byDay.get(day) ?? 0) + spend);
		if (e.appId) byApp.set(e.appId, (byApp.get(e.appId) ?? 0) + spend);
		for (const line of e.details?.breakdown ?? []) {
			const key = line.kind === 'element' ? `${e.appId ?? ''}:${line.element}` : `${e.appId ?? ''}:(base)`;
			byElement.set(key, (byElement.get(key) ?? 0) + (line.amount ?? 0));
		}
		for (const line of e.details?.lines ?? []) {
			const key = `${e.appId ?? ''}:${line.unit}`;
			const prev = byUnit.get(key) ?? { amount: 0, quantity: 0 };
			byUnit.set(key, { amount: prev.amount + (line.amount ?? 0), quantity: prev.quantity + (line.quantity ?? 0) });
		}
	}
	return { total, byDay, byApp, byElement, byUnit };
};

/**
 * @param {any} props loader result of `loadUsage`
 */
export function UsageView(props) {
	if (!props.ok) return <PageProblem problem={props.problem} />;
	const { website, catalog, meter, statement, range } = props;
	const lines = /** @type {any[]} */ (meter?.subscriptions ?? []).filter((l) => l.websiteId === website.websiteId);
	const burn = lines.reduce((s, l) => s + (l.burnRatePerHour ?? 0), 0);
	const entries = /** @type {any[]} */ (statement?.entries ?? []);
	const { total, byDay, byApp, byElement, byUnit } = spendBreakdown(entries);
	/** @param {string} key */
	const split = (key) => {
		const i = key.indexOf(':');
		return { appId: key.slice(0, i), rest: key.slice(i + 1) };
	};
	/** @param {string} appId @param {string} elementKey */
	const elementName = (appId, elementKey) =>
		catalog.find((/** @type {any} */ p) => p.appId === appId)?.elements?.find((/** @type {any} */ e) => e.key === elementKey)
			?.name ?? elementKey;
	const balance = meter?.balanceMillicredits ?? null;
	const monthTotal = typeof meter?.projectedMonth === 'number' && meter.projectedMonth > 0 ? meter.projectedMonth : null;
	return (
		<div className="space-y-6">
			<WebsiteHeader website={website} active="usage" />
			<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
				<Stat label="Spend now" value={formatCreditsPerHour(burn)} hint="This website" icon="activity" />
				<Stat
					label="Spend in range"
					value={formatCredits(total)}
					hint={`${entries.filter((e) => CHARGES.has(e.type)).length} hourly entries`}
					icon="wallet"
				/>
				<Stat
					label="Hours remaining"
					value={formatHours(meter?.hoursRemaining)}
					hint="Whole balance at the organisation's current spend"
					tone={typeof meter?.hoursRemaining === 'number' && meter.hoursRemaining < 24 ? 'warning' : 'neutral'}
					icon="clock"
				/>
				<Stat label="Balance" value={formatCredits(balance)} hint="Shared by all websites" icon="wallet" />
			</div>
			{monthTotal ? (
				<Card>
					<Meter
						label="Month to date vs. projected month (organisation)"
						value={meter.monthToDate}
						max={monthTotal}
						valueText={`${creditsNumber(meter.monthToDate)} of ${creditsNumber(monthTotal)} credits`}
						tone="primary"
						hint={`Projection to ${formatDateTime(meter.periodEnd)} at the current burn rate of ${formatCreditsPerHour(meter.burnRatePerHour)}.`}
					/>
				</Card>
			) : null}
			<Card title="Range" subtitle="UTC days; defaults to this month.">
				<form method="get" className="flex flex-wrap items-end gap-3">
					<Input label="From" type="date" name="from" defaultValue={range.from ?? ''} fieldClassName="w-44" />
					<Input label="To" type="date" name="to" defaultValue={range.to ?? ''} fieldClassName="w-44" />
					<Button type="submit" variant="secondary">
						Apply
					</Button>
				</form>
				{props.statementProblem ? (
					<Callout tone="danger" className="mt-4">
						{describeProblem(props.statementProblem)}
					</Callout>
				) : null}
			</Card>
			<Card title="Spend per day">
				<BarChart
					label="Spend per day in credits"
					data={[...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([day, v]) => ({ label: day.slice(5), value: v }))}
					format={(v) => formatCredits(v)}
				/>
			</Card>
			<div className="grid gap-4 lg:grid-cols-3">
				<Card title="Per product">
					<ShareBars
						label="Spend per product"
						format={(v) => formatCredits(v)}
						data={[...byApp]
							.sort((a, b) => b[1] - a[1])
							.map(([appId, v]) => ({ label: productName(catalog, appId), value: v }))}
					/>
				</Card>
				<Card title="Per element">
					<ShareBars
						label="Spend per element"
						format={(v) => formatCredits(v)}
						data={[...byElement]
							.filter(([, v]) => v > 0)
							.sort((a, b) => b[1] - a[1])
							.map(([key, v]) => {
								const { appId, rest } = split(key);
								return {
									label: rest === '(base)' ? `${productName(catalog, appId)} base` : elementName(appId, rest),
									value: v,
								};
							})}
					/>
				</Card>
				<Card title="Per unit (metered)">
					<ShareBars
						label="Metered spend per unit"
						format={(v) => formatCredits(v)}
						emptyText="No metered usage in this range."
						data={[...byUnit]
							.sort((a, b) => b[1].amount - a[1].amount)
							.map(([key, v]) => ({
								label: humanize(split(key).rest),
								value: v.amount,
								hint: `${formatNumber(v.quantity)} used`,
							}))}
					/>
				</Card>
			</div>
			<Table
				caption="Ledger entries of this website"
				captionHidden={false}
				rows={entries}
				rowKey={(e) => e.entryId}
				defaultSort={{ key: 'at', direction: 'desc' }}
				empty="No charges in this range yet. Hours settle shortly after they end."
				columns={[
					{
						key: 'at',
						header: 'Hour',
						sortable: true,
						sortValue: (e) => e.periodStart ?? e.at,
						render: (e) => formatDateTime(e.periodStart ?? e.at),
					},
					{ key: 'appId', header: 'Product', render: (e) => (e.appId ? productName(catalog, e.appId) : '—') },
					{ key: 'type', header: 'Type', render: (e) => humanize(e.type) },
					{
						key: 'amount',
						header: 'Amount',
						align: 'right',
						sortable: true,
						sortValue: (e) => e.amountMillicredits,
						render: (e) => <span className="tabular-nums">{formatCredits(e.amountMillicredits, { signed: true })}</span>,
					},
				]}
			/>
		</div>
	);
}
