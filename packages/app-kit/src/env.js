/**
 * Read the product's environment (names in API.md). Values are returned as-is; `createProduct` validates them.
 * @module
 */

/** Default pool of the product's control-database client per instance (many instances share one Atlas M0 cluster). */
export const CONTROL_DB_POOL_SIZE = 5;

/** @param {string | undefined} value */
const poolSizeOf = (value) => {
	const n = Number(value);
	return Number.isInteger(n) && n >= 1 && n <= 100 ? n : CONTROL_DB_POOL_SIZE;
};

/**
 * The product's environment: its own control database (`DATABASE_URI`) and the deployer's `CONNECT_SECRET` (≥ 32
 * characters; without it the product refuses connection attempts). A Portal connects at `POST /.well-known/ss-connect`
 * with that secret; the Portal URL, the appId, the signing key and generated secrets are kept in the database.
 * @param {Record<string, string | undefined>} [env] defaults to `process.env`
 * @returns {{ productDbUri: string | undefined, connectSecret: string | undefined, productDbOptions: { maxPoolSize: number, minPoolSize: number, maxIdleTimeMS: number, serverSelectionTimeoutMS: number }, logLevel: string, outboundAllowHosts: string[] }}
 *   `productDbOptions`: a small pool for serverless (optional `DATABASE_MAX_POOL_SIZE`, default {@link CONTROL_DB_POOL_SIZE}),
 *   idle connections closed after a minute; `outboundAllowHosts` from the optional development-only
 *   `OUTBOUND_DEV_ALLOW_HOSTS` (ignored in production); `logLevel` is `info` in production, `debug` elsewhere
 */
export const configFromEnv = (env = process.env) => {
	// in production the connection, keys and queues must survive restarts and be shared by instances: no in-memory
	// fallback (the build itself runs without the database)
	if (env.NODE_ENV === 'production' && !env.DATABASE_URI && env.NEXT_PHASE !== 'phase-production-build')
		throw new Error("DATABASE_URI is required in production: set it to this product's own database.");
	return configOf(env);
};

/** @param {Record<string, string | undefined>} env */
const configOf = (env) => ({
	productDbUri: env.DATABASE_URI,
	connectSecret: env.CONNECT_SECRET || undefined,
	productDbOptions: {
		maxPoolSize: poolSizeOf(env.DATABASE_MAX_POOL_SIZE),
		minPoolSize: 0,
		maxIdleTimeMS: 60_000,
		serverSelectionTimeoutMS: 5_000,
	},
	logLevel: env.LOG_LEVEL ?? (env.NODE_ENV === 'production' ? 'info' : 'debug'),
	outboundAllowHosts: (env.OUTBOUND_DEV_ALLOW_HOSTS ?? '')
		.split(',')
		.map((host) => host.trim())
		.filter((host) => host !== ''),
});
