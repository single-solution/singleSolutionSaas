import crypto from 'crypto';

const SESSION_SECRET = process.env.PORTAL_SESSION_SECRET || 'singlesolution_master_session_secret_v3_99418';
const COOKIE_NAME = 'portal_session';

/**
 * Hashes a plain-text password using SHA-256 with a unique salt
 */
export function hashPassword(password) {
	const salt = crypto.randomBytes(16).toString('hex');
	const hash = crypto.createHmac('sha256', salt).update(password).digest('hex');
	return `${salt}:${hash}`;
}

/**
 * Validates a plain-text password against a stored hash or plain password (with constant-time compare)
 */
export function verifyPassword(password, stored) {
	if (!stored || !password) return false;

	// Check if stored has salt:hash format
	if (stored.includes(':')) {
		const [salt, expectedHash] = stored.split(':');
		const actualHash = crypto.createHmac('sha256', salt).update(password).digest('hex');
		try {
			return crypto.timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(expectedHash, 'hex'));
		} catch {
			return false;
		}
	}

	// Plain string comparison using timingSafeEqual
	const actualBuf = Buffer.from(password);
	const expectedBuf = Buffer.from(stored);
	if (actualBuf.length !== expectedBuf.length) return false;
	return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

/**
 * Creates a signed session token
 */
export function createSessionToken(payload) {
	const data = {
		...payload,
		iat: Date.now(),
		exp: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
	};
	const encodedData = Buffer.from(JSON.stringify(data)).toString('base64url');
	const signature = crypto.createHmac('sha256', SESSION_SECRET).update(encodedData).digest('base64url');
	return `${encodedData}.${signature}`;
}

/**
 * Verifies a signed session token
 */
export function verifySessionToken(token) {
	if (!token || typeof token !== 'string') return null;
	const parts = token.split('.');
	if (parts.length !== 2) return null;

	const [encodedData, signature] = parts;
	const expectedSignature = crypto.createHmac('sha256', SESSION_SECRET).update(encodedData).digest('base64url');

	try {
		const isSigValid = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
		if (!isSigValid) return null;

		const payload = JSON.parse(Buffer.from(encodedData, 'base64url').toString('utf8'));
		if (payload.exp && Date.now() > payload.exp) return null;
		return payload;
	} catch {
		return null;
	}
}

/**
 * Extracts session from Next.js Request or cookie header
 */
export function getSession(req) {
	try {
		let cookieHeader = '';
		if (req && req.headers) {
			if (typeof req.headers.get === 'function') {
				cookieHeader = req.headers.get('cookie') || '';
			} else if (req.headers.cookie) {
				cookieHeader = req.headers.cookie;
			}
		}

		if (!cookieHeader) return null;

		const cookies = Object.fromEntries(
			cookieHeader.split(';').map((c) => {
				const [k, ...v] = c.trim().split('=');
				return [k, decodeURIComponent(v.join('='))];
			}),
		);

		const token = cookies[COOKIE_NAME];
		return verifySessionToken(token);
	} catch {
		return null;
	}
}

/**
 * Builds standard Set-Cookie header for session
 */
export function buildSessionCookie(token, maxAgeSeconds = 7 * 24 * 60 * 60) {
	const isProd = process.env.NODE_ENV === 'production';
	const secureFlag = isProd ? '; Secure' : '';
	return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secureFlag}`;
}

/**
 * Builds clear session cookie header
 */
export function buildClearSessionCookie() {
	return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
