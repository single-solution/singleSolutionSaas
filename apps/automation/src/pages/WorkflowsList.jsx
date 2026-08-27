import React, { useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { DataTable } from '@saas/ui/tables/Table';
import { Badge } from '@saas/ui/badges/Badge';
import { Button } from '@saas/ui/buttons/Button';
import { Input } from '@saas/ui/inputs/TextInput';

export default function WorkflowsList() {
	const [search, setSearch] = useState('');

	const workflows = [
		{
			id: 'wf_1',
			name: 'Order Paid -> Slack Alert & Invoice',
			trigger: 'order_paid',
			status: 'active',
			runs: '4,281',
			created: '2024-01-12',
		},
		{
			id: 'wf_2',
			name: 'VIP Customer Welcome Sequence',
			trigger: 'vip_tier_unlocked',
			status: 'active',
			runs: '892',
			created: '2024-02-04',
		},
		{
			id: 'wf_3',
			name: 'Inventory Stock Depletion Warning',
			trigger: 'inventory_critical',
			status: 'paused',
			runs: '142',
			created: '2024-03-01',
		},
	];

	return (
		<div className="space-y-6">
			<PageHeader
				title="Workflow Automation Pipelines"
				subtitle="Catalog of active and scheduled event automation pipelines"
				actions={
					<Link to="/builder">
						<Button size="sm">
							<Plus size={13} />
							<span>Create Automation</span>
						</Button>
					</Link>
				}
			/>

			<div className="space-y-4">
				<Input
					placeholder="Search automations by trigger or pipeline name..."
					value={search}
					onChange={(e) => setSearch(e.target.value)}
				/>
				<DataTable
					columns={[
						{
							key: 'name',
							label: 'Pipeline Name',
							render: (v, r) => (
								<Link to={`/builder?id=${r.id}`} className="font-semibold text-zinc-900 hover:underline">
									{v}
								</Link>
							),
						},
						{
							key: 'trigger',
							label: 'Inbound Trigger',
							render: (v) => <span className="font-mono text-zinc-600">{v}</span>,
						},
						{
							key: 'status',
							label: 'State',
							render: (v) => <Badge type={v === 'active' ? 'active' : 'neutral'}>{v.toUpperCase()}</Badge>,
						},
						{ key: 'runs', label: 'Total Executions' },
						{ key: 'created', label: 'Created' },
					]}
					data={workflows}
				/>
			</div>
		</div>
	);
}
