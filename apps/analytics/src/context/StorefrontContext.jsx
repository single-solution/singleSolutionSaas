import React, { createContext, useContext, useState, useEffect } from 'react';
import { useAppSecurity } from '@saas/ui/auth/AppAuthGuard';
import { aggregateAnalyticsFromEvents, EMPTY_ANALYTICS_STATE } from '../data/analyticsStore';

const StorefrontContext = createContext(null);

export function useStorefront() {
	return useContext(StorefrontContext);
}

export function StorefrontProvider({ children }) {
	const { session } = useAppSecurity() || {};
	const isAdmin = session?.role === 'admin';

	// Load list of merchant stores ONLY from real registered portal tenants
	const [stores, setStores] = useState(() => {
		try {
			// 1. If merchant session is logged in, use solely the merchant's real account
			if (session && session.role === 'merchant') {
				return [
					{
						id: session.tenantId,
						name: session.tenantName,
						domain: session.domain || 'unassigned-domain.com',
						apiKey: session.apiKey || `pk_live_${session.tenantId}`,
						subscriptions: session.enabledFeatures || ['*'],
					},
				];
			}

			// 2. If admin, read registered merchants from portal storage
			const savedTenants = localStorage.getItem('saas_tenants');
			if (savedTenants) {
				const tenants = JSON.parse(savedTenants);
				if (Array.isArray(tenants) && tenants.length > 0) {
					return tenants.map((t) => ({
						id: t.id,
						name: t.name,
						domain: t.domain,
						apiKey: t.apiKey || `pk_live_${t.id}`,
						subscriptions: (t.subscriptions && t.subscriptions.analytics) || ['*'],
					}));
				}
			}

			// 3. Clean empty state: NO fake fallback merchants
			return [];
		} catch {
			return [];
		}
	});

	const [selectedStoreId, setSelectedStoreId] = useState(() => {
		return stores[0]?.id || '';
	});

	// Keep selectedStoreId in sync when stores change
	useEffect(() => {
		if (stores.length > 0 && !stores.some((s) => s.id === selectedStoreId)) {
			setSelectedStoreId(stores[0].id);
		} else if (stores.length === 0) {
			setSelectedStoreId('');
		}
	}, [stores, selectedStoreId]);

	const activeStore = stores.find((s) => s.id === selectedStoreId) || stores[0] || null;

	// Per-store integration states
	const [metaCapiConfig, setMetaCapiConfig] = useState({ pixelId: '', accessToken: '', testEventCode: '', isEnabled: false });
	const [ga4Config, setGa4Config] = useState({ measurementId: '', apiSecret: '', isEnabled: false });
	const [webhookConfig, setWebhookConfig] = useState({ endpointUrl: '', signingSecret: '', isEnabled: false });
	const [storeEvents, setStoreEvents] = useState([]);

	// Re-load per-store settings when activeStore changes
	useEffect(() => {
		if (!activeStore) {
			setMetaCapiConfig({ pixelId: '', accessToken: '', testEventCode: '', isEnabled: false });
			setGa4Config({ measurementId: '', apiSecret: '', isEnabled: false });
			setWebhookConfig({ endpointUrl: '', signingSecret: '', isEnabled: false });
			setStoreEvents([]);
			return;
		}

		try {
			const savedMeta = localStorage.getItem(`saas_meta_capi_${activeStore.id}`);
			setMetaCapiConfig(
				savedMeta ? JSON.parse(savedMeta) : { pixelId: '', accessToken: '', testEventCode: '', isEnabled: false },
			);

			const savedGa4 = localStorage.getItem(`saas_ga4_${activeStore.id}`);
			setGa4Config(savedGa4 ? JSON.parse(savedGa4) : { measurementId: '', apiSecret: '', isEnabled: false });

			const savedWh = localStorage.getItem(`saas_webhook_${activeStore.id}`);
			setWebhookConfig(
				savedWh
					? JSON.parse(savedWh)
					: { endpointUrl: '', signingSecret: `whsec_${activeStore.id.slice(-6)}`, isEnabled: false },
			);

			const savedEvents = localStorage.getItem(`saas_events_${activeStore.id}`);
			setStoreEvents(savedEvents ? JSON.parse(savedEvents) : []);
		} catch {}
	}, [activeStore?.id]);

	const saveMetaCapi = (newConfig) => {
		if (!activeStore) return;
		setMetaCapiConfig(newConfig);
		try {
			localStorage.setItem(`saas_meta_capi_${activeStore.id}`, JSON.stringify(newConfig));
		} catch {}
	};

	const saveGa4 = (newConfig) => {
		if (!activeStore) return;
		setGa4Config(newConfig);
		try {
			localStorage.setItem(`saas_ga4_${activeStore.id}`, JSON.stringify(newConfig));
		} catch {}
	};

	const saveWebhook = (newConfig) => {
		if (!activeStore) return;
		setWebhookConfig(newConfig);
		try {
			localStorage.setItem(`saas_webhook_${activeStore.id}`, JSON.stringify(newConfig));
		} catch {}
	};

	const recordStoreEvent = (eventData) => {
		if (!activeStore) return null;
		const newEvent = {
			id: `ev_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
			timestamp: 'Just now',
			storeId: activeStore.id,
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

		const updated = [newEvent, ...storeEvents.slice(0, 99)];
		setStoreEvents(updated);
		try {
			localStorage.setItem(`saas_events_${activeStore.id}`, JSON.stringify(updated));
		} catch {}
		return newEvent;
	};

	const resetStoreEvents = () => {
		if (!activeStore) return;
		setStoreEvents([]);
		try {
			localStorage.removeItem(`saas_events_${activeStore.id}`);
		} catch {}
	};

	// Aggregated metrics for current active store
	const analyticsData = storeEvents.length > 0 ? aggregateAnalyticsFromEvents(storeEvents) : EMPTY_ANALYTICS_STATE;

	// Check if active feature is enabled for this store
	const hasStoreFeature = (featureId) => {
		if (!activeStore) return false;
		if (isAdmin) return true;
		if (activeStore.subscriptions?.includes('*')) return true;
		return Boolean(activeStore.subscriptions?.includes(featureId));
	};

	return (
		<StorefrontContext.Provider
			value={{
				isAdmin,
				stores,
				activeStore,
				selectedStoreId,
				setSelectedStoreId,
				analyticsData,
				storeEvents,
				recordStoreEvent,
				resetStoreEvents,
				hasStoreFeature,
				metaCapiConfig,
				saveMetaCapi,
				ga4Config,
				saveGa4,
				webhookConfig,
				saveWebhook,
			}}>
			{children}
		</StorefrontContext.Provider>
	);
}
