/**
 * Collections of the `identity` module (PLAN 0.2): admins, merchants (one record = business details + one login),
 * the login e-mails (unique across admins and merchants), one-time tokens, websites, domain claims and — until the
 * switch (PLAN 0.12 step 5) — website-key metadata and identity issuers. No password, token or key is stored in clear:
 * passwords are scrypt hashes, two-step secrets are sealed with `ENCRYPTION_KEY`, one-time tokens and recovery codes
 * are HMACs, `sk_` keys are `hashSecretKey` HMACs and `pk_` keys are not stored at all.
 * @module
 */
import { defineCollection } from '../../infra/db.js';

export const C = Object.freeze({
	admins: 'identity_admins',
	merchants: 'identity_merchants',
	logins: 'identity_logins',
	tokens: 'identity_tokens',
	websites: 'identity_websites',
	domains: 'identity_domains',
	keys: 'identity_website_keys',
	issuers: 'identity_issuers',
	issuerRequests: 'identity_issuer_requests',
});

export const collections = Object.freeze([
	defineCollection({
		module: 'identity',
		name: C.admins,
		description:
			'Admins: name, login e-mail, one role (owner | support | finance), status invited | active, optional two-step. The first admin carries `firstAdmin: true` (unique), so only one can be created that way. `_id` = adminId.',
		indexes: [
			{ keys: { email: 1 }, unique: true },
			{ keys: { firstAdmin: 1 }, name: 'first_admin', unique: true, partialFilterExpression: { firstAdmin: true } },
			{ keys: { role: 1, status: 1 } },
		],
	}),
	defineCollection({
		module: 'identity',
		name: C.merchants,
		description:
			'Merchants: business details plus exactly one login (owner e-mail, password, optional two-step); status active | suspended | deleted; `nameKey` for prefix search. `_id` = merchantId.',
		indexes: [{ keys: { status: 1, _id: 1 } }, { keys: { nameKey: 1, _id: 1 } }, { keys: { email: 1 } }],
	}),
	defineCollection({
		module: 'identity',
		name: C.logins,
		description:
			'Login e-mails, unique across admins and merchants (`_id` = the lower-cased e-mail): `{ kind: admin | merchant, subject }`. Claimed before a login is created or changed, released when it is erased.',
	}),
	defineCollection({
		module: 'identity',
		name: C.tokens,
		description:
			'Single-use tokens (setup links, password resets, e-mail changes, two-step sign-in steps); `_id` = HMAC of the token.',
		timestamps: false,
		ttl: { field: 'expireAt', afterSeconds: 0 },
		indexes: [{ keys: { purpose: 1, subject: 1 } }],
	}),
	defineCollection({
		module: 'identity',
		name: C.websites,
		description:
			'Websites: one exact domain each, unique among active websites (a test twin shares it until the switch, PLAN 0.12 step 5).',
		tenant: 'merchant',
		indexes: [
			{ keys: { merchantId: 1, status: 1, createdAt: 1 } },
			{ keys: { domain: 1, status: 1 } },
			{
				keys: { domain: 1, env: 1 },
				name: 'active_domain_env',
				unique: true,
				partialFilterExpression: { status: 'active' },
			},
		],
	}),
	defineCollection({
		module: 'identity',
		name: C.domains,
		description: 'Domain claims of active websites (`_id` = normalised domain); released at once when the website is removed.',
	}),
	defineCollection({
		module: 'identity',
		name: C.keys,
		description: 'Website key metadata (sk_: HMAC only; pk_: nothing) and revocation schedule. `_id` = keyId.',
		tenant: 'merchant',
		indexes: [{ keys: { merchantId: 1, websiteId: 1, createdAt: -1 } }, { keys: { revokeAt: 1, _id: 1 } }],
	}),
	defineCollection({
		module: 'identity',
		name: C.issuers,
		description:
			'Bring-your-own customer identity issuers, one per website (`_id` = websiteId): issuer, JWKS URL or inline public keys (≤ 5, public material only), audience, claim map, key fetch status.',
		tenant: 'merchant',
		indexes: [{ keys: { merchantId: 1, _id: 1 } }],
	}),
	defineCollection({
		module: 'identity',
		name: C.issuerRequests,
		description:
			'Product requests to become a website identity issuer (F.16; `_id` = websiteId): product, requested issuer input (public keys only), status pending|approved|rejected, decision.',
		tenant: 'merchant',
		indexes: [{ keys: { merchantId: 1, status: 1, requestedAt: -1 } }],
	}),
]);
