/**
 * Read the product's environment (names in API.md). Values are returned as-is; `createProduct` validates them.
 * @module
 */

/**
 * @param {Record<string, string | undefined>} [env] defaults to `process.env`
 * @returns {{ portalUrl: string | undefined, appId: string | null, signingKey: string | undefined, registrationTokenHash: string | undefined, productDbUri: string | undefined, productDbOptions: { maxPoolSize: number, minPoolSize: number, maxIdleTimeMS: number, serverSelectionTimeoutMS: number }, logLevel: string, outboundAllowHosts: string[] }}
 *   `outboundAllowHosts` comes from `SS_OUTBOUND_ALLOW_HOSTS` (comma-separated; development only — ignored in production);
 *   `productDbOptions` are the `MongoClient` options of the product's control database: a small pool for serverless
 *   (`SS_PRODUCT_DB_MAX_POOL_SIZE`, default {@link CONTROL_DB_POOL_SIZE}), idle connections closed after a minute
 */
/** Default pool of the product's control-database client per instance (many instances share one Atlas M0 cluster). */
export const CONTROL_DB_POOL_SIZE = 5;

/** @param {string | undefined} value */
const poolSizeOf = (value) => {
	const n = Number(value);
	return Number.isInteger(n) && n >= 1 && n <= 100 ? n : CONTROL_DB_POOL_SIZE;
};

export const configFromEnv = (env = process.env) => ({
	portalUrl: env.SS_PORTAL_URL,
	appId: env.SS_APP_ID && env.SS_APP_ID.length > 0 ? env.SS_APP_ID : null,
	signingKey: env.SS_APP_SIGNING_KEY,
	registrationTokenHash: env.SS_REGISTRATION_TOKEN_HASH,
	productDbUri: env.SS_PRODUCT_DB_URI,
	productDbOptions: {
		maxPoolSize: poolSizeOf(env.SS_PRODUCT_DB_MAX_POOL_SIZE),
		minPoolSize: 0,
		maxIdleTimeMS: 60_000,
		serverSelectionTimeoutMS: 5_000,
	},
	logLevel: env.SS_LOG_LEVEL ?? 'info',
	outboundAllowHosts: (env.SS_OUTBOUND_ALLOW_HOSTS ?? '')
		.split(',')
		.map((host) => host.trim())
		.filter((host) => host !== ''),
});
