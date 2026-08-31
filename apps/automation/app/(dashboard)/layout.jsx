'use client';

import React from 'react';
import { AppLayout } from '@saas/ui/layout/AppLayout';
import { useAppSecurity } from '@saas/ui/auth/AppAuthGuard';
import { useAppContext } from '../../src/context/AppContext';
import { Building2, Coins, LogOut, Zap, GitBranch, LayoutTemplate, PlayCircle, Settings, Sparkles } from 'lucide-react';

export default function AutomationDashboardLayout({ children }) {
	const { session, logoutApp } = useAppSecurity() || {};
	const { isAdmin, stores, activeStore, selectedStoreId, setSelectedStoreId, totalMonthlyCost, enabledFeatures } = useAppContext() || {};

	const navigation = [
		{
			label: 'Pipeline Management',
			items: [
				{ name: 'Workflows', href: '/', icon: Zap },
				{ name: 'Flow Builder', href: '/builder', icon: GitBranch },
				{ name: 'Templates', href: '/templates', icon: LayoutTemplate },
				{ name: 'Execution Logs', href: '/executions', icon: PlayCircle },
				
				{ name: 'Settings', href: '/settings', icon: Settings },
			],
		},
	];

	return (
		<AppLayout
			appName="Workflow Automation Engine"
			appSubtitle={session?.tenantName || 'Workspace'}
			navigation={navigation}
			headerRight={
				<div className="flex items-center gap-3">
					{isAdmin && stores && (
						<div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-100 border border-slate-200 text-xs">
							<Building2 size={13} className="text-indigo-600" />
							<span className="text-slate-500 font-bold hidden sm:inline">Store:</span>
							{stores.length > 0 ? (
								<select
									value={selectedStoreId}
									onChange={(e) => setSelectedStoreId(e.target.value)}
									className="bg-transparent font-bold text-slate-900 focus:outline-none cursor-pointer">
									{stores.map((s) => (
										<option key={s.id} value={s.id}>
											{s.name} ({s.domain})
										</option>
									))}
								</select>
							) : (
								<span className="font-semibold text-slate-400">No Stores Registered</span>
							)}
						</div>
					)}

					<div className="hidden sm:flex items-center gap-1.5 px-3 py-1 rounded-xl bg-amber-50 border border-amber-200 text-xs font-bold text-amber-900">
						<Coins size={13} className="text-amber-600" />
						<span>${totalMonthlyCost || 0}</span>
						<span className="text-[10px] text-amber-600 font-normal">/mo</span>
					</div>

					<div className="text-xs text-right hidden sm:block">
						<div className="font-bold text-slate-900">{activeStore?.name || session?.tenantName || 'SuperAdmin'}</div>
						<div className="text-[10px] text-slate-500 font-mono">
							{activeStore?.domain || session?.domain || 'Platform Root'}
						</div>
					</div>

					<button
						type="button"
						onClick={logoutApp}
						title="Sign Out / Back to Portal"
						className="p-2 rounded-xl bg-slate-100 hover:bg-rose-50 text-slate-500 hover:text-rose-600 transition-colors cursor-pointer">
						<LogOut size={16} />
					</button>
				</div>
			}>
			{children}
		</AppLayout>
	);
}
