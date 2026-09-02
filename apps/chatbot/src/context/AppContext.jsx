'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useAppSecurity } from '@saas/ui/auth/AppAuthGuard';

const AppContext = createContext(null);
const API_BASE = '/api';

export function useAppContext() {
	return useContext(AppContext);
}

function normalizeWebsites(tenant) {
	if (!tenant) return [];
	if (Array.isArray(tenant.websites) && tenant.websites.length > 0) {
		return tenant.websites;
	}
	return [
		{
			id: `site_${tenant.id || 'default'}_main`,
			name: `${tenant.name || 'Storefront'} (Main)`,
			domain: tenant.domain || 'yourstore.com',
			status: 'active',
			createdAt: new Date().toISOString(),
		},
	];
}

export function AppProvider({ children }) {
	const { session, portalUrl } = useAppSecurity() || {};
	const isAdmin = session?.role === 'admin';
	const isMerchant = session?.role === 'merchant';
	const isStandalone = !session || (!isAdmin && !isMerchant);

	// Load list of merchant stores
	const [stores, setStores] = useState(() => {
		try {
			if (session && session.role === 'merchant' && session.tenantId) {
				const merchantStore = {
					id: session.tenantId,
					name: session.tenantName || 'Merchant Storefront',
					domain: session.domain || 'yourstore.com',
					apiKey: session.apiKey || `pk_live_${session.tenantId}`,
					subscriptions: session.enabledFeatures || ['*'],
					websites: session.websites || [
						{
							id: `site_${session.tenantId}_main`,
							name: `${session.tenantName || 'Storefront'} (Main Store)`,
							domain: session.domain || 'yourstore.com',
							status: 'active',
						},
					],
				};
				return [merchantStore];
			}

			const savedTenants = typeof window !== 'undefined' ? localStorage.getItem('saas_tenants') : null;
			if (savedTenants) {
				const tenants = JSON.parse(savedTenants);
				if (Array.isArray(tenants) && tenants.length > 0) {
					return tenants.map((t) => ({
						id: t.id,
						name: t.name,
						domain: t.domain,
						apiKey: t.apiKey || `pk_live_${t.id}`,
						subscriptions: (t.subscriptions && t.subscriptions.chatbot) || ['*'],
						websites: normalizeWebsites(t),
					}));
				}
			}
			return [];
		} catch {
			return [];
		}
	});

	const [selectedStoreId, setSelectedStoreId] = useState(() => {
		return session?.tenantId || stores[0]?.id || 'tnt_merchant_demo';
	});

	const [selectedWebsiteId, setSelectedWebsiteId] = useState('');

	// Sync tenants when session or role changes
	useEffect(() => {
		if (session && session.role === 'merchant' && session.tenantId) {
			const merchantStore = {
				id: session.tenantId,
				name: session.tenantName || 'Merchant Storefront',
				domain: session.domain || 'yourstore.com',
				apiKey: session.apiKey || `pk_live_${session.tenantId}`,
				subscriptions: session.enabledFeatures || ['*'],
				websites: normalizeWebsites({
					id: session.tenantId,
					name: session.tenantName,
					domain: session.domain,
					websites: session.websites,
				}),
			};
			setStores([merchantStore]);
			setSelectedStoreId(session.tenantId);
		} else if (isAdmin) {
			const pUrl =
				(typeof window !== 'undefined' && window.__PORTAL_URL__) ||
				session?.portalUrl ||
				portalUrl ||
				process.env.NEXT_PUBLIC_PORTAL_URL ||
				'';
			if (pUrl) {
				fetch(`${pUrl}/api/tenants`)
					.then((res) => res.json())
					.then((data) => {
						if (Array.isArray(data) && data.length > 0) {
							const adminStores = data.map((t) => ({
								id: t.id,
								name: t.name,
								domain: t.domain,
								apiKey: t.apiKey || `pk_live_${t.id}`,
								subscriptions: (t.subscriptions && t.subscriptions.chatbot) || ['*'],
								websites: normalizeWebsites(t),
							}));
							setStores(adminStores);
							if (!selectedStoreId || !adminStores.find((s) => s.id === selectedStoreId)) {
								setSelectedStoreId(adminStores[0].id);
							}
						}
					})
					.catch(() => {});
			}
		}
	}, [session, isAdmin, portalUrl]);

	const activeStore = stores.find((s) => s.id === selectedStoreId) ||
		stores[0] || {
			id: 'tnt_default',
			name: 'Default Merchant',
			domain: 'yourstore.com',
			websites: [{ id: 'site_default_main', name: 'Default Storefront', domain: 'yourstore.com' }],
		};

	const websites = normalizeWebsites(activeStore);

	// Automatically select first website when active store changes
	useEffect(() => {
		if (websites.length > 0) {
			if (!selectedWebsiteId || !websites.some((w) => w.id === selectedWebsiteId)) {
				setSelectedWebsiteId(websites[0].id);
			}
		} else {
			setSelectedWebsiteId('');
		}
	}, [activeStore, websites, selectedWebsiteId]);

	const activeWebsite = websites.find((w) => w.id === selectedWebsiteId) ||
		websites[0] || {
			id: `site_${activeStore.id}_main`,
			name: activeStore.name || 'Main Website',
			domain: activeStore.domain || 'yourstore.com',
		};

	// Website-isolated configuration reader/writer
	const getWebsiteConfig = useCallback(
		(appKey, defaultValues = {}) => {
			if (typeof window === 'undefined') return defaultValues;
			try {
				const storageKey = `app_config_${activeWebsite?.id || 'default'}_${appKey}`;
				const saved = localStorage.getItem(storageKey);
				if (saved) return { ...defaultValues, ...JSON.parse(saved) };
			} catch {}
			return defaultValues;
		},
		[activeWebsite],
	);

	const saveWebsiteConfig = useCallback(
		(appKey, configUpdates) => {
			if (typeof window === 'undefined' || !activeWebsite?.id) return;
			try {
				const storageKey = `app_config_${activeWebsite.id}_${appKey}`;
				const current = getWebsiteConfig(appKey, {});
				const merged = { ...current, ...configUpdates, updatedAt: new Date().toISOString() };
				localStorage.setItem(storageKey, JSON.stringify(merged));
				return merged;
			} catch {}
		},
		[activeWebsite, getWebsiteConfig],
	);

	// Feature licensing state
	const [featuresCatalog, setFeaturesCatalog] = useState([]);
	const [enabledFeatures, setEnabledFeatures] = useState(() => {
		if (session?.enabledFeatures && !session.enabledFeatures.includes('*')) {
			return session.enabledFeatures;
		}
		return ['conversations', 'handoff', 'widget'];
	});
	const [totalMonthlyCost, setTotalMonthlyCost] = useState(0);

	const toggleFeature = async (featureId, action) => {
		if (!activeStore) return;
		setEnabledFeatures((prev) => {
			if (action === 'enable') return prev.includes(featureId) ? prev : [...prev, featureId];
			if (action === 'disable') return prev.filter((f) => f !== featureId);
			return prev.includes(featureId) ? prev.filter((f) => f !== featureId) : [...prev, featureId];
		});

		try {
			const res = await fetch(`${API_BASE}/features`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ siteId: activeStore.id, featureId, action }),
			});
			if (res.ok) {
				const data = await res.json();
				if (Array.isArray(data.enabledFeatures)) {
					setEnabledFeatures(data.enabledFeatures);
					setTotalMonthlyCost(data.totalMonthlyCost || 0);
				}
			}
		} catch {}
	};

	return (
		<AppContext.Provider
			value={{
				session,
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
				getWebsiteConfig,
				saveWebsiteConfig,
				featuresCatalog,
				enabledFeatures,
				totalMonthlyCost,
				toggleFeature,
				portalUrl: portalUrl || session?.portalUrl || '',
			}}>
			{children}
		</AppContext.Provider>
	);
}
