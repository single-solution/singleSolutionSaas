/**
 * Server-to-server calls to the merchant's other products, only through their public APIs and only through app-kit's
 * SSRF-guarded `product.outbound.fetch` (public https, DNS answers vetted at connect time, no redirects, deadline, size
 * cap). Base URLs come from the website's settings (`offer_apply.coupons_url`, `deals_url`, `loyalty_redeem.loyalty_url`,
 * `cart.catalog_url`); the server key is the merchant's own `sk_` key, sealed in their database (adapters/secrets.js).
 * No other product's code is imported.
 *
 * GAP: neither the kit nor the Portal can tell a product another product's API base for the same website, so the
 * merchant sets the URLs.
 *
 * Every call answers `{ ok: true, status, json }` or `{ ok: false, reason, status?, code? }` — never throws — so
 * checkout keeps working (without the offer) when a product is down, and placement can compensate.
 */

/**
 * @typedef {{ base: string, key: string }} Connection
 * @typedef {{ ok: true, status: number, json: any } | { ok: false, reason: 'not_configured' | 'unreachable' | 'refused', status?: number, code?: string }} CallResult
 */

/**
 * @param {{ send: (url: string, init: Record<string, unknown>) => Promise<{ status: number, body: Buffer | Uint8Array }>, timeoutMs?: number }} deps
 */
export const createIntegrations = ({ send, timeoutMs = 8_000 }) => {
	/**
	 * @param {Connection | null} connection
	 * @param {string} method
	 * @param {string} path absolute path on the product (`/v1/quotes`)
	 * @param {{ body?: unknown, idempotencyKey?: string, identity?: string | null }} [options]
	 * @returns {Promise<CallResult>}
	 */
	const call = async (connection, method, path, { body, idempotencyKey, identity } = {}) => {
		if (!connection?.base || !connection.key) return { ok: false, reason: 'not_configured' };
		/** @type {Record<string, string>} */
		const headers = { accept: 'application/json', authorization: `Bearer ${connection.key}` };
		if (body !== undefined) headers['content-type'] = 'application/json';
		if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
		if (identity) headers['ss-identity'] = identity;
		try {
			const response = await send(`${connection.base.replace(/\/+$/, '')}${path}`, {
				method,
				headers,
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				redirect: 'error',
				timeoutMs,
			});
			const text = Buffer.from(response.body).toString('utf8');
			/** @type {any} */
			let json = null;
			try {
				json = text ? JSON.parse(text) : null;
			} catch {
				json = null;
			}
			if (response.status >= 200 && response.status < 300) return { ok: true, status: response.status, json };
			const type = typeof json?.type === 'string' ? json.type : '';
			return {
				ok: false,
				reason: 'refused',
				status: response.status,
				code: type.split('/').pop() || `http_${response.status}`,
			};
		} catch {
			return { ok: false, reason: 'unreachable' };
		}
	};

	return Object.freeze({
		call,
		coupons: Object.freeze({
			/** @param {Connection | null} c @param {{ codes: string[], cart: Record<string, unknown> }} body */
			quote: (c, body) => call(c, 'POST', '/v1/quotes', { body }),
			/** @param {Connection | null} c @param {Record<string, unknown>} body @param {string} key */
			reserve: (c, body, key) => call(c, 'POST', '/v1/reservations', { body, idempotencyKey: key }),
			/** @param {Connection | null} c @param {string} id @param {string} orderId @param {string} key */
			redeem: (c, id, orderId, key) =>
				call(c, 'POST', `/v1/reservations/${encodeURIComponent(id)}/redeem`, { body: { orderId }, idempotencyKey: key }),
			/** @param {Connection | null} c @param {string} id @param {string} key */
			release: (c, id, key) =>
				call(c, 'POST', `/v1/reservations/${encodeURIComponent(id)}/release`, { body: {}, idempotencyKey: key }),
		}),
		deals: Object.freeze({
			/** @param {Connection | null} c @param {Record<string, unknown>} body @param {string} key */
			quote: (c, body, key) => call(c, 'POST', '/v1/quotes', { body, idempotencyKey: key }),
			/** @param {Connection | null} c @param {string} id @param {Record<string, unknown>} body @param {string} key */
			commit: (c, id, body, key) =>
				call(c, 'POST', `/v1/quotes/${encodeURIComponent(id)}/commit`, { body, idempotencyKey: key }),
			/** @param {Connection | null} c @param {string} id @param {string} key */
			release: (c, id, key) =>
				call(c, 'POST', `/v1/quotes/${encodeURIComponent(id)}/release`, { body: {}, idempotencyKey: key }),
		}),
		loyalty: Object.freeze({
			/** @param {Connection | null} c @param {Record<string, unknown>} body */
			quote: (c, body) => call(c, 'POST', '/v1/redemptions:quote', { body }),
			/** @param {Connection | null} c @param {Record<string, unknown>} body @param {string} key */
			redeem: (c, body, key) => call(c, 'POST', '/v1/redemptions', { body, idempotencyKey: key }),
			/** @param {Connection | null} c @param {string} id @param {string} key */
			release: (c, id, key) =>
				call(c, 'POST', `/v1/redemptions/${encodeURIComponent(id)}/release`, { body: {}, idempotencyKey: key }),
		}),
		catalog: Object.freeze({
			/** @param {Connection | null} c @param {string} ref */
			item: (c, ref) => call(c, 'GET', `/v1/items/${encodeURIComponent(ref)}`),
			/** @param {Connection | null} c @param {Record<string, unknown>} body @param {string} key */
			reserve: (c, body, key) => call(c, 'POST', '/v1/stock-reservations', { body, idempotencyKey: key }),
			/** @param {Connection | null} c @param {string} id */
			release: (c, id) => call(c, 'DELETE', `/v1/stock-reservations/${encodeURIComponent(id)}`),
		}),
	});
};

/** @typedef {ReturnType<typeof createIntegrations>} Integrations */
