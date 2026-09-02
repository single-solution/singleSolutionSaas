'use client';

import React from 'react';
import { AppLayout } from '@saas/ui/layout/AppLayout';
import { StoreWebsiteSelector } from '@saas/ui/layout/StoreWebsiteSelector';
import { useAppSecurity } from '@saas/ui/auth/AppAuthGuard';
import { useAppContext } from '../../src/context/AppContext';
import { Coins, LogOut, Zap, GitBranch, LayoutTemplate, PlayCircle, Settings } from 'lucide-react';

export default function AutomationDashboardLayout({ children }) {
	const { session, logoutApp, portalUrl } = useAppSecurity() || {};
	const {
		isAdmin,
		isMerchant,
		isStandalone,
		stores,
		activeStore,
		selectedStoreId,
		setSelectedStoreId,
		websites,
		activeWebsite,
		selectedWebsiteId,
		setSelectedWebsiteId,
		totalMonthlyCost,
	} = useAppContext() || {};

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
			footerLink={{ to: portalUrl || session?.portalUrl || '#', label: 'Master Portal' }}
			appName="Workflow Automation Engine"
			appSubtitle={activeWebsite?.name || session?.tenantName || 'Workspace'}
			navigation={navigation}
			headerLeft={
				<StoreWebsiteSelector
					merchants={stores}
					selectedMerchantId={selectedStoreId}
					onSelectMerchant={setSelectedStoreId}
					websites={websites}
					selectedWebsiteId={selectedWebsiteId}
					onSelectWebsite={setSelectedWebsiteId}
					isAdmin={isAdmin}
					isMerchant={isMerchant}
					isStandalone={isStandalone}
					merchantName={activeStore?.name}
					portalUrl={portalUrl}
				/>
			}
			headerRight={
				<div className="flex items-center gap-3">
					<div className="hidden sm:flex items-center gap-1.5 px-3 py-1 rounded-xl bg-amber-50 border border-amber-200 text-xs font-bold text-amber-900">
						<Coins size={13} className="text-amber-600" />
						<span>${totalMonthlyCost || 0}</span>
						<span className="text-[10px] text-amber-600 font-normal">/mo</span>
					</div>

					<div className="text-xs text-right hidden sm:block">
						<div className="font-bold text-slate-900">{activeStore?.name || session?.tenantName || 'SuperAdmin'}</div>
						<div className="text-[10px] text-slate-500 font-mono">
							{activeWebsite?.domain || activeStore?.domain || 'Platform Root'}
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
