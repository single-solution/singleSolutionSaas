/**
 * Client database for `resources/resolve` (kind `database`): a configured MongoDB URI, or a lazily started
 * MongoMemoryServer (`mongodb-memory-server`, a workspace dev dependency). One database per merchant.
 * @module
 */

/**
 * @typedef {object} DatabaseResolver
 * @property {(target: { merchantId: string, websiteId: string }) => Promise<{ uri: string, dbName: string }>} resolve
 * @property {() => Promise<void>} stop
 */

/**
 * Put a database name into a MongoDB URI (keeps credentials and options).
 * @param {string} uri
 * @param {string} dbName
 * @returns {string}
 */
export const withDatabase = (uri, dbName) => {
	const match = /^(mongodb(?:\+srv)?:\/\/[^/?]+)(?:\/[^?]*)?(\?.*)?$/.exec(uri);
	if (!match) throw new TypeError('not a mongodb:// URI');
	return `${match[1]}/${dbName}${match[2] ?? ''}`;
};

/**
 * @returns {Promise<{ uri: string, stop: () => Promise<void> }>}
 */
export const startMemoryServer = async () => {
	const { MongoMemoryServer } = await import('mongodb-memory-server');
	const server = await MongoMemoryServer.create();
	return {
		uri: server.getUri(),
		stop: async () => {
			await server.stop();
		},
	};
};

/**
 * @param {{ uri?: string | null, start?: typeof startMemoryServer }} [options]
 * @returns {DatabaseResolver}
 */
export const createDatabaseResolver = ({ uri = null, start = startMemoryServer } = {}) => {
	/** @type {Promise<{ uri: string, stop: () => Promise<void> }> | undefined} */
	let server;
	const base = async () => {
		if (uri) return uri;
		server ??= start();
		return (await server).uri;
	};
	return {
		resolve: async ({ merchantId }) => {
			const dbName = `client_${merchantId}`;
			return { uri: withDatabase(await base(), dbName), dbName };
		},
		stop: async () => {
			if (server) await (await server).stop();
			server = undefined;
		},
	};
};
