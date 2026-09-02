'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useAppSecurity } from '@saas/ui/auth/AppAuthGuard';
import { aggregateAnalyticsFromEvents, EMPTY_ANALYTICS_STATE } from '../data/analyticsStore';

const StorefrontContext = createContext(null);
const API_BASE = '/api';

export function useStorefront() {
	return useContext(StorefrontContext);
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

export function StorefrontProvider({ children }) {
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
					websites: normalizeWebsites({
						id: session.tenantId,
						name: session.tenantName,
						domain: session.domain,
						websites: session.websites,
					}),
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
						subscriptions: (t.subscriptions && t.subscriptions.analytics) || ['*'],
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
								subscriptions: (t.subscriptions && t.subscriptions.analytics) || ['*'],
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

	// Per-store integration states
	const [metaCapiConfig, setMetaCapiConfig] = useState({ pixelId: '', accessToken: '', testEventCode: '', isEnabled: false });
	const [ga4Config, setGa4Config] = useState({ measurementId: '', apiSecret: '', isEnabled: false });
	const [webhookConfig, setWebhookConfig] = useState({ endpointUrl: '', signingSecret: '', isEnabled: false });
	const [storeEvents, setStoreEvents] = useState([]);
	const [isLoadingEvents, setIsLoadingEvents] = useState(false);

	// Feature licensing state
	const [featuresCatalog, setFeaturesCatalog] = useState([]);
	const [enabledFeatures, setEnabledFeatures] = useState(() => {
		if (session?.enabledFeatures && !session.enabledFeatures.includes('*')) {
			return session.enabledFeatures;
		}
		return ['core_traffic', 'funnel_dropoff', 'speed_insights', 'meta_capi', 'ga4_sync', 'custom_webhooks', 'search_analytics'];
	});
	const [totalMonthlyCost, setTotalMonthlyCost] = useState(0);

	const refreshStoreData = useCallback(async () => {
		if (!activeStore) return;
		setIsLoadingEvents(true);
		try {
			const resFeat = await fetch(`${API_BASE}/features?siteId=${encodeURIComponent(activeStore.id)}`);
			if (resFeat.ok) {
				const featData = await resFeat.json();
				if (featData.features) setFeaturesCatalog(featData.features);
				if (Array.isArray(featData.enabledFeatures)) {
					setEnabledFeatures(featData.enabledFeatures);
					setTotalMonthlyCost(featData.totalMonthlyCost || 0);
				}
			}

			const resEvents = await fetch(`${API_BASE}/events?siteId=${encodeURIComponent(activeWebsite?.id || activeStore.id)}`);
			if (resEvents.ok) {
				const events = await resEvents.json();
				if (Array.isArray(events)) setStoreEvents(events);
			}

			const resInteg = await fetch(
				`${API_BASE}/integrations?siteId=${encodeURIComponent(activeWebsite?.id || activeStore.id)}`,
			);
			if (resInteg.ok) {
				const integ = await resInteg.json();
				if (integ.metaCapi) setMetaCapiConfig(integ.metaCapi);
				if (integ.ga4) setGa4Config(integ.ga4);
				if (integ.webhooks) setWebhookConfig(integ.webhooks);
			}
		} catch (err) {
			console.warn('Analytics data load note:', err.message);
		} finally {
			setIsLoadingEvents(false);
		}
	}, [activeStore, activeWebsite]);

	useEffect(() => {
		refreshStoreData();
	}, [refreshStoreData]);

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

	const saveMetaCapi = async (newConfig) => {
		if (!activeStore) return;
		setMetaCapiConfig(newConfig);
		try {
			await fetch(`${API_BASE}/integrations`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					siteId: activeWebsite?.id || activeStore.id,
					metaCapi: newConfig,
					ga4: ga4Config,
					webhooks: webhookConfig,
				}),
			});
		} catch {}
	};

	const saveGa4 = async (newConfig) => {
		if (!activeStore) return;
		setGa4Config(newConfig);
		try {
			await fetch(`${API_BASE}/integrations`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					siteId: activeWebsite?.id || activeStore.id,
					metaCapi: metaCapiConfig,
					ga4: newConfig,
					webhooks: webhookConfig,
				}),
			});
		} catch {}
	};

	const saveWebhook = async (newConfig) => {
		if (!activeStore) return;
		setWebhookConfig(newConfig);
		try {
			await fetch(`${API_BASE}/integrations`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					siteId: activeWebsite?.id || activeStore.id,
					metaCapi: metaCapiConfig,
					ga4: ga4Config,
					webhooks: newConfig,
				}),
			});
		} catch {}
	};

	const recordStoreEvent = async (eventData) => {
		if (!activeStore) return null;
		const payload = {
			siteId: activeWebsite?.id || activeStore.id,
			eventType: eventData.eventType || 'page_view',
			eventName: eventData.eventName,
			path: eventData.path || '/',
			title: eventData.title || 'Store Page',
			referrer: eventData.referrer || 'Direct',
			sessionId: eventData.sessionId || `sess_${Date.now()}`,
			visitorId: eventData.visitorId || `vis_${Date.now()}`,
			device: eventData.device || 'Mobile Phone',
			browser: eventData.browser || 'Mobile Safari',
			os: eventData.os || 'iOS 18.0',
			city: eventData.city || 'Karachi, Sindh',
			durationMs: Number(eventData.durationMs) || 3500,
			vitalMetric: eventData.vitalMetric,
			vitalValue: eventData.vitalValue,
			vitalRating: eventData.vitalRating,
			eventData: eventData.eventData,
		};

		const tempEvent = {
			id: `ev_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
			timestamp: new Date().toISOString(),
			...payload,
		};

		setStoreEvents((prev) => [tempEvent, ...prev.slice(0, 99)]);

		try {
			await fetch(`${API_BASE}/events`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
			});
		} catch {}

		return tempEvent;
	};

	const resetStoreEvents = async () => {
		if (!activeStore) return;
		setStoreEvents([]);
		try {
			await fetch(`${API_BASE}/events?siteId=${encodeURIComponent(activeWebsite?.id || activeStore.id)}`, {
				method: 'DELETE',
			});
		} catch {}
	};

	const hasStoreFeature = (featureId) => {
		if (!activeStore) return false;
		if (isAdmin) return true;
		if (enabledFeatures.includes('*')) return true;
		return Boolean(enabledFeatures.includes(featureId));
	};

	const analyticsData = storeEvents.length > 0 ? aggregateAnalyticsFromEvents(storeEvents) : EMPTY_ANALYTICS_STATE;

	return (
		<StorefrontContext.Provider
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
				analyticsData,
				analytics: analyticsData,
				storeEvents,
				isLoadingEvents,
				refreshStoreData,
				featuresCatalog,
				enabledFeatures,
				totalMonthlyCost,
				toggleFeature,
				hasStoreFeature,
				recordStoreEvent,
				resetStoreEvents,
				metaCapiConfig,
				setMetaCapiConfig,
				saveMetaCapi,
				ga4Config,
				setGa4Config,
				saveGa4,
				webhookConfig,
				setWebhookConfig,
				saveWebhook,
				portalUrl: portalUrl || session?.portalUrl || '',
			}}>
			{children}
		</StorefrontContext.Provider>
	);
}
