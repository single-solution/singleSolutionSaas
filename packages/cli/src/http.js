/**
 * Minimal node:http helpers shared by the emulator server: bounded body reading, JSON replies, header maps.
 * @module
 */

/** Largest request body accepted (bytes). */
export const MAX_BODY_BYTES = 1_000_000;

/**
 * Read a request body (bounded).
 * @param {import('node:http').IncomingMessage} request
 * @param {number} [limit]
 * @returns {Promise<string>}
 */
export const readBody = (request, limit = MAX_BODY_BYTES) =>
	new Promise((resolve, reject) => {
		/** @type {Buffer[]} */
		const chunks = [];
		let size = 0;
		request.on('data', (/** @type {Buffer} */ chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(Object.assign(new Error('payload too large'), { code: 'payload_too_large' }));
				request.destroy();
			} else chunks.push(chunk);
		});
		request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		request.on('error', reject);
	});

/**
 * Lower-case single-valued header map (duplicates joined like node does for most headers).
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @returns {Record<string, string | undefined>}
 */
export const headerMap = (headers) =>
	Object.fromEntries(
		Object.entries(headers).map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value.join(', ') : value]),
	);

/**
 * Write a JSON response.
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 */
export const sendJson = (response, status, body, headers = {}) => {
	const text = JSON.stringify(body);
	response.writeHead(status, {
		'content-type': 'application/json',
		'cache-control': 'no-store',
		...headers,
		'content-length': String(Buffer.byteLength(text)),
	});
	response.end(text);
};

/**
 * True for loopback peers.
 * @param {string | undefined} address
 * @returns {boolean}
 */
export const isLoopback = (address) => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
