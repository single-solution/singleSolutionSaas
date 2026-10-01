/**
 * Read the product's environment (names in API.md). Values are returned as-is; `createProduct` validates them.
 * @module
 */

/**
 * @param {Record<string, string | undefined>} [env] defaults to `process.env`
 * @returns {{ portalUrl: string | undefined, appId: string | null, signingKey: string | undefined, registrationTokenHash: string | undefined, productDbUri: string | undefined, logLevel: string, outboundAllowHosts: string[] }}
 *   `outboundAllowHosts` comes from `SS_OUTBOUND_ALLOW_HOSTS` (comma-separated; development only — ignored in production)
 */
export const configFromEnv = (env = process.env) => ({
	portalUrl: env.SS_PORTAL_URL,
	appId: env.SS_APP_ID && env.SS_APP_ID.length > 0 ? env.SS_APP_ID : null,
	signingKey: env.SS_APP_SIGNING_KEY,
	registrationTokenHash: env.SS_REGISTRATION_TOKEN_HASH,
	productDbUri: env.SS_PRODUCT_DB_URI,
	logLevel: env.SS_LOG_LEVEL ?? 'info',
	outboundAllowHosts: (env.SS_OUTBOUND_ALLOW_HOSTS ?? '')
		.split(',')
		.map((host) => host.trim())
		.filter((host) => host !== ''),
});
