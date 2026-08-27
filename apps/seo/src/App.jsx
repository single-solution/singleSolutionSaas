import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AppLayout } from '@saas/ui/layout/AppLayout';
import { AppAuthGuard, useAppSecurity, FeatureLockScreen } from '@saas/ui/auth/AppAuthGuard';
import { LayoutDashboard, Settings, FileText, Globe, Activity, Sparkles, LogOut } from 'lucide-react';

import Dashboard from './pages/Dashboard.jsx';
import PagesList from './pages/PagesList.jsx';
import PageDetail from './pages/PageDetail.jsx';
import AuditResults from './pages/AuditResults.jsx';
import Sitemap from './pages/Sitemap.jsx';
import SettingsPage from './pages/Settings.jsx';
import GuestLanding from './pages/GuestLanding.jsx';
import SeoSandbox from './pages/SeoSandbox.jsx';

function AuditsGuard() {
	const { hasFeature } = useAppSecurity() || {};
	if (!hasFeature('url_auditor')) {
		return (
			<FeatureLockScreen
				featureName="Live URL SEO Auditor"
				creditCost={25}
				desc="On-page crawler and core web vital forensics for store product pages."
			/>
		);
	}
	return <AuditResults />;
}

function SitemapGuard() {
	const { hasFeature } = useAppSecurity() || {};
	if (!hasFeature('xml_sitemap')) {
		return (
			<FeatureLockScreen
				featureName="Dynamic XML Sitemap Builder"
				creditCost={20}
				desc="Automated search engine indexing and dynamic XML sitemap generation."
			/>
		);
	}
	return <Sitemap />;
}

function SeoApp() {
	const { session, logoutApp, hasFeature, enabledFeatures = [] } = useAppSecurity() || {};

	const navigation = [
		{
			label: 'Merchant Console',
			items: [
				{ name: 'Dashboard', href: '/', icon: LayoutDashboard },
				{ name: 'Managed Pages', href: '/pages', icon: FileText },
				{
					name: 'Audit Reports',
					href: '/audits',
					icon: Activity,
					badge: hasFeature('url_auditor') ? 'Active' : 'Locked',
				},
				{
					name: 'XML Sitemap',
					href: '/sitemap',
					icon: Globe,
					badge: hasFeature('xml_sitemap') ? 'Active' : 'Locked',
				},
				{ name: 'Settings', href: '/settings', icon: Settings },
			],
		},
		{
			label: 'Sandbox & Public',
			items: [
				{ name: 'Live URL Auditor', href: '/sandbox', icon: Sparkles },
				{ name: 'Guest Overview', href: '/welcome', icon: Globe },
			],
		},
	];

	const activeCount = enabledFeatures.includes('*') ? 4 : enabledFeatures.length;

	return (
		<AppLayout
			appName="SEO Engine"
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
				<Route path="/sandbox" element={<SeoSandbox />} />
				<Route path="/pages" element={<PagesList />} />
				<Route path="/pages/:id" element={<PageDetail />} />
				<Route path="/audits" element={<AuditsGuard />} />
				<Route path="/sitemap" element={<SitemapGuard />} />
				<Route path="/settings" element={<SettingsPage />} />
			</Routes>
		</AppLayout>
	);
}

export default function App() {
	return (
		<BrowserRouter>
			<AppAuthGuard productId="seo" appName="SEO Engine">
				<SeoApp />
			</AppAuthGuard>
		</BrowserRouter>
	);
}
