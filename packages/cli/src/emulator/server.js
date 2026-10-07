/**
 * node:http server for the emulated Portal: public JWKS, the `/v1/product/*` API, and a local admin API under
 * `/_dev/*` (loopback only, `x-ss-dev-token` required) used by `ss dev connect|launch|keys|emit|settle`.
 * The server can be stopped and started again on the same port (offline-grace certification).
 * @module
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { headerMap, isLoopback, readBody, sendJson } from '../http.js';
import { isObject } from '../fsutil.js';

/** @typedef {import('./portal.js').Portal} Portal */

/**
 * @param {unknown} error
 * @returns {{ status: number, body: Record<string, unknown> }}
 */
const adminError = (error) => {
	const code = /** @type {{ code?: unknown }} */ (error).code;
	const status =
		code === 'unknown_app' || code === 'unknown_website' || code === 'unknown_key' || code === 'not_registered'
			? 404
			: code === 'connection_rejected'
				? 502
				: 400;
	return { status, body: { error: typeof code === 'string' ? code : 'error', message: /** @type {Error} */ (error).message } };
};

/**
 * Admin operations (`/_dev/<name>`).
 * @param {Portal} portal
 * @param {string} name
 * @param {Record<string, any>} input
 * @returns {Promise<unknown>}
 */
const admin = async (portal, name, input) => {
	switch (name) {
		case 'connect':
			return portal.connect({ url: String(input.url ?? ''), secret: String(input.secret ?? '') });
		case 'launch':
			return portal.launch(/** @type {any} */ (input));
		case 'keys':
			return input.websiteId || input.rotate
				? portal.issueKeys(input.websiteId ? { websiteId: String(input.websiteId) } : {})
				: portal.websiteKeys();
		case 'revoke':
			return portal.revokeKey(String(input.keyId ?? ''));
		case 'emit': {
			const result = await portal.emit(/** @type {any} */ (input));
			return { status: result.status, body: result.body, event: result.event };
		}
		case 'settle':
			return portal.settle({ hours: Number(input.hours ?? 1) });
		case 'entitlements':
			return portal.setEntitlement(/** @type {any} */ (input));
		case 'subscription':
			return portal.setSubscriptionStatus(/** @type {any} */ (input));
		case 'resource':
			return portal.setResource(/** @type {any} */ (input));
		case 'identity':
			return input.websiteId
				? portal.decideIdentityRequest({ websiteId: String(input.websiteId), decision: String(input.decision ?? '') })
				: { requests: portal.identityRequests(), issuers: portal.identityIssuers() };
		case 'state':
			return {
				portalUrl: portal.portalUrl,
				apps: portal.apps().map((app) => ({
					appId: app.appId,
					slug: app.manifest.product.slug,
					baseUrl: app.baseUrl,
					kids: app.keys.map((key) => key.kid),
					registeredAt: app.registeredAt,
				})),
				websites: portal.fixture().websites,
				subscriptions: portal.fixture().subscriptions,
				usage: portal.usage(),
				published: portal.published(),
				heartbeats: portal.heartbeats(),
				identityRequests: portal.identityRequests(),
			};
		default:
			throw Object.assign(new Error(`unknown admin operation ${name}`), { code: 'unknown_operation' });
	}
};

/**
 * @param {{ portal: Portal, host?: string, port?: number, adminToken?: string, log?: (line: string) => void }} options
 */
export const createEmulatorServer = ({
	portal,
	host = '127.0.0.1',
	port,
	adminToken = randomBytes(24).toString('base64url'),
	log = () => {},
}) => {
	const listenPort = port ?? Number(new URL(portal.portalUrl).port || 80);

	/** @type {import('node:http').RequestListener} */
	const listener = async (request, response) => {
		const url = new URL(request.url ?? '/', 'http://emulator.local');
		const method = request.method ?? 'GET';
		try {
			if (method === 'GET' && url.pathname === '/.well-known/jwks.json')
				return sendJson(response, 200, portal.jwks(), { 'cache-control': 'max-age=60' });
			if (url.pathname.startsWith('/v1/product/')) {
				const raw = method === 'GET' ? '' : await readBody(request);
				/** @type {unknown} */
				let body;
				try {
					body = raw ? JSON.parse(raw) : undefined;
				} catch {
					return sendJson(
						response,
						400,
						{ type: 'about:blank', title: 'Bad request', status: 400, detail: 'body is not JSON' },
						{ 'content-type': 'application/problem+json' },
					);
				}
				const result = await portal.handleProduct({
					method,
					path: url.pathname,
					query: url.searchParams,
					headers: headerMap(request.headers),
					body,
				});
				return sendJson(response, result.status, result.body, result.headers);
			}
			if (url.pathname.startsWith('/_dev/')) {
				if (!isLoopback(request.socket.remoteAddress)) return sendJson(response, 403, { error: 'forbidden' });
				if (request.headers['x-ss-dev-token'] !== adminToken) return sendJson(response, 401, { error: 'unauthorized' });
				const raw = method === 'GET' ? '' : await readBody(request);
				const parsed = raw ? JSON.parse(raw) : {};
				try {
					return sendJson(
						response,
						200,
						await admin(portal, url.pathname.slice('/_dev/'.length), isObject(parsed) ? parsed : {}),
					);
				} catch (error) {
					const { status, body } = adminError(error);
					return sendJson(response, status, body);
				}
			}
			return sendJson(
				response,
				404,
				{ type: 'about:blank', title: 'Not found', status: 404 },
				{ 'content-type': 'application/problem+json' },
			);
		} catch (error) {
			log(`error  ${method} ${url.pathname}: ${/** @type {Error} */ (error).message}`);
			if (!response.headersSent)
				sendJson(
					response,
					500,
					{ type: 'about:blank', title: 'Internal error', status: 500 },
					{ 'content-type': 'application/problem+json' },
				);
		}
	};

	/** @type {import('node:http').Server | null} */
	let server = null;

	return Object.freeze({
		adminToken,
		get port() {
			const address = server?.address();
			return typeof address === 'object' && address !== null ? address.port : listenPort;
		},
		/** @returns {Promise<{ url: string, port: number }>} */
		start: () =>
			new Promise((resolve, reject) => {
				if (server) {
					resolve({ url: portal.portalUrl, port: listenPort });
					return;
				}
				const created = createServer((request, response) => {
					void listener(request, response);
				});
				created.once('error', (error) => {
					server = null;
					reject(error);
				});
				created.listen(listenPort, host, () => {
					server = created;
					const address = created.address();
					resolve({
						url: portal.portalUrl,
						port: typeof address === 'object' && address !== null ? address.port : listenPort,
					});
				});
			}),
		/** @returns {Promise<void>} */
		stop: () =>
			new Promise((resolve) => {
				const current = server;
				server = null;
				if (!current) {
					resolve();
					return;
				}
				current.close(() => resolve());
				current.closeAllConnections();
			}),
	});
};

/** @typedef {ReturnType<typeof createEmulatorServer>} EmulatorServer */
