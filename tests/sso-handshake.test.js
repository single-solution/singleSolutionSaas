import { describe, it, expect } from 'vitest';
import { createSSOToken, verifySSOToken, computeHMAC, getAppLaunchUrl } from '../shared/ui/auth/ssoHandshake.js';

describe('SSO Security Handshake & Cryptographic Verification', () => {
	const TEST_SECRET = '5741cfedc52b185a454653dd5b65c6b1c11b25d87e548e2012e19d35985a4636';

	it('computes deterministic HMAC signatures', () => {
		const msg = '{"tenantId":"tnt_test","productId":"analytics"}';
		const sig1 = computeHMAC(msg, TEST_SECRET);
		const sig2 = computeHMAC(msg, TEST_SECRET);
		expect(sig1).toBe(sig2);
		expect(typeof sig1).toBe('string');
		expect(sig1.length).toBe(32);
	});

	it('trims leading/trailing whitespace from secret keys automatically', () => {
		const msg = 'test_message';
		const cleanSig = computeHMAC(msg, TEST_SECRET);
		const untrimmedSig = computeHMAC(msg, `  ${TEST_SECRET} \n`);
		expect(untrimmedSig).toBe(cleanSig);
	});

	it('generates and verifies a valid SSO launch token', () => {
		const user = { id: 'usr_admin', name: 'SuperAdmin', role: 'admin' };
		const product = { id: 'analytics', name: 'Analytics Pro', secretKey: TEST_SECRET };
		const portalUrl = 'https://portal.singlesolution.app';

		const token = createSSOToken(user, product, TEST_SECRET, portalUrl);
		expect(typeof token).toBe('string');
		expect(token.includes('.')).toBe(true);

		const verification = verifySSOToken(token, {
			expectedProductId: 'analytics',
			expectedSecret: TEST_SECRET,
		});

		expect(verification.valid).toBe(true);
		expect(verification.session.tenantId).toBe('usr_admin');
		expect(verification.session.role).toBe('admin');
		expect(verification.session.productId).toBe('analytics');
		expect(verification.session.portalUrl).toBe(portalUrl);
		expect(verification.session.enabledFeatures).toEqual(['*']);
	});

	it('rejects tokens signed with a different or mismatched secret key', () => {
		const user = { id: 'usr_merchant', name: 'Merchant One', role: 'merchant' };
		const product = { id: 'analytics', name: 'Analytics' };
		const correctSecret = 'correct_secret_key_12345';
		const attackerSecret = 'attacker_forged_key_99999';

		const token = createSSOToken(user, product, attackerSecret);

		const verification = verifySSOToken(token, {
			expectedProductId: 'analytics',
			expectedSecret: correctSecret,
		});

		expect(verification.valid).toBe(false);
		expect(verification.error).toContain('Cryptographic signature mismatch');
	});

	it('rejects tokens intended for a different micro-app (audience mismatch)', () => {
		const user = { id: 'usr_admin', role: 'admin' };
		const product = { id: 'chatbot', name: 'AI Chatbot' };

		const token = createSSOToken(user, product, TEST_SECRET);

		const verification = verifySSOToken(token, {
			expectedProductId: 'seo',
			expectedSecret: TEST_SECRET,
		});

		expect(verification.valid).toBe(false);
		expect(verification.error).toContain('Token target mismatch');
	});

	it('rejects replayed tokens using the anti-replay nonce check', () => {
		const user = { id: 'usr_admin', role: 'admin' };
		const product = { id: 'automation', name: 'Automation' };

		const token = createSSOToken(user, product, TEST_SECRET);

		// First verification succeeds
		const firstAttempt = verifySSOToken(token, {
			expectedProductId: 'automation',
			expectedSecret: TEST_SECRET,
		});
		expect(firstAttempt.valid).toBe(true);

		// Second verification with the exact same nonce fails
		const replayAttempt = verifySSOToken(token, {
			expectedProductId: 'automation',
			expectedSecret: TEST_SECRET,
		});
		expect(replayAttempt.valid).toBe(false);
		expect(replayAttempt.error).toContain('Token replay detected');
	});

	it('constructs correct launch URLs with query parameters', () => {
		const user = { id: 'usr_portal_123', name: 'Test User', role: 'merchant' };
		const product = { id: 'loyalty', name: 'Loyalty Rewards', secretKey: TEST_SECRET };
		const baseUrl = 'https://loyalty.singlesolution.app';

		const launchUrl = getAppLaunchUrl(baseUrl, user, product, TEST_SECRET);
		const parsedUrl = new URL(launchUrl);

		expect(parsedUrl.origin).toBe('https://loyalty.singlesolution.app');
		expect(parsedUrl.searchParams.has('sso_token')).toBe(true);
		expect(parsedUrl.searchParams.get('product_id')).toBe('loyalty');
		expect(parsedUrl.searchParams.get('tenant_id')).toBe('usr_portal_123');
	});

	it('safely handles untrimmed base URLs and trailing slashes in launch URLs', () => {
		const user = { id: 'usr_portal_123', name: 'Test User', role: 'merchant' };
		const product = { id: 'loyalty', name: 'Loyalty Rewards', secretKey: TEST_SECRET };
		const messyBaseUrl = '  https://loyalty.singlesolution.app/  ';

		const launchUrl = getAppLaunchUrl(messyBaseUrl, user, product, TEST_SECRET);
		const parsedUrl = new URL(launchUrl);

		expect(parsedUrl.pathname).toBe('/');
		expect(parsedUrl.origin).toBe('https://loyalty.singlesolution.app');
		expect(parsedUrl.searchParams.has('sso_token')).toBe(true);
	});
});
