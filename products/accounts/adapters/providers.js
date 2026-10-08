/**
 * Outside services, always through `@ss/net` with the merchant's own keys (PLAN 0.8.6):
 *
 * - **Google** (OpenID Connect, authorization code with PKCE), **Apple** (Sign in with Apple, `form_post`, the client
 *   secret an ES256 JWT signed with the merchant's key) and **Facebook** (Login, Graph API with `appsecret_proof`).
 *   The ID tokens of Google and Apple come straight from the provider's token endpoint over TLS, so their claims are
 *   checked (issuer, audience, expiry, nonce) without fetching the providers' keys (OpenID Connect Core 3.1.3.7).
 * - **Breached passwords**: the Have I Been Pwned range API (k-anonymity: only the first 5 characters of the
 *   password's SHA-1 leave the server). When it cannot be reached, the password is not refused for it.
 * @module
 */
import { createHash, createHmac, createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { sha1Upper } from './crypto.js';

/** @typedef {(url: string, init?: import('@ss/net').SafeFetchInit) => Promise<import('@ss/net').SafeResponse>} Send */
/** @typedef {'google' | 'apple' | 'facebook'} Provider */
/** @typedef {{ subject: string, email: string | null, name: string }} ProviderIdentity */

const GOOGLE = Object.freeze({
	authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
	token: 'https://oauth2.googleapis.com/token',
	issuers: ['https://accounts.google.com', 'accounts.google.com'],
});
const APPLE = Object.freeze({
	authorize: 'https://appleid.apple.com/auth/authorize',
	token: 'https://appleid.apple.com/auth/token',
	issuer: 'https://appleid.apple.com',
});
const FACEBOOK = Object.freeze({
	authorize: 'https://www.facebook.com/v21.0/dialog/oauth',
	graph: 'https://graph.facebook.com/v21.0',
});
const PWNED_RANGE = 'https://api.pwnedpasswords.com/range/';

/** @param {unknown} value @returns {Record<string, any>} */
const objectOf = (value) => (typeof value === 'object' && value !== null ? /** @type {Record<string, any>} */ (value) : {});

/** @param {import('@ss/net').SafeResponse} response */
const jsonOf = (response) => {
	try {
		return objectOf(JSON.parse(response.body.toString('utf8')));
	} catch {
		return {};
	}
};

/** The claims of a JWT (not verified: only for tokens received straight from the provider). @param {unknown} token */
const claimsOf = (token) => {
	if (typeof token !== 'string') return {};
	try {
		return objectOf(JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')));
	} catch {
		return {};
	}
};

/** A PKCE verifier's S256 challenge. @param {string} verifier */
export const pkceChallenge = (verifier) => createHash('sha256').update(verifier).digest('base64url');

/** @param {Record<string, any>} key */
const appleKey = (key) => ({
	servicesId: String(key.servicesId ?? ''),
	teamId: String(key.teamId ?? ''),
	keyId: String(key.keyId ?? ''),
	privateKey: String(key.privateKey ?? ''),
});

/**
 * Apple's client secret: an ES256 JWT (5 minutes) signed with the merchant's key.
 * @param {Record<string, any>} key the Apple connection
 * @param {number} now
 */
export const appleClientSecret = (key, now) => {
	const { servicesId, teamId, keyId, privateKey } = appleKey(key);
	const iat = Math.floor(now / 1000);
	/** @param {unknown} value */
	const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
	const input = `${b64({ alg: 'ES256', kid: keyId })}.${b64({ iss: teamId, iat, exp: iat + 300, aud: APPLE.issuer, sub: servicesId })}`;
	const signature = cryptoSign('sha256', Buffer.from(input), {
		key: createPrivateKey(privateKey.replace(/\\n/g, '\n')),
		dsaEncoding: 'ieee-p1363',
	});
	return `${input}.${signature.toString('base64url')}`;
};

/**
 * @param {{ send: Send, now: () => number }} options
 */
export const createProviders = ({ send, now }) => {
	/** @param {string} url @param {Record<string, string>} form */
	const postForm = (url, form) =>
		send(url, {
			method: 'POST',
			redirect: 'error',
			headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
			body: new URLSearchParams(form).toString(),
		});

	/**
	 * Check an ID token's claims.
	 * @param {Record<string, any>} claims
	 * @param {{ issuers: string[], audience: string, nonce: string }} expected
	 * @returns {ProviderIdentity | null}
	 */
	const identityOf = (claims, { issuers, audience, nonce }) => {
		const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
		if (!issuers.includes(claims.iss) || !aud.includes(audience) || typeof claims.sub !== 'string') return null;
		if (typeof claims.exp !== 'number' || claims.exp * 1000 < now() - 60_000 || claims.nonce !== nonce) return null;
		const verified = claims.email_verified === true || claims.email_verified === 'true';
		return {
			subject: claims.sub,
			email: verified && typeof claims.email === 'string' ? claims.email : null,
			name: typeof claims.name === 'string' ? claims.name : '',
		};
	};

	return Object.freeze({
		/**
		 * The provider's sign-in page address.
		 * @param {Provider} provider
		 * @param {Record<string, any>} key the provider connection
		 * @param {{ redirectUri: string, state: string, nonce: string, verifier: string }} input
		 */
		authorizeUrl: (provider, key, { redirectUri, state, nonce, verifier }) => {
			if (provider === 'google')
				return `${GOOGLE.authorize}?${new URLSearchParams({
					client_id: String(key.clientId),
					redirect_uri: redirectUri,
					response_type: 'code',
					scope: 'openid email profile',
					state,
					nonce,
					code_challenge: pkceChallenge(verifier),
					code_challenge_method: 'S256',
					prompt: 'select_account',
				}).toString()}`;
			if (provider === 'apple')
				return `${APPLE.authorize}?${new URLSearchParams({
					client_id: appleKey(key).servicesId,
					redirect_uri: redirectUri,
					response_type: 'code',
					response_mode: 'form_post',
					scope: 'name email',
					state,
					nonce,
				}).toString()}`;
			return `${FACEBOOK.authorize}?${new URLSearchParams({
				client_id: String(key.appId),
				redirect_uri: redirectUri,
				response_type: 'code',
				scope: 'email,public_profile',
				state,
			}).toString()}`;
		},

		/**
		 * Exchange the code the provider sent back for the person's identity; null when the provider refuses.
		 * @param {Provider} provider
		 * @param {Record<string, any>} key
		 * @param {{ code: string, redirectUri: string, nonce: string, verifier: string, appleUser?: string }} input
		 * @returns {Promise<ProviderIdentity | null>}
		 */
		identify: async (provider, key, { code, redirectUri, nonce, verifier, appleUser }) => {
			if (provider === 'google') {
				const response = await postForm(GOOGLE.token, {
					code,
					client_id: String(key.clientId),
					client_secret: String(key.clientSecret),
					redirect_uri: redirectUri,
					grant_type: 'authorization_code',
					code_verifier: verifier,
				});
				if (response.status !== 200) return null;
				return identityOf(claimsOf(jsonOf(response).id_token), {
					issuers: [...GOOGLE.issuers],
					audience: String(key.clientId),
					nonce,
				});
			}
			if (provider === 'apple') {
				const response = await postForm(APPLE.token, {
					code,
					client_id: appleKey(key).servicesId,
					client_secret: appleClientSecret(key, now()),
					redirect_uri: redirectUri,
					grant_type: 'authorization_code',
				});
				if (response.status !== 200) return null;
				const identity = identityOf(claimsOf(jsonOf(response).id_token), {
					issuers: [APPLE.issuer],
					audience: appleKey(key).servicesId,
					nonce,
				});
				if (!identity) return null;
				// Apple sends the name only the first time, in the form's `user` field
				const user = (() => {
					try {
						return objectOf(JSON.parse(appleUser ?? '{}'));
					} catch {
						return {};
					}
				})();
				const name = [user.name?.firstName, user.name?.lastName].filter((part) => typeof part === 'string').join(' ');
				return { ...identity, name: name.slice(0, 120) };
			}
			const token = await send(
				`${FACEBOOK.graph}/oauth/access_token?${new URLSearchParams({
					client_id: String(key.appId),
					client_secret: String(key.appSecret),
					redirect_uri: redirectUri,
					code,
				}).toString()}`,
				{ redirect: 'error', headers: { accept: 'application/json' } },
			);
			const accessToken = jsonOf(token).access_token;
			if (token.status !== 200 || typeof accessToken !== 'string') return null;
			const proof = createHmac('sha256', String(key.appSecret)).update(accessToken).digest('hex');
			const me = await send(
				`${FACEBOOK.graph}/me?${new URLSearchParams({ fields: 'id,name,email', access_token: accessToken, appsecret_proof: proof }).toString()}`,
				{ redirect: 'error', headers: { accept: 'application/json' } },
			);
			const profile = jsonOf(me);
			if (me.status !== 200 || typeof profile.id !== 'string') return null;
			return {
				subject: profile.id,
				// Facebook only returns confirmed e-mail addresses
				email: typeof profile.email === 'string' ? profile.email : null,
				name: typeof profile.name === 'string' ? profile.name.slice(0, 120) : '',
			};
		},

		/**
		 * Connection tests: Facebook is asked for an app token (a read-only call); Google and Apple keys are checked for
		 * their shape (Apple's key must sign), since they have no read-only call.
		 * @param {Provider} provider
		 * @param {unknown} value
		 * @returns {Promise<{ ok: boolean, message?: string }>}
		 */
		test: async (provider, value) => {
			const key = objectOf(value);
			if (provider === 'google') {
				const ok =
					typeof key.clientId === 'string' &&
					/\.apps\.googleusercontent\.com$/.test(key.clientId) &&
					typeof key.clientSecret === 'string' &&
					key.clientSecret.length > 0;
				return ok
					? { ok: true }
					: { ok: false, message: 'Enter the OAuth client id (….apps.googleusercontent.com) and secret.' };
			}
			if (provider === 'apple') {
				const { servicesId, teamId, keyId } = appleKey(key);
				if (!servicesId || !/^[A-Z0-9]{10}$/.test(teamId) || !/^[A-Z0-9]{10}$/.test(keyId))
					return { ok: false, message: 'Enter the Services ID, the 10-character Team ID and Key ID, and the key.' };
				try {
					appleClientSecret(key, now());
					return { ok: true };
				} catch {
					return { ok: false, message: 'The private key (.p8) cannot sign.' };
				}
			}
			if (typeof key.appId !== 'string' || typeof key.appSecret !== 'string')
				return { ok: false, message: 'Enter the app id and app secret.' };
			const response = await send(
				`${FACEBOOK.graph}/oauth/access_token?${new URLSearchParams({
					client_id: key.appId,
					client_secret: key.appSecret,
					grant_type: 'client_credentials',
				}).toString()}`,
				{ redirect: 'error', headers: { accept: 'application/json' } },
			);
			return response.status === 200 ? { ok: true } : { ok: false, message: `Facebook answered HTTP ${response.status}.` };
		},

		/**
		 * Whether a password is in the breached-password list (false when the list cannot be reached).
		 * @param {string} password
		 */
		breached: async (password) => {
			const hash = sha1Upper(password);
			try {
				const response = await send(`${PWNED_RANGE}${hash.slice(0, 5)}`, {
					redirect: 'error',
					headers: { 'add-padding': 'true' },
					maxBytes: 2 * 1024 * 1024,
				});
				if (response.status !== 200) return false;
				const suffix = hash.slice(5);
				return response.body
					.toString('utf8')
					.split('\n')
					.some((line) => {
						const [candidate, count] = line.trim().split(':');
						return candidate === suffix && Number(count) > 0;
					});
			} catch {
				return false;
			}
		},
	});
};

/** @typedef {ReturnType<typeof createProviders>} Providers */
