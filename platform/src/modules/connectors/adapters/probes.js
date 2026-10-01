/**
 * Connection checks against client-owned resources (I/O). Every network path goes through the SSRF guard
 * (`outbound.js`); results are reports of stable codes (`core/report.js`) — nothing from the remote side or from
 * the credentials is copied into a report.
 *
 * - database: connect with short timeouts, `ping`, `connectionStatus` (roles, least privilege), create and drop a
 *   probe collection with an index in the target database;
 * - storage: SigV4-signed PUT / GET / DELETE of a probe object under the configured prefix;
 * - ai / messaging (HTTP): one cheap authenticated GET (AI: the models list);
 * - messaging (SMTP): TCP (+ TLS when `secure`) reachability and the server greeting; authentication is not tried;
 * - payments / analytics: no automated check (stored only) — the report is marked `skipped`.
 * @module
 */
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { MongoClient } from 'mongodb';
import { aiEndpoint } from '../core/descriptor.js';
import { checkDatabaseCredentials } from '../core/mongo-uri.js';
import { checkHost } from '../core/netguard.js';
import { analysePrivileges, buildReport } from '../core/report.js';
import { objectUrl, signHeaders } from '../core/sigv4.js';
import { createGuardedLookup, createOutbound } from './outbound.js';

/** @typedef {import('../core/netguard.js').Allowlist} Allowlist */
/** @typedef {import('../core/report.js').CheckReport} CheckReport */
/** @typedef {import('../core/report.js').CheckStep} CheckStep */
/** @typedef {import('./outbound.js').LookupFunction} LookupFunction */
/** @typedef {(uri: string, options: import('mongodb').MongoClientOptions) => MongoClient} ConnectMongo */

export const DB_TIMEOUTS = Object.freeze({ serverSelectionTimeoutMS: 5_000, connectTimeoutMS: 5_000, socketTimeoutMS: 10_000 });
const DB_DEADLINE_MS = 25_000;

/**
 * @param {unknown} error
 * @returns {string}
 */
const mongoCode = (error) => {
	const e = /** @type {any} */ (error);
	if (e?.code === 13 || e?.codeName === 'Unauthorized') return 'permission_denied';
	if (e?.code === 18 || e?.codeName === 'AuthenticationFailed' || /auth/i.test(String(e?.name ?? ''))) return 'auth_failed';
	return 'command_failed';
};

/**
 * @param {unknown} error
 */
const isAuthError = (error) => {
	const e = /** @type {any} */ (error);
	return e?.code === 18 || e?.codeName === 'AuthenticationFailed' || /authentication failed/i.test(String(e?.message ?? ''));
};

/** @param {Buffer} body */
const s3ErrorCode = (body) => /<Code>([A-Za-z]{1,64})<\/Code>/.exec(body.toString('utf8'))?.[1] ?? null;

/**
 * @param {number} status
 * @param {string | null} s3Code
 */
const storageFailure = (status, s3Code) => {
	if (s3Code === 'InvalidAccessKeyId' || s3Code === 'SignatureDoesNotMatch' || s3Code === 'InvalidToken') return 'auth_failed';
	if (s3Code === 'NoSuchBucket') return 'bucket_not_found';
	if (s3Code === 'AccessDenied' || status === 403) return 'permission_denied';
	if (status === 401) return 'auth_failed';
	return 'unexpected_status';
};

/**
 * @param {{ allowlist: Allowlist, now: () => number, randomBytes: (n: number) => Uint8Array, lookup?: LookupFunction,
 *   connectMongo?: ConnectMongo, httpTimeoutMs?: number }} options
 */
export const createProbes = ({
	allowlist,
	now,
	randomBytes,
	lookup,
	connectMongo = (uri, options) => new MongoClient(uri, options),
	httpTimeoutMs = 8_000,
}) => {
	const outbound = createOutbound({ allowlist, ...(lookup ? { lookup } : {}), defaultTimeoutMs: httpTimeoutMs });
	const hex = (/** @type {number} */ n) => Buffer.from(randomBytes(n)).toString('hex');

	/**
	 * @param {Record<string, any>} credentials
	 * @returns {Promise<CheckReport>}
	 */
	const database = async (credentials) => {
		const startedAt = now();
		const { errors, dbName } = checkDatabaseCredentials(/** @type {any} */ (credentials), allowlist);
		if (errors.length > 0 || dbName === null)
			return buildReport({ steps: [{ name: 'credentials', ok: false, code: 'invalid_credentials' }], startedAt, now: now() });
		let refused = false;
		const guarded = createGuardedLookup({
			allowlist,
			...(lookup ? { lookup } : {}),
			onRefused: () => {
				refused = true;
			},
		});
		/** @type {CheckStep[]} */
		const steps = [];
		/** @type {string[]} */
		const warnings = [];
		/** @type {Record<string, unknown>} */
		const info = {};
		const client = connectMongo(credentials.uri, {
			...DB_TIMEOUTS,
			maxPoolSize: 1,
			minPoolSize: 0,
			retryWrites: false,
			retryReads: false,
			appName: 'ss-portal-connection-check',
			lookup: /** @type {any} */ (guarded),
		});
		/** @type {ReturnType<typeof setTimeout> | undefined} */
		let timer;
		const run = async () => {
			try {
				await client.connect();
			} catch (error) {
				if (refused) steps.push({ name: 'reachability', ok: false, code: 'address_refused' });
				else if (isAuthError(error)) {
					steps.push({ name: 'reachability', ok: true }, { name: 'auth', ok: false, code: 'auth_failed' });
				} else steps.push({ name: 'reachability', ok: false, code: 'unreachable' });
				return;
			}
			const db = client.db(dbName);
			try {
				await db.command({ ping: 1 });
				steps.push({ name: 'reachability', ok: true });
			} catch (error) {
				steps.push({ name: 'reachability', ok: false, code: mongoCode(error) });
				return;
			}
			try {
				const privileges = analysePrivileges(await db.command({ connectionStatus: 1, showPrivileges: true }), dbName);
				steps.push({ name: 'auth', ok: true });
				info.roles = privileges.roles;
				info.authenticated = privileges.authenticated;
				if (!privileges.authenticated) warnings.push('unauthenticated');
				if (privileges.overPrivileged) warnings.push('over_privileged');
			} catch (error) {
				steps.push({ name: 'auth', ok: false, code: mongoCode(error) });
				return;
			}
			try {
				const build = await db.command({ buildInfo: 1 });
				if (typeof build.version === 'string' && /^[0-9][0-9a-z.+-]{0,31}$/.test(build.version))
					info.serverVersion = build.version;
			} catch {
				// optional
			}
			const probe = `ss_probe_${hex(6)}`;
			let createdCollection = false;
			try {
				await db.createCollection(probe);
				createdCollection = true;
				steps.push({ name: 'create_collection', ok: true });
				await db.collection(probe).createIndex({ probe: 1 }, { name: 'ss_probe' });
				steps.push({ name: 'create_index', ok: true });
			} catch (error) {
				steps.push({ name: createdCollection ? 'create_index' : 'create_collection', ok: false, code: mongoCode(error) });
			} finally {
				if (createdCollection) {
					try {
						await db.collection(probe).drop();
						steps.push({ name: 'drop_collection', ok: true });
					} catch (error) {
						steps.push({ name: 'drop_collection', ok: false, code: mongoCode(error) });
					}
				}
			}
		};
		try {
			const deadline = new Promise((resolve) => {
				timer = setTimeout(() => resolve('timeout'), DB_DEADLINE_MS);
			});
			if ((await Promise.race([run().then(() => 'done'), deadline])) === 'timeout')
				steps.push({ name: 'deadline', ok: false, code: 'timeout' });
		} finally {
			clearTimeout(timer);
			await client.close(true).catch(() => {});
		}
		return buildReport({ steps, warnings, info, startedAt, now: now() });
	};

	/**
	 * @param {Record<string, any>} c
	 * @returns {Promise<CheckReport>}
	 */
	const storage = async (c) => {
		const startedAt = now();
		const credentials = { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey };
		const key = `${c.prefix ?? ''}ss_probe/${hex(8)}.txt`;
		const url = objectUrl({ endpoint: c.endpoint, region: c.region, bucket: c.bucket, forcePathStyle: c.forcePathStyle }, key);
		const content = `ss-probe ${hex(4)}`;
		/** @type {CheckStep[]} */
		const steps = [];
		/**
		 * @param {'PUT' | 'GET' | 'DELETE'} method
		 * @param {string} name
		 */
		const call = async (method, name) => {
			const body = method === 'PUT' ? content : '';
			const headers = signHeaders({
				method,
				url,
				credentials,
				region: c.region,
				now: now(),
				headers: method === 'PUT' ? { 'content-type': 'text/plain' } : {},
				body,
			});
			const res = await outbound.request({ method, url, headers, ...(method === 'PUT' ? { body } : {}) });
			if (!res.ok) {
				if (steps.length === 0) steps.push({ name: 'reachability', ok: false, code: res.code });
				else steps.push({ name, ok: false, code: res.code });
				return null;
			}
			if (steps.length === 0) steps.push({ name: 'reachability', ok: true });
			if (res.status < 200 || res.status > 299) {
				steps.push({ name, ok: false, code: storageFailure(res.status, s3ErrorCode(res.body)), status: res.status });
				return null;
			}
			return res;
		};
		const put = await call('PUT', 'put_object');
		if (put) {
			steps.push({ name: 'put_object', ok: true });
			const got = await call('GET', 'get_object');
			if (got)
				steps.push(
					got.body.toString('utf8') === content
						? { name: 'get_object', ok: true }
						: { name: 'get_object', ok: false, code: 'content_mismatch' },
				);
			if (await call('DELETE', 'delete_object')) steps.push({ name: 'delete_object', ok: true });
		}
		return buildReport({ steps, startedAt, now: now() });
	};

	/**
	 * @param {string} url
	 * @param {Record<string, string>} headers
	 * @returns {Promise<CheckReport>}
	 */
	const httpGet = async (url, headers) => {
		const startedAt = now();
		const res = await outbound.request({ method: 'GET', url, headers: { accept: 'application/json', ...headers } });
		/** @type {CheckStep[]} */
		const steps = [];
		if (!res.ok) steps.push({ name: 'reachability', ok: false, code: res.code });
		else {
			steps.push({ name: 'reachability', ok: true });
			if (res.status >= 200 && res.status <= 299) steps.push({ name: 'auth', ok: true, status: res.status });
			else
				steps.push({
					name: 'auth',
					ok: false,
					code: res.status === 401 || res.status === 403 ? 'auth_failed' : 'unexpected_status',
					status: res.status,
				});
		}
		return buildReport({ steps, startedAt, now: now() });
	};

	/**
	 * @param {Record<string, any>} c
	 * @returns {Promise<CheckReport>}
	 */
	const smtp = (c) =>
		new Promise((resolve) => {
			const startedAt = now();
			const host = checkHost(String(c.host), allowlist);
			if (!host.ok) {
				resolve(buildReport({ steps: [{ name: 'reachability', ok: false, code: host.code }], startedAt, now: now() }));
				return;
			}
			const secure = c.secure ?? true;
			const port = c.port ?? (secure ? 465 : 587);
			let refused = false;
			const guarded = createGuardedLookup({
				allowlist,
				...(lookup ? { lookup } : {}),
				onRefused: () => {
					refused = true;
				},
			});
			let settled = false;
			/** @param {CheckStep[]} steps */
			const finish = (steps) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				socket.destroy();
				resolve(buildReport({ steps, warnings: ['auth_not_checked'], startedAt, now: now() }));
			};
			const options = { host: host.host, port, lookup: /** @type {any} */ (guarded) };
			const socket = secure ? tlsConnect({ ...options, servername: host.ip ? undefined : host.host }) : netConnect(options);
			const timer = setTimeout(() => finish([{ name: 'reachability', ok: false, code: 'timeout' }]), httpTimeoutMs);
			socket.once('data', (chunk) => {
				const greeting = /^220[ -]/.test(chunk.toString('utf8'));
				finish([
					{ name: 'reachability', ok: true },
					greeting ? { name: 'greeting', ok: true } : { name: 'greeting', ok: false, code: 'unexpected_greeting' },
				]);
			});
			socket.once('error', (error) => {
				const code = String(/** @type {any} */ (error)?.code ?? '');
				finish([
					{
						name: 'reachability',
						ok: false,
						code: refused
							? 'address_refused'
							: /CERT|SSL|TLS|SELF_SIGNED|HOSTNAME|ALTNAME/.test(code)
								? 'tls_error'
								: 'unreachable',
					},
				]);
			});
		});

	/**
	 * Run the check for a connector.
	 * @param {string} kind
	 * @param {string} provider
	 * @param {Record<string, any>} credentials
	 * @returns {Promise<CheckReport>}
	 */
	const run = async (kind, provider, credentials) => {
		switch (kind) {
			case 'database':
				return database(credentials);
			case 'storage':
				return storage(credentials);
			case 'ai': {
				const endpoint = aiEndpoint(provider, credentials);
				/** @type {Record<string, string>} */
				const headers = { ...endpoint.headers };
				if (endpoint.authScheme === 'header') headers[String(endpoint.authHeader)] = String(credentials.apiKey);
				else headers.authorization = `Bearer ${credentials.apiKey}`;
				return httpGet(`${endpoint.baseUrl}/models`, headers);
			}
			case 'messaging': {
				if (provider === 'smtp') return smtp(credentials);
				const base = String(credentials.baseUrl).replace(/\/+$/, '');
				const auth =
					credentials.authScheme === 'header'
						? { [String(credentials.authHeader ?? 'x-api-key').toLowerCase()]: credentials.apiKey }
						: { authorization: `Bearer ${credentials.apiKey}` };
				return httpGet(`${base}${credentials.testPath ?? ''}` || base, { ...(credentials.headers ?? {}), ...auth });
			}
			default: {
				const at = now();
				return buildReport({ steps: [], warnings: ['not_checked'], startedAt: at, now: at, skipped: true });
			}
		}
	};

	return Object.freeze({ run, database, storage, httpGet, smtp });
};
/** @typedef {ReturnType<typeof createProbes>} Probes */
