/**
 * Bring-your-own customer identity (PLAN §5.3): per website, the merchant registers the issuer of its own login
 * (`{ issuer, jwksUrl | publicJwks[], audience?, claimMap }`). The issuer's public keys travel inline in every signed
 * entitlement document of the website (`identity` section, built by commerce through {@link identityFor}), so
 * products verify `SS-Identity` tokens offline with `@ss/app-kit` `identity.verify`.
 *
 * - A `jwksUrl` is fetched with `@ss/net` `safeFetch` (https only, every DNS answer vetted, no redirects, 5 s, 64 KiB)
 *   when saved and then at most hourly when documents are rebuilt ({@link JWKS_TTL_MS}); a failed refresh keeps the
 *   last good keys and retries after {@link JWKS_RETRY_MS}. Saving refuses a JWKS URL that yields no usable key.
 * - Only public signature keys are stored (Ed25519, P-256, RSA ≥ 2048, ≤ 5). No customer data is stored.
 * - Every change is audited and re-signs the website's documents (`commerce.invalidateWebsite`).
 * @module
 */
import { checkUrl, createOutboundPolicy, isNetError, safeFetch as netFetch, textOf } from '@ss/net';
import { problem } from '../../infra/http.js';
import { JWKS_MAX_BYTES, identitySection, jwksDue, keysOfJwks, presentIssuer } from './core/issuer.js';

/** @typedef {import('./repo.js').Deps} Deps */
/** @typedef {import('./repo.js').Meta} Meta */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */
/** @typedef {import('./core/issuer.js').IssuerInput} IssuerInput */
/** @typedef {import('@ss/contracts').IdentitySection} IdentitySection */
/** @typedef {typeof netFetch} SafeFetch */

/**
 * @typedef {object} IssuerOptions
 * @property {ReadonlyArray<string>} [allowHosts] development allowlist (default `ctx.config.outbound.allowHosts`; empty in production)
 * @property {import('@ss/net').Resolver} [resolve] DNS resolver of the outbound policy (tests)
 * @property {SafeFetch} [fetch] replaces `@ss/net` `safeFetch` (tests)
 */

/**
 * @param {Deps} deps
 * @param {{ loadWebsite: (websiteId: string, merchantId?: string) => Promise<Record<string, any>>,
 *   collection: import('../../infra/db.js').TenantRepository, options?: IssuerOptions }} hooks
 */
export const createIssuers = (deps, { loadWebsite, collection, options = {} }) => {
	const { ctx, audit } = deps;
	const policy = createOutboundPolicy({
		allowHosts: ctx.config.isProduction ? [] : [...(options.allowHosts ?? ctx.config.outbound.allowHosts)],
		maxRedirects: 0,
		timeoutMs: 5_000,
		maxBytes: JWKS_MAX_BYTES,
		userAgent: 'ss-portal-identity/1',
		...(options.resolve ? { resolve: options.resolve } : {}),
	});
	const safeFetch = options.fetch ?? netFetch;
	/** @param {string} merchantId */
	const of = (merchantId) => /** @type {import('../../infra/db.js').MutableOps} */ (collection.forMerchant(merchantId));
	const all = () => /** @type {import('../../infra/db.js').MutableOps} */ (collection.acrossMerchants());
	/** @type {Map<string, Promise<unknown>>} single flight of JWKS refreshes per website */
	const inflight = new Map();

	/**
	 * Fetch and normalise a JWKS.
	 * @param {string} url
	 * @returns {Promise<{ ok: true, keys: import('@ss/contracts').IdentityJwk[], skipped: number } | { ok: false, reason: string }>}
	 */
	const fetchJwks = async (url) => {
		const checked = checkUrl(url, policy);
		if (!checked.ok) return { ok: false, reason: `destination refused (${checked.reason})` };
		try {
			const res = await safeFetch(url, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'error' }, policy);
			if (res.status !== 200) return { ok: false, reason: `the JWKS URL answered ${res.status}` };
			/** @type {unknown} */
			let json;
			try {
				json = JSON.parse(textOf(res));
			} catch {
				return { ok: false, reason: 'the JWKS is not JSON' };
			}
			return keysOfJwks(json);
		} catch (error) {
			if (isNetError(error)) return { ok: false, reason: `the JWKS URL could not be fetched (${error.code})` };
			throw error;
		}
	};

	/**
	 * Refresh the keys of a JWKS-URL issuer and store the outcome (last good keys survive failures).
	 * @param {Record<string, any>} doc
	 * @returns {Promise<Record<string, any>>}
	 */
	const refreshStored = async (doc) => {
		const at = new Date(ctx.now());
		const fetched = await fetchJwks(doc.jwksUrl);
		const set = fetched.ok
			? { keys: fetched.keys, keysFetchedAt: at, keysFailedAt: null, lastError: null, skippedKeys: fetched.skipped }
			: { keysFailedAt: at, lastError: fetched.reason };
		if (!fetched.ok) ctx.logger.warn('identity issuer JWKS refresh failed', { websiteId: doc._id, reason: fetched.reason });
		await of(doc.merchantId).updateOne({ _id: doc._id, merchantId: doc.merchantId }, { $set: set });
		return { ...doc, ...set };
	};

	/**
	 * @param {Record<string, any>} website
	 * @returns {Promise<Record<string, any> | null>}
	 */
	const stored = (website) =>
		of(String(website.merchantId)).findOne({ _id: String(website._id), merchantId: String(website.merchantId) });

	/** Re-sign the website's documents (best effort: documents also refresh on their own within minutes). */
	const resign = async (/** @type {string} */ websiteId) => {
		if (!ctx.moduleNames().includes('commerce')) return;
		try {
			await ctx.service('commerce').invalidateWebsite(websiteId);
		} catch (error) {
			ctx.logger.warn('entitlement documents not re-signed after an identity change', { websiteId, error });
		}
	};

	return Object.freeze({
		/**
		 * The website's identity issuer, or null.
		 * @param {{ merchantId: string, websiteId: string }} input
		 */
		getIssuer: async ({ merchantId, websiteId }) => {
			const doc = await stored(await loadWebsite(websiteId, merchantId));
			return doc ? presentIssuer(doc) : null;
		},

		/**
		 * The stored issuer record (internal: issuer requests compare against it), or null.
		 * @param {{ merchantId: string, websiteId: string }} input
		 */
		stored: async ({ merchantId, websiteId }) => stored(await loadWebsite(websiteId, merchantId)),

		/**
		 * Check an issuer input without storing it: a JWKS URL must yield a usable key now (product issuer requests).
		 * @param {IssuerInput} input
		 */
		checkInput: async (input) => {
			if (!input.jwksUrl) return { ok: true, kids: (input.publicJwks ?? []).map((k) => k.kid) };
			const fetched = await fetchJwks(input.jwksUrl);
			if (!fetched.ok)
				throw problem('validation_failed', 'The JWKS URL did not yield a usable key.', {
					errors: [{ path: '/jwksUrl', message: fetched.reason }],
				});
			return { ok: true, kids: fetched.keys.map((k) => k.kid) };
		},

		/**
		 * Register or replace the website's identity issuer. A JWKS URL is fetched now and must yield a usable key.
		 * `managedBy` names the product whose approved request set it (F.16); a merchant's own change clears it.
		 * @param {{ merchantId: string, websiteId: string, input: IssuerInput, actor: Actor, meta?: Meta,
		 *   managedBy?: { appId: string, slug: string, name: string } | null }} input
		 */
		setIssuer: async ({ merchantId, websiteId, input, actor, meta = {}, managedBy = null }) => {
			const website = await loadWebsite(websiteId, merchantId);
			if (website.status !== 'active') throw problem('conflict', 'The website is deleted.');
			const at = new Date(ctx.now());
			/** @type {Record<string, any>} */
			let keys = { keys: input.publicJwks, keysFetchedAt: null, keysFailedAt: null, lastError: null, skippedKeys: 0 };
			if (input.jwksUrl) {
				const fetched = await fetchJwks(input.jwksUrl);
				if (!fetched.ok)
					throw problem('validation_failed', 'The JWKS URL did not yield a usable key.', {
						errors: [{ path: '/jwksUrl', message: fetched.reason }],
					});
				keys = { keys: fetched.keys, keysFetchedAt: at, keysFailedAt: null, lastError: null, skippedKeys: fetched.skipped };
			}
			const before = await stored(website);
			/** @type {Record<string, any>} */
			const doc = {
				issuer: input.issuer,
				jwksUrl: input.jwksUrl,
				audience: input.audience,
				claimMap: input.claimMap,
				managedBy,
				...keys,
			};
			await of(merchantId).updateOne({ _id: websiteId, merchantId }, { $set: doc }, { upsert: true });
			const after = /** @type {Record<string, any>} */ (await stored(website));
			await audit(
				actor,
				before ? 'website.identity_updated' : 'website.identity_set',
				{ type: 'website', id: websiteId, merchantId, websiteId },
				{
					...(before ? { before: { issuer: before.issuer, source: before.jwksUrl ? 'jwks_url' : 'inline' } } : {}),
					after: {
						issuer: doc.issuer,
						source: doc.jwksUrl ? 'jwks_url' : 'inline',
						kids: doc.keys.map((/** @type {any} */ k) => k.kid),
						...(managedBy ? { managedBy: managedBy.appId } : {}),
					},
					meta,
				},
			);
			await resign(websiteId);
			return presentIssuer(after);
		},

		/**
		 * Remove the website's identity issuer (products stop accepting federated customer tokens).
		 * @param {{ merchantId: string, websiteId: string, actor: Actor, meta?: Meta }} input
		 */
		removeIssuer: async ({ merchantId, websiteId, actor, meta = {} }) => {
			await loadWebsite(websiteId, merchantId);
			const { deletedCount } = await of(merchantId).deleteOne({ _id: websiteId, merchantId });
			if (deletedCount === 0) throw problem('not_found', 'This website has no identity issuer.');
			await audit(actor, 'website.identity_removed', { type: 'website', id: websiteId, merchantId, websiteId }, { meta });
			await resign(websiteId);
			return { websiteId, removed: true };
		},

		/**
		 * Fetch the JWKS URL now (console "Refresh keys").
		 * @param {{ merchantId: string, websiteId: string, actor: Actor, meta?: Meta }} input
		 */
		refreshKeys: async ({ merchantId, websiteId, actor, meta = {} }) => {
			const doc = await stored(await loadWebsite(websiteId, merchantId));
			if (!doc) throw problem('not_found', 'This website has no identity issuer.');
			if (!doc.jwksUrl) throw problem('conflict', 'This issuer has inline keys; there is nothing to fetch.');
			const refreshed = await refreshStored(doc);
			await audit(
				actor,
				'website.identity_keys_refreshed',
				{ type: 'website', id: websiteId, merchantId, websiteId },
				{
					after: { ok: !refreshed.lastError, kids: (refreshed.keys ?? []).map((/** @type {any} */ k) => k.kid) },
					meta,
				},
			);
			await resign(websiteId);
			return presentIssuer(refreshed);
		},

		/**
		 * The `identity` section of the website's entitlement documents (commerce), or null. Refreshes a due JWKS
		 * first (single flight; failures keep the last good keys). Never throws for issuer problems.
		 * @param {string} websiteId
		 * @returns {Promise<IdentitySection | null>}
		 */
		identityFor: async (websiteId) => {
			if (typeof websiteId !== 'string') return null;
			let doc = await all().findOne({ _id: websiteId });
			if (!doc) return null;
			if (jwksDue(doc, ctx.now())) {
				const pending = inflight.get(websiteId) ?? refreshStored(doc).finally(() => inflight.delete(websiteId));
				inflight.set(websiteId, pending);
				try {
					doc = /** @type {Record<string, any>} */ (await pending);
				} catch (error) {
					ctx.logger.warn('identity issuer refresh failed', { websiteId, error });
				}
			}
			return identitySection(/** @type {any} */ (doc));
		},

		/**
		 * Drop the issuers of deleted websites (called by website deletion).
		 * @param {{ merchantId: string, websiteIds: string[] }} input
		 */
		forget: async ({ merchantId, websiteIds }) => {
			if (websiteIds.length === 0) return 0;
			const { deletedCount } = await of(merchantId).deleteMany({ merchantId, _id: { $in: websiteIds } });
			return deletedCount;
		},
	});
};
/** @typedef {ReturnType<typeof createIssuers>} Issuers */
