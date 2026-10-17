/**
 * Calls to the products with a website's server token: the import routes (K10) and, with the sign-in of the staff member who
 * runs the migration, the settings API (K1) and the count routes.
 * @module
 */

/**
 * @typedef {{ url: string, token: string, signIn?: string }} ProductTarget the product's address and the website's server
 *   token; `signIn`: the Accounts sign-in of the staff member who runs the migration. The import routes (K10) are the
 *   importer's own and take the server token alone, while the `import` feature is on. The settings, the Format and the
 *   lists it carries over, and the count routes it compares, are a staff member's: they go with this sign-in (it lasts
 *   15 minutes: a long run renews it with a new `SS_IMPORT_SIGN_IN_<ID>`), and without one the product refuses them.
 */
/** @typedef {{ ok: boolean, status: number, headers: Headers, json: any }} ProductAnswer */

/**
 * An answer a product refused (not a failed record: the whole call).
 * @param {string} message
 * @param {Record<string, unknown>} details
 */
export const importError = (message, details) => Object.assign(new Error(message), { name: 'ImportError', details });

/**
 * The target of a product, or a clear error.
 * @param {Record<string, ProductTarget>} products
 * @param {string} product
 */
export const targetOf = (products, product) => {
	const target = products[product];
	if (!target) throw importError(`No address or server token for ${product}.`, { product });
	return target;
};

/**
 * A call to a product with its server token; its answer, whatever the status.
 * @param {typeof globalThis.fetch} fetch
 * @param {ProductTarget} target
 * @param {string} method
 * @param {string} route
 * @param {{ body?: string, type?: string }} [init]
 * @returns {Promise<ProductAnswer>}
 */
export const requestProduct = async (fetch, target, method, route, { body, type } = {}) => {
	const response = await fetch(`${target.url.replace(/\/+$/, '')}${route}`, {
		method,
		headers: {
			authorization: `Bearer ${target.token}`,
			accept: 'application/json',
			...(type ? { 'content-type': type } : {}),
			...(target.signIn && !route.startsWith('/v1/import/') ? { 'ss-sign-in': target.signIn } : {}),
		},
		...(body === undefined ? {} : { body }),
	});
	const text = await response.text();
	/** @type {any} */
	let json = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		json = null;
	}
	return { ok: response.ok, status: response.status, headers: response.headers, json };
};

/**
 * A JSON call to a product with its server token; a refused call throws.
 * @param {typeof globalThis.fetch} fetch
 * @param {ProductTarget} target
 * @param {string} method
 * @param {string} route
 * @param {{ body?: string, type?: string }} [init]
 */
export const callProduct = async (fetch, target, method, route, init = {}) => {
	const answer = await requestProduct(fetch, target, method, route, init);
	if (!answer.ok)
		throw importError(`${method} ${route} answered ${answer.status}${answer.json?.detail ? `: ${answer.json.detail}` : ''}`, {
			status: answer.status,
			problem: answer.json,
		});
	return answer.json;
};
