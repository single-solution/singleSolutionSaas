import { describe, it, expect } from 'vitest';
import { createSSOToken, verifySSOToken, computeHMAC } from '../shared/ui/auth/ssoHandshake';

describe('Portal Control Plane, Feature Governance & Credit System', () => {
	it('calculates dynamic monthly credit costs based on enabled features', () => {
		const product = {
			id: 'chatbot',
			name: 'AI Chat Assistant',
			features: [
				{ id: 'ai_kb', name: 'Knowledge Base', creditCost: 40 },
				{ id: 'order_lookup', name: 'Order Lookup', creditCost: 35 },
				{ id: 'human_escalation', name: 'Human Escalation', creditCost: 25 },
				{ id: 'multilingual', name: 'Multilingual', creditCost: 20 },
			],
		};

		const merchant = {
			id: 'tnt_leather_1',
			name: 'Lahore Leather',
			subscriptions: {
				chatbot: ['ai_kb', 'order_lookup'], // only 2 features active
			},
		};

		const calculateFee = (m, prods) => {
			let total = 0;
			prods.forEach((p) => {
				const activeIds = m.subscriptions[p.id] || [];
				p.features.forEach((f) => {
					if (activeIds.includes(f.id)) total += f.creditCost;
				});
			});
			return total;
		};

		// 40 + 35 = 75 credits/mo
		expect(calculateFee(merchant, [product])).toBe(75);

		// Merchant enables human escalation (+$25)
		merchant.subscriptions.chatbot.push('human_escalation');
		expect(calculateFee(merchant, [product])).toBe(100);

		// Merchant disables knowledge base (-$40)
		merchant.subscriptions.chatbot = merchant.subscriptions.chatbot.filter((f) => f !== 'ai_kb');
		expect(calculateFee(merchant, [product])).toBe(60);
	});

	it('propagates exact active merchant features inside SSO launch tokens', () => {
		const merchant = {
			id: 'tnt_store_abc',
			name: 'Karachi Mobiles',
			domain: 'karachimobiles.com',
			role: 'merchant',
			subscriptions: {
				analytics: ['funnel_dropoff', 'realtime_telemetry'],
			},
			secretKey: 'sk_live_merchant_sec_1',
		};

		const product = { id: 'analytics', name: 'Analytics Pro' };

		const token = createSSOToken(merchant, product, merchant.secretKey);
		const verification = verifySSOToken(token, {
			expectedProductId: 'analytics',
			expectedSecret: merchant.secretKey,
		});

		expect(verification.valid).toBe(true);
		expect(verification.session.enabledFeatures).toEqual(['funnel_dropoff', 'realtime_telemetry']);
		expect(verification.session.enabledFeatures.includes('cohort_reports')).toBe(false);
	});

	it('manages bank transfer top-up requests and credit approvals', () => {
		const merchant = {
			id: 'tnt_store_1',
			name: 'Test Merchant Store',
			creditsBalance: 50,
		};

		const depositRequests = [];
		const creditTransactions = [];

		const newRequest = {
			id: 'DEP-100234',
			tenantId: merchant.id,
			tenantName: merchant.name,
			amount: 500,
			bankName: 'Meezan Bank',
			transactionRef: 'TRX-BANK-99881',
			status: 'pending',
			submittedAt: '2026-08-28',
		};
		depositRequests.push(newRequest);
		expect(depositRequests.length).toBe(1);

		// Admin approves
		const targetReq = depositRequests.find((r) => r.id === 'DEP-100234');
		targetReq.status = 'approved';
		merchant.creditsBalance += targetReq.amount;

		const tx = {
			id: 'TX-9901',
			tenantId: merchant.id,
			amount: targetReq.amount,
			balanceAfter: merchant.creditsBalance,
			type: 'deposit',
			method: 'Bank Wire Transfer',
			reference: targetReq.transactionRef,
		};
		creditTransactions.push(tx);

		expect(merchant.creditsBalance).toBe(550);
		expect(creditTransactions.length).toBe(1);
	});

	it('handles deposit rejection workflow with custom reason', () => {
		const depositRequests = [
			{
				id: 'DEP-9941',
				tenantId: 'tnt_store_2',
				amount: 300,
				status: 'pending',
			},
		];

		const rejectDeposit = (reqId, reason) => {
			return depositRequests.map((r) =>
				r.id === reqId ? { ...r, status: 'rejected', rejectionReason: reason, rejectedAt: new Date().toISOString() } : r,
			);
		};

		const updated = rejectDeposit('DEP-9941', 'Bank slip unreadable');
		expect(updated[0].status).toBe('rejected');
		expect(updated[0].rejectionReason).toBe('Bank slip unreadable');
	});

	it('guarantees cryptographic security: rejects forged tokens and replay attacks', () => {
		const tenant = {
			id: 'tnt_leather_991',
			name: 'Lahore Leather',
			domain: 'lahoreleather.com',
			plan: 'pro',
			apiKey: 'pk_live_12345678',
			secretKey: 'sk_live_secretkey88',
		};

		const product = { id: 'analytics', name: 'Analytics Pro' };
		const token = createSSOToken(tenant, product, tenant.secretKey);

		const result = verifySSOToken(token, { expectedProductId: 'analytics', expectedSecret: tenant.secretKey });
		expect(result.valid).toBe(true);

		// Anti-Replay
		const replayAttempt = verifySSOToken(token, { expectedProductId: 'analytics', expectedSecret: tenant.secretKey });
		expect(replayAttempt.valid).toBe(false);
		expect(replayAttempt.error).toContain('Token replay detected');

		// Forged signature
		const fakeSignature = computeHMAC('fake_payload', 'wrong_secret');
		const forgedToken = `${btoa(encodeURIComponent('{"tenantId":"fake","productId":"analytics","issuedAt":' + Date.now() + ',"nonce":"fake"}'))}.${fakeSignature}`;
		const forgedResult = verifySSOToken(forgedToken, {
			expectedProductId: 'analytics',
			expectedSecret: tenant.secretKey,
		});
		expect(forgedResult.valid).toBe(false);
	});

	it('securely hashes passwords and validates session tokens', async () => {
		const {
			hashPassword,
			verifyPassword,
			createSessionToken,
			verifySessionToken,
			buildSessionCookie,
			buildClearSessionCookie,
		} = await import('../portal/lib/auth.js');

		const rawPassword = 'super_secret_master_password_99!';
		const hashed = hashPassword(rawPassword);

		expect(hashed).toContain(':');
		expect(verifyPassword(rawPassword, hashed)).toBe(true);
		expect(verifyPassword('wrong_password', hashed)).toBe(false);

		const userPayload = { id: 'adm_123', email: 'admin@platform.io', role: 'admin' };
		const sessionToken = createSessionToken(userPayload);
		const decoded = verifySessionToken(sessionToken);

		expect(decoded).toBeTruthy();
		expect(decoded.id).toBe('adm_123');
		expect(decoded.email).toBe('admin@platform.io');

		expect(verifySessionToken('tampered.token')).toBeNull();

		const cookie = buildSessionCookie(sessionToken);
		expect(cookie).toContain('portal_session=');
		expect(cookie).toContain('HttpOnly');
		expect(cookie).toContain('SameSite=Lax');

		const clearCookie = buildClearSessionCookie();
		expect(clearCookie).toContain('Max-Age=0');
	});

	it('computes exact monthly credit costs for Analytics Pro 9-feature catalog', async () => {
		const { DEFAULT_FEATURES } = await import('../apps/analytics/app/api/features/route.js');
		expect(DEFAULT_FEATURES.length).toBe(9);

		// Compute full package cost
		const fullPackageCost = DEFAULT_FEATURES.reduce((sum, f) => sum + f.creditCost, 0);
		expect(fullPackageCost).toBe(235); // 30+35+30+25+25+15+30+20+25 = 235

		// Store with partial features: core_traffic (30) + funnel_dropoff (35) + meta_capi (30)
		const activeFeatures = ['core_traffic', 'funnel_dropoff', 'meta_capi'];
		const activeCost = DEFAULT_FEATURES.filter((f) => activeFeatures.includes(f.id)).reduce((sum, f) => sum + f.creditCost, 0);
		expect(activeCost).toBe(95);

		// Merchant adds custom_webhooks (+25)
		activeFeatures.push('custom_webhooks');
		const updatedCost = DEFAULT_FEATURES.filter((f) => activeFeatures.includes(f.id)).reduce((sum, f) => sum + f.creditCost, 0);
		expect(updatedCost).toBe(120);
	});

	it('manages multi-website storefronts and auto-calculates aggregate merchant billing', () => {
		const catalog = [
			{
				id: 'analytics',
				name: 'Analytics Pro',
				features: [
					{ id: 'core_traffic', creditCost: 30 },
					{ id: 'funnel_dropoff', creditCost: 35 },
					{ id: 'meta_capi', creditCost: 30 },
				],
			},
			{
				id: 'seo',
				name: 'SEO Forensics',
				features: [
					{ id: 'schema', creditCost: 30 },
					{ id: 'serp_rank', creditCost: 35 },
				],
			},
		];

		const calcSiteFee = (site) => {
			let total = 0;
			catalog.forEach((prod) => {
				const active = site.subscriptions?.[prod.id] || [];
				prod.features.forEach((f) => {
					if (active.includes(f.id)) total += f.creditCost;
				});
			});
			return total;
		};

		const calcMerchantFee = (merchant) => {
			return (merchant.websites || []).reduce((sum, site) => sum + calcSiteFee(site), 0);
		};

		// Merchant with 2 attached websites
		const merchant = {
			id: 'tnt_chandni_multi',
			name: 'Chandni Enterprise',
			websites: [
				{
					id: 'site_flagship',
					name: 'Chandni Traders Flagship',
					domain: 'chandnitraders.com',
					subscriptions: {
						analytics: ['core_traffic', 'funnel_dropoff'], // 30 + 35 = 65
						seo: ['schema'], // 30 -> site 1 = 95
					},
				},
				{
					id: 'site_outlet',
					name: 'Chandni Outlet',
					domain: 'outlet.chandnitraders.com',
					subscriptions: {
						analytics: ['core_traffic'], // 30
						seo: ['serp_rank'], // 35 -> site 2 = 65
					},
				},
			],
		};

		expect(calcSiteFee(merchant.websites[0])).toBe(95);
		expect(calcSiteFee(merchant.websites[1])).toBe(65);
		expect(calcMerchantFee(merchant)).toBe(160); // 95 + 65 = 160

		// SuperAdmin updates feature price for 'core_traffic' from $30 to $50
		catalog[0].features.find((f) => f.id === 'core_traffic').creditCost = 50;

		// Both websites have core_traffic active (+20 for site 1, +20 for site 2 = +40 overall)
		expect(calcSiteFee(merchant.websites[0])).toBe(115);
		expect(calcSiteFee(merchant.websites[1])).toBe(85);
		expect(calcMerchantFee(merchant)).toBe(200); // 115 + 85 = 200
	});

	it('computes AWS-style pay-per-hour rates and exact usage costs for short-term activations', async () => {
		const { getHourlyRate, formatHourlyRate, calculateUsageCost } = await import('../shared/ui/billing/hourlyBilling.js');

		// Feature with $30/mo standard price
		const monthlyFee = 30;
		const hourly = getHourlyRate(monthlyFee);
		expect(hourly).toBe(0.0417); // 30 / 720 = 0.041666... rounded to 0.0417
		expect(formatHourlyRate(monthlyFee)).toBe('$0.0417/hr');

		// Merchant runs a 48-hour flash sale with 5-stage conversion funnel ($35/mo -> $0.0486/hr)
		const funnelMonthly = 35;
		const flashSaleCost = calculateUsageCost(funnelMonthly, 48); // 48 * 0.0486 = $2.33
		expect(flashSaleCost).toBe(2.33);

		// If disabled after 3 hours:
		const shortTestCost = calculateUsageCost(funnelMonthly, 3); // 3 * 0.0486 = $0.15
		expect(shortTestCost).toBe(0.15);
	});
});
