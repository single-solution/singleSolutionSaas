import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENV_VARS, buildConfig, deriveSecret, loadConfig, loadEnv } from '../src/infra/config.js';
import { isPlatformError } from '../src/infra/errors.js';
import { originFromHeaders, requestOrigin, withOrigin } from '../src/infra/request-scope.js';
import { createSystemStore, generateSecrets, secretsOf, testSystemState } from '../src/infra/system.js';
import { startMongo, testEnv, testSystem } from './helpers.js';

/** @type {Awaited<ReturnType<typeof startMongo>>} */
let mongo;
beforeAll(async () => {
	mongo = await startMongo();
});
afterAll(async () => {
	await mongo.stop();
});

/** @param {() => unknown} fn @returns {string[]} */
const problemsOf = (fn) => {
	try {
		fn();
	} catch (error) {
		if (isPlatformError(error, 'config_invalid')) return /** @type {string[]} */ (error.details?.problems);
		throw error;
	}
	return [];
};

const PROD_STORAGE = {
	NODE_ENV: 'production',
	STORAGE_ENDPOINT: 'https://r2.example.net',
	STORAGE_BUCKET: 'ss-assets',
	STORAGE_ACCESS_KEY_ID: 'AK',
	STORAGE_SECRET_ACCESS_KEY: 'SK',
};

describe('loadEnv: only the database and the storage; everything else is fixed', () => {
	it('loads a minimal environment with the fixed values', async () => {
		const env = loadEnv(await testEnv());
		expect(env).toMatchObject({
			env: 'test',
			isProduction: false,
			mongo: { uri: 'mongodb://127.0.0.1:27017/ss_portal_test', dbName: 'ss_portal_test', maxPoolSize: 5 },
			logLevel: 'info',
			maxBodyBytes: 1024 * 1024,
			delivery: { storage: null },
		});
		expect(env.sessions.staff).toEqual({ idleMs: 30 * 60_000, absoluteMs: 12 * 3_600_000 });
		expect(env.sessions.merchant).toEqual({ idleMs: 1440 * 60_000, absoluteMs: 336 * 3_600_000 });
		expect(Object.isFrozen(env)).toBe(true);
		// former tuning variables are ignored
		const tuned = loadEnv(
			await testEnv({ MAX_BODY_BYTES: '12', DELIVERY_BUDGET_KB: '1', MONGODB_DB: 'other', APP_VERSION: 'x' }),
		);
		expect(tuned).toMatchObject({ maxBodyBytes: 1024 * 1024, delivery: { storage: null } });
		expect(tuned.mongo.dbName).toBe('ss_portal_test');
	});

	it('derives the environment from NODE_ENV only (production unless development or test)', async () => {
		expect(loadEnv(await testEnv({ NODE_ENV: 'development' }))).toMatchObject({ env: 'development', logLevel: 'debug' });
		expect(loadEnv({ ...(await testEnv()), ...PROD_STORAGE })).toMatchObject({ env: 'production', logLevel: 'info' });
		expect(loadEnv({ ...(await testEnv()), ...PROD_STORAGE, NODE_ENV: 'staging' }).env).toBe('production');
	});

	it('requires only the database (storage is optional); reports every problem without values', () => {
		expect(problemsOf(() => loadEnv({ NODE_ENV: 'production' }))).toEqual(['MONGODB_URI is required']);
		expect(
			loadEnv({ NODE_ENV: 'production', MONGODB_URI: 'mongodb+srv://u:p@cluster.example.net/ss_portal' }).delivery.storage,
		).toBeNull();
		const problems = problemsOf(() =>
			loadEnv({ NODE_ENV: 'test', MONGODB_URI: 'postgres://x', LOG_LEVEL: 'loud', OUTBOUND_DEV_ALLOW_HOSTS: 'http://x/y' }),
		);
		for (const name of ['MONGODB_URI', 'LOG_LEVEL', 'OUTBOUND_DEV_ALLOW_HOSTS'])
			expect(problems).toEqual(expect.arrayContaining([expect.stringContaining(name)]));
		expect(problemsOf(() => loadEnv({ NODE_ENV: 'test', MONGODB_URI: 'mongodb://h/bad%20name!' }))).toEqual([
			expect.stringContaining('invalid database'),
		]);
	});

	it('derives the database name; the dev allowlist is ignored in production', async () => {
		const env = loadEnv(
			await testEnv({
				MONGODB_URI: 'mongodb+srv://user:pass@cluster.example.net/?retryWrites=true',
				OUTBOUND_DEV_ALLOW_HOSTS: ' Localhost, 127.0.0.1 ,[::1],, ',
			}),
		);
		expect(env.mongo.dbName).toBe('ss_portal');
		expect(env.outbound.allowHosts).toEqual(['localhost', '127.0.0.1', '[::1]']);
		expect(
			loadEnv({ ...(await testEnv()), ...PROD_STORAGE, OUTBOUND_DEV_ALLOW_HOSTS: 'localhost' }).outbound.allowHosts,
		).toEqual([]);
	});

	it('documents every variable, and only the database is required', () => {
		const names = ENV_VARS.map(([name]) => name);
		expect(new Set(names).size).toBe(names.length);
		expect(ENV_VARS.filter(([, required]) => required).map(([name]) => name)).toEqual(['MONGODB_URI']);
		for (const gone of [
			'PUBLIC_URL',
			'PORTAL_URL',
			'ADMIN_SECRET',
			'SIGNING_KEYS',
			'ENCRYPTION_KEYS',
			'SESSION_SECRET',
			'KEY_PEPPER',
			'SMTP_URL',
			'PREVIEW_URL',
			'TRUST_PROXY_HEADERS',
			'MAX_BODY_BYTES',
			'DELIVERY_BUDGET_KB',
			'OPERATION_DEADLINE_MS',
			'MONGODB_MAX_POOL_SIZE',
			'APP_VERSION',
			'STAFF_SESSION_IDLE_MINUTES',
		])
			expect(names).not.toContain(gone);
	});
});

describe('buildConfig: environment + system state', () => {
	it('joins the generated secrets and the recorded settings', async () => {
		const config = loadConfig(await testEnv(), await testSystem(), { baseUrl: 'https://portal.test' });
		expect(config.portalUrl).toBe('https://portal.test');
		expect(config.portalOrigin).toBe('https://portal.test');
		expect(config.cookieSecure).toBe(true);
		expect(config.problemBaseUri).toBe('https://portal.test/problems/');
		expect(config.signingKeys.map((k) => k.kid)).toEqual(['portal-2026-10', 'portal-2026-04']);
		expect(config.websiteKeySigningKeys.map((k) => k.kid)).toEqual(['website-2026-10']);
		expect(config.keks.map((k) => k.id)).toEqual(['kek-2', 'kek-1']);
		expect(config.mail).toEqual({ smtp: null, from: null });
	});

	it('the Portal URL is the current request origin (no stored setting)', async () => {
		const config = loadConfig(await testEnv(), await testSystem());
		expect(config.portalUrl).toBe('http://localhost');
		expect(config.cookieSecure).toBe(false);
		withOrigin('https://portal.example.com', () => {
			expect(config.portalUrl).toBe('https://portal.example.com');
			expect(config.portalOrigin).toBe('https://portal.example.com');
			expect(config.cookieSecure).toBe(true);
		});
		/** @param {Record<string, string>} headers */
		const at = (headers, url = 'http://internal:3000/v1/x') => requestOrigin(new Request(url, { headers }));
		expect(at({ host: 'Portal.Example.com', 'x-forwarded-proto': 'https' })).toBe('https://portal.example.com');
		expect(at({ host: 'portal.example.com:443', 'x-forwarded-proto': 'http,https' })).toBe('https://portal.example.com');
		expect(at({ host: 'localhost:4000' })).toBe('http://localhost:4000');
		expect(at({ host: 'bad host/x' })).toBe('http://internal:3000');
		expect(at({}, 'https://portal.test/v1/x')).toBe('https://portal.test');
		expect(originFromHeaders(new Headers({ host: 'a.test', 'x-forwarded-proto': 'gopher' }), 'https://b.test')).toBe(
			'https://a.test',
		);
	});

	it('validates the mail sender; tests may replace fixed values', async () => {
		const env = loadEnv(await testEnv());
		const system = await testSystem();
		expect(buildConfig(env, system, { overrides: { maxBodyBytes: 64 } }).maxBodyBytes).toBe(64);
		const mail = { host: 'smtp.example.com', port: 465, secure: true, user: 'u', pass: 'p', from: 'bad\r\nBcc: x@y.z' };
		expect(problemsOf(() => buildConfig(env, { ...system, mail }))).toEqual([expect.stringContaining('sender')]);
		const ok = buildConfig(env, { ...system, mail: { ...mail, from: 'Portal <no-reply@example.com>' } });
		expect(ok.mail).toEqual({
			smtp: { host: 'smtp.example.com', port: 465, secure: true, user: 'u', pass: 'p' },
			from: 'Portal <no-reply@example.com>',
		});
		expect(problemsOf(() => buildConfig(env, { ...system, signingKeys: [] }))).toEqual(['system secrets are incomplete']);
	});

	it('derives labelled subkeys', () => {
		expect(deriveSecret(Buffer.alloc(32, 1), 'a').equals(deriveSecret(Buffer.alloc(32, 1), 'b'))).toBe(false);
	});
});

describe('system store (secrets generated on first start, settings recorded later)', () => {
	it('generates the secrets once, even when instances start concurrently', async () => {
		const db = mongo.db('system_first_start');
		const stores = [createSystemStore(db), createSystemStore(db), createSystemStore(db)];
		const loaded = await Promise.all(stores.map((store) => store.load()));
		const kids = loaded.map(({ state }) => state.signingKeys[0]?.kid);
		expect(new Set(kids).size).toBe(1);
		const first = /** @type {{ state: import('../src/infra/config.js').SystemState, version: number }} */ (loaded[0]);
		expect(first.version).toBe(0);
		expect(first.state.websiteKeySigningKeys[0]?.kid).not.toBe(first.state.signingKeys[0]?.kid);
		expect(first.state.sessionSecret.equals(first.state.websiteKeyPepper)).toBe(false);
		expect(first.state.keks[0]?.key.length).toBe(32);
		expect(await db.collection('platform_system').countDocuments({ _id: /** @type {any} */ ('secrets') })).toBe(1);
	});

	it('records settings (mail password sealed) and bumps the version', async () => {
		const db = mongo.db('system_settings');
		const store = createSystemStore(db);
		await store.update({ mail: null });
		expect(await store.version()).toBe(1);
		await store.update({
			mail: { host: 'smtp.example.com', port: 587, secure: false, user: 'mailer', pass: 's3cret', from: 'ops@example.com' },
		});
		const raw = await db.collection('platform_system').findOne({ _id: /** @type {any} */ ('settings') });
		expect(JSON.stringify(raw)).not.toContain('s3cret');
		const { state, version } = await store.load();
		expect(version).toBe(2);
		expect(state.mail).toMatchObject({ host: 'smtp.example.com', pass: 's3cret', from: 'ops@example.com' });
		// keep the stored password when none is given; remove it with null
		await store.update({
			mail: { host: 'smtp2.example.com', port: 587, secure: false, user: 'mailer', from: 'ops@example.com' },
		});
		expect((await store.load()).state.mail?.pass).toBe('s3cret');
		await store.update({
			mail: { host: 'smtp2.example.com', port: 587, secure: false, user: null, pass: null, from: 'ops@example.com' },
		});
		expect((await store.load()).state.mail?.pass).toBeNull();
		await store.update({ mail: null });
		expect((await store.load()).state.mail).toBeNull();
		expect(await store.version()).toBeGreaterThan(version);
	});

	it('builds complete states for tests and tools', () => {
		const state = testSystemState();
		expect(state.mail).toBeNull();
		expect(secretsOf(generateSecrets()).signingKeys).toHaveLength(1);
	});

	it('records the applied schema fingerprint', async () => {
		const store = createSystemStore(mongo.db('system_schema'));
		expect(await store.appliedSchema()).toBeNull();
		await store.recordSchema('abc');
		expect(await store.appliedSchema()).toBe('abc');
	});
});
