/**
 * Test harness for the identity module: one MongoMemoryReplSet per test file, a Portal per test with identity and the
 * fake neighbours, small HTTP clients that keep their session cookies, and helpers that create logins the way PLAN 0.2
 * says: the first admin from the sign-in page, other admins by invite, merchants by an admin (setup link).
 * Work after responses (e-mails) runs before each call returns.
 */
import { totpCode } from '../../../src/infra/auth.js';
import { closeMongoClients } from '../../../src/infra/db.js';
import { createIdentityModule } from '../../../src/modules/identity/index.js';
import { systemModule } from '../../../src/modules/system/index.js';
import { createSystemStore } from '../../../src/infra/system.js';
import { createPortal } from '../../../src/portal.js';
import { ENCRYPTION_KEY, PORTAL_URL, createClock, createTestLogger, startMongo, testConfig } from '../../helpers.js';
import { fakeCatalog, fakeCommerce, memoryMailer, whoamiModule } from './fakes/modules.js';

export { PORTAL_URL };

export const PASSWORD = 'correct horse battery';

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
 * @param {{ commerce?: { fail?: boolean }, identity?: Record<string, unknown>, env?: Record<string, string>,
 *   settings?: Record<string, any>, withCommerce?: boolean, withCatalog?: boolean, mail?: boolean }} [options]
 *   `mail: false` builds the Portal
 *   without e-mail sending (e-mails are skipped)
 */
export const boot = async (options = {}) => {
	if (!mongo) throw new Error('setupMongo first');
	const clock = createClock();
	const mailer = memoryMailer();
	if (options.mail === false) mailer.setAvailable(false);
	const commerce = fakeCommerce(options.commerce);
	const catalog = await fakeCatalog();
	const config = await testConfig(options.env ?? {}, options.settings ? { settings: options.settings } : {});
	const { logger, entries } = createTestLogger();
	const identity = createIdentityModule({ mailer, ...(options.identity ?? {}) });
	const modules = [
		systemModule,
		whoamiModule,
		identity,
		...(options.withCatalog === false ? [] : [catalog.module]),
		...(options.withCommerce === false ? [] : [commerce.module]),
	];
	dbCounter += 1;
	const db = mongo.db(`identity_${process.pid}_${dbCounter}`);
	/** @type {Promise<unknown>[]} */
	const pending = [];
	const portal = createPortal({
		config,
		db,
		modules,
		logger,
		now: clock.now,
		system: createSystemStore(db, { encryptionKey: ENCRYPTION_KEY, now: clock.now }),
		background: { mode: 'on', fallback: (task) => void pending.push(Promise.resolve().then(task)) },
	});
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
		while (pending.length > 0) await Promise.all(pending.splice(0));
		/** @type {any} */
		let json = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			json = null;
		}
		return { status: response.status, headers: response.headers, json, setCookies: response.headers.getSetCookie() };
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
			/** @param {string} path @param {unknown} [body] */
			del: (path, body) => send('DELETE', path, body),
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
	 * Sign in on the one sign-in page (no two-step); returns the client.
	 * @param {string} email
	 * @param {string} [password]
	 */
	const signIn = async (email, password = PASSWORD) => {
		const c = client();
		const res = await c.post('/v1/auth/sign-in', { email, password });
		if (res.status !== 200 || res.json.status !== 'ok') throw new Error(`sign-in ${res.status} ${JSON.stringify(res.json)}`);
		return c;
	};

	/** @type {ReturnType<typeof client> | null} */
	let firstOwner = null;

	/**
	 * The first admin (an Owner), created from the sign-in page on first use.
	 * @returns {Promise<{ client: ReturnType<typeof client>, adminId: string, email: string }>}
	 */
	const owner = async () => {
		if (firstOwner) {
			let me = await firstOwner.get('/v1/me');
			// the sign-in lasts the Session length: sign in again when it ended
			if (me.status === 401) {
				firstOwner.setCookie((await signIn('owner@portal.test')).cookie);
				me = await firstOwner.get('/v1/me');
			}
			return { client: firstOwner, adminId: me.json.admin.adminId, email: me.json.admin.email };
		}
		const c = client();
		const created = await c.post('/v1/auth/first-admin', {
			name: 'Olivia Owner',
			email: 'owner@portal.test',
			password: PASSWORD,
		});
		if (created.status !== 201) throw new Error(`first admin ${created.status} ${JSON.stringify(created.json)}`);
		firstOwner = c;
		return { client: c, adminId: created.json.admin.adminId, email: 'owner@portal.test' };
	};

	/**
	 * An admin of a role, invited by the first Owner, who accepted the invite (name + password).
	 * @param {'owner' | 'support' | 'finance'} role
	 * @param {string} [email]
	 */
	const admin = async (role, email = `${role}-${(keyCounter += 1)}@portal.test`) => {
		const by = (await owner()).client;
		const invited = await by.post('/v1/admin/admins', { email, role });
		if (invited.status !== 201) throw new Error(`invite ${invited.status} ${JSON.stringify(invited.json)}`);
		const c = client();
		const accepted = await c.post('/v1/auth/set-password', {
			token: mailer.token(email, 'admin_invite'),
			password: PASSWORD,
			name: `${role} admin`,
		});
		if (accepted.status !== 200) throw new Error(`accept ${accepted.status} ${JSON.stringify(accepted.json)}`);
		return { client: c, adminId: invited.json.admin.adminId, email };
	};

	/**
	 * A merchant created by the first Owner whose login set its password from the setup link; returns the signed-in
	 * merchant client, its id and the Owner's client.
	 * @param {string} email
	 * @param {Record<string, unknown>} [fields]
	 */
	const merchant = async (email, fields = {}) => {
		const by = (await owner()).client;
		const created = await by.post('/v1/admin/merchants', { name: 'Shop', ownerName: 'Sam Seller', email, ...fields });
		if (created.status !== 201) throw new Error(`merchant ${created.status} ${JSON.stringify(created.json)}`);
		const c = client();
		const set = await c.post('/v1/auth/set-password', { token: mailer.token(email, 'merchant_setup'), password: PASSWORD });
		if (set.status !== 200) throw new Error(`setup ${set.status} ${JSON.stringify(set.json)}`);
		return { client: c, merchantId: created.json.merchant.merchantId, admin: by, password: PASSWORD };
	};

	/**
	 * Merchant + one website added by the Owner (the merchant's own client cannot add websites).
	 * @param {string} email
	 * @param {string} [domain]
	 */
	const merchantWithWebsite = async (email, domain = 'shop.example.com') => {
		const m = await merchant(email);
		const created = await m.admin.post(`/v1/merchants/${m.merchantId}/websites`, { domain });
		if (created.status !== 201) throw new Error(`website ${created.status} ${JSON.stringify(created.json)}`);
		return { ...m, websiteId: created.json.website.websiteId, domain };
	};

	/**
	 * Turn two-step on for a signed-in client; returns the secret and recovery codes.
	 * @param {ReturnType<typeof client>} c
	 */
	const enableTwoStep = async (c) => {
		const started = await c.post('/v1/me/two-step/start');
		clock.advance(30_000);
		const confirmed = await c.post('/v1/me/two-step/confirm', { code: code(started.json.secret) });
		if (confirmed.status !== 200) throw new Error(`two-step ${confirmed.status} ${JSON.stringify(confirmed.json)}`);
		clock.advance(30_000);
		return {
			secret: /** @type {string} */ (started.json.secret),
			recoveryCodes: /** @type {string[]} */ (confirmed.json.recoveryCodes),
		};
	};

	/** Activity entries (newest first) of an action. @param {string} action */
	const activity = (action) => db.collection('platform_audit').find({ action }).sort({ at: -1, _id: -1 }).toArray();

	return {
		portal,
		db,
		service,
		call,
		client,
		clock,
		mailer,
		commerce,
		catalog,
		entries,
		code,
		signIn,
		owner,
		admin,
		merchant,
		merchantWithWebsite,
		enableTwoStep,
		activity,
		config,
	};
};
