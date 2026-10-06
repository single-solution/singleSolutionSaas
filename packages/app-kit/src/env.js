/**
 * Read the product's environment (names in API.md). Values are returned as-is; `createProduct` validates them.
 * @module
 */

/**
 * @param {Record<string, string | undefined>} [env] defaults to `process.env`
 * @returns {{ portalUrl: string | undefined, appId: string | null, signingKey: string | undefined, registrationTokenHash: string | undefined, productDbUri: string | undefined, productDbOptions: { maxPoolSize: number, minPoolSize: number, maxIdleTimeMS: number, serverSelectionTimeoutMS: number }, logLevel: string, outboundAllowHosts: string[] }}
 *   `outboundAllowHosts` comes from `OUTBOUND_DEV_ALLOW_HOSTS` (comma-separated; development only — ignored in production);
 *   `productDbOptions` are the `MongoClient` options of the product's control database: a small pool for serverless
 *   (`DATABASE_MAX_POOL_SIZE`, default {@link CONTROL_DB_POOL_SIZE}), idle connections closed after a minute
 */
/** Default pool of the product's control-database client per instance (many instances share one Atlas M0 cluster). */
export const CONTROL_DB_POOL_SIZE = 5;

/** @param {string | undefined} value */
const poolSizeOf = (value) => {
	const n = Number(value);
	return Number.isInteger(n) && n >= 1 && n <= 100 ? n : CONTROL_DB_POOL_SIZE;
};

export const configFromEnv = (env = process.env) => ({
	portalUrl: env.PORTAL_URL,
	appId: env.APP_ID && env.APP_ID.length > 0 ? env.APP_ID : null,
	signingKey: env.SIGNING_KEY,
	registrationTokenHash: env.REGISTRATION_TOKEN_HASH,
	productDbUri: env.DATABASE_URI,
	productDbOptions: {
		maxPoolSize: poolSizeOf(env.DATABASE_MAX_POOL_SIZE),
		minPoolSize: 0,
		maxIdleTimeMS: 60_000,
		serverSelectionTimeoutMS: 5_000,
	},
	// info in production, debug elsewhere; LOG_LEVEL overrides (undocumented, tests use it to stay quiet)
	logLevel: env.LOG_LEVEL ?? (env.NODE_ENV === 'production' ? 'info' : 'debug'),
	outboundAllowHosts: (env.OUTBOUND_DEV_ALLOW_HOSTS ?? '')
		.split(',')
		.map((host) => host.trim())
		.filter((host) => host !== ''),
});
