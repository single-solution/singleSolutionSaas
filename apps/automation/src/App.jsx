import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AppLayout } from '@saas/ui/layout/AppLayout';
import { AppAuthGuard, useAppSecurity, FeatureLockScreen } from '@saas/ui/auth/AppAuthGuard';
import { LayoutDashboard, Settings, GitBranch, History, Copy, Sparkles, Globe, LogOut } from 'lucide-react';

import Dashboard from './pages/Dashboard.jsx';
import WorkflowsList from './pages/WorkflowsList.jsx';
import WorkflowBuilder from './pages/WorkflowBuilder.jsx';
import Templates from './pages/Templates.jsx';
import RunHistory from './pages/RunHistory.jsx';
import SettingsPage from './pages/Settings.jsx';
import GuestLanding from './pages/GuestLanding.jsx';
import AutomationSandbox from './pages/AutomationSandbox.jsx';

function MultiStepBuilderGuard() {
	const { hasFeature } = useAppSecurity() || {};
	if (!hasFeature('multi_step')) {
		return (
			<FeatureLockScreen
				featureName="Multi-Step Action Pipelines"
				creditCost={40}
				desc="Visual multi-step automation builder chaining webhooks, WhatsApp alerts, and inventory sync."
			/>
		);
	}
	return <WorkflowBuilder />;
}

function AutomationApp() {
	const { session, logoutApp, hasFeature, enabledFeatures = [] } = useAppSecurity() || {};

	const navigation = [
		{
			label: 'Merchant Console',
			items: [
				{ name: 'Dashboard', href: '/', icon: LayoutDashboard },
				{ name: 'Workflows', href: '/workflows', icon: GitBranch },
				{
					name: 'Pipeline Builder',
					href: '/workflows/new',
					icon: Sparkles,
					badge: hasFeature('multi_step') ? 'Active' : 'Locked',
				},
				{ name: 'Templates', href: '/templates', icon: Copy },
				{ name: 'Run Logs', href: '/history', icon: History },
				{ name: 'Settings', href: '/settings', icon: Settings },
			],
		},
		{
			label: 'Sandbox & Public',
			items: [
				{ name: 'Trigger Simulator', href: '/sandbox', icon: Sparkles },
				{ name: 'Guest Overview', href: '/welcome', icon: Globe },
			],
		},
	];

	const activeCount = enabledFeatures.includes('*') ? 4 : enabledFeatures.length;

	return (
		<AppLayout
			appName="Workflow Automator"
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
				<Route path="/sandbox" element={<AutomationSandbox />} />
				<Route path="/workflows" element={<WorkflowsList />} />
				<Route path="/workflows/new" element={<MultiStepBuilderGuard />} />
				<Route path="/workflows/:id" element={<MultiStepBuilderGuard />} />
				<Route path="/templates" element={<Templates />} />
				<Route path="/history" element={<RunHistory />} />
				<Route path="/settings" element={<SettingsPage />} />
			</Routes>
		</AppLayout>
	);
}

export default function App() {
	return (
		<BrowserRouter>
			<AppAuthGuard productId="automation" appName="Workflow Automator">
				<AutomationApp />
			</AppAuthGuard>
		</BrowserRouter>
	);
}
