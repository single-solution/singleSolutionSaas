import { describe, expect, it } from 'vitest';
import { generateSigningKey } from '@ss/protocol';
import {
	ENV_VARS,
	deriveSecret,
	deriveSigningKey,
	loadConfig,
	parseKeks,
	parseSigningKeys,
	parseSmtpUrl,
} from '../src/infra/config.js';
import { isPlatformError } from '../src/infra/errors.js';
import { b64, testEnv } from './helpers.js';

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
const problemsOf = (env) => {
	try {
		loadConfig(env);
	} catch (error) {
		if (isPlatformError(error, 'config_invalid')) return /** @type {string[]} */ (error.details?.problems);
		throw error;
	}
	return [];
};

describe('loadConfig', () => {
	it('loads a complete environment', async () => {
		const config = loadConfig(await testEnv());
		expect(config.env).toBe('test');
		expect(config.portalUrl).toBe('https://portal.test');
		expect(config.portalOrigin).toBe('https://portal.test');
		expect(config.cookieSecure).toBe(true);
		expect(config.mongo).toEqual({
			uri: 'mongodb://127.0.0.1:27017/ss_portal_test',
			dbName: 'ss_portal_test',
			maxPoolSize: 5,
		});
		expect(config.signingKeys.map((k) => k.kid)).toEqual(['portal-2026-10', 'portal-2026-04']);
		expect(config.keks.map((k) => k.id)).toEqual(['kek-2', 'kek-1']);
		expect(config.sessionSecret.length).toBe(32);
		expect(config.problemBaseUri).toBe('https://portal.test/problems/');
		expect(config.logLevel).toBe('info');
		expect(config.trustProxyHeaders).toBe(false);
		expect(config.maxBodyBytes).toBe(1024 * 1024);
		expect(config.cronDeadlineMs).toBe(50_000);
		expect(config.sessions.staff).toEqual({ idleMs: 30 * 60_000, absoluteMs: 12 * 3_600_000 });
		expect(config.version).toBe('dev');
		expect(Object.isFrozen(config)).toBe(true);
	});

	it('reports every missing variable at once, without values', () => {
		const problems = problemsOf({});
		for (const name of [
			'PORTAL_URL',
			'MONGODB_URI',
			'PORTAL_SIGNING_KEYS',
			'SECRETS_KEK',
			'SESSION_SECRET',
			'WEBSITE_KEY_PEPPER',
			'CRON_SECRET',
		]) {
			expect(problems).toContain(`${name} is required`);
		}
		try {
			loadConfig({});
		} catch (error) {
			expect(String(/** @type {Error} */ (error).message)).toMatch(/^Invalid Portal configuration/);
		}
	});

	it('rejects invalid values', async () => {
		const env = await testEnv({
			PORTAL_ENV: 'staging',
			PORTAL_URL: 'https://portal.test/?x=1',
			MONGODB_URI: 'postgres://x',
			MONGODB_DB: 'bad name!',
			MONGODB_MAX_POOL_SIZE: '0',
			PORTAL_SIGNING_KEYS: '[{"kty":"OKP"}]',
			SECRETS_KEK: 'k1:short',
			SESSION_SECRET: 'short',
			WEBSITE_KEY_PEPPER: 'short',
			CRON_SECRET: 'short',
			PROBLEM_BASE_URI: 'not a uri',
			LOG_LEVEL: 'loud',
			TRUST_PROXY_HEADERS: 'yes',
			MAX_BODY_BYTES: '12',
			CRON_DEADLINE_MS: 'soon',
			STAFF_SESSION_IDLE_MINUTES: '-1',
		});
		const problems = problemsOf(env);
		expect(problems).toEqual(
			expect.arrayContaining([
				expect.stringContaining('PORTAL_ENV'),
				expect.stringContaining('PORTAL_URL'),
				expect.stringContaining('MONGODB_URI'),
				expect.stringContaining('MONGODB_DB'),
				expect.stringContaining('MONGODB_MAX_POOL_SIZE'),
				expect.stringContaining('PORTAL_SIGNING_KEYS'),
				expect.stringContaining('SECRETS_KEK'),
				expect.stringContaining('SESSION_SECRET'),
				expect.stringContaining('WEBSITE_KEY_PEPPER'),
				expect.stringContaining('CRON_SECRET'),
				expect.stringContaining('PROBLEM_BASE_URI'),
				expect.stringContaining('LOG_LEVEL'),
				expect.stringContaining('TRUST_PROXY_HEADERS'),
				expect.stringContaining('MAX_BODY_BYTES'),
				expect.stringContaining('CRON_DEADLINE_MS'),
				expect.stringContaining('STAFF_SESSION_IDLE_MINUTES'),
			]),
		);
	});

	it('requires https outside local development', async () => {
		expect(problemsOf(await testEnv({ PORTAL_URL: 'http://portal.test' }))).toEqual([expect.stringContaining('https')]);
		expect(problemsOf(await testEnv({ PORTAL_URL: 'http://localhost:4000', NODE_ENV: 'production' }))).toEqual([
			expect.stringContaining('https'),
		]);
		const local = loadConfig(await testEnv({ PORTAL_URL: 'http://localhost:4000/', NODE_ENV: 'development' }));
		expect(local.env).toBe('development');
		expect(local.portalUrl).toBe('http://localhost:4000');
		expect(local.cookieSecure).toBe(false);
		const prod = loadConfig(await testEnv({ NODE_ENV: 'production' }));
		expect(prod.isProduction).toBe(true);
		expect(problemsOf(await testEnv({ PORTAL_URL: 'not a url' }))).toEqual([expect.stringContaining('PORTAL_URL')]);
	});

	it('derives the database name and honours optional settings', async () => {
		const config = loadConfig(
			await testEnv({
				MONGODB_URI: 'mongodb+srv://user:pass@cluster.example.net/?retryWrites=true',
				PROBLEM_BASE_URI: 'https://errors.example.dev/portal',
				LOG_LEVEL: 'debug',
				TRUST_PROXY_HEADERS: 'true',
				MAX_BODY_BYTES: '2048',
				CRON_DEADLINE_MS: '20000',
				PORTAL_VERSION: '1.2.3',
				PORTAL_ENV: 'preview',
				MERCHANT_SESSION_IDLE_MINUTES: '60',
				MERCHANT_SESSION_MAX_HOURS: '2',
			}),
		);
		expect(config.mongo.dbName).toBe('ss_portal');
		expect(config.problemBaseUri).toBe('https://errors.example.dev/portal/');
		expect(config.trustProxyHeaders).toBe(true);
		expect(config.maxBodyBytes).toBe(2048);
		expect(config.version).toBe('1.2.3');
		expect(config.env).toBe('preview');
		expect(config.sessions.merchant).toEqual({ idleMs: 3_600_000, absoluteMs: 7_200_000 });
		expect(loadConfig(await testEnv({ MONGODB_DB: 'explicit' })).mongo.dbName).toBe('explicit');
	});

	it('refuses an idle timeout above the absolute lifetime and equal secrets', async () => {
		expect(problemsOf(await testEnv({ STAFF_SESSION_IDLE_MINUTES: '1000', STAFF_SESSION_MAX_HOURS: '1' }))).toEqual([
			expect.stringContaining('STAFF session idle timeout'),
		]);
		expect(problemsOf(await testEnv({ WEBSITE_KEY_PEPPER: b64(32, 3) }))).toEqual([expect.stringContaining('must differ')]);
	});

	it('accepts raw-text secrets of sufficient length', async () => {
		const config = loadConfig(await testEnv({ SESSION_SECRET: 'x!'.repeat(20), WEBSITE_KEY_PEPPER: 'y#'.repeat(20) }));
		expect(config.sessionSecret.toString()).toBe('x!'.repeat(20));
	});

	it('documents every variable', () => {
		const names = ENV_VARS.map(([name]) => name);
		expect(names).toContain('PORTAL_SIGNING_KEYS');
		expect(new Set(names).size).toBe(names.length);
	});
});

describe('website-key signer, idempotency secret, outbound allowlist and mail', () => {
	it('loads the dedicated website-key signer; requires it in production; derives one elsewhere', async () => {
		const config = loadConfig(await testEnv());
		expect(config.websiteKeySigningKeys.map((k) => k.kid)).toEqual(['website-2026-10']);
		expect(config.websiteKeySigningDerived).toBe(false);
		expect(problemsOf(await testEnv({ WEBSITE_KEY_SIGNING_KEYS: undefined, PORTAL_ENV: 'production' }))).toEqual([
			'WEBSITE_KEY_SIGNING_KEYS is required in production',
		]);
		const dev = loadConfig(await testEnv({ WEBSITE_KEY_SIGNING_KEYS: undefined }));
		expect(dev.websiteKeySigningDerived).toBe(true);
		expect(dev.websiteKeySigningKeys[0]?.kid).toMatch(/^website-dev-/);
		// deterministic per SESSION_SECRET, distinct from it otherwise
		const again = loadConfig(await testEnv({ WEBSITE_KEY_SIGNING_KEYS: undefined }));
		expect(again.websiteKeySigningKeys[0]?.x).toBe(dev.websiteKeySigningKeys[0]?.x);
		expect(deriveSigningKey(Buffer.alloc(32, 1), 'a').x).not.toBe(deriveSigningKey(Buffer.alloc(32, 2), 'a').x);
		expect(problemsOf(await testEnv({ WEBSITE_KEY_SIGNING_KEYS: '[1]' }))).toEqual([
			expect.stringContaining('WEBSITE_KEY_SIGNING_KEYS must be a JSON array'),
		]);
		// never the Portal's keys (by kid or by key)
		const env = await testEnv();
		const [portal] = JSON.parse(/** @type {string} */ (env.PORTAL_SIGNING_KEYS));
		expect(problemsOf({ ...env, WEBSITE_KEY_SIGNING_KEYS: JSON.stringify([{ ...portal, kid: 'other' }]) })).toEqual([
			expect.stringContaining('distinct'),
		]);
		const { privateJwk: sameKid } = await generateSigningKey({ kid: portal.kid });
		expect(problemsOf({ ...env, WEBSITE_KEY_SIGNING_KEYS: JSON.stringify([sameKid]) })).toEqual([
			expect.stringContaining('distinct'),
		]);
	});

	it('uses IDEMPOTENCY_SECRET or derives the fingerprint key from SESSION_SECRET', async () => {
		const derived = loadConfig(await testEnv());
		expect(derived.idempotencySecret.equals(deriveSecret(derived.sessionSecret, 'idempotency'))).toBe(true);
		expect(derived.idempotencySecret.equals(derived.sessionSecret)).toBe(false);
		const explicit = loadConfig(await testEnv({ IDEMPOTENCY_SECRET: b64(32, 8) }));
		expect(explicit.idempotencySecret.equals(Buffer.alloc(32, 8))).toBe(true);
		expect(problemsOf(await testEnv({ IDEMPOTENCY_SECRET: 'short' }))).toEqual([
			'IDEMPOTENCY_SECRET must be at least 32 bytes',
		]);
	});

	it('exposes the outbound development allowlist except in production', async () => {
		expect(loadConfig(await testEnv()).outbound.allowHosts).toEqual([]);
		const dev = loadConfig(await testEnv({ OUTBOUND_DEV_ALLOW_HOSTS: ' Localhost, 127.0.0.1 ,[::1],, ' }));
		expect(dev.outbound.allowHosts).toEqual(['localhost', '127.0.0.1', '[::1]']);
		expect(
			loadConfig(await testEnv({ OUTBOUND_DEV_ALLOW_HOSTS: 'localhost', PORTAL_ENV: 'production' })).outbound.allowHosts,
		).toEqual([]);
		expect(problemsOf(await testEnv({ OUTBOUND_DEV_ALLOW_HOSTS: 'http://x/y' }))).toEqual([
			expect.stringContaining('OUTBOUND_DEV_ALLOW_HOSTS'),
		]);
	});

	it('parses the platform SMTP URL and sender', async () => {
		const config = loadConfig(
			await testEnv({
				PLATFORM_SMTP_URL: 'smtps://mailer%40x:p%40ss@smtp.example.com',
				PLATFORM_MAIL_FROM: 'Portal <no-reply@example.com>',
			}),
		);
		expect(config.mail).toEqual({
			smtp: { host: 'smtp.example.com', port: 465, secure: true, user: 'mailer@x', pass: 'p@ss' },
			from: 'Portal <no-reply@example.com>',
		});
		expect(loadConfig(await testEnv()).mail).toEqual({ smtp: null, from: null });
		expect(parseSmtpUrl('smtp://smtp.example.com')).toEqual({
			host: 'smtp.example.com',
			port: 587,
			secure: false,
			user: null,
			pass: null,
		});
		expect(parseSmtpUrl('smtp://[::1]:2525')).toMatchObject({ host: '::1', port: 2525 });
		for (const bad of ['nope', 'http://smtp.example.com', 'smtp://h/path', 'smtp://h?x=1', 'smtp://u:%zz@h'])
			expect(parseSmtpUrl(bad)).toBeNull();
		expect(problemsOf(await testEnv({ PLATFORM_SMTP_URL: 'smtp://smtp.example.com' }))).toEqual([
			'PLATFORM_MAIL_FROM is required with PLATFORM_SMTP_URL',
		]);
		expect(problemsOf(await testEnv({ PLATFORM_SMTP_URL: 'ftp://x', PLATFORM_MAIL_FROM: 'bad\r\nBcc: x@y.z' }))).toEqual([
			expect.stringContaining('PLATFORM_SMTP_URL'),
			expect.stringContaining('PLATFORM_MAIL_FROM'),
		]);
		expect(loadConfig(await testEnv({ PLATFORM_MAIL_FROM: 'ops@example.com' })).mail.from).toBe('ops@example.com');
	});
});

describe('parseKeks', () => {
	it('parses lists and bare keys', () => {
		expect(parseKeks(`a:${b64(32)}, b:${b64(32, 9)}`)?.map((k) => k.id)).toEqual(['a', 'b']);
		expect(parseKeks(b64(32))?.[0]?.id).toBe('k1');
		expect(parseKeks(Buffer.alloc(32, 5).toString('base64url'))?.[0]?.key.length).toBe(32);
	});
	it('rejects malformed lists', () => {
		expect(parseKeks('')).toBeNull();
		expect(parseKeks(`${b64(32)},${b64(32)}`)).toBeNull(); // bare keys only alone
		expect(parseKeks(`a:${b64(32)},a:${b64(32)}`)).toBeNull();
		expect(parseKeks(`a:${b64(16)}`)).toBeNull();
		expect(parseKeks(`bad id:${b64(32)}`)).toBeNull();
		expect(parseKeks('a:***')).toBeNull();
	});
});

describe('parseSigningKeys', () => {
	it('rejects non-arrays, public keys, invalid JWKs and duplicate kids', async () => {
		const env = await testEnv();
		const [first] = JSON.parse(/** @type {string} */ (env.PORTAL_SIGNING_KEYS));
		expect(parseSigningKeys('nope')).toBeNull();
		expect(parseSigningKeys('[]')).toBeNull();
		expect(parseSigningKeys(JSON.stringify([{ ...first, d: undefined }]))).toBeNull();
		expect(parseSigningKeys(JSON.stringify([{ ...first, crv: 'P-256' }]))).toBeNull();
		expect(parseSigningKeys(JSON.stringify([first, first]))).toBeNull();
		expect(parseSigningKeys(JSON.stringify([first]))?.[0]?.d).toBe(first.d);
	});
});
