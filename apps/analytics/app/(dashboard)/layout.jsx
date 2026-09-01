'use client';

import React from 'react';
import { AppLayout } from '@saas/ui/layout/AppLayout';
import { useAppSecurity } from '@saas/ui/auth/AppAuthGuard';
import { useStorefront } from '../../src/context/StorefrontContext';
import {
	BarChart3,
	LayoutDashboard,
	Settings,
	Filter,
	Activity,
	Sparkles,
	Globe,
	LogOut,
	Gauge,
	Search,
	Share2,
	Radio,
	Code,
	Building2,
	Layers,
	Coins,
} from 'lucide-react';

export default function DashboardLayout({ children }) {
	const { session, logoutApp, portalUrl } = useAppSecurity() || {};
	const {
		isAdmin,
		stores,
		activeStore,
		selectedStoreId,
		setSelectedStoreId,
		hasStoreFeature,
		totalMonthlyCost,
		enabledFeatures,
	} = useStorefront();

	const navigation = [
		{
			label: 'Storefront Telemetry',
			items: [
				{ name: 'Dashboard', href: '/', icon: LayoutDashboard },
				{
					name: 'Live Shoppers',
					href: '/events',
					icon: Activity,
					badge: hasStoreFeature('core_traffic') ? 'Active' : 'Locked',
				},
				{
					name: 'Funnel Drops',
					href: '/funnel',
					icon: Filter,
					badge: hasStoreFeature('funnel_dropoff') ? 'Active' : 'Locked',
				},
				{
					name: 'Speed Vitals',
					href: '/speed',
					icon: Gauge,
					badge: hasStoreFeature('speed_insights') ? 'Active' : 'Locked',
				},
			],
		},
		{
			label: 'Marketing & Integrations',
			items: [
				{
					name: 'Meta Pixel & CAPI',
					href: '/integrations/meta',
					icon: Share2,
					badge: hasStoreFeature('meta_capi') ? 'Active' : 'Locked',
				},
				{
					name: 'Google Analytics 4',
					href: '/integrations/ga4',
					icon: Globe,
					badge: hasStoreFeature('ga4_sync') ? 'Active' : 'Locked',
				},
				{
					name: 'Outbound Webhooks',
					href: '/integrations/webhooks',
					icon: Radio,
					badge: hasStoreFeature('custom_webhooks') ? 'Active' : 'Locked',
				},
			],
		},
		{
			label: 'Shopper Intelligence',
			items: [
				{
					name: 'Search Intent',
					href: '/search-analytics',
					icon: Search,
					badge: hasStoreFeature('search_analytics') ? 'Active' : 'Locked',
				},
				{
					name: 'Reports & Export',
					href: '/reports',
					icon: BarChart3,
				},
			],
		},
		{
			label: 'Governance & Settings',
			items: [
				{ name: 'Module Manager', href: '/modules', icon: Layers, badge: `${enabledFeatures.length} Active` },
				{ name: 'Direct API & SDK', href: '/connect', icon: Code },

				{ name: 'Settings', href: '/settings', icon: Settings },
			],
		},
	];

	return (
		<AppLayout
			footerLink={{ to: portalUrl || session?.portalUrl || '#', label: 'Master Portal' }}
			appName="Analytics Pro"
			appSubtitle={activeStore?.name || (isAdmin ? 'Admin Console' : 'Storefront')}
			navigation={navigation}
			headerRight={
				<div className="flex items-center gap-3">
					{isAdmin && (
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

					{/* Monthly Credit Cost Pill */}
					<div className="hidden sm:flex items-center gap-1.5 px-3 py-1 rounded-xl bg-amber-50 border border-amber-200 text-xs font-bold text-amber-900">
						<Coins size={13} className="text-amber-600" />
						<span>${totalMonthlyCost}</span>
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
