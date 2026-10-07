/**
 * Connections (PLAN 0.4.3, 0.4.6, 0.4.8): the merchant's own database, storage, provider keys and pasted tokens, per
 * website, in the product database.
 *
 * - Values are encrypted (AES-256-GCM, key derived from `ENCRYPTION_KEY`) and write-only: screens get only
 *   `{ name, label, kind, neededBy, status, message?, last4, testedAt }`. A value that no longer decrypts (the key
 *   changed) shows as `not_connected`.
 * - Each value is tested live when saved and on Test: `database` connects and pings through the guarded lookup,
 *   `storage` signs a HEAD request to the bucket, `token` must verify as a Portal-signed server token of the expected
 *   product for the same website (else it is refused), and the definition's own `test` hook runs last.
 * - Every change writes Recent changes.
 * - `callProduct` calls another product with a pasted token, at the address the Portal's directory gives (cached up to
 *   5 minutes), through `@ss/net`.
 * @module
 */
import { isNetError } from '@ss/net';
import { problem } from './http/results.js';
import { createS3Storage } from './adapters/storage.js';
import { isObject, omit } from './util.js';

/** @typedef {import('./stores/types.js').Store} Store */
/** @typedef {import('./recent.js').Who} Who */
/** @typedef {import('./http/results.js').ProblemResult} ProblemResult */
/** @typedef {'database' | 'storage' | 'secret' | 'token'} ConnectionKind */
/** @typedef {string | Record<string, string | number | boolean>} ConnectionValue */
/**
 * @typedef {object} ConnectionDefinition
 * @property {string} label shown on the Connections screen
 * @property {string[]} neededBy feature keys
 * @property {ConnectionKind} kind
 * @property {string} [productId] `token` connections: the product whose server token is pasted
 * @property {string} [secretField] object values: the member whose last 4 characters are shown (default `apiKey`)
 * @property {(value: ConnectionValue, ctx: { websiteId: string, send: OutboundSend }) => Promise<{ ok: boolean, message?: string }>} [test]
 */
/**
 * @typedef {{ name: string, label: string, kind: ConnectionKind, neededBy: string[], status: 'connected' | 'not_connected' | 'test_failed',
 *   message?: string, last4: string, testedAt: string | null }} ConnectionView
 */
/** @typedef {(url: string, init?: import('@ss/net').SafeFetchInit) => Promise<import('@ss/net').SafeResponse>} OutboundSend */
/**
 * @typedef {{ ok: true, status: number, body: unknown }
 *   | { ok: false, reason: 'not_connected' | 'refused' | 'unavailable' | 'unreachable' | 'failed', status?: number, body?: unknown }} ProductCall
 */

const NAME = /^[a-z][a-z0-9_]{0,39}$/;
const KINDS = Object.freeze(['database', 'storage', 'secret', 'token']);
const DIRECTORY_TTL_MS = 5 * 60_000;
const MAX_VALUE_LENGTH = 4096;

/**
 * Check connection definitions against the manifest; adds the built-in `database` connection when none is declared.
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
			throw new TypeError(`connection ${name} needs a label and a kind (database, storage, secret, token)`);
		if (!Array.isArray(def.neededBy) || def.neededBy.some((key) => !keys.includes(key)))
			throw new TypeError(`connection ${name}: neededBy must list features of the manifest`);
		if ((def.kind === 'token') !== (typeof def.productId === 'string'))
			throw new TypeError(`connection ${name}: productId is required for token connections and only there`);
		if (def.kind === 'database' && name !== 'database') throw new TypeError('the database connection is named database');
		out[name] = def;
	}
	out.database ??= { label: 'Database (MongoDB)', kind: 'database', neededBy: [...keys] };
	return out;
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
	if (kind === 'token')
		return typeof value === 'string' && value.length > 0 && value.length <= MAX_VALUE_LENGTH ? null : 'Paste the server token.';
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
 *   sealer: import('./sealing.js').Sealer, recent: import('./recent.js').RecentChanges, send: OutboundSend,
 *   policy: import('@ss/net').OutboundPolicy, testDatabase: (uri: string) => Promise<{ ok: boolean, message?: string }>,
 *   verifyServerToken: (token: string, productId: string) => Promise<{ websiteId: string } | null>,
 *   directory: (productId: string) => Promise<{ baseUrl: string }>,
 *   now: () => number, logger: import('./logger.js').Logger,
 * }} options
 */
export const createConnections = ({
	store,
	productId,
	definitions,
	sealer,
	recent,
	send,
	policy,
	testDatabase,
	verifyServerToken,
	directory,
	now,
	logger,
}) => {
	/** @type {Map<string, { baseUrl: string, until: number }>} */
	const addresses = new Map();
	/** @param {string} websiteId @param {string} name */
	const idOf = (websiteId, name) => `${websiteId}|${name}`;
	/** @param {string} websiteId @param {string} name */
	const aad = (websiteId, name) => `connection|${websiteId}|${name}`;

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
	 * @param {ConnectionDefinition} def
	 * @param {ConnectionValue} value
	 */
	const last4Of = (def, value) => {
		const secret =
			typeof value === 'string' ? value : value[def.kind === 'storage' ? 'secretAccessKey' : (def.secretField ?? 'apiKey')];
		return typeof secret === 'string' ? secret.slice(-4) : '';
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
	const list = async (websiteId) =>
		Promise.all(
			Object.entries(definitions).map(async ([name, def]) => {
				const found = await read(websiteId, name);
				const base = { name, label: def.label, kind: def.kind, neededBy: [...def.neededBy] };
				if (!found) return { ...base, status: /** @type {const} */ ('not_connected'), last4: '', testedAt: null };
				return {
					...base,
					status: found.doc.status,
					...(found.doc.message ? { message: found.doc.message } : {}),
					last4: found.doc.last4,
					testedAt: new Date(found.doc.testedAt).toISOString(),
				};
			}),
		);

	/**
	 * Save (or replace) a value: checked, tested live, encrypted.
	 * @param {{ websiteId: string, name: string, value: unknown, who: Who }} input
	 * @returns {Promise<{ ok: true, connection: ConnectionView } | { ok: false, problem: ProblemResult }>}
	 */
	const save = async ({ websiteId, name, value, who }) => {
		const def = definitions[name];
		if (!def) return { ok: false, problem: problem('not_found', 'No such connection.') };
		const violation = valueViolation(def.kind, value);
		if (violation) return { ok: false, problem: problem('validation_failed', violation) };
		const checked = /** @type {ConnectionValue} */ (value);
		if (def.kind === 'storage') {
			try {
				createS3Storage({
					descriptor: /** @type {Record<string, unknown>} */ (checked),
					websiteId,
					slug: productId,
					send,
					now,
					policy,
				});
			} catch (error) {
				return { ok: false, problem: problem('validation_failed', /** @type {Error} */ (error).message) };
			}
		}
		if (def.kind === 'token') {
			const claims = await verifyServerToken(/** @type {string} */ (checked), /** @type {string} */ (def.productId));
			if (!claims || claims.websiteId !== websiteId)
				return {
					ok: false,
					problem: problem('validation_failed', `This is not a server token of ${def.productId} for this website.`),
				};
		}
		const result = await runTests(websiteId, def, checked);
		const t = now();
		await store.put('connections', idOf(websiteId, name), {
			websiteId,
			name,
			sealed: sealer.seal(JSON.stringify(checked), aad(websiteId, name)),
			last4: last4Of(def, checked),
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
	 * Test the saved value again.
	 * @param {{ websiteId: string, name: string }} input
	 * @returns {Promise<{ ok: true, connection: ConnectionView } | { ok: false, problem: ProblemResult }>}
	 */
	const test = async ({ websiteId, name }) => {
		const def = definitions[name];
		if (!def) return { ok: false, problem: problem('not_found', 'No such connection.') };
		const found = await read(websiteId, name);
		if (!found) return { ok: false, problem: problem('not_found', `${def.label} is not connected.`) };
		let result = await runTests(websiteId, def, found.value);
		if (result.ok && def.kind === 'token') {
			const claims = await verifyServerToken(/** @type {string} */ (found.value), /** @type {string} */ (def.productId));
			if (!claims) result = { ok: false, message: 'The token was refused (it may have been regenerated).' };
		}
		await store.put('connections', idOf(websiteId, name), {
			...omit(found.doc, ['message']),
			status: result.ok ? 'connected' : 'test_failed',
			...(result.message ? { message: result.message } : {}),
			testedAt: now(),
		});
		const connection = /** @type {ConnectionView} */ ((await list(websiteId)).find((c) => c.name === name));
		return { ok: true, connection };
	};

	/**
	 * @param {{ websiteId: string, name: string, who: Who }} input
	 * @returns {Promise<{ ok: true } | { ok: false, problem: ProblemResult }>}
	 */
	const remove = async ({ websiteId, name, who }) => {
		const def = definitions[name];
		if (!def) return { ok: false, problem: problem('not_found', 'No such connection.') };
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

	/** @param {string} id */
	const addressOf = async (id) => {
		const cached = addresses.get(id);
		if (cached && cached.until > now()) return cached.baseUrl;
		const { baseUrl } = await directory(id);
		addresses.set(id, { baseUrl, until: now() + DIRECTORY_TTL_MS });
		return baseUrl;
	};

	/**
	 * Call another product with the server token pasted for it, exactly as the merchant's own server would.
	 * @param {string} websiteId
	 * @param {string} otherProductId
	 * @param {string} path e.g. `/v1/activity-copies`
	 * @param {{ method?: string, body?: unknown, headers?: Record<string, string> }} [init]
	 * @returns {Promise<ProductCall>}
	 */
	const callProduct = async (websiteId, otherProductId, path, { method = 'GET', body, headers = {} } = {}) => {
		const name = Object.keys(definitions).find(
			(key) => definitions[key]?.kind === 'token' && definitions[key]?.productId === otherProductId,
		);
		const token = name ? await value(websiteId, name) : null;
		if (!name || typeof token !== 'string') return { ok: false, reason: 'not_connected' };
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
			await mark(websiteId, name, 'The token was refused (it may have been regenerated).');
			return { ok: false, reason: 'refused', status: 401, body: parsed };
		}
		const code = isObject(parsed) && typeof parsed.type === 'string' ? parsed.type.split('/').pop() : '';
		if (response.status === 403 && code === 'product_unavailable') {
			await mark(websiteId, name, `${otherProductId} is not available for this website.`);
			return { ok: false, reason: 'unavailable', status: 403, body: parsed };
		}
		return { ok: false, reason: response.status >= 500 ? 'unreachable' : 'failed', status: response.status, body: parsed };
	};

	return Object.freeze({
		definitions,
		list,
		save,
		test,
		remove,
		value,
		callProduct,
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
