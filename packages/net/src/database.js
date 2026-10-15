/**
 * MongoDB client rules shared by the Portal and every product, without the driver (callers pass their client): the
 * deadlines and pool of a serverless client, connecting a client before use, and knowing an error of a database that
 * cannot be reached (which requests answer 503).
 * @module
 */

/**
 * Deadlines of every database call, for serverless functions (K-16): finding a server that answers (a database that
 * cannot be reached) and opening a connection 5 s; waiting for a free pooled connection 10 s; each send or receive on a
 * connection 10 s (one operation that hangs).
 */
export const DATABASE_DEADLINES = Object.freeze({
	serverSelectionTimeoutMS: 5_000,
	connectTimeoutMS: 5_000,
	waitQueueTimeoutMS: 10_000,
	socketTimeoutMS: 10_000,
});

/**
 * Options of a serverless database client (`new MongoClient(uri, options)`): a small pool that keeps no idle
 * connection longer than a minute, and {@link DATABASE_DEADLINES}. Add driver-specific options (`lookup`) to the copy.
 * @param {{ maxPoolSize?: number, appName?: string }} [options] `maxPoolSize` 5 by default
 * @returns {{ maxPoolSize: number, minPoolSize: number, maxIdleTimeMS: number, serverSelectionTimeoutMS: number,
 *   connectTimeoutMS: number, waitQueueTimeoutMS: number, socketTimeoutMS: number, appName?: string }}
 */
export const databaseClientOptions = ({ maxPoolSize = 5, appName } = {}) => ({
	maxPoolSize,
	minPoolSize: 0,
	maxIdleTimeMS: 60_000,
	...DATABASE_DEADLINES,
	...(appName === undefined ? {} : { appName }),
});

/** Driver errors of a database that cannot be reached, or that did not answer within a deadline. */
const UNAVAILABLE_ERRORS = new Set([
	'MongoServerSelectionError',
	'MongoNetworkError',
	'MongoNetworkTimeoutError',
	'MongoWaitQueueTimeoutError',
	'MongoOperationTimeoutError',
	'MongoPoolClearedError',
	'MongoTopologyClosedError',
]);

/** Network errors of a name lookup (a `mongodb+srv` address whose DNS records cannot be read right now). */
const LOOKUP_ERRORS = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ETIMEOUT', 'ESERVFAIL']);

/**
 * True when the database cannot be reached or did not answer in time: a driver network error or deadline, a failed DNS
 * lookup of its address, or an operation over its `maxTimeMS` (server code 50).
 * @param {unknown} error
 * @returns {boolean}
 */
export const isDatabaseUnavailable = (error) => {
	if (typeof error !== 'object' || error === null) return false;
	const { name, code } = /** @type {{ name?: unknown, code?: unknown }} */ (error);
	return UNAVAILABLE_ERRORS.has(String(name)) || code === 50 || LOOKUP_ERRORS.has(String(code));
};

/**
 * Connect a database client before use: the returned function resolves once `client` is connected. A mongodb 6.x client
 * whose first connect fails (the database cannot be reached while a serverless instance starts) closes its topology,
 * and every later call fails with `MongoTopologyClosedError`, even once the database is back; `client.connect()` opens
 * a new one. So a failed connect (within {@link DATABASE_DEADLINES}) is forgotten and tried again by the next call, on
 * the same warm instance; concurrent calls share one attempt, and a connected client is not asked again (it finds its
 * database again by itself after an outage).
 * @param {{ connect: () => Promise<unknown> }} client
 * @returns {() => Promise<void>}
 */
export const connectBeforeUse = (client) => {
	/** @type {Promise<unknown> | null} */
	let connecting = null;
	return async () => {
		connecting ??= client.connect().catch((error) => {
			connecting = null;
			throw error;
		});
		await connecting;
	};
};
