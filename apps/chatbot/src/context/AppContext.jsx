import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useAppSecurity } from '@saas/ui/auth/AppAuthGuard';

const AppContext = createContext(null);
const API_BASE = '/api';

export function useAppContext() {
	return useContext(AppContext);
}

export function AppProvider({ children }) {
	const { session } = useAppSecurity() || {};
	const isAdmin = session?.role === 'admin';

	// Load list of merchant stores from SSO session or portal
	const [stores, setStores] = useState(() => {
		try {
			if (session && session.role === 'merchant' && session.tenantId) {
				return [
					{
						id: session.tenantId,
						name: session.tenantName || 'Merchant Storefront',
						domain: session.domain || 'yourstore.com',
						apiKey: session.apiKey || `pk_live_${session.tenantId}`,
						subscriptions: session.enabledFeatures || ['*'],
					},
				];
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
					}));
				}
			}
			return [];
		} catch {
			return [];
		}
	});

	const [selectedStoreId, setSelectedStoreId] = useState(() => {
		return session?.tenantId || stores[0]?.id || '';
	});

	useEffect(() => {
		if (session && session.role === 'merchant' && session.tenantId) {
			const merchantStore = {
				id: session.tenantId,
				name: session.tenantName || 'Merchant Storefront',
				domain: session.domain || 'yourstore.com',
				apiKey: session.apiKey || `pk_live_${session.tenantId}`,
				subscriptions: session.enabledFeatures || ['*'],
			};
			setStores([merchantStore]);
			setSelectedStoreId(session.tenantId);
		} else if (isAdmin) {
			// Fetch all tenants for admin context switching
			const portalUrl =
				(typeof window !== 'undefined' && window.__PORTAL_URL__) ||
				session?.portalUrl ||
				process.env.PORTAL_URL ||
				'http://localhost:3000';
			fetch(`${portalUrl}/api/tenants`)
				.then((res) => res.json())
				.then((data) => {
					if (Array.isArray(data) && data.length > 0) {
						const adminStores = data.map((t) => ({
							id: t.id,
							name: t.name,
							domain: t.domain,
							apiKey: t.apiKey || `pk_live_${t.id}`,
							subscriptions: (t.subscriptions && t.subscriptions.chatbot) || ['*'],
						}));
						setStores(adminStores);
						if (!selectedStoreId || !adminStores.find((s) => s.id === selectedStoreId)) {
							setSelectedStoreId(adminStores[0].id);
						}
					}
				})
				.catch((err) => console.warn('Failed to fetch tenants for admin:', err));
		}
	}, [session, isAdmin, selectedStoreId]);

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
	const [isLoadingEvents, setIsLoadingEvents] = useState(false);

	// Feature Licensing State per Store
	const [featuresCatalog, setFeaturesCatalog] = useState([]);
	const [enabledFeatures, setEnabledFeatures] = useState(() => {
		if (session?.enabledFeatures && !session.enabledFeatures.includes('*')) {
			return session.enabledFeatures;
		}
		return ['conversations', 'handoff', 'widget'];
	});
	const [totalMonthlyCost, setTotalMonthlyCost] = useState(0);

	// Fetch store features, events & integrations from standalone analytics backend
	const refreshStoreData = useCallback(async () => {
		if (!activeStore) {
			setMetaCapiConfig({ pixelId: '', accessToken: '', testEventCode: '', isEnabled: false });
			setGa4Config({ measurementId: '', apiSecret: '', isEnabled: false });
			setWebhookConfig({ endpointUrl: '', signingSecret: '', isEnabled: false });
			setStoreEvents([]);
			return;
		}

		setIsLoadingEvents(true);
		try {
			// Fetch features
			const resFeat = await fetch(`${API_BASE}/features?siteId=${encodeURIComponent(activeStore.id)}`);
			if (resFeat.ok) {
				const featData = await resFeat.json();
				if (featData.features) setFeaturesCatalog(featData.features);
				if (Array.isArray(featData.enabledFeatures)) {
					setEnabledFeatures(featData.enabledFeatures);
					setTotalMonthlyCost(featData.totalMonthlyCost || 0);
				}
			}

			// Fetch events
			const resEvents = await fetch(`${API_BASE}/events?siteId=${encodeURIComponent(activeStore.id)}`);
			if (resEvents.ok) {
				const events = await resEvents.json();
				if (Array.isArray(events)) {
					setStoreEvents(events);
				}
			}

			// Fetch integrations
			const resInteg = await fetch(`${API_BASE}/integrations?siteId=${encodeURIComponent(activeStore.id)}`);
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
	}, [activeStore]);

	useEffect(() => {
		refreshStoreData();
	}, [refreshStoreData]);

	const toggleFeature = async (featureId, action) => {
		if (!activeStore) return;

		// Optimistic update
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
		} catch (err) {
			console.error('Feature toggle error:', err);
		}
	};

	const saveMetaCapi = async (newConfig) => {
		if (!activeStore) return;
		setMetaCapiConfig(newConfig);
		try {
			await fetch(`${API_BASE}/integrations`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ siteId: activeStore.id, metaCapi: newConfig, ga4: ga4Config, webhooks: webhookConfig }),
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
				body: JSON.stringify({ siteId: activeStore.id, metaCapi: metaCapiConfig, ga4: newConfig, webhooks: webhookConfig }),
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
				body: JSON.stringify({ siteId: activeStore.id, metaCapi: metaCapiConfig, ga4: ga4Config, webhooks: newConfig }),
			});
		} catch {}
	};

	const recordStoreEvent = async (eventData) => {
		if (!activeStore) return null;
		const payload = {
			siteId: activeStore.id,
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

		const updated = [tempEvent, ...storeEvents.slice(0, 99)];
		setStoreEvents(updated);

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
			await fetch(`${API_BASE}/events?siteId=${encodeURIComponent(activeStore.id)}`, { method: 'DELETE' });
		} catch {}
	};

	const hasStoreFeature = (featureId) => {
		if (!activeStore) return false;
		if (isAdmin) return true;
		if (enabledFeatures.includes('*')) return true;
		return Boolean(enabledFeatures.includes(featureId));
	};

	return (
		<AppContext.Provider
			value={{
				isAdmin,
				stores,
				activeStore,
				selectedStoreId,
				setSelectedStoreId,

				storeEvents,
				isLoadingEvents,
				featuresCatalog,
				enabledFeatures,
				totalMonthlyCost,
				toggleFeature,
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
		</AppContext.Provider>
	);
}
