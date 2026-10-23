/**
 * The website's connections (settings-ownership design 8.4): ONE MongoDB database connection, ONE S3-compatible storage
 * connection and ONE AI provider key per website, entered once in the Portal (Website settings › Data and files) and
 * delivered to every product on the website that needs them (the AI key only to a product whose manifest says `needs.ai`).
 *
 * - **Who changes them**: only a signed-in merchant (own website), Owner or Support (`connections.write`), after a fresh
 *   confirmation of their password (and a code while two-step is on), through the console routes. No `/v1/product/*` route
 *   writes them, so a stolen product key or server token changes nothing.
 * - **Secrets can be written, never read**: a value is checked, sealed with `ENCRYPTION_KEY` (AAD: website, name and the
 *   value's own counter) and kept. No route returns it to a person: the console gets `set: true | false` and, per
 *   product, how the product's own test of the value went. Activity and e-mails never carry a value.
 * - **Each product gets its own database**: the same connection string with the database name `ss_<productId>`
 *   (`databaseNameFor`; an Owner may name another for one product, for a store that must keep a single database) and keeps
 *   its own folder in the bucket (`<prefix><productId>/<websiteId>/`). Only a product that needs a connection
 *   (manifest `needs`) is given it.
 * - **Delivery**: a product fetches `GET /v1/product/websites/:websiteId/connections` over its signed channel when the
 *   status answer's `connectionsVersion` is ahead of the one it holds, or a notice tells it. A product on the website gets
 *   it once added (so a product added later is connected without anyone entering anything). At most
 *   {@link FETCHES_PER_HOUR} fetches with secrets per product and website per hour, and {@link PRODUCT_FETCHES_PER_HOUR}
 *   per product across all websites (a stolen product key reads at most that much); every one is logged. The Owners get
 *   an e-mail once an hour per product when it passes {@link PRODUCT_FETCH_WARNING} and again when it hits the cap.
 * - **Health**: the product tests the value when it adopts it and reports the result
 *   (`PUT …/connections/:name/health`); the Portal never opens a connection to the merchant's database or bucket.
 * - **Every change** is logged (`website.connection_saved`, `website.connection_removed`: who, which connection, never a
 *   value), raises the website's `connectionsVersion`, tells the products on the website and e-mails the merchant.
 * @module
 */
import { AI_PROVIDERS, WEBSITE_CONNECTIONS, databaseNameFor, isDatabaseName, storageFolderFor } from '@ss/contracts';
import { checkUrl, createOutboundPolicy, isSafeMongoUri } from '@ss/net';
import { resealEach } from '../../infra/crypto.js';
import { problem } from '../../infra/http.js';
import { isDuplicateKey } from '../../infra/util.js';
import { CONNECTIONS, PRODUCT_FETCHES } from './schema.js';

/** @typedef {import('../../infra/modules.js').ModuleContext} ModuleContext */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */
/** @typedef {import('@ss/contracts').WebsiteConnectionName} WebsiteConnectionName */
/** @typedef {{ actor: Actor, requestId?: string | null, ip?: string | null }} Audited */

/** A product may fetch the secrets of one website this many times in an hour. */
export const FETCHES_PER_HOUR = 6;
/** A product may fetch secrets this many times in an hour across all its websites; further fetches are refused. */
export const PRODUCT_FETCHES_PER_HOUR = 1200;
/** The Owners are told when a product passes this many secret fetches in an hour. */
export const PRODUCT_FETCH_WARNING = 600;
const HOUR_MS = 3_600_000;
/** The longest connection string. */
const URI_MAX = 4096;
/** Health messages are cut here. */
const MESSAGE_MAX = 300;
/** A bucket name as real providers allow it: 3 to 63 lowercase letters, digits, dots and dashes, a letter or digit at both ends. */
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
/** A storage region as real providers name it: lowercase letters, digits and dashes, such as `eu-central-1` or `auto`. */
const REGION = /^[a-z0-9-]{1,32}$/;
/** A bucket prefix: letters, digits and `-_./`, no leading slash, ending with a slash when set. */
const PREFIX = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*$/;
/** An AI model name: letters, digits and `_.:/@-`. */
const AI_MODEL = /^[\w./:@-]{1,120}$/;
/** The shortest and the longest AI key. */
const AI_KEY_MIN = 8;
const AI_KEY_MAX = 512;
/** What the merchant is told changed, per connection. @type {Record<WebsiteConnectionName, string>} */
const CHANGED = {
	database: 'The database connection',
	storage: 'The storage connection',
	ai: 'The AI provider key',
};

/** @param {WebsiteConnectionName} name @param {string} websiteId @param {number} v */
const sealAad = (name, websiteId, v) => ({ websiteId, name, v: String(v), purpose: 'website_connection' });

/**
 * Check a MongoDB connection string entered by a person. The message never repeats the value.
 * @param {unknown} value
 * @param {import('@ss/net').OutboundPolicy} policy
 * @returns {{ ok: true, value: string } | { ok: false, message: string }}
 */
export const checkDatabaseValue = (value, policy) => {
	if (typeof value !== 'string' || value.trim() === '') return { ok: false, message: 'Enter the MongoDB connection string.' };
	const text = value.trim();
	if (text.length > URI_MAX) return { ok: false, message: 'The connection string is too long.' };
	if (!/^mongodb(?:\+srv)?:\/\/\S+$/.test(text))
		return { ok: false, message: 'A MongoDB connection string starts with mongodb:// or mongodb+srv://.' };
	const safe = isSafeMongoUri(text, policy);
	if (!safe.ok) return { ok: false, message: `This connection string is not allowed (${safe.reason}).` };
	return { ok: true, value: text };
};

/**
 * Check a storage connection entered by a person: `{ bucket, region, accessKeyId, secretAccessKey }` and optionally
 * `endpoint`, `forcePathStyle`, `prefix` and `publicBaseUrl` (the public https address of the bucket's root, such as a CDN in
 * front of it; not a secret). Nothing else is kept.
 * @param {unknown} value
 * @param {import('@ss/net').OutboundPolicy} policy
 * @returns {{ ok: true, value: Record<string, string | boolean> } | { ok: false, message: string, field?: string }}
 */
export const checkStorageValue = (value, policy) => {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		return { ok: false, message: 'Enter the storage connection.' };
	const input = /** @type {Record<string, unknown>} */ (value);
	/** @type {Record<string, string | boolean>} */
	const out = {};
	for (const [field, max] of /** @type {const} */ ([
		['bucket', 255],
		['region', 64],
		['accessKeyId', 256],
		['secretAccessKey', 512],
	])) {
		const text = typeof input[field] === 'string' ? input[field].trim() : '';
		if (text === '') return { ok: false, message: `Enter the ${field}.`, field };
		if (text.length > max) return { ok: false, message: `The ${field} is too long.`, field };
		// the bucket and region become part of the host and path of the links a product signs: only real names pass
		if (field === 'bucket' && !BUCKET.test(text))
			return {
				ok: false,
				message:
					'The bucket name is 3 to 63 lowercase letters, digits, dots or dashes, starting and ending with a letter or digit.',
				field,
			};
		if (field === 'region' && !REGION.test(text))
			return { ok: false, message: 'The region is up to 32 lowercase letters, digits or dashes.', field };
		out[field] = text;
	}
	for (const key of Object.keys(input))
		if (
			![
				'bucket',
				'region',
				'accessKeyId',
				'secretAccessKey',
				'endpoint',
				'forcePathStyle',
				'prefix',
				'publicBaseUrl',
			].includes(key)
		)
			return { ok: false, message: `${key} is not a storage setting.`, field: key };
	const endpoint = typeof input.endpoint === 'string' ? input.endpoint.trim() : '';
	if (endpoint !== '') {
		const checked = checkUrl(endpoint, policy);
		if (!checked.ok || !endpoint.startsWith('https://') || endpoint.length > 2048)
			return { ok: false, message: 'The endpoint must be a public https address.', field: 'endpoint' };
		out.endpoint = endpoint.replace(/\/+$/, '');
	}
	const publicBaseUrl = typeof input.publicBaseUrl === 'string' ? input.publicBaseUrl.trim() : '';
	if (publicBaseUrl !== '') {
		const checked = checkUrl(publicBaseUrl, policy);
		if (!checked.ok || !publicBaseUrl.startsWith('https://') || publicBaseUrl.length > 2048 || /[?#]/.test(publicBaseUrl))
			return {
				ok: false,
				message: 'The public address must be a public https address without a ? or a #.',
				field: 'publicBaseUrl',
			};
		out.publicBaseUrl = publicBaseUrl.replace(/\/+$/, '');
	}
	if (input.forcePathStyle !== undefined) {
		if (typeof input.forcePathStyle !== 'boolean')
			return { ok: false, message: 'Path style is on or off.', field: 'forcePathStyle' };
		out.forcePathStyle = input.forcePathStyle;
	}
	const prefix = typeof input.prefix === 'string' ? input.prefix.trim() : '';
	if (prefix !== '') {
		if (prefix.length > 200 || !PREFIX.test(prefix))
			return {
				ok: false,
				message: 'A prefix is folders ending with a slash, such as shop/media/.',
				field: 'prefix',
			};
		out.prefix = prefix;
	}
	return { ok: true, value: out };
};

/**
 * Check the website's AI provider key entered by a person: `{ provider, apiKey, model }` and, for a `compatible` service,
 * its https `baseUrl`. Nothing else is kept. The message never repeats the key.
 * @param {unknown} value
 * @param {import('@ss/net').OutboundPolicy} policy
 * @returns {{ ok: true, value: Record<string, string> } | { ok: false, message: string, field?: string }}
 */
export const checkAiValue = (value, policy) => {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		return { ok: false, message: 'Enter the AI provider key.' };
	const input = /** @type {Record<string, unknown>} */ (value);
	for (const key of Object.keys(input))
		if (!['provider', 'apiKey', 'model', 'baseUrl'].includes(key))
			return { ok: false, message: `${key} is not an AI provider setting.`, field: key };
	const provider = input.provider;
	if (typeof provider !== 'string' || !(/** @type {readonly string[]} */ (AI_PROVIDERS).includes(provider)))
		return { ok: false, message: 'Pick a provider.', field: 'provider' };
	const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
	if (apiKey.length < AI_KEY_MIN) return { ok: false, message: 'Enter the API key.', field: 'apiKey' };
	if (apiKey.length > AI_KEY_MAX) return { ok: false, message: 'The API key is too long.', field: 'apiKey' };
	const model = typeof input.model === 'string' ? input.model.trim() : '';
	if (!AI_MODEL.test(model)) return { ok: false, message: 'Enter the model.', field: 'model' };
	const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '';
	if (input.baseUrl !== undefined && typeof input.baseUrl !== 'string')
		return { ok: false, message: 'The base URL is an https address.', field: 'baseUrl' };
	if (provider !== 'compatible') {
		if (baseUrl !== '') return { ok: false, message: 'Only a compatible service has a base URL.', field: 'baseUrl' };
		return { ok: true, value: { provider, apiKey, model } };
	}
	const checked = checkUrl(baseUrl, policy);
	if (!checked.ok || !baseUrl.startsWith('https://') || baseUrl.length > 2048 || /[?#]/.test(baseUrl))
		return { ok: false, message: 'Enter the public https base URL of the service.', field: 'baseUrl' };
	return { ok: true, value: { provider, apiKey, model, baseUrl: baseUrl.replace(/\/+$/, '') } };
};

/**
 * @param {ModuleContext} ctx
 * @param {{ notifyProducts: (websiteId: string, what: 'connections' | 'links') => Promise<void> }} hooks
 */
export const createConnections = (ctx, { notifyProducts }) => {
	const store = /** @type {import('../../infra/db.js').TenantRepository} */ (ctx.collection(CONNECTIONS));
	/** @param {string} merchantId */
	const ownerOps = (merchantId) => /** @type {import('../../infra/db.js').MutableOps} */ (store.forMerchant(merchantId));
	const all = () => /** @type {import('../../infra/db.js').MutableOps} */ (store.acrossMerchants());
	const fetches = () => /** @type {import('../../infra/db.js').MutableOps} */ (ctx.collection(PRODUCT_FETCHES));
	const identity = () => ctx.service('identity');
	const commerce = () => ctx.service('commerce');
	const catalog = () => ctx.service('catalog');
	const policy = createOutboundPolicy({
		allowHosts: ctx.config.isProduction ? [] : [...ctx.config.outbound.allowHosts],
		userAgent: 'ss-portal/1',
	});

	/**
	 * The merchant's active website, else 404.
	 * @param {string} merchantId @param {string} websiteId
	 */
	const websiteOf = async (merchantId, websiteId) => {
		const website = await identity()
			.getWebsite(websiteId)
			.catch((/** @type {{ code?: string }} */ error) => {
				if (error?.code === 'not_found') return null;
				throw error;
			});
		if (!website || website.merchantId !== merchantId || website.status !== 'active')
			throw problem('not_found', 'No such website.');
		return website;
	};

	/** @param {string} message */
	const conflict = (message = 'The connections changed meanwhile. Reload and try again.') => problem('conflict', message);

	/**
	 * Raise the website's `connectionsVersion` by one and run `change` on the stored record in the same write (one
	 * conditional update, so two changes never share a version).
	 * @param {string} merchantId @param {string} websiteId
	 * @param {(record: Record<string, any> | null, version: number) => Record<string, any>} change the fields to `$set`/`$unset`: `{ $set?, $unset? }`
	 * @returns {Promise<number>} the new version
	 */
	const write = async (merchantId, websiteId, change) => {
		const ops = ownerOps(merchantId);
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const record = await ops.findOne({ merchantId, _id: websiteId });
			const version = Number(record?.version ?? 0) + 1;
			const { $set = {}, $unset = {} } = change(record, version);
			if (record) {
				const result = await ops.updateOne(
					{ merchantId, _id: websiteId, version: record.version },
					{ $set: { ...$set, version }, ...(Object.keys($unset).length > 0 ? { $unset } : {}) },
				);
				if (result.matchedCount === 1) return version;
			} else {
				try {
					await ops.insertOne({ _id: websiteId, merchantId, health: {}, fetched: {}, deliveries: {}, ...$set, version });
					return version;
				} catch (error) {
					if (!isDuplicateKey(error)) throw error;
				}
			}
		}
		throw conflict();
	};

	/**
	 * The products on the website now, with what each needs of the connections.
	 * @param {string} websiteId
	 * @returns {Promise<Array<{ productId: string, name: string, needs: { database: boolean, storage: 'none' | 'optional' | 'required', ai?: boolean } }>>}
	 */
	const productsNeeding = async (websiteId) => {
		const onSite = /** @type {Array<{ productId: string }>} */ (await commerce().productsOnWebsite(websiteId));
		const found = await Promise.all(
			onSite.map(async ({ productId }) => {
				const product = await catalog()
					.getProduct(productId)
					.catch(() => null);
				return product ? { productId, name: String(product.name), needs: product.needs } : null;
			}),
		);
		return found.filter((item) => item !== null);
	};

	/**
	 * Tell the Owners that a product passed the warning line or hit the cap, once per product, kind and hour: the first
	 * caller to set the hour's flag sends (the flag is set in one conditional update). Recorded in the activity log even
	 * when e-mail cannot be sent; never fails the fetch.
	 * @param {{ productId: string, productName: string, kind: 'warning' | 'cap', count: number }} input
	 */
	const alertOwners = async ({ productId, productName, kind, count }) => {
		try {
			const flag = kind === 'cap' ? 'capped' : 'warned';
			const claimed = await fetches().updateOne(
				{ _id: productId, start: { $gt: ctx.now() - HOUR_MS }, [flag]: { $ne: true } },
				{ $set: { [flag]: true } },
			);
			if (claimed.modifiedCount !== 1) return;
			ctx.logger.warn('a product fetched website connections more than usual', { productId, kind, count });
			await ctx.audit.record({
				actor: { type: 'system', id: 'connections' },
				action: 'website.connections_alert',
				target: { type: 'product', id: productId },
				after: { kind, count, warning: PRODUCT_FETCH_WARNING, cap: PRODUCT_FETCHES_PER_HOUR },
			});
			await identity().mailOwners({
				template: 'connection_fetch_alert',
				data: {
					product: productName,
					kind,
					count: String(count),
					warning: String(PRODUCT_FETCH_WARNING),
					cap: String(PRODUCT_FETCHES_PER_HOUR),
				},
			});
		} catch (error) {
			ctx.logger.warn('connection fetch alert not sent', { productId, error });
		}
	};

	/**
	 * Count one secret fetch of a product against its total for the hour, across all websites. Atomic: the count only
	 * goes up while it is below the cap, and an old hour is replaced only if it is still the one that was read.
	 * @param {string} productId @param {string} productName
	 * @returns {Promise<boolean>} false when the product is at its cap for this hour
	 */
	const takeProductFetch = async (productId, productName) => {
		const ops = fetches();
		const fresh = { warned: false, capped: false };
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const now = ctx.now();
			const counted = await ops.findOneAndUpdate(
				{ _id: productId, start: { $gt: now - HOUR_MS }, count: { $lt: PRODUCT_FETCHES_PER_HOUR } },
				{ $inc: { count: 1 } },
			);
			if (counted) {
				if (Number(counted.count) >= PRODUCT_FETCH_WARNING)
					await alertOwners({ productId, productName, kind: 'warning', count: Number(counted.count) });
				return true;
			}
			const slot = await ops.findOne({ _id: productId });
			if (slot && Number(slot.start) > now - HOUR_MS) {
				await alertOwners({ productId, productName, kind: 'cap', count: Number(slot.count) });
				return false;
			}
			if (slot) {
				const started = await ops.updateOne(
					{ _id: productId, start: slot.start },
					{ $set: { start: now, count: 1, ...fresh } },
				);
				if (started.modifiedCount === 1) return true;
			} else {
				try {
					await ops.insertOne({ _id: productId, start: now, count: 1, ...fresh });
					return true;
				} catch (error) {
					if (!isDuplicateKey(error)) throw error;
				}
			}
		}
		throw conflict();
	};

	/**
	 * The database name a product gets on the website.
	 * @param {Record<string, any> | null} record @param {string} productId
	 */
	const dbNameOf = (record, productId) => String(record?.dbNames?.[productId] ?? databaseNameFor(productId));

	/**
	 * How a product's own test of a connection stands: `not_set` (nothing entered), `waiting` (entered, not fetched and
	 * tested yet), `connected`, `test_failed`.
	 * @param {Record<string, any> | null} record @param {WebsiteConnectionName} name @param {string} productId
	 * @returns {{ state: 'not_set' | 'waiting' | 'connected' | 'test_failed', message?: string }}
	 */
	const stateOf = (record, name, productId) => {
		const value = record?.[name];
		if (!value) return { state: 'not_set' };
		const health = record?.health?.[productId]?.[name];
		// a report older than the value's last change says nothing about it
		if (!health || health.version < value.atVersion) return { state: 'waiting' };
		return health.ok
			? { state: 'connected' }
			: { state: 'test_failed', ...(health.message ? { message: String(health.message) } : {}) };
	};

	/** @param {Record<string, any> | null | undefined} value */
	const whenSet = (value) => (value ? { set: true, setAt: new Date(value.setAt).toISOString() } : { set: false, setAt: null });

	/**
	 * Who may see how the per-product databases are named: everyone with read access (a name is not a secret).
	 * @param {string} websiteId
	 * @param {Record<string, any> | null} record
	 */
	const productRows = async (websiteId, record) =>
		(await productsNeeding(websiteId)).map(({ productId, name, needs }) => ({
			productId,
			name,
			database: needs.database
				? {
						name: dbNameOf(record, productId),
						overridden: record?.dbNames?.[productId] !== undefined,
						...stateOf(record, 'database', productId),
					}
				: null,
			storage:
				needs.storage === 'none'
					? null
					: {
							folder: storageFolderFor({ productId, websiteId }),
							required: needs.storage === 'required',
							...stateOf(record, 'storage', productId),
						},
			ai: needs.ai ? stateOf(record, 'ai', productId) : null,
		}));

	/**
	 * Tell the merchant a connection changed (never fails the change).
	 * @param {{ merchantId: string, websiteId: string, domain: string, name: WebsiteConnectionName, what: 'saved' | 'removed', actor: Actor }} input
	 */
	const mailChange = async ({ merchantId, websiteId, domain, name, what, actor }) => {
		try {
			const brand = ctx.config.settings.branding.name;
			const who = actor.type === 'merchant' ? 'You' : actor.type === 'admin' ? `Someone from ${brand}` : 'The system';
			await identity().mailMerchant({
				merchantId,
				template: 'connection_changed',
				data: {
					brand,
					website: domain,
					who,
					what: `${CHANGED[name]} was ${what === 'saved' ? 'saved or replaced' : 'removed'}`,
					websiteId,
				},
			});
		} catch (error) {
			ctx.logger.warn('connection change e-mail not sent', { websiteId, error });
		}
	};

	/**
	 * The Owner's per-product database names: `{ productId: name }`, each a valid name, no name twice.
	 * @param {unknown} names
	 * @returns {Record<string, string>}
	 */
	const checkNames = (names) => {
		if (typeof names !== 'object' || names === null || Array.isArray(names))
			throw problem('validation_failed', 'names is a set of product ids and database names.', {
				errors: [{ path: '/names', message: 'must be an object' }],
			});
		/** @type {Record<string, string>} */
		const out = {};
		const seen = new Set();
		for (const [productId, name] of Object.entries(names)) {
			if (!/^[a-z][a-z0-9-]{1,30}$/.test(productId) || !isDatabaseName(name) || seen.has(name))
				throw problem('validation_failed', 'A database name is letters, digits and underscores, once per product.', {
					errors: [{ path: `/names/${productId}`, message: 'is not a database name this website can use' }],
				});
			seen.add(name);
			out[productId] = name;
		}
		return out;
	};

	return Object.freeze({
		/**
		 * The save counter of the website's connections and links (0: none yet): the status answer's `connectionsVersion`.
		 * @param {string} websiteId
		 * @returns {Promise<number>}
		 */
		versionOf: async (websiteId) =>
			Number((await all().findOne({ _id: websiteId }, { projection: { version: 1 } }))?.version ?? 0),

		/**
		 * What the console shows: whether each connection is set (never its value), the database name and test result of
		 * every product on the website, and what the products still lack.
		 * @param {{ merchantId: string, websiteId: string }} input
		 */
		view: async ({ merchantId, websiteId }) => {
			await websiteOf(merchantId, websiteId);
			const record = await ownerOps(merchantId).findOne({ merchantId, _id: websiteId });
			return {
				version: Number(record?.version ?? 0),
				database: whenSet(record?.database),
				storage: {
					...whenSet(record?.storage),
					...(record?.storage?.publicBaseUrl ? { publicBaseUrl: String(record.storage.publicBaseUrl) } : {}),
				},
				ai: {
					...whenSet(record?.ai),
					// not secrets: shown so the merchant sees which provider and model the key is for
					...(record?.ai?.provider ? { provider: String(record.ai.provider), model: String(record.ai.model) } : {}),
					...(record?.ai?.baseUrl ? { baseUrl: String(record.ai.baseUrl) } : {}),
				},
				products: await productRows(websiteId, record),
			};
		},

		/**
		 * Save (or replace) a connection. The caller has confirmed the person's password. Checked, sealed, logged;
		 * the products on the website are told and the merchant gets an e-mail.
		 * @param {{ merchantId: string, websiteId: string, name: string, value: unknown, names?: unknown } & Audited} input
		 *   `names`: the Owner's per-product database names (database only, Owner only)
		 */
		save: async ({ merchantId, websiteId, name, value, names, actor, requestId = null, ip = null }) => {
			const website = await websiteOf(merchantId, websiteId);
			if (!(/** @type {readonly string[]} */ (WEBSITE_CONNECTIONS).includes(name)))
				throw problem('not_found', 'No such connection.');
			const which = /** @type {WebsiteConnectionName} */ (name);
			if (names !== undefined && (which !== 'database' || actor.type !== 'admin' || actor.role !== 'owner'))
				throw problem('forbidden', 'Only an Owner names the databases of the products.');
			const dbNames = names === undefined ? undefined : checkNames(names);
			const checked =
				which === 'database'
					? checkDatabaseValue(value, policy)
					: which === 'ai'
						? checkAiValue(value, policy)
						: checkStorageValue(value, policy);
			if (!checked.ok)
				throw problem('validation_failed', checked.message, {
					errors: [
						{ path: `/value${'field' in checked && checked.field ? `/${checked.field}` : ''}`, message: checked.message },
					],
				});
			const plain = which === 'database' ? /** @type {string} */ (checked.value) : JSON.stringify(checked.value);
			const publicBaseUrl =
				which === 'storage' ? /** @type {Record<string, string | boolean>} */ (checked.value).publicBaseUrl : undefined;
			const aiShown = which === 'ai' ? /** @type {Record<string, string>} */ (checked.value) : null;
			const before = await ownerOps(merchantId).findOne({ merchantId, _id: websiteId });
			const v = Number(before?.[which]?.v ?? 0) + 1;
			const at = new Date(ctx.now());
			const version = await write(merchantId, websiteId, (_record, next) => ({
				$set: {
					[which]: {
						sealed: ctx.secretBox.seal(plain, { aad: sealAad(which, websiteId, v) }),
						v,
						atVersion: next,
						setAt: at,
						setBy: { type: actor.type, id: actor.id },
						// not a secret: kept in plain beside the sealed value so the console can show it
						...(publicBaseUrl ? { publicBaseUrl } : {}),
						...(aiShown
							? {
									provider: aiShown.provider,
									model: aiShown.model,
									...(aiShown.baseUrl ? { baseUrl: aiShown.baseUrl } : {}),
								}
							: {}),
					},
					...(dbNames ? { dbNames } : {}),
				},
			}));
			await ctx.audit.record({
				actor: /** @type {any} */ (actor),
				action: 'website.connection_saved',
				target: { type: 'website', id: websiteId, merchantId, websiteId },
				after: { name: which, replaced: Boolean(before?.[which]), version, ...(dbNames ? { dbNames } : {}) },
				requestId,
				ip,
			});
			await notifyProducts(websiteId, 'connections');
			await mailChange({ merchantId, websiteId, domain: String(website.domain), name: which, what: 'saved', actor });
			return { version };
		},

		/**
		 * Remove a connection (the products keep their last copy until they next fetch: nothing is deleted in the
		 * merchant's database or bucket).
		 * @param {{ merchantId: string, websiteId: string, name: string } & Audited} input
		 */
		remove: async ({ merchantId, websiteId, name, actor, requestId = null, ip = null }) => {
			const website = await websiteOf(merchantId, websiteId);
			if (!(/** @type {readonly string[]} */ (WEBSITE_CONNECTIONS).includes(name)))
				throw problem('not_found', 'No such connection.');
			const which = /** @type {WebsiteConnectionName} */ (name);
			const before = await ownerOps(merchantId).findOne({ merchantId, _id: websiteId });
			if (!before?.[which]) throw problem('not_found', 'This connection is not set.');
			const version = await write(merchantId, websiteId, () => ({ $set: {}, $unset: { [which]: '' } }));
			await ctx.audit.record({
				actor: /** @type {any} */ (actor),
				action: 'website.connection_removed',
				target: { type: 'website', id: websiteId, merchantId, websiteId },
				after: { name: which, version },
				requestId,
				ip,
			});
			await notifyProducts(websiteId, 'connections');
			await mailChange({ merchantId, websiteId, domain: String(website.domain), name: which, what: 'removed', actor });
			return { version };
		},

		/**
		 * Raise the version (a link was created, changed or revoked) without changing a connection.
		 * @param {{ merchantId: string, websiteId: string }} input
		 * @returns {Promise<number>}
		 */
		bump: ({ merchantId, websiteId }) => write(merchantId, websiteId, () => ({ $set: {} })),

		/**
		 * What a product gets (`GET /v1/product/websites/:websiteId/connections`): the connections the product needs, with
		 * its own database name, the website's AI key under `shared` (only when its manifest says `needs.ai`; else null) and its
		 * links (`links` is the website links service's part). The website must be active
		 * and have the product (404 `website_not_found`). A fetch with secrets is counted: more than
		 * {@link FETCHES_PER_HOUR} an hour for the website, or {@link PRODUCT_FETCHES_PER_HOUR} for the product across all
		 * websites, is 429.
		 * @param {{ productId: string, websiteId: string, links: (merchantId: string) => Promise<{ out: any[], in: any[] }> }} input
		 */
		forProduct: async ({ productId, websiteId, links }) => {
			const [placement, website] = await Promise.all([
				commerce().productOnWebsite(websiteId, productId),
				identity()
					.getWebsite(websiteId)
					.catch((/** @type {{ code?: string }} */ error) => {
						if (error?.code === 'not_found') return null;
						throw error;
					}),
			]);
			if (!placement || placement.status !== 'added' || !website || website.status !== 'active')
				throw problem('website_not_found', 'This website does not have this product.');
			const merchantId = String(website.merchantId);
			const product = await catalog().getProduct(productId);
			// inactive catalog: no secrets (placement alone is not enough)
			if (product.status !== 'active') throw problem('website_not_found', 'This website does not have this product.');
			const record = await ownerOps(merchantId).findOne({ merchantId, _id: websiteId });
			const open = (/** @type {WebsiteConnectionName} */ name) =>
				ctx.secretBox.openText(record?.[name].sealed, { aad: sealAad(name, websiteId, record?.[name].v) });
			/** @type {string | null} */
			let uri = null;
			/** @type {Record<string, unknown> | null} */
			let bucket = null;
			/** @type {Record<string, unknown> | null} */
			let ai = null;
			try {
				if (product.needs.database && record?.database) {
					uri = open('database');
					// checked again on delivery: an address refused now (a stricter policy, a value stored another way) goes out as not set
					if (!isSafeMongoUri(uri, policy).ok) {
						ctx.logger.warn('website database address refused', { websiteId });
						uri = null;
					}
				}
				if (product.needs.storage !== 'none' && record?.storage) bucket = JSON.parse(open('storage'));
				if (product.needs.ai === true && record?.ai) ai = JSON.parse(open('ai'));
			} catch {
				// sealed under a key that is gone: delivered as not set (the Owner's Re-seal reports it)
				ctx.logger.warn('website connection cannot be opened', { websiteId });
				uri = null;
				bucket = null;
				ai = null;
			}
			const ownLinks = await links(merchantId);
			const version = Number(record?.version ?? 0);
			const secrets = uri !== null || bucket !== null || ai !== null || ownLinks.out.length > 0;
			if (secrets) {
				const now = ctx.now();
				const slot = record?.deliveries?.[productId];
				const fresh = !slot || now - Number(slot.start) >= HOUR_MS;
				if (!fresh && Number(slot.count) >= FETCHES_PER_HOUR)
					throw problem('rate_limited', 'This product fetched the connections too often. Try again later.');
				if (!(await takeProductFetch(productId, String(product.name))))
					throw problem('rate_limited', 'This product fetched the connections too often. Try again later.');
				await ownerOps(merchantId).updateOne(
					{ merchantId, _id: websiteId },
					fresh
						? { $set: { [`deliveries.${productId}`]: { start: now, count: 1 } } }
						: { $inc: { [`deliveries.${productId}.count`]: 1 } },
				);
				await ctx.audit.record({
					actor: { type: 'product', id: productId },
					action: 'website.connections_delivered',
					target: { type: 'website', id: websiteId, merchantId, websiteId },
					after: {
						productId,
						version,
						parts: [
							uri !== null ? 'database' : null,
							bucket !== null ? 'storage' : null,
							ai !== null ? 'ai' : null,
							ownLinks.out.length > 0 ? 'links' : null,
						].filter(Boolean),
					},
				});
			}
			if (record)
				await ownerOps(merchantId).updateOne(
					{ merchantId, _id: websiteId },
					{ $set: { [`fetched.${productId}`]: { version, at: new Date(ctx.now()) } } },
				);
			return {
				version,
				database: uri === null ? null : { uri, dbName: dbNameOf(record, productId) },
				storage: bucket,
				shared: { ai },
				links: ownLinks,
			};
		},

		/**
		 * A product reports how a delivered connection worked (`PUT …/connections/:name/health`). Only for a website that
		 * has the product; only the connection names; the message is cut and never trusted as markup.
		 * @param {{ productId: string, websiteId: string, name: string, version: unknown, ok: unknown, message?: unknown }} input
		 */
		reportHealth: async ({ productId, websiteId, name, version, ok, message }) => {
			if (!(/** @type {readonly string[]} */ (WEBSITE_CONNECTIONS).includes(name)))
				throw problem('not_found', 'No such connection.');
			const placement = await commerce().productOnWebsite(websiteId, productId);
			if (!placement || placement.status !== 'added')
				throw problem('website_not_found', 'This website does not have this product.');
			const merchantId = String(placement.merchantId);
			const text = typeof message === 'string' ? message.slice(0, MESSAGE_MAX) : undefined;
			await ownerOps(merchantId).updateOne(
				{ merchantId, _id: websiteId },
				{
					$set: {
						[`health.${productId}.${name}`]: {
							version: Number(version),
							ok: ok === true,
							...(ok === true || !text ? {} : { message: text }),
							at: new Date(ctx.now()),
						},
					},
				},
			);
			return { accepted: true };
		},

		/**
		 * Which products fetched which version and when (the table "Between your products" and the console).
		 * @param {{ merchantId: string, websiteId: string }} input
		 * @returns {Promise<Record<string, { version: number, at: string }>>}
		 */
		fetchedBy: async ({ merchantId, websiteId }) => {
			const record = await ownerOps(merchantId).findOne({ merchantId, _id: websiteId });
			return Object.fromEntries(
				Object.entries(record?.fetched ?? {}).map(([productId, item]) => [
					productId,
					{ version: Number(/** @type {any} */ (item).version), at: new Date(/** @type {any} */ (item).at).toISOString() },
				]),
			);
		},

		/** The website is removed for good: its connections are deleted. @param {{ merchantId: string, websiteId: string }} input */
		forget: async ({ merchantId, websiteId }) => {
			await ownerOps(merchantId).deleteOne({ merchantId, _id: websiteId });
		},

		/**
		 * Settings → Encryption key → Re-seal: every sealed connection sealed again with the current key.
		 * @returns {Promise<import('../../infra/crypto.js').ResealCounts>}
		 */
		reseal: async () => {
			const docs = await all()
				.find({}, { projection: { database: 1, storage: 1, ai: 1 } })
				.toArray();
			/** @type {Array<{ sealed: unknown, aad: Record<string, string>, save: (next: string) => Promise<unknown> }>} */
			const items = [];
			for (const doc of docs)
				for (const name of WEBSITE_CONNECTIONS) {
					const value = doc[name];
					if (!value?.sealed) continue;
					items.push({
						sealed: value.sealed,
						aad: sealAad(name, String(doc._id), value.v),
						save: (next) =>
							all().updateOne({ _id: doc._id, [`${name}.sealed`]: value.sealed }, { $set: { [`${name}.sealed`]: next } }),
					});
				}
			return resealEach(ctx.secretBox, items);
		},
	});
};
