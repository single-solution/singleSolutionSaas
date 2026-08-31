import React from 'react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { DataTable } from '@saas/ui/tables/Table';
import { Badge } from '@saas/ui/badges/Badge';

export default function RunHistory() {
	const runs = [
		{
			id: 'run_99128',
			name: 'Order Paid -> Slack Alert',
			triggerId: 'evt_984',
			status: 'success',
			latency: '12ms',
			time: '4m ago',
		},
		{
			id: 'run_99127',
			name: 'VIP Point Multiplier',
			triggerId: 'evt_983',
			status: 'success',
			latency: '18ms',
			time: '12m ago',
		},
		{ id: 'run_99126', name: 'Stock Alert', triggerId: 'evt_982', status: 'success', latency: '9ms', time: '34m ago' },
	];

	return (
		<div className="space-y-6">
			<PageHeader title="Execution Run Logs" subtitle="Detailed audit trail of all serverless workflow invocations" />

			<DataTable
				columns={[
					{ key: 'id', label: 'Run ID', render: (v) => <strong className="font-mono text-zinc-900">{v}</strong> },
					{ key: 'name', label: 'Workflow Name' },
					{ key: 'triggerId', label: 'Event Source', render: (v) => <span className="font-mono text-zinc-500">{v}</span> },
					{ key: 'status', label: 'Result', render: (v) => <Badge type="active">{v.toUpperCase()}</Badge> },
					{ key: 'latency', label: 'Execution Time' },
					{ key: 'time', label: 'Executed' },
				]}
				data={runs}
			/>
		</div>
	);
}
