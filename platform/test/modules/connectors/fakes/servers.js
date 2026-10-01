/**
 * Local fake providers for connection checks: an S3-compatible object store and a JSON HTTP API (models list),
 * plus an SMTP greeter. They listen on 127.0.0.1 (admitted only through the test allowlist).
 */
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';

/** @param {import('node:http').Server | import('node:net').Server} server */
const listen = (server) =>
	new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => resolve(/** @type {import('node:net').AddressInfo} */ (server.address()).port));
	});

/**
 * @param {{ accessKeyId: string, deny?: 'auth' | 'permission' | 'bucket' | null, corrupt?: boolean }} options
 */
export const startFakeS3 = async (options) => {
	/** @type {Map<string, Buffer>} */
	const objects = new Map();
	/** @type {Array<{ method: string, url: string, authorization: string }>} */
	const requests = [];
	const server = createServer((req, res) => {
		/** @type {Buffer[]} */
		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => {
			const authorization = String(req.headers.authorization ?? '');
			requests.push({ method: String(req.method), url: String(req.url), authorization });
			const fail = (/** @type {number} */ status, /** @type {string} */ code) => {
				res.writeHead(status, { 'content-type': 'application/xml' });
				res.end(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>no</Message></Error>`);
			};
			if (!authorization.includes(`Credential=${options.accessKeyId}/`) || options.deny === 'auth')
				return fail(403, 'InvalidAccessKeyId');
			if (options.deny === 'permission') return fail(403, 'AccessDenied');
			if (options.deny === 'bucket') return fail(404, 'NoSuchBucket');
			const key = String(req.url);
			if (req.method === 'PUT') {
				objects.set(key, Buffer.concat(chunks));
				res.writeHead(200);
				return res.end();
			}
			if (req.method === 'GET') {
				const body = objects.get(key);
				if (!body) return fail(404, 'NoSuchKey');
				res.writeHead(200, { 'content-type': 'text/plain' });
				return res.end(options.corrupt ? 'different' : body);
			}
			if (req.method === 'DELETE') {
				objects.delete(key);
				res.writeHead(204);
				return res.end();
			}
			return fail(405, 'MethodNotAllowed');
		});
	});
	const port = await listen(server);
	return {
		endpoint: `http://127.0.0.1:${port}`,
		objects,
		requests,
		options,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve(undefined));
			}),
	};
};

/**
 * JSON API answering 200 to an exact credential header, 401 otherwise.
 * @param {{ header: string, value: string, status?: number, delayMs?: number, bigBody?: boolean, redirectTo?: string }} options
 */
export const startFakeApi = async (options) => {
	/** @type {Array<{ method: string, url: string, headers: import('node:http').IncomingHttpHeaders }>} */
	const requests = [];
	const server = createServer((req, res) => {
		requests.push({ method: String(req.method), url: String(req.url), headers: req.headers });
		const respond = () => {
			if (options.redirectTo) {
				res.writeHead(302, { location: options.redirectTo });
				return res.end();
			}
			if (options.bigBody) {
				res.writeHead(200, { 'content-type': 'application/json' });
				return res.end(`{"data":"${'x'.repeat(200_000)}"}`);
			}
			if (req.headers[options.header] !== options.value) {
				res.writeHead(401, { 'content-type': 'application/json' });
				return res.end('{"error":"bad key sk-echoed-back"}');
			}
			res.writeHead(options.status ?? 200, { 'content-type': 'application/json' });
			return res.end('{"data":[]}');
		};
		if (options.delayMs) setTimeout(respond, options.delayMs);
		else respond();
	});
	const port = await listen(server);
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		requests,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve(undefined));
			}),
	};
};

/** @param {{ greeting?: string }} [options] */
export const startFakeSmtp = async ({ greeting = '220 mail.example.com ESMTP ready\r\n' } = {}) => {
	/** @type {Set<import('node:net').Socket>} */
	const sockets = new Set();
	const server = createTcpServer((socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		socket.on('error', () => {});
		socket.resume();
		if (greeting) socket.write(greeting);
	});
	const port = await listen(server);
	return {
		port,
		close: () =>
			new Promise((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve(undefined));
			}),
	};
};
