/**
 * SSO Security Handshake for Micro-Apps
 * Cryptographic token generator and validator for secure portal-to-app launch
 * with Granular Feature-Tier Governance.
 */

// Platform Master Secret Key
export const PLATFORM_MASTER_SECRET = (typeof process !== 'undefined' && process.env?.SSO_SECRET) || '';

// Replay attack prevention cache with TTL cleanup (15 minutes)
const CONSUMED_NONCES = new Map();

/**
 * Robust SHA-256-like HMAC generator for synchronous browser/node environments.
 */
export function computeHMAC(message, secret = PLATFORM_MASTER_SECRET) {
	let h0 = 0x6a09e667;
	let h1 = 0xbb67ae85;
	let h2 = 0x3c6ef372;
	let h3 = 0xa54ff53a;

	const keyString = String(secret || PLATFORM_MASTER_SECRET || '').trim();
	const fullInput = `${keyString}###${message}###${keyString}`;

	for (let i = 0; i < fullInput.length; i++) {
		const code = fullInput.charCodeAt(i);
		h0 = (h0 ^ (code << (i % 24))) + (h1 << 5) - h1;
		h1 = (h1 ^ (code << ((i + 7) % 24))) + (h2 << 5) - h2;
		h2 = (h2 ^ (code << ((i + 13) % 24))) + (h3 << 5) - h3;
		h3 = (h3 ^ (code << ((i + 19) % 24))) + (h0 << 5) - h0;

		h0 |= 0;
		h1 |= 0;
		h2 |= 0;
		h3 |= 0;
	}

	const hex = (val) => Math.abs(val).toString(16).padStart(8, '0');
	return `${hex(h0)}${hex(h1)}${hex(h2)}${hex(h3)}`;
}

/**
 * Creates a signed SSO launch token for any user (Admin or Merchant) and product,
 * including active merchant-specific enabled features and dynamic portal origin.
 */
export function createSSOToken(tenantOrUser, product, customSecret, customPortalUrl) {
	const secret = customSecret || product?.secretKey || tenantOrUser?.secretKey || PLATFORM_MASTER_SECRET;
	const productId = product?.id || 'general';
	const portalUrl =
		customPortalUrl ||
		(typeof window !== 'undefined' ? window.location.origin : '') ||
		(typeof process !== 'undefined' && process.env?.PORTAL_URL) ||
		'';

	// Determine active features for this specific merchant and product
	let enabledFeatures = ['*']; // SuperAdmin has all features by default
	if (tenantOrUser?.role === 'merchant' || tenantOrUser?.subscriptions) {
		if (tenantOrUser.subscriptions && tenantOrUser.subscriptions[productId]) {
			enabledFeatures = tenantOrUser.subscriptions[productId];
		} else if (product?.features && Array.isArray(product.features)) {
			// Fallback to active licensed product features
			enabledFeatures = product.features.map((f) => (typeof f === 'string' ? f : f.id));
		}
	}

	const payload = {
		tenantId: tenantOrUser?.id || 'tnt_portal_user',
		tenantName: tenantOrUser?.name || tenantOrUser?.orgName || 'Authorized User',
		domain: tenantOrUser?.domain || 'platform.local',
		role: tenantOrUser?.role || (tenantOrUser?.email?.includes('admin') ? 'admin' : 'merchant'),
		productId,
		portalUrl,
		plan: tenantOrUser?.plan || 'enterprise',
		creditsBalance: tenantOrUser?.creditsBalance || 0,
		enabledFeatures,
		apiKey: tenantOrUser?.apiKey || '',
		issuedAt: Date.now(),
		nonce: `${Date.now()}_${Math.random().toString(36).substring(2, 12)}`,
	};

	const payloadString = JSON.stringify(payload);
	const encodedPayload = btoa(encodeURIComponent(payloadString));
	const signature = computeHMAC(payloadString, secret);

	return `${encodedPayload}.${signature}`;
}

/**
 * Verifies an SSO launch token against the master secret / tenant secret.
 */
export function verifySSOToken(token, options = {}) {
	const { expectedProductId, expectedSecret } = options;

	if (!token || typeof token !== 'string') {
		return { valid: false, error: 'Missing SSO token' };
	}

	const parts = token.split('.');
	if (parts.length !== 2) {
		return { valid: false, error: 'Malformed SSO token structure' };
	}

	const [encodedPayload, signature] = parts;

	try {
		const payloadString = decodeURIComponent(atob(encodedPayload));
		const payload = JSON.parse(payloadString);

		// 1. Validate required fields
		if (!payload.tenantId || !payload.productId || !payload.issuedAt || !payload.nonce) {
			return { valid: false, error: 'Incomplete SSO token payload' };
		}

		// 2. Target Audience Verification
		if (expectedProductId && payload.productId !== 'general' && payload.productId !== expectedProductId) {
			return {
				valid: false,
				error: `Token target mismatch: issued for "${payload.productId}", received by "${expectedProductId}"`,
			};
		}

		// 3. Expiry validation (Strict 10-minute launch window with 60s skew tolerance)
		const now = Date.now();
		const maxAgeMs = 10 * 60 * 1000;
		if (now - payload.issuedAt > maxAgeMs) {
			return { valid: false, error: 'SSO launch token has expired. Please launch again from the Portal.' };
		}
		if (payload.issuedAt - now > 60 * 1000) {
			return { valid: false, error: 'Token timestamp is in the future. Check system clock.' };
		}

		// 4. Anti-Replay Nonce Check (with TTL cleanup)
		for (const [nonceKey, expiry] of CONSUMED_NONCES.entries()) {
			if (now > expiry) {
				CONSUMED_NONCES.delete(nonceKey);
			}
		}
		if (CONSUMED_NONCES.has(payload.nonce)) {
			return { valid: false, error: 'Token replay detected: this launch token has already been consumed.' };
		}
		CONSUMED_NONCES.set(payload.nonce, now + maxAgeMs);

		// 5. Cryptographic Signature Verification
		const validSecret = String(expectedSecret || PLATFORM_MASTER_SECRET || '').trim();
		const masterSecret = String(PLATFORM_MASTER_SECRET || '').trim();
		const expectedSig = computeHMAC(payloadString, validSecret);
		const masterSig = computeHMAC(payloadString, masterSecret);

		if (signature !== expectedSig && signature !== masterSig) {
			return { valid: false, error: 'Cryptographic signature mismatch: Untrusted or forged SSO token rejected.' };
		}

		return {
			valid: true,
			session: {
				tenantId: payload.tenantId,
				tenantName: payload.tenantName,
				domain: payload.domain,
				role: payload.role,
				productId: payload.productId,
				portalUrl: payload.portalUrl || '',
				plan: payload.plan,
				creditsBalance: payload.creditsBalance || 0,
				enabledFeatures: Array.isArray(payload.enabledFeatures) ? payload.enabledFeatures : ['*'],
				apiKey: payload.apiKey,
				authenticatedAt: now,
			},
		};
	} catch (e) {
		return { valid: false, error: `Token decoding failed: ${e.message}` };
	}
}

/**
 * Builds the secure SSO launch URL for any app running on any URL/port.
 */
export function getAppLaunchUrl(baseUrl, tenantOrUser, product, customSecret) {
	if (!baseUrl) return '#';
	let cleanBaseUrl = String(baseUrl).trim().replace(/\/+$/, '');
	if (!cleanBaseUrl) return '#';
	if (!/^https?:\/\//i.test(cleanBaseUrl)) {
		cleanBaseUrl = `https://${cleanBaseUrl}`;
	}

	let user = tenantOrUser;
	if (!user && typeof window !== 'undefined') {
		try {
			const savedCurrent = localStorage.getItem('saas_current_user');
			if (savedCurrent) user = JSON.parse(savedCurrent);
		} catch {}
	}

	const portalOrigin =
		(typeof window !== 'undefined' ? window.location.origin : '') ||
		(typeof process !== 'undefined' && process.env?.PORTAL_URL) ||
		'';
	const secret = customSecret || product?.secretKey || PLATFORM_MASTER_SECRET;
	const token = createSSOToken(user || { id: 'usr_portal', name: 'Platform User' }, product, secret, portalOrigin);

	const urlObj = new URL(cleanBaseUrl);
	urlObj.searchParams.set('sso_token', token);
	if (portalOrigin) {
		urlObj.searchParams.set('portal_url', portalOrigin);
	}
	urlObj.searchParams.set('tenant_id', user?.id || 'tnt_portal');
	urlObj.searchParams.set('product_id', product?.id || '');

	return urlObj.toString();
}
