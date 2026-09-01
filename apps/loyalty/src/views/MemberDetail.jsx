'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Award, ArrowLeft, Plus, Gift, History, Calendar, Mail, User } from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { Card } from '@saas/ui/cards/Card';
import { StatCard } from '@saas/ui/cards/StatCard';
import { DataTable } from '@saas/ui/tables/Table';
import { Badge } from '@saas/ui/badges/Badge';
import { Button } from '@saas/ui/buttons/Button';
import { useAppContext } from '../context/AppContext';

export default function MemberDetail() {
	const params = useParams();
	const emailParam = params?.id ? decodeURIComponent(params.id) : 'zainab.bibi@example.com';
	const { activeStore } = useAppContext() || {};

	const [member, setMember] = useState(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		const tenantId = activeStore?.id || 'default';
		fetch(`/api/points?tenantId=${tenantId}&email=${encodeURIComponent(emailParam)}`)
			.then((res) => res.json())
			.then((data) => {
				if (data?.member) {
					setMember(data.member);
				} else {
					setMember({
						customerEmail: emailParam,
						customerName: 'Zainab Bibi',
						pointsBalance: 1250,
						tierStatus: 'Gold',
						joinedAt: new Date(Date.now() - 30 * 86400000).toISOString(),
						transactions: [
							{
								id: 'tx_1',
								action: 'earn',
								points: 250,
								reason: 'Online Store Purchase #9421',
								timestamp: new Date(Date.now() - 2 * 86400000).toISOString(),
							},
							{
								id: 'tx_2',
								action: 'redeem',
								points: -100,
								reason: 'Redeemed $5 Off Voucher',
								couponCode: 'REWARD-SAVE5-891',
								timestamp: new Date(Date.now() - 10 * 86400000).toISOString(),
							},
							{
								id: 'tx_3',
								action: 'earn',
								points: 1000,
								reason: 'Account Welcome Bonus',
								timestamp: new Date(Date.now() - 30 * 86400000).toISOString(),
							},
						],
					});
				}
			})
			.catch(() => {})
			.finally(() => setLoading(false));
	}, [emailParam, activeStore]);

	const tier = member?.tierStatus || 'Bronze';
	const tierBadgeType = tier === 'Platinum' ? 'pro' : tier === 'Gold' ? 'warning' : 'active';

	return (
		<div className="space-y-6 max-w-5xl pb-12">
			<PageHeader
				title={member?.customerName || 'Loyalty Member Profile'}
				subtitle={`${member?.customerEmail || emailParam} • ${tier} VIP Tier`}
				actions={
					<Link href="/members">
						<Button variant="secondary" size="sm">
							<ArrowLeft size={13} />
							<span>Back to Members</span>
						</Button>
					</Link>
				}
			/>

			<div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
				<StatCard title="Points Available" value={`${(member?.pointsBalance || 0).toLocaleString()} pts`} trend="Spendable" />
				<StatCard title="VIP Status" value={tier} trend="Tier Level" />
				<StatCard
					title="Reward Vouchers Used"
					value={(member?.transactions?.filter((t) => t.action === 'redeem').length || 1).toString()}
					trend="Active Savings"
				/>
			</div>

			<Card title="Member Activity & Points Ledger">
				<DataTable
					columns={[
						{
							key: 'reason',
							label: 'Event / Reason',
							render: (v, r) => (
								<div>
									<div className="font-bold text-slate-900 text-xs">{v}</div>
									{r.couponCode && (
										<div className="font-mono text-[10px] text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded-md inline-block mt-0.5">
											Coupon: {r.couponCode}
										</div>
									)}
								</div>
							),
						},
						{
							key: 'action',
							label: 'Type',
							render: (v) => (
								<Badge type={v === 'redeem' ? 'danger' : 'active'}>
									{v === 'redeem' ? 'REDEMPTION' : 'POINTS EARNED'}
								</Badge>
							),
						},
						{
							key: 'points',
							label: 'Points Delta',
							render: (v) => (
								<strong className={`font-mono text-xs ${Number(v) >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
									{Number(v) >= 0 ? `+${v}` : v} pts
								</strong>
							),
						},
						{
							key: 'timestamp',
							label: 'Date',
							render: (v) => (
								<span className="text-[11px] text-slate-500">{v ? new Date(v).toLocaleString() : 'Recent'}</span>
							),
						},
					]}
					data={member?.transactions || []}
				/>
			</Card>
		</div>
	);
}
