/**
 * Shared helpers of the system tests: a controllable clock and databases on the run's MongoMemoryReplSet
 * (`TEST_MONGODB_URI`, started by the `@ss/config` Mongo global setup).
 * @module
 */

/**
 * Controllable clock.
 * @param {number} start epoch milliseconds
 */
export const createClock = (start) => {
	let t = start;
	return {
		now: () => t,
		/** @param {number} ms */
		advance: (ms) => {
			t += ms;
		},
		/** @param {number} ms */
		set: (ms) => {
			t = ms;
		},
	};
};

/**
 * MongoDB URI of a database on the shared replica set.
 * @param {string} name
 */
export const mongoUri = (name) => {
	const base = process.env.TEST_MONGODB_URI;
	if (!base) throw new Error('TEST_MONGODB_URI is not set (run through vitest with the @ss/config Mongo setup)');
	const url = new URL(base);
	url.pathname = `/${name}`;
	return url.toString();
};

/** The `CONNECT_SECRET` the products under test run with. */
export const CONNECT_SECRET = 'e2e-product-connect-secret-0123456789abcdef';

/**
 * Add a product the way staff do: Admin → Apps → Add product with its URL and connect secret (the Portal calls its
 * `/.well-known/ss-connect`, HMAC both ways, and pins its address and key). Answers the app as the admin API shows it,
 * with status 201 once connected.
 * @param {(method: string, path: string, init?: Record<string, any>) => Promise<{ status: number, json: any }>} call in-process Portal call
 * @param {string} staffCookie
 * @param {string} productUrl
 * @param {string} [secret]
 */
export const connectProduct = async (call, staffCookie, productUrl, secret = CONNECT_SECRET) => {
	const connected = await call('POST', '/v1/admin/apps/connect', { cookie: staffCookie, body: { url: productUrl, secret } });
	if (connected.status !== 201) return connected;
	const app = await call('GET', `/v1/admin/apps/${connected.json.appId}`, { cookie: staffCookie });
	return { status: 201, json: app.json };
};
