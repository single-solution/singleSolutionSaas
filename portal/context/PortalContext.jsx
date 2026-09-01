'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { getAppLaunchUrl } from '../../shared/ui/auth/ssoHandshake.js';

const PortalContext = createContext(null);

export function usePortal() {
	const context = useContext(PortalContext);
	if (!context) {
		throw new Error('usePortal must be used within a PortalProvider');
	}
	return context;
}

export function PortalProvider({ children }) {
	const [currentUser, setCurrentUser] = useState(null);
	const [currentRole, setCurrentRole] = useState('admin');
	const [hasAdminApi, setHasAdminApi] = useState(false);
	const [products, setProducts] = useState([]);
	const [tenants, setTenants] = useState([]);
	const [selectedTenantId, setSelectedTenantId] = useState('');
	const [depositRequests, setDepositRequests] = useState([]);
	const [creditTransactions, setCreditTransactions] = useState([]);
	const [auditLogs, setAuditLogs] = useState([]);
	const [platformSettings, setPlatformSettings] = useState({
		platformName: 'SingleSolution Multi-Tenant Cloud',
		supportEmail: 'support@singlesolution.io',
		maintenanceMode: false,
		bankDetails: {
			bankName: 'Meezan Bank Ltd',
			accountTitle: 'Single Solution Technologies (Pvt) Ltd',
			accountNumber: '02010108920192',
			iban: 'PK45MEZN0002010108920192',
			branch: 'DHA Phase 5 Branch, Lahore',
			instructions: 'Please include your Store Domain or Tenant ID as the payment reference.',
		},
		security: {
			ssoTokenExpiryMinutes: 10,
			enforceHttps: false,
			allowMerchantKeyRotation: true,
		},
	});
	const [toast, setToast] = useState(null);
	const [isLoading, setIsLoading] = useState(true);

	const showToast = useCallback((message, type = 'success') => {
		setToast({ message, type, id: Date.now() });
		setTimeout(() => setToast(null), 3500);
	}, []);

	const logAction = useCallback(async (action, actor = 'SuperAdmin', level = 'info', details = {}) => {
		const newLog = {
			id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
			action,
			actor,
			level,
			details,
			timestamp: new Date().toISOString(),
		};
		setAuditLogs((prev) => [newLog, ...prev.slice(0, 199)]);

		try {
			await fetch('/api/audit', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(newLog),
			});
		} catch {}
	}, []);

	const refreshAuditLogs = useCallback(async (filterLevel = 'all') => {
		try {
			const url = filterLevel && filterLevel !== 'all' ? `/api/audit?level=${filterLevel}` : '/api/audit';
			const res = await fetch(url);
			if (res.ok) {
				const data = await res.json();
				if (Array.isArray(data)) setAuditLogs(data);
			}
		} catch {}
	}, []);

	// Initial data sync with server
	useEffect(() => {
		async function syncWithServer() {
			setIsLoading(true);
			try {
				const resSession = await fetch('/api/auth/session');
				if (resSession.ok) {
					const dataSession = await resSession.json();
					setHasAdminApi(Boolean(dataSession.hasAdmin));
					if (dataSession.user) {
						setCurrentUser(dataSession.user);
						setCurrentRole(dataSession.user.role || 'admin');
						if (dataSession.user.role === 'merchant') {
							setSelectedTenantId(dataSession.user.id);
						}
					}
				}

				const resApps = await fetch('/api/apps');
				if (resApps.ok) {
					const dataApps = await resApps.json();
					if (Array.isArray(dataApps)) {
						setProducts(dataApps);
					}
				}

				const resTenants = await fetch('/api/tenants');
				if (resTenants.ok) {
					const dataTenants = await resTenants.json();
					if (Array.isArray(dataTenants)) {
						setTenants(dataTenants);
						if (dataTenants.length > 0) {
							setSelectedTenantId((prev) => prev || dataTenants[0].id);
						}
					}
				}

				const resBilling = await fetch('/api/billing');
				if (resBilling.ok) {
					const dataBilling = await resBilling.json();
					if (dataBilling.depositRequests) setDepositRequests(dataBilling.depositRequests);
					if (dataBilling.creditTransactions) setCreditTransactions(dataBilling.creditTransactions);
				}

				const resSettings = await fetch('/api/settings');
				if (resSettings.ok) {
					const dataSettings = await resSettings.json();
					if (dataSettings) setPlatformSettings(dataSettings);
				}

				const resAudit = await fetch('/api/audit');
				if (resAudit.ok) {
					const dataAudit = await resAudit.json();
					if (Array.isArray(dataAudit)) setAuditLogs(dataAudit);
				}
			} catch (err) {
				console.warn('Backend sync note:', err.message);
			} finally {
				setIsLoading(false);
			}
		}

		syncWithServer();
	}, []);

	const activeTenant = tenants.find((t) => t.id === selectedTenantId) || tenants[0] || null;
	const isAuthenticated = Boolean(currentUser);
	const hasAdmin = hasAdminApi || Boolean(currentUser);

	// Single website monthly fee calculator
	const calculateWebsiteMonthlyFee = useCallback(
		(website, customProducts = products) => {
			if (!website) return 0;
			const subs = website.subscriptions || {};
			let total = 0;
			customProducts.forEach((prod) => {
				const activeFeatureIds = subs[prod.id] || [];
				if (Array.isArray(prod.features)) {
					prod.features.forEach((feat) => {
						if (activeFeatureIds.includes(feat.id)) {
							total += Number(feat.creditCost) || 0;
						}
					});
				}
			});
			return total;
		},
		[products],
	);

	// Multi-website aggregated merchant monthly fee calculator
	const calculateMerchantMonthlyFee = useCallback(
		(tenant) => {
			if (!tenant) return 0;
			if (Array.isArray(tenant.websites) && tenant.websites.length > 0) {
				return tenant.websites.reduce((sum, site) => {
					return sum + calculateWebsiteMonthlyFee(site, products);
				}, 0);
			}

			// Fallback for top-level subscriptions
			return calculateWebsiteMonthlyFee({ subscriptions: tenant.subscriptions || {} }, products);
		},
		[products, calculateWebsiteMonthlyFee],
	);

	const login = async (email, password, role = 'admin') => {
		const cleanEmail = email.trim().toLowerCase();
		const res = await fetch('/api/auth/login', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email: cleanEmail, password, role }),
		});

		if (res.ok) {
			const sessionUser = await res.json();
			setCurrentUser(sessionUser);
			setCurrentRole(sessionUser.role);
			if (sessionUser.role === 'merchant') {
				setSelectedTenantId(sessionUser.id);
			}
			logAction(`User logged in (${role})`, cleanEmail, 'info');
			showToast(`Signed in as ${sessionUser.name}`);
			return sessionUser;
		} else {
			const errData = await res.json();
			throw new Error(errData.error || 'Invalid credentials');
		}
	};

	const setupAdmin = async ({ name, email, password, orgName }) => {
		const payload = {
			name: name.trim(),
			email: email.trim().toLowerCase(),
			password,
			orgName: orgName?.trim() || 'SingleSolution Platform',
		};

		const res = await fetch('/api/auth/setup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		});

		if (res.ok) {
			const sessionUser = await res.json();
			setCurrentUser(sessionUser);
			setCurrentRole('admin');
			setHasAdminApi(true);
			logAction('Provisioned SuperAdmin account in MongoDB', sessionUser.email, 'success');
			showToast(`Welcome ${sessionUser.name}! SuperAdmin console ready.`);
			return sessionUser;
		} else {
			const errData = await res.json();
			throw new Error(errData.error || 'Failed to provision SuperAdmin.');
		}
	};

	const logout = async () => {
		const userName = currentUser?.name || 'User';
		try {
			await fetch('/api/auth/logout', { method: 'POST' });
		} catch {}
		setCurrentUser(null);
		logAction('User logged out', userName, 'info');
		showToast('Signed out successfully.');
	};

	const addTenant = async (tenantData) => {
		const initialSubscriptions = {};
		products.forEach((prod) => {
			if (Array.isArray(prod.features)) {
				initialSubscriptions[prod.id] = prod.features.map((f) => f.id);
			}
		});

		const defaultWebsites = tenantData.websites || [
			{
				id: `site_${Date.now().toString().slice(-4)}`,
				name: `${tenantData.name?.trim()} (Primary)`,
				domain: tenantData.domain
					?.trim()
					.toLowerCase()
					.replace(/^https?:\/\//, '')
					.replace(/\/$/, ''),
				status: 'active',
				subscriptions: initialSubscriptions,
				createdAt: new Date().toISOString(),
			},
		];

		const payload = {
			...tenantData,
			subscriptions: initialSubscriptions,
			websites: defaultWebsites,
		};

		try {
			const res = await fetch('/api/tenants', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
			});
			if (!res.ok) {
				const errorData = await res.json();
				throw new Error(errorData.error || 'Failed to create merchant');
			}
			const created = await res.json();
			setTenants((prev) => [created, ...prev.filter((t) => t.id !== created.id)]);
			setSelectedTenantId(created.id);
			logAction(`Created merchant account: ${created.name}`, created.id, 'success');
			showToast(`Created merchant "${created.name}".`);
			return created;
		} catch (err) {
			showToast(err.message || 'Failed to create merchant', 'danger');
			return null;
		}
	};

	const updateTenant = async (tenantId, updates) => {
		try {
			const res = await fetch(`/api/tenants/${tenantId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(updates),
			});
			if (!res.ok) {
				const errorData = await res.json();
				throw new Error(errorData.error || 'Failed to update merchant');
			}
			const data = await res.json();
			// Update the tenant ID if it changed
			const newTenantId = data.id || tenantId;
			setTenants((prev) => prev.map((t) => (t.id === tenantId ? { ...t, ...updates, id: newTenantId } : t)));
			if (selectedTenantId === tenantId && newTenantId !== tenantId) {
				setSelectedTenantId(newTenantId);
			}
			showToast('Merchant updated successfully.');
		} catch (err) {
			showToast(err.message || 'Failed to update merchant', 'danger');
			throw err;
		}
	};

	// Multi-Website Operations
	const addMerchantWebsite = async (tenantId, websiteData) => {
		const target = tenants.find((t) => t.id === tenantId);
		if (!target) return;

		const cleanDomain = (websiteData.domain || '')
			.trim()
			.toLowerCase()
			.replace(/^https?:\/\//, '')
			.replace(/\/$/, '');

		const initialSubscriptions = {};
		products.forEach((prod) => {
			if (Array.isArray(prod.features)) {
				initialSubscriptions[prod.id] = prod.features.map((f) => f.id);
			}
		});

		const newSite = {
			id: `site_${Date.now().toString().slice(-4)}_${Math.random().toString(36).substring(2, 5)}`,
			name: websiteData.name?.trim() || cleanDomain,
			domain: cleanDomain,
			status: 'active',
			subscriptions: websiteData.subscriptions || initialSubscriptions,
			createdAt: new Date().toISOString(),
		};

		const updatedWebsites = [...(target.websites || []), newSite];
		await updateTenant(tenantId, { websites: updatedWebsites });
		logAction(`Added website ${newSite.domain} to merchant ${target.name}`, 'SuperAdmin', 'info');
		showToast(`Added website "${newSite.domain}".`);
	};

	const deleteMerchantWebsite = async (tenantId, websiteId) => {
		const target = tenants.find((t) => t.id === tenantId);
		if (!target) return;

		const updatedWebsites = (target.websites || []).filter((w) => w.id !== websiteId);
		await updateTenant(tenantId, { websites: updatedWebsites });
		logAction(`Removed website from merchant ${target.name}`, 'SuperAdmin', 'warning');
		showToast(`Website removed.`);
	};

	const toggleWebsiteFeature = async (tenantId, websiteId, productId, featureId) => {
		const target = tenants.find((t) => t.id === tenantId);
		if (!target) return;

		const updatedWebsites = (target.websites || []).map((site) => {
			if (site.id === websiteId) {
				const subs = { ...(site.subscriptions || {}) };
				const currentFeatures = subs[productId] || [];
				const hasFeature = currentFeatures.includes(featureId);
				const nextFeatures = hasFeature ? currentFeatures.filter((f) => f !== featureId) : [...currentFeatures, featureId];
				return {
					...site,
					subscriptions: {
						...subs,
						[productId]: nextFeatures,
					},
				};
			}
			return site;
		});

		const aggregatedSubscriptions = {};
		updatedWebsites.forEach((site) => {
			Object.entries(site.subscriptions || {}).forEach(([pId, fIds]) => {
				if (!aggregatedSubscriptions[pId]) aggregatedSubscriptions[pId] = [];
				if (Array.isArray(fIds)) {
					fIds.forEach((f) => {
						if (!aggregatedSubscriptions[pId].includes(f)) {
							aggregatedSubscriptions[pId].push(f);
						}
					});
				}
			});
		});

		await updateTenant(tenantId, { websites: updatedWebsites, subscriptions: aggregatedSubscriptions });
		showToast(`Updated feature licensing.`);
	};

	const rotateTenantKeys = async (tenantId) => {
		const target = tenants.find((t) => t.id === tenantId);
		if (!target) return;

		const slug = target.name
			.toLowerCase()
			.replace(/[^a-z0-9]/g, '_')
			.substring(0, 10);
		const newApiKey = `ss_live_${slug}_${Math.random().toString(36).substring(2, 10)}`;
		const newSecretKey = `sk_live_${slug}_${Math.random().toString(36).substring(2, 12)}`;

		await updateTenant(tenantId, { apiKey: newApiKey, secretKey: newSecretKey });
		logAction(`Rotated API credentials for store: ${target.name}`, 'SuperAdmin', 'warning');
		showToast(`Credentials rotated for ${target.name}.`);
	};

	const deleteTenant = async (tenantId) => {
		try {
			await fetch(`/api/tenants/${tenantId}`, { method: 'DELETE' });
		} catch {}
		setTenants((prev) => prev.filter((t) => t.id !== tenantId));
		logAction('Deleted merchant account', tenantId, 'danger');
		showToast(`Merchant deleted.`);
	};

	const toggleTenantStatus = async (tenantId) => {
		const target = tenants.find((t) => t.id === tenantId);
		if (!target) return;
		const nextStatus = target.status === 'active' ? 'suspended' : 'active';
		await updateTenant(tenantId, { status: nextStatus });
	};

	const toggleMerchantProductFeature = async (tenantId, productId, featureId) => {
		const target = tenants.find((t) => t.id === tenantId);
		if (!target) return;

		const subs = { ...(target.subscriptions || {}) };
		const currentFeatures = subs[productId] || [];
		const hasFeature = currentFeatures.includes(featureId);
		const nextFeatures = hasFeature ? currentFeatures.filter((f) => f !== featureId) : [...currentFeatures, featureId];

		subs[productId] = nextFeatures;

		const updatedWebsites = Array.isArray(target.websites)
			? target.websites.map((w, idx) =>
					idx === 0 ? { ...w, subscriptions: { ...(w.subscriptions || {}), [productId]: nextFeatures } } : w,
				)
			: [];

		await updateTenant(tenantId, {
			subscriptions: subs,
			...(updatedWebsites.length > 0 ? { websites: updatedWebsites } : {}),
		});
		showToast(`${hasFeature ? 'Disabled' : 'Enabled'} feature.`);
	};

	const updateFeaturePrice = async (appId, featureId, newCreditCost, newName, newDesc) => {
		try {
			const res = await fetch('/api/apps', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ appId, featureId, newCreditCost: Number(newCreditCost), newName, newDesc }),
			});

			if (res.ok) {
				const data = await res.json();
				setProducts((prev) => prev.map((app) => (app.id === appId ? { ...app, features: data.features } : app)));
				logAction(`SuperAdmin updated feature price: ${appId} -> ${featureId} to $${newCreditCost}/mo`, 'SuperAdmin', 'info');
				showToast(`Feature price updated to $${newCreditCost} credits/mo.`);
			}
		} catch (err) {
			showToast(err.message || 'Failed to update feature pricing', 'danger');
		}
	};

	const registerProduct = async (productData) => {
		const slug = productData.name
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]/g, '_');
		const defaultFeatures = [
			{ id: 'core', name: 'Core Engine', creditCost: Number(productData.price) || 50, desc: 'Base functionality' },
			{ id: 'analytics', name: 'Analytics & Telemetry', creditCost: 25, desc: 'Live event tracking' },
			{ id: 'webhooks', name: 'Webhook Triggers', creditCost: 20, desc: 'Automated event hooks' },
		];

		const newProduct = {
			id: slug,
			originalId: productData.id,
			name: productData.name.trim(),
			url: productData.url.trim(),
			secretKey: productData.secretKey || `sec_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
			status: 'operational',
			desc: productData.desc?.trim() || 'Custom registered SaaS micro-application.',
			features: productData.features || defaultFeatures,
		};

		try {
			const res = await fetch('/api/apps', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(newProduct),
			});
			if (!res.ok) {
				const errorData = await res.json();
				throw new Error(errorData.error || 'Failed to register app');
			}
		} catch (err) {
			showToast(err.message || 'Failed to register app', 'danger');
			return null;
		}

		setProducts((prev) => {
			const filtered = prev.filter((p) => p.id !== (productData.id || newProduct.id));
			const cleanProduct = { ...newProduct };
			delete cleanProduct.originalId;
			return [...filtered, cleanProduct];
		});

		logAction(`Registered SaaS micro-app: ${newProduct.name}`, newProduct.url, 'success');
		showToast(`Registered app "${newProduct.name}".`);
		return newProduct;
	};

	const deleteProduct = async (productId) => {
		const target = products.find((p) => p.id === productId);
		try {
			await fetch(`/api/apps?id=${productId}`, { method: 'DELETE' });
		} catch {}

		setProducts((prev) => prev.filter((p) => p.id !== productId));
		logAction(`Deleted micro-app: ${target?.name || productId}`, productId, 'danger');
		showToast(`Micro-app removed from registry.`);
	};

	const requestBankDeposit = async ({ tenantId, amount, bankName, transactionRef, notes }) => {
		const target = tenants.find((t) => t.id === tenantId);
		const newRequest = {
			id: `DEP-${Math.floor(1000 + Math.random() * 9000)}`,
			tenantId,
			tenantName: target?.name || tenantId,
			amount: Number(amount),
			bankName,
			transactionRef,
			notes: notes || '',
			status: 'pending',
			submittedAt: new Date().toISOString(),
		};

		const nextRequests = [newRequest, ...depositRequests];
		setDepositRequests(nextRequests);

		try {
			await fetch('/api/billing', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ depositRequests: nextRequests, creditTransactions }),
			});
		} catch {}

		logAction(`Submitted deposit request ($${amount})`, target?.name || tenantId, 'info');
		showToast('Deposit receipt submitted for SuperAdmin verification.');
	};

	const approveDepositRequest = async (requestId) => {
		const request = depositRequests.find((r) => r.id === requestId);
		if (!request || request.status !== 'pending') return;

		const target = tenants.find((t) => t.id === request.tenantId);
		const currentBalance = Number(target?.creditsBalance) || 0;
		const newBalance = currentBalance + Number(request.amount);

		const updatedRequests = depositRequests.map((r) =>
			r.id === requestId ? { ...r, status: 'approved', approvedAt: new Date().toISOString() } : r,
		);
		setDepositRequests(updatedRequests);

		const newTx = {
			id: `TX-${Date.now().toString().slice(-4)}`,
			tenantId: request.tenantId,
			amount: request.amount,
			balanceAfter: newBalance,
			type: 'deposit',
			method: 'Bank Wire Transfer',
			reference: request.transactionRef,
			timestamp: new Date().toISOString(),
		};
		const updatedTransactions = [newTx, ...creditTransactions];
		setCreditTransactions(updatedTransactions);

		await updateTenant(request.tenantId, { creditsBalance: newBalance });

		try {
			await fetch('/api/billing', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ depositRequests: updatedRequests, creditTransactions: updatedTransactions }),
			});
		} catch {}

		logAction(`Approved deposit ($${request.amount}) for ${request.tenantName}`, 'SuperAdmin', 'success');
		showToast(`Approved deposit of $${request.amount}. Account credited.`);
	};

	const rejectDepositRequest = async (requestId, reason) => {
		const request = depositRequests.find((r) => r.id === requestId);
		if (!request || request.status !== 'pending') return;

		const updatedRequests = depositRequests.map((r) =>
			r.id === requestId
				? {
						...r,
						status: 'rejected',
						rejectionReason: reason || 'Receipt verification could not be confirmed.',
						rejectedAt: new Date().toISOString(),
						rejectedBy: 'SuperAdmin',
					}
				: r,
		);
		setDepositRequests(updatedRequests);

		try {
			await fetch('/api/billing', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'reject_deposit',
					requestId,
					tenantId: request.tenantId,
					reason,
					adminName: 'SuperAdmin',
				}),
			});
		} catch {}

		logAction(`Rejected deposit request ${requestId} (${reason})`, 'SuperAdmin', 'danger');
		showToast(`Deposit request rejected.`);
	};

	const grantAdminCredits = async (tenantId, amount, reason) => {
		const target = tenants.find((t) => t.id === tenantId);
		const currentBalance = Number(target?.creditsBalance) || 0;
		const newBalance = currentBalance + Number(amount);

		await updateTenant(tenantId, { creditsBalance: newBalance });

		const newTx = {
			id: `TX-${Date.now().toString().slice(-4)}`,
			tenantId,
			amount: Number(amount),
			balanceAfter: newBalance,
			type: Number(amount) >= 0 ? 'credit_grant' : 'debit_charge',
			method: 'Administrative Adjustment',
			reference: reason || 'SuperAdmin Manual Float Adjustment',
			timestamp: new Date().toISOString(),
		};
		const nextTxs = [newTx, ...creditTransactions];
		setCreditTransactions(nextTxs);

		try {
			await fetch('/api/billing', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'grant_credits',
					tenantId,
					amount: Number(amount),
					reason,
					adminName: 'SuperAdmin',
				}),
			});
		} catch {}

		logAction(`Admin adjusted credits ($${amount}) for ${target?.name}`, 'SuperAdmin', 'success');
		showToast(`Adjusted wallet balance by $${amount}.`);
	};

	const savePlatformSettings = async (newSettings) => {
		setPlatformSettings(newSettings);
		try {
			await fetch('/api/settings', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(newSettings),
			});
			logAction('SuperAdmin updated platform cluster settings', 'SuperAdmin', 'info');
			showToast('Cluster configuration saved.');
		} catch {
			showToast('Failed to save settings to server.', 'danger');
		}
	};

	const checkAppHealth = async (appUrl) => {
		try {
			const res = await fetch('/api/apps/health', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ url: appUrl }),
			});
			if (res.ok) {
				return await res.json();
			}
		} catch {}
		return { online: false, status: 'unreachable' };
	};

	const launchMicroApp = (product, tenant = activeTenant) => {
		if (!product) return;
		const launchUrl = getAppLaunchUrl(product?.url, tenant, product, product?.secretKey);
		window.open(launchUrl, '_blank', 'noopener,noreferrer');
		logAction(`Launched micro-app: ${product.name}`, currentUser?.email || 'User', 'info');
	};

	return (
		<PortalContext.Provider
			value={{
				currentUser,
				role: currentRole,
				setRole: setCurrentRole,
				hasAdmin,
				isAuthenticated,
				isLoading,
				products,
				tenants,
				selectedTenantId,
				setSelectedTenantId,
				activeTenant,
				depositRequests,
				creditTransactions,
				auditLogs,
				platformSettings,
				platformBankDetails: platformSettings.bankDetails,
				login,
				setupAdmin,
				logout,
				addTenant,
				updateTenant,
				rotateTenantKeys,
				deleteTenant,
				toggleTenantStatus,
				toggleMerchantProductFeature,
				addMerchantWebsite,
				deleteMerchantWebsite,
				toggleWebsiteFeature,
				updateFeaturePrice,
				registerProduct,
				deleteProduct,
				requestBankDeposit,
				approveDepositRequest,
				rejectDepositRequest,
				grantAdminCredits,
				savePlatformSettings,
				checkAppHealth,
				refreshAuditLogs,
				calculateWebsiteMonthlyFee,
				calculateMerchantMonthlyFee,
				launchMicroApp,
				showToast,
			}}>
			{children}

			{/* Toast Notification Container */}
			{toast && (
				<div className="fixed bottom-5 right-5 z-50 animate-slide-up">
					<div
						className={`px-4 py-3 rounded-2xl shadow-xl border text-xs font-bold flex items-center gap-2.5 ${
							toast.type === 'danger'
								? 'bg-rose-50 text-rose-800 border-rose-200'
								: toast.type === 'warning'
									? 'bg-amber-50 text-amber-800 border-amber-200'
									: 'bg-slate-900 text-white border-slate-800 shadow-slate-900/20'
						}`}>
						<span className="w-2 h-2 rounded-full bg-emerald-400" />
						<span>{toast.message}</span>
					</div>
				</div>
			)}
		</PortalContext.Provider>
	);
}
