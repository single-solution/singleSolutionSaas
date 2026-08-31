'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { usePortal } from '../context/PortalContext';
import {
	LayoutDashboard,
	Users,
	Grid,
	Coins,
	Clock,
	Settings,
	Shield,
	Store,
	Key,
	Sliders,
	ExternalLink,
	Zap,
} from 'lucide-react';

export default function PortalSidebar() {
	const pathname = usePathname() || '/';
	const { role, depositRequests = [] } = usePortal();

	const pendingDepositCount = (depositRequests || []).filter((r) => r.status === 'pending').length;

	const adminNav = [
		{
			section: 'Governance',
			items: [
				{ label: 'Control Overview', href: '/admin', icon: LayoutDashboard },
				{ label: 'Store Tenants', href: '/admin/tenants', icon: Users },
				{ label: 'App Registry', href: '/admin/registry', icon: Grid },
			],
		},
		{
			section: 'Finance & Audit',
			items: [
				{
					label: 'Billing Ledger',
					href: '/admin/billing',
					icon: Coins,
					badge: pendingDepositCount > 0 ? `${pendingDepositCount} Pending` : null,
				},
				{ label: 'Audit Logs', href: '/admin/audit', icon: Clock },
				{ label: 'Cluster Settings', href: '/admin/settings', icon: Settings },
			],
		},
	];

	const merchantNav = [
		{
			section: 'Store Workspace',
			items: [
				{ label: 'Merchant Console', href: '/merchant/home', icon: LayoutDashboard },
				{ label: 'App Licenses', href: '/merchant/licenses', icon: Sliders },
			],
		},
		{
			section: 'Finance & Security',
			items: [
				{ label: 'Wallet & Topups', href: '/merchant/billing', icon: Coins },
				{ label: 'API Credentials', href: '/merchant/credentials', icon: Key },
			],
		},
	];

	const navSections = role === 'admin' ? adminNav : merchantNav;

	return (
		<aside className="w-64 bg-white border-r border-slate-200/80 flex flex-col justify-between shrink-0 min-h-screen">
			<div className="p-4 space-y-6">
				{/* Brand Tile */}
				<div className="flex items-center gap-3 px-2 py-1">
					<div className="w-9 h-9 rounded-xl bg-indigo-600 text-white flex items-center justify-center font-bold text-sm shadow-md shadow-indigo-100">
						<Zap size={18} />
					</div>
					<div>
						<div className="font-extrabold text-sm text-slate-900 tracking-tight leading-none">SingleSolution</div>
						<div className="text-[10px] font-bold uppercase tracking-wider text-indigo-600 mt-0.5">
							{role === 'admin' ? 'SuperAdmin Portal' : 'Merchant Store Hub'}
						</div>
					</div>
				</div>

				{/* Navigation Links */}
				<nav className="space-y-5">
					{navSections.map((sec, idx) => (
						<div key={idx} className="space-y-1">
							<div className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400 px-3 mb-1.5">
								{sec.section}
							</div>
							{sec.items.map((item) => {
								const Icon = item.icon;
								const isActive =
									item.href === '/admin' || item.href === '/merchant/home'
										? pathname === item.href
										: pathname === item.href || pathname.startsWith(item.href + '/');

								return (
									<Link
										key={item.href}
										href={item.href}
										className={`flex items-center justify-between px-3 py-2 rounded-xl text-xs font-semibold transition-all ${
											isActive
												? 'bg-indigo-50 text-indigo-700 font-bold shadow-2xs'
												: 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
										}`}>
										<div className="flex items-center gap-2.5">
											<Icon size={15} className={isActive ? 'text-indigo-600' : 'text-slate-400'} />
											<span>{item.label}</span>
										</div>
										{item.badge && (
											<span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-amber-100 text-amber-700 border border-amber-200 animate-pulse">
												{item.badge}
											</span>
										)}
									</Link>
								);
							})}
						</div>
					))}
				</nav>
			</div>

			{/* Bottom Status / Links */}
			<div className="p-4 border-t border-slate-100 space-y-2 text-xs">
				<div className="p-3 rounded-xl bg-slate-50 border border-slate-200/60 flex items-center justify-between">
					<div>
						<div className="text-[11px] font-bold text-slate-900">Cluster Status</div>
						<div className="text-[10px] text-emerald-600 font-semibold flex items-center gap-1">
							<span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping" />
							<span>5/5 Micro-Apps Live</span>
						</div>
					</div>
					<Shield size={16} className="text-slate-400" />
				</div>
			</div>
		</aside>
	);
}
