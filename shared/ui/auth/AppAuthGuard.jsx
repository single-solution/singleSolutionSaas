'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';
import { verifySSOToken } from './ssoHandshake';

const AppSecurityContext = createContext(null);

export function useAppSecurity() {
	return useContext(AppSecurityContext);
}

function LockIcon({ size = 24, className = '' }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}>
			<rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
			<path d="M7 11V7a5 5 0 0 1 10 0v4" />
		</svg>
	);
}

function ShieldAlertIcon({ size = 14, className = '' }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}>
			<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
			<path d="M12 8v4" />
			<path d="M12 16h.01" />
		</svg>
	);
}

function ExternalLinkIcon({ size = 14, className = '' }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}>
			<path d="M15 3h6v6" />
			<path d="M10 14 21 3" />
			<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
		</svg>
	);
}

function CheckCircleIcon({ size = 14, className = '' }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}>
			<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
			<polyline points="22 4 12 14.01 9 11.01" />
		</svg>
	);
}

export function FeatureLockScreen({
	featureName = 'Advanced Module',
	creditCost = 30,
	desc = 'This feature is currently disabled for your merchant account.',
	portalUrl = 'http://localhost:3000/merchant/licenses',
	onActivate,
}) {
	const [isActivating, setIsActivating] = useState(false);

	const handleActivate = async () => {
		if (onActivate) {
			setIsActivating(true);
			try {
				await onActivate();
			} finally {
				setIsActivating(false);
			}
		}
	};

	return (
		<div className="p-8 rounded-3xl bg-white border border-slate-200 shadow-xs max-w-lg mx-auto text-center space-y-5 my-8">
			<div className="w-12 h-12 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center mx-auto shadow-2xs">
				<LockIcon size={24} />
			</div>
			<div className="space-y-1.5">
				<div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-slate-100 border border-slate-200 text-[11px] font-semibold text-slate-700">
					<span>Optional Module</span>
				</div>
				<h3 className="text-lg font-bold text-slate-900">{featureName} is Locked</h3>
				<p className="text-xs text-slate-500 max-w-sm mx-auto leading-relaxed">{desc}</p>
			</div>
			<div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/80 text-xs flex justify-between items-center text-left">
				<div>
					<div className="font-semibold text-slate-900">Pay-Per-Hour Rate (AWS Model)</div>
					<div className="text-[11px] text-slate-500">Metered per hour active · Cancel anytime</div>
				</div>
				<div className="text-right">
					<span className="font-bold text-sm text-indigo-600">${(Number(creditCost) / 720).toFixed(4)}/hr</span>
					<span className="text-[10px] text-slate-400 block font-mono">~${creditCost}/mo full float</span>
				</div>
			</div>
			<div className="space-y-2">
				{onActivate && (
					<button
						type="button"
						onClick={handleActivate}
						disabled={isActivating}
						className="w-full py-2.5 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white font-bold text-xs transition-all shadow-xs hover:shadow-md flex items-center justify-center gap-2 cursor-pointer active:scale-98 disabled:opacity-50">
						<span>{isActivating ? 'Activating Module...' : `Activate ($${(Number(creditCost) / 720).toFixed(4)}/hr)`}</span>
					</button>
				)}
				<a
					href={portalUrl}
					target="_blank"
					rel="noopener noreferrer"
					className="w-full py-2 px-4 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs transition-all flex items-center justify-center gap-2 cursor-pointer">
					<span>Manage in Master Portal</span>
					<ExternalLinkIcon size={13} />
				</a>
			</div>
		</div>
	);
}

export function AppAuthGuard({ productId, appName = 'Micro-App', portalUrl: propPortalUrl, children }) {
	const sessionKey = `saas_app_session_${productId || 'default'}`;
	const [mounted, setMounted] = useState(false);

	const [dynamicPortalUrl, setDynamicPortalUrl] = useState(() => {
		if (typeof window !== 'undefined') {
			try {
				const params = new URLSearchParams(window.location.search);
				const fromUrl = params.get('portal_url');
				if (fromUrl) return fromUrl;
				if (document.referrer) return new URL(document.referrer).origin;
			} catch {}
		}
		return propPortalUrl || (typeof process !== 'undefined' && process.env?.PORTAL_URL) || '#';
	});

	const [session, setSession] = useState(null);
	const [error, setError] = useState('');

	useEffect(() => {
		setMounted(true);
		try {
			// 1. Check direct sessionStorage
			const saved = sessionStorage.getItem(sessionKey);
			if (saved) {
				const parsed = JSON.parse(saved);
				if (parsed.portalUrl) setDynamicPortalUrl(parsed.portalUrl);
				setSession(parsed);
				return;
			}

			// 2. Auto-detect shared portal login session
			const currentPortalUser = localStorage.getItem('saas_current_user');
			if (currentPortalUser) {
				const user = JSON.parse(currentPortalUser);
				let enabledFeatures = ['*'];
				if (user.role === 'merchant' && user.subscriptions && user.subscriptions[productId]) {
					enabledFeatures = user.subscriptions[productId];
				}

				setSession({
					tenantId: user.id || 'usr_authed',
					tenantName: user.name || user.orgName || 'Authenticated User',
					domain: user.domain || 'platform.local',
					role: user.role || 'merchant',
					productId,
					portalUrl: dynamicPortalUrl,
					plan: user.plan || 'pro',
					creditsBalance: user.creditsBalance || 0,
					enabledFeatures,
					apiKey: user.apiKey || '',
					authenticatedAt: Date.now(),
				});
				return;
			}

			// 3. Auto-detect root SuperAdmin setup
			const adminUser = localStorage.getItem('saas_admin_user');
			if (adminUser) {
				const admin = JSON.parse(adminUser);
				setSession({
					tenantId: admin.id || 'adm_root',
					tenantName: admin.name || 'SuperAdmin Master',
					domain: 'admin.platform.local',
					role: 'admin',
					productId,
					portalUrl: dynamicPortalUrl,
					plan: 'enterprise',
					creditsBalance: 999999,
					enabledFeatures: ['*'],
					apiKey: '',
					authenticatedAt: Date.now(),
				});
			}
		} catch {}
	}, [sessionKey, productId, dynamicPortalUrl]);

	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const ssoToken = params.get('sso_token');
		const incomingPortalUrl = params.get('portal_url');

		if (incomingPortalUrl) {
			setDynamicPortalUrl(incomingPortalUrl);
		}

		if (ssoToken) {
			const verification = verifySSOToken(ssoToken, { expectedProductId: productId });
			if (verification.valid) {
				const verifiedSession = verification.session;
				if (verifiedSession.portalUrl) {
					setDynamicPortalUrl(verifiedSession.portalUrl);
				}
				setSession(verifiedSession);
				try {
					sessionStorage.setItem(sessionKey, JSON.stringify(verifiedSession));
				} catch {}

				const cleanUrl = new URL(window.location.href);
				cleanUrl.searchParams.delete('sso_token');
				cleanUrl.searchParams.delete('portal_url');
				cleanUrl.searchParams.delete('tenant_id');
				cleanUrl.searchParams.delete('product_id');
				window.history.replaceState({}, document.title, cleanUrl.toString());
			} else {
				setError(verification.error || 'Invalid SSO Token');
			}
		}
	}, [sessionKey, productId]);

	const handleLogoutApp = () => {
		setSession(null);
		sessionStorage.removeItem(sessionKey);
	};

	const hasFeature = (featureId) => {
		if (!session) return false;
		if (session.role === 'admin') return true;
		if (session.enabledFeatures?.includes('*')) return true;
		return Boolean(session.enabledFeatures?.includes(featureId));
	};

	if (!mounted) {
		return <div className="min-h-screen bg-slate-50" />;
	}

	if (session) {
		return (
			<AppSecurityContext.Provider
				value={{
					session,
					logoutApp: handleLogoutApp,
					appName,
					productId,
					portalUrl: session.portalUrl || dynamicPortalUrl,
					hasFeature,
					enabledFeatures: session.enabledFeatures || [],
				}}>
				{children}
			</AppSecurityContext.Provider>
		);
	}

	return (
		<div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 antialiased font-sans text-slate-900">
			<div className="w-full max-w-md p-8 rounded-3xl bg-white border border-slate-200 shadow-xl space-y-6 text-center">
				<div className="w-14 h-14 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center mx-auto shadow-xs">
					<LockIcon size={28} />
				</div>

				<div className="space-y-2">
					<div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-100 border border-slate-200 text-xs font-semibold text-slate-700">
						<ShieldAlertIcon size={13} className="text-amber-600" />
						<span>Isolated SaaS Micro-App</span>
					</div>
					<h1 className="text-xl font-extrabold text-slate-900 tracking-tight">{appName} Runtime</h1>
					<p className="text-xs text-slate-500 leading-relaxed max-w-sm mx-auto">
						Direct standalone access is restricted. Please sign in to the Master Portal to access this micro-app.
					</p>
				</div>

				{error && (
					<div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs text-left">{error}</div>
				)}

				<div className="space-y-3 pt-2">
					{dynamicPortalUrl && dynamicPortalUrl !== '#' ? (
						<a
							href={dynamicPortalUrl}
							className="w-full py-3 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white font-bold text-xs transition-all duration-150 shadow-xs hover:shadow-md flex items-center justify-center gap-2 cursor-pointer active:scale-98">
							<span>Sign In via Master Portal</span>
							<ExternalLinkIcon size={14} />
						</a>
					) : (
						<div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-xs">
							Portal URL not specified. Pass <code>?portal_url=https://your-portal-domain</code> or set{' '}
							<code>PORTAL_URL</code> in environment variables.
						</div>
					)}
				</div>

				<div className="pt-2 text-[11px] text-slate-400 flex items-center justify-center gap-1">
					<CheckCircleIcon size={12} className="text-emerald-500" />
					<span>End-to-End SSO & Feature Governance Active</span>
				</div>
			</div>
		</div>
	);
}
