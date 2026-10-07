/**
 * The two tokens of each product on a website (PLAN 0.4.4): a browser token (public, stored in full) and a server
 * token (secret, sealed with `ENCRYPTION_KEY` so it can be revealed), both signed by the Portal's dedicated token
 * signer with `@ss/protocol` `issueToken`. They are created when the product is first added to the website and kept
 * when it is removed, so a re-add restores the same ids.
 *
 * - **Reveal** opens the server token (never cached; Activity `token.revealed`, shown to the merchant too). A token
 *   sealed under another `ENCRYPTION_KEY` cannot be shown: the screen offers Regenerate.
 * - **Regenerate** issues a new token of one kind, revokes the old id at once (revocation list) and tells the product
 *   (`token.revoked` notice); Activity `token.regenerated`.
 * - **Removing a website** revokes the tokens of every product it had, for good.
 * @module
 */
import { isDuplicateKey } from '../../infra/util.js';
import { issueToken } from '@ss/protocol';
import { problem } from '../../infra/http.js';
import { REVOCATION_PAGE, decodeRevocationCursor, revocationFilter, revocationPage } from './core/revocations.js';
import { C } from './schema.js';

/** @typedef {import('./repo.js').Deps} Deps */
/** @typedef {import('./repo.js').Meta} Meta */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */
/** @typedef {'browser' | 'server'} TokenKind */

/** @param {string} websiteId @param {string} productId */
const docId = (websiteId, productId) => `${websiteId}:${productId}`;

/** @param {string} websiteId @param {string} productId @param {string} jti */
const sealAad = (websiteId, productId, jti) => ({ websiteId, productId, jti, purpose: 'server_token' });

/**
 * @param {Deps} deps
 * @param {{
 *   loadWebsite: (websiteId: string, merchantId?: string) => Promise<Record<string, any>>,
 *   notify: (productId: string, notice: { type: 'token.revoked', websiteId: string }) => Promise<unknown>,
 * }} hooks `notify`: send a notice to the product (catalog)
 */
export const createProductTokens = (deps, hooks) => {
	const { ctx, audit } = deps;
	const repo = /** @type {import('../../infra/db.js').TenantRepository} */ (ctx.collection(C.productTokens));
	const revocations = /** @type {import('../../infra/db.js').ReadOps} */ (ctx.collection(C.revocations));
	/** @param {string} merchantId */
	const of = (merchantId) => /** @type {import('../../infra/db.js').MutableOps} */ (repo.forMerchant(merchantId));

	/**
	 * Sign a new token of one kind.
	 * @param {Record<string, any>} website
	 * @param {string} productId
	 * @param {TokenKind} kind
	 */
	const sign = async (website, productId, kind) => {
		const { token, claims } = await issueToken({
			signer: ctx.keys.tokenSigner,
			issuer: ctx.config.portalUrl,
			websiteId: String(website._id),
			domain: website.domain,
			productId,
			kind,
			now: ctx.now,
			randomBytes: ctx.randomBytes,
		});
		const at = new Date(ctx.now());
		if (kind === 'browser') return { jti: claims.jti, token, createdAt: at };
		return {
			jti: claims.jti,
			sealed: ctx.secretBox.seal(token, { aad: sealAad(String(website._id), productId, claims.jti) }),
			createdAt: at,
		};
	};

	/**
	 * The server token in clear, or null when it was sealed under another `ENCRYPTION_KEY`.
	 * @param {Record<string, any>} doc
	 * @returns {string | null}
	 */
	const openServer = (doc) => {
		try {
			return ctx.secretBox.openText(doc.server.sealed, { aad: sealAad(doc.websiteId, doc.productId, doc.server.jti) });
		} catch {
			return null;
		}
	};

	/**
	 * Revoke token ids at once (a repeated id is ignored).
	 * @param {Record<string, any>} doc
	 * @param {string[]} jtis
	 */
	const revoke = async (doc, jtis) => {
		for (const jti of jtis) {
			try {
				await revocations.insertOne({
					_id: jti,
					productId: doc.productId,
					websiteId: doc.websiteId,
					merchantId: doc.merchantId,
					revokedAt: new Date(ctx.now()),
				});
			} catch (error) {
				if (!isDuplicateKey(error)) throw error;
			}
		}
	};

	/**
	 * The stored tokens of a product on a website, or 404.
	 * @param {string} merchantId @param {string} websiteId @param {string} productId
	 */
	const load = async (merchantId, websiteId, productId) => {
		const doc = await of(merchantId).findOne({ merchantId, _id: docId(websiteId, productId) });
		if (!doc) throw problem('not_found', 'This product is not on the website.');
		return doc;
	};

	return Object.freeze({
		/**
		 * Create the two tokens of a product on a website, or keep the existing ones (a re-add restores them).
		 * @param {{ merchantId: string, websiteId: string, productId: string }} input
		 * @returns {Promise<{ created: boolean }>}
		 */
		ensure: async ({ merchantId, websiteId, productId }) => {
			const existing = await of(merchantId).findOne({ merchantId, _id: docId(websiteId, productId) });
			if (existing) return { created: false };
			const website = await hooks.loadWebsite(websiteId, merchantId);
			try {
				await of(merchantId).insertOne({
					_id: docId(websiteId, productId),
					websiteId,
					productId,
					browser: await sign(website, productId, 'browser'),
					server: await sign(website, productId, 'server'),
				});
			} catch (error) {
				if (!isDuplicateKey(error)) throw error;
				return { created: false };
			}
			return { created: true };
		},

		/**
		 * The tokens of some products on a website, as the Install and tokens tab shows them: the browser token in full,
		 * the server token only as whether it can be shown.
		 * @param {{ merchantId: string, websiteId: string, productIds: readonly string[] }} input
		 */
		list: async ({ merchantId, websiteId, productIds }) => {
			const docs = await of(merchantId).find({ merchantId, websiteId }).sort({ productId: 1 }).limit(100).toArray();
			const wanted = new Set(productIds);
			return docs
				.filter((doc) => wanted.has(doc.productId))
				.map((doc) => ({
					productId: String(doc.productId),
					browserToken: String(doc.browser.token),
					serverTokenCanShow: openServer(doc) !== null,
				}));
		},

		/**
		 * Reveal the server token (Activity `token.revealed`; the merchant sees admins' reveals).
		 * @param {{ merchantId: string, websiteId: string, productId: string, actor: Actor, meta?: Meta }} input
		 */
		reveal: async ({ merchantId, websiteId, productId, actor, meta = {} }) => {
			const doc = await load(merchantId, websiteId, productId);
			const token = openServer(doc);
			if (token === null) throw problem('conflict', 'Cannot be shown: regenerate.');
			await audit(
				actor,
				'token.revealed',
				{ type: 'website', id: websiteId, merchantId, websiteId },
				{ after: { productId, kind: 'server' }, meta },
			);
			return { productId, serverToken: token };
		},

		/**
		 * Regenerate one token: the old id is revoked at once and the product is told (`token.revoked`).
		 * @param {{ merchantId: string, websiteId: string, productId: string, kind: TokenKind, actor: Actor, meta?: Meta }} input
		 */
		regenerate: async ({ merchantId, websiteId, productId, kind, actor, meta = {} }) => {
			const doc = await load(merchantId, websiteId, productId);
			const website = await hooks.loadWebsite(websiteId, merchantId);
			const fresh = await sign(website, productId, kind);
			const old = String(doc[kind].jti);
			const updated = await of(merchantId).updateOne(
				{ merchantId, _id: doc._id, [`${kind}.jti`]: old },
				{ $set: { [kind]: fresh } },
			);
			if (updated.matchedCount !== 1) throw problem('conflict', 'The token changed meanwhile. Reload and try again.');
			await revoke(doc, [old]);
			await audit(
				actor,
				'token.regenerated',
				{ type: 'website', id: websiteId, merchantId, websiteId },
				{ after: { productId, kind }, meta },
			);
			await hooks.notify(productId, { type: 'token.revoked', websiteId });
			const token = kind === 'browser' ? String(fresh.token) : openServer({ ...doc, server: fresh });
			return { productId, kind, token };
		},

		/**
		 * Revoke the tokens of every product a website had (the website is removed); returns those products.
		 * @param {{ merchantId: string, websiteId: string }} input
		 * @returns {Promise<string[]>}
		 */
		revokeWebsite: async ({ merchantId, websiteId }) => {
			const docs = await of(merchantId).find({ merchantId, websiteId }).limit(100).toArray();
			for (const doc of docs) await revoke(doc, [String(doc.browser.jti), String(doc.server.jti)]);
			return docs.map((doc) => String(doc.productId));
		},

		/**
		 * Revoked token ids of one product after a cursor (PLAN 0.4.12 row 6).
		 * @param {{ productId: string, since: unknown }} input
		 */
		revocationsSince: async ({ productId, since }) => {
			const cursor = decodeRevocationCursor(since);
			if (!cursor.ok) throw problem('bad_request', 'since is not a valid cursor.');
			const rows = await revocations
				.find(revocationFilter(productId, cursor.value))
				.sort({ revokedAt: 1, _id: 1 })
				.limit(REVOCATION_PAGE + 1)
				.project({ _id: 1, revokedAt: 1 })
				.toArray();
			return revocationPage(/** @type {any} */ (rows), cursor.value, ctx.now());
		},
	});
};
/** @typedef {ReturnType<typeof createProductTokens>} ProductTokens */
