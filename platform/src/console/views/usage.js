'use client';
/**
 * Website → Usage (PLAN 0.5.11): spend per UTC day and the hours and credits per product × feature × day of this
 * website. Today's rows are live.
 * @module
 */
import { Callout, Card, Input, Select, describeProblem } from '@ss/ui';
import { BILLING } from '../../texts/console.js';
import { UsageView as UsageTables } from './billing.js';
import { PageProblem, WebsiteHeader } from './common.js';

/**
 * A GET form for a range of UTC days (and optionally a website).
 * @param {{ range: { from: string | null, to: string | null }, websites?: any[] | null, websiteId?: string | null }} props
 */
export function RangeForm({ range, websites = null, websiteId = null }) {
	return (
		<form method="get" className="flex flex-wrap items-end gap-3">
			<Input label={BILLING.filters.from} name="from" type="date" defaultValue={range.from ?? ''} />
			<Input label={BILLING.filters.to} name="to" type="date" defaultValue={range.to ?? ''} />
			{websites ? (
				<Select
					label={BILLING.filters.website}
					name="websiteId"
					defaultValue={websiteId ?? ''}
					options={[
						{ value: '', label: BILLING.filters.all },
						...websites.map((w) => ({ value: String(w.websiteId), label: String(w.domain) })),
					]}
				/>
			) : null}
			<button
				type="submit"
				className="min-h-10 rounded-xl border border-line bg-surface px-4 text-sm font-semibold text-fg hover:border-line-strong">
				{BILLING.filters.apply}
			</button>
		</form>
	);
}

/**
 * @param {any} props loader result of `loadUsage`
 */
export function UsageView(props) {
	if (!props.ok) return <PageProblem problem={props.problem} />;
	return (
		<div className="space-y-6">
			<WebsiteHeader website={props.website} active="usage" />
			<Card>
				<RangeForm range={props.range} />
			</Card>
			{props.usageProblem ? (
				<Callout tone="danger">{describeProblem(props.usageProblem)}</Callout>
			) : (
				<UsageTables usage={props.usage} showWebsite={false} />
			)}
		</div>
	);
}
