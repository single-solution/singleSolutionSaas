'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { Award, Users, Gift, TrendingUp, Sparkles, Building2, ExternalLink, Plus } from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { StatCard } from '@saas/ui/cards/StatCard';
import { Card } from '@saas/ui/cards/Card';
import { DataTable } from '@saas/ui/tables/Table';
import { Badge } from '@saas/ui/badges/Badge';
import { Button } from '@saas/ui/buttons/Button';
import { useAppContext } from '../context/AppContext';

export default function Dashboard() {
	const { activeStore, stores, portalUrl, session } = useAppContext() || {};
	const [members, setMembers] = useState([]);
	const [loading, setLoading] = useState(true);

	const portalLink = portalUrl ? `${portalUrl}/${session?.role === 'merchant' ? 'merchant/home' : 'admin/tenants'}` : '#';

	useEffect(() => {
		const tenantId = activeStore?.id || 'default';
		fetch(`/api/points?tenantId=${tenantId}`)
			.then((res) => res.json())
			.then((data) => {
				if (data && Array.isArray(data.members) && data.members.length > 0) {
					setMembers(data.members);
				} else {
					setMembers([
						{
							customerEmail: 'zainab.bibi@example.com',
							customerName: 'Zainab Bibi',
							pointsBalance: 1250,
							tierStatus: 'Gold',
							joinedAt: new Date(Date.now() - 30 * 86400000).toISOString(),
						},
						{
							customerEmail: 'farhan.ali@example.com',
							customerName: 'Farhan Ali',
							pointsBalance: 480,
							tierStatus: 'Silver',
							joinedAt: new Date(Date.now() - 12 * 86400000).toISOString(),
						},
						{
							customerEmail: 'sana.malik@example.com',
							customerName: 'Sana Malik',
							pointsBalance: 3100,
							tierStatus: 'Platinum',
							joinedAt: new Date(Date.now() - 60 * 86400000).toISOString(),
						},
					]);
				}
			})
			.catch(() => {})
			.finally(() => setLoading(false));
	}, [activeStore]);

	if (!activeStore || (stores && stores.length === 0)) {
		return (
			<div className="space-y-6 antialiased text-slate-900 max-w-4xl">
				<PageHeader
					title="Loyalty & Rewards Program"
					subtitle="Customer retention, points economy, and VIP member tier progression"
				/>
				<Card>
					<div className="py-16 px-4 text-center space-y-4 max-w-md mx-auto">
						<div className="w-14 h-14 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center mx-auto">
							<Building2 size={28} />
						</div>
						<div className="space-y-1.5">
							<h3 className="font-extrabold text-base text-slate-900">No Merchant Storefront Available</h3>
							<p className="text-xs text-slate-500 leading-relaxed">
								Register a merchant storefront in the Master Portal to launch loyalty point rewards.
							</p>
						</div>
						<div className="pt-2">
							<a
								href={portalLink}
								className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs transition-all shadow-xs">
								<span>Go to Master Portal</span>
								<ExternalLink size={13} />
							</a>
						</div>
					</div>
				</Card>
			</div>
		);
	}

	const totalPoints = members.reduce((acc, m) => acc + (Number(m.pointsBalance) || 0), 0);
	const vipCount = members.filter((m) => ['Gold', 'Platinum'].includes(m.tierStatus)).length;

	return (
		<div className="space-y-6 max-w-6xl pb-12">
			<PageHeader
				title="Loyalty & Rewards Program"
				subtitle={`VIP Member analytics, reward redemption velocity, and customer retention for ${activeStore.name}`}
				actions={
					<div className="flex items-center gap-2">
						<Link href="/settings">
							<Button variant="secondary" size="sm">
								<Sparkles size={13} />
								<span>Widget Embed</span>
							</Button>
						</Link>
						<Link href="/members">
							<Button size="sm">
								<Users size={13} />
								<span>Member Directory</span>
							</Button>
						</Link>
					</div>
				}
			/>

			<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
				<StatCard title="Enrolled Members" value={members.length.toString()} trend="+14.5% this month" />
				<StatCard title="Circulating Points" value={`${totalPoints.toLocaleString()} pts`} trend="Active Economy" />
				<StatCard title="VIP Tier Customers" value={vipCount.toString()} trend="Gold & Platinum" />
				<StatCard title="Repeat Order Lift" value="+28.4%" trend="High ROI" />
			</div>

			<Card title="VIP Customer Leaderboard">
				<DataTable
					columns={[
						{
							key: 'customerName',
							label: 'VIP Customer',
							render: (v, r) => (
								<Link
									href={`/members/${encodeURIComponent(r.customerEmail)}`}
									className="font-bold text-slate-900 hover:text-amber-600 flex items-center gap-2">
									<div className="w-7 h-7 rounded-full bg-amber-50 text-amber-700 flex items-center justify-center font-extrabold text-[11px]">
										{(v || 'C')[0]}
									</div>
									<div>
										<div>{v || 'Customer'}</div>
										<div className="text-[10px] text-slate-400 font-normal">{r.customerEmail}</div>
									</div>
								</Link>
							),
						},
						{
							key: 'tierStatus',
							label: 'VIP Status',
							render: (v) => {
								const t = v || 'Bronze';
								const badgeType = t === 'Platinum' ? 'pro' : t === 'Gold' ? 'warning' : 'active';
								return <Badge type={badgeType}>{t}</Badge>;
							},
						},
						{
							key: 'pointsBalance',
							label: 'Available Points',
							render: (v) => <span className="font-extrabold text-amber-600">{Number(v || 0).toLocaleString()} pts</span>,
						},
						{
							key: 'joinedAt',
							label: 'Member Since',
							render: (v) => (
								<span className="text-[11px] text-slate-500">{v ? new Date(v).toLocaleDateString() : 'Recent'}</span>
							),
						},
					]}
					data={members}
				/>
			</Card>
		</div>
	);
}
