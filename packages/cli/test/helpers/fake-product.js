/**
 * A minimal SSPS service product built directly on @ss/protocol (stand-in for an app-kit product) used to test the
 * emulator end to end and the certification suite. `broken` switches individual behaviours off so tests can prove
 * that certify detects each failure.
 */
import { createServer } from 'node:http';
import { validateEvent } from '@ss/contracts';
import {
	createConnectResponse,
	createKeyResolver,
	createMemoryReplayStore,
	createSigner,
	originAllowed,
	signAssertion,
	toPublicJwk,
	verifyConnectRequest,
	verifyEntitlementDocument,
	verifyEvent,
	verifyLaunch,
	verifyRequest,
	verifyWebsiteKey,
} from '@ss/protocol';

/**
 * @param {import('node:http').IncomingMessage} request
 * @returns {Promise<string>}
 */
const readBody = (request) =>
	new Promise((resolve) => {
		/** @type {Buffer[]} */
		const chunks = [];
		request.on('data', (/** @type {Buffer} */ chunk) => chunks.push(chunk));
		request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
	});

/** The CONNECT_SECRET fake products run with (unless a test passes another). */
export const FAKE_SECRET = 'fake-product-connect-secret-0123456789abcdef';

/**
 * @param {{ manifest: any, portalUrl: string, signingKey: any, broken?: Record<string, boolean>, fetch?: typeof fetch,
 *   secret?: string }} options
 */
export const createFakeProduct = ({
	manifest,
	portalUrl,
	signingKey,
	broken = {},
	fetch = globalThis.fetch,
	secret = FAKE_SECRET,
}) => {
	const signer = createSigner(signingKey);
	const publicJwk = toPublicJwk(signingKey);
	const portalKeys = createKeyResolver({
		fetchJwks: async () => (await fetch(`${portalUrl}/.well-known/jwks.json`)).json(),
		minRefreshIntervalMs: 0,
	});
	const launchStore = createMemoryReplayStore();
	const eventReplay = createMemoryReplayStore();
	const portalCallReplay = createMemoryReplayStore();
	const connectNonces = createMemoryReplayStore();
	let pkReads = 0;
	/** @type {string | null} */
	let appId = null;
	/** @type {Map<string, any>} */
	const entitlements = new Map();
	/** @type {Map<string, { status: number, body: unknown }>} */
	const idempotency = new Map();
	/** @type {Map<string, Array<{ id: string, text: string }>>} */
	const notes = new Map();
	/** @type {Map<string, number>} */
	const effects = new Map();
	/** @type {Set<string>} */
	const seenEvents = new Set();
	/** @type {Set<string>} */
	const revoked = new Set();
	/** @type {Map<string, any>} */
	const sessions = new Map();
	let counter = 0;

	/**
	 * Signed Portal call (client assertion).
	 * @param {string} path
	 * @param {{ method?: string, body?: unknown }} [init]
	 */
	const portal = async (path, { method = 'GET', body } = {}) => {
		const assertion = await signAssertion({ signer, appId: /** @type {string} */ (appId), audience: portalUrl });
		const response = await fetch(`${portalUrl}${path}`, {
			method,
			headers: { authorization: `Bearer ${assertion}`, 'content-type': 'application/json' },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		return { status: response.status, json: await response.json() };
	};

	/** @param {string} websiteId */
	const entitlementFor = async (websiteId) => {
		if (entitlements.has(websiteId) && !broken.offlineGrace) return entitlements.get(websiteId);
		try {
			const result = await portal(`/v1/product/entitlements?websiteId=${websiteId}`);
			if (result.status !== 200) return entitlements.get(websiteId) ?? null;
			const verified = await verifyEntitlementDocument({ token: result.json.document, keyResolver: portalKeys });
			entitlements.set(websiteId, verified.payload);
			return verified.payload;
		} catch {
			return broken.offlineGrace ? null : (entitlements.get(websiteId) ?? null);
		}
	};

	/**
	 * @param {import('node:http').ServerResponse} response
	 * @param {number} status
	 * @param {unknown} body
	 * @param {Record<string, string>} [headers]
	 */
	const send = (response, status, body, headers = {}) => {
		response.writeHead(status, { 'content-type': 'application/json', ...headers });
		response.end(JSON.stringify(body));
	};
	/**
	 * @param {import('node:http').ServerResponse} response
	 * @param {number} status
	 * @param {string} code
	 */
	const problem = (response, status, code) =>
		send(
			response,
			status,
			broken.problems ? { error: code } : { type: `https://errors.test/${code}`, title: code, status },
			broken.problems ? {} : { 'content-type': 'application/problem+json' },
		);

	/**
	 * @param {Record<string, string | string[] | undefined>} headers
	 * @param {string} raw
	 */
	const portalSigned = async (
		/** @type {any} */ headers,
		/** @type {string} */ raw,
		/** @type {string} */ method,
		/** @type {string} */ path,
	) => {
		try {
			await verifyRequest({
				method,
				path,
				audience: /** @type {string} */ (appId),
				headers,
				rawBody: raw,
				keyResolver: portalKeys,
				replayStore: portalCallReplay,
			});
			return true;
		} catch {
			return false;
		}
	};

	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? '/', 'http://product');
		const method = request.method ?? 'GET';
		const raw = method === 'GET' ? '' : await readBody(request);
		const route = `${method} ${url.pathname}`;
		if (route === 'GET /.well-known/ss-app.json') return send(response, 200, manifest);
		if (route === 'POST /.well-known/ss-connect') {
			/** @type {ReturnType<typeof verifyConnectRequest>} */
			let connect;
			try {
				connect = verifyConnectRequest({ secret, headers: /** @type {any} */ (request.headers), body: raw });
			} catch {
				return send(response, 401, { error: 'unauthorized' });
			}
			if (await connectNonces.seen(`ss-connect|${connect.nonce}`, Date.now() + 900_000))
				return send(response, 401, { error: 'unauthorized' });
			if (connect.portalUrl !== portalUrl) return send(response, 401, { error: 'unauthorized' });
			appId = connect.appId;
			const answer = createConnectResponse({ secret, appId, nonce: connect.nonce, publicJwk, manifest });
			response.writeHead(200, answer.headers);
			return void response.end(answer.body);
		}
		if (route === 'POST /.well-known/ss-events') {
			try {
				await verifyEvent({
					headers: /** @type {any} */ (request.headers),
					rawBody: raw,
					keyResolver: portalKeys,
					replayStore: eventReplay,
				});
			} catch {
				return send(response, 401, { error: 'unauthorized' });
			}
			const event = JSON.parse(raw);
			if (!validateEvent(event).ok) return send(response, 400, { error: 'invalid_event' });
			if (seenEvents.has(event.id) && !broken.eventDedupe) return send(response, 200, { duplicate: true });
			if (event.type === 'key.revoked@1' && !broken.controlEvents) for (const keyId of event.data.keyIds) revoked.add(keyId);
			if (event.type === 'entitlement.changed@1' && !broken.controlEvents) entitlements.delete(event.websiteId);
			seenEvents.add(event.id);
			effects.set(event.id, (effects.get(event.id) ?? 0) + 1);
			return send(response, 200, { accepted: true });
		}
		if (route === 'GET /sso') {
			try {
				const claims = await verifyLaunch({
					token: url.searchParams.get('launch'),
					keyResolver: portalKeys,
					audience: /** @type {string} */ (appId),
					issuer: portalUrl,
					consume: broken.launchReplay ? () => true : async (jti, exp) => !(await launchStore.seen(jti, exp)),
				});
				counter += 1;
				const id = `ses_fakesession${String(counter).padStart(8, '0')}`;
				sessions.set(id, {
					kind: claims.kind,
					role: claims.user.roles?.[0],
					scope: claims.scope,
					actor: claims.act?.sub ?? null,
				});
				response.writeHead(303, { location: '/dashboard', 'set-cookie': `ss_session=${id}; Path=/; HttpOnly` });
				return response.end();
			} catch {
				return problem(response, 401, 'invalid_credentials');
			}
		}
		if (route === 'GET /v1/session') {
			const session = sessions.get(/^Bearer (ses_\S+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '');
			if (broken.sessionView) return problem(response, 404, 'not_found');
			return session ? send(response, 200, session) : problem(response, 401, 'unauthorized');
		}
		if (route === 'GET /healthz' || route === 'GET /readyz') return send(response, 200, { ok: true });
		if (route === 'POST /v1/data:export' || route === 'POST /v1/data:anonymize') {
			if (!(await portalSigned(request.headers, raw, method, `${url.pathname}${url.search}`)))
				return problem(response, 401, 'unauthorized');
			const body = JSON.parse(raw);
			const resolved = await portal('/v1/product/resources/resolve', {
				method: 'POST',
				body: { websiteId: body.websiteId, kind: 'database' },
			});
			return send(response, 200, {
				websiteId: body.websiteId,
				database: resolved.json.descriptor?.dbName ?? null,
				notes: notes.get(body.websiteId) ?? [],
			});
		}

		// Website-key routes
		const bearer = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
		if (!bearer) return problem(response, 401, 'unauthorized');
		/** @type {any} */
		let website;
		try {
			website = await verifyWebsiteKey({ key: bearer, keyResolver: portalKeys, revocations: revoked });
		} catch {
			return problem(response, 401, 'invalid_credentials');
		}
		if (website.kind === 'pk' && !broken.originCheck) {
			const allowed = originAllowed({
				origin: request.headers.origin ?? null,
				referer: request.headers.referer ?? null,
				domain: website.domain,
				allowSubdomains: website.allowSubdomains,
				env: website.env,
			});
			if (!allowed) return problem(response, 403, 'origin_not_allowed');
		}
		const doc = await entitlementFor(website.websiteId);
		if (!doc) return problem(response, 503, 'unavailable');
		const list = notes.get(website.websiteId) ?? [];
		notes.set(website.websiteId, list);
		const probe = /^\/v1\/ss-probe\/events\/(.+)$/.exec(url.pathname);
		if (probe) return send(response, 200, { id: probe[1], effects: effects.get(decodeURIComponent(probe[1] ?? '')) ?? 0 });
		if (route === 'GET /v1/ss-probe/data-guard')
			return send(response, 200, { rejected: !broken.dataGuard, code: 'data_guard' });
		if (route === 'GET /v1/entitlement') return send(response, 200, doc);
		if (route === 'GET /v1/config') return send(response, 200, doc.config);
		if (route === 'GET /v1/strings') return send(response, 200, { 'notes.title': 'Notes' });
		if (route === 'POST /v1/events') return send(response, broken.siteEvents ? 422 : 202, { accepted: 1 });
		if (url.pathname === '/v1/notes') {
			if (doc.elements.notes?.enabled !== true && !broken.gating) return problem(response, 403, 'element_disabled');
			if (method === 'GET' && website.kind === 'pk') {
				pkReads += 1;
				if (broken.pkServerError) return problem(response, 500, 'internal_error');
				if (broken.pkFlaky && pkReads % 2 === 0) return problem(response, 403, 'forbidden');
				if (broken.pkRefused) return problem(response, 403, 'key_kind_required');
			}
			if (method === 'GET') {
				const limit = Number(url.searchParams.get('limit') ?? 20);
				const cursor = url.searchParams.get('cursor');
				const start = cursor ? list.findIndex((note) => note.id === cursor) + 1 : 0;
				const items = list.slice(start, start + limit);
				const next = start + limit < list.length ? items.at(-1)?.id : null;
				return send(
					response,
					200,
					{ items, nextCursor: next ?? null },
					next && !broken.pagination ? { link: `</v1/notes?cursor=${next}&limit=${limit}>; rel="next"` } : {},
				);
			}
			if (method === 'POST') {
				const key = request.headers['idempotency-key'];
				if (typeof key !== 'string') return problem(response, 428, 'idempotency_key_required');
				const cacheKey = `${website.websiteId}|${key}`;
				const cached = idempotency.get(cacheKey);
				if (cached && !broken.idempotency) return send(response, cached.status, cached.body);
				counter += 1;
				const note = { id: `note_${String(counter).padStart(4, '0')}`, text: JSON.parse(raw).text };
				list.push(note);
				await portal('/v1/product/usage', {
					method: 'POST',
					body: {
						records: [
							{
								websiteId: website.websiteId,
								unit: 'note_created',
								quantity: 1,
								idempotencyKey: `note:${note.id}`,
								occurredAt: new Date().toISOString(),
							},
						],
					},
				});
				idempotency.set(cacheKey, { status: 201, body: note });
				return send(response, 201, note);
			}
		}
		return problem(response, 404, 'not_found');
	});

	return {
		get appId() {
			return appId;
		},
		portal,
		/** @param {number} [port] @returns {Promise<string>} */
		start: (port = 0) =>
			new Promise((resolve) => {
				server.listen(port, '127.0.0.1', () => {
					const address = /** @type {import('node:net').AddressInfo} */ (server.address());
					resolve(`http://127.0.0.1:${address.port}`);
				});
			}),
		stop: () =>
			new Promise((resolve) => {
				server.close(() => resolve(undefined));
				server.closeAllConnections();
			}),
	};
};
