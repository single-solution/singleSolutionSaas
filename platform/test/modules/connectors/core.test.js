import { describe, expect, it } from 'vitest';
import { createOutboundPolicy } from '@ss/net';
import { decideResolve, requiredKinds } from '../../../src/modules/connectors/core/access.js';
import { DESCRIPTOR_TTL_MS, aiEndpoint, descriptorOf } from '../../../src/modules/connectors/core/descriptor.js';
import { maskSecret, previewOf } from '../../../src/modules/connectors/core/mask.js';
import { checkDatabaseCredentials } from '../../../src/modules/connectors/core/mongo-uri.js';
import { analysePrivileges, buildReport, statusFromReport } from '../../../src/modules/connectors/core/report.js';
import {
	providersFor,
	urlRefusalCode,
	validateCredentials,
	validateLabel,
	validateWebsiteIds,
} from '../../../src/modules/connectors/core/schemas.js';

const DEV = createOutboundPolicy({ allowHosts: ['127.0.0.1', 'localhost', 'minio.dev'] });
const EMPTY_ALLOWLIST = createOutboundPolicy();
const WEB = 'web_0123456789abcdefghjkmnpq';

describe('mongo URIs', () => {
	it('requires public hosts, TLS, credentials, safe options and a usable database', () => {
		const ok = (/** @type {string} */ uri, /** @type {string | undefined} */ dbName = undefined, allowlist = EMPTY_ALLOWLIST) =>
			checkDatabaseCredentials({ uri, ...(dbName ? { dbName } : {}) }, allowlist).errors;
		expect(ok('mongodb+srv://u:p@cluster0.example.net/shop')).toEqual([]);
		expect(ok('mongodb://u:p@db.example.com:27017/shop?tls=true&authSource=admin&authMechanism=SCRAM-SHA-256')).toEqual([]);
		expect(ok('mongodb://u:p@db.example.com/shop?ssl=true')).toEqual([]);
		expect(ok('mongodb://u:p@db.example.com/shop')).toEqual([expect.objectContaining({ code: 'tls_required' })]);
		expect(ok('mongodb+srv://u:p@cluster0.example.net/shop?tls=false')).toEqual([
			expect.objectContaining({ code: 'tls_required' }),
		]);
		expect(ok('mongodb+srv://cluster0.example.net/shop')).toEqual([
			expect.objectContaining({ message: 'a database user and password are required' }),
		]);
		expect(ok('mongodb+srv://u:p@localhost/shop')[0]).toMatchObject({ code: 'address_refused' });
		expect(ok('mongodb://u:p@10.0.0.5/shop?tls=true')[0]).toMatchObject({ code: 'address_refused' });
		expect(ok('mongodb://u:p@169.254.169.254/shop?tls=true')[0]).toMatchObject({ code: 'address_refused' });
		expect(ok('mongodb://u:p@[::1]:27017/shop?tls=true')[0]).toMatchObject({ code: 'address_refused' });
		expect(ok('mongodb://u:p@bad host.example.com/shop?tls=true')[0]).toMatchObject({ code: 'invalid_host' });
		expect(ok('mongodb://u:p@bad_host/shop?tls=true')[0]).toMatchObject({ code: 'address_refused' });
		// a name answering with the metadata IP is refused at connect time (guardedLookup), see probes.test.js
		expect(ok('mongodb+srv://u:p@c.example.net/shop?tlsInsecure=true')[0]).toMatchObject({
			message: 'option tlsinsecure is not allowed',
		});
		for (const opt of [
			'tlsCAFile=/etc/passwd',
			'tlsCertificateKeyFile=/x',
			'tlsInsecure=true',
			'tlsAllowInvalidCertificates=true',
			'proxyHost=10.0.0.1',
			'authMechanismProperties=ENVIRONMENT:azure',
		])
			expect(ok(`mongodb+srv://u:p@c.example.net/shop?${opt}`), opt).toEqual([
				expect.objectContaining({ message: expect.stringContaining('is not allowed') }),
			]);
		expect(ok('mongodb+srv://u:p@c.example.net/shop?authMechanism=MONGODB-AWS')).toEqual([
			expect.objectContaining({ message: 'only SCRAM authentication is allowed' }),
		]);
		expect(ok('mongodb+srv://u:p@c.example.net/')).toEqual([expect.objectContaining({ path: '/credentials/dbName' })]);
		expect(ok('mongodb+srv://u:p@c.example.net/', 'shop')).toEqual([]);
		expect(ok('mongodb+srv://u:p@c.example.net/admin')).toEqual([
			expect.objectContaining({ message: 'admin, local and config cannot be used' }),
		]);
		expect(ok('mongodb+srv://u:p@c.example.net/', 'a.b')).toEqual([
			expect.objectContaining({ message: 'the database name is invalid' }),
		]);
		expect(ok('mongodb+srv://u:p@c.example.net/', 'é'.repeat(40))).toEqual([
			expect.objectContaining({ message: 'the database name is invalid' }),
		]);
		expect(ok('nope')).toEqual([expect.objectContaining({ path: '/credentials/uri' })]);
		expect(ok('mongodb://u:p@h.example.com:99999/db')).toEqual([expect.objectContaining({ path: '/credentials/uri' })]);
		// development allowlist: loopback without TLS or credentials
		expect(ok('mongodb://127.0.0.1:27017/shop', undefined, DEV)).toEqual([]);
	});
});

const SECRET = 'sk-test-0123456789abcdefghijklmnop';

describe('credential schemas', () => {
	const v = (
		/** @type {any} */ kind,
		/** @type {any} */ provider,
		/** @type {any} */ credentials,
		allowlist = EMPTY_ALLOWLIST,
	) => validateCredentials({ kind, provider, credentials }, allowlist);

	it('validates kinds and providers', () => {
		expect(v('nope', 'x', {})).toMatchObject({ ok: false, errors: [{ path: '/kind' }] });
		expect(v('ai', 'mistral', { apiKey: SECRET })).toMatchObject({ ok: false, errors: [{ path: '/provider' }] });
		expect(v('payments', 'Bad Slug', { key: 'x' })).toMatchObject({
			ok: false,
			errors: [{ path: '/provider', message: 'must be a provider slug' }],
		});
		expect(providersFor('database')).toEqual(['mongodb']);
		expect(providersFor('payments')).toBeNull();
		expect(providersFor('analytics')).toBeNull();
	});

	it('database', () => {
		expect(v('database', 'mongodb', { uri: 'mongodb+srv://u:p@c.example.net/shop' })).toMatchObject({
			ok: true,
			kind: 'database',
		});
		expect(v('database', 'mongodb', { uri: 'mongodb+srv://u:p@c.example.net/shop', extra: 1 })).toMatchObject({
			ok: false,
			errors: [{ path: '/credentials/extra', message: 'is not allowed' }],
		});
		expect(v('database', 'mongodb', { uri: 'mongodb://u:p@db.example.com/shop' }).ok).toBe(false);
	});

	it('storage', () => {
		const base = { region: 'eu-west-1', bucket: 'my-bucket', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: SECRET };
		expect(v('storage', 's3', base)).toMatchObject({ ok: true });
		expect(
			v('storage', 'r2', { ...base, endpoint: 'https://acc.r2.cloudflarestorage.com', prefix: 'media/', forcePathStyle: true })
				.ok,
		).toBe(true);
		expect(v('storage', 'r2', { ...base, endpoint: 'https://acc.r2.cloudflarestorage.com/path' })).toMatchObject({
			ok: false,
			errors: [{ message: 'must be an origin (no path or query)' }],
		});
		expect(v('storage', 'minio', { ...base, endpoint: 'http://minio.example.com' })).toMatchObject({
			ok: false,
			errors: [{ code: 'https_required' }],
		});
		expect(v('storage', 'minio', { ...base, endpoint: 'https://10.0.0.8' })).toMatchObject({
			ok: false,
			errors: [{ code: 'address_refused' }],
		});
		expect(v('storage', 'minio', { ...base, endpoint: 'https://a b.example' })).toMatchObject({
			ok: false,
			errors: [{ message: 'is not a valid URL' }],
		});
		expect(v('storage', 'minio', { ...base, endpoint: 'http://minio.dev:9000' }, DEV).ok).toBe(true);
		expect(v('storage', 'minio', { ...base, endpoint: 'https://minio.example.com:9000' })).toMatchObject({
			ok: false,
			errors: [{ code: 'port_refused', message: 'must use port 443 or 8443' }],
		});
		expect(v('storage', 'minio', { ...base, endpoint: 'https://minio.example.com/#x' })).toMatchObject({
			ok: false,
			errors: [{ code: 'invalid_url' }],
		});
		expect(v('storage', 'minio', { ...base, endpoint: 'https://169.254.169.254' })).toMatchObject({
			ok: false,
			errors: [{ code: 'address_refused' }],
		});
		expect(urlRefusalCode({ code: 'bad_url', reason: 'unsupported_scheme' })).toBe('https_required');
		expect(urlRefusalCode({ code: 'bad_url', reason: 'invalid_url' })).toBe('invalid_url');
		expect(urlRefusalCode({ code: 'ssrf_blocked', reason: 'metadata_address' })).toBe('address_refused');
		expect(v('storage', 's3', { ...base, prefix: '/abs/' }).ok).toBe(false);
		expect(v('storage', 's3', { ...base, bucket: 'A' }).ok).toBe(false);
	});

	it('ai', () => {
		expect(v('ai', 'openai', { apiKey: SECRET, model: 'gpt-x' }).ok).toBe(true);
		expect(v('ai', 'generic', { apiKey: SECRET })).toMatchObject({ ok: false, errors: [{ path: '/credentials/baseUrl' }] });
		expect(v('ai', 'generic', { apiKey: SECRET, baseUrl: 'https://llm.example.com/v1?x=1' })).toMatchObject({
			ok: false,
			errors: [{ message: 'must not carry a query' }],
		});
		expect(v('ai', 'generic', { apiKey: SECRET, baseUrl: 'https://llm.example.com/v1' }).ok).toBe(true);
		expect(v('ai', 'openai', { apiKey: 'has space' }).ok).toBe(false);
	});

	it('messaging', () => {
		const http = { baseUrl: 'https://msg.example.com/api', apiKey: SECRET };
		expect(
			v('messaging', 'generic-http', {
				...http,
				authScheme: 'header',
				authHeader: 'X-Key',
				headers: { 'X-Version': '2' },
				testPath: '/me',
			}).ok,
		).toBe(true);
		expect(v('messaging', 'generic-http', { ...http, authScheme: 'header', authHeader: 'Cookie' })).toMatchObject({
			ok: false,
			errors: [{ path: '/credentials/authHeader' }],
		});
		expect(v('messaging', 'generic-http', { ...http, headers: { Host: 'evil' } })).toMatchObject({
			ok: false,
			errors: [{ path: '/credentials/headers/Host' }],
		});
		expect(v('messaging', 'generic-http', { ...http, authHeader: 'X-Key', headers: { 'x-key': 'dup' } })).toMatchObject({
			ok: false,
			errors: [{ path: '/credentials/headers/x-key' }],
		});
		expect(v('messaging', 'generic-http', { ...http, testPath: '//evil.com' })).toMatchObject({
			ok: false,
			errors: [{ path: '/credentials/testPath' }],
		});
		expect(v('messaging', 'generic-http', { ...http, testPath: '/a/../b' }).ok).toBe(false);
		expect(v('messaging', 'generic-http', { ...http, baseUrl: 'http://msg.example.com' }).ok).toBe(false);
		const smtp = { host: 'smtp.example.com', port: 465, secure: true, username: 'u', password: 'p', from: 'shop@example.com' };
		expect(v('messaging', 'smtp', smtp).ok).toBe(true);
		expect(v('messaging', 'smtp', { ...smtp, host: '192.168.0.10' })).toMatchObject({
			ok: false,
			errors: [{ code: 'address_refused' }],
		});
		expect(v('messaging', 'smtp', { ...smtp, host: 'bad host' })).toMatchObject({
			ok: false,
			errors: [{ code: 'invalid_host' }],
		});
	});

	it('payments and analytics', () => {
		expect(v('payments', 'stripe', { secretKey: SECRET, webhookSecret: 'whsec_x' }).ok).toBe(true);
		expect(v('payments', 'stripe', {}).ok).toBe(false);
		expect(v('analytics', 'ga4', { ids: { measurementId: 'G-ABC123' } }).ok).toBe(true);
		expect(v('analytics', 'ga4', { ids: {} }).ok).toBe(false);
	});

	it('never echoes submitted values in errors', () => {
		const result = v('storage', 's3', {
			region: 'eu-west-1',
			bucket: 'b!',
			accessKeyId: 'AKIA',
			secretAccessKey: `${SECRET} space`,
		});
		expect(JSON.stringify(result)).not.toContain(SECRET);
	});

	it('website ids and labels', () => {
		expect(validateWebsiteIds(undefined)).toEqual({ ok: true, value: [] });
		expect(validateWebsiteIds([WEB])).toEqual({ ok: true, value: [WEB] });
		expect(validateWebsiteIds([WEB, WEB]).ok).toBe(false);
		expect(validateWebsiteIds(['x']).ok).toBe(false);
		expect(validateWebsiteIds('x').ok).toBe(false);
		expect(validateLabel('  Main DB ')).toEqual({ ok: true, value: 'Main DB' });
		expect(validateLabel('').ok).toBe(false);
		expect(validateLabel('a\nb').ok).toBe(false);
		expect(validateLabel(3).ok).toBe(false);
	});
});

describe('previews', () => {
	it('mask secrets', () => {
		expect(maskSecret(SECRET)).toBe('…mnop');
		expect(maskSecret('short')).toBe('••••');
		expect(maskSecret(undefined)).toBe('••••');
	});

	it('never contain secrets', () => {
		const db = previewOf('database', 'mongodb', { uri: 'mongodb+srv://admin:Sup3rS3cretPass@c.example.net/shop' });
		expect(db).toEqual({ scheme: 'mongodb+srv', hosts: ['c.example.net'], dbName: 'shop', authenticated: true });
		expect(JSON.stringify(db)).not.toMatch(/Sup3r|admin/);
		expect(previewOf('database', 'mongodb', { uri: 'mongodb://h.example.com:27017/', dbName: 'x' })).toMatchObject({
			hosts: ['h.example.com:27017'],
			dbName: 'x',
			authenticated: false,
		});
		expect(previewOf('database', 'mongodb', { uri: 'bad' })).toEqual({ scheme: null });
		expect(
			previewOf('storage', 's3', { region: 'r', bucket: 'b', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: SECRET }),
		).toEqual({
			endpoint: null,
			region: 'r',
			bucket: 'b',
			prefix: '',
			accessKeyId: '…MPLE',
		});
		expect(
			previewOf('storage', 'r2', {
				endpoint: 'https://x.example.com',
				region: 'auto',
				bucket: 'b',
				prefix: 'p/',
				accessKeyId: 'a',
				secretAccessKey: SECRET,
			}).endpoint,
		).toBe('https://x.example.com');
		expect(previewOf('ai', 'anthropic', { apiKey: SECRET })).toEqual({
			baseUrl: 'https://api.anthropic.com/v1',
			model: null,
			apiKey: '…mnop',
		});
		expect(previewOf('ai', 'generic', { apiKey: SECRET, baseUrl: 'https://llm.example.com/v1/', model: 'm' })).toEqual({
			baseUrl: 'https://llm.example.com/v1/',
			model: 'm',
			apiKey: '…mnop',
		});
		expect(
			previewOf('messaging', 'smtp', { host: 'smtp.example.com', username: 'mailer-user@example.com', password: SECRET }),
		).toEqual({
			host: 'smtp.example.com',
			port: 465,
			username: '….com',
			from: null,
		});
		expect(
			previewOf('messaging', 'smtp', { host: 'h.example.com', secure: false, username: 'u', password: 'p', from: 'a@b.c' })
				.port,
		).toBe(587);
		expect(previewOf('messaging', 'generic-http', { baseUrl: 'bad', apiKey: SECRET })).toEqual({
			baseUrl: null,
			apiKey: '…mnop',
		});
		expect(previewOf('payments', 'stripe', { secretKey: SECRET, a: 'x' })).toEqual({ fields: ['a', 'secretKey'] });
		expect(previewOf('analytics', 'ga4', { ids: { measurementId: 'G-ABC' } })).toEqual({ ids: { measurementId: '••••' } });
	});
});

describe('descriptors (F.9 shapes)', () => {
	it('builds every kind', () => {
		expect(DESCRIPTOR_TTL_MS).toBeLessThanOrEqual(15 * 60_000);
		expect(descriptorOf('database', 'mongodb', { uri: 'mongodb+srv://u:p@c/x' })).toEqual({ uri: 'mongodb+srv://u:p@c/x' });
		expect(descriptorOf('database', 'mongodb', { uri: 'u', dbName: 'd' })).toEqual({ uri: 'u', dbName: 'd' });
		expect(
			descriptorOf('storage', 'r2', {
				endpoint: 'https://x.example.com/',
				region: 'auto',
				bucket: 'b',
				accessKeyId: 'a',
				secretAccessKey: 's',
				forcePathStyle: false,
				prefix: 'p/',
			}),
		).toEqual({
			bucket: 'b',
			region: 'auto',
			accessKeyId: 'a',
			secretAccessKey: 's',
			endpoint: 'https://x.example.com',
			forcePathStyle: false,
			prefix: 'p/',
		});
		expect(descriptorOf('storage', 's3', { region: 'r', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' })).toEqual({
			bucket: 'b',
			region: 'r',
			accessKeyId: 'a',
			secretAccessKey: 's',
		});
		expect(descriptorOf('ai', 'openai', { apiKey: 'k', model: 'm' })).toEqual({
			provider: 'openai',
			baseUrl: 'https://api.openai.com/v1',
			apiKey: 'k',
			model: 'm',
			authScheme: 'bearer',
		});
		expect(descriptorOf('ai', 'anthropic', { apiKey: 'k' })).toEqual({
			provider: 'anthropic',
			baseUrl: 'https://api.anthropic.com/v1',
			apiKey: 'k',
			authScheme: 'header',
			authHeader: 'x-api-key',
			headers: { 'anthropic-version': '2023-06-01' },
		});
		expect(descriptorOf('ai', 'google', { apiKey: 'k' })).toMatchObject({ authScheme: 'header', authHeader: 'x-goog-api-key' });
		expect(aiEndpoint('generic', { baseUrl: 'https://llm.example.com/v1/' }).baseUrl).toBe('https://llm.example.com/v1');
		expect(
			descriptorOf('messaging', 'generic-http', {
				baseUrl: 'https://m.example.com/',
				apiKey: 'k',
				authScheme: 'header',
				authHeader: 'X-Key',
				headers: { 'X-V': '1' },
			}),
		).toEqual({
			provider: 'generic-http',
			baseUrl: 'https://m.example.com',
			apiKey: 'k',
			authScheme: 'header',
			authHeader: 'X-Key',
			headers: { 'X-V': '1' },
		});
		expect(descriptorOf('messaging', 'generic-http', { baseUrl: 'https://m.example.com', apiKey: 'k', headers: {} })).toEqual({
			provider: 'generic-http',
			baseUrl: 'https://m.example.com',
			apiKey: 'k',
			authScheme: 'bearer',
		});
		expect(
			descriptorOf('messaging', 'smtp', { host: 'smtp.example.com', username: 'u', password: 'p', from: 'a@b.c' }),
		).toEqual({
			provider: 'smtp',
			baseUrl: 'smtps://smtp.example.com:465',
			apiKey: 'p',
			username: 'u',
			from: 'a@b.c',
		});
		expect(
			descriptorOf('messaging', 'smtp', { host: 'h.example.com', secure: false, username: 'u', password: 'p' }).baseUrl,
		).toBe('smtp://h.example.com:587');
		expect(descriptorOf('payments', 'stripe', { secretKey: 's' })).toEqual({
			provider: 'stripe',
			credentials: { secretKey: 's' },
		});
		expect(descriptorOf('analytics', 'ga4', { ids: { m: 'G' } })).toEqual({ provider: 'ga4', ids: { m: 'G' } });
	});
});

describe('reports', () => {
	it('builds reports and statuses', () => {
		const ok = buildReport({ steps: [{ name: 'reachability', ok: true, status: 200 }], startedAt: 0, now: 10, info: { x: 1 } });
		expect(ok).toEqual({
			ok: true,
			checkedAt: new Date(10).toISOString(),
			durationMs: 10,
			checks: [{ name: 'reachability', ok: true, status: 200 }],
			warnings: [],
			info: { x: 1 },
		});
		expect(statusFromReport(ok)).toBe('connected');
		const failed = buildReport({
			steps: [{ name: 'auth', ok: false, code: 'auth_failed' }],
			warnings: ['a', 'a'],
			startedAt: 5,
			now: 1,
		});
		expect(statusFromReport(failed)).toBe('failing');
		expect(failed).toMatchObject({ durationMs: 0, warnings: ['a'] });
		expect(buildReport({ steps: [], startedAt: 0, now: 0, skipped: true })).toMatchObject({ ok: true, skipped: true });
	});

	it('analyses privileges', () => {
		const least = {
			authInfo: {
				authenticatedUsers: [{ user: 'app', db: 'admin' }],
				authenticatedUserRoles: [{ role: 'readWrite', db: 'shop' }, { role: 'dbAdmin', db: 'shop' }, { bad: 1 }],
				authenticatedUserPrivileges: [{ resource: { db: 'shop', collection: '' }, actions: ['find'] }],
			},
		};
		expect(analysePrivileges(least, 'shop')).toEqual({
			authenticated: true,
			roles: ['dbAdmin@shop', 'readWrite@shop'],
			overPrivileged: false,
			reasons: [],
			warnings: ['db_admin'],
		});
		/** @param {Array<{ role: string, db: string }>} roles */
		const withRoles = (roles) => analysePrivileges({ authInfo: { authenticatedUserRoles: roles } }, 'shop');
		expect(withRoles([{ role: 'dbOwner', db: 'shop' }])).toMatchObject({ overPrivileged: false, warnings: ['db_admin'] });
		expect(withRoles([{ role: 'userAdmin', db: 'shop' }])).toMatchObject({ overPrivileged: false, warnings: ['db_admin'] });
		expect(withRoles([{ role: 'root', db: 'admin' }])).toMatchObject({ overPrivileged: true, reasons: ['cluster_role'] });
		expect(withRoles([{ role: 'clusterAdmin', db: 'admin' }]).reasons).toEqual(['cluster_role']);
		for (const role of ['readAnyDatabase', 'readWriteAnyDatabase', 'userAdminAnyDatabase', 'dbAdminAnyDatabase'])
			expect(withRoles([{ role, db: 'admin' }]).reasons, role).toEqual(['any_database_role']);
		expect(withRoles([{ role: 'userAdmin', db: 'admin' }]).reasons).toEqual(['other_database']);
		expect(withRoles([{ role: 'read', db: 'admin' }]).reasons).toEqual(['other_database']);
		expect(
			withRoles([
				{ role: 'readWrite', db: 'shop' },
				{ role: 'read', db: 'other' },
			]),
		).toMatchObject({ overPrivileged: true, reasons: ['other_database'] });
		expect(
			analysePrivileges(
				{ authInfo: { authenticatedUsers: [{}], authenticatedUserRoles: [{ role: 'atlasAdmin', db: 'admin' }] } },
				'shop',
			).overPrivileged,
		).toBe(true);
		expect(
			analysePrivileges({ authInfo: { authenticatedUserRoles: [{ role: 'readWrite', db: 'admin' }] } }, 'shop').overPrivileged,
		).toBe(true);
		expect(
			analysePrivileges({ authInfo: { authenticatedUserPrivileges: [{ resource: { cluster: true }, actions: [] }] } }, 'shop')
				.overPrivileged,
		).toBe(true);
		expect(
			analysePrivileges({ authInfo: { authenticatedUserPrivileges: [{ resource: { anyResource: true } }] } }, 'shop')
				.overPrivileged,
		).toBe(true);
		expect(
			analysePrivileges({ authInfo: { authenticatedUserPrivileges: [{ resource: { db: '', collection: '' } }] } }, 'shop')
				.overPrivileged,
		).toBe(true);
		expect(analysePrivileges({ authInfo: { authenticatedUserPrivileges: [{}] } }, 'shop').overPrivileged).toBe(false);
		expect(
			analysePrivileges(
				{ authInfo: { authenticatedUserPrivileges: [{ resource: { db: 'other', collection: 'x' } }] } },
				'shop',
			).reasons,
		).toEqual(['other_database']);
		expect(analysePrivileges(null, 'shop')).toEqual({
			authenticated: false,
			roles: [],
			overPrivileged: false,
			reasons: [],
			warnings: [],
		});
	});
});

describe('resolve authorisation (pure)', () => {
	const manifest = {
		requires: { resources: ['database'] },
		elements: [{ key: 'a', requires: { resources: ['storage'] } }, { key: 'b' }],
	};
	it('collects required kinds', () => {
		expect([...requiredKinds(manifest)].sort()).toEqual(['database', 'storage']);
		expect(requiredKinds(null).size).toBe(0);
		expect(requiredKinds({ requires: { resources: [3] }, elements: 'x' }).size).toBe(0);
	});
	it('decides', () => {
		const subs = [
			{ subscriptionId: 'sub_1', appId: 'app_other', websiteId: WEB, status: 'active' },
			{ subscriptionId: 'sub_2', appId: 'app_a', websiteId: WEB, status: 'paused' },
		];
		expect(decideResolve({ appId: 'app_a', websiteId: WEB, kind: 'database', subscriptions: subs, manifest })).toEqual({
			ok: false,
			reason: 'no_subscription',
		});
		expect(decideResolve({ appId: 'app_a', websiteId: WEB, kind: 'database', subscriptions: 'x', manifest })).toEqual({
			ok: false,
			reason: 'no_subscription',
		});
		const active = [...subs, { subscriptionId: 'sub_3', appId: 'app_a', websiteId: WEB, status: 'active' }];
		expect(decideResolve({ appId: 'app_a', websiteId: WEB, kind: 'ai', subscriptions: active, manifest })).toEqual({
			ok: false,
			reason: 'not_required',
		});
		expect(decideResolve({ appId: 'app_a', websiteId: WEB, kind: 'storage', subscriptions: active, manifest })).toEqual({
			ok: true,
			subscriptionId: 'sub_3',
		});
		expect(
			decideResolve({
				appId: 'app_a',
				websiteId: WEB,
				kind: 'database',
				subscriptions: [{ subscriptionId: 's', appId: 'app_a', websiteId: 'web_other', status: 'active' }],
				manifest,
			}),
		).toEqual({ ok: false, reason: 'no_subscription' });
	});
});
