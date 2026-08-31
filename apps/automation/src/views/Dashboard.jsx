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
				title="Workflow Automation Engine"
				subtitle="Event-driven business logic triggers, webhook responders, and external sync pipelines"
			/>

			<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
				<StatCard title="Active Automations" value="14 Pipelines" trend="+2 new" />
				<StatCard title="Executions (24h)" value="12,480" trend="+18.2%" />
				<StatCard title="Success Rate" value="99.8%" trend="Grade A+" />
				<StatCard title="Avg Pipeline Latency" value="18ms" trend="Edge Fast" />
			</div>

			<Card title="Recently Fired Pipelines">
				<DataTable
					columns={[
						{ key: 'workflow', label: 'Workflow Name' },
						{ key: 'trigger', label: 'Trigger Event' },
						{
							key: 'status',
							label: 'Execution',
							render: (v) => <Badge type={v === 'Success' ? 'active' : 'danger'}>{v}</Badge>,
						},
						{ key: 'duration', label: 'Duration' },
						{ key: 'time', label: 'Fired At' },
					]}
					data={[
						{
							workflow: 'Order Paid -> Slack Alert & Invoice Email',
							trigger: 'order_paid',
							status: 'Success',
							duration: '14ms',
							time: '1m ago',
						},
						{
							workflow: 'Low Stock Alert -> WhatsApp Notification',
							trigger: 'inventory_low',
							status: 'Success',
							duration: '22ms',
							time: '18m ago',
						},
						{
							workflow: 'Abandoned Cart -> 1-Hour Discount Voucher',
							trigger: 'cart_abandoned',
							status: 'Success',
							duration: '19ms',
							time: '42m ago',
						},
					]}
				/>
			</Card>
		</div>
	);
}
