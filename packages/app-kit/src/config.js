/**
 * The product's environment (PLAN 0.11): exactly `MONGODB_URI`, `CONNECT_SECRET` and `ENCRYPTION_KEY`. Problems name
 * the variable, never its value. A product with problems still starts (`createProduct({ problems })`) and answers every
 * route with 503 and these sentences.
 * @module
 */

/** Shortest accepted `CONNECT_SECRET` and `ENCRYPTION_KEY`. */
export const MIN_SECRET_LENGTH = 32;

/** @typedef {{ mongodbUri: string, connectSecret: string, encryptionKey: string }} ProductConfig */

/**
 * @param {Record<string, string | undefined>} [env] defaults to `process.env`
 * @returns {{ config: ProductConfig, problems: string[] }}
 */
export const configFromEnv = (env = process.env) => {
	const mongodbUri = env.MONGODB_URI ?? '';
	const connectSecret = env.CONNECT_SECRET ?? '';
	const encryptionKey = env.ENCRYPTION_KEY ?? '';
	/** @type {string[]} */
	const problems = [];
	if (!/^mongodb(\+srv)?:\/\/\S+$/.test(mongodbUri))
		problems.push('MONGODB_URI is missing or is not a MongoDB connection string.');
	if (connectSecret.length < MIN_SECRET_LENGTH)
		problems.push(`CONNECT_SECRET is missing or shorter than ${MIN_SECRET_LENGTH} characters.`);
	if (encryptionKey.length < MIN_SECRET_LENGTH)
		problems.push(`ENCRYPTION_KEY is missing or shorter than ${MIN_SECRET_LENGTH} characters.`);
	return { config: { mongodbUri, connectSecret, encryptionKey }, problems };
};
