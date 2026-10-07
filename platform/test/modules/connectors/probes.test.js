import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createOutboundPolicy } from '@ss/net';
import { DB_TIMEOUTS, createProbes, outboundCode } from '../../../src/modules/connectors/adapters/probes.js';
import { startFakeApi, startFakeS3, startFakeSmtp } from './fakes/servers.js';

/** @param {ReadonlyArray<string>} [allowHosts] @param {import('@ss/net').Resolver} [resolve] */
const policyOf = (allowHosts = [], resolve) =>
	createOutboundPolicy({ allowHosts, maxRedirects: 0, maxBytes: 64 * 1024, ...(resolve ? { resolve } : {}) });
const DEV = policyOf(['127.0.0.1']);
const STRICT = policyOf();
const KEY = 'sk-live-abcdefghijklmnopqrstuvwxyz012345';
let n = 0;
const randomBytes = (/** @type {number} */ size) => new Uint8Array(size).fill((n += 1) % 256);

/**
 * Fake DNS for the outbound policy: maps names to addresses (unknown names fail with ENOTFOUND).
 * @param {Record<string, string[]>} table
 * @returns {import('@ss/net').Resolver}
 */
const fakeDns = (table) => async (hostname) => {
	const addresses = table[hostname];
	if (!addresses) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
	return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

describe('outbound requests (@ss/net policy, end to end)', () => {
	/** @type {Awaited<ReturnType<typeof startFakeApi>>} */
	let api;
	beforeAll(async () => {
		api = await startFakeApi({ header: 'authorization', value: `Bearer ${KEY}` });
	});
	afterAll(async () => api.close());
	const now = () => Date.now();

	it('enforces https, allowed ports and public destinations before connecting', async () => {
		const strict = createProbes({ policy: STRICT, now, randomBytes });
		/** @param {string} url */
		const code = async (url) => {
			const res = await strict.request({ method: 'GET', url });
			return res.ok ? res.status : res.code;
		};
		expect(await code(`${api.baseUrl}/models`)).toBe('address_refused');
		expect(await code('http://api.example.com/models')).toBe('https_required');
		expect(await code('https://169.254.169.254/latest/meta-data/')).toBe('address_refused');
		expect(await code('https://[fd00:ec2::254]/')).toBe('address_refused');
		expect(await code('https://[::ffff:a9fe:a9fe]/')).toBe('address_refused');
		expect(await code('https://0x7f.1/')).toBe('address_refused');
		expect(await code('https://10.0.0.1/')).toBe('address_refused');
		expect(await code('https://api.example.com:9200/')).toBe('port_refused');
		expect(await code('gopher://x.example.com')).toBe('https_required');
		expect(await code('https://user:pw@api.example.com/')).toBe('invalid_url');
		expect(await code('::')).toBe('invalid_url');
		expect(api.requests).toHaveLength(0);
	});

	it('vets every DNS answer at connect time (rebinding, metadata, private)', async () => {
		const dns = fakeDns({
			'rebind.example.com': ['93.184.216.34', '10.0.0.7'],
			'meta.example.com': ['169.254.169.254'],
			'v6.example.com': ['fd00:ec2::254'],
			'api.attacker.example': ['127.0.0.1'],
			'empty.example.com': [],
		});
		const probes = createProbes({ policy: policyOf([], dns), now, randomBytes });
		for (const host of ['rebind.example.com', 'meta.example.com', 'v6.example.com', 'api.attacker.example'])
			expect(await probes.request({ method: 'GET', url: `https://${host}/models` }), host).toEqual({
				ok: false,
				code: 'address_refused',
			});
		expect(await probes.request({ method: 'GET', url: 'https://empty.example.com/' })).toEqual({
			ok: false,
			code: 'unreachable',
		});
		expect(await probes.request({ method: 'GET', url: 'https://nowhere.example/' })).toEqual({
			ok: false,
			code: 'unreachable',
		});
		expect(api.requests).toHaveLength(0);
		// an allowlisted development name may resolve to loopback
		const port = new URL(api.baseUrl).port;
		const dev = createProbes({
			policy: policyOf(['dev.example.com'], fakeDns({ 'dev.example.com': ['127.0.0.1'] })),
			now,
			randomBytes,
		});
		expect(await dev.request({ method: 'GET', url: `http://dev.example.com:${port}/models` })).toMatchObject({
			ok: true,
			status: 401,
		});
	});

	it('performs allowlisted requests with caps, deadlines and no redirects', async () => {
		const dev = createProbes({ policy: DEV, now, randomBytes, httpTimeoutMs: 2_000 });
		const ok = await dev.request({
			method: 'POST',
			url: `${api.baseUrl}/models`,
			headers: { authorization: `Bearer ${KEY}` },
			body: '{}',
		});
		expect(ok).toMatchObject({ ok: true, status: 200 });
		expect(ok.ok && ok.body.toString()).toBe('{"data":[]}');
		const slow = await startFakeApi({ header: 'x', value: 'y', delayMs: 500 });
		const impatient = createProbes({ policy: DEV, now, randomBytes, httpTimeoutMs: 50 });
		expect(await impatient.request({ method: 'GET', url: `${slow.baseUrl}/` })).toEqual({ ok: false, code: 'timeout' });
		await slow.close();
		const big = await startFakeApi({ header: 'x', value: 'y', bigBody: true });
		expect(await dev.request({ method: 'GET', url: `${big.baseUrl}/` })).toEqual({ ok: false, code: 'response_too_large' });
		await big.close();
		const moved = await startFakeApi({ header: 'x', value: 'y', redirectTo: 'https://169.254.169.254/latest' });
		expect(await dev.request({ method: 'GET', url: `${moved.baseUrl}/` })).toMatchObject({ ok: true, status: 302 });
		expect(moved.requests).toHaveLength(1);
		await moved.close();
		expect(await dev.request({ method: 'GET', url: 'http://127.0.0.1:1/' })).toEqual({ ok: false, code: 'unreachable' });
		expect(await dev.request({ method: 'GET', url: `${api.baseUrl.replace('http:', 'https:')}/` })).toMatchObject({
			ok: false,
		});
		expect(outboundCode(new Error('x'))).toBe('unreachable');
	});
});

describe('probes: storage, http, smtp, skipped kinds', () => {
	const now = () => Date.parse('2026-10-01T10:00:00Z');
	const probes = createProbes({ policy: DEV, now, randomBytes, httpTimeoutMs: 2_000 });
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
		const strict = createProbes({ policy: STRICT, now, randomBytes });
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
		const strict = createProbes({ policy: STRICT, now, randomBytes });
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
		const silent = createProbes({ policy: DEV, now, randomBytes, httpTimeoutMs: 100 });
		const quiet = await startFakeSmtp({ greeting: '' });
		expect((await silent.smtp({ host: '127.0.0.1', port: quiet.port, secure: false })).checks[0]).toMatchObject({
			code: 'timeout',
		});
		await quiet.close();
		expect((await probes.smtp({ host: '127.0.0.1', port: 1, secure: false })).checks[0]).toMatchObject({ code: 'unreachable' });
		const strict = createProbes({
			policy: policyOf([], fakeDns({ 'smtp.attacker.example': ['10.9.9.9'] })),
			now,
			randomBytes,
		});
		expect((await strict.smtp({ host: '192.168.1.1' })).checks[0]).toMatchObject({ code: 'address_refused' });
		expect((await strict.smtp({ host: 'smtp.attacker.example', port: 587, secure: false })).checks[0]).toMatchObject({
			code: 'address_refused',
		});
	});

	it('payments are stored only', async () => {
		expect(await probes.run('payments', 'stripe', { secretKey: 'x' })).toMatchObject({
			ok: true,
			skipped: true,
			checks: [],
			warnings: ['not_checked'],
		});
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
						{ createUser: 'owner', pwd: 'owner-password-012', roles: [{ role: 'dbOwner', db: 'shop' }], database: 'shop' },
						{
							createUser: 'wide',
							pwd: 'wide-password-345',
							roles: [
								{ role: 'readWrite', db: 'shop' },
								{ role: 'read', db: 'other' },
							],
							database: 'shop',
						},
						{
							createUser: 'useradmin',
							pwd: 'useradmin-password-678',
							roles: [
								{ role: 'readWrite', db: 'shop' },
								{ role: 'userAdminAnyDatabase', db: 'admin' },
							],
							database: 'admin',
						},
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
		policy: DEV,
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
			'least_privilege:true',
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

	it('refuses over-privileged users, warns about db owners and flags missing rights', async () => {
		const root = await probes.database({ uri: uri('root', 'root-password-123', 'shop', 'admin') });
		expect(root).toMatchObject({ ok: false, info: { privilegeIssues: expect.arrayContaining(['cluster_role']) } });
		expect(root.checks.at(-1)).toEqual({ name: 'least_privilege', ok: false, code: 'over_privileged' });
		expect(root.checks.map((c) => c.name)).not.toContain('create_collection');
		const wide = await probes.database({ uri: uri('wide', 'wide-password-345') });
		expect(wide).toMatchObject({ ok: false, info: { privilegeIssues: ['other_database'] } });
		const userAdmin = await probes.database({ uri: uri('useradmin', 'useradmin-password-678', 'shop', 'admin') });
		expect(userAdmin.ok).toBe(false);
		expect(userAdmin.info?.privilegeIssues).toContain('any_database_role');
		const owner = await probes.database({ uri: uri('owner', 'owner-password-012') });
		expect(owner).toMatchObject({ ok: true, warnings: ['db_admin'], info: { roles: ['dbOwner@shop'] } });
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
			policy: DEV,
			now,
			randomBytes,
			connectMongo: (u, o) => new MongoClient(u, { ...o, serverSelectionTimeoutMS: 300 }),
		});
		expect((await fast.database({ uri: 'mongodb://127.0.0.1:1/shop' })).checks).toEqual([
			{ name: 'reachability', ok: false, code: 'unreachable' },
		]);
		const rebind = createProbes({
			policy: policyOf([], fakeDns({ 'db.attacker.example': ['127.0.0.1'], 'db.meta.example': ['169.254.169.254'] })),
			now,
			randomBytes,
			connectMongo: (u, o) => new MongoClient(u, { ...o, serverSelectionTimeoutMS: 1_000 }),
		});
		expect((await rebind.database({ uri: 'mongodb://u:p@db.attacker.example:27017/shop?tls=true' })).checks).toEqual([
			{ name: 'reachability', ok: false, code: 'address_refused' },
		]);
		expect((await rebind.database({ uri: 'mongodb://u:p@db.meta.example:27017/shop?tls=true' })).checks).toEqual([
			{ name: 'reachability', ok: false, code: 'address_refused' },
		]);
		expect((await rebind.database({ uri: 'mongodb://u:p@10.0.0.1/shop?tls=true' })).checks).toEqual([
			{ name: 'credentials', ok: false, code: 'invalid_credentials' },
		]);
	}, 60_000);
});
