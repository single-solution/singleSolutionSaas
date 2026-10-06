/**
 * Read the product's environment (names in API.md). Values are returned as-is; `createProduct` validates them.
 * Dependency-free: the Next.js proxy (`@ss/app-kit/proxy`) imports it.
 * @module
 */

/** Pool of the product's control-database client per instance (many instances share one Atlas M0 cluster). */
export const CONTROL_DB_POOL_SIZE = 5;

/**
 * The product's environment: its own control database (`DATABASE_URI`) and the deployer's `CONNECT_SECRET` (≥ 32
 * characters; without it the product refuses connection attempts). A Portal connects at `POST /.well-known/ss-connect`
 * with that secret; the Portal URL, the appId, the signing key and generated secrets are kept in the database.
 * @param {Record<string, string | undefined>} [env] defaults to `process.env`
 * @returns {{ productDbUri: string | undefined, connectSecret: string | undefined, problems: string[], productDbOptions: { maxPoolSize: number, minPoolSize: number, maxIdleTimeMS: number, serverSelectionTimeoutMS: number }, logLevel: string, outboundAllowHosts: string[] }}
 *   `problems`: {@link configProblems} (pass them to `createProduct`); `productDbOptions`: a small pool for serverless ({@link CONTROL_DB_POOL_SIZE} connections),
 *   idle connections closed after a minute; `outboundAllowHosts` from the optional development-only
 *   `OUTBOUND_DEV_ALLOW_HOSTS` (ignored in production); `logLevel` is `info` in production, `debug` elsewhere
 */
export const configFromEnv = (env = process.env) => ({ ...configOf(env), problems: configProblems(env) });

/** Problem reported when a production deployment has no control database. */
export const DATABASE_URI_REQUIRED = "DATABASE_URI is required in production: set it to this product's own database.";

/**
 * Why this environment cannot serve: one sentence per problem, naming variables, never their values. A product with
 * problems still starts (`createProduct({ problems })`) and answers every route with 503 and these sentences.
 * @param {Record<string, string | undefined>} [env] defaults to `process.env`
 * @returns {string[]}
 */
export const configProblems = (env = process.env) => {
	/** @type {string[]} */
	const problems = [];
	// in production the connection, keys and queues must survive restarts and be shared by instances: no in-memory
	// fallback (the build itself runs without the database)
	if (env.NODE_ENV === 'production' && !env.DATABASE_URI && env.NEXT_PHASE !== 'phase-production-build')
		problems.push(DATABASE_URI_REQUIRED);
	return problems;
};

/** @param {Record<string, string | undefined>} env */
const configOf = (env) => ({
	productDbUri: env.DATABASE_URI,
	connectSecret: env.CONNECT_SECRET || undefined,
	productDbOptions: {
		maxPoolSize: CONTROL_DB_POOL_SIZE,
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
