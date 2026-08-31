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
				title="Loyalty & Rewards Program"
				subtitle="Manage member tiers, point redemption velocity, and customer loyalty retention"
			/>

			<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
				<StatCard title="Enrolled Members" value="4,821" trend="+14.5%" />
				<StatCard title="Points Issued" value="482,000 pts" trend="+22.1%" />
				<StatCard title="Redemption Rate" value="68.4%" trend="+3.2%" />
				<StatCard title="Loyalty GMV Boost" value="$38,400" trend="+19.4%" />
			</div>

			<Card title="Recent Point Redemptions">
				<DataTable
					columns={[
						{ key: 'customer', label: 'VIP Customer' },
						{
							key: 'tier',
							label: 'Current Tier',
							render: (v) => <Badge type={v === 'Gold' ? 'warning' : 'pro'}>{v}</Badge>,
						},
						{ key: 'reward', label: 'Reward Claimed' },
						{ key: 'points', label: 'Points Spent' },
						{ key: 'time', label: 'Timestamp' },
					]}
					data={[
						{ customer: 'Zainab Bibi', tier: 'Gold', reward: '$20 Store Voucher', points: '500 pts', time: '12m ago' },
						{ customer: 'Farhan Ali', tier: 'Silver', reward: 'Free Express Shipping', points: '250 pts', time: '34m ago' },
						{
							customer: 'Sana Malik',
							tier: 'Platinum',
							reward: '$50 VIP Cash Reward',
							points: '1,200 pts',
							time: '1h ago',
						},
					]}
				/>
			</Card>
		</div>
	);
}
