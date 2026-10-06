/**
 * Collections of the `identity` module. Control-plane records only (PLAN §1a): accounts, memberships, websites,
 * domain claims, website-key metadata and hashed one-time tokens. No password, token or key is stored in clear:
 * passwords are scrypt hashes, TOTP secrets are sealed with the envelope, one-time tokens and recovery codes are
 * HMACs, `sk_` keys are `hashSecretKey` HMACs and `pk_` keys are not stored at all.
 * @module
 */
import { defineCollection } from '../../infra/db.js';

export const C = Object.freeze({
	staff: 'identity_staff',
	users: 'identity_users',
	merchants: 'identity_merchants',
	memberships: 'identity_memberships',
	invites: 'identity_invites',
	tokens: 'identity_tokens',
	websites: 'identity_websites',
	domains: 'identity_domains',
	keys: 'identity_website_keys',
	partners: 'identity_partners',
	developers: 'identity_developers',
	notes: 'identity_merchant_notes',
	issuers: 'identity_issuers',
	issuerRequests: 'identity_issuer_requests',
});

export const collections = Object.freeze([
	defineCollection({
		module: 'identity',
		name: C.staff,
		description:
			'Staff users (platform roles, optional TOTP; the first admin has `login: "admin"` and may have no e-mail). `_id` = staffId.',
		indexes: [{ keys: { email: 1 }, unique: true }],
	}),
	defineCollection({
		module: 'identity',
		name: C.users,
		description: 'Merchant users (global accounts; membership per merchant). `_id` = userId.',
		indexes: [{ keys: { email: 1 }, unique: true }],
	}),
	defineCollection({
		module: 'identity',
		name: C.merchants,
		description:
			'Merchants (tenant roots): name, `nameKey` (normalised name for prefix search), status active|suspended, owner. `_id` = merchantId.',
		indexes: [{ keys: { status: 1, _id: 1 } }, { keys: { nameKey: 1, _id: 1 } }],
	}),
	defineCollection({
		module: 'identity',
		name: C.memberships,
		description: 'Merchant team members: merchant-wide roles and website-scoped grants.',
		tenant: 'merchant',
		indexes: [{ keys: { merchantId: 1, userId: 1 }, unique: true }, { keys: { userId: 1, createdAt: 1 } }],
	}),
	defineCollection({
		module: 'identity',
		name: C.invites,
		description: 'Pending team invitations; only the HMAC of the invite token is stored.',
		tenant: 'merchant',
		indexes: [
			{ keys: { tokenHash: 1 }, unique: true },
			{
				keys: { merchantId: 1, email: 1 },
				name: 'pending_email',
				unique: true,
				partialFilterExpression: { status: 'pending' },
			},
		],
	}),
	defineCollection({
		module: 'identity',
		name: C.tokens,
		description: 'Single-use tokens (signup, password reset, MFA challenges); `_id` = HMAC of the token.',
		timestamps: false,
		ttl: { field: 'expireAt', afterSeconds: 0 },
		indexes: [{ keys: { purpose: 1, subject: 1 } }],
	}),
	defineCollection({
		module: 'identity',
		name: C.websites,
		description: 'Websites (live + test twin share the domain, distinct ids).',
		tenant: 'merchant',
		indexes: [
			{ keys: { merchantId: 1, status: 1, createdAt: 1 } },
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
		description: 'Global domain claims (`_id` = normalised domain); deleted websites keep the claim for a cooldown.',
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
		name: C.partners,
		description: 'Partners (agencies) with merchant grants.',
		indexes: [{ keys: { email: 1 }, unique: true }, { keys: { 'grants.merchantId': 1 } }],
	}),
	defineCollection({
		module: 'identity',
		name: C.developers,
		description: 'Developers (product builders) with app grants.',
		indexes: [{ keys: { email: 1 }, unique: true }, { keys: { 'grants.appId': 1 } }],
	}),
	defineCollection({
		module: 'identity',
		name: C.notes,
		description: 'Staff notes on merchants (append-only; author staff id, body ≤ 2000 chars).',
		tenant: 'merchant',
		appendOnly: true,
		indexes: [{ keys: { merchantId: 1, createdAt: -1, _id: -1 } }],
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
