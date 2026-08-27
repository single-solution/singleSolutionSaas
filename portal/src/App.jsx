import React, { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import {
	LayoutDashboard,
	Users,
	Grid,
	CreditCard,
	Settings,
	Shield,
	Store,
	Key,
	Search,
	LogOut,
	CheckCircle2,
} from 'lucide-react';
import { AppLayout } from '@saas/ui/layout/AppLayout';

import { PortalProvider, usePortal } from './context/PortalContext';
import GlobalSearchModal from './components/GlobalSearchModal';

// Auth Pages
import AdminSetupPage from './pages/auth/AdminSetupPage';
import LoginPage from './pages/auth/LoginPage';

// Admin Pages
import AdminDashboard from './pages/admin/AdminDashboard';
import TenantsManager from './pages/admin/TenantsManager';
import AppRegistry from './pages/admin/AppRegistry';
import BillingLedger from './pages/admin/BillingLedger';
import AuditLogs from './pages/admin/AuditLogs';
import SettingsPage from './pages/admin/SettingsPage';

// Merchant Pages
import MerchantHome from './pages/merchant/MerchantHome';
import MerchantLicenses from './pages/merchant/MerchantLicenses';
import Credentials from './pages/merchant/Credentials';
import MerchantBilling from './pages/merchant/MerchantBilling';

// Public Landing Page
import LandingPage from './LandingPage';

function PortalShell() {
	const { hasAdmin, isAuthenticated, currentUser, role, activeTenant, logout, toast } = usePortal();

	const [isSettingUp, setIsSettingUp] = useState(!hasAdmin);
	const [isSearchOpen, setIsSearchOpen] = useState(false);

	// Global Keyboard Shortcut (⌘K / Ctrl+K)
	useEffect(() => {
		const handleKeyDown = (e) => {
			if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
				e.preventDefault();
				setIsSearchOpen((prev) => !prev);
			}
		};
		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, []);

	// First time setup guard
	if (!hasAdmin || isSettingUp) {
		return <AdminSetupPage onComplete={() => setIsSettingUp(false)} />;
	}

	// Unauthenticated guard
	if (!isAuthenticated) {
		return <LoginPage onSwitchToSetup={() => setIsSettingUp(true)} />;
	}

	const adminNav = [
		{ to: '/', label: 'Dashboard', icon: LayoutDashboard },
		{ to: '/tenants', label: 'Merchants', icon: Users },
		{ to: '/registry', label: 'Products', icon: Grid },
		{ to: '/billing', label: 'Subscriptions', icon: CreditCard },
		{ to: '/audit-logs', label: 'Audit Logs', icon: Shield },
		{ to: '/settings', label: 'Settings', icon: Settings },
	];

	const merchantNav = [
		{ to: '/merchant', label: 'Overview', icon: Store },
		{ to: '/merchant/licenses', label: 'Products', icon: Grid },
		{ to: '/merchant/credentials', label: 'API Keys', icon: Key },
		{ to: '/merchant/billing', label: 'Billing', icon: CreditCard },
	];

	const headerLeft = (
		<div className="flex items-center gap-3">
			{/* Interactive Search Bar */}
			<button
				type="button"
				onClick={() => setIsSearchOpen(true)}
				className="flex items-center gap-2 px-3.5 py-1.5 rounded-xl bg-slate-50 hover:bg-slate-100/90 border border-slate-200/80 hover:border-slate-300 text-xs text-slate-500 min-w-[240px] text-left transition-all duration-150 cursor-pointer shadow-2xs hover:shadow-xs">
				<Search size={13} className="text-slate-400" />
				<span>Search platform...</span>
				<kbd className="ml-auto px-1.5 py-0.5 text-[9px] font-mono bg-white border border-slate-200 rounded text-slate-400 shadow-2xs">
					⌘K
				</kbd>
			</button>

			{role === 'merchant' && activeTenant && (
				<div className="hidden sm:flex items-center gap-2 px-3 py-1 rounded-xl bg-indigo-50/70 border border-indigo-100 text-xs text-indigo-800 font-medium transition-all duration-150">
					<Store size={13} className="text-indigo-600" />
					<span>{activeTenant.name}</span>
					<span className="text-indigo-500/80 font-mono text-[11px]">({activeTenant.domain})</span>
				</div>
			)}
		</div>
	);

	const headerRight = (
		<div className="flex items-center gap-3">
			{/* Status Badge */}
			<div className="hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-50 border border-emerald-200 text-xs font-semibold text-emerald-800 transition-all duration-150">
				<span className="w-2 h-2 rounded-full bg-emerald-500" />
				<span>{role === 'admin' ? 'Platform Operational' : 'Store Active'}</span>
			</div>

			{/* User Profile Block & Sign Out */}
			<div className="flex items-center gap-2.5 pl-3 border-l border-slate-200">
				<div className="w-8 h-8 rounded-xl bg-indigo-600 text-white flex items-center justify-center text-xs font-bold shadow-xs transition-transform duration-150 hover:scale-105">
					{currentUser?.name ? currentUser.name.charAt(0).toUpperCase() : 'A'}
				</div>
				<div className="hidden sm:block text-left text-xs leading-tight">
					<div className="font-bold text-slate-900 truncate max-w-[130px]">{currentUser?.name || 'Account'}</div>
					<div className="text-[10px] text-slate-500 capitalize">{role === 'admin' ? 'SuperAdmin' : 'Merchant Store'}</div>
				</div>
				<button
					type="button"
					onClick={logout}
					title="Sign Out"
					className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-all duration-150 cursor-pointer ml-1 active:scale-95">
					<LogOut size={15} />
				</button>
			</div>
		</div>
	);

	return (
		<>
			{/* Global Command Palette Search Modal */}
			<GlobalSearchModal isOpen={isSearchOpen} onClose={() => setIsSearchOpen(false)} />

			{/* Global Toast Alert */}
			{toast && (
				<div className="fixed bottom-6 right-6 z-50 transition-all duration-200">
					<div
						className={`px-4 py-3 rounded-2xl shadow-xl border text-xs font-semibold flex items-center gap-2.5 transition-all duration-200 ${
							toast.type === 'danger'
								? 'bg-rose-900 text-white border-rose-800'
								: toast.type === 'warning'
									? 'bg-amber-900 text-white border-amber-800'
									: 'bg-slate-900 text-white border-slate-800'
						}`}>
						<CheckCircle2 size={15} className="text-emerald-400" />
						<span>{toast.message}</span>
					</div>
				</div>
			)}

			<AppLayout
				appName="SingleSolution SaaS"
				appSubtitle={role === 'admin' ? 'Admin Portal' : activeTenant?.name || 'Merchant Portal'}
				navigation={role === 'admin' ? adminNav : merchantNav}
				headerLeft={headerLeft}
				headerRight={headerRight}
				footerMiddle={<span>All Services Operational • TLS 1.3 Encrypted</span>}
				footerText="Platform v3.2.0"
				footerLink={{ to: '/landing', label: 'Product Showcase' }}>
				<Routes>
					{/* Admin Routes */}
					<Route path="/" element={<AdminDashboard />} />
					<Route path="/tenants" element={<TenantsManager />} />
					<Route path="/registry" element={<AppRegistry />} />
					<Route path="/billing" element={<BillingLedger />} />
					<Route path="/audit-logs" element={<AuditLogs />} />
					<Route path="/settings" element={<SettingsPage />} />

					{/* Merchant Routes */}
					<Route path="/merchant" element={<MerchantHome />} />
					<Route path="/merchant/licenses" element={<MerchantLicenses />} />
					<Route path="/merchant/credentials" element={<Credentials />} />
					<Route path="/merchant/billing" element={<MerchantBilling />} />

					{/* Public Suite Route */}
					<Route path="/landing" element={<LandingPage />} />
				</Routes>
			</AppLayout>
		</>
	);
}

export default function App() {
	return (
		<BrowserRouter>
			<PortalProvider>
				<PortalShell />
			</PortalProvider>
		</BrowserRouter>
	);
}
