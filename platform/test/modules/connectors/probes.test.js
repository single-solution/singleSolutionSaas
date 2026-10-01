import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createGuardedLookup, createOutbound, REFUSED_CODE } from '../../../src/modules/connectors/adapters/outbound.js';
import { DB_TIMEOUTS, createProbes } from '../../../src/modules/connectors/adapters/probes.js';
import { EMPTY_ALLOWLIST, allowlistFor } from '../../../src/modules/connectors/core/netguard.js';
import { startFakeApi, startFakeS3, startFakeSmtp } from './fakes/servers.js';

const DEV = allowlistFor('test', ['127.0.0.1']);
const KEY = 'sk-live-abcdefghijklmnopqrstuvwxyz012345';
let n = 0;
const randomBytes = (/** @type {number} */ size) => new Uint8Array(size).fill((n += 1) % 256);

/**
 * Fake DNS: maps names to addresses.
 * @param {Record<string, string[]>} table
 */
const fakeDns = (table) =>
	/** @type {any} */ (
		(/** @type {string} */ hostname, /** @type {any} */ _options, /** @type {Function} */ cb) => {
			const addresses = table[hostname];
			if (!addresses) return cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
			return cb(
				null,
				addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
			);
		}
	);

describe('guarded lookup', () => {
	/** @param {any} lookup @param {string} host @param {any} options */
	const run = (lookup, host, options) =>
		new Promise((resolve) => {
			lookup(host, options, (/** @type {any} */ error, /** @type {any} */ address, /** @type {any} */ family) =>
				resolve({ error: error?.code ?? null, address, family }),
			);
		});

	it('refuses private, loopback and metadata addresses after resolution', async () => {
		let refusals = 0;
		const dns = fakeDns({
			'rebind.example.com': ['93.184.216.34', '10.0.0.7'],
			'meta.example.com': ['169.254.169.254'],
			'v6.example.com': ['fd00:ec2::254'],
			'ok.example.com': ['93.184.216.34'],
			'empty.example.com': [],
			'dev.example.com': ['127.0.0.1'],
		});
		const lookup = createGuardedLookup({ allowlist: EMPTY_ALLOWLIST, lookup: dns, onRefused: () => (refusals += 1) });
		expect(await run(lookup, 'rebind.example.com', { all: true })).toMatchObject({ error: REFUSED_CODE });
		expect(await run(lookup, 'meta.example.com', {})).toMatchObject({ error: REFUSED_CODE });
		expect(await run(lookup, 'v6.example.com', 6)).toMatchObject({ error: REFUSED_CODE });
		expect(await run(lookup, 'empty.example.com', {})).toMatchObject({ error: REFUSED_CODE });
		expect(refusals).toBe(4);
		expect(await run(lookup, 'missing.example.com', {})).toMatchObject({ error: 'ENOTFOUND' });
		expect(await run(lookup, 'ok.example.com', {})).toEqual({ error: null, address: '93.184.216.34', family: 4 });
		expect(await run(lookup, 'ok.example.com', { all: true })).toEqual({
			error: null,
			address: [{ address: '93.184.216.34', family: 4 }],
			family: undefined,
		});
		const viaCallback = await new Promise((resolve) =>
			/** @type {any} */ (lookup)('ok.example.com', (/** @type {any} */ e, /** @type {any} */ a) => resolve(a)),
		);
		expect(viaCallback).toBe('93.184.216.34');
		const allowHost = createGuardedLookup({ allowlist: allowlistFor('test', ['dev.example.com']), lookup: dns });
		expect(await run(allowHost, 'dev.example.com', {})).toMatchObject({ error: null, address: '127.0.0.1' });
		const allowIp = createGuardedLookup({ allowlist: DEV, lookup: dns });
		expect(await run(allowIp, 'dev.example.com', null)).toMatchObject({ error: null, address: '127.0.0.1' });
		// the default resolver is the system one
		const system = createGuardedLookup({ allowlist: EMPTY_ALLOWLIST });
		expect(await run(system, 'localhost', {})).toMatchObject({ error: REFUSED_CODE });
	});
});

describe('outbound requests', () => {
	/** @type {Awaited<ReturnType<typeof startFakeApi>>} */
	let api;
	beforeAll(async () => {
		api = await startFakeApi({ header: 'authorization', value: `Bearer ${KEY}` });
	});
	afterAll(async () => api.close());

	it('enforces https and public destinations', async () => {
		const strict = createOutbound({ allowlist: EMPTY_ALLOWLIST });
		expect(await strict.request({ method: 'GET', url: `${api.baseUrl}/models` })).toEqual({
			ok: false,
			code: 'address_refused',
		});
		expect(await strict.request({ method: 'GET', url: 'http://api.example.com/models' })).toEqual({
			ok: false,
			code: 'https_required',
		});
		expect(await strict.request({ method: 'GET', url: 'https://169.254.169.254/latest/meta-data/' })).toEqual({
			ok: false,
			code: 'address_refused',
		});
		expect(await strict.request({ method: 'GET', url: 'https://[fd00:ec2::254]/' })).toEqual({
			ok: false,
			code: 'address_refused',
		});
		expect(await strict.request({ method: 'GET', url: 'https://10.0.0.1/' })).toEqual({ ok: false, code: 'address_refused' });
		expect(await strict.request({ method: 'GET', url: 'gopher://x.example.com' })).toEqual({
			ok: false,
			code: 'https_required',
		});
		expect(await strict.request({ method: 'GET', url: '::' })).toEqual({ ok: false, code: 'invalid_url' });
		// a public-looking name that resolves to a private address never gets a connection
		const rebinding = createOutbound({
			allowlist: EMPTY_ALLOWLIST,
			lookup: fakeDns({ 'api.attacker.example': ['127.0.0.1'] }),
		});
		const before = api.requests.length;
		expect(await rebinding.request({ method: 'GET', url: 'https://api.attacker.example/models' })).toEqual({
			ok: false,
			code: 'address_refused',
		});
		expect(api.requests.length).toBe(before);
		const unknown = createOutbound({ allowlist: EMPTY_ALLOWLIST, lookup: fakeDns({}) });
		expect(await unknown.request({ method: 'GET', url: 'https://nowhere.example/' })).toEqual({
			ok: false,
			code: 'unreachable',
		});
	});

	it('performs allowlisted requests with caps and deadlines', async () => {
		const dev = createOutbound({ allowlist: DEV });
		const ok = await dev.request({
			method: 'POST',
			url: `${api.baseUrl}/models`,
			headers: { authorization: `Bearer ${KEY}` },
			body: '{}',
		});
		expect(ok).toMatchObject({ ok: true, status: 200 });
		expect(ok.ok && ok.body.toString()).toBe('{"data":[]}');
		const buf = await dev.request({ method: 'POST', url: `${api.baseUrl}/x`, body: Buffer.from('a') });
		expect(buf).toMatchObject({ ok: true, status: 401 });
		const slow = await startFakeApi({ header: 'x', value: 'y', delayMs: 500 });
		expect(await dev.request({ method: 'GET', url: `${slow.baseUrl}/`, timeoutMs: 50 })).toEqual({
			ok: false,
			code: 'timeout',
		});
		await slow.close();
		const big = await startFakeApi({ header: 'x', value: 'y', bigBody: true });
		expect(await dev.request({ method: 'GET', url: `${big.baseUrl}/`, maxBytes: 1024 })).toEqual({
			ok: false,
			code: 'response_too_large',
		});
		await big.close();
		expect(await dev.request({ method: 'GET', url: 'http://127.0.0.1:1/' })).toEqual({ ok: false, code: 'unreachable' });
		const tls = createOutbound({ allowlist: DEV });
		expect(await tls.request({ method: 'GET', url: `${api.baseUrl.replace('http:', 'https:')}/` })).toMatchObject({
			ok: false,
		});
	});
});

describe('probes: storage, http, smtp, skipped kinds', () => {
	const now = () => Date.parse('2026-10-01T10:00:00Z');
	const probes = createProbes({ allowlist: DEV, now, randomBytes, httpTimeoutMs: 2_000 });
	const creds = (/** @type {string} */ endpoint) => ({
		endpoint,
		region: 'auto',
		bucket: 'shop-media',
		accessKeyId: 'AKIAFAKEKEY123456',
		secretAccessKey: 'super-secret-storage-key-0123456789',
		prefix: 'site/',
	});

	it('storage: put/get/delete a probe object', async () => {
		const s3 = await startFakeS3({ accessKeyId: 'AKIAFAKEKEY123456' });
		const report = await probes.run('storage', 'r2', creds(s3.endpoint));
		expect(report).toMatchObject({ ok: true });
		expect(report.checks.map((c) => c.name)).toEqual(['reachability', 'put_object', 'get_object', 'delete_object']);
		expect(s3.objects.size).toBe(0);
		expect(s3.requests.map((r) => r.method)).toEqual(['PUT', 'GET', 'DELETE']);
		expect(s3.requests[0]?.url).toMatch(/^\/shop-media\/site\/ss_probe\/[0-9a-f]{16}\.txt$/);
		expect(s3.requests[0]?.authorization).toMatch(
			/^AWS4-HMAC-SHA256 Credential=AKIAFAKEKEY123456\/20261001\/auto\/s3\/aws4_request/,
		);
		expect(JSON.stringify(report)).not.toContain('super-secret');
		await s3.close();
	});

	it.each([
		['auth', 'auth_failed'],
		['permission', 'permission_denied'],
		['bucket', 'bucket_not_found'],
	])('storage: %s failures', async (deny, code) => {
		const s3 = await startFakeS3({ accessKeyId: 'AKIAFAKEKEY123456', deny: /** @type {any} */ (deny) });
		const report = await probes.storage(creds(s3.endpoint));
		expect(report.ok).toBe(false);
		expect(report.checks).toContainEqual(expect.objectContaining({ name: 'put_object', ok: false, code }));
		await s3.close();
	});

	it('storage: wrong key id, corrupt read, unreachable, refused', async () => {
		const s3 = await startFakeS3({ accessKeyId: 'OTHER' });
		expect((await probes.storage(creds(s3.endpoint))).checks[1]).toMatchObject({ code: 'auth_failed', status: 403 });
		await s3.close();
		const corrupt = await startFakeS3({ accessKeyId: 'AKIAFAKEKEY123456', corrupt: true });
		expect((await probes.storage(creds(corrupt.endpoint))).checks).toContainEqual({
			name: 'get_object',
			ok: false,
			code: 'content_mismatch',
		});
		await corrupt.close();
		expect((await probes.storage(creds('http://127.0.0.1:1'))).checks).toEqual([
			{ name: 'reachability', ok: false, code: 'unreachable' },
		]);
		const strict = createProbes({ allowlist: EMPTY_ALLOWLIST, now, randomBytes });
		expect((await strict.storage({ ...creds('https://10.1.1.1'), endpoint: 'https://10.1.1.1' })).checks[0]).toMatchObject({
			code: 'address_refused',
		});
		expect((await strict.storage({ ...creds(''), endpoint: undefined, region: 'eu-west-1' })).checks[0]?.name).toBe(
			'reachability',
		);
	});

	it('ai and messaging over http', async () => {
		const openai = await startFakeApi({ header: 'authorization', value: `Bearer ${KEY}` });
		expect(await probes.run('ai', 'openai', { baseUrl: openai.baseUrl, apiKey: KEY })).toMatchObject({
			ok: true,
			checks: [
				{ name: 'reachability', ok: true },
				{ name: 'auth', ok: true, status: 200 },
			],
		});
		expect(openai.requests.at(-1)?.url).toBe('/v1/models');
		const bad = await probes.run('ai', 'generic', { baseUrl: openai.baseUrl, apiKey: 'wrong-key' });
		expect(bad.checks[1]).toEqual({ name: 'auth', ok: false, code: 'auth_failed', status: 401 });
		expect(JSON.stringify(bad)).not.toContain('echoed');
		await openai.close();
		const anthropic = await startFakeApi({ header: 'x-api-key', value: KEY });
		expect((await probes.run('ai', 'anthropic', { baseUrl: anthropic.baseUrl, apiKey: KEY })).ok).toBe(true);
		expect(anthropic.requests.at(-1)?.headers['anthropic-version']).toBe('2023-06-01');
		await anthropic.close();
		const google = await startFakeApi({ header: 'x-goog-api-key', value: KEY, status: 500 });
		expect((await probes.run('ai', 'google', { baseUrl: google.baseUrl, apiKey: KEY })).checks[1]).toMatchObject({
			code: 'unexpected_status',
			status: 500,
		});
		await google.close();
		const msg = await startFakeApi({ header: 'x-key', value: KEY });
		expect(
			await probes.run('messaging', 'generic-http', {
				baseUrl: `${msg.baseUrl}/`,
				apiKey: KEY,
				authScheme: 'header',
				authHeader: 'X-Key',
				headers: { 'X-Version': '2' },
				testPath: '/me',
			}),
		).toMatchObject({ ok: true });
		expect(msg.requests.at(-1)).toMatchObject({ url: '/v1/me', headers: { 'x-version': '2' } });
		expect(
			(await probes.run('messaging', 'generic-http', { baseUrl: msg.baseUrl, apiKey: KEY, authScheme: 'header' })).ok,
		).toBe(false);
		expect((await probes.run('messaging', 'generic-http', { baseUrl: msg.baseUrl, apiKey: KEY })).ok).toBe(false);
		await msg.close();
		const strict = createProbes({ allowlist: EMPTY_ALLOWLIST, now, randomBytes });
		expect((await strict.run('ai', 'openai', { apiKey: KEY, baseUrl: 'https://169.254.169.254/v1' })).checks).toEqual([
			{ name: 'reachability', ok: false, code: 'address_refused' },
		]);
	});

	it('smtp reachability and greeting', { timeout: 15_000 }, async () => {
		const smtp = await startFakeSmtp();
		const report = await probes.run('messaging', 'smtp', {
			host: '127.0.0.1',
			port: smtp.port,
			secure: false,
			username: 'u',
			password: 'p',
		});
		expect(report).toMatchObject({ ok: true, warnings: ['auth_not_checked'] });
		await smtp.close();
		const odd = await startFakeSmtp({ greeting: '554 go away\r\n' });
		expect((await probes.smtp({ host: '127.0.0.1', port: odd.port, secure: false })).checks[1]).toEqual({
			name: 'greeting',
			ok: false,
			code: 'unexpected_greeting',
		});
		// TLS against a plain server fails the handshake
		const plain = await startFakeSmtp({ greeting: '' });
		const tls = await probes.smtp({ host: '127.0.0.1', port: plain.port, secure: true });
		expect(tls.checks[0]).toMatchObject({ name: 'reachability', ok: false });
		await plain.close();
		const silent = createProbes({ allowlist: DEV, now, randomBytes, httpTimeoutMs: 100 });
		const quiet = await startFakeSmtp({ greeting: '' });
		expect((await silent.smtp({ host: '127.0.0.1', port: quiet.port, secure: false })).checks[0]).toMatchObject({
			code: 'timeout',
		});
		await quiet.close();
		expect((await probes.smtp({ host: '127.0.0.1', port: 1, secure: false })).checks[0]).toMatchObject({ code: 'unreachable' });
		const strict = createProbes({
			allowlist: EMPTY_ALLOWLIST,
			now,
			randomBytes,
			lookup: fakeDns({ 'smtp.attacker.example': ['10.9.9.9'] }),
		});
		expect((await strict.smtp({ host: '192.168.1.1' })).checks[0]).toMatchObject({ code: 'address_refused' });
		expect((await strict.smtp({ host: 'smtp.attacker.example', port: 587, secure: false })).checks[0]).toMatchObject({
			code: 'address_refused',
		});
	});

	it('payments and analytics are stored only', async () => {
		expect(await probes.run('payments', 'stripe', { secretKey: 'x' })).toMatchObject({
			ok: true,
			skipped: true,
			checks: [],
			warnings: ['not_checked'],
		});
		expect((await probes.run('analytics', 'ga4', { ids: { m: 'G-1' } })).skipped).toBe(true);
	});
});

describe('probes: database (MongoMemoryReplSet, development allowlist)', () => {
	/** @type {MongoMemoryReplSet} */
	let replSet;
	/** @type {string} */
	let hostPort;
	beforeAll(async () => {
		replSet = await MongoMemoryReplSet.create({
			replSet: {
				count: 1,
				storageEngine: 'wiredTiger',
				auth: {
					enable: true,
					customRootName: 'root',
					customRootPwd: 'root-password-123',
					extraUsers: [
						{ createUser: 'app', pwd: 'app-password-456', roles: [{ role: 'readWrite', db: 'shop' }], database: 'shop' },
						{ createUser: 'reader', pwd: 'reader-password-789', roles: [{ role: 'read', db: 'shop' }], database: 'shop' },
					],
				},
			},
		});
		hostPort = new URL(replSet.getUri().replace('mongodb://', 'http://')).host;
	}, 120_000);
	afterAll(async () => replSet?.stop());

	const now = () => Date.now();
	/** @type {Array<import('mongodb').MongoClientOptions>} */
	const seen = [];
	const probes = createProbes({
		allowlist: DEV,
		now,
		randomBytes,
		connectMongo: (uri, options) => {
			seen.push(options);
			return new MongoClient(uri, options);
		},
	});
	const uri = (/** @type {string} */ user, /** @type {string} */ pw, db = 'shop', source = 'shop') =>
		`mongodb://${user}:${pw}@${hostPort}/${db}?replicaSet=testset&authSource=${source}`;

	it('reports reachability, auth, least privilege and index rights; drops the probe', async () => {
		const report = await probes.run('database', 'mongodb', { uri: uri('app', 'app-password-456') });
		expect(report).toMatchObject({ ok: true, warnings: [], info: { roles: ['readWrite@shop'], authenticated: true } });
		expect(report.checks.map((c) => `${c.name}:${c.ok}`)).toEqual([
			'reachability:true',
			'auth:true',
			'create_collection:true',
			'create_index:true',
			'drop_collection:true',
		]);
		expect(seen[0]).toMatchObject({ ...DB_TIMEOUTS, maxPoolSize: 1 });
		expect(typeof seen[0]?.lookup).toBe('function');
		const admin = new MongoClient(replSet.getUri(), { auth: { username: 'root', password: 'root-password-123' } });
		const names = (await admin.db('shop').listCollections().toArray()).map((c) => c.name);
		expect(names.filter((name) => name.startsWith('ss_probe_'))).toEqual([]);
		await admin.close();
		expect(JSON.stringify(report)).not.toContain('app-password');
	}, 60_000);

	it('flags over-privileged users and missing rights', async () => {
		const root = await probes.database({ uri: uri('root', 'root-password-123', 'shop', 'admin') });
		expect(root).toMatchObject({ ok: true, warnings: ['over_privileged'] });
		const reader = await probes.database({ uri: uri('reader', 'reader-password-789') });
		expect(reader.ok).toBe(false);
		expect(reader.checks).toContainEqual({ name: 'create_collection', ok: false, code: 'permission_denied' });
	}, 60_000);

	it('reports authentication failures, unreachable and refused hosts', async () => {
		const wrong = await probes.database({ uri: uri('app', 'not-the-password') });
		expect(wrong.checks).toEqual([
			{ name: 'reachability', ok: true },
			{ name: 'auth', ok: false, code: 'auth_failed' },
		]);
		expect(JSON.stringify(wrong)).not.toContain('not-the-password');
		const fast = createProbes({
			allowlist: DEV,
			now,
			randomBytes,
			connectMongo: (u, o) => new MongoClient(u, { ...o, serverSelectionTimeoutMS: 300 }),
		});
		expect((await fast.database({ uri: 'mongodb://127.0.0.1:1/shop' })).checks).toEqual([
			{ name: 'reachability', ok: false, code: 'unreachable' },
		]);
		const rebind = createProbes({
			allowlist: EMPTY_ALLOWLIST,
			now,
			randomBytes,
			lookup: fakeDns({ 'db.attacker.example': ['127.0.0.1'] }),
			connectMongo: (u, o) => new MongoClient(u, { ...o, serverSelectionTimeoutMS: 1_000 }),
		});
		expect((await rebind.database({ uri: 'mongodb://u:p@db.attacker.example:27017/shop?tls=true' })).checks).toEqual([
			{ name: 'reachability', ok: false, code: 'address_refused' },
		]);
		expect((await rebind.database({ uri: 'mongodb://u:p@10.0.0.1/shop?tls=true' })).checks).toEqual([
			{ name: 'credentials', ok: false, code: 'invalid_credentials' },
		]);
	}, 60_000);
});
