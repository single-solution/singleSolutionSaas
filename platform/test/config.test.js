import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	ENV_VARS,
	buildConfig,
	checkPortalUrl,
	checkPreviewUrl,
	deriveSecret,
	loadConfig,
	loadEnv,
} from '../src/infra/config.js';
import { isPlatformError } from '../src/infra/errors.js';
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

describe('loadEnv: only the database, the storage and tuning', () => {
	it('loads a minimal environment with defaults', async () => {
		const env = loadEnv(await testEnv());
		expect(env).toMatchObject({
			env: 'test',
			isProduction: false,
			version: 'dev',
			mongo: { uri: 'mongodb://127.0.0.1:27017/ss_portal_test', dbName: 'ss_portal_test', maxPoolSize: 5 },
			logLevel: 'info',
			trustProxyHeaders: false,
			maxBodyBytes: 1024 * 1024,
			operationDeadlineMs: 50_000,
			delivery: { storage: null, budgetKb: 60 },
		});
		expect(env.sessions.staff).toEqual({ idleMs: 30 * 60_000, absoluteMs: 12 * 3_600_000 });
		expect(Object.isFrozen(env)).toBe(true);
	});

	it('derives the environment from NODE_ENV only (production unless development or test)', async () => {
		expect(loadEnv(await testEnv({ NODE_ENV: 'development' }))).toMatchObject({ env: 'development', logLevel: 'debug' });
		expect(loadEnv({ ...(await testEnv()), ...PROD_STORAGE })).toMatchObject({ env: 'production', logLevel: 'info' });
		expect(loadEnv({ ...(await testEnv()), ...PROD_STORAGE, NODE_ENV: 'staging' }).env).toBe('production');
		expect(loadEnv(await testEnv({ APP_VERSION: '1a2b3c' })).version).toBe('1a2b3c');
	});

	it('requires only the database (storage is optional); reports every problem without values', () => {
		expect(problemsOf(() => loadEnv({ NODE_ENV: 'production' }))).toEqual(['MONGODB_URI is required']);
		expect(
			loadEnv({ NODE_ENV: 'production', MONGODB_URI: 'mongodb+srv://u:p@cluster.example.net/ss_portal' }).delivery.storage,
		).toBeNull();
		const problems = problemsOf(() =>
			loadEnv({
				NODE_ENV: 'test',
				MONGODB_URI: 'postgres://x',
				MONGODB_DB: 'bad name!',
				MONGODB_MAX_POOL_SIZE: '0',
				LOG_LEVEL: 'loud',
				TRUST_PROXY_HEADERS: 'yes',
				MAX_BODY_BYTES: '12',
				OPERATION_DEADLINE_MS: 'soon',
				STAFF_SESSION_IDLE_MINUTES: '-1',
				OUTBOUND_DEV_ALLOW_HOSTS: 'http://x/y',
			}),
		);
		for (const name of [
			'MONGODB_URI',
			'MONGODB_DB',
			'MONGODB_MAX_POOL_SIZE',
			'LOG_LEVEL',
			'TRUST_PROXY_HEADERS',
			'MAX_BODY_BYTES',
			'OPERATION_DEADLINE_MS',
			'STAFF_SESSION_IDLE_MINUTES',
			'OUTBOUND_DEV_ALLOW_HOSTS',
		])
			expect(problems).toEqual(expect.arrayContaining([expect.stringContaining(name)]));
		expect(
			problemsOf(() =>
				loadEnv({
					NODE_ENV: 'test',
					MONGODB_URI: 'mongodb://h/db',
					STAFF_SESSION_IDLE_MINUTES: '1000',
					STAFF_SESSION_MAX_HOURS: '1',
				}),
			),
		).toEqual([expect.stringContaining('STAFF session idle timeout')]);
	});

	it('derives the database name and honours optional settings; the dev allowlist is ignored in production', async () => {
		const env = loadEnv(
			await testEnv({
				MONGODB_URI: 'mongodb+srv://user:pass@cluster.example.net/?retryWrites=true',
				TRUST_PROXY_HEADERS: 'true',
				MAX_BODY_BYTES: '2048',
				MERCHANT_SESSION_IDLE_MINUTES: '60',
				MERCHANT_SESSION_MAX_HOURS: '2',
				OUTBOUND_DEV_ALLOW_HOSTS: ' Localhost, 127.0.0.1 ,[::1],, ',
			}),
		);
		expect(env.mongo.dbName).toBe('ss_portal');
		expect(env.trustProxyHeaders).toBe(true);
		expect(env.maxBodyBytes).toBe(2048);
		expect(env.sessions.merchant).toEqual({ idleMs: 3_600_000, absoluteMs: 7_200_000 });
		expect(env.outbound.allowHosts).toEqual(['localhost', '127.0.0.1', '[::1]']);
		expect(loadEnv(await testEnv({ MONGODB_DB: 'explicit' })).mongo.dbName).toBe('explicit');
		expect(
			loadEnv({ ...(await testEnv()), ...PROD_STORAGE, OUTBOUND_DEV_ALLOW_HOSTS: 'localhost' }).outbound.allowHosts,
		).toEqual([]);
	});

	it('documents every variable, and nothing but the database and the storage is required', () => {
		const names = ENV_VARS.map(([name]) => name);
		expect(new Set(names).size).toBe(names.length);
		expect(ENV_VARS.filter(([, required]) => required).map(([name]) => name)).toEqual([
			'MONGODB_URI',
			'STORAGE_ENDPOINT',
			'STORAGE_BUCKET',
			'STORAGE_ACCESS_KEY_ID',
			'STORAGE_SECRET_ACCESS_KEY',
		]);
		for (const gone of [
			'PUBLIC_URL',
			'SIGNING_KEYS',
			'ENCRYPTION_KEYS',
			'SESSION_SECRET',
			'KEY_PEPPER',
			'SMTP_URL',
			'PREVIEW_URL',
		])
			expect(names).not.toContain(gone);
	});
});

describe('buildConfig: environment + system state', () => {
	it('joins the generated secrets and the recorded settings', async () => {
		const config = loadConfig(await testEnv(), await testSystem());
		expect(config.setUp).toBe(true);
		expect(config.portalUrl).toBe('https://portal.test');
		expect(config.portalOrigin).toBe('https://portal.test');
		expect(config.cookieSecure).toBe(true);
		expect(config.problemBaseUri).toBe('https://portal.test/problems/');
		expect(config.signingKeys.map((k) => k.kid)).toEqual(['portal-2026-10', 'portal-2026-04']);
		expect(config.websiteKeySigningKeys.map((k) => k.kid)).toEqual(['website-2026-10']);
		expect(config.keks.map((k) => k.id)).toEqual(['kek-2', 'kek-1']);
		expect(config.mail).toEqual({ smtp: null, from: null });
		expect(config.delivery.previewOrigin).toBeNull();
	});

	it('before setup: not set up, with a placeholder URL', async () => {
		const config = loadConfig(await testEnv(), await testSystem({ portalUrl: null }));
		expect(config.setUp).toBe(false);
		expect(config.portalUrl).toBe('http://localhost');
	});

	it('validates the recorded URLs and the mail sender', async () => {
		const env = loadEnv(await testEnv());
		const system = await testSystem();
		expect(problemsOf(() => buildConfig(env, { ...system, portalUrl: 'http://portal.test' }))).toEqual([
			expect.stringContaining('https'),
		]);
		expect(problemsOf(() => buildConfig(env, { ...system, previewUrl: 'https://portal.test' }))).toEqual([
			expect.stringContaining('different host'),
		]);
		expect(buildConfig(env, { ...system, previewUrl: 'https://preview.test' }).delivery.previewOrigin).toBe(
			'https://preview.test',
		);
		const mail = { host: 'smtp.example.com', port: 465, secure: true, user: 'u', pass: 'p', from: 'bad\r\nBcc: x@y.z' };
		expect(problemsOf(() => buildConfig(env, { ...system, mail }))).toEqual([expect.stringContaining('sender')]);
		const ok = buildConfig(env, { ...system, mail: { ...mail, from: 'Portal <no-reply@example.com>' } });
		expect(ok.mail).toEqual({
			smtp: { host: 'smtp.example.com', port: 465, secure: true, user: 'u', pass: 'p' },
			from: 'Portal <no-reply@example.com>',
		});
		expect(problemsOf(() => buildConfig(env, { ...system, signingKeys: [] }))).toEqual(['system secrets are incomplete']);
	});

	it('checks Portal and preview URL candidates', () => {
		expect(checkPortalUrl('https://Portal.Example.com/', { production: true })).toEqual({
			ok: true,
			url: 'https://portal.example.com',
		});
		expect(checkPortalUrl('http://localhost:4000', { production: false })).toEqual({ ok: true, url: 'http://localhost:4000' });
		for (const bad of ['http://localhost:4000', 'https://x.test/path', 'nope', 'https://u:p@x.test'])
			expect(checkPortalUrl(bad, { production: true }).ok).toBe(false);
		expect(checkPreviewUrl('https://preview.test', { production: true, portalUrl: 'https://portal.test' }).ok).toBe(true);
		for (const bad of [
			'https://preview.test/p',
			'ftp://preview.test',
			'https://u:p@preview.test',
			'not a url',
			'https://portal.test',
		])
			expect(checkPreviewUrl(bad, { production: true, portalUrl: 'https://portal.test' }).ok).toBe(false);
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
		expect(first.state.portalUrl).toBeNull();
		expect(first.version).toBe(0);
		expect(first.state.websiteKeySigningKeys[0]?.kid).not.toBe(first.state.signingKeys[0]?.kid);
		expect(first.state.sessionSecret.equals(first.state.websiteKeyPepper)).toBe(false);
		expect(first.state.keks[0]?.key.length).toBe(32);
		expect(await db.collection('platform_system').countDocuments({ _id: /** @type {any} */ ('secrets') })).toBe(1);
	});

	it('records settings (mail password sealed), bumps the version and rotates keys keeping the old ones', async () => {
		const db = mongo.db('system_settings');
		const store = createSystemStore(db);
		await store.update({ portalUrl: 'https://portal.example.com', setup: true });
		expect(await store.version()).toBe(1);
		await store.update({
			mail: { host: 'smtp.example.com', port: 587, secure: false, user: 'mailer', pass: 's3cret', from: 'ops@example.com' },
		});
		const raw = await db.collection('platform_system').findOne({ _id: /** @type {any} */ ('settings') });
		expect(JSON.stringify(raw)).not.toContain('s3cret');
		const { state, version } = await store.load();
		expect(version).toBe(2);
		expect(state.portalUrl).toBe('https://portal.example.com');
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
		await store.update({ mail: null, previewUrl: 'https://preview.example.net' });
		expect((await store.load()).state).toMatchObject({ mail: null, previewUrl: 'https://preview.example.net' });

		const before = (await store.load()).state;
		const rotated = await store.rotate('signing');
		expect(rotated).toMatchObject({ kind: 'signing', count: 2 });
		const after = (await store.load()).state;
		expect(after.signingKeys.map((k) => k.kid)).toEqual([rotated.id, before.signingKeys[0]?.kid]);
		expect((await store.rotate('encryption')).count).toBe(2);
		expect((await store.rotate('website')).count).toBe(2);
		const info = await store.keyInfo();
		expect(info.signing.map((k) => k.active)).toEqual([true, false]);
		expect(JSON.stringify(info)).not.toMatch(/seed|"key"/);
		expect(await store.version()).toBeGreaterThan(version);
	});

	it('builds complete states for tests and tools', () => {
		const state = testSystemState({ portalUrl: 'https://p.test' });
		expect(state.portalUrl).toBe('https://p.test');
		expect(secretsOf(generateSecrets()).signingKeys).toHaveLength(1);
	});

	it('records the applied schema fingerprint', async () => {
		const store = createSystemStore(mongo.db('system_schema'));
		expect(await store.appliedSchema()).toBeNull();
		await store.recordSchema('abc');
		expect(await store.appliedSchema()).toBe('abc');
	});
});
