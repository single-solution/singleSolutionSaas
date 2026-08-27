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
});
