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

/**
 * POST a connection code to a product's `/setup` (what its owner does in the browser).
 * @param {string} productUrl
 * @param {string} code
 */
export const postSetup = (productUrl, code) =>
	fetch(`${productUrl}/setup`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify({ code, baseUrl: productUrl }),
	});

/**
 * Add a product the way staff and its owner do: Admin → Apps → Add product (a one-time connection code), then the
 * product's `/setup` connects with it (proof of possession of its new key; the Portal pins its address). Answers the
 * app as the admin API shows it, with status 201 once connected.
 * @param {(method: string, path: string, init?: Record<string, any>) => Promise<{ status: number, json: any }>} call in-process Portal call
 * @param {string} staffCookie
 * @param {string} productUrl
 */
export const connectProduct = async (call, staffCookie, productUrl) => {
	const issued = await call('POST', '/v1/admin/apps/connection-codes', { cookie: staffCookie });
	if (issued.status !== 201) return issued;
	const setup = await postSetup(productUrl, issued.json.code);
	if (setup.status !== 200) return { status: setup.status, json: await setup.json().catch(() => null) };
	const app = await call('GET', `/v1/admin/apps/${issued.json.appId}`, { cookie: staffCookie });
	return { status: 201, json: app.json };
};
