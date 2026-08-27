import React from 'react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { StatCard } from '@saas/ui/cards/StatCard';
import { Card } from '@saas/ui/cards/Card';

export default function Analytics() {
	return (
		<div className="space-y-6">
			<PageHeader
				title="Chatbot Performance Analytics"
				subtitle="Deflection rates, conversation duration, and customer satisfaction metrics"
			/>

			<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
				<StatCard title="Total Interactions" value="48,290" trend="+18.4%" />
				<StatCard title="CSAT Score" value="4.8 / 5.0" trend="+0.2" />
				<StatCard title="Avg Session Duration" value="1m 42s" trend="-15s" />
				<StatCard title="Cost Deflection" value="$3,420" trend="+22%" />
			</div>

			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				<Card title="Top Customer Inquiries">
					<div className="space-y-3 text-xs">
						<div className="flex justify-between items-center pb-2 border-b border-zinc-100">
							<span className="font-semibold text-zinc-800">Order Delivery Status</span>
							<span className="font-mono text-zinc-500">42% (20,281)</span>
						</div>
						<div className="flex justify-between items-center pb-2 border-b border-zinc-100">
							<span className="font-semibold text-zinc-800">Product Sizing & Fit</span>
							<span className="font-mono text-zinc-500">28% (13,521)</span>
						</div>
						<div className="flex justify-between items-center pb-2 border-b border-zinc-100">
							<span className="font-semibold text-zinc-800">Refund & Exchanges</span>
							<span className="font-mono text-zinc-500">18% (8,692)</span>
						</div>
						<div className="flex justify-between items-center">
							<span className="font-semibold text-zinc-800">Payment Inquiries</span>
							<span className="font-mono text-zinc-500">12% (5,794)</span>
						</div>
					</div>
				</Card>

				<Card title="Escalation Forensics">
					<div className="space-y-3 text-xs text-zinc-600">
						<p>
							• <strong>84%</strong> of escalations occurred when order numbers could not be validated via courier API.
						</p>
						<p>
							• <strong>12%</strong> were explicit customer requests to talk to human manager.
						</p>
						<p>
							• <strong>4%</strong> were complex international custom tailoring requests.
						</p>
					</div>
				</Card>
			</div>
		</div>
	);
}
