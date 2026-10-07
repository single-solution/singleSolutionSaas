/**
 * Public service of the `catalog` module: connected products (PLAN 0.8.2 Products, 0.4.12 row 1), launches (0.4.3)
 * and notices (0.4.12).
 *
 * - **Add product** (Owner): the admin gives the product's URL and its `CONNECT_SECRET`; the Portal calls
 *   `<url>/.well-known/ss-connect` (`@ss/protocol` handshake, HMAC both ways; the secret is never stored) sending
 *   `PORTAL_URL`, its published keys and its last accepted price-list version. The product answers its id, public key,
 *   manifest and current price list. The product is stored under its id, inactive; an id already connected is refused
 *   (Reconnect). The price list becomes the product's first accepted one (commerce).
 * - **Reconnect** (Owner): the same handshake with a new URL and/or secret; the product must answer the same id.
 *   Websites, tokens, switches and charges stay; the returned price list is handled as a price report.
 * - **Active / inactive**: inactive products are not offered in Add product; nothing else changes.
 * - **Launches**: merchant launches for the merchant's own websites that have the product (refused while suspended),
 *   admin launches for Owner and Support (Finance refused), with no website for Owners only.
 * - The `productKeys` port (the key a product signs its client assertions with) and the `productCalled` port (its
 *   waiting notices).
 * @module
 */
import { validateManifest, validatePriceReport } from '@ss/contracts';
import { checkUrl, createOutboundPolicy, isNetError, safeFetch as netFetch, textOf } from '@ss/net';
import {
	canonicalJson,
	canonicalUrl,
	createConnectRequest,
	createJwks,
	createKeyResolver,
	isConnectSecret,
	isProtocolError,
	issueLaunch as protocolIssueLaunch,
	verifyConnectResponse,
} from '@ss/protocol';
import { problem } from '../../infra/http.js';
import { isDuplicateKey } from '../../infra/util.js';
import { launchUrl } from './core/input.js';
import { createNotices } from './notices.js';
import { LAUNCHES, PRODUCTS } from './schema.js';

/** @typedef {import('../../infra/modules.js').ModuleContext} ModuleContext */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */
/** @typedef {import('@ss/contracts').Manifest} Manifest */
/** @typedef {import('@ss/contracts').PriceList} PriceList */
/** @typedef {import('@ss/protocol').KeyResolver} KeyResolver */
/** @typedef {import('@ss/net').OutboundPolicy} OutboundPolicy */
/**
 * Outbound HTTP client (the `@ss/net` `safeFetch` signature).
 * @typedef {(url: string, init: import('@ss/net').SafeFetchInit, policy: OutboundPolicy) =>
 *   Promise<import('@ss/net').SafeResponse>} SafeFetch
 */
/** @typedef {{ actor: Actor, requestId?: string | null, ip?: string | null }} Audited */
/** @typedef {import('../../infra/auth.js').Session} Session */

const ANSWER_MAX_BYTES = 512 * 1024;

/**
 * @typedef {object} CatalogOptions
 * @property {ReadonlyArray<string>} [allowHosts] hosts outbound calls may reach although private or plain http;
 *   default `ctx.config.outbound.allowHosts` (the loopback hosts outside production); always empty in production
 * @property {import('@ss/net').Resolver} [resolve] DNS resolver of the outbound policy (tests)
 * @property {SafeFetch} [fetch] outbound HTTP client (default: `@ss/net` `safeFetch`)
 */

/**
 * @param {string} code
 * @param {string} detail
 * @param {{ errors?: Array<{ path: string, message: string, keyword?: string }> }} [extra]
 * @returns {never}
 */
const fail = (code, detail, extra) => {
	throw problem(code, detail, extra);
};

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The reason a product gives in an error answer (its `problems` or problem `detail`), at most 5 short sentences.
 * @param {string} text the response body
 * @returns {string | null}
 */
const productReason = (text) => {
	/** @type {unknown} */
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isObject(json)) return null;
	const listed = Array.isArray(json.problems) ? json.problems.filter((p) => typeof p === 'string' && p.trim() !== '') : [];
	const reasons = listed.length > 0 ? listed : typeof json.detail === 'string' && json.detail.trim() !== '' ? [json.detail] : [];
	const joined = reasons
		.slice(0, 5)
		.map((reason) => reason.trim().slice(0, 300))
		.join(' ');
	return joined === '' ? null : joined;
};

/**
 * An address from the manifest (absolute, or a path under the base URL), or null.
 * @param {string | null | undefined} value
 * @param {string} baseUrl
 */
const absolute = (value, baseUrl) => {
	if (typeof value !== 'string' || value.length === 0) return null;
	try {
		return new URL(value, `${baseUrl}/`).toString();
	} catch {
		return null;
	}
};

/** @param {unknown} at */
const iso = (at) => (at instanceof Date ? at.toISOString() : null);

/**
 * @param {ModuleContext} ctx
 * @param {CatalogOptions} [options]
 */
export const createCatalogService = (ctx, options = {}) => {
	const products = /** @type {import('../../infra/db.js').MutableOps} */ (ctx.collection(PRODUCTS));
	const launches = /** @type {import('../../infra/db.js').MutableOps} */ (ctx.collection(LAUNCHES));
	/** @type {OutboundPolicy} */
	const policy = createOutboundPolicy({
		allowHosts: ctx.config.isProduction ? [] : [...(options.allowHosts ?? ctx.config.outbound.allowHosts)],
		userAgent: 'ss-portal/1',
		...(options.resolve ? { resolve: options.resolve } : {}),
	});
	/** @type {SafeFetch} */
	const safeFetch = options.fetch ?? netFetch;
	const notices = createNotices({ ctx, policy, fetch: safeFetch });
	const commerce = () => ctx.service('commerce');
	const identity = () => ctx.service('identity');

	/**
	 * @param {{ actor: Actor | { type: 'system' | 'product', id: string }, action: string, productId: string,
	 *   before?: unknown, after?: unknown, requestId?: string | null, ip?: string | null, merchantId?: string | null,
	 *   websiteId?: string | null }} entry
	 */
	const audit = ({
		actor,
		action,
		productId,
		before,
		after,
		requestId = null,
		ip = null,
		merchantId = null,
		websiteId = null,
	}) =>
		ctx.audit.record({
			actor: /** @type {any} */ (actor),
			action,
			target: websiteId
				? { type: 'website', id: websiteId, merchantId, websiteId }
				: { type: 'product', id: productId, merchantId },
			...(before === undefined ? {} : { before }),
			after: { productId, ...(isObject(after) ? after : {}) },
			requestId,
			ip,
		});

	/** @param {Record<string, any>} doc @returns {Manifest} */
	const manifestOf = (doc) => /** @type {Manifest} */ (JSON.parse(doc.manifestJson));

	/**
	 * The product as the consoles show it.
	 * @param {Record<string, any>} doc
	 */
	const view = (doc) => {
		const manifest = manifestOf(doc);
		return {
			productId: String(doc._id),
			name: manifest.name,
			status: /** @type {'active' | 'inactive'} */ (doc.status),
			baseUrl: String(doc.baseUrl),
			version: manifest.version,
			widgetScriptUrl: absolute(manifest.widgetScriptUrl, doc.baseUrl),
			docsUrl: absolute(manifest.docsUrl, doc.baseUrl),
			connectedAt: iso(doc.connectedAt),
			reconnectedAt: iso(doc.reconnectedAt),
		};
	};

	/** @param {string} productId */
	const load = async (productId) =>
		(await products.findOne({ _id: productId })) ?? fail('not_found', `No product ${productId} is connected.`);

	/**
	 * Canonical, SSRF-checked base URL (before any request).
	 * @param {string} value
	 */
	const baseUrlOf = (value) => {
		/** @type {string} */
		let canonical;
		try {
			canonical = canonicalUrl(value);
		} catch {
			return fail('validation_failed', 'The product address is not a valid URL.', {
				errors: [{ path: '/url', message: 'must be a plain http(s) URL' }],
			});
		}
		const checked = checkUrl(canonical, policy);
		if (!checked.ok) fail('catalog_target_refused', `The product address was refused (${checked.reason}).`);
		return canonical;
	};

	/**
	 * The connect handshake (PLAN 0.4.12 row 1): checked answer `{ productId, publicJwk, manifest, prices }`.
	 * @param {{ base: string, secret: string, priceListVersion: number }} input
	 */
	const handshake = async ({ base, secret, priceListVersion }) => {
		const request = createConnectRequest({
			secret,
			productUrl: base,
			portalUrl: ctx.config.portalUrl,
			jwks: ctx.keys.publishedJwks(),
			priceListVersion,
			now: ctx.now,
			randomBytes: ctx.randomBytes,
		});
		/** @type {{ status: number, headers: Record<string, string>, text: string }} */
		let res;
		try {
			const answer = await safeFetch(
				request.url,
				{ method: 'POST', headers: request.headers, body: request.body, maxBytes: ANSWER_MAX_BYTES, redirect: 'error' },
				policy,
			);
			res = { status: answer.status, headers: answer.headers, text: textOf(answer) };
		} catch (error) {
			if (!isNetError(error)) throw error;
			if (error.code === 'timeout') return fail('timeout', 'The product did not answer in time.');
			if (error.code === 'bad_url' || error.code === 'ssrf_blocked' || error.code === 'redirect_refused')
				return fail('catalog_target_refused', `The product address was refused (${error.reason}).`);
			return fail('upstream_error', `The product could not be reached (${error.reason}).`);
		}
		if (res.status === 401) fail('unauthorized', 'The product refused the connect secret.');
		if (res.status === 503)
			fail('upstream_error', productReason(res.text) ?? 'The product refuses connections: its CONNECT_SECRET is not set.');
		if (res.status !== 200) fail('upstream_error', `The product answered ${res.status}.`);
		/** @type {ReturnType<typeof verifyConnectResponse>} */
		let verified;
		try {
			verified = verifyConnectResponse({ secret, headers: res.headers, body: res.text, nonce: request.nonce, now: ctx.now });
		} catch (error) {
			ctx.logger.warn('product connection answer refused', { reason: isProtocolError(error) ? error.code : 'invalid' });
			return fail('upstream_error', 'The product answer does not verify.');
		}
		const manifest = validateManifest(verified.manifest);
		if (!manifest.ok)
			fail('invalid_manifest', 'The product manifest is invalid.', {
				errors: manifest.problems.map((p) => ({ path: `/manifest${p.path}`, message: p.message, keyword: p.keyword })),
			});
		const checkedManifest = /** @type {{ value: Manifest }} */ (manifest).value;
		if (checkedManifest.id !== verified.productId)
			fail('invalid_manifest', `The product answered ${verified.productId} but its manifest names ${checkedManifest.id}.`);
		const prices = validatePriceReport(verified.prices);
		if (!prices.ok)
			fail('validation_failed', 'The product price list is invalid.', {
				errors: prices.problems.map((p) => ({ path: `/prices${p.path}`, message: p.message, keyword: p.keyword })),
			});
		return {
			productId: verified.productId,
			publicJwk: verified.publicJwk,
			manifest: checkedManifest,
			prices: /** @type {{ value: PriceList }} */ (prices).value,
		};
	};

	/**
	 * Add product (Owner): connect a new product; it starts inactive. An id already connected is refused.
	 * @param {{ url: string, secret: string } & Audited} input
	 */
	const connect = async ({ url, secret, actor, requestId = null, ip = null }) => {
		if (!isConnectSecret(secret))
			fail('validation_failed', 'The connect secret must be at least 32 characters.', {
				errors: [{ path: '/secret', message: 'must be at least 32 characters' }],
			});
		const base = baseUrlOf(url);
		const answer = await handshake({ base, secret, priceListVersion: 0 });
		if (await products.findOne({ _id: answer.productId }))
			fail('conflict', `${answer.productId} is already connected: use Reconnect on its product page.`);
		const at = new Date(ctx.now());
		const doc = {
			_id: answer.productId,
			status: 'inactive',
			baseUrl: base,
			manifestJson: canonicalJson(answer.manifest),
			publicJwk: answer.publicJwk,
			connectedAt: at,
			reconnectedAt: null,
		};
		try {
			await products.insertOne(doc);
		} catch (error) {
			if (isDuplicateKey(error))
				fail('conflict', `${answer.productId} is already connected: use Reconnect on its product page.`);
			throw error;
		}
		await commerce().recordPriceList({ productId: answer.productId, prices: answer.prices, requestId, ip });
		await audit({ actor, action: 'product.connected', productId: answer.productId, after: { baseUrl: base }, requestId, ip });
		return view({ ...doc, createdAt: at });
	};

	/**
	 * Reconnect (Owner): the same product with a new URL and/or secret; it must answer the same id.
	 * @param {{ productId: string, url: string | null, secret: string } & Audited} input
	 */
	const reconnect = async ({ productId, url, secret, actor, requestId = null, ip = null }) => {
		const existing = await load(productId);
		if (!isConnectSecret(secret))
			fail('validation_failed', 'The connect secret must be at least 32 characters.', {
				errors: [{ path: '/secret', message: 'must be at least 32 characters' }],
			});
		const base = baseUrlOf(url ?? existing.baseUrl);
		const accepted = await commerce().priceListVersion(productId);
		const answer = await handshake({ base, secret, priceListVersion: accepted });
		if (answer.productId !== productId)
			fail('conflict', `The product answered ${answer.productId}, not ${productId}. Reconnect needs the same product.`);
		if (answer.prices.version < accepted)
			fail('conflict', `The product answered price list ${answer.prices.version}; ${accepted} is already accepted.`);
		await products.updateOne(
			{ _id: productId },
			{
				$set: {
					baseUrl: base,
					manifestJson: canonicalJson(answer.manifest),
					publicJwk: answer.publicJwk,
					reconnectedAt: new Date(ctx.now()),
				},
			},
		);
		if (answer.prices.version > accepted) await commerce().recordPriceList({ productId, prices: answer.prices, requestId, ip });
		await audit({
			actor,
			action: 'product.reconnected',
			productId,
			before: { baseUrl: existing.baseUrl },
			after: { baseUrl: base },
			requestId,
			ip,
		});
		return view(await load(productId));
	};

	/**
	 * Set active / inactive (Owner).
	 * @param {{ productId: string, status: 'active' | 'inactive' } & Audited} input
	 */
	const setStatus = async ({ productId, status, actor, requestId = null, ip = null }) => {
		const doc = await load(productId);
		if (doc.status === status) return view(doc);
		await products.updateOne({ _id: productId }, { $set: { status } });
		await audit({
			actor,
			action: status === 'active' ? 'product.activated' : 'product.deactivated',
			productId,
			before: { status: doc.status },
			after: { status },
			requestId,
			ip,
		});
		return view({ ...doc, status });
	};

	/**
	 * Branding and support contact of launches (Settings).
	 */
	const launchContext = () => {
		const { branding, support } = ctx.config.settings;
		return {
			branding: {
				name: branding.name,
				accent: branding.accent,
				logoUrl: branding.hasLogo ? `${ctx.config.portalUrl}/branding/logo?v=${branding.logoVersion}` : null,
			},
			support: {
				email: support.email ?? '',
				phone: support.phone ?? '',
				...(support.whatsapp ? { whatsapp: support.whatsapp } : {}),
			},
		};
	};

	/**
	 * Sign a launch, remember its id for consumption and log the opening.
	 * @param {{ productId: string, session: Session, actor: Actor, claims: { kind: 'merchant', merchant: any } |
	 *   { kind: 'admin', admin: any }, merchantId: string | null, websiteId: string | null, requestId?: string | null,
	 *   ip?: string | null }} input
	 */
	const sign = async ({ productId, session, actor, claims, merchantId, websiteId, requestId = null, ip = null }) => {
		const doc = await load(productId);
		/** @type {Awaited<ReturnType<typeof protocolIssueLaunch>>} */
		let issued;
		try {
			issued = await protocolIssueLaunch({
				signer: ctx.keys.signer,
				issuer: ctx.config.portalUrl,
				audience: productId,
				sessionExpiresAt: new Date(session.expiresAt).toISOString(),
				...launchContext(),
				...claims,
				now: ctx.now,
				randomBytes: ctx.randomBytes,
			});
		} catch (error) {
			if (isProtocolError(error)) return fail('catalog_launch_refused', error.message);
			throw error;
		}
		await launches.insertOne({
			_id: issued.claims.jti,
			productId,
			kind: issued.claims.kind,
			subject: issued.claims.sub,
			expireAt: new Date((issued.claims.exp + 5) * 1000),
		});
		await audit({
			actor,
			action: 'product.dashboard_opened',
			productId,
			merchantId,
			websiteId,
			after: { kind: issued.claims.kind },
			requestId,
			ip,
		});
		return { url: launchUrl(doc.baseUrl, issued.token), expiresAt: new Date(issued.claims.exp * 1000).toISOString() };
	};

	/**
	 * A merchant opens a product dashboard for one of its websites that has the product (PLAN 0.4.3). Refused while
	 * the merchant is suspended.
	 * @param {{ merchantId: string, websiteId: string, productId: string, session: Session } & Audited} input
	 */
	const merchantLaunch = async ({ merchantId, websiteId, productId, session, actor, requestId = null, ip = null }) => {
		const merchant = await identity().getMerchant(merchantId);
		if (merchant.status !== 'active') fail('merchant_suspended', 'The merchant is suspended.');
		const websiteIds = /** @type {string[]} */ (await commerce().merchantWebsitesWithProduct(merchantId, productId));
		if (!websiteIds.includes(websiteId)) fail('not_found', 'This product is not on the website.');
		const sites = /** @type {Map<string, { domain: string }>} */ (await identity().websitesByIds(websiteIds));
		const websites = websiteIds
			.filter((id) => sites.has(id))
			.map((id) => ({ websiteId: id, domain: /** @type {{ domain: string }} */ (sites.get(id)).domain }));
		return sign({
			productId,
			session,
			actor,
			claims: { kind: 'merchant', merchant: { id: merchantId, name: merchant.name, websites, websiteId } },
			merchantId,
			websiteId,
			requestId,
			ip,
		});
	};

	/**
	 * An admin opens a product dashboard (PLAN 0.4.3): Owner or Support for a website that has the product; with no
	 * website, Owners only (checked by the route). Finance is refused.
	 * @param {{ productId: string, websiteId: string | null, session: Session } & Audited} input
	 */
	const adminLaunch = async ({ productId, websiteId, session, actor, requestId = null, ip = null }) => {
		if (actor.role !== 'owner' && actor.role !== 'support') fail('forbidden', 'Finance admins do not open product dashboards.');
		/** @type {string | null} */
		let merchantId = null;
		if (websiteId !== null) {
			const on = await commerce().productOnWebsite(websiteId, productId);
			if (!on || on.status !== 'added') fail('not_found', 'This product is not on the website.');
			merchantId = on.merchantId;
		} else await load(productId);
		return sign({
			productId,
			session,
			actor,
			claims: { kind: 'admin', admin: { id: actor.id, name: actor.name ?? 'Admin', role: actor.role, websiteId } },
			merchantId,
			websiteId,
			requestId,
			ip,
		});
	};

	/**
	 * `POST /v1/product/launch/consume`: a launch the Portal issued to this product, used once.
	 * @param {{ productId: string, jti: string }} input
	 */
	const consumeLaunch = async ({ productId, jti }) => {
		const launch = await launches.findOne({ _id: jti, productId });
		const expireAt = launch?.expireAt instanceof Date ? launch.expireAt.getTime() : 0;
		if (!launch || expireAt <= ctx.now()) return { consumed: false };
		const seen = await ctx.replayStore.seen(`catalog-launch|${productId}|${jti}`, expireAt);
		return { consumed: !seen };
	};

	return {
		connect,
		reconnect,
		setStatus,
		merchantLaunch,
		adminLaunch,
		consumeLaunch,
		/**
		 * A connected product (INTERFACES.md).
		 * @param {string} productId
		 */
		getProduct: async (productId) => view(await load(productId)),
		/**
		 * Connected products, by id.
		 * @param {{ status?: 'active' | 'inactive' }} [filter]
		 */
		listProducts: async ({ status } = {}) =>
			(
				await products
					.find(status ? { status } : {})
					.sort({ _id: 1 })
					.limit(200)
					.toArray()
			).map(view),
		/**
		 * The product page: the product, its features from the last accepted price list, and its numbers.
		 * @param {string} productId
		 */
		productDetail: async (productId) => {
			const product = view(await load(productId));
			const prices = await commerce().currentPriceList(productId);
			return {
				...product,
				priceListVersion: prices?.version ?? 0,
				features: (prices?.features ?? []).map((/** @type {Record<string, any>} */ f) => ({
					key: f.key,
					name: f.name,
					description: f.description,
					dependsOn: f.dependsOn,
					millicreditsPerHour: f.price,
				})),
				numbers: await commerce().productNumbers(productId),
			};
		},
		/**
		 * `GET /v1/product/directory/:productId`: where to send a pasted token.
		 * @param {string} productId
		 */
		directory: async (productId) => ({ baseUrl: String((await load(productId)).baseUrl) }),
		/**
		 * Is the product connected and active (offered in Add product)?
		 * @param {string} productId
		 */
		isActive: async (productId) => (await products.findOne({ _id: productId }))?.status === 'active',
		notify: notices.notify,
		notifyAll: notices.notifyAll,
		deliverNotices: notices.deliver,
		waitingNotices: notices.waiting,
		/**
		 * `productKeys` port: the public key the product signs its client assertions with (pinned at connect).
		 * @param {string} productId
		 * @returns {Promise<KeyResolver | null>}
		 */
		productKeys: async (productId) => {
			const doc = await products.findOne({ _id: productId });
			return doc ? createKeyResolver({ jwks: createJwks([doc.publicJwk]) }) : null;
		},
	};
};
/** @typedef {ReturnType<typeof createCatalogService>} CatalogService */
