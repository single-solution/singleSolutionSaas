import React, { createContext, useContext, useState, useEffect } from 'react';

const PortalContext = createContext();

const DEFAULT_BANK_DETAILS = {
	bankName: 'Meezan Bank / Standard Chartered',
	accountTitle: 'SingleSolution SaaS Cloud Platform',
	accountNumber: '0102-0105678901',
	iban: 'PK36MEZN0001234567890123',
	swift: 'MEZNPKKA',
	instructions: 'Please include your Store Domain or Merchant ID in the transaction reference when transferring funds.',
};

export const SUITE_PRESET_PRODUCTS = [
	{
		id: 'analytics',
		name: 'Analytics Pro',
		icon: '📊',
		port: 5001,
		url: 'http://localhost:5001',
		version: 'v3.0.0',
		desc: 'Enterprise multi-store telemetry, Meta CAPI, GA4 server sync, and e-commerce funnel forensics.',
		features: [
			{
				id: 'realtime_telemetry',
				name: 'Real-Time Telemetry & Event Ingestion API',
				creditCost: 30,
				desc: 'Live event stream, REST ingestion API, and session journeys',
			},
			{
				id: 'funnel_dropoff',
				name: 'E-Commerce Funnel Forensics',
				creditCost: 35,
				desc: 'Cart abandonment analytics and 5-stage checkout drop-off',
			},
			{
				id: 'meta_capi',
				name: 'Meta Pixel & Facebook Conversions API (CAPI)',
				creditCost: 35,
				desc: 'Server-side purchase event dispatch with iOS 14+ deduplication',
			},
			{
				id: 'ga4_measurement',
				name: 'Google Analytics 4 Server Sync',
				creditCost: 30,
				desc: 'Server-side GA4 Measurement Protocol event dispatch',
			},
			{
				id: 'speed_vitals',
				name: 'Core Web Vitals Real-Device Telemetry',
				creditCost: 25,
				desc: 'Mobile P75 LCP, CLS, and INP performance monitoring',
			},
			{
				id: 'search_forensics',
				name: 'Search Intent & Zero-Result Lab',
				creditCost: 25,
				desc: 'Customer search discovery and zero-result missed sale tracking',
			},
			{
				id: 'cohort_reports',
				name: 'Customer Cohort Retention & LTV',
				creditCost: 35,
				desc: 'Longitudinal repeat purchase matrices and buyer lifetime value',
			},
			{
				id: 'custom_webhooks',
				name: 'Telemetry Webhooks & Dispatch',
				creditCost: 25,
				desc: 'Forward real-time purchase and visit events to external endpoints',
			},
		],
	},
	{
		id: 'chatbot',
		name: 'AI Chat Assistant',
		icon: '🤖',
		port: 5002,
		url: 'http://localhost:5002',
		version: 'v3.1.2',
		desc: 'Autonomous customer support agent with knowledge base ingestion and order lookup actions.',
		features: [
			{ id: 'ai_kb', name: 'Custom Knowledge Base Ingestion', creditCost: 40, desc: 'Upload PDFs/docs for AI training' },
			{ id: 'order_lookup', name: 'Order Tracking & CRM Lookup', creditCost: 35, desc: 'Live customer order status lookup' },
			{
				id: 'human_escalation',
				name: 'Human Agent Escalation',
				creditCost: 25,
				desc: 'Live routing to staff on WhatsApp/Slack',
			},
			{
				id: 'multilingual',
				name: 'Multilingual Urdu/Arabic/English',
				creditCost: 20,
				desc: 'Real-time auto language translation',
			},
		],
	},
	{
		id: 'seo',
		name: 'SEO Engine',
		icon: '🌐',
		port: 5003,
		url: 'http://localhost:5003',
		version: 'v1.8.4',
		desc: 'Automated on-page audits, dynamic XML sitemap generation, and AI meta-tag optimization.',
		features: [
			{ id: 'url_auditor', name: 'Live URL SEO Auditor', creditCost: 25, desc: 'On-page crawler and core web vital checks' },
			{ id: 'xml_sitemap', name: 'Dynamic XML Sitemap Builder', creditCost: 20, desc: 'Automated search engine indexing' },
			{
				id: 'schema_markup',
				name: 'JSON-LD Rich Snippet Schema',
				creditCost: 25,
				desc: 'Product rich snippets for Google Search',
			},
			{
				id: 'meta_generator',
				name: 'AI Meta Tags & Alt-text',
				creditCost: 20,
				desc: 'Automated SEO title and description generator',
			},
		],
	},
	{
		id: 'automation',
		name: 'Workflow Automator',
		icon: '⚡',
		port: 5004,
		url: 'http://localhost:5004',
		version: 'v2.0.1',
		desc: 'Visual event-driven workflow engine with webhook triggers and multi-channel actions.',
		features: [
			{
				id: 'webhook_triggers',
				name: 'Inbound Webhook Triggers',
				creditCost: 30,
				desc: 'Capture real-time events from any platform',
			},
			{ id: 'multi_step', name: 'Multi-Step Action Pipelines', creditCost: 40, desc: 'Chained workflow execution steps' },
			{
				id: 'slack_whatsapp',
				name: 'Slack & WhatsApp Instant Alerts',
				creditCost: 30,
				desc: 'Push notifications on store events',
			},
			{
				id: 'logic_branching',
				name: 'Conditional Branching Engine',
				creditCost: 30,
				desc: 'If/Else decision logic for workflows',
			},
		],
	},
	{
		id: 'loyalty',
		name: 'Loyalty & Rewards',
		icon: '💎',
		port: 5005,
		url: 'http://localhost:5005',
		version: 'v2.2.0',
		desc: 'Tiered loyalty point programs, VIP multipliers, and customer reward redemption store.',
		features: [
			{ id: 'vip_tiers', name: 'Tiered VIP Multipliers', creditCost: 30, desc: 'Bronze, Silver, Gold reward point rates' },
			{ id: 'voucher_store', name: 'Voucher Redemption Store', creditCost: 30, desc: 'Exchange points for discount coupons' },
			{
				id: 'referral_engine',
				name: 'Customer Referral Engine',
				creditCost: 25,
				desc: 'Track friend invitations and reward points',
			},
			{
				id: 'expiry_automation',
				name: 'Point Expiry Automations',
				creditCost: 20,
				desc: 'Auto-notify customers before points lapse',
			},
		],
	},
];

export function PortalProvider({ children }) {
	// ─── 1. AUTHENTICATION & ADMIN SETUP ────────────────────────
	const [adminUser, setAdminUser] = useState(() => {
		try {
			const saved = localStorage.getItem('saas_admin_user');
			return saved ? JSON.parse(saved) : null;
		} catch {
			return null;
		}
	});

	const [currentUser, setCurrentUser] = useState(() => {
		try {
			const saved = localStorage.getItem('saas_current_user');
			return saved ? JSON.parse(saved) : null;
		} catch {
			return null;
		}
	});

	// ─── 2. DOMAIN ENTITY STATES ────────────────────────────────
	const [products, setProducts] = useState(() => {
		try {
			const saved = localStorage.getItem('saas_products');
			if (saved) {
				const parsed = JSON.parse(saved);
				if (Array.isArray(parsed) && parsed.length > 0) {
					// Merge updated features if presets match
					return parsed.map((p) => {
						const preset = SUITE_PRESET_PRODUCTS.find((pr) => pr.id === p.id);
						return preset ? { ...p, features: preset.features } : p;
					});
				}
			}
			return [];
		} catch {
			return [];
		}
	});

	const [tenants, setTenants] = useState(() => {
		try {
			const saved = localStorage.getItem('saas_tenants');
			if (saved) {
				const parsed = JSON.parse(saved);
				return parsed.map((t) => ({
					...t,
					creditsBalance: typeof t.creditsBalance === 'number' ? t.creditsBalance : 0,
					subscriptions: t.subscriptions || {},
					products: Array.isArray(t.products) ? t.products : [],
				}));
			}
			return [];
		} catch {
			return [];
		}
	});

	const [depositRequests, setDepositRequests] = useState(() => {
		try {
			const saved = localStorage.getItem('saas_deposit_requests');
			return saved ? JSON.parse(saved) : [];
		} catch {
			return [];
		}
	});

	const [creditTransactions, setCreditTransactions] = useState(() => {
		try {
			const saved = localStorage.getItem('saas_credit_transactions');
			return saved ? JSON.parse(saved) : [];
		} catch {
			return [];
		}
	});

	const [platformBankDetails, setPlatformBankDetails] = useState(() => {
		try {
			const saved = localStorage.getItem('saas_bank_details');
			return saved ? JSON.parse(saved) : DEFAULT_BANK_DETAILS;
		} catch {
			return DEFAULT_BANK_DETAILS;
		}
	});

	const [auditLogs, setAuditLogs] = useState(() => {
		try {
			const saved = localStorage.getItem('saas_audit_logs');
			return saved ? JSON.parse(saved) : [];
		} catch {
			return [];
		}
	});

	const [currentRole, setCurrentRole] = useState(() => {
		return currentUser?.role || 'admin';
	});

	const [selectedTenantId, setSelectedTenantId] = useState(() => {
		return tenants[0]?.id || '';
	});

	const [toast, setToast] = useState(null);

	// ─── 3. PERSISTENCE EFFECTS ──────────────────────────────────
	useEffect(() => {
		try {
			if (adminUser) {
				localStorage.setItem('saas_admin_user', JSON.stringify(adminUser));
			} else {
				localStorage.removeItem('saas_admin_user');
			}
		} catch {}
	}, [adminUser]);

	useEffect(() => {
		try {
			if (currentUser) {
				localStorage.setItem('saas_current_user', JSON.stringify(currentUser));
			} else {
				localStorage.removeItem('saas_current_user');
			}
		} catch {}
	}, [currentUser]);

	useEffect(() => {
		try {
			localStorage.setItem('saas_tenants', JSON.stringify(tenants));
		} catch {}
	}, [tenants]);

	useEffect(() => {
		try {
			localStorage.setItem('saas_products', JSON.stringify(products));
		} catch {}
	}, [products]);

	useEffect(() => {
		try {
			localStorage.setItem('saas_deposit_requests', JSON.stringify(depositRequests));
		} catch {}
	}, [depositRequests]);

	useEffect(() => {
		try {
			localStorage.setItem('saas_credit_transactions', JSON.stringify(creditTransactions));
		} catch {}
	}, [creditTransactions]);

	useEffect(() => {
		try {
			localStorage.setItem('saas_bank_details', JSON.stringify(platformBankDetails));
		} catch {}
	}, [platformBankDetails]);

	useEffect(() => {
		try {
			localStorage.setItem('saas_audit_logs', JSON.stringify(auditLogs));
		} catch {}
	}, [auditLogs]);

	useEffect(() => {
		if (tenants.length > 0 && !tenants.some((t) => t.id === selectedTenantId)) {
			setSelectedTenantId(tenants[0].id);
		}
	}, [tenants, selectedTenantId]);

	// ─── 4. DERIVED CONTEXT ──────────────────────────────────────
	const hasAdmin = Boolean(adminUser);
	const isAuthenticated = Boolean(currentUser);
	const activeTenant = tenants.find((t) => t.id === selectedTenantId) || tenants[0] || null;

	const calculateMerchantMonthlyFee = (tenant) => {
		if (!tenant) return 0;
		const tenantSubs = tenant.subscriptions || {};
		let total = 0;

		products.forEach((prod) => {
			const activeFeatureIds = tenantSubs[prod.id] || [];
			if (Array.isArray(prod.features)) {
				prod.features.forEach((feat) => {
					if (activeFeatureIds.includes(feat.id)) {
						total += Number(feat.creditCost) || 0;
					}
				});
			}
		});

		return total;
	};

	const showToast = (message, type = 'success') => {
		setToast({ message, type });
		setTimeout(() => setToast(null), 3500);
	};

	const logAction = (action, target, type = 'info') => {
		const newLog = {
			id: Date.now(),
			timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
			actor: currentRole === 'admin' ? adminUser?.name || 'SuperAdmin' : `Merchant (${activeTenant?.name || 'Store'})`,
			action,
			target,
			type,
		};
		setAuditLogs((prev) => [newLog, ...prev]);
	};

	const setupAdmin = ({ name, email, password, orgName }) => {
		const newAdmin = {
			id: `adm_${Date.now()}`,
			name: name.trim(),
			email: email.trim().toLowerCase(),
			password,
			orgName: orgName.trim() || 'SingleSolution Platform',
			createdAt: new Date().toISOString(),
		};
		setAdminUser(newAdmin);
		const sessionUser = {
			id: newAdmin.id,
			name: newAdmin.name,
			email: newAdmin.email,
			role: 'admin',
			orgName: newAdmin.orgName,
		};
		setCurrentUser(sessionUser);
		setCurrentRole('admin');
		logAction('Initialized SuperAdmin account', newAdmin.email, 'success');
		showToast(`Welcome ${newAdmin.name}! Your admin account is ready.`);
		return newAdmin;
	};

	const login = (email, password, role = 'admin') => {
		const cleanEmail = email.trim().toLowerCase();

		if (role === 'admin') {
			if (!adminUser) {
				throw new Error('No SuperAdmin account configured. Please complete setup first.');
			}
			if (adminUser.email !== cleanEmail || adminUser.password !== password) {
				throw new Error('Invalid SuperAdmin email or password.');
			}
			const sessionUser = {
				id: adminUser.id,
				name: adminUser.name,
				email: adminUser.email,
				role: 'admin',
				orgName: adminUser.orgName,
			};
			setCurrentUser(sessionUser);
			setCurrentRole('admin');
			logAction('SuperAdmin logged in', adminUser.email, 'info');
			showToast(`Signed in as ${adminUser.name}`);
			return sessionUser;
		}

		const targetTenant = tenants.find((t) => t.email.toLowerCase() === cleanEmail);
		if (!targetTenant) {
			throw new Error('No merchant account registered with this email address.');
		}
		if (targetTenant.password && targetTenant.password !== password) {
			throw new Error('Incorrect merchant password. Please check your credentials.');
		}
		if (targetTenant.status === 'suspended') {
			throw new Error('This merchant account is suspended. Please contact platform administration.');
		}

		const sessionUser = {
			id: targetTenant.id,
			name: targetTenant.name,
			email: targetTenant.email,
			role: 'merchant',
			domain: targetTenant.domain,
			subscriptions: targetTenant.subscriptions || {},
			creditsBalance: targetTenant.creditsBalance || 0,
			apiKey: targetTenant.apiKey || '',
			secretKey: targetTenant.secretKey || '',
		};
		setCurrentUser(sessionUser);
		setCurrentRole('merchant');
		setSelectedTenantId(targetTenant.id);
		logAction(`Merchant logged into store: ${targetTenant.name}`, targetTenant.domain, 'info');
		showToast(`Signed in to ${targetTenant.name}`);
		return sessionUser;
	};

	const logout = () => {
		const userName = currentUser?.name || 'User';
		setCurrentUser(null);
		logAction('User logged out', userName, 'info');
		showToast('Signed out successfully.');
	};

	const addTenant = (tenantData) => {
		const slug = tenantData.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
		const initialCredits = Number(tenantData.initialCredits) || 0;

		const initialSubscriptions = {};
		products.forEach((prod) => {
			if (Array.isArray(prod.features)) {
				initialSubscriptions[prod.id] = prod.features.map((f) => f.id);
			}
		});

		const newTenant = {
			id: `tnt_${slug}_${Math.random().toString(36).substring(2, 6)}`,
			name: tenantData.name.trim(),
			domain: tenantData.domain?.trim() || `${slug}.com`,
			email: tenantData.email.trim().toLowerCase(),
			password: tenantData.password?.trim() || 'merchant123',
			plan: tenantData.plan || 'pro',
			status: 'active',
			mrr: tenantData.plan === 'enterprise' ? 1200 : tenantData.plan === 'pro' ? 450 : 99,
			creditsBalance: initialCredits,
			products: products.map((p) => p.id),
			subscriptions: initialSubscriptions,
			apiKey: `pk_live_${Math.random().toString(36).substring(2, 14)}`,
			secretKey: `sk_live_${Math.random().toString(36).substring(2, 14)}`,
			webhookUrl: tenantData.webhookUrl || '',
			usage: { apiCalls: 0, tokens: 0, storageMb: 10 },
			createdAt: new Date().toISOString().split('T')[0],
		};

		setTenants((prev) => [newTenant, ...prev]);
		setSelectedTenantId(newTenant.id);

		if (initialCredits > 0) {
			const initTx = {
				id: `TX-${Date.now()}`,
				tenantId: newTenant.id,
				tenantName: newTenant.name,
				type: 'deposit',
				amount: initialCredits,
				balanceAfter: initialCredits,
				method: 'Account Initialization Credit',
				reference: 'INIT-TOPUP',
				timestamp: new Date().toISOString().split('T')[0],
			};
			setCreditTransactions((prev) => [initTx, ...prev]);
		}

		logAction(`Created merchant account: ${newTenant.name}`, newTenant.id, 'success');
		showToast(`Merchant "${newTenant.name}" created successfully.`);
		return newTenant;
	};

	const updateTenant = (tenantId, updates) => {
		setTenants((prev) =>
			prev.map((t) =>
				t.id === tenantId
					? {
							...t,
							...updates,
							email: updates.email ? updates.email.trim().toLowerCase() : t.email,
						}
					: t,
			),
		);
		logAction(`Updated merchant properties for ${tenantId}`, JSON.stringify(updates), 'info');
		showToast('Merchant updated successfully.');
	};

	const toggleTenantStatus = (tenantId) => {
		setTenants((prev) =>
			prev.map((t) => {
				if (t.id === tenantId) {
					const nextStatus = t.status === 'active' ? 'suspended' : 'active';
					logAction(`Changed merchant status to ${nextStatus}`, t.name, nextStatus === 'active' ? 'success' : 'danger');
					showToast(`Merchant ${t.name} is now ${nextStatus}.`);
					return { ...t, status: nextStatus };
				}
				return t;
			}),
		);
	};

	const toggleMerchantProductFeature = (tenantId, productId, featureId) => {
		let updatedTenant = null;

		setTenants((prev) =>
			prev.map((t) => {
				if (t.id === tenantId) {
					const subs = { ...(t.subscriptions || {}) };
					const currentFeatures = subs[productId] || [];
					const hasFeature = currentFeatures.includes(featureId);

					const nextFeatures = hasFeature ? currentFeatures.filter((f) => f !== featureId) : [...currentFeatures, featureId];

					subs[productId] = nextFeatures;

					let nextProducts = Array.isArray(t.products) ? [...t.products] : [];
					if (nextFeatures.length > 0 && !nextProducts.includes(productId)) {
						nextProducts.push(productId);
					} else if (nextFeatures.length === 0 && nextProducts.includes(productId)) {
						nextProducts = nextProducts.filter((p) => p !== productId);
					}

					updatedTenant = {
						...t,
						subscriptions: subs,
						products: nextProducts,
					};

					updatedTenant.mrr = calculateMerchantMonthlyFee(updatedTenant);

					logAction(
						hasFeature ? `Disabled feature: ${featureId} in ${productId}` : `Enabled feature: ${featureId} in ${productId}`,
						t.name,
						hasFeature ? 'warning' : 'success',
					);
					showToast(`${hasFeature ? 'Disabled' : 'Enabled'} feature for ${t.name}.`);

					return updatedTenant;
				}
				return t;
			}),
		);

		if (currentUser && currentUser.id === tenantId && updatedTenant) {
			const nextSession = {
				...currentUser,
				subscriptions: updatedTenant.subscriptions,
			};
			setCurrentUser(nextSession);
		}
	};

	const toggleTenantProduct = (tenantId, productId) => {
		const targetProduct = products.find((p) => p.id === productId);
		const allFeatureIds = Array.isArray(targetProduct?.features) ? targetProduct.features.map((f) => f.id) : ['core'];

		setTenants((prev) =>
			prev.map((t) => {
				if (t.id === tenantId) {
					const subs = { ...(t.subscriptions || {}) };
					const hasProduct = t.products?.includes(productId);

					let nextProducts = Array.isArray(t.products) ? [...t.products] : [];
					if (hasProduct) {
						nextProducts = nextProducts.filter((p) => p !== productId);
						subs[productId] = [];
					} else {
						nextProducts.push(productId);
						subs[productId] = allFeatureIds;
					}

					const updated = {
						...t,
						products: nextProducts,
						subscriptions: subs,
					};
					updated.mrr = calculateMerchantMonthlyFee(updated);

					logAction(
						hasProduct ? `Revoked product: ${productId}` : `Activated product: ${productId}`,
						t.name,
						hasProduct ? 'warning' : 'success',
					);
					showToast(`${hasProduct ? 'Deactivated' : 'Activated'} ${targetProduct?.name || productId}.`);
					return updated;
				}
				return t;
			}),
		);
	};

	const registerProduct = (productData) => {
		const slug = productData.id || productData.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
		const defaultFeatures = [
			{ id: 'core', name: 'Core Application Engine', creditCost: Number(productData.price) || 50, desc: 'Base functionality' },
			{ id: 'analytics', name: 'Usage Analytics & Logs', creditCost: 25, desc: 'Real-time telemetry and auditing' },
			{ id: 'webhooks', name: 'Webhook Integration Hooks', creditCost: 20, desc: 'Automated event triggers' },
		];

		const newProduct = {
			id: slug,
			name: productData.name.trim(),
			icon: productData.icon || '🚀',
			url: productData.url.trim(),
			port: productData.port || 5000,
			status: 'operational',
			version: productData.version || 'v1.0.0',
			desc: productData.desc?.trim() || 'Custom registered SaaS micro-application.',
			features: productData.features || defaultFeatures,
		};

		setProducts((prev) => {
			const filtered = prev.filter((p) => p.id !== newProduct.id);
			return [...filtered, newProduct];
		});

		logAction(`Registered SaaS micro-app: ${newProduct.name}`, newProduct.url, 'success');
		showToast(`Registered app "${newProduct.name}".`);
		return newProduct;
	};

	const deleteProduct = (productId) => {
		const target = products.find((p) => p.id === productId);
		setProducts((prev) => prev.filter((p) => p.id !== productId));
		logAction(`Removed SaaS micro-app: ${target?.name || productId}`, productId, 'warning');
		showToast(`Removed app "${target?.name || productId}".`);
	};

	const updateProductFeatureCost = (productId, featureId, newCreditCost) => {
		const costNum = Number(newCreditCost);
		if (isNaN(costNum) || costNum < 0) return;

		setProducts((prev) =>
			prev.map((p) => {
				if (p.id === productId && Array.isArray(p.features)) {
					return {
						...p,
						features: p.features.map((f) => (f.id === featureId ? { ...f, creditCost: costNum } : f)),
					};
				}
				return p;
			}),
		);

		logAction(`Updated credit cost for ${featureId} to $${costNum}`, productId, 'info');
		showToast('Feature credit pricing updated.');
	};

	const addProductFeature = (productId, newFeature) => {
		if (!newFeature.name || !newFeature.id) return;
		setProducts((prev) =>
			prev.map((p) => {
				if (p.id === productId) {
					const existing = Array.isArray(p.features) ? p.features : [];
					return {
						...p,
						features: [...existing, newFeature],
					};
				}
				return p;
			}),
		);
		showToast(`Added feature "${newFeature.name}" to product.`);
	};

	const regenerateApiKey = (tenantId, keyType = 'apiKey') => {
		const prefix = keyType === 'secretKey' ? 'sk_live_' : 'pk_live_';
		const newKey = `${prefix}${Math.random().toString(36).substring(2, 14)}`;

		setTenants((prev) => prev.map((t) => (t.id === tenantId ? { ...t, [keyType]: newKey } : t)));
		logAction(`Regenerated ${keyType} credential`, activeTenant?.name || tenantId, 'warning');
		showToast(`Regenerated ${keyType === 'secretKey' ? 'Secret Key' : 'Publishable Key'}.`);
		return newKey;
	};

	const deleteTenant = (tenantId) => {
		const target = tenants.find((t) => t.id === tenantId);
		setTenants((prev) => prev.filter((t) => t.id !== tenantId));
		logAction('Deleted merchant account', target?.name || tenantId, 'danger');
		showToast(`Merchant ${target?.name || tenantId} deleted.`);
	};

	const requestBankDeposit = ({ tenantId, amount, transactionRef, notes, bankName }) => {
		const target = tenants.find((t) => t.id === tenantId) || activeTenant;
		if (!target) throw new Error('Merchant account not found.');

		const newRequest = {
			id: `DEP-${Date.now().toString().slice(-6)}`,
			tenantId: target.id,
			tenantName: target.name,
			amount: Number(amount),
			bankName: bankName || 'Bank Transfer',
			transactionRef: transactionRef.trim(),
			notes: notes?.trim() || '',
			status: 'pending',
			submittedAt: new Date().toISOString().split('T')[0],
		};

		setDepositRequests((prev) => [newRequest, ...prev]);
		logAction(`Submitted bank transfer top-up request of $${newRequest.amount}`, target.name, 'info');
		showToast(`Deposit request ${newRequest.id} submitted for Admin verification.`);
		return newRequest;
	};

	const approveDepositRequest = (requestId) => {
		const req = depositRequests.find((r) => r.id === requestId);
		if (!req || req.status !== 'pending') return;

		let newBalance = 0;
		setTenants((prev) =>
			prev.map((t) => {
				if (t.id === req.tenantId) {
					newBalance = (t.creditsBalance || 0) + req.amount;
					return { ...t, creditsBalance: newBalance };
				}
				return t;
			}),
		);

		setDepositRequests((prev) =>
			prev.map((r) =>
				r.id === requestId ? { ...r, status: 'approved', reviewedAt: new Date().toISOString().split('T')[0] } : r,
			),
		);

		const tx = {
			id: `TX-${Date.now()}`,
			tenantId: req.tenantId,
			tenantName: req.tenantName,
			type: 'deposit',
			amount: req.amount,
			balanceAfter: newBalance,
			method: 'Bank Wire Transfer',
			reference: req.transactionRef,
			timestamp: new Date().toISOString().split('T')[0],
		};

		setCreditTransactions((prev) => [tx, ...prev]);
		logAction(`Approved bank deposit request ${req.id} (+$${req.amount})`, req.tenantName, 'success');
		showToast(`Approved deposit of $${req.amount} for ${req.tenantName}.`);
	};

	const rejectDepositRequest = (requestId, reason) => {
		const req = depositRequests.find((r) => r.id === requestId);
		if (!req || req.status !== 'pending') return;

		setDepositRequests((prev) =>
			prev.map((r) =>
				r.id === requestId
					? {
							...r,
							status: 'rejected',
							reason: reason || 'Unverified bank wire',
							reviewedAt: new Date().toISOString().split('T')[0],
						}
					: r,
			),
		);

		logAction(`Rejected deposit request ${req.id}: ${reason || 'Unverified'}`, req.tenantName, 'warning');
		showToast(`Deposit request ${req.id} rejected.`);
	};

	const adjustMerchantCredits = (tenantId, amount, reason = 'Manual Admin Adjustment') => {
		const delta = Number(amount);
		if (isNaN(delta) || delta === 0) return;

		let targetMerchant = null;
		let newBalance = 0;

		setTenants((prev) =>
			prev.map((t) => {
				if (t.id === tenantId) {
					targetMerchant = t;
					newBalance = Math.max(0, (t.creditsBalance || 0) + delta);
					return { ...t, creditsBalance: newBalance };
				}
				return t;
			}),
		);

		const tx = {
			id: `TX-${Date.now()}`,
			tenantId,
			tenantName: targetMerchant?.name || 'Merchant',
			type: delta > 0 ? 'deposit' : 'deduction',
			amount: Math.abs(delta),
			balanceAfter: newBalance,
			method: 'SuperAdmin Adjustment',
			reference: reason,
			timestamp: new Date().toISOString().split('T')[0],
		};

		setCreditTransactions((prev) => [tx, ...prev]);
		logAction(
			`Adjusted credits by ${delta > 0 ? '+' : ''}$${delta} (${reason})`,
			targetMerchant?.name || tenantId,
			delta > 0 ? 'success' : 'warning',
		);
		showToast(`Updated credit balance for ${targetMerchant?.name || 'Merchant'}.`);
	};

	const updateBankDetails = (newDetails) => {
		setPlatformBankDetails((prev) => ({ ...prev, ...newDetails }));
		logAction('Updated platform bank deposit instructions', 'Platform Configuration', 'info');
		showToast('Bank transfer details saved.');
	};

	const clearAllData = () => {
		setTenants([]);
		setDepositRequests([]);
		setCreditTransactions([]);
		setProducts([]);
		setAuditLogs([]);
		localStorage.removeItem('saas_tenants');
		localStorage.removeItem('saas_deposit_requests');
		localStorage.removeItem('saas_credit_transactions');
		localStorage.removeItem('saas_products');
		localStorage.removeItem('saas_audit_logs');
		showToast('Cleared all platform and credit data.');
	};

	return (
		<PortalContext.Provider
			value={{
				adminUser,
				currentUser,
				hasAdmin,
				isAuthenticated,
				setupAdmin,
				login,
				logout,
				tenants,
				products,
				registerProduct,
				deleteProduct,
				updateProductFeatureCost,
				addProductFeature,
				toggleMerchantProductFeature,
				calculateMerchantMonthlyFee,
				depositRequests,
				creditTransactions,
				platformBankDetails,
				requestBankDeposit,
				approveDepositRequest,
				rejectDepositRequest,
				adjustMerchantCredits,
				updateBankDetails,
				role: currentRole,
				setRole: setCurrentRole,
				currentRole,
				setCurrentRole,
				selectedTenantId,
				setSelectedTenantId,
				activeTenant,
				addTenant,
				updateTenant,
				toggleTenantStatus,
				toggleTenantProduct,
				regenerateApiKey,
				deleteTenant,
				clearAllData,
				logAction,
				toast,
				showToast,
			}}>
			{children}
		</PortalContext.Provider>
	);
}

export function usePortal() {
	const context = useContext(PortalContext);
	if (!context) {
		throw new Error('usePortal must be used within a PortalProvider');
	}
	return context;
}
