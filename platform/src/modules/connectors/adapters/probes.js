/**
 * Connection checks against client-owned resources (I/O). Every network path goes through the `@ss/net` SSRF guard:
 * HTTP(S) through `safeFetch` (URL policy, DNS answers vetted at connect time, no redirects, deadline, size cap), the
 * MongoDB driver and SMTP sockets through `guardedLookup` after a `checkHost`. Results are reports of stable codes
 * (`core/report.js`) — nothing from the remote side or from the credentials is copied into a report.
 *
 * - database: connect with short timeouts, `ping`, `connectionStatus` (least privilege: privileges outside the
 *   target database or at cluster level fail the check with `over_privileged`; dbAdmin/dbOwner/userAdmin on the
 *   target is a `db_admin` warning), create and drop a probe collection with an index in the target database;
 * - storage: SigV4-signed PUT / GET / DELETE of a probe object under the configured prefix;
 * - ai / messaging (HTTP): one cheap authenticated GET (AI: the models list);
 * - messaging (SMTP): TCP (+ TLS when `secure`) reachability and the server greeting; authentication is not tried;
 * - payments: no automated check (stored only) — the report is marked `skipped`.
 * @module
 */
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { checkHost, guardedLookup, isNetError, objectUrl, safeFetch, signV4 } from '@ss/net';
import { MongoClient } from 'mongodb';
import { aiEndpoint } from '../core/descriptor.js';
import { checkDatabaseCredentials } from '../core/mongo-uri.js';
import { analysePrivileges, buildReport } from '../core/report.js';
import { urlRefusalCode } from '../core/schemas.js';

/** @typedef {import('@ss/net').OutboundPolicy} OutboundPolicy */
/** @typedef {import('../core/report.js').CheckReport} CheckReport */
/** @typedef {import('../core/report.js').CheckStep} CheckStep */
/**
 * @typedef {{ ok: true, status: number, headers: Record<string, string>, body: Buffer }
 *   | { ok: false, code: string }} OutboundResult
 */
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
 * Stable report code of an outbound failure.
 * @param {unknown} error
 * @returns {string}
 */
export const outboundCode = (error) => {
	if (!isNetError(error)) return 'unreachable';
	switch (error.code) {
		case 'bad_url':
		case 'ssrf_blocked':
			return urlRefusalCode(error);
		case 'timeout':
			return 'timeout';
		case 'too_large':
			return 'response_too_large';
		default:
			return error.reason === 'tls_failed' ? 'tls_error' : 'unreachable';
	}
};

/**
 * @param {{ policy: OutboundPolicy, now: () => number, randomBytes: (n: number) => Uint8Array,
 *   connectMongo?: ConnectMongo, httpTimeoutMs?: number }} options `policy` is the `@ss/net` outbound policy (its
 *   `resolve` is the DNS resolver every check uses)
 */
export const createProbes = ({
	policy,
	now,
	randomBytes,
	connectMongo = (uri, options) => new MongoClient(uri, options),
	httpTimeoutMs = 8_000,
}) => {
	const hex = (/** @type {number} */ n) => Buffer.from(randomBytes(n)).toString('hex');

	/**
	 * One guarded HTTP(S) request: redirects are returned as they are (never followed); failures become codes.
	 * @param {{ method: string, url: string, headers?: Record<string, string>, body?: string }} input
	 * @returns {Promise<OutboundResult>}
	 */
	const request = async ({ method, url, headers = {}, body }) => {
		try {
			const res = await safeFetch(
				url,
				{ method, headers, ...(body === undefined ? {} : { body }), redirect: 'manual', timeoutMs: httpTimeoutMs },
				policy,
			);
			return { ok: true, status: res.status, headers: res.headers, body: res.body };
		} catch (error) {
			return { ok: false, code: outboundCode(error) };
		}
	};

	/**
	 * A `lookup` for sockets and the MongoDB driver that records refusals.
	 * @returns {{ lookup: import('@ss/net').LookupFunction, refused: () => boolean }}
	 */
	const lookupWithFlag = () => {
		let refused = false;
		return {
			lookup: guardedLookup(policy, {
				onRefused: () => {
					refused = true;
				},
			}),
			refused: () => refused,
		};
	};

	/**
	 * @param {Record<string, any>} credentials
	 * @returns {Promise<CheckReport>}
	 */
	const database = async (credentials) => {
		const startedAt = now();
		const { errors, dbName } = checkDatabaseCredentials(/** @type {any} */ (credentials), policy);
		if (errors.length > 0 || dbName === null)
			return buildReport({ steps: [{ name: 'credentials', ok: false, code: 'invalid_credentials' }], startedAt, now: now() });
		const guarded = lookupWithFlag();
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
			lookup: /** @type {any} */ (guarded.lookup),
		});
		/** @type {ReturnType<typeof setTimeout> | undefined} */
		let timer;
		const run = async () => {
			try {
				await client.connect();
			} catch (error) {
				if (guarded.refused()) steps.push({ name: 'reachability', ok: false, code: 'address_refused' });
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
				warnings.push(...privileges.warnings);
				if (privileges.overPrivileged) {
					// a product connection must not reach other databases or the cluster: refuse, never write with it
					info.privilegeIssues = privileges.reasons;
					steps.push({ name: 'least_privilege', ok: false, code: 'over_privileged' });
					return;
				}
				steps.push({ name: 'least_privilege', ok: true });
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
			const headers = signV4({
				method,
				url,
				accessKeyId: c.accessKeyId,
				secretAccessKey: c.secretAccessKey,
				region: c.region,
				now: now(),
				headers: method === 'PUT' ? { 'content-type': 'text/plain' } : {},
				body,
			});
			const res = await request({ method, url, headers, ...(method === 'PUT' ? { body } : {}) });
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
		const res = await request({ method: 'GET', url, headers: { accept: 'application/json', ...headers } });
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
			const host = checkHost(String(c.host), policy);
			if (!host.ok) {
				const code = host.code === 'ssrf_blocked' ? 'address_refused' : 'invalid_host';
				resolve(buildReport({ steps: [{ name: 'reachability', ok: false, code }], startedAt, now: now() }));
				return;
			}
			// implicit TLS on 465 (or when stated); other ports STARTTLS — the same default as the descriptor
			const port = c.port ?? (c.secure === false ? 587 : 465);
			const secure = c.secure ?? port === 465;
			const guarded = lookupWithFlag();
			let settled = false;
			/** @param {CheckStep[]} steps */
			const finish = (steps) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				socket.destroy();
				resolve(buildReport({ steps, warnings: ['auth_not_checked'], startedAt, now: now() }));
			};
			const options = { host: host.host, port, lookup: /** @type {any} */ (guarded.lookup) };
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
						code: guarded.refused()
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

	return Object.freeze({ run, database, storage, httpGet, smtp, request });
};
/** @typedef {ReturnType<typeof createProbes>} Probes */
