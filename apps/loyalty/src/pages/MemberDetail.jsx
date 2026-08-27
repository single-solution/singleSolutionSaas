import React from 'react';
import { useParams, Link } from 'react-router-dom';
import { Award, Gift, ArrowLeft } from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { Card } from '@saas/ui/cards/Card';
import { StatCard } from '@saas/ui/cards/StatCard';
import { DataTable } from '@saas/ui/tables/Table';
import { Badge } from '@saas/ui/badges/Badge';

export default function MemberDetail() {
	const { id } = useParams();

	return (
		<div className="space-y-6 max-w-4xl">
			<PageHeader
				title={`Member Profile: ${id || 'mem_1'}`}
				subtitle="Zainab Bibi • Gold VIP Member"
				actions={
					<Link to="/members" className="text-xs font-semibold text-zinc-600 hover:text-zinc-900">
						← Back to Members
					</Link>
				}
			/>

			<div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
				<StatCard title="Point Balance" value="2,450 pts" trend="Gold Tier" />
				<StatCard title="Lifetime Spend" value="$1,840.00" trend="24 Orders" />
				<StatCard title="Points Redeemed" value="1,200 pts" trend="4 Vouchers" />
			</div>

			<Card title="Reward Redemption History">
				<DataTable
					columns={[
						{ key: 'reward', label: 'Voucher / Perk' },
						{ key: 'points', label: 'Points Deducted' },
						{ key: 'status', label: 'Status', render: (v) => <Badge type="active">{v}</Badge> },
						{ key: 'date', label: 'Redemption Date' },
					]}
					data={[
						{ reward: '$20 Store Credit Voucher', points: '500 pts', status: 'Redeemed', date: '2024-03-12' },
						{ reward: 'Free Express Courier Delivery', points: '250 pts', status: 'Redeemed', date: '2024-02-18' },
					]}
				/>
			</Card>
		</div>
	);
}
