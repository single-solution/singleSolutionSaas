/**
 * Connections (PLAN 0.4.3, 0.4.6, 0.4.8; settings-ownership design 8.3 and 8.4): the website's database and storage,
 * the website's AI provider key, the product's own provider keys, and the links to other products, per website, in the
 * product database.
 *
 * - **The Portal owns four kinds.** The database and the storage are entered once per website in the Portal (Website
 *   settings › Data and files) and arrive here with the product's own database name; the website's AI provider key is
 *   entered there too and arrives, when the manifest says `needs.ai`, in a `secret` definition that says `portal: 'ai'`; the
 *   links to other products are created by the Portal from the manifests and arrive as keys with the scopes granted. They
 *   are *managed*: `save` and `remove` refuse them (409 `managed_by_portal`), and only `adopt` (a signed fetch from the
 *   Portal) writes them. The product's own provider keys (`secret` with no `portal`) are still entered in the product.
 * - Values are encrypted (`sealing.js`: with `ENCRYPTION_KEY`, or `ENCRYPTION_KEY_PREVIOUS` while the key changes)
 *   and write-only: screens get only `{ name, label, kind, neededBy, managed, set, status, message?, testedAt }`: whether a
 *   value is stored (`set`) and how its last test went, never the value and not even its last characters. A value
 *   that no longer decrypts (the key changed without the previous one) shows as `not_connected`. `reseal` seals every
 *   stored value with the current key (the Owner's Re-seal, `reseal.js`).
 * - Each value is tested live when it arrives or is saved and on Test: `database` connects and pings through the guarded
 *   lookup, `storage` signs a HEAD request to the bucket, and the definition's own `test` hook runs last. The result is
 *   reported to the Portal, which never opens the merchant's database or bucket itself.
 * - Every change writes Recent changes.
 * - `callProduct` calls another product with the link key the Portal gave this product for it, at the address the
 *   Portal's directory gives (cached up to 5 minutes), through `@ss/net`; a send to Notifications carries the defaults and
 *   long values of the product's message (`attach`, `messages.js`). The key proves who calls and the other product
 *   enforces what it may do. `addressOf` gives another product's address (the same cache); `products` every connected
 *   product and its address (the Portal's directory list, cached up to 5 minutes; its last good copy while the Portal
 *   cannot answer), so a product can serve the others without naming them in its code.
 * @module
 */
import { isNetError, isSafeMongoUri } from '@ss/net';
import { isObject } from '@ss/contracts/util';
import { problem } from './http/results.js';
import { createS3Storage } from './adapters/storage.js';
import { resealEach } from './reseal.js';
import { omit } from './util.js';

/** @typedef {import('./stores/types.js').Store} Store */
/** @typedef {import('./recent.js').Who} Who */
/** @typedef {import('./http/results.js').ProblemResult} ProblemResult */
/** @typedef {'database' | 'storage' | 'secret' | 'link'} ConnectionKind `link`: a key to another product, from the Portal */
/** @typedef {string | Record<string, string | number | boolean>} ConnectionValue */
/**
 * @typedef {object} ConnectionDefinition
 * @property {string} label shown on the Connections screen
 * @property {string[]} neededBy feature keys
 * @property {Exclude<ConnectionKind, 'link'>} kind
 * @property {string} [secretField] object values: the member whose last 4 characters are shown (default `apiKey`)
 * @property {'ai'} [portal] only for a `secret`: the value is the Portal's (the website's AI provider key, `bundle.shared.ai`): managed
 * @property {(value: ConnectionValue, ctx: { websiteId: string, send: OutboundSend }) => Promise<{ ok: boolean, message?: string }>} [test]
 */
/**
 * @typedef {{ name: string, label: string, kind: ConnectionKind, neededBy: string[], managed: boolean,
 *   status: 'connected' | 'not_connected' | 'test_failed', set: boolean, message?: string, testedAt: string | null }} ConnectionView
 *   `managed`: the Portal owns it (database, storage, the AI key and links): it cannot be saved or removed here
 */
/** The Portal's bundle for a product (`GET /v1/product/websites/:id/connections`). @typedef {import('@ss/contracts').WebsiteConnections} Bundle */
/** @typedef {(url: string, init?: import('@ss/net').SafeFetchInit) => Promise<import('@ss/net').SafeResponse>} OutboundSend */
/** @typedef {{ productId: string, name: string, baseUrl: string }} DirectoryEntry a connected product, its name and address */
/**
 * @typedef {{ ok: true, status: number, body: unknown }
 *   | { ok: false, reason: 'not_connected' | 'refused' | 'unavailable' | 'unreachable' | 'failed', status?: number, body?: unknown }} ProductCall
 */

const NAME = /^[a-z][a-z0-9_]{0,39}$/;
const KINDS = Object.freeze(['database', 'storage', 'secret']);
/** The kinds the Portal owns. */
const MANAGED_KINDS = Object.freeze(['database', 'storage']);
/** The shared values of the Portal's bundle a `secret` definition may take (`portal`). */
const SHARED = Object.freeze(['ai']);

/**
 * Whether the Portal owns the definition's value: a database, a storage or a secret that says `portal`.
 * @param {ConnectionDefinition | undefined} def
 */
const isManaged = (def) => def !== undefined && (MANAGED_KINDS.includes(def.kind) || def.portal !== undefined);

/**
 * The name the Portal knows a managed definition by (`database`, `storage`, `ai`), or null for a value of the product's own.
 * @param {ConnectionDefinition} def
 * @returns {'database' | 'storage' | 'ai' | null}
 */
export const portalNameOf = (def) => (def.kind === 'database' || def.kind === 'storage' ? def.kind : (def.portal ?? null));

/**
 * What the Portal delivered for a managed definition, or null when it holds none.
 * @param {ConnectionDefinition} def
 * @param {Bundle} bundle
 */
export const deliveredFor = (def, bundle) => {
	const name = portalNameOf(def);
	return name === 'database' ? bundle.database : name === 'storage' ? bundle.storage : name === 'ai' ? bundle.shared.ai : null;
};
/** Who changed a connection that arrived from the Portal. @type {Who} */
const PORTAL = Object.freeze({ kind: 'portal', id: 'portal', name: 'Portal' });
/** The name a link to another product is stored under. @param {string} productId */
export const linkName = (productId) => `link_${productId.replace(/-/g, '_')}`;
const DIRECTORY_TTL_MS = 5 * 60_000;
/** After the Portal could not list the products, it is asked again only after this long. */
const DIRECTORY_RETRY_MS = 60_000;
const MAX_VALUE_LENGTH = 4096;
/** The most stored values one Re-seal reads (every website's Connections). */
const RESEAL_LIMIT = 100_000;

/**
 * Check connection definitions against the manifest; adds the built-in `database` connection when none is declared. The
 * database and the storage are the Portal's: the storage is named `storage`. There are no token connections: a
 * product's links to other products come from the Portal (manifest `links.needs`).
 * @param {Record<string, ConnectionDefinition> | undefined} definitions
 * @param {import('@ss/contracts').Manifest} manifest
 * @returns {Record<string, ConnectionDefinition>}
 */
export const checkConnectionDefinitions = (definitions = {}, manifest) => {
	const keys = manifest.features.map((feature) => feature.key);
	/** @type {Record<string, ConnectionDefinition>} */
	const out = {};
	for (const [name, def] of Object.entries(definitions)) {
		if (!NAME.test(name)) throw new TypeError(`connection name must match ${NAME}: ${name}`);
		if (!isObject(def) || typeof def.label !== 'string' || !KINDS.includes(def.kind))
			throw new TypeError(`connection ${name} needs a label and a kind (database, storage, secret)`);
		if (!Array.isArray(def.neededBy) || def.neededBy.some((key) => !keys.includes(key)))
			throw new TypeError(`connection ${name}: neededBy must list features of the manifest`);
		if (def.kind === 'database' && name !== 'database') throw new TypeError('the database connection is named database');
		if (def.kind === 'storage' && name !== 'storage') throw new TypeError('the storage connection is named storage');
		if (def.portal !== undefined && (def.kind !== 'secret' || !SHARED.includes(def.portal)))
			throw new TypeError(`connection ${name}: portal must be one of ${SHARED.join(', ')} and only a secret takes it`);
		out[name] = def;
	}
	out.database ??= { label: 'Database (MongoDB)', kind: 'database', neededBy: [...keys] };
	return out;
};

/**
 * The links a product needs from other products, from its manifest: name, the other product, the features that use it.
 * @param {import('@ss/contracts').Manifest} manifest
 * @returns {Array<{ name: string, productId: string, label: string, neededBy: string[] }>}
 */
export const linkDefinitionsOf = (manifest) => {
	/** @type {Map<string, { productId: string, neededBy: Set<string> }>} */
	const found = new Map();
	for (const need of manifest.links?.needs ?? []) {
		const entry = found.get(need.product) ?? { productId: need.product, neededBy: new Set() };
		for (const key of need.features) entry.neededBy.add(key);
		found.set(need.product, entry);
	}
	return [...found.values()].map(({ productId, neededBy }) => ({
		name: linkName(productId),
		productId,
		label: `Link to ${productId.charAt(0).toUpperCase()}${productId.slice(1)}`,
		neededBy: [...neededBy],
	}));
};

/**
 * Why a value does not fit its kind, or null.
 * @param {ConnectionKind} kind
 * @param {unknown} value
 * @returns {string | null}
 */
const valueViolation = (kind, value) => {
	if (kind === 'database')
		return typeof value === 'string' && /^mongodb(\+srv)?:\/\/\S+$/.test(value) && value.length <= MAX_VALUE_LENGTH
			? null
			: 'A MongoDB connection string (mongodb:// or mongodb+srv://) is required.';
	if (typeof value === 'string')
		return kind === 'secret' && value.length > 0 && value.length <= MAX_VALUE_LENGTH ? null : 'A value is required.';
	const fine =
		isObject(value) &&
		Object.keys(value).length > 0 &&
		Object.keys(value).length <= 20 &&
		Object.values(value).every(
			(v) => typeof v === 'boolean' || typeof v === 'number' || (typeof v === 'string' && v.length <= MAX_VALUE_LENGTH),
		);
	return fine ? null : 'The value must be text or a set of up to 20 fields.';
};

/**
 * @param {{
 *   store: Store, productId: string, definitions: Record<string, ConnectionDefinition>,
 *   links?: Array<{ name: string, productId: string, label: string, neededBy: string[] }>,
 *   sealer: import('./sealing.js').Sealer, recent: import('./recent.js').RecentChanges, send: OutboundSend,
 *   policy: import('@ss/net').OutboundPolicy, testDatabase: (uri: string) => Promise<{ ok: boolean, message?: string }>,
 *   directory: (productId: string) => Promise<{ baseUrl: string }>,
 *   directoryList: () => Promise<{ items: DirectoryEntry[] }>,
 *   now: () => number, logger: import('./logger.js').Logger,
 *   attach?: import('./messages.js').Messages['attach'],
 * }} options `links`: the links the manifest needs (`linkDefinitionsOf`)
 */
export const createConnections = ({
	store,
	productId,
	definitions,
	links = [],
	sealer,
	recent,
	send,
	policy,
	testDatabase,
	directory,
	directoryList,
	now,
	logger,
	attach = (_productId, _path, init) => init,
}) => {
	/** @type {Map<string, { baseUrl: string, until: number }>} */
	const addresses = new Map();
	/** @type {{ items: ReadonlyArray<Readonly<DirectoryEntry>>, until: number } | null} */
	let listed = null;
	/** The Portal's last failure to list the products, kept {@link DIRECTORY_RETRY_MS}. @type {{ error: unknown, until: number } | null} */
	let unlisted = null;
	/** @param {string} websiteId @param {string} name */
	const idOf = (websiteId, name) => `${websiteId}|${name}`;
	/** @param {string} websiteId @param {string} name */
	const aad = (websiteId, name) => `connection|${websiteId}|${name}`;
	const linkByProduct = new Map(links.map((link) => [link.productId, link]));
	const linkByName = new Map(links.map((link) => [link.name, link]));

	/**
	 * @param {string} websiteId
	 * @param {string} name
	 * @returns {Promise<{ doc: Record<string, any>, value: ConnectionValue } | null>}
	 */
	const read = async (websiteId, name) => {
		const doc = await store.get('connections', idOf(websiteId, name));
		const text = doc ? sealer.open(doc.sealed, aad(websiteId, name)) : null;
		if (!doc || text === null) return null;
		return { doc, value: JSON.parse(text) };
	};

	/**
	 * Run the tests of a value.
	 * @param {string} websiteId
	 * @param {ConnectionDefinition} def
	 * @param {ConnectionValue} value
	 * @returns {Promise<{ ok: boolean, message?: string }>}
	 */
	const runTests = async (websiteId, def, value) => {
		/** @type {{ ok: boolean, message?: string }} */
		let result = { ok: true };
		try {
			if (def.kind === 'database') result = await testDatabase(/** @type {string} */ (value));
			if (def.kind === 'storage') {
				const storage = createS3Storage({
					descriptor: /** @type {Record<string, unknown>} */ (value),
					websiteId,
					slug: productId,
					send,
					now,
					policy,
				});
				await storage.headObject({ key: 'ss-connection-test' });
			}
			if (result.ok && def.test) result = await def.test(value, { websiteId, send });
		} catch (error) {
			result = { ok: false, message: error instanceof Error ? error.message : 'The test failed.' };
		}
		return result.ok ? { ok: true } : { ok: false, message: result.message ?? 'The test failed.' };
	};

	/**
	 * @param {string} websiteId
	 * @returns {Promise<ConnectionView[]>}
	 */
	const list = async (websiteId) => {
		const rows = await Promise.all(
			Object.entries(definitions).map(async ([name, def]) => {
				const found = await read(websiteId, name);
				const base = {
					name,
					label: def.label,
					kind: def.kind,
					neededBy: [...def.neededBy],
					managed: isManaged(def),
				};
				if (!found) return { ...base, set: false, status: /** @type {const} */ ('not_connected'), testedAt: null };
				return {
					...base,
					set: true,
					status: found.doc.status,
					...(found.doc.message ? { message: found.doc.message } : {}),
					testedAt: new Date(found.doc.testedAt).toISOString(),
				};
			}),
		);
		const linkRows = await Promise.all(
			links.map(async (link) => {
				const doc = await store.get('connections', idOf(websiteId, link.name));
				const base = {
					name: link.name,
					label: link.label,
					kind: /** @type {const} */ ('link'),
					neededBy: [...link.neededBy],
					managed: true,
				};
				if (!doc) return { ...base, set: false, status: /** @type {const} */ ('not_connected'), testedAt: null };
				return {
					...base,
					set: true,
					status: doc.status ?? 'connected',
					...(doc.message ? { message: doc.message } : {}),
					testedAt: new Date(doc.testedAt ?? doc.at).toISOString(),
				};
			}),
		);
		return [...rows, ...linkRows];
	};

	/**
	 * The refusal of a change the Portal owns: 409 `managed_by_portal`, naming where to make it.
	 * @param {string} label
	 * @param {'connections' | 'links'} section
	 * @returns {{ ok: false, problem: ProblemResult }}
	 */
	const managed = (label, section) => ({
		ok: false,
		problem: problem(
			'managed_by_portal',
			section === 'links'
				? `${label} is set by the Portal: it links the products of a website by itself (Website settings › Between your products).`
				: `${label} is entered once for every product, in the Portal: Website settings › Data and files.`,
			{ extensions: { section } },
		),
	});

	/**
	 * Save (or replace) a value of the product's own (a provider key): checked, tested live, encrypted. The database,
	 * the storage and the links are the Portal's: 409 `managed_by_portal`.
	 * @param {{ websiteId: string, name: string, value: unknown, who: Who }} input
	 * @returns {Promise<{ ok: true, connection: ConnectionView } | { ok: false, problem: ProblemResult }>}
	 */
	const save = async ({ websiteId, name, value, who }) => {
		const link = linkByName.get(name);
		if (link) return managed(link.label, 'links');
		const def = definitions[name];
		if (!def) return { ok: false, problem: problem('not_found', 'No such connection.') };
		if (isManaged(def)) return managed(def.label, 'connections');
		const violation = valueViolation(def.kind, value);
		if (violation) return { ok: false, problem: problem('validation_failed', violation) };
		const checked = /** @type {ConnectionValue} */ (value);
		const result = await runTests(websiteId, def, checked);
		const t = now();
		await store.put('connections', idOf(websiteId, name), {
			websiteId,
			name,
			sealed: sealer.seal(JSON.stringify(checked), aad(websiteId, name)),
			status: result.ok ? 'connected' : 'test_failed',
			...(result.message ? { message: result.message } : {}),
			testedAt: t,
			at: t,
		});
		await recent.record({ websiteId, who, what: 'connections', detail: `${def.label}: saved` });
		const connection = /** @type {ConnectionView} */ ((await list(websiteId)).find((c) => c.name === name));
		return { ok: true, connection };
	};

	/**
	 * Test the saved value again (the Portal's values too: the result goes to the Portal, which shows it).
	 * @param {{ websiteId: string, name: string }} input
	 * @returns {Promise<{ ok: true, connection: ConnectionView, tested?: { name: 'database' | 'storage' | 'ai', ok: boolean, message?: string } } | { ok: false, problem: ProblemResult }>}
	 */
	const test = async ({ websiteId, name }) => {
		const def = definitions[name];
		if (!def) return { ok: false, problem: problem('not_found', 'No such connection.') };
		const found = await read(websiteId, name);
		if (!found) return { ok: false, problem: problem('not_found', `${def.label} is not connected.`) };
		const result = await runTests(websiteId, def, found.value);
		await store.put('connections', idOf(websiteId, name), {
			...omit(found.doc, ['message']),
			status: result.ok ? 'connected' : 'test_failed',
			...(result.message ? { message: result.message } : {}),
			testedAt: now(),
		});
		const connection = /** @type {ConnectionView} */ ((await list(websiteId)).find((c) => c.name === name));
		return {
			ok: true,
			connection,
			...(portalNameOf(def)
				? { tested: { name: /** @type {'database' | 'storage' | 'ai'} */ (portalNameOf(def)), ...result } }
				: {}),
		};
	};

	/**
	 * @param {{ websiteId: string, name: string, who: Who }} input
	 * @returns {Promise<{ ok: true } | { ok: false, problem: ProblemResult }>}
	 */
	const remove = async ({ websiteId, name, who }) => {
		const link = linkByName.get(name);
		if (link) return managed(link.label, 'links');
		const def = definitions[name];
		if (!def) return { ok: false, problem: problem('not_found', 'No such connection.') };
		if (isManaged(def)) return managed(def.label, 'connections');
		await store.delete('connections', idOf(websiteId, name));
		await recent.record({ websiteId, who, what: 'connections', detail: `${def.label}: removed` });
		return { ok: true };
	};

	/**
	 * The decrypted value of a connection (server side only; never return it to a screen or log it).
	 * @param {string} websiteId
	 * @param {string} name
	 * @returns {Promise<ConnectionValue | null>}
	 */
	const value = async (websiteId, name) => (await read(websiteId, name))?.value ?? null;

	/**
	 * The website's database: the connection string and this product's own database name, or null when none arrived.
	 * @param {string} websiteId
	 * @returns {Promise<{ uri: string, dbName: string | null } | null>}
	 */
	const databaseOf = async (websiteId) => {
		const found = await read(websiteId, 'database');
		return found && typeof found.value === 'string' ? { uri: found.value, dbName: found.doc.dbName ?? null } : null;
	};

	/**
	 * Every secret value this product stores for a website, to keep them out of anything shown (the Setup sheet's part).
	 * @param {string} websiteId
	 * @returns {Promise<ConnectionValue[]>}
	 */
	const allValues = async (websiteId) => {
		const names = [...Object.keys(definitions), ...links.map((link) => link.name)];
		return (await Promise.all(names.map((name) => value(websiteId, name)))).filter((each) => each !== null);
	};

	/**
	 * Mark a connection broken (or working again) after a call through it.
	 * @param {string} websiteId
	 * @param {string} name
	 * @param {string | null} message null = working
	 */
	const mark = async (websiteId, name, message) => {
		const doc = await store.get('connections', idOf(websiteId, name));
		if (!doc || (message === null && doc.status === 'connected') || (message !== null && doc.message === message)) return;
		await store.put('connections', idOf(websiteId, name), {
			...omit(doc, ['message']),
			status: message === null ? 'connected' : 'test_failed',
			...(message === null ? {} : { message }),
			testedAt: now(),
		});
	};

	/**
	 * What arrived from the Portal for a managed value: sealed, tested with the existing tests, kept. A value that did not
	 * change since the held one is not tested again. Returns how it stands for the Portal's health report, or null when
	 * nothing needed testing.
	 * @param {string} websiteId
	 * @param {string} name
	 * @param {ConnectionDefinition} def
	 * @param {ConnectionValue} incoming
	 * @param {{ version: number, dbName?: string }} meta
	 * @returns {Promise<{ name: string, ok: boolean, message?: string } | null>}
	 */
	const adoptValue = async (websiteId, name, def, incoming, { version, dbName }) => {
		const held = await read(websiteId, name);
		if (
			held &&
			JSON.stringify(held.value) === JSON.stringify(incoming) &&
			(held.doc.dbName ?? null) === (dbName ?? null) &&
			held.doc.status !== undefined
		)
			return null;
		// the Portal checks an address when it is saved, but this product checks it again: a refused address is not kept
		// and never opens a connection (the message names the reason, never the address)
		if (def.kind === 'database') {
			const safe = isSafeMongoUri(incoming, policy);
			if (!safe.ok) {
				await recent.record({
					websiteId,
					who: PORTAL,
					what: 'connections',
					detail: `${def.label}: the address from the Portal was refused (${safe.reason})`,
				});
				return { name, ok: false, message: `This address is not allowed (${safe.reason}).` };
			}
		}
		const result = await runTests(websiteId, def, incoming);
		const t = now();
		await store.put('connections', idOf(websiteId, name), {
			websiteId,
			name,
			sealed: sealer.seal(JSON.stringify(incoming), aad(websiteId, name)),
			status: result.ok ? 'connected' : 'test_failed',
			...(result.message ? { message: result.message } : {}),
			...(dbName ? { dbName } : {}),
			portalVersion: version,
			testedAt: t,
			at: t,
		});
		await recent.record({
			websiteId,
			who: PORTAL,
			what: 'connections',
			detail: `${def.label}: updated from the Portal (version ${version})`,
		});
		return { name, ...result };
	};

	/**
	 * Take what the Portal delivered for this product: the database, the storage and the AI key (sealed, tested), the links' keys
	 * (sealed), and forget what the Portal no longer delivers (a removed connection, a revoked or switched-off link, and the
	 * token connections of older versions). Returns the test results to report.
	 * @param {string} websiteId
	 * @param {Bundle} bundle
	 * @returns {Promise<Array<{ name: string, ok: boolean, message?: string }>>}
	 */
	const adopt = async (websiteId, bundle) => {
		/** @type {Array<{ name: string, ok: boolean, message?: string }>} */
		const results = [];
		for (const [name, def] of Object.entries(definitions)) {
			if (!isManaged(def)) continue;
			const incoming = deliveredFor(def, bundle);
			if (!incoming) {
				if (await store.get('connections', idOf(websiteId, name))) {
					await store.delete('connections', idOf(websiteId, name));
					await recent.record({
						websiteId,
						who: PORTAL,
						what: 'connections',
						detail: `${def.label}: removed in the Portal`,
					});
				}
				continue;
			}
			const reported =
				'uri' in incoming
					? await adoptValue(websiteId, name, def, incoming.uri, { version: bundle.version, dbName: incoming.dbName })
					: await adoptValue(websiteId, name, def, /** @type {ConnectionValue} */ (incoming), { version: bundle.version });
			if (reported) results.push(reported);
		}
		for (const link of links) {
			const given = bundle.links.out.find((each) => each.to === link.productId);
			const id = idOf(websiteId, link.name);
			if (!given) {
				if (await store.get('connections', id)) {
					await store.delete('connections', id);
					await recent.record({ websiteId, who: PORTAL, what: 'connections', detail: `${link.label}: ended in the Portal` });
				}
				continue;
			}
			const held = await read(websiteId, link.name);
			if (held && held.value === given.token) continue;
			const t = now();
			await store.put('connections', id, {
				websiteId,
				name: link.name,
				sealed: sealer.seal(JSON.stringify(given.token), aad(websiteId, link.name)),
				status: 'connected',
				portalVersion: bundle.version,
				testedAt: t,
				at: t,
			});
			await recent.record({
				websiteId,
				who: PORTAL,
				what: 'connections',
				detail: `${link.label}: updated from the Portal (version ${bundle.version})`,
			});
		}
		// an older version of this product kept the server tokens of other products pasted by hand: they are not used
		// any more, so they are not kept
		for (const doc of await store.list('connections', { websiteId }, { limit: RESEAL_LIMIT })) {
			const name = String(doc.name);
			if (!definitions[name] && !linkByName.has(name)) await store.delete('connections', idOf(websiteId, name));
		}
		return results;
	};

	/**
	 * Another product's address (its base URL, from the Portal's directory, cached up to 5 minutes).
	 * @param {string} id
	 * @returns {Promise<string>}
	 */
	const addressOf = async (id) => {
		const cached = addresses.get(id);
		if (cached && cached.until > now()) return cached.baseUrl;
		const { baseUrl } = await directory(id);
		addresses.set(id, { baseUrl, until: now() + DIRECTORY_TTL_MS });
		return baseUrl;
	};

	/**
	 * Every connected product with its name and address, by id (the Portal's directory list, cached up to 5 minutes; its
	 * addresses also answer `addressOf`). While the Portal cannot answer, the last good copy; throws when there is none.
	 * After a failure the Portal is asked again only after a minute, so callers (a send) never each wait for it.
	 * @returns {Promise<ReadonlyArray<Readonly<DirectoryEntry>>>}
	 */
	const products = async () => {
		if (listed && listed.until > now()) return listed.items;
		if (unlisted && unlisted.until > now()) {
			if (!listed) throw unlisted.error;
			return listed.items;
		}
		try {
			const { items } = await directoryList();
			const until = now() + DIRECTORY_TTL_MS;
			for (const item of items) addresses.set(item.productId, { baseUrl: item.baseUrl, until });
			listed = { items: Object.freeze(items.map((item) => Object.freeze({ ...item }))), until };
			unlisted = null;
		} catch (error) {
			unlisted = { error, until: now() + DIRECTORY_RETRY_MS };
			if (!listed) throw error;
			logger.warn('product directory not read: the last copy is used', { error });
		}
		return listed.items;
	};

	/**
	 * Call another product with the link key the Portal gave this product for it, exactly as the other product expects:
	 * the key proves who calls, and the other product lets it do only what the Portal granted. A send to Notifications
	 * carries the defaults and long values of the product's message (parity P1).
	 * @param {string} websiteId
	 * @param {string} otherProductId
	 * @param {string} path e.g. `/v1/activity-copies`
	 * @param {{ method?: string, body?: unknown, headers?: Record<string, string> }} [init]
	 * @returns {Promise<ProductCall>}
	 */
	const callProduct = async (websiteId, otherProductId, path, init = {}) => {
		const { method = 'GET', body, headers = {} } = attach(otherProductId, path, init);
		const name = linkName(otherProductId);
		const token = linkByName.has(name) ? await value(websiteId, name) : null;
		if (typeof token !== 'string') return { ok: false, reason: 'not_connected' };
		/** @type {string} */
		let baseUrl;
		try {
			baseUrl = await addressOf(otherProductId);
		} catch (error) {
			logger.warn('product address not found', { productId: otherProductId, error });
			await mark(websiteId, name, `${otherProductId} is not available.`);
			return { ok: false, reason: 'unavailable' };
		}
		/** @type {import('@ss/net').SafeResponse} */
		let response;
		try {
			response = await send(`${baseUrl}${path}`, {
				method,
				redirect: 'error',
				headers: {
					accept: 'application/json',
					authorization: `Bearer ${token}`,
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
					...headers,
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		} catch (error) {
			logger.warn('product call failed', { productId: otherProductId, reason: isNetError(error) ? error.code : 'error' });
			return { ok: false, reason: 'unreachable' };
		}
		/** @type {unknown} */
		let parsed = null;
		try {
			parsed = response.body.length > 0 ? JSON.parse(response.body.toString('utf8')) : null;
		} catch {
			parsed = null;
		}
		if (response.status >= 200 && response.status < 300) {
			await mark(websiteId, name, null);
			return { ok: true, status: response.status, body: parsed };
		}
		if (response.status === 401) {
			await mark(websiteId, name, 'The link was refused (it may have been revoked or switched off in the Portal).');
			return { ok: false, reason: 'refused', status: 401, body: parsed };
		}
		const code = isObject(parsed) && typeof parsed.type === 'string' ? parsed.type.split('/').pop() : '';
		if (response.status === 403 && code === 'product_unavailable') {
			await mark(websiteId, name, `${otherProductId} is not available for this website.`);
			return { ok: false, reason: 'unavailable', status: 403, body: parsed };
		}
		return { ok: false, reason: response.status >= 500 ? 'unreachable' : 'failed', status: response.status, body: parsed };
	};

	/**
	 * Seal every stored value with the current key (RT-14). A value saved meanwhile is left as saved.
	 * @returns {Promise<import('./reseal.js').ResealCounts>}
	 */
	const reseal = async () =>
		resealEach(
			sealer,
			(await store.list('connections', {}, { limit: RESEAL_LIMIT })).map((doc) => ({
				sealed: doc.sealed,
				aad: aad(doc.websiteId, doc.name),
				save: async (/** @type {string} */ next) => {
					const id = idOf(doc.websiteId, doc.name);
					if ((await store.get('connections', id))?.sealed === doc.sealed)
						await store.put('connections', id, { ...doc, sealed: next });
				},
			})),
		);

	return Object.freeze({
		definitions,
		links: Object.freeze([...links]),
		list,
		save,
		test,
		remove,
		value,
		databaseOf,
		allValues,
		adopt,
		callProduct,
		addressOf,
		products,
		reseal,
		/**
		 * The values the Portal delivers (the database, the storage, the AI key, the links' keys) that are stored for the website but no
		 * longer open (the key changed without the previous one): the product fetches them again.
		 * @param {string} websiteId
		 * @returns {Promise<string[]>}
		 */
		unreadable: async (websiteId) => {
			/** @type {string[]} */
			const names = [];
			for (const doc of await store.list('connections', { websiteId }, { limit: 200 })) {
				const name = String(doc.name);
				const delivered = isManaged(definitions[name]) || linkByName.has(name);
				if (delivered && sealer.open(doc.sealed, aad(websiteId, name)) === null) names.push(name);
			}
			return names;
		},
		/** Whether the product's manifest needs a link to the product (it is then given one when both are on the website). @param {string} id */
		declaresLink: (id) => linkByProduct.has(id),
		/**
		 * Whether the Portal gave this product a link to another product for the website.
		 * @param {string} websiteId @param {string} id
		 * @returns {Promise<boolean>}
		 */
		hasLink: async (websiteId, id) => (await value(websiteId, linkName(id))) !== null,
		/** @returns {Promise<string[]>} the websites whose merchant database is connected */
		websitesWithDatabase: async () =>
			(await store.list('connections', { name: 'database' }, { limit: RESEAL_LIMIT })).map((doc) => doc.websiteId),
		/**
		 * The S3-compatible storage of a website (presigned uploads), or null when not connected.
		 * @param {string} websiteId
		 * @param {string} [name] default `storage`
		 */
		storage: async (websiteId, name = 'storage') => {
			const found = definitions[name]?.kind === 'storage' ? await value(websiteId, name) : null;
			return isObject(found) ? createS3Storage({ descriptor: found, websiteId, slug: productId, send, now, policy }) : null;
		},
	});
};

/** @typedef {ReturnType<typeof createConnections>} Connections */
