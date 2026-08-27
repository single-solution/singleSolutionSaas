import React from 'react';
import { Gift, Plus } from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { DataTable } from '@saas/ui/tables/Table';
import { Badge } from '@saas/ui/badges/Badge';
import { Button } from '@saas/ui/buttons/Button';

export default function RewardsList() {
	const rewards = [
		{ id: 'rw_1', name: '$10 Off Storewide', cost: '250 pts', type: 'Discount Code', status: 'active', claimed: 842 },
		{ id: 'rw_2', name: '$25 Off Orders over $100', cost: '500 pts', type: 'Cart Voucher', status: 'active', claimed: 412 },
		{ id: 'rw_3', name: 'Free Velvet Gift Bag', cost: '750 pts', type: 'Free Product', status: 'active', claimed: 189 },
	];

	return (
		<div className="space-y-6">
			<PageHeader
				title="Redemption Rewards Catalog"
				subtitle="Configure store vouchers, free gifts, and shipping discounts claimable with loyalty points"
				actions={
					<Button size="sm">
						<Plus size={13} />
						<span>Create Reward</span>
					</Button>
				}
			/>

			<DataTable
				columns={[
					{ key: 'name', label: 'Reward Title', render: (v) => <strong className="text-zinc-900">{v}</strong> },
					{
						key: 'cost',
						label: 'Point Cost',
						render: (v) => <span className="font-mono font-bold text-zinc-800">{v}</span>,
					},
					{ key: 'type', label: 'Reward Type' },
					{ key: 'status', label: 'Status', render: (v) => <Badge type="active">{v.toUpperCase()}</Badge> },
					{ key: 'claimed', label: 'Total Claims' },
				]}
				data={rewards}
			/>
		</div>
	);
}
