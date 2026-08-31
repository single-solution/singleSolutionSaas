'use client';

import React from 'react';
import { usePortal } from '../../../../context/PortalContext';
import { Users, Grid, Coins, Activity, ArrowUpRight } from 'lucide-react';

export default function AdminMetrics() {
	const { tenants = [], products = [], depositRequests = [] } = usePortal();

	const totalMerchants = tenants.length;
	const activeMerchants = tenants.filter((t) => t.status === 'active').length;
	const totalApps = products.length;
	const pendingDeposits = depositRequests.filter((r) => r.status === 'pending').length;
	const totalPlatformCredits = tenants.reduce((acc, t) => acc + (Number(t.creditsBalance) || 0), 0);

	const stats = [
		{
			title: 'Merchant Stores',
			value: totalMerchants,
			subValue: `${activeMerchants} Active`,
			icon: Users,
			color: 'text-indigo-600',
			bg: 'bg-indigo-50',
		},
		{
			title: 'Micro-Applications',
			value: totalApps,
			subValue: '100% Operational',
			icon: Grid,
			color: 'text-purple-600',
			bg: 'bg-purple-50',
		},
		{
			title: 'Platform Float Balance',
			value: `$${totalPlatformCredits.toLocaleString()}`,
			subValue: `${pendingDeposits} Pending Topups`,
			icon: Coins,
			color: 'text-amber-600',
			bg: 'bg-amber-50',
		},
		{
			title: 'Cluster Health',
			value: '99.98%',
			subValue: 'Latency 18ms',
			icon: Activity,
			color: 'text-emerald-600',
			bg: 'bg-emerald-50',
		},
	];

	return (
		<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
			{stats.map((stat, i) => {
				const Icon = stat.icon;
				return (
					<div
						key={i}
						className="p-5 rounded-2xl bg-white border border-slate-200/80 shadow-xs space-y-3 transition-all hover:shadow-md hover:border-slate-300">
						<div className="flex items-center justify-between">
							<span className="text-xs font-bold text-slate-500 uppercase tracking-wider">{stat.title}</span>
							<div className={`w-8 h-8 rounded-xl ${stat.bg} ${stat.color} flex items-center justify-center`}>
								<Icon size={16} />
							</div>
						</div>
						<div>
							<div className="text-2xl font-extrabold text-slate-900 tracking-tight">{stat.value}</div>
							<div className="text-[11px] font-semibold text-slate-400 mt-0.5 flex items-center gap-1">
								<ArrowUpRight size={12} className="text-emerald-500" />
								<span>{stat.subValue}</span>
							</div>
						</div>
					</div>
				);
			})}
		</div>
	);
}
