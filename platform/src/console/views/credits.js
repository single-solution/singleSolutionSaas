'use client';
/**
 * Usage and credits (PLAN 0.8.2 Merchant): balance and days left at the current spend, the spend per product ×
 * website × UTC day × feature, and the credit receipts (the amount paid is shown to admins only). Credits are added by
 * an admin; the page shows the support contact instead of a payment form.
 * @module
 */
import { Button, Callout, Card, Input, PageHeader, Select, describeProblem } from '@ss/ui';
import { BILLING } from '../../texts/console.js';
import { BillingStats, ReceiptsTable, UsageView } from './billing.js';
import { PageProblem } from './common.js';

/**
 * A GET form for a range of UTC days and a website.
 * @param {{ range: { from: string | null, to: string | null }, websites: any[], websiteId: string | null }} props
 */
function RangeForm({ range, websites, websiteId }) {
	return (
		<form method="get" className="flex flex-wrap items-end gap-3">
			<Input label={BILLING.filters.from} name="from" type="date" defaultValue={range.from ?? ''} />
			<Input label={BILLING.filters.to} name="to" type="date" defaultValue={range.to ?? ''} />
			<Select
				label={BILLING.filters.website}
				name="websiteId"
				defaultValue={websiteId ?? ''}
				options={[
					{ value: '', label: BILLING.filters.all },
					...websites.map((w) => ({ value: String(w.websiteId), label: String(w.domain) })),
				]}
			/>
			<Button type="submit" variant="secondary">
				{BILLING.filters.apply}
			</Button>
		</form>
	);
}

/**
 * @param {any} props loader result of `loadCredits`
 */
export function CreditsView(props) {
	if (!props.ok) return <PageProblem problem={props.problem} />;
	return (
		<div className="space-y-8">
			<PageHeader title={BILLING.usageTitle} subtitle={BILLING.usageIntro} />
			<BillingStats summary={props.billing} />
			<Card>
				<RangeForm range={props.filter} websites={props.websites} websiteId={props.filter.websiteId} />
			</Card>
			{props.usageProblem ? (
				<Callout tone="danger">{describeProblem(props.usageProblem)}</Callout>
			) : (
				<UsageView usage={props.usage} />
			)}
			<Card title={BILLING.receiptsTitle} subtitle={BILLING.receiptsIntro} padded={false}>
				<ReceiptsTable receipts={props.receipts} />
			</Card>
		</div>
	);
}
