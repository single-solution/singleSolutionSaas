import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AppLayout } from '@saas/ui/layout/AppLayout';
import { AppAuthGuard, useAppSecurity, FeatureLockScreen } from '@saas/ui/auth/AppAuthGuard';
import { Gift, LayoutDashboard, Settings, Star, Users, Sparkles, Globe, LogOut } from 'lucide-react';

import Dashboard from './pages/Dashboard.jsx';
import VipTiers from './pages/VipTiers.jsx';
import RewardsList from './pages/RewardsList.jsx';
import MembersList from './pages/MembersList.jsx';
import MemberDetail from './pages/MemberDetail.jsx';
import SettingsPage from './pages/Settings.jsx';
import GuestLanding from './pages/GuestLanding.jsx';
import LoyaltySandbox from './pages/LoyaltySandbox.jsx';

function TiersGuard() {
	const { hasFeature } = useAppSecurity() || {};
	if (!hasFeature('vip_tiers')) {
		return (
			<FeatureLockScreen
				featureName="Tiered VIP Multipliers"
				creditCost={30}
				desc="Bronze, Silver, Gold reward point rates with dynamic point multipliers on purchases."
			/>
		);
	}
	return <VipTiers />;
}

function RewardsGuard() {
	const { hasFeature } = useAppSecurity() || {};
	if (!hasFeature('voucher_store')) {
		return (
			<FeatureLockScreen
				featureName="Voucher Redemption Store"
				creditCost={30}
				desc="Exchange customer loyalty points for discount promo coupons and exclusive perks."
			/>
		);
	}
	return <RewardsList />;
}

function LoyaltyApp() {
	const { session, logoutApp, hasFeature, enabledFeatures = [] } = useAppSecurity() || {};

	const navigation = [
		{
			label: 'Merchant Console',
			items: [
				{ name: 'Dashboard', href: '/', icon: LayoutDashboard },
				{
					name: 'VIP Tiers',
					href: '/tiers',
					icon: Star,
					badge: hasFeature('vip_tiers') ? 'Active' : 'Locked',
				},
				{
					name: 'Rewards Store',
					href: '/rewards',
					icon: Gift,
					badge: hasFeature('voucher_store') ? 'Active' : 'Locked',
				},
				{ name: 'Members', href: '/members', icon: Users },
				{ name: 'Settings', href: '/settings', icon: Settings },
			],
		},
		{
			label: 'Sandbox & Public',
			items: [
				{ name: 'Points Simulator', href: '/sandbox', icon: Sparkles },
				{ name: 'Guest Overview', href: '/welcome', icon: Globe },
			],
		},
	];

	const activeCount = enabledFeatures.includes('*') ? 4 : enabledFeatures.length;

	return (
		<AppLayout
			appName="Loyalty & Rewards"
			appSubtitle={session?.tenantName || 'Workspace'}
			navigation={navigation}
			headerRight={
				session && (
					<div className="flex items-center gap-3">
						<div className="hidden sm:flex items-center gap-2 px-2.5 py-1 rounded-xl bg-indigo-50 border border-indigo-100 text-[11px] font-semibold text-indigo-900">
							<span>{activeCount} of 4 Modules Active</span>
						</div>
						<div className="text-xs text-right hidden sm:block">
							<div className="font-bold text-slate-900">{session.tenantName}</div>
							<div className="text-[10px] text-slate-500 font-mono">{session.domain}</div>
						</div>
						<button
							type="button"
							onClick={logoutApp}
							title="Lock Session"
							className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors cursor-pointer">
							<LogOut size={15} />
						</button>
					</div>
				)
			}>
			<Routes>
				<Route path="/" element={<Dashboard />} />
				<Route path="/welcome" element={<GuestLanding />} />
				<Route path="/sandbox" element={<LoyaltySandbox />} />
				<Route path="/tiers" element={<TiersGuard />} />
				<Route path="/rewards" element={<RewardsGuard />} />
				<Route path="/members" element={<MembersList />} />
				<Route path="/members/:id" element={<MemberDetail />} />
				<Route path="/settings" element={<SettingsPage />} />
			</Routes>
		</AppLayout>
	);
}

export default function App() {
	return (
		<BrowserRouter>
			<AppAuthGuard productId="loyalty" appName="Loyalty & Rewards">
				<LoyaltyApp />
			</AppAuthGuard>
		</BrowserRouter>
	);
}
