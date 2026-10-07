/**
 * Collections of the `identity` module (PLAN 0.2, 0.4.4): admins, merchants (one record = business details + one
 * login), the login e-mails (unique across admins and merchants), one-time links, websites, domain claims, the two
 * tokens of each product on a website and the revoked token ids. Passwords are scrypt hashes, two-step secrets and
 * server tokens are sealed with `ENCRYPTION_KEY`, one-time links and recovery codes are HMACs; browser tokens are
 * public and stored in full.
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
	productTokens: 'identity_product_tokens',
	revocations: 'identity_revocations',
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
		description: 'Websites: one exact domain each (status active | removed), unique among active websites. `_id` = websiteId.',
		tenant: 'merchant',
		indexes: [
			{ keys: { merchantId: 1, status: 1, createdAt: 1 } },
			{ keys: { domain: 1, status: 1 } },
			{ keys: { domain: 1 }, name: 'active_domain', unique: true, partialFilterExpression: { status: 'active' } },
		],
	}),
	defineCollection({
		module: 'identity',
		name: C.domains,
		description: 'Domain claims of active websites (`_id` = normalised domain); released at once when the website is removed.',
	}),
	defineCollection({
		module: 'identity',
		name: C.productTokens,
		description:
			'The browser token (in full) and the server token (sealed with ENCRYPTION_KEY) of a product on a website, with their ids (`jti`). `_id` = `<websiteId>:<productId>`; kept when the product is removed, so a re-add restores them.',
		tenant: 'merchant',
		indexes: [{ keys: { merchantId: 1, websiteId: 1, productId: 1 } }],
	}),
	defineCollection({
		module: 'identity',
		name: C.revocations,
		description:
			'Revoked token ids (`_id` = jti): regenerated tokens and the tokens of removed websites, listed to products by `revokedAt`.',
		appendOnly: true,
		timestamps: false,
		indexes: [{ keys: { productId: 1, revokedAt: 1, _id: 1 } }],
	}),
]);
