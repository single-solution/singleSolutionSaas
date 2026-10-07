'use client';
/**
 * Usage and credits (PLAN 0.8.2 Merchant): balance and days left at the current spend, the spend per product ×
 * website × UTC day × feature, and the credit receipts (the amount paid is shown to admins only). Credits are added by
 * an admin; the page shows the support contact instead of a payment form.
 * @module
 */
import { Callout, Card, PageHeader, describeProblem } from '@ss/ui';
import { BILLING } from '../../texts/console.js';
import { BillingStats, ReceiptsTable, UsageView } from './billing.js';
import { PageProblem } from './common.js';
import { RangeForm } from './usage.js';

/**
 * @param {any} props loader result of `loadCredits`
 */
export function CreditsView(props) {
	if (!props.ok) return <PageProblem problem={props.problem} />;
	return (
		<div className="space-y-6">
			<PageHeader title={BILLING.usageTitle} />
			<BillingStats summary={props.billing} />
			<Card>
				<RangeForm range={props.filter} websites={props.websites} websiteId={props.filter.websiteId} />
			</Card>
			{props.usageProblem ? (
				<Callout tone="danger">{describeProblem(props.usageProblem)}</Callout>
			) : (
				<UsageView usage={props.usage} />
			)}
			<Card title={BILLING.receiptsTitle} padded={false}>
				<ReceiptsTable receipts={props.receipts} />
			</Card>
		</div>
	);
}
