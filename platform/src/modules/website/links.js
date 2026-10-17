/**
 * The links between the products of a website (settings-ownership design 8.3). Nobody pastes a product token into
 * another product: when two products are on the same website, the Portal creates the link they need.
 *
 * - **A link is one-way and named**: caller Y, callee X, website W (`chat → notifications`). It carries **scopes**: what Y
 *   may do in X, for example `messages.send`. The scopes come from the manifests: X's `links.offers` lists what it
 *   offers; Y's `links.needs` lists what it uses, and the features that use it. The Portal grants only offered scopes, and only
 *   those of needs whose features are on (a need with no feature is always on). When a feature is switched, the grant is worked out
 *   again; a link with nothing left to grant stays but is idle.
 * - **The token proves who, the Portal decides what**: the link token is a Portal-signed token of kind `link`
 *   (`{ productId: callee, caller, websiteId }`, no scopes), sealed here with `ENCRYPTION_KEY` and given only to the
 *   caller over its signed channel. The callee is told who may call it and with which scopes (`links.in`) and enforces
 *   that; changing a grant needs no new token.
 * - **Provisioned and revoked by the Portal alone**: created when both products are added and a feature needs the link;
 *   revoked, with the token on the revocation list, at once when either product is removed from the website, when the
 *   website is removed, when a person regenerates it or switches it off. No route lets anyone paste, read or write a
 *   token or a scope: a merchant can only switch a link off, on, or regenerate it (after confirming their password).
 * - Every change raises the website's `connectionsVersion`, tells the products involved and is logged
 *   (`website.link_changed`).
 * @module
 */
import { issueToken } from '@ss/protocol';
import { resealEach } from '../../infra/crypto.js';
import { problem } from '../../infra/http.js';
import { isDuplicateKey } from '../../infra/util.js';
import { LINKS } from './schema.js';

/** @typedef {import('../../infra/modules.js').ModuleContext} ModuleContext */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */
/** @typedef {{ actor: Actor, requestId?: string | null, ip?: string | null }} Audited */

/** @param {string} websiteId @param {string} callee @param {string} caller */
const docId = (websiteId, callee, caller) => `${websiteId}:${callee}:${caller}`;
/** @param {string} websiteId @param {string} callee @param {string} caller @param {string} jti */
const sealAad = (websiteId, callee, caller, jti) => ({ websiteId, callee, caller, jti, purpose: 'link_token' });
/** @param {string[]} a @param {string[]} b */
const sameScopes = (a, b) => a.length === b.length && a.every((scope, index) => scope === b[index]);

/**
 * @param {ModuleContext} ctx
 * @param {{ bump: (input: { merchantId: string, websiteId: string }) => Promise<number>,
 *   notify: (websiteId: string, what: 'connections' | 'links', productIds: readonly string[]) => Promise<void> }} hooks
 */
export const createLinks = (ctx, { bump, notify }) => {
	const store = /** @type {import('../../infra/db.js').TenantRepository} */ (ctx.collection(LINKS));
	/** @param {string} merchantId */
	const ownerOps = (merchantId) => /** @type {import('../../infra/db.js').MutableOps} */ (store.forMerchant(merchantId));
	const identity = () => ctx.service('identity');
	const commerce = () => ctx.service('commerce');
	const catalog = () => ctx.service('catalog');

	/**
	 * The active website, else null.
	 * @param {string} websiteId
	 */
	const activeWebsite = async (websiteId) => {
		const website = await identity()
			.getWebsite(websiteId)
			.catch((/** @type {{ code?: string }} */ error) => {
				if (error?.code === 'not_found') return null;
				throw error;
			});
		return website && website.status === 'active' ? website : null;
	};

	/**
	 * The products on the website with their manifests' links and the features that are on.
	 * @param {string} websiteId
	 * @returns {Promise<Map<string, { name: string, on: string[], offers: Array<{ scope: string, name: string, description: string }>,
	 *   needs: Array<{ product: string, scopes: string[], features: string[], optional?: boolean }> }>>}
	 */
	const productsOf = async (websiteId) => {
		const onSite = /** @type {Array<{ productId: string, on: string[] }>} */ (await commerce().productsOnWebsite(websiteId));
		/** @type {Map<string, any>} */
		const out = new Map();
		await Promise.all(
			onSite.map(async ({ productId, on }) => {
				const product = await catalog()
					.getProduct(productId)
					.catch(() => null);
				if (product)
					out.set(productId, { name: String(product.name), on, offers: product.links.offers, needs: product.links.needs });
			}),
		);
		return out;
	};

	/**
	 * The links the products need now: `callee>caller` → the scopes to grant (offered by the callee, needed by a caller's
	 * feature that is on).
	 * @param {Awaited<ReturnType<typeof productsOf>>} products
	 * @returns {Map<string, { caller: string, callee: string, scopes: string[] }>}
	 */
	const desiredOf = (products) => {
		/** @type {Map<string, { caller: string, callee: string, scopes: Set<string> }>} */
		const wanted = new Map();
		for (const [caller, product] of products)
			for (const need of product.needs) {
				const callee = products.get(need.product);
				if (!callee || need.product === caller) continue;
				if (need.features.length > 0 && !need.features.some((/** @type {string} */ key) => product.on.includes(key)))
					continue;
				const offered = new Set(callee.offers.map((/** @type {{ scope: string }} */ offer) => offer.scope));
				const entry = wanted.get(`${need.product}>${caller}`) ?? { caller, callee: need.product, scopes: new Set() };
				for (const scope of need.scopes) if (offered.has(scope)) entry.scopes.add(scope);
				wanted.set(`${need.product}>${caller}`, entry);
			}
		return new Map([...wanted].map(([key, entry]) => [key, { ...entry, scopes: [...entry.scopes].sort() }]));
	};

	/**
	 * Sign and seal a link token.
	 * @param {Record<string, any>} website @param {string} callee @param {string} caller
	 */
	const sign = async (website, callee, caller) => {
		const { token, claims } = await issueToken({
			signer: ctx.keys.tokenSigner,
			issuer: ctx.config.portalUrl,
			websiteId: String(website.websiteId),
			domain: website.domain,
			productId: callee,
			kind: 'link',
			caller,
			now: ctx.now,
			randomBytes: ctx.randomBytes,
		});
		return {
			jti: claims.jti,
			sealed: ctx.secretBox.seal(token, { aad: sealAad(String(website.websiteId), callee, caller, claims.jti) }),
		};
	};

	/**
	 * Put a link token on the revocation list at once and tell the callee (it reads the list right away).
	 * @param {Record<string, any>} doc
	 */
	const revokeToken = async (doc) => {
		if (!doc.jti) return;
		await identity().revokeTokenIds({
			merchantId: String(doc.merchantId),
			websiteId: String(doc.websiteId),
			productId: String(doc.callee),
			jtis: [String(doc.jti)],
		});
		try {
			await catalog().notify(String(doc.callee), { type: 'token.revoked', websiteId: String(doc.websiteId) });
		} catch (error) {
			ctx.logger.warn('token.revoked not queued', { productId: doc.callee, websiteId: doc.websiteId, error });
		}
	};

	/**
	 * @param {Actor | { type: 'system', id: string }} actor
	 * @param {Record<string, any>} doc
	 * @param {string} action what happened
	 * @param {Record<string, unknown>} [extra]
	 * @param {{ requestId?: string | null, ip?: string | null }} [meta]
	 */
	const log = (actor, doc, action, extra = {}, meta = {}) =>
		ctx.audit.record({
			actor: /** @type {any} */ (actor),
			action: 'website.link_changed',
			target: {
				type: 'website',
				id: String(doc.websiteId),
				merchantId: String(doc.merchantId),
				websiteId: String(doc.websiteId),
			},
			after: { caller: doc.caller, callee: doc.callee, change: action, scopes: doc.scopes, ...extra },
			requestId: meta.requestId ?? null,
			ip: meta.ip ?? null,
		});

	const system = /** @type {const} */ ({ type: 'system', id: 'website' });

	/**
	 * Work out the links of a website again from who is on it and which features are on: create what is needed, change a
	 * grant that changed, revoke and delete what no longer has both products. Safe to run any time and again (and
	 * concurrently); a website that is not active has no links.
	 * @param {string} websiteId
	 * @returns {Promise<{ changed: boolean }>}
	 */
	const recompute = async (websiteId) => {
		const website = await activeWebsite(websiteId);
		if (!website) return { changed: false };
		const merchantId = String(website.merchantId);
		const ops = ownerOps(merchantId);
		const products = await productsOf(websiteId);
		const wanted = desiredOf(products);
		const existing = await ops.find({ merchantId, websiteId }).limit(200).toArray();
		/** @type {Set<string>} */
		const touched = new Set();
		/** The links created or changed now: they carry the new version. @type {string[]} */
		const marked = [];
		let changed = false;
		for (const doc of existing) {
			if (products.has(String(doc.caller)) && products.has(String(doc.callee))) continue;
			await revokeToken(doc);
			await ops.deleteOne({ merchantId, _id: doc._id });
			await log(system, doc, 'revoked', { why: 'a product left the website' });
			touched.add(String(doc.caller)).add(String(doc.callee));
			changed = true;
		}
		for (const [, want] of wanted) {
			const id = docId(websiteId, want.callee, want.caller);
			const doc = existing.find((each) => each._id === id);
			if (!doc) {
				if (want.scopes.length === 0) continue;
				const made = await sign(website, want.callee, want.caller);
				try {
					await ops.insertOne({
						_id: id,
						websiteId,
						caller: want.caller,
						callee: want.callee,
						scopes: want.scopes,
						status: 'on',
						...made,
						createdAt: new Date(ctx.now()),
					});
				} catch (error) {
					// a run at the same time made it
					if (isDuplicateKey(error)) continue;
					throw error;
				}
				await log(
					system,
					{ merchantId, websiteId, caller: want.caller, callee: want.callee, scopes: want.scopes },
					'created',
				);
				marked.push(id);
				touched.add(want.caller).add(want.callee);
				changed = true;
			} else if (!sameScopes(doc.scopes, want.scopes)) {
				await ops.updateOne({ merchantId, _id: id }, { $set: { scopes: want.scopes } });
				await log(system, { ...doc, scopes: want.scopes }, 'scopes_changed', { before: doc.scopes });
				marked.push(id);
				touched.add(want.caller).add(want.callee);
				changed = true;
			}
		}
		// a link whose products are still there but that nothing needs any more keeps its token and grants nothing
		for (const doc of existing) {
			if (!products.has(String(doc.caller)) || !products.has(String(doc.callee))) continue;
			if (wanted.has(`${doc.callee}>${doc.caller}`) || doc.scopes.length === 0) continue;
			await ops.updateOne({ merchantId, _id: doc._id }, { $set: { scopes: [] } });
			await log(system, { ...doc, scopes: [] }, 'scopes_changed', { before: doc.scopes });
			marked.push(String(doc._id));
			touched.add(String(doc.caller)).add(String(doc.callee));
			changed = true;
		}
		if (!changed) return { changed: false };
		const version = await bump({ merchantId, websiteId });
		if (marked.length > 0) await ops.updateMany({ merchantId, _id: { $in: marked } }, { $set: { atVersion: version } });
		await notify(
			websiteId,
			'links',
			[...touched].filter((productId) => products.has(productId)),
		);
		return { changed: true };
	};

	/**
	 * A link of the website, else 404.
	 * @param {string} merchantId @param {string} websiteId @param {string} callee @param {string} caller
	 */
	const load = async (merchantId, websiteId, callee, caller) => {
		const doc = await ownerOps(merchantId).findOne({ merchantId, _id: docId(websiteId, callee, caller) });
		if (!doc || doc.websiteId !== websiteId) throw problem('not_found', 'No such link.');
		return doc;
	};

	return Object.freeze({
		recompute,

		/**
		 * The links the console shows: who may call whom, the scopes in words, whether it is on, and whether the caller has
		 * fetched its key (`fetchedBy`: product → { version }).
		 * @param {{ merchantId: string, websiteId: string, fetchedBy: Record<string, { version: number }> }} input
		 */
		view: async ({ merchantId, websiteId, fetchedBy }) => {
			const [docs, products] = await Promise.all([
				ownerOps(merchantId).find({ merchantId, websiteId }).sort({ caller: 1, callee: 1 }).limit(200).toArray(),
				productsOf(websiteId),
			]);
			return docs
				.filter((doc) => products.has(String(doc.caller)) && products.has(String(doc.callee)))
				.map((doc) => {
					const callee = /** @type {NonNullable<ReturnType<typeof products.get>>} */ (products.get(String(doc.callee)));
					const caller = /** @type {NonNullable<ReturnType<typeof products.get>>} */ (products.get(String(doc.caller)));
					const state = doc.status === 'off' ? 'off' : doc.scopes.length === 0 ? 'idle' : 'on';
					return {
						caller: String(doc.caller),
						callerName: caller.name,
						callee: String(doc.callee),
						calleeName: callee.name,
						state,
						scopes: doc.scopes.map((/** @type {string} */ scope) => {
							const offer = callee.offers.find((each) => each.scope === scope);
							return { scope, name: offer?.name ?? scope, description: offer?.description ?? '' };
						}),
						// has the caller fetched its key at the version this link last changed?
						delivered: state === 'on' && (fetchedBy[String(doc.caller)]?.version ?? 0) >= Number(doc.atVersion ?? 0),
					};
				});
		},

		/**
		 * The links of one product, as it fetches them: its keys to call others (`out`) and who may call it (`in`). Only
		 * links that are on, with something granted, between two products that are on the website now.
		 * @param {{ websiteId: string, merchantId: string, productId: string }} input
		 * @returns {Promise<{ out: Array<{ to: string, token: string, scopes: string[] }>, in: Array<{ from: string, scopes: string[] }> }>}
		 */
		forProduct: async ({ websiteId, merchantId, productId }) => {
			const [docs, onSite] = await Promise.all([
				ownerOps(merchantId)
					.find({ merchantId, websiteId, $or: [{ caller: productId }, { callee: productId }] })
					.limit(200)
					.toArray(),
				/** @type {Promise<Array<{ productId: string }>>} */ (commerce().productsOnWebsite(websiteId)),
			]);
			const present = new Set(onSite.map((each) => each.productId));
			const live = docs.filter(
				(doc) =>
					doc.status === 'on' && doc.scopes.length > 0 && present.has(String(doc.caller)) && present.has(String(doc.callee)),
			);
			/** @type {Array<{ to: string, token: string, scopes: string[] }>} */
			const out = [];
			for (const doc of live.filter((each) => each.caller === productId)) {
				try {
					out.push({
						to: String(doc.callee),
						token: ctx.secretBox.openText(doc.sealed, {
							aad: sealAad(websiteId, String(doc.callee), String(doc.caller), String(doc.jti)),
						}),
						scopes: [...doc.scopes],
					});
				} catch {
					// sealed under a key that is gone: the link is left out (Re-seal reports it; Regenerate makes a new one)
					ctx.logger.warn('link token cannot be opened', { websiteId, callee: doc.callee, caller: doc.caller });
				}
			}
			return {
				out,
				in: live
					.filter((each) => each.callee === productId)
					.map((doc) => ({ from: String(doc.caller), scopes: [...doc.scopes] })),
			};
		},

		/**
		 * Regenerate a link's token: the old one is revoked at once (callee and caller are told).
		 * @param {{ merchantId: string, websiteId: string, callee: string, caller: string } & Audited} input
		 */
		regenerate: async ({ merchantId, websiteId, callee, caller, actor, requestId = null, ip = null }) => {
			const website = await activeWebsite(websiteId);
			if (!website || website.merchantId !== merchantId) throw problem('not_found', 'No such website.');
			const doc = await load(merchantId, websiteId, callee, caller);
			if (doc.status === 'off') throw problem('conflict', 'This link is switched off. Switch it on first.');
			const fresh = await sign(website, callee, caller);
			const updated = await ownerOps(merchantId).updateOne({ merchantId, _id: doc._id, jti: doc.jti }, { $set: { ...fresh } });
			if (updated.matchedCount !== 1) throw problem('conflict', 'The link changed meanwhile. Reload and try again.');
			await revokeToken(doc);
			const version = await bump({ merchantId, websiteId });
			await ownerOps(merchantId).updateOne({ merchantId, _id: doc._id }, { $set: { atVersion: version } });
			await log(actor, doc, 'regenerated', {}, { requestId, ip });
			await notify(websiteId, 'links', [caller, callee]);
			return { regenerated: true };
		},

		/**
		 * Switch a link off (its token is revoked at once) or on again (a new token). A merchant's way to stop one product
		 * calling another.
		 * @param {{ merchantId: string, websiteId: string, callee: string, caller: string, on: boolean } & Audited} input
		 */
		switch: async ({ merchantId, websiteId, callee, caller, on, actor, requestId = null, ip = null }) => {
			const website = await activeWebsite(websiteId);
			if (!website || website.merchantId !== merchantId) throw problem('not_found', 'No such website.');
			const doc = await load(merchantId, websiteId, callee, caller);
			if ((doc.status === 'on') === on) return { on };
			if (on) {
				const fresh = await sign(website, callee, caller);
				await ownerOps(merchantId).updateOne({ merchantId, _id: doc._id }, { $set: { ...fresh, status: 'on' } });
			} else {
				await revokeToken(doc);
				await ownerOps(merchantId).updateOne(
					{ merchantId, _id: doc._id },
					{ $set: { status: 'off' }, $unset: { sealed: '', jti: '' } },
				);
			}
			const version = await bump({ merchantId, websiteId });
			await ownerOps(merchantId).updateOne({ merchantId, _id: doc._id }, { $set: { atVersion: version } });
			await log(actor, doc, on ? 'switched_on' : 'switched_off', {}, { requestId, ip });
			await notify(websiteId, 'links', [caller, callee]);
			return { on };
		},

		/**
		 * The website is removed: every link is revoked and deleted.
		 * @param {{ merchantId: string, websiteId: string }} input
		 */
		forget: async ({ merchantId, websiteId }) => {
			const docs = await ownerOps(merchantId).find({ merchantId, websiteId }).limit(200).toArray();
			for (const doc of docs) await revokeToken(doc);
			await ownerOps(merchantId).deleteMany({ merchantId, websiteId });
		},

		/**
		 * Settings → Encryption key → Re-seal: every link token sealed again with the current key.
		 * @returns {Promise<import('../../infra/crypto.js').ResealCounts>}
		 */
		reseal: async () => {
			const all = /** @type {import('../../infra/db.js').MutableOps} */ (store.acrossMerchants());
			const docs = await all
				.find({ sealed: { $type: 'string' } }, { projection: { websiteId: 1, caller: 1, callee: 1, jti: 1, sealed: 1 } })
				.toArray();
			return resealEach(
				ctx.secretBox,
				docs.map((doc) => ({
					sealed: doc.sealed,
					aad: sealAad(doc.websiteId, doc.callee, doc.caller, doc.jti),
					save: (/** @type {string} */ next) =>
						all.updateOne({ _id: doc._id, sealed: doc.sealed }, { $set: { sealed: next } }),
				})),
			);
		},
	});
};
