import React from 'react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { StatCard } from '@saas/ui/cards/StatCard';
import { Card } from '@saas/ui/cards/Card';
import { DataTable } from '@saas/ui/tables/Table';
import { Badge } from '@saas/ui/badges/Badge';

export default function Dashboard() {
	return (
		<div className="space-y-6">
			<PageHeader
				title="AI Chatbot Console"
				subtitle="Manage autonomous customer conversations, resolution metrics, and escalation triggers"
			/>

			<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
				<StatCard title="Total Conversations" value="1,247" trend="+12%" />
				<StatCard title="Bot Resolution Rate" value="78%" trend="+5%" />
				<StatCard title="Avg Response Time" value="1.2s" trend="-0.3s" />
				<StatCard title="Human Escalations" value="267" trend="-8%" />
			</div>

			<Card title="Live Customer Inquiries">
				<DataTable
					columns={[
						{ key: 'customer', label: 'Customer' },
						{ key: 'intent', label: 'Detected Intent' },
						{
							key: 'status',
							label: 'Status',
							render: (v) => <Badge type={v === 'Resolved' ? 'active' : 'warning'}>{v}</Badge>,
						},
						{ key: 'sentiment', label: 'Sentiment' },
						{ key: 'time', label: 'Time' },
					]}
					data={[
						{
							customer: 'Sarah Jenkins',
							intent: 'Order Tracking #8841',
							status: 'Resolved',
							sentiment: 'Positive (0.94)',
							time: '2m ago',
						},
						{
							customer: 'Ahmed Raza',
							intent: 'Return Request',
							status: 'Escalated',
							sentiment: 'Neutral (0.55)',
							time: '14m ago',
						},
						{
							customer: 'Emma Watson',
							intent: 'Product Size Guide',
							status: 'Resolved',
							sentiment: 'Positive (0.88)',
							time: '35m ago',
						},
					]}
				/>
			</Card>
		</div>
	);
}
