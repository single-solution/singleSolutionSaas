/**
 * Website Setup sheets (PLAN.md, website setup sheet and setup advisor): one generated
 * `ss.blueprint/1` per website, for the admin and the merchant, and read-only share links for a client or a developer.
 *
 * - **Gather**: every product on the website (not removed) is asked for its part (`GET /v1/blueprint?websiteId=`, a
 *   call signed with the Portal key, `@ss/protocol` `signPortalCall`) at the same time, each within
 *   {@link PRODUCT_ANSWER_MS}; a product that does not answer in time, refuses, or answers something that is not a
 *   product blueprint (`@ss/contracts`) shows as not reachable with the reason, and the sheet still renders. The
 *   Portal adds the website's facts: domain, the allowed origins, each product's public browser token and install
 *   snippet, and that its server token is issued (never the token). Generated on request, never stored: kept in this
 *   instance's memory for {@link SHEET_CACHE_MS} per website (light on free plans).
 * - **Share links**: a random 256-bit key, stored only as its SHA-256; it lasts 1–30 days (7 by default) and can be
 *   revoked. The address carries the key in its fragment (`/shared-setup#key=`), so it never reaches servers or logs;
 *   the page sends it in a POST body. A link may leave out the settings' values and the install details.
 * - **Business profile and advisor**: the merchant or an Owner or Support admin saves a short business profile of the
 *   website (`catalog_setup_profiles`); every sheet then carries it and, per product, the features it recommends and
 *   the features that are on although it rules them out (`core/advisor.js`, from the `recommendFor` tags each
 *   product's part names). **Switch on** (Owner or Support) asks the product to switch a feature on, with the
 *   features it needs (`POST /v1/blueprint/features`, a signed Portal call); the product reports the change to the
 *   Portal as its Features page does, which accepts it only for a current Owner or Support admin and writes
 *   `product.features_changed`. The sheet is then gathered again.
 * - **Activity**: `website.setup_opened` and `website.setup_downloaded` (the admin or merchant who did it),
 *   `website.setup_profile_saved`, `website.setup_shared`, `website.setup_share_revoked`, and
 *   `website.setup_share_opened` at most once an hour per link (the system, on behalf of whoever holds the link).
 * @module
 */
import { createId, validateProductBlueprint } from '@ss/contracts';
import { isNetError, textOf } from '@ss/net';
import { signPortalCall } from '@ss/protocol';
import { isProblem, problem } from '../../infra/http.js';
import { sha256Hex } from '../../infra/util.js';
import { assembleSheet, productEntry, reasonOfStatus, sharedCopy } from './core/setup.js';
import { PRODUCTS, SETUP_LINKS, SETUP_PROFILES } from './schema.js';

/** @typedef {import('../../infra/modules.js').ModuleContext} ModuleContext */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */
/** @typedef {import('@ss/contracts').Blueprint} Blueprint */
/** @typedef {import('@ss/contracts').BusinessProfile} BusinessProfile */
/** @typedef {import('./core/setup.js').GatheredProduct} GatheredProduct */
/** @typedef {{ actor: Actor, requestId?: string | null, ip?: string | null }} Audited */

/** How long a gathered sheet is kept per website (in this instance's memory). */
export const SHEET_CACHE_MS = 60_000;
/** How long each product has to answer. */
const PRODUCT_ANSWER_MS = 5_000;
/** How long a product has to switch a feature on (it reports to the Portal first). */
const SWITCH_ANSWER_MS = 10_000;
/** Sheets kept at most (the oldest goes first). */
const SHEET_CACHE_LIMIT = 200;
const ANSWER_MAX_BYTES = 512 * 1024;
/** A share link's opening is written to Activity at most this often. */
const SHARE_OPEN_AUDIT_MS = 60 * 60_000;
/** Share links of one website that may be in use at once. */
export const SHARE_LINKS_MAX = 50;
const DAY_MS = 24 * 60 * 60_000;
const KEY = /^[A-Za-z0-9_-]{43}$/;
const NOT_SHARED = 'This share link does not exist, has expired or was revoked.';

/** @param {Uint8Array} bytes */
const base64url = (bytes) => Buffer.from(bytes).toString('base64url');

/**
 * @param {{ ctx: ModuleContext, policy: import('@ss/net').OutboundPolicy,
 *   fetch: import('./service.js').SafeFetch }} options
 */
export const createSetup = ({ ctx, policy, fetch }) => {
	const products = /** @type {import('../../infra/db.js').MutableOps} */ (ctx.collection(PRODUCTS));
	const links = /** @type {import('../../infra/db.js').TenantRepository} */ (ctx.collection(SETUP_LINKS));
	const profiles = /** @type {import('../../infra/db.js').TenantRepository} */ (ctx.collection(SETUP_PROFILES));
	/** @param {string} merchantId */
	const linksOf = (merchantId) => /** @type {import('../../infra/db.js').MutableOps} */ (links.forMerchant(merchantId));
	/** @param {string} merchantId */
	const profilesOf = (merchantId) => /** @type {import('../../infra/db.js').MutableOps} */ (profiles.forMerchant(merchantId));
	const identity = () => ctx.service('identity');
	/**
	 * Gathered products per website, with their status (the profile and the advice are added at each read).
	 * @type {Map<string, { until: number, at: number, status: Blueprint['website']['status'], products: GatheredProduct[] }>}
	 */
	const cache = new Map();

	/**
	 * @param {string} action
	 * @param {{ type: string, id: string, name?: string | null } | Actor} actor
	 * @param {{ merchantId: string, websiteId: string }} website
	 * @param {{ after?: Record<string, unknown>, requestId?: string | null, ip?: string | null }} [extra]
	 */
	const audit = (action, actor, { merchantId, websiteId }, { after, requestId = null, ip = null } = {}) =>
		ctx.audit.record({
			actor: /** @type {any} */ (actor),
			action,
			target: { type: 'website', id: websiteId, merchantId, websiteId },
			...(after ? { after } : {}),
			requestId,
			ip,
		});

	/**
	 * The merchant's active website, else 404.
	 * @param {string} merchantId
	 * @param {string} websiteId
	 * @returns {Promise<{ websiteId: string, merchantId: string, domain: string }>}
	 */
	const websiteOf = async (merchantId, websiteId) => {
		const website = await identity()
			.getWebsite(websiteId)
			.catch((/** @type {unknown} */ error) => {
				if (isProblem(error)) return null;
				throw error;
			});
		if (!website || website.merchantId !== merchantId || website.status !== 'active')
			throw problem('not_found', 'No such website.');
		return website;
	};

	/**
	 * One product's part, or why it is missing.
	 * @param {string} productId
	 * @param {string} websiteId
	 * @returns {Promise<Parameters<typeof productEntry>[1]>}
	 */
	const ask = async (productId, websiteId) => {
		const product = await products.findOne({ _id: productId });
		if (!product) return { ok: false, reason: 'unreachable' };
		const url = new URL(`${String(product.baseUrl).replace(/\/+$/, '')}/v1/blueprint`);
		url.searchParams.set('websiteId', websiteId);
		try {
			const headers = await signPortalCall({
				signer: ctx.keys.signer,
				audience: productId,
				method: 'GET',
				target: `${url.pathname}${url.search}`,
				timestamp: Math.floor(ctx.now() / 1000),
				randomBytes: ctx.randomBytes,
			});
			const res = await fetch(
				url.toString(),
				{
					method: 'GET',
					headers: { accept: 'application/json', ...headers },
					timeoutMs: PRODUCT_ANSWER_MS,
					maxBytes: ANSWER_MAX_BYTES,
					redirect: 'error',
				},
				policy,
			);
			const reason = reasonOfStatus(res.status);
			if (reason !== null) {
				ctx.logger.warn('setup sheet: a product refused', { productId, status: res.status });
				return { ok: false, reason };
			}
			/** @type {unknown} */
			let json = null;
			try {
				json = JSON.parse(textOf(res));
			} catch {
				json = null;
			}
			const checked = validateProductBlueprint(json);
			if (!checked.ok || checked.value.productId !== productId) {
				ctx.logger.warn('setup sheet: a product answered no blueprint', { productId });
				return { ok: false, reason: 'invalid' };
			}
			return { ok: true, blueprint: checked.value, apiBase: String(product.baseUrl).replace(/\/+$/, '') };
		} catch (error) {
			if (!isNetError(error)) throw error;
			ctx.logger.warn('setup sheet: a product did not answer', { productId, reason: error.code });
			return { ok: false, reason: error.code === 'timeout' ? 'timeout' : 'unreachable' };
		}
	};

	/**
	 * The products of a website as gathered, with the status they have: kept for a minute, gathered again when older or
	 * when `fresh`.
	 * @param {{ merchantId: string, websiteId: string, fresh?: boolean }} input
	 * @returns {Promise<{ at: number, status: Blueprint['website']['status'], products: GatheredProduct[] }>}
	 */
	const gathered = async ({ merchantId, websiteId, fresh = false }) => {
		const kept = cache.get(websiteId);
		if (!fresh && kept && kept.until > ctx.now()) return kept;
		const entries = /** @type {Array<{ productId: string, name: string, browserToken: string }>} */ (
			await identity().installOf({ merchantId, websiteId })
		);
		const [status, answers] = await Promise.all([
			ctx.service('commerce').productsStatus(merchantId),
			Promise.all(entries.map((entry) => ask(entry.productId, websiteId))),
		]);
		const fresher = {
			until: ctx.now() + SHEET_CACHE_MS,
			at: ctx.now(),
			status,
			products: entries.map((entry, index) => productEntry(entry, /** @type {any} */ (answers[index]))),
		};
		cache.delete(websiteId);
		cache.set(websiteId, fresher);
		while (cache.size > SHEET_CACHE_LIMIT) cache.delete(/** @type {string} */ (cache.keys().next().value));
		return fresher;
	};

	/**
	 * The business profile of a website, or null.
	 * @param {string} merchantId
	 * @param {string} websiteId
	 * @returns {Promise<BusinessProfile | null>}
	 */
	const profileOf = async (merchantId, websiteId) =>
		(await profilesOf(merchantId).findOne({ merchantId, _id: websiteId }))?.profile ?? null;

	/**
	 * The sheet of a website: its products as gathered, with its business profile and the advice for it.
	 * @param {{ merchantId: string, websiteId: string, domain: string, fresh?: boolean }} input
	 * @returns {Promise<Blueprint>}
	 */
	const sheetOf = async ({ merchantId, websiteId, domain, fresh = false }) => {
		const [{ at, status, products }, profile] = await Promise.all([
			gathered({ merchantId, websiteId, fresh }),
			profileOf(merchantId, websiteId),
		]);
		return assembleSheet({ websiteId, domain, status, products, profile, now: at });
	};

	/**
	 * Ask a product to switch features on for an admin (a signed Portal call).
	 * @param {{ productId: string, websiteId: string, features: string[], actor: Actor }} input
	 * @returns {Promise<{ added: string[] }>}
	 */
	const askToSwitchOn = async ({ productId, websiteId, features, actor }) => {
		const product = await products.findOne({ _id: productId });
		if (!product) throw problem('not_found', 'No such product.');
		const url = new URL(`${String(product.baseUrl).replace(/\/+$/, '')}/v1/blueprint/features`);
		url.searchParams.set('websiteId', websiteId);
		const body = JSON.stringify({ features, admin: { id: actor.id, name: actor.name ?? actor.id, role: actor.role } });
		/** @type {import('@ss/net').SafeResponse} */
		let res;
		try {
			const headers = await signPortalCall({
				signer: ctx.keys.signer,
				audience: productId,
				method: 'POST',
				target: `${url.pathname}${url.search}`,
				body,
				timestamp: Math.floor(ctx.now() / 1000),
				randomBytes: ctx.randomBytes,
			});
			res = await fetch(
				url.toString(),
				{
					method: 'POST',
					headers: { accept: 'application/json', 'content-type': 'application/json', ...headers },
					body,
					timeoutMs: SWITCH_ANSWER_MS,
					maxBytes: ANSWER_MAX_BYTES,
					redirect: 'error',
				},
				policy,
			);
		} catch (error) {
			if (!isNetError(error)) throw error;
			ctx.logger.warn('setup sheet: a product did not answer a switch', { productId, reason: error.code });
			throw problem('upstream_error', 'The product did not answer. Refresh to see whether the feature is on, then try again.');
		}
		/** @type {Record<string, any>} */
		let answer = {};
		try {
			const json = JSON.parse(textOf(res));
			if (json && typeof json === 'object') answer = json;
		} catch {
			answer = {};
		}
		if (res.status === 200 && Array.isArray(answer.added)) return { added: answer.added.map(String) };
		const said = typeof answer.detail === 'string' && answer.detail.trim() !== '' ? answer.detail.trim().slice(0, 300) : null;
		ctx.logger.warn('setup sheet: a product refused a switch', { productId, status: res.status });
		if (res.status === 422 || res.status === 409)
			throw problem('catalog_switch_refused', said ?? 'The product refused the change. Nothing was changed.');
		throw problem('upstream_error', said ?? 'The product could not switch the feature on. Nothing was changed.');
	};

	/** @param {Record<string, any>} doc */
	const linkView = (doc) => {
		const expiresAt = new Date(doc.expiresAt);
		return {
			linkId: String(doc._id),
			createdAt: new Date(doc.createdAt).toISOString(),
			createdBy: /** @type {'admin' | 'merchant'} */ (doc.createdBy),
			expiresAt: expiresAt.toISOString(),
			revokedAt: doc.revokedAt ? new Date(doc.revokedAt).toISOString() : null,
			status: doc.revokedAt ? 'revoked' : expiresAt.getTime() <= ctx.now() ? 'expired' : 'active',
			values: doc.values === true,
			install: doc.install === true,
			openedAt: doc.openedAt ? new Date(doc.openedAt).toISOString() : null,
			opens: Number(doc.opens ?? 0),
		};
	};

	return Object.freeze({
		/**
		 * The Setup sheet of a merchant's website, for the admin or the merchant (Activity `website.setup_opened`, or
		 * `website.setup_downloaded` for the JSON file).
		 * @param {{ merchantId: string, websiteId: string, fresh?: boolean, download?: boolean } & Audited} input
		 */
		sheet: async ({ merchantId, websiteId, fresh = false, download = false, actor, requestId = null, ip = null }) => {
			const website = await websiteOf(merchantId, websiteId);
			const sheet = await sheetOf({ merchantId, websiteId, domain: website.domain, fresh });
			await audit(
				download ? 'website.setup_downloaded' : 'website.setup_opened',
				actor,
				{ merchantId, websiteId },
				{ requestId, ip },
			);
			return { sheet, domain: website.domain };
		},

		/**
		 * Save the website's business profile (`core/advisor.js` `parseProfile`; null removes it), Activity
		 * `website.setup_profile_saved`; answers the sheet with the advice for it (the products as gathered).
		 * @param {{ merchantId: string, websiteId: string, profile: BusinessProfile | null } & Audited} input
		 * @returns {Promise<Blueprint>}
		 */
		saveProfile: async ({ merchantId, websiteId, profile, actor, requestId = null, ip = null }) => {
			const website = await websiteOf(merchantId, websiteId);
			if (profile === null) await profilesOf(merchantId).deleteOne({ merchantId, _id: websiteId });
			else await profilesOf(merchantId).updateOne({ merchantId, _id: websiteId }, { $set: { profile } }, { upsert: true });
			await audit('website.setup_profile_saved', actor, { merchantId, websiteId }, { after: { profile }, requestId, ip });
			return sheetOf({ merchantId, websiteId, domain: website.domain });
		},

		/**
		 * The advisor's Switch on (Owner or Support): the product switches the feature on with every feature it needs,
		 * for this admin, and reports it to the Portal like its Features page; then the sheet is gathered again.
		 * @param {{ merchantId: string, websiteId: string, productId: string, feature: string } & Audited} input
		 * @returns {Promise<{ added: string[], sheet: Blueprint }>}
		 */
		switchOn: async ({ merchantId, websiteId, productId, feature, actor }) => {
			const website = await websiteOf(merchantId, websiteId);
			const entries = /** @type {Array<{ productId: string }>} */ (await identity().installOf({ merchantId, websiteId }));
			if (!entries.some((entry) => entry.productId === productId))
				throw problem('not_found', 'This product is not on the website.');
			const { added } = await askToSwitchOn({ productId, websiteId, features: [feature], actor });
			return { added, sheet: await sheetOf({ merchantId, websiteId, domain: website.domain, fresh: true }) };
		},

		/**
		 * Create a share link (Activity `website.setup_shared`). The address is answered once: only the key's hash is kept.
		 * @param {{ merchantId: string, websiteId: string, days: number, values: boolean, install: boolean } & Audited} input
		 */
		createLink: async ({ merchantId, websiteId, days, values, install, actor, requestId = null, ip = null }) => {
			await websiteOf(merchantId, websiteId);
			const now = new Date(ctx.now());
			const inUse = await linksOf(merchantId).countDocuments({
				merchantId,
				websiteId,
				revokedAt: null,
				expiresAt: { $gt: now },
			});
			if (inUse >= SHARE_LINKS_MAX)
				throw problem('conflict', `A website has at most ${SHARE_LINKS_MAX} share links in use. Revoke one first.`);
			const key = base64url(ctx.randomBytes(32));
			const doc = {
				_id: createId('shl', { randomBytes: ctx.randomBytes }),
				merchantId,
				websiteId,
				keyHash: sha256Hex(key),
				values,
				install,
				expiresAt: new Date(now.getTime() + days * DAY_MS),
				revokedAt: null,
				createdBy: actor.type === 'admin' ? 'admin' : 'merchant',
				openedAt: null,
				opens: 0,
			};
			await linksOf(merchantId).insertOne(doc);
			const link = linkView({ ...doc, createdAt: now });
			await audit(
				'website.setup_shared',
				actor,
				{ merchantId, websiteId },
				{ after: { linkId: link.linkId, expiresAt: link.expiresAt, values, install }, requestId, ip },
			);
			return { link, url: `${ctx.config.portalUrl}/shared-setup#key=${key}` };
		},

		/**
		 * The website's share links that have not expired (revoked ones too), newest first.
		 * @param {{ merchantId: string, websiteId: string }} input
		 */
		listLinks: async ({ merchantId, websiteId }) => {
			await websiteOf(merchantId, websiteId);
			const docs = await linksOf(merchantId)
				.find({ merchantId, websiteId, expiresAt: { $gt: new Date(ctx.now()) } })
				.sort({ createdAt: -1, _id: -1 })
				.limit(SHARE_LINKS_MAX * 2)
				.toArray();
			return { items: docs.map(linkView) };
		},

		/**
		 * Revoke a share link at once (Activity `website.setup_share_revoked`); revoking it again changes nothing.
		 * @param {{ merchantId: string, websiteId: string, linkId: string } & Audited} input
		 */
		revokeLink: async ({ merchantId, websiteId, linkId, actor, requestId = null, ip = null }) => {
			await websiteOf(merchantId, websiteId);
			const doc = await linksOf(merchantId).findOne({ merchantId, websiteId, _id: linkId });
			if (!doc) throw problem('not_found', 'No such share link.');
			if (doc.revokedAt) return linkView(doc);
			const revokedAt = new Date(ctx.now());
			await linksOf(merchantId).updateOne({ merchantId, _id: linkId, revokedAt: null }, { $set: { revokedAt } });
			await audit('website.setup_share_revoked', actor, { merchantId, websiteId }, { after: { linkId }, requestId, ip });
			return linkView({ ...doc, revokedAt });
		},

		/**
		 * The sheet a share link shows, read-only, to whoever holds its key; the same 404 for a key that never existed,
		 * expired or was revoked.
		 * @param {{ key: unknown, requestId?: string | null, ip?: string | null }} input
		 */
		shared: async ({ key, requestId = null, ip = null }) => {
			if (typeof key !== 'string' || !KEY.test(key)) throw problem('not_found', NOT_SHARED);
			const all = /** @type {import('../../infra/db.js').MutableOps} */ (links.acrossMerchants());
			const doc = await all.findOne({ keyHash: sha256Hex(key) });
			const now = ctx.now();
			if (!doc || doc.revokedAt || new Date(doc.expiresAt).getTime() <= now) throw problem('not_found', NOT_SHARED);
			const merchantId = String(doc.merchantId);
			const websiteId = String(doc.websiteId);
			const website = await websiteOf(merchantId, websiteId).catch((/** @type {unknown} */ error) => {
				throw isProblem(error) ? problem('not_found', NOT_SHARED) : error;
			});
			const sheet = await sheetOf({ merchantId, websiteId, domain: website.domain });
			const lastOpened = doc.openedAt ? new Date(doc.openedAt).getTime() : -Infinity;
			await linksOf(merchantId).updateOne(
				{ merchantId, _id: doc._id },
				{ $set: { openedAt: new Date(now) }, $inc: { opens: 1 } },
			);
			if (now - lastOpened >= SHARE_OPEN_AUDIT_MS)
				await audit(
					'website.setup_share_opened',
					{ type: 'system', id: 'setup_share' },
					{ merchantId, websiteId },
					{ after: { linkId: String(doc._id) }, requestId, ip },
				);
			return sharedCopy(sheet, {
				values: doc.values === true,
				install: doc.install === true,
				expiresAt: new Date(doc.expiresAt).toISOString(),
			});
		},
	});
};
/** @typedef {ReturnType<typeof createSetup>} Setup */
