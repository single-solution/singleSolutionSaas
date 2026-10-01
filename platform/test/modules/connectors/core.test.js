import { describe, expect, it } from 'vitest';
import { signHeaders as kitSignHeaders } from '../../../../packages/app-kit/src/connectors/sigv4.js';
import { decideResolve, requiredKinds } from '../../../src/modules/connectors/core/access.js';
import { DESCRIPTOR_TTL_MS, aiEndpoint, descriptorOf } from '../../../src/modules/connectors/core/descriptor.js';
import { maskSecret, previewOf } from '../../../src/modules/connectors/core/mask.js';
import { checkDatabaseCredentials, parseMongoUri } from '../../../src/modules/connectors/core/mongo-uri.js';
import {
	EMPTY_ALLOWLIST,
	allowlistFor,
	checkHost,
	checkUrl,
	isAllowlisted,
	isBlockedAddress,
	normaliseHost,
} from '../../../src/modules/connectors/core/netguard.js';
import { analysePrivileges, buildReport, statusFromReport } from '../../../src/modules/connectors/core/report.js';
import {
	providersFor,
	validateCredentials,
	validateLabel,
	validateWebsiteIds,
} from '../../../src/modules/connectors/core/schemas.js';
import { objectUrl, signHeaders, uriEncode } from '../../../src/modules/connectors/core/sigv4.js';

const DEV = allowlistFor('test', ['127.0.0.1', 'localhost', 'minio.dev']);
const WEB = 'web_0123456789abcdefghjkmnpq';

describe('netguard', () => {
	it.each([
		'127.0.0.1',
		'127.255.0.9',
		'10.1.2.3',
		'172.16.0.1',
		'172.31.255.255',
		'192.168.1.1',
		'169.254.169.254',
		'100.100.100.200',
		'0.0.0.0',
		'224.0.0.1',
		'255.255.255.255',
		'198.18.0.1',
		'::1',
		'::',
		'fe80::1',
		'fd00:ec2::254',
		'fc00::1',
		'::ffff:127.0.0.1',
		'::ffff:8.8.8.8',
		'0:0:0:0:0:ffff:7f00:1',
		'64:ff9b::a00:1',
		'2002:7f00:1::',
		'2001:db8::1',
		'ff02::1',
		'[::1]',
		'fe80::1%eth0',
		'not-an-ip',
	])('blocks %s', (ip) => expect(isBlockedAddress(ip)).toBe(true));

	it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '[2a00:1450:4009:81f::200e]'])(
		'allows public %s',
		(ip) => expect(isBlockedAddress(ip)).toBe(false),
	);

	it('checks host names', () => {
		expect(checkHost('api.openai.com', EMPTY_ALLOWLIST)).toEqual({
			ok: true,
			host: 'api.openai.com',
			ip: false,
			allowlisted: false,
		});
		expect(checkHost('API.Example.COM.', EMPTY_ALLOWLIST)).toMatchObject({ ok: true, host: 'api.example.com' });
		for (const host of [
			'localhost',
			'db.localhost',
			'printer.local',
			'metadata.google.internal',
			'x.home.arpa',
			'2130706433.1',
			'0x7f.0.0.1',
		])
			expect(checkHost(host, EMPTY_ALLOWLIST)).toEqual({ ok: false, code: 'address_refused' });
		for (const host of ['', 'single', 'bad_host.com', '-x.com', 'a..b'])
			expect(checkHost(host, EMPTY_ALLOWLIST)).toEqual({ ok: false, code: 'invalid_host' });
		expect(checkHost(/** @type {any} */ (5), EMPTY_ALLOWLIST)).toEqual({ ok: false, code: 'invalid_host' });
		expect(checkHost('127.0.0.1', EMPTY_ALLOWLIST)).toEqual({ ok: false, code: 'address_refused' });
		expect(checkHost('8.8.8.8', EMPTY_ALLOWLIST)).toEqual({ ok: true, host: '8.8.8.8', ip: true, allowlisted: false });
		expect(checkHost('127.0.0.1', DEV)).toEqual({ ok: true, host: '127.0.0.1', ip: true, allowlisted: true });
		expect(checkHost('LOCALHOST', DEV)).toMatchObject({ ok: true, allowlisted: true });
		expect(normaliseHost('[::1]')).toBe('::1');
	});

	it('honours the allowlist only in development and test', () => {
		expect(isAllowlisted(allowlistFor('production', ['127.0.0.1']), '127.0.0.1')).toBe(false);
		expect(isAllowlisted(allowlistFor('preview', ['127.0.0.1']), '127.0.0.1')).toBe(false);
		expect(isAllowlisted(allowlistFor('development', ['127.0.0.1']), '127.0.0.1')).toBe(true);
	});

	it('checks URLs', () => {
		expect(checkUrl('https://api.example.com/v1', EMPTY_ALLOWLIST)).toMatchObject({ ok: true, allowlisted: false });
		expect(checkUrl('http://api.example.com', EMPTY_ALLOWLIST)).toEqual({ ok: false, code: 'https_required' });
		expect(checkUrl('ftp://api.example.com', EMPTY_ALLOWLIST)).toEqual({ ok: false, code: 'https_required' });
		expect(checkUrl('https://169.254.169.254/latest/meta-data', EMPTY_ALLOWLIST)).toEqual({
			ok: false,
			code: 'address_refused',
		});
		expect(checkUrl('https://[::ffff:a9fe:a9fe]/', EMPTY_ALLOWLIST)).toEqual({ ok: false, code: 'address_refused' });
		expect(checkUrl('https://0x7f.1/', EMPTY_ALLOWLIST)).toEqual({ ok: false, code: 'address_refused' });
		expect(checkUrl('https://2130706433/', EMPTY_ALLOWLIST)).toEqual({ ok: false, code: 'address_refused' });
		expect(checkUrl('https://user:pw@api.example.com', EMPTY_ALLOWLIST)).toEqual({ ok: false, code: 'invalid_url' });
		expect(checkUrl('https://api.example.com/#x', EMPTY_ALLOWLIST)).toEqual({ ok: false, code: 'invalid_url' });
		expect(checkUrl('not a url', EMPTY_ALLOWLIST)).toEqual({ ok: false, code: 'invalid_url' });
		expect(checkUrl('http://127.0.0.1:9000', DEV)).toMatchObject({ ok: true, allowlisted: true });
		expect(checkUrl('http://localhost:9000', EMPTY_ALLOWLIST)).toEqual({ ok: false, code: 'address_refused' });
	});
});

describe('mongo URIs', () => {
	it('parses standard and SRV strings', () => {
		const parsed = parseMongoUri(
			'mongodb://app%40x:p%40ss@a.example.com:27017,[2606:4700::1]:27018/shop?tls=true&replicaSet=rs0',
		);
		expect(parsed).toMatchObject({
			ok: true,
			value: {
				scheme: 'mongodb',
				username: 'app@x',
				hasPassword: true,
				hosts: [
					{ host: 'a.example.com', port: 27017 },
					{ host: '[2606:4700::1]', port: 27018 },
				],
				dbName: 'shop',
			},
		});
		expect(parseMongoUri('mongodb+srv://cluster0.example.net/')).toMatchObject({
			ok: true,
			value: { scheme: 'mongodb+srv', username: null, dbName: null },
		});
		for (const bad of [
			'postgres://x',
			'mongodb://',
			'mongodb://u:p@',
			'mongodb://:p@h.example.com/db',
			'mongodb://u:p/x@h.example.com/db',
			'mongodb://u%zz:p@h.example.com/db',
			'mongodb://h.example.com:0/db',
			'mongodb://h.example.com:99999/db',
			'mongodb://h.example.com:abc/db',
			'mongodb+srv://a.example.com,b.example.com/db',
			'mongodb+srv://a.example.com:27017/db',
			'mongodb://h.example.com/%zz',
		])
			expect(parseMongoUri(bad).ok, bad).toBe(false);
	});

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
		expect(ok('mongodb://u:p@bad_host/shop?tls=true')[0]).toMatchObject({ code: 'invalid_host' });
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
		});
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
		expect(analysePrivileges(null, 'shop')).toEqual({ authenticated: false, roles: [], overPrivileged: false });
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

describe('SigV4', () => {
	it('matches the app-kit implementation', () => {
		const params = {
			method: 'PUT',
			url: 'https://bucket.s3.eu-west-1.amazonaws.com/media/a%20b.txt?x-id=PutObject',
			credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
			region: 'eu-west-1',
			now: Date.parse('2026-10-01T10:00:00Z'),
			headers: { 'content-type': 'text/plain' },
			body: 'hello',
		};
		expect(signHeaders(params)).toEqual(kitSignHeaders(params));
		const withToken = { ...params, credentials: { ...params.credentials, sessionToken: 'tok' } };
		expect(signHeaders(withToken)).toEqual(kitSignHeaders(withToken));
		expect(signHeaders(withToken)['x-amz-security-token']).toBe('tok');
	});

	it('builds object URLs', () => {
		expect(uriEncode("a b/c!'()*", true)).toBe('a%20b/c%21%27%28%29%2A');
		expect(objectUrl({ region: 'eu-west-1', bucket: 'b' }, 'p/k.txt')).toBe('https://b.s3.eu-west-1.amazonaws.com/p/k.txt');
		expect(objectUrl({ region: 'eu-west-1', bucket: 'b', forcePathStyle: true }, 'k')).toBe(
			'https://s3.eu-west-1.amazonaws.com/b/k',
		);
		expect(objectUrl({ endpoint: 'https://acc.r2.example.com', region: 'auto', bucket: 'b' }, 'k')).toBe(
			'https://acc.r2.example.com/b/k',
		);
		expect(objectUrl({ endpoint: 'https://minio.example.com', region: 'auto', bucket: 'b', forcePathStyle: false }, 'k')).toBe(
			'https://b.minio.example.com/k',
		);
	});
});
