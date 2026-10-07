/**
 * Test harness for the identity module: one MongoMemoryReplSet per test file, a Portal per test with identity and
 * the fake neighbours, and small HTTP clients that keep their session cookies.
 */
import { totpCode } from '../../../src/infra/auth.js';
import { closeMongoClients } from '../../../src/infra/db.js';
import { createIdentityModule } from '../../../src/modules/identity/index.js';
import { systemModule } from '../../../src/modules/system/index.js';
import { createPortal } from '../../../src/portal.js';
import { PORTAL_URL, createClock, createTestLogger, startMongo, testConfig } from '../../helpers.js';
import { fakeCatalog, fakeCommerce, fakeIntegration, memoryMailer, whoamiModule } from './fakes/modules.js';

export { PORTAL_URL };

/** @type {Awaited<ReturnType<typeof startMongo>> | null} */
let mongo = null;
let dbCounter = 0;

export const setupMongo = async () => {
	mongo = await startMongo();
};
export const teardownMongo = async () => {
	await closeMongoClients();
	await mongo?.stop();
};

/**
 * @param {{ commerce?: { fail?: boolean }, integration?: { fail?: boolean } | false, identity?: Record<string, unknown>,
 *   env?: Record<string, string>, withCommerce?: boolean }} [options]
 */
export const boot = async (options = {}) => {
	if (!mongo) throw new Error('setupMongo first');
	const clock = createClock();
	const mailer = memoryMailer();
	const commerce = fakeCommerce(options.commerce);
	const integration = fakeIntegration(options.integration || {});
	const catalog = await fakeCatalog();
	const config = await testConfig({ TRUST_PROXY_HEADERS: 'true', ...(options.env ?? {}) });
	const { logger, entries } = createTestLogger();
	const identity = createIdentityModule({ mailer, ...(options.identity ?? {}) });
	const modules = [
		systemModule,
		whoamiModule,
		identity,
		catalog.module,
		...(options.withCommerce === false ? [] : [commerce.module]),
		...(options.integration === false ? [] : [integration.module]),
	];
	dbCounter += 1;
	const db = mongo.db(`identity_${process.pid}_${dbCounter}`);
	const portal = createPortal({ config, db, modules, logger, now: clock.now });
	await portal.ensureIndexes();
	const service = /** @type {import('../../../src/modules/identity/service.js').IdentityService} */ (
		portal.modules.service('identity')
	);

	/**
	 * @param {string} method
	 * @param {string} path
	 * @param {{ body?: unknown, headers?: Record<string, string>, cookie?: string, ip?: string }} [init]
	 */
	const call = async (method, path, { body, headers = {}, cookie, ip = '203.0.113.7' } = {}) => {
		const response = await portal.handle(
			new Request(`${PORTAL_URL}${path}`, {
				method,
				headers: {
					origin: PORTAL_URL,
					'sec-fetch-site': 'same-origin',
					'x-forwarded-for': ip,
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
					...(cookie ? { cookie } : {}),
					...headers,
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
		const text = await response.text();
		return {
			status: response.status,
			headers: response.headers,
			json: text ? JSON.parse(text) : null,
			setCookies: response.headers.getSetCookie(),
		};
	};

	let keyCounter = 0;
	/**
	 * A client that keeps one session cookie (updated from Set-Cookie).
	 * @param {{ ip?: string }} [clientOptions]
	 */
	const client = ({ ip } = {}) => {
		let cookie = '';
		/**
		 * @param {string} method
		 * @param {string} path
		 * @param {unknown} [body]
		 * @param {{ headers?: Record<string, string> }} [extra]
		 */
		const send = async (method, path, body, extra = {}) => {
			const headers = { ...(extra.headers ?? {}) };
			if (method === 'POST' && !('idempotency-key' in headers)) {
				keyCounter += 1;
				headers['idempotency-key'] = `k-${keyCounter}`;
			}
			const res = await call(method, path, { body, headers, ...(cookie ? { cookie } : {}), ...(ip ? { ip } : {}) });
			for (const set of res.setCookies) {
				const [pair] = set.split(';');
				const [name, value] = String(pair).split('=');
				cookie = value ? `${name}=${value}` : '';
			}
			return res;
		};
		return {
			send,
			/** @param {string} path */
			get: (path) => send('GET', path),
			/** @param {string} path @param {unknown} [body] @param {{ headers?: Record<string, string> }} [extra] */
			post: (path, body, extra) => send('POST', path, body, extra),
			/** @param {string} path @param {unknown} [body] */
			patch: (path, body) => send('PATCH', path, body),
			/** @param {string} path */
			del: (path) => send('DELETE', path),
			get cookie() {
				return cookie;
			},
			/** @param {string} value */
			setCookie: (value) => {
				cookie = value;
			},
		};
	};

	/** @param {string} secret */
	const code = (secret) => totpCode(secret, clock.now());

	/**
	 * Sign up and verify a merchant owner; returns the signed-in client and ids.
	 * @param {string} email
	 * @param {{ password?: string, merchantName?: string, ip?: string }} [input]
	 */
	const signupOwner = async (email, { password = 'correct horse battery', merchantName = 'Shop', ip } = {}) => {
		const c = client(ip ? { ip } : {});
		const signup = await c.post('/v1/auth/merchant/signup', { email, password, merchantName });
		if (signup.status !== 202) throw new Error(`signup ${signup.status} ${JSON.stringify(signup.json)}`);
		const verified = await c.post('/v1/auth/merchant/verify-email', {
			token: mailer.token(email.toLowerCase(), 'verify_email'),
		});
		if (verified.status !== 201) throw new Error(`verify ${verified.status} ${JSON.stringify(verified.json)}`);
		return { client: c, merchantId: verified.json.merchantId, userId: verified.json.user.userId, password };
	};

	/**
	 * A fresh signed-in merchant client.
	 * @param {string} email
	 * @param {string} [password]
	 */
	const login = async (email, password = 'correct horse battery') => {
		const c = client();
		const res = await c.post('/v1/auth/merchant/login', { email, password });
		if (res.status !== 200) throw new Error(`login ${res.status}`);
		return c;
	};

	/**
	 * Create the first admin or another staff user with a password and enrolled TOTP; returns the signed-in client.
	 * @param {string} email
	 * @param {string[]} [roles]
	 * @param {{ creator?: any }} [input]
	 */
	const staffUser = async (email, roles = ['superadmin'], { creator } = {}) => {
		const password = 'staff password 123!';
		if (!creator) {
			// the first admin: created from the sign-in page, then given an e-mail in Account settings
			const first = client();
			const created = await first.post('/v1/auth/staff/first-admin', { password });
			if (created.status !== 201) throw new Error(`first admin ${created.status} ${JSON.stringify(created.json)}`);
			const named = await first.send('PATCH', '/v1/me', { email });
			if (named.status !== 200) throw new Error(`profile ${named.status} ${JSON.stringify(named.json)}`);
		} else {
			const created = await creator.post('/v1/admin/staff', { email, roles });
			if (created.status !== 201) throw new Error(`staff create ${created.status} ${JSON.stringify(created.json)}`);
			const token = mailer.token(email, 'staff_welcome');
			await call('POST', '/v1/auth/staff/password-reset/confirm', { body: { token, password } });
		}
		const c = client();
		const login = await c.post('/v1/auth/staff/login', { email, password });
		if (login.status !== 200) throw new Error(`staff login ${login.status}`);
		const enrol = await c.post('/v1/auth/staff/mfa/enrol');
		clock.advance(30_000);
		const confirm = await c.post('/v1/auth/staff/mfa/confirm', { code: code(enrol.json.secret) });
		if (confirm.status !== 200) throw new Error(`staff confirm ${confirm.status} ${JSON.stringify(confirm.json)}`);
		return {
			client: c,
			secret: enrol.json.secret,
			password,
			staffId: login.json.staff.staffId,
			recoveryCodes: confirm.json.recoveryCodes,
		};
	};

	return {
		portal,
		db,
		service,
		call,
		client,
		clock,
		mailer,
		commerce,
		integration,
		catalog,
		entries,
		code,
		signupOwner,
		staffUser,
		login,
		config,
	};
};
