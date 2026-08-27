import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AppLayout } from '@saas/ui/layout/AppLayout';
import { AppAuthGuard, useAppSecurity, FeatureLockScreen } from '@saas/ui/auth/AppAuthGuard';
import { StorefrontProvider, useStorefront } from './context/StorefrontContext';
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
	ChevronDown,
	Building2,
} from 'lucide-react';

import Dashboard from './pages/Dashboard.jsx';
import Funnel from './pages/Funnel.jsx';
import EventsList from './pages/EventsList.jsx';
import SpeedInsights from './pages/SpeedInsights.jsx';
import SearchAnalytics from './pages/SearchAnalytics.jsx';
import Reports from './pages/Reports.jsx';
import SettingsPage from './pages/Settings.jsx';
import GuestLanding from './pages/GuestLanding.jsx';
import AnalyticsSandbox from './pages/AnalyticsSandbox.jsx';
import DirectApiConnect from './pages/DirectApiConnect.jsx';
import MetaCapiIntegration from './pages/MetaCapiIntegration.jsx';
import Ga4Integration from './pages/Ga4Integration.jsx';
import WebhooksIntegration from './pages/WebhooksIntegration.jsx';

function AnalyticsAppInner() {
	const { session, logoutApp } = useAppSecurity() || {};
	const { isAdmin, stores, activeStore, selectedStoreId, setSelectedStoreId, hasStoreFeature } = useStorefront();

	const navigation = [
		{
			label: 'Storefront Telemetry',
			items: [
				{ name: 'Dashboard', href: '/', icon: LayoutDashboard },
				{
					name: 'Live Shoppers',
					href: '/events',
					icon: Activity,
					badge: hasStoreFeature('realtime_telemetry') ? 'Active' : 'Locked',
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
					badge: hasStoreFeature('speed_vitals') ? 'Active' : 'Locked',
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
					badge: hasStoreFeature('ga4_measurement') ? 'Active' : 'Locked',
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
					badge: hasStoreFeature('search_forensics') ? 'Active' : 'Locked',
				},
				{
					name: 'Cohort Retention',
					href: '/reports',
					icon: BarChart3,
					badge: hasStoreFeature('cohort_reports') ? 'Active' : 'Locked',
				},
			],
		},
		{
			label: 'Developer & Connect',
			items: [
				{ name: 'Direct API & SDK', href: '/connect', icon: Code },
				{ name: 'Event Simulator', href: '/sandbox', icon: Sparkles },
				{ name: 'Settings', href: '/settings', icon: Settings },
			],
		},
	];

	// Count active features for this store
	const activeFeaturesCount = activeStore
		? activeStore.subscriptions?.includes('*')
			? 8
			: (activeStore.subscriptions || []).length
		: 0;

	return (
		<AppLayout
			appName="Analytics Pro"
			appSubtitle={activeStore?.name || (isAdmin ? 'Admin Console' : 'Storefront')}
			navigation={navigation}
			headerRight={
				<div className="flex items-center gap-3">
					{/* SuperAdmin Multi-Store Switcher */}
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

					{/* Active Modules Badge */}
					<div className="hidden sm:flex items-center gap-2 px-2.5 py-1 rounded-xl bg-indigo-50 border border-indigo-100 text-[11px] font-semibold text-indigo-900">
						<span>{activeFeaturesCount} of 8 Modules Active</span>
					</div>

					{/* Store / User Info */}
					<div className="text-xs text-right hidden sm:block">
						<div className="font-bold text-slate-900">{activeStore?.name || session?.tenantName || 'SuperAdmin'}</div>
						<div className="text-[10px] text-slate-500 font-mono">
							{activeStore?.domain || session?.domain || 'Platform Root'}
						</div>
					</div>

					<button
						type="button"
						onClick={logoutApp}
						title="Lock Session"
						className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors cursor-pointer">
						<LogOut size={15} />
					</button>
				</div>
			}>
			<Routes>
				<Route path="/" element={<Dashboard />} />
				<Route path="/welcome" element={<GuestLanding />} />
				<Route path="/sandbox" element={<AnalyticsSandbox />} />
				<Route path="/connect" element={<DirectApiConnect />} />
				<Route path="/funnel" element={<Funnel />} />
				<Route path="/events" element={<EventsList />} />
				<Route path="/speed" element={<SpeedInsights />} />
				<Route path="/integrations/meta" element={<MetaCapiIntegration />} />
				<Route path="/integrations/ga4" element={<Ga4Integration />} />
				<Route path="/integrations/webhooks" element={<WebhooksIntegration />} />
				<Route path="/search-analytics" element={<SearchAnalytics />} />
				<Route path="/reports" element={<Reports />} />
				<Route path="/settings" element={<SettingsPage />} />
			</Routes>
		</AppLayout>
	);
}

export default function App() {
	return (
		<BrowserRouter>
			<AppAuthGuard productId="analytics" appName="Analytics Pro">
				<StorefrontProvider>
					<AnalyticsAppInner />
				</StorefrontProvider>
			</AppAuthGuard>
		</BrowserRouter>
	);
}
