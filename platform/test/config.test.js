import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKeyResolver, issueToken, verifyToken } from '@ss/protocol';
import { DEFAULT_SETTINGS, buildConfig, loadConfig, loadEnv, parsePortalUrl } from '../src/infra/config.js';
import { createPortalKeys } from '../src/infra/crypto.js';
import { isPlatformError } from '../src/infra/errors.js';
import { createSystemStore, generateSecrets, secretsOf } from '../src/infra/system.js';
import { testSystemState } from '../src/testing.js';
import { ENCRYPTION_KEY, PORTAL_URL, startMongo, testEnv, testSystem } from './helpers.js';

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

const PROD = {
	NODE_ENV: 'production',
	PORTAL_URL: 'https://portal.example.com',
	ENCRYPTION_KEY,
};

describe('loadEnv: the database, the Portal address and the encryption key (PLAN 0.11)', () => {
	it('loads a minimal environment with the fixed values', async () => {
		const env = loadEnv(await testEnv());
		expect(env).toMatchObject({
			env: 'test',
			isProduction: false,
			portalUrl: PORTAL_URL,
			encryptionKey: ENCRYPTION_KEY,
			mongo: { uri: 'mongodb://127.0.0.1:27017/ss_portal_test', dbName: 'ss_portal_test', maxPoolSize: 5 },
			logLevel: 'info',
			maxBodyBytes: 1024 * 1024,
		});
		expect(Object.isFrozen(env)).toBe(true);
	});

	it('derives the environment from NODE_ENV only (production unless development or test)', async () => {
		expect(loadEnv(await testEnv({ NODE_ENV: 'development' }))).toMatchObject({ env: 'development', logLevel: 'debug' });
		expect(loadEnv({ ...(await testEnv()), ...PROD })).toMatchObject({ env: 'production', logLevel: 'info' });
		expect(loadEnv({ ...(await testEnv()), ...PROD, NODE_ENV: 'staging' }).env).toBe('production');
	});

	it('requires the database, PORTAL_URL and ENCRYPTION_KEY; reports every problem without values', () => {
		expect(problemsOf(() => loadEnv({ NODE_ENV: 'production' }))).toEqual([
			'MONGODB_URI is required',
			'PORTAL_URL is required',
			'ENCRYPTION_KEY is required',
		]);
		expect(
			loadEnv({
				NODE_ENV: 'production',
				MONGODB_URI: 'mongodb+srv://u:p@cluster.example.net/ss_portal',
				PORTAL_URL: 'https://portal.example.com',
				ENCRYPTION_KEY,
			}).env,
		).toBe('production');
		const short = problemsOf(() => loadEnv({ ...PROD, MONGODB_URI: 'mongodb://h/x', ENCRYPTION_KEY: 'short' }));
		expect(short).toEqual(['ENCRYPTION_KEY must be at least 32 characters']);
		expect(short.join(' ')).not.toContain('short');
		const problems = problemsOf(() => loadEnv({ NODE_ENV: 'test', MONGODB_URI: 'postgres://x', LOG_LEVEL: 'loud' }));
		for (const name of ['MONGODB_URI', 'LOG_LEVEL'])
			expect(problems).toEqual(expect.arrayContaining([expect.stringContaining(name)]));
		expect(
			problemsOf(() =>
				loadEnv({ NODE_ENV: 'test', MONGODB_URI: 'mongodb://h/bad%20name!', PORTAL_URL: 'https://p.test', ENCRYPTION_KEY }),
			),
		).toEqual([expect.stringContaining('invalid database')]);
	});

	it('derives the database name; local products are reachable outside production only', async () => {
		const env = loadEnv(
			await testEnv({
				MONGODB_URI: 'mongodb+srv://user:pass@cluster.example.net/?retryWrites=true',
			}),
		);
		expect(env.mongo.dbName).toBe('ss_portal');
		expect(env.outbound.allowHosts).toEqual(['localhost', '127.0.0.1', '::1']);
		expect(loadEnv({ ...(await testEnv()), ...PROD }).outbound.allowHosts).toEqual([]);
	});

	it('documents exactly the three variables of PLAN 0.11, the optional previous key and the optional log level', async () => {
		const example = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
		const names = example.split('\n').flatMap((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1] ?? []);
		expect(names).toEqual(['MONGODB_URI', 'PORTAL_URL', 'ENCRYPTION_KEY', 'ENCRYPTION_KEY_PREVIOUS', 'LOG_LEVEL']);
		const env = await testEnv();
		expect(loadEnv(env).previousEncryptionKey).toBeNull();
		const previous = 'previous-encryption-key-0123456789abcdef';
		expect(loadEnv({ ...env, ENCRYPTION_KEY_PREVIOUS: previous }).previousEncryptionKey).toBe(previous);
		expect(problemsOf(() => loadEnv({ ...env, ENCRYPTION_KEY_PREVIOUS: 'old-short-key' }))).toEqual([
			'ENCRYPTION_KEY_PREVIOUS must be at least 32 characters',
		]);
		expect(loadEnv({ ...env, LOG_LEVEL: 'warn' }).logLevel).toBe('warn');
		expect(loadEnv({ ...env, NODE_ENV: 'development', LOG_LEVEL: 'error' }).logLevel).toBe('error');
	});
});

describe('buildConfig: environment + system state', () => {
	it('joins the generated secrets and the recorded settings', async () => {
		const config = loadConfig(await testEnv(), await testSystem());
		expect(config.portalUrl).toBe('https://portal.test');
		expect(config.cookieSecure).toBe(true);
		expect(config.problemBaseUri).toBe('https://portal.test/problems/');
		expect(config.signingKeys.map((k) => k.kid)).toEqual(['portal-2026-10', 'portal-2026-04']);
		expect(config.tokenSigningKeys.map((k) => k.kid)).toEqual(['token-2026-10']);
		expect(config.mail).toEqual({ smtp: null, from: null });
		expect(config.settings).toEqual(DEFAULT_SETTINGS);
		expect(config.sessionMs).toBe(12 * 3_600_000);
	});

	it('the Portal address is PORTAL_URL only: https, an origin with nothing after it (PLAN 0.8.1, 0.11)', async () => {
		const local = loadConfig(await testEnv({ PORTAL_URL: 'http://localhost:4000' }), await testSystem());
		expect(local.portalUrl).toBe('http://localhost:4000');
		expect(local.cookieSecure).toBe(false);
		expect(parsePortalUrl('https://Portal.Example.com', true)).toEqual({ ok: true, value: 'https://portal.example.com' });
		expect(parsePortalUrl('https://portal.example.com:8443', true)).toEqual({
			ok: true,
			value: 'https://portal.example.com:8443',
		});
		for (const local of ['http://127.0.0.1:3000', 'http://[::1]', 'http://app.localhost', 'http://localhost'])
			expect(parsePortalUrl(local, false).ok).toBe(true);
		// one trailing slash and surrounding spaces are tolerated
		expect(parsePortalUrl(' https://portal.example.com/ ', true)).toEqual({ ok: true, value: 'https://portal.example.com' });
		for (const bad of [
			'https://portal.example.com//',
			'https://portal.example.com/admin',
			'https://portal.example.com?x=1',
			'https://portal.example.com#a',
			'https://user:pass@portal.example.com',
			'ftp://portal.example.com',
			'portal.example.com',
			'http://portal.example.com',
		])
			expect(parsePortalUrl(bad, false).ok).toBe(false);
		// production: https always, even for localhost
		expect(parsePortalUrl('http://localhost', true).ok).toBe(false);
		expect(parsePortalUrl(undefined, true)).toEqual({ ok: false, message: 'PORTAL_URL is required' });
	});

	it('takes the recorded settings over the defaults; Session length sets the one session lifetime', async () => {
		const config = loadConfig(
			await testEnv(),
			await testSystem({ settings: { security: { sessionHours: 2 }, branding: { name: 'Acme' } } }),
		);
		expect(config.settings.security).toEqual({ sessionHours: 2, requireTwoStepForAdmins: false });
		expect(config.settings.branding.name).toBe('Acme');
		expect(config.sessionMs).toBe(2 * 3_600_000);
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
});

describe('system store (secrets generated on first start, settings recorded later)', () => {
	it('generates the secrets once, even when instances start concurrently', async () => {
		const db = mongo.db('system_first_start');
		const stores = [
			createSystemStore(db, { encryptionKey: ENCRYPTION_KEY }),
			createSystemStore(db, { encryptionKey: ENCRYPTION_KEY }),
			createSystemStore(db, { encryptionKey: ENCRYPTION_KEY }),
		];
		const loaded = await Promise.all(stores.map((store) => store.load()));
		const kids = loaded.map(({ state }) => state.signingKeys[0]?.kid);
		expect(new Set(kids).size).toBe(1);
		const first = /** @type {{ state: import('../src/infra/config.js').SystemState, version: number }} */ (loaded[0]);
		expect(first.version).toBe(0);
		expect(first.state.tokenSigningKeys[0]?.kid).not.toBe(first.state.signingKeys[0]?.kid);
		expect(first.state.sessionSecret.equals(first.state.idempotencySecret)).toBe(false);
		expect(await db.collection('platform_system').countDocuments({ _id: /** @type {any} */ ('secrets') })).toBe(1);
	});

	it('records settings (mail password sealed) and bumps the version', async () => {
		const db = mongo.db('system_settings');
		const store = createSystemStore(db, { encryptionKey: ENCRYPTION_KEY });
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

	it('seals the SMTP password with ENCRYPTION_KEY: another key cannot read it back (PLAN 0.4.8)', async () => {
		const db = mongo.db('system_settings_key');
		const store = createSystemStore(db, { encryptionKey: ENCRYPTION_KEY });
		await store.update({
			mail: { host: 'smtp.example.com', port: 587, secure: false, user: 'u', pass: 'pw-1', from: 'a@b.co' },
		});
		const sealed = /** @type {any} */ (await store.settings())?.mail?.passSealed;
		expect(store.passwordReadable(sealed)).toBe(true);
		const other = createSystemStore(db, { encryptionKey: 'another-encryption-key-0123456789abcdef' });
		expect((await other.load()).state.mail?.pass).toBeNull();
		expect(other.passwordReadable(sealed)).toBe(false);
		expect(store.passwordReadable(null)).toBe(false);
	});

	it('records the security, branding, support and billing settings and the logo', async () => {
		const db = mongo.db('system_settings_groups');
		const store = createSystemStore(db, { encryptionKey: ENCRYPTION_KEY });
		await store.update({ security: { sessionHours: 24 }, support: { email: 'help@example.com', phone: undefined } });
		await store.update({ security: { requireTwoStepForAdmins: true } });
		const { state } = await store.load();
		expect(state.settings?.security).toEqual({ sessionHours: 24, requireTwoStepForAdmins: true });
		expect(state.settings?.support).toEqual({ email: 'help@example.com' });
		expect(await store.logo()).toBeNull();
		await store.setLogo({ type: 'image/png', data: Buffer.from([1, 2, 3]) });
		expect(await store.logo()).toEqual({ type: 'image/png', data: Buffer.from([1, 2, 3]) });
		expect((await store.load()).state.settings?.branding).toEqual({ hasLogo: true, logoVersion: 1 });
		await store.setLogo(null);
		expect(await store.logo()).toBeNull();
		expect((await store.load()).state.settings?.branding).toEqual({ hasLogo: false, logoVersion: 2 });
	});

	it('keeps the signing keys sealed with ENCRYPTION_KEY, their public keys readable (K-21)', async () => {
		const db = mongo.db('system_keys_sealed');
		const store = createSystemStore(db, { encryptionKey: ENCRYPTION_KEY });
		const { state } = await store.load();
		const raw = /** @type {any} */ (await db.collection('platform_system').findOne({ _id: /** @type {any} */ ('secrets') }));
		for (const key of [...raw.signingKeys, ...raw.tokenSigningKeys]) {
			expect(key).toEqual({
				kid: expect.any(String),
				sealed: expect.stringMatching(/^ss2\./),
				publicJwk: expect.objectContaining({ kid: key.kid, crv: 'Ed25519' }),
				createdAt: expect.any(String),
			});
		}
		expect(JSON.stringify(raw)).not.toContain(/** @type {string} */ (state.signingKeys[0]?.d));
		expect(state.signingKeys.map((k) => k.kid)).toEqual(raw.signingKeys.map((/** @type {any} */ k) => k.kid));
		expect(state.publishedOnly).toEqual({ signing: [], token: [] });
	});

	it('seals seeds kept in clear before on first use, and signs with the same keys (K-21)', async () => {
		const db = mongo.db('system_keys_plain');
		const plain = generateSecrets();
		await db.collection('platform_system').insertOne(/** @type {any} */ ({ _id: 'secrets', ...plain }));
		const { state } = await createSystemStore(db, { encryptionKey: ENCRYPTION_KEY }).load();
		expect(state.signingKeys.map((k) => k.d)).toEqual(secretsOf(plain).signingKeys.map((k) => k.d));
		expect(state.tokenSigningKeys.map((k) => k.d)).toEqual(secretsOf(plain).tokenSigningKeys.map((k) => k.d));
		const raw = /** @type {any} */ (await db.collection('platform_system').findOne({ _id: /** @type {any} */ ('secrets') }));
		expect(JSON.stringify(raw)).not.toContain(/** @type {string} */ (plain.signingKeys[0]?.seed));
		expect(raw.signingKeys[0].sealed).toMatch(/^ss2\./);
	});

	it('when no signing key opens (ENCRYPTION_KEY lost) a new one signs and the old ones stay published (K-21)', async () => {
		const db = mongo.db('system_keys_lost');
		const first = (await createSystemStore(db, { encryptionKey: ENCRYPTION_KEY }).load()).state;
		const lostKey = 'lost-encryption-key-0123456789abcdef-x';
		const stores = [createSystemStore(db, { encryptionKey: lostKey }), createSystemStore(db, { encryptionKey: lostKey })];
		const [a, b] = await Promise.all(stores.map((store) => store.load()));
		// concurrent instances agree on one new key per list
		expect(a?.state.signingKeys.map((k) => k.kid)).toEqual(b?.state.signingKeys.map((k) => k.kid));
		const lost = /** @type {import('../src/infra/config.js').SystemState} */ (a?.state);
		expect(lost.signingKeys).toHaveLength(1);
		expect(lost.signingKeys[0]?.kid).not.toBe(first.signingKeys[0]?.kid);
		expect(lost.publishedOnly?.signing.map((k) => k.kid)).toEqual([first.signingKeys[0]?.kid]);
		expect(lost.publishedOnly?.token.map((k) => k.kid)).toEqual([first.tokenSigningKeys[0]?.kid]);
		const keys = createPortalKeys(lost.signingKeys, lost.tokenSigningKeys, lost.publishedOnly);
		expect(keys.publishedJwks().keys).toHaveLength(4);
		// a token the old key signed still verifies; new tokens are signed by the new key
		const old = createPortalKeys(first.signingKeys, first.tokenSigningKeys);
		const issued = await issueToken({
			signer: old.tokenSigner,
			issuer: PORTAL_URL,
			websiteId: 'web_1',
			domain: 'shop.example.com',
			productId: 'notes',
			kind: 'server',
		});
		const claims = await verifyToken({
			token: issued.token,
			keyResolver: createKeyResolver({ jwks: keys.publishedJwks() }),
			issuer: PORTAL_URL,
			productId: 'notes',
		});
		expect(claims.websiteId).toBe('web_1');
		expect(keys.tokenSigner.kid).toBe(lost.tokenSigningKeys[0]?.kid);
		// the right key back: the old keys sign again, the one made meanwhile stays published
		const back = (await createSystemStore(db, { encryptionKey: ENCRYPTION_KEY }).load()).state;
		expect(back.signingKeys.map((k) => k.kid)).toEqual([first.signingKeys[0]?.kid]);
		expect(back.publishedOnly?.signing.map((k) => k.kid)).toEqual([lost.signingKeys[0]?.kid]);
	});

	it('Re-seal moves the signing keys and the SMTP password to the new ENCRYPTION_KEY (RT-14, K-21)', async () => {
		const db = mongo.db('system_reseal');
		const old = createSystemStore(db, { encryptionKey: ENCRYPTION_KEY });
		const kids = (await old.load()).state.signingKeys.map((k) => k.kid);
		await old.update({ mail: { host: 'smtp.example.com', port: 587, secure: false, user: 'u', pass: 'pw-1', from: 'a@b.co' } });
		const newKey = 'new-encryption-key-0123456789abcdef-portal';
		const changing = createSystemStore(db, { encryptionKey: newKey, previousKey: ENCRYPTION_KEY });
		expect(await changing.reseal()).toEqual({ resealed: 3, current: 0, unreadable: 0 });
		expect(await changing.reseal()).toEqual({ resealed: 0, current: 3, unreadable: 0 });
		const after = createSystemStore(db, { encryptionKey: newKey });
		const { state } = await after.load();
		expect(state.signingKeys.map((k) => k.kid)).toEqual(kids);
		expect(state.publishedOnly).toEqual({ signing: [], token: [] });
		expect(state.mail?.pass).toBe('pw-1');
		expect(await createSystemStore(mongo.db('system_reseal_empty'), { encryptionKey: newKey }).reseal()).toEqual({
			resealed: 0,
			current: 2,
			unreadable: 0,
		});
	});

	it('builds complete states for tests and tools', () => {
		const state = testSystemState();
		expect(state.mail).toBeNull();
		expect(secretsOf(generateSecrets()).signingKeys).toHaveLength(1);
	});

	it('records the applied schema fingerprint', async () => {
		const store = createSystemStore(mongo.db('system_schema'), { encryptionKey: ENCRYPTION_KEY });
		expect(await store.appliedSchema()).toBeNull();
		await store.recordSchema('abc');
		expect(await store.appliedSchema()).toBe('abc');
	});
});
