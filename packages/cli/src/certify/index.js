/**
 * `ss certify [dir] --url <product base url>` — the SSPS certification suite (Part E §12) run against a running
 * product through an in-process Portal emulator bound to the product's pinned Portal URL.
 *
 * Service products: `.well-known` endpoints, connection-code setup (bad code, proof of possession, setup closes),
 * launches of every kind accepted and bad ones rejected, website keys (sk_, pk_ + origin), RFC 9457 errors, element
 * gating, idempotent POST replay, cursor pagination, standard resources, signed events (delivery, replay, tampering,
 * idempotent consumption), data guard, data export/anonymise, entitlement offline grace (the emulator goes down).
 * Element packs: validation plus a headless/renderer smoke test.
 * @module
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createId, validateManifest } from '@ss/contracts';
import { createSigner, generateSigningKey, hashManifest, issueLaunch, issueWebsiteKey, signEvent } from '@ss/protocol';
import { validateProject } from '../validate/index.js';
import { normaliseFixture } from '../emulator/fixture.js';
import { createPortal } from '../emulator/portal.js';
import { concreteEventType } from '../emulator/events.js';
import { createEmulatorServer } from '../emulator/server.js';
import { createDatabaseResolver } from '../emulator/mongo.js';
import { isObject, readJson } from '../fsutil.js';

/** @typedef {'pass' | 'fail' | 'skip'} CheckStatus */
/** @typedef {{ id: string, title: string, status: CheckStatus, detail: string, durationMs: number }} CheckResult */
/**
 * @typedef {object} CertificationReport
 * @property {boolean} ok
 * @property {string} product
 * @property {'service' | 'pack' | 'unknown'} kind
 * @property {string | null} url
 * @property {string | null} portalUrl
 * @property {string} startedAt
 * @property {string} finishedAt
 * @property {{ passed: number, failed: number, skipped: number }} summary
 * @property {CheckResult[]} checks
 */
/** @typedef {{ status: number, headers: Headers, text: string, json: any }} HttpResult */

export const CERT_MERCHANT = 'mer_certmerchant01';
export const CERT_WEBSITE = 'web_certwebsite01';
export const CERT_BLOCKED_WEBSITE = 'web_certwebsite02';
export const CERT_DOMAIN = 'shop.example.com';
export const FOREIGN_ORIGIN = 'https://evil.example.net';

/**
 * Fixture used by certification: one website with every element on, one with every element switched off.
 * @param {{ elements: string[], portalUrl: string }} input
 */
export const certificationFixture = ({ elements, portalUrl }) =>
	normaliseFixture({
		portal: { url: portalUrl },
		merchants: [{ id: CERT_MERCHANT, name: 'Certification Merchant', balance: 1000 }],
		websites: [
			{ id: CERT_WEBSITE, merchantId: CERT_MERCHANT, domain: CERT_DOMAIN, env: 'test', allowSubdomains: false },
			{
				id: CERT_BLOCKED_WEBSITE,
				merchantId: CERT_MERCHANT,
				domain: 'blocked.example.com',
				env: 'test',
				allowSubdomains: false,
			},
		],
		subscriptions: [
			{ id: 'sub_certsubscript01', websiteId: CERT_WEBSITE },
			{
				id: 'sub_certsubscript02',
				websiteId: CERT_BLOCKED_WEBSITE,
				layers: { website: { elements: Object.fromEntries(elements.map((key) => [key, { enabled: false }])) } },
			},
		],
	});

/**
 * @param {HttpResult} result
 * @returns {string | null} why it is not an RFC 9457 problem, or null
 */
export const problemShapeError = (result) => {
	const type = result.headers.get('content-type') ?? '';
	if (!type.includes('application/problem+json')) return `content-type is '${type}', expected application/problem+json`;
	const body = result.json;
	if (!isObject(body)) return 'body is not a JSON object';
	if (typeof body.type !== 'string' || typeof body.title !== 'string') return 'problem needs string type and title';
	if (body.status !== result.status) return `problem status ${String(body.status)} ≠ HTTP ${result.status}`;
	return null;
};

/**
 * Next cursor from a paginated response: `Link: <…?cursor=x>; rel="next"`, `X-Next-Cursor`, or `nextCursor` in the body.
 * @param {HttpResult} result
 * @returns {{ cursor: string, source: string } | null}
 */
export const nextCursorOf = (result) => {
	const link = result.headers.get('link');
	if (link) {
		for (const part of link.split(',')) {
			const match = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(part);
			if (match?.[1]) {
				const cursor = new URL(match[1], 'http://x').searchParams.get('cursor');
				if (cursor) return { cursor, source: 'Link' };
			}
		}
	}
	const header = result.headers.get('x-next-cursor');
	if (header) return { cursor: header, source: 'X-Next-Cursor' };
	const body = result.json;
	if (isObject(body) && typeof body.nextCursor === 'string' && body.nextCursor)
		return { cursor: body.nextCursor, source: 'body.nextCursor' };
	return null;
};

/**
 * @param {unknown} body
 * @returns {unknown[]}
 */
const itemsOf = (body) =>
	isObject(body) && Array.isArray(body.items)
		? body.items
		: Array.isArray(body)
			? body
			: isObject(body) && Array.isArray(body.data)
				? body.data
				: [];

/**
 * @param {unknown} item
 * @returns {string}
 */
const idOfItem = (item) => (isObject(item) && typeof item.id === 'string' ? item.id : JSON.stringify(item));

/**
 * Plain-text table of results.
 * @param {CertificationReport} report
 * @returns {string}
 */
export const formatReport = (report) => {
	const width = Math.max(10, ...report.checks.map((check) => check.id.length));
	const mark = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' };
	const lines = [
		`Certification — ${report.product} (${report.kind})${report.url ? ` at ${report.url}` : ''}`,
		`${'CHECK'.padEnd(width)}  RESULT  DETAIL`,
		...report.checks.map(
			(check) =>
				`${check.id.padEnd(width)}  ${mark[check.status].padEnd(6)}  ${check.title}${check.detail ? ` — ${check.detail}` : ''}`,
		),
		`${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped → ${report.ok ? 'CERTIFIABLE (Listed)' : 'NOT CERTIFIABLE'}`,
	];
	return `${lines.join('\n')}\n`;
};

/** OpenAPI operation keys of a path item. */
const HTTP_METHODS = Object.freeze(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

/**
 * True when an OpenAPI path item, or one of its operations, sets `"x-ss-certify": true`.
 * @param {unknown} item
 * @returns {boolean}
 */
const marksCertify = (item) =>
	isObject(item) &&
	(item['x-ss-certify'] === true ||
		HTTP_METHODS.some((method) => isObject(item[method]) && item[method]['x-ss-certify'] === true));

/**
 * @typedef {{ ok: true, element: import('@ss/contracts').ManifestElement | undefined, resource: string | undefined, source: 'x-ss-certify' | 'first' }
 *   | { ok: false, problem: string }} CertificationTarget
 */

/**
 * The resource the key, gating, idempotency, pagination, control-event and offline checks run against. A product
 * chooses it by marking the collection path `/v1/<resource>` (the path item or one of its operations) with
 * `"x-ss-certify": true` in `openapi.json`; the resource must be in the `api.resources` of a Mode C element (the
 * first such element is the one switched off and on). Without a mark: the first resource of the first Mode C
 * element with `api.resources`. Several marked paths, or a mark on anything else, is a configuration error.
 * @param {import('@ss/contracts').Manifest} manifest
 * @param {Record<string, unknown>} openapiPaths `paths` of openapi.json (`{}` when absent)
 * @returns {CertificationTarget}
 */
export const certificationTarget = (manifest, openapiPaths) => {
	const modeC = manifest.elements.filter((element) => element.modes.includes('C') && (element.api?.resources?.length ?? 0) > 0);
	const marked = Object.entries(openapiPaths)
		.filter(([, item]) => marksCertify(item))
		.map(([pathname]) => pathname);
	if (marked.length === 0) {
		const element = modeC[0];
		return { ok: true, element, resource: element?.api?.resources?.[0], source: 'first' };
	}
	if (marked.length > 1)
		return { ok: false, problem: `x-ss-certify is set on ${marked.length} paths (${marked.join(', ')}); mark one` };
	const pathname = /** @type {string} */ (marked[0]);
	const name = /^\/v1\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/.exec(pathname)?.[1];
	const element = name === undefined ? undefined : modeC.find((candidate) => candidate.api?.resources?.includes(name));
	if (!element || name === undefined)
		return {
			ok: false,
			problem: `${pathname} is marked x-ss-certify but is not /v1/<resource> of a Mode C element's api.resources`,
		};
	return { ok: true, element, resource: name, source: 'x-ss-certify' };
};

/**
 * @typedef {object} CertifyOptions
 * @property {string} dir project directory (manifest, openapi.json)
 * @property {string} [url] running product base URL (service products)
 * @property {string} [portalUrl] Portal URL the product pins (default: ss.dev.json portal.url or http://localhost:4400)
 * @property {Record<string, any>} [snapshot] `ss dev` state (reuses its Portal key and a connected app instead of connecting)
 * @property {typeof fetch} [fetch]
 * @property {() => number} [now]
 * @property {{ resolve: (target: { merchantId: string, websiteId: string }) => Promise<{ uri: string, dbName: string }>, stop?: () => Promise<void> }} [database]
 * @property {(line: string) => void} [log]
 * @property {number} [timeoutMs] per request
 */

/**
 * Run the suite.
 * @param {CertifyOptions} options
 * @returns {Promise<CertificationReport>}
 */
export const runCertification = async ({
	dir,
	url,
	portalUrl: portalUrlIn,
	snapshot,
	fetch = globalThis.fetch,
	now = Date.now,
	database,
	log = () => {},
	timeoutMs = 15_000,
}) => {
	const startedAt = new Date(now()).toISOString();
	/** @type {CheckResult[]} */
	const checks = [];
	/**
	 * @param {string} id
	 * @param {string} title
	 * @param {() => Promise<string | { skip: string } | void>} fn resolves with detail (pass), `{ skip }`, or throws (fail)
	 */
	const check = async (id, title, fn) => {
		const started = Date.now();
		/** @type {CheckResult} */
		let result;
		try {
			const outcome = await fn();
			result = isObject(outcome)
				? { id, title, status: 'skip', detail: String(outcome.skip), durationMs: Date.now() - started }
				: { id, title, status: 'pass', detail: outcome ?? '', durationMs: Date.now() - started };
		} catch (error) {
			result = { id, title, status: 'fail', detail: /** @type {Error} */ (error).message, durationMs: Date.now() - started };
		}
		checks.push(result);
		log(`${result.status.toUpperCase().padEnd(4)}  ${id}${result.detail ? `  ${result.detail}` : ''}`);
		return result.status === 'pass';
	};
	/** @param {string} id @param {string} title @param {string} reason */
	const skip = (id, title, reason) => {
		checks.push({ id, title, status: 'skip', detail: reason, durationMs: 0 });
		log(`SKIP  ${id}  ${reason}`);
	};
	/**
	 * @param {boolean} condition
	 * @param {string} message
	 * @returns {asserts condition}
	 */
	const expect = (condition, message) => {
		if (!condition) throw new Error(message);
	};

	const finish = (
		/** @type {string} */ product,
		/** @type {CertificationReport['kind']} */ kind,
		/** @type {string | null} */ portalUrl,
	) => {
		const summary = {
			passed: checks.filter((entry) => entry.status === 'pass').length,
			failed: checks.filter((entry) => entry.status === 'fail').length,
			skipped: checks.filter((entry) => entry.status === 'skip').length,
		};
		return /** @type {CertificationReport} */ ({
			ok: summary.failed === 0,
			product,
			kind,
			url: url ?? null,
			portalUrl,
			startedAt,
			finishedAt: new Date(now()).toISOString(),
			summary,
			checks,
		});
	};

	// ── Static: the project itself ────────────────────────────────────────────────────────────────────────
	const validation = await validateProject(dir);
	await check('project.validate', 'ss app validate passes', async () => {
		expect(
			validation.ok,
			validation.problems
				.filter((problem) => problem.severity === 'error')
				.map((problem) => `${problem.file} ${problem.rule}: ${problem.message}`)
				.slice(0, 5)
				.join('; '),
		);
		return `${validation.summary.warnings} warnings`;
	});
	const checked = validateManifest(validation.manifest);
	if (!checked.ok) return finish('unknown', 'unknown', null);
	const manifest = checked.value;
	const slug = manifest.product.slug;

	if (manifest.product.kind === 'pack') {
		await packChecks({ dir, manifest, check, expect });
		return finish(slug, 'pack', null);
	}

	// ── Service products: live checks against the running product ─────────────────────────────────────────
	if (!url) {
		skip('service.url', 'running product', 'pass --url <product base url> to run the live suite');
		return finish(slug, 'service', null);
	}
	const base = url.replace(/\/+$/, '');
	const devFixture = await readJson(path.join(dir, 'ss.dev.json'));
	const fixturePortal =
		devFixture.ok &&
		isObject(devFixture.value) &&
		isObject(devFixture.value.portal) &&
		typeof devFixture.value.portal.url === 'string'
			? devFixture.value.portal.url
			: undefined;
	const portalUrl = (
		portalUrlIn ??
		(typeof snapshot?.portalUrl === 'string' ? snapshot.portalUrl : undefined) ??
		fixturePortal ??
		'http://localhost:4400'
	).replace(/\/+$/, '');
	const elements = manifest.elements.map((element) => element.key);
	const db = database ?? createDatabaseResolver();
	const portal = await createPortal({
		fixture: certificationFixture({ elements, portalUrl }),
		portalUrl,
		now,
		fetch,
		database: db,
		...(snapshot ? { snapshot } : {}),
	});
	const server = createEmulatorServer({ portal });

	/**
	 * @param {string} pathname
	 * @param {{ method?: string, headers?: Record<string, string>, body?: unknown, raw?: string }} [init]
	 * @returns {Promise<HttpResult>}
	 */
	const call = async (pathname, { method = 'GET', headers = {}, body, raw } = {}) => {
		const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
		const response = await fetch(`${base}${pathname}`, {
			method,
			headers: {
				accept: 'application/json',
				...(payload === undefined ? {} : { 'content-type': 'application/json' }),
				...headers,
			},
			...(payload === undefined ? {} : { body: payload }),
			signal: AbortSignal.timeout(timeoutMs),
			redirect: 'manual',
		});
		const text = await response.text();
		/** @type {unknown} */
		let json = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			// not JSON
		}
		return { status: response.status, headers: response.headers, text, json };
	};

	try {
		const started = await check('emulator.start', `Portal emulator listening on ${portalUrl}`, async () => {
			try {
				await server.start();
			} catch (error) {
				const code = /** @type {{ code?: string }} */ (error).code;
				throw new Error(
					code === 'EADDRINUSE'
						? `${portalUrl} is busy — stop \`ss dev\` first (certify runs its own emulator)`
						: /** @type {Error} */ (error).message,
				);
			}
			return portal.portalUrl;
		});
		if (!started) return finish(slug, 'service', portalUrl);

		// .well-known
		await check('wellknown.manifest', 'GET /.well-known/ss-app.json serves the bundled manifest', async () => {
			const result = await call('/.well-known/ss-app.json');
			expect(result.status === 200, `status ${result.status}`);
			const served = validateManifest(result.json);
			expect(
				served.ok,
				`served manifest is invalid: ${
					served.ok
						? ''
						: served.problems
								.slice(0, 3)
								.map((problem) => `${problem.path} ${problem.message}`)
								.join('; ')
				}`,
			);
			expect(
				hashManifest(result.json) === hashManifest(manifest),
				'served manifest differs from the local manifest.json (with features bundled)',
			);
			return 'matches manifest.json';
		});
		const eventsPath = manifest.endpoints?.events ?? '/.well-known/ss-events';
		const snapshotApp = portal.apps().find((app) => app.baseUrl.replace(/\/+$/, '') === base);
		if (!snapshotApp)
			await check(
				'setup.rejects-bad-code',
				'POST /setup refuses an invalid connection code and stays unconnected',
				async () => {
					const result = await call('/setup', { method: 'POST', body: { code: 'ssc_invalid', baseUrl: base } });
					expect(result.status === 400, `status ${result.status}`);
					return '400, still unconnected';
				},
			);

		// Connection-code onboarding (the product's /setup)
		let registered = Boolean(snapshotApp);
		if (snapshotApp) {
			skip(
				'connection.setup',
				'/setup connects with a one-time code and the proof of possession verifies',
				`reusing ${snapshotApp.appId} from the ss dev state`,
			);
		} else {
			registered = await check(
				'connection.setup',
				'/setup connects with a one-time code and the proof of possession verifies',
				async () => {
					const result = await portal.connect({ url: base });
					return `appId ${result.appId}, key ${result.kid}, jkt ${result.thumbprint.slice(0, 12)}…`;
				},
			);
			await check('connection.setup-closed', 'once connected, /setup refuses another code', async () => {
				const { code } = portal.connectionCode();
				const result = await call('/setup', { method: 'POST', body: { code, baseUrl: base } });
				expect(result.status === 404, `status ${result.status}`);
				return '404 after connection';
			});
		}
		if (!registered) {
			skip('live', 'remaining live checks', 'the product is not connected to this emulator');
			return finish(slug, 'service', portalUrl);
		}
		await check('wellknown.events-unsigned', 'unsigned event deliveries are refused', async () => {
			const result = await call(eventsPath, { method: 'POST', body: { id: 'evt_unsigned000001' } });
			expect(result.status === 401 || result.status === 400 || result.status === 403, `status ${result.status}`);
			return `status ${result.status}`;
		});
		const app = portal.apps().find((candidate) => candidate.baseUrl.replace(/\/+$/, '') === base) ?? portal.apps()[0];
		if (!app) throw new Error('no connected app');

		// Launches
		const kinds = /** @type {const} */ (['merchant', 'demo', 'admin', 'impersonate', 'partner', 'developer']);
		/**
		 * Exchange a launch at the standard `GET /sso?launch=` (303 + `ss_session` cookie), then read the session back
		 * from the product's `GET /v1/session` when it has one.
		 * @param {string} launchToken
		 * @returns {Promise<{ status: number, json: any, view: boolean }>}
		 */
		const session = async (launchToken) => {
			const sso = await call(`/sso?launch=${encodeURIComponent(launchToken)}`);
			if (sso.status !== 303 && sso.status !== 302) return { status: sso.status, json: sso.json, view: false };
			const id = /ss_session=(ses_[^;,\s]+)/.exec(sso.headers.get('set-cookie') ?? '')?.[1];
			if (!id) return { status: 500, json: { detail: '/sso did not set the ss_session cookie' }, view: false };
			const view = await call('/v1/session', { headers: { authorization: `Bearer ${id}` } });
			if (view.status === 404) return { status: 200, json: {}, view: false };
			return { status: view.status, json: view.json, view: true };
		};
		for (const kind of kinds) {
			await check(`launch.${kind}`, `${kind} launch is accepted`, async () => {
				const issued = await portal.launch({ kind, appId: app.appId, ...(kind === 'admin' ? { scope: CERT_MERCHANT } : {}) });
				const result = await session(issued.token);
				expect(result.status === 200, `status ${result.status}${result.json?.detail ? ` (${result.json.detail})` : ''}`);
				if (!result.view) return 'session established (no GET /v1/session to inspect)';
				expect(isObject(result.json) && result.json.kind === kind, `session kind ${String(result.json?.kind)} ≠ ${kind}`);
				if (kind === 'impersonate')
					expect(Boolean(result.json.actor), 'impersonation must expose the acting staff member (audit banner)');
				return `role ${String(result.json.role ?? '—')}`;
			});
		}
		await check('launch.replay', 'a launch cannot be used twice', async () => {
			const issued = await portal.launch({ kind: 'merchant', appId: app.appId });
			const first = await session(issued.token);
			expect(first.status === 200, `first use answered ${first.status}`);
			const second = await session(issued.token);
			expect(second.status === 401, `replay answered ${second.status}`);
			return 'replay → 401';
		});
		await check('launch.expired', 'an expired launch is refused', async () => {
			const issued = await portal.launch({
				kind: 'merchant',
				appId: app.appId,
				ttlSeconds: 60,
				now: () => now() - 10 * 60_000,
			});
			const result = await session(issued.token);
			expect(result.status === 401, `status ${result.status}`);
			return 'expired → 401';
		});
		await check('launch.audience', 'a launch for another app is refused', async () => {
			const issued = await portal.launch({ kind: 'merchant', appId: 'app_otherapplication1', baseUrl: base });
			const result = await session(issued.token);
			expect(result.status === 401, `status ${result.status}`);
			return 'wrong aud → 401';
		});
		const forger = createSigner((await generateSigningKey({ kid: portal.signer.kid })).privateJwk);
		await check('launch.forged', 'a launch signed by another key (same kid) is refused', async () => {
			const issued = await issueLaunch({
				signer: forger,
				issuer: portal.portalUrl,
				audience: app.appId,
				subject: 'usr_forged',
				kind: 'merchant',
				user: { id: 'usr_forged' },
				scope: { merchantId: CERT_MERCHANT },
				now,
			});
			const result = await session(issued.token);
			expect(result.status === 401, `status ${result.status}`);
			return 'forged → 401';
		});

		// Website keys
		/** Every Mode C resource, in manifest order. */
		const resources = [
			...new Set(
				manifest.elements.filter((element) => element.modes.includes('C')).flatMap((element) => element.api?.resources ?? []),
			),
		];
		const openapi = await readJson(path.join(dir, 'openapi.json'));
		const openapiPaths = openapi.ok && isObject(openapi.value) ? /** @type {any} */ (openapi.value.paths ?? {}) : {};
		const target = certificationTarget(manifest, openapiPaths);
		const resourceElement = target.ok ? target.element : undefined;
		const resource = target.ok ? target.resource : undefined;
		if (!target.ok) {
			await check('certify.target', 'the certification resource (x-ss-certify) is a Mode C resource', async () => {
				expect(false, target.problem);
			});
		} else if (resource) {
			await check('certify.target', 'certification resource', async () =>
				target.source === 'x-ss-certify'
					? `/v1/${resource} of ${target.element?.key} (x-ss-certify)`
					: `/v1/${resource} of ${target.element?.key} (first Mode C resource)`,
			);
		}
		/** Resources with a collection read: documented `GET /v1/<resource>` (all of them when openapi.json is missing). */
		const readable = resources.filter((name) => !openapi.ok || Boolean(openapiPaths[`/v1/${name}`]?.get));
		/** Resources whose `GET /v1/<resource>` declares `x-ss-key-kind: "sk"` in openapi.json (pk_ must be refused). */
		const skOnly = new Set(resources.filter((name) => openapiPaths[`/v1/${name}`]?.get?.['x-ss-key-kind'] === 'sk'));
		if (!resource) {
			skip('keys', 'website key checks', 'no Mode C resource in the manifest');
		}
		const resourcePath = `/v1/${resource ?? 'unknown'}`;
		const issued = await portal.issueKeys({ websiteId: CERT_WEBSITE });
		const sk = /** @type {import('../emulator/portal.js').IssuedKey} */ (issued.find((key) => key.kind === 'sk')).key;
		const pk = /** @type {import('../emulator/portal.js').IssuedKey} */ (issued.find((key) => key.kind === 'pk')).key;
		const blocked = await portal.issueKeys({ websiteId: CERT_BLOCKED_WEBSITE });
		const blockedSk = /** @type {import('../emulator/portal.js').IssuedKey} */ (blocked.find((key) => key.kind === 'sk')).key;
		const bearer = (/** @type {string} */ key) => ({ authorization: `Bearer ${key}` });
		if (resource) {
			await check('keys.sk', `sk_ key reads ${resourcePath}`, async () => {
				const result = await call(resourcePath, { headers: bearer(sk) });
				expect(result.status === 200, `status ${result.status}${result.json?.detail ? ` (${result.json.detail})` : ''}`);
				return '200';
			});
			await check('keys.missing', 'requests without a key are refused (401 problem)', async () => {
				const result = await call(resourcePath);
				expect(result.status === 401, `status ${result.status}`);
				const shape = problemShapeError(result);
				expect(shape === null, String(shape));
				return '401';
			});
			await check('keys.malformed', 'malformed keys are refused', async () => {
				const result = await call(resourcePath, { headers: bearer('sk_test_not-a-real-key') });
				expect(result.status === 401, `status ${result.status}`);
				return '401';
			});
			await check('keys.forged', 'keys signed by another key are refused', async () => {
				const forged = await issueWebsiteKey({
					signer: forger,
					kind: 'sk',
					websiteId: CERT_WEBSITE,
					merchantId: CERT_MERCHANT,
					domain: CERT_DOMAIN,
					env: 'test',
					scopes: ['read', 'write'],
					keyId: createId('key'),
					now,
				});
				const result = await call(resourcePath, { headers: bearer(forged.key) });
				expect(result.status === 401, `status ${result.status}`);
				return '401';
			});
			await check(
				'keys.pk-resources',
				'pk_ key from the bound domain: every resource GET answers 200 or a 401/403 problem, consistently; sk_-only resources refuse pk_',
				async () => {
					/** @type {string[]} */
					const outcomes = [];
					for (const name of readable) {
						const pathname = `/v1/${name}`;
						const headers = { ...bearer(pk), origin: `https://${CERT_DOMAIN}` };
						const first = await call(pathname, { headers });
						const second = await call(pathname, { headers });
						const allowed = first.status === 200 || first.status === 401 || first.status === 403;
						expect(allowed, `GET ${pathname} answered ${first.status}`);
						expect(second.status === first.status, `GET ${pathname} answered ${first.status}, then ${second.status}`);
						if (first.status !== 200) {
							const shape = problemShapeError(first);
							expect(shape === null, `GET ${pathname}: ${String(shape)}`);
						}
						if (skOnly.has(name)) {
							expect(first.status !== 200, `GET ${pathname} is sk_-only (x-ss-key-kind) but answered 200 to a pk_ key`);
						}
						outcomes.push(`${name} ${first.status}`);
					}
					return outcomes.length > 0 ? outcomes.join(', ') : 'no documented resource GET';
				},
			);
			await check('keys.pk-foreign-origin', 'pk_ key is refused from another origin (403)', async () => {
				const result = await call(resourcePath, { headers: { ...bearer(pk), origin: FOREIGN_ORIGIN } });
				expect(result.status === 403, `status ${result.status}`);
				const shape = problemShapeError(result);
				expect(shape === null, String(shape));
				return '403';
			});
			await check('errors.problem', 'unknown routes answer an RFC 9457 problem', async () => {
				const result = await call('/v1/ss-certify-unknown-route', { headers: bearer(sk) });
				expect(result.status === 404, `status ${result.status}`);
				const shape = problemShapeError(result);
				expect(shape === null, String(shape));
				return '404 application/problem+json';
			});
			await check('gating.element-disabled', 'a disabled element answers 403 problem in Mode C', async () => {
				const result = await call(resourcePath, { headers: bearer(blockedSk) });
				expect(result.status === 403, `status ${result.status}`);
				const shape = problemShapeError(result);
				expect(shape === null, String(shape));
				return `403 ${String(result.json?.type ?? '')}`;
			});

			// Idempotency and pagination (request examples come from openapi.json)
			const example = openapiPaths[resourcePath]?.post?.requestBody?.content?.['application/json']?.example;
			if (example === undefined) {
				skip(
					'idempotency.replay',
					'POST replay with the same Idempotency-Key returns the original result',
					`no POST ${resourcePath} request example in openapi.json`,
				);
				skip('pagination.cursor', 'cursor pagination', `no POST ${resourcePath} request example in openapi.json`);
			} else {
				await check('idempotency.required', 'POST without Idempotency-Key is refused (problem)', async () => {
					const result = await call(resourcePath, { method: 'POST', headers: bearer(sk), body: example });
					expect(result.status >= 400 && result.status < 500, `status ${result.status}`);
					const shape = problemShapeError(result);
					expect(shape === null, String(shape));
					return String(result.status);
				});
				await check(
					'idempotency.replay',
					'POST replay with the same Idempotency-Key returns the original result',
					async () => {
						const key = `certify-${createId('idk').slice(4)}`;
						const first = await call(resourcePath, {
							method: 'POST',
							headers: { ...bearer(sk), 'idempotency-key': key },
							body: example,
						});
						expect(
							first.status >= 200 && first.status < 300,
							`first POST answered ${first.status}${first.json?.detail ? ` (${first.json.detail})` : ''}`,
						);
						const second = await call(resourcePath, {
							method: 'POST',
							headers: { ...bearer(sk), 'idempotency-key': key },
							body: example,
						});
						expect(second.status === first.status, `replay status ${second.status} ≠ ${first.status}`);
						expect(
							second.text === first.text || JSON.stringify(second.json) === JSON.stringify(first.json),
							'replay body differs from the original',
						);
						return `${first.status} replayed`;
					},
				);
				await check('pagination.cursor', 'cursor pagination returns disjoint pages', async () => {
					const extra = await call(resourcePath, {
						method: 'POST',
						headers: { ...bearer(sk), 'idempotency-key': `certify-${createId('idk').slice(4)}` },
						body: example,
					});
					expect(extra.status >= 200 && extra.status < 300, `seeding POST answered ${extra.status}`);
					const first = await call(`${resourcePath}?limit=1`, { headers: bearer(sk) });
					expect(first.status === 200, `status ${first.status}`);
					const next = nextCursorOf(first);
					expect(next !== null, 'no next cursor (Link rel="next", X-Next-Cursor or nextCursor)');
					const second = await call(`${resourcePath}?limit=1&cursor=${encodeURIComponent(next.cursor)}`, {
						headers: bearer(sk),
					});
					expect(second.status === 200, `next page answered ${second.status}`);
					const seen = new Set(itemsOf(first.json).map(idOfItem));
					const page = itemsOf(second.json).map(idOfItem);
					expect(page.length > 0 && page.every((id) => !seen.has(id)), 'pages overlap or the next page is empty');
					return `cursor via ${next.source}`;
				});
			}
		}

		// Standard resources
		for (const [pathname, method, auth] of /** @type {const} */ ([
			['/v1/entitlement', 'GET', true],
			['/v1/config', 'GET', true],
			['/v1/strings?lang=en', 'GET', true],
			['/healthz', 'GET', false],
			['/readyz', 'GET', false],
		])) {
			await check(`standard.${pathname.split('?')[0]?.replace(/^\/(?:v1\/)?/, '')}`, `${method} ${pathname}`, async () => {
				const result = await call(pathname, { method, headers: auth ? bearer(sk) : {} });
				expect(result.status === 200, `status ${result.status}`);
				expect(result.json !== null, 'body is not JSON');
				return '200';
			});
		}
		await check('standard.events', 'POST /v1/events accepts a site event in the product namespace', async () => {
			const result = await call('/v1/events', {
				method: 'POST',
				headers: { ...bearer(sk), 'idempotency-key': `certify-${createId('idk').slice(4)}` },
				body: {
					events: [
						{
							id: createId('evt'),
							type: `${slug.replace(/-/g, '_')}.certify_probe@1`,
							occurredAt: new Date(now()).toISOString(),
							idempotencyKey: createId('idk'),
							actor: { type: 'anonymous' },
							data: {},
						},
					],
				},
			});
			expect(
				result.status >= 200 && result.status < 300,
				`status ${result.status}${result.json?.detail ? ` (${result.json.detail})` : ''}`,
			);
			return String(result.status);
		});

		// Events
		const consumed = (manifest.events?.consumes ?? []).map(concreteEventType).find((type) => type !== null);
		if (!consumed) skip('events', 'signed event delivery', 'the manifest consumes no deliverable events');
		else {
			/** @type {Awaited<ReturnType<typeof portal.emit>> | null} */
			let delivery = null;
			await check('events.delivery', `signed ${consumed} delivery is accepted`, async () => {
				delivery = await portal.emit({ type: consumed, websiteId: CERT_WEBSITE, appId: app.appId });
				expect(delivery.status >= 200 && delivery.status < 300, `status ${delivery.status}`);
				return String(delivery.status);
			});
			const first = /** @type {Awaited<ReturnType<typeof portal.emit>> | null} */ (delivery);
			if (first) {
				await check('events.replay', 'the exact same delivery (timestamp + body) is not processed again', async () => {
					const result = await portal.deliver({ rawBody: first.rawBody, headers: first.headers, appId: app.appId });
					expect(result.status < 500, `status ${result.status}`);
					return `status ${result.status}`;
				});
				await check('events.redelivery', 'a re-signed redelivery of the same event id is acknowledged', async () => {
					const headers = await portal.signBody(first.rawBody, { timestamp: Math.floor(now() / 1000) + 1 });
					const result = await portal.deliver({ rawBody: first.rawBody, headers: { ...headers }, appId: app.appId });
					expect(result.status >= 200 && result.status < 300, `status ${result.status}`);
					return String(result.status);
				});
				await check('events.idempotent', 'consumption is idempotent (one effect per event id)', async () => {
					const result = await call(`/v1/ss-probe/events/${encodeURIComponent(first.event.id)}`, { headers: bearer(sk) });
					expect(result.status === 200, `probe /v1/ss-probe/events/:id answered ${result.status} (dev-only probe required)`);
					expect(
						isObject(result.json) && result.json.effects === 1,
						`effects = ${String(result.json?.effects)}, expected 1`,
					);
					return 'effects = 1';
				});
				await check('events.bad-signature', 'deliveries signed by another key are refused', async () => {
					const headers = await signEvent({ signer: forger, body: first.rawBody, timestamp: Math.floor(now() / 1000) + 2 });
					const result = await portal.deliver({ rawBody: first.rawBody, headers: { ...headers }, appId: app.appId });
					expect(result.status >= 400 && result.status < 500, `status ${result.status}`);
					return String(result.status);
				});
				await check('events.tampered', 'a tampered body is refused', async () => {
					const headers = await portal.signBody(first.rawBody, { timestamp: Math.floor(now() / 1000) + 3 });
					const tampered = first.rawBody.replace(first.event.id, createId('evt'));
					const result = await portal.deliver({ rawBody: tampered, headers: { ...headers }, appId: app.appId });
					expect(result.status >= 400 && result.status < 500, `status ${result.status}`);
					return String(result.status);
				});
				await check('events.envelope', 'a signed but non-conformant envelope is refused', async () => {
					const rawBody = JSON.stringify({ ...first.event, id: createId('evt'), type: 'not a type' });
					const headers = await portal.signBody(rawBody, { timestamp: Math.floor(now() / 1000) + 4 });
					const result = await portal.deliver({ rawBody, headers: { ...headers }, appId: app.appId });
					expect(result.status >= 400 && result.status < 500, `status ${result.status}`);
					return String(result.status);
				});
			}
		}

		// Data standard
		await check('data.guard', 'queries without websiteId are rejected by the data guard', async () => {
			const result = await call('/v1/ss-probe/data-guard', { headers: bearer(sk) });
			expect(result.status === 200, `probe /v1/ss-probe/data-guard answered ${result.status} (dev-only probe required)`);
			expect(isObject(result.json) && result.json.rejected === true, 'a query without websiteId was executed');
			return `rejected (${String(result.json.code ?? '')})`;
		});
		for (const [operation, payload] of /** @type {const} */ ([
			['export', { websiteId: CERT_WEBSITE, requestId: 'req_certexport0001' }],
			[
				'anonymize',
				{ websiteId: CERT_WEBSITE, requestId: 'req_certanonym0001', subject: { customerId: 'cus_certcustomer1' } },
			],
		])) {
			await check(
				`data.${operation}`,
				`POST /v1/data:${operation} requires a Portal signature and succeeds when signed`,
				async () => {
					const rawBody = JSON.stringify(payload);
					const unsigned = await call(`/v1/data:${operation}`, {
						method: 'POST',
						raw: rawBody,
						headers: { 'idempotency-key': payload.requestId },
					});
					expect(unsigned.status === 401 || unsigned.status === 403, `unsigned request answered ${unsigned.status}`);
					const headers = await portal.signRequest({
						method: 'POST',
						path: `/v1/data:${operation}`,
						body: rawBody,
						appId: app.appId,
					});
					const signed = await call(`/v1/data:${operation}`, {
						method: 'POST',
						raw: rawBody,
						headers: { ...headers, 'idempotency-key': payload.requestId },
					});
					expect(
						signed.status >= 200 && signed.status < 300,
						`signed request answered ${signed.status}${signed.json?.detail ? ` (${signed.json.detail})` : ''}`,
					);
					return `unsigned ${unsigned.status}, signed ${signed.status}`;
				},
			);
		}

		// Control events: the product reacts to Portal pushes without waiting for its caches to expire.
		if (resource) {
			await check('control.key-revoked', 'key.revoked@1 is honoured immediately', async () => {
				const extra = await portal.issueKeys({ websiteId: CERT_WEBSITE });
				const doomed = /** @type {import('../emulator/portal.js').IssuedKey} */ (extra.find((key) => key.kind === 'sk'));
				const before = await call(resourcePath, { headers: bearer(doomed.key) });
				expect(before.status === 200, `fresh key answered ${before.status}`);
				await portal.revokeKey(doomed.keyId);
				const after = await call(resourcePath, { headers: bearer(doomed.key) });
				expect(after.status === 401, `revoked key answered ${after.status}`);
				return 'revoked → 401';
			});
			await check('control.entitlement-changed', 'entitlement.changed@1 switches an element off and on again', async () => {
				const elementKey = /** @type {string} */ (resourceElement?.key);
				const off = await portal.setEntitlement({ websiteId: CERT_WEBSITE, element: elementKey, enabled: false });
				expect(
					off.deliveries.every((delivery) => delivery.status >= 200 && delivery.status < 300),
					`delivery answered ${off.deliveries.map((delivery) => delivery.error ?? delivery.status).join(', ')}`,
				);
				const disabled = await call(resourcePath, { headers: bearer(sk) });
				await portal.setEntitlement({ websiteId: CERT_WEBSITE, element: elementKey, enabled: true });
				expect(disabled.status === 403, `with the element off the product answered ${disabled.status}`);
				const enabled = await call(resourcePath, { headers: bearer(sk) });
				expect(enabled.status === 200, `after re-enabling the product answered ${enabled.status}`);
				return 'off → 403, on → 200';
			});
		}

		// Offline grace: the Portal goes down, cached entitlements keep the product running.
		if (resource) {
			await check(
				'entitlement.offline-grace',
				'the product keeps serving with the Portal unreachable (cached entitlement)',
				async () => {
					const warm = await call(resourcePath, { headers: bearer(sk) });
					expect(warm.status === 200, `warm-up answered ${warm.status}`);
					await server.stop();
					try {
						const offline = await call(resourcePath, { headers: bearer(sk) });
						expect(offline.status === 200, `with the Portal down the product answered ${offline.status}`);
					} finally {
						await server.start();
					}
					return '200 while offline';
				},
			);
		}
		return finish(slug, 'service', portalUrl);
	} finally {
		await server.stop();
		if (!database) await db.stop?.();
	}
};

/**
 * Element packs: import the headless core and renderer and exercise them with an in-memory client and a fake DOM.
 * @param {{ dir: string, manifest: import('@ss/contracts').Manifest, check: (id: string, title: string, fn: () => Promise<string | { skip: string } | void>) => Promise<boolean>, expect: (condition: boolean, message: string) => void }} input
 */
const packChecks = async ({ dir, manifest, check, expect }) => {
	const strings = await readJson(path.join(dir, 'strings/en.json'));
	for (const element of manifest.elements) {
		const [headlessFile = '', headlessName = ''] = (element.headless ?? '').split('#');
		const [rendererFile = '', rendererName = ''] = (element.renderer ?? '').split('#');
		/** @type {any} */
		let instance = null;
		await check(`pack.${element.key}.headless`, `${element.key}: headless core has the standard shape`, async () => {
			const module = await import(pathToFileURL(path.join(dir, headlessFile)).href);
			const factory = module[headlessName];
			expect(typeof factory === 'function', `${element.headless} is not a function`);
			const client = memoryClient();
			instance = factory({ config: {}, strings: strings.ok ? strings.value : {}, client, emit: () => {} });
			for (const member of ['state', 'subscribe', 'validate', 'destroy'])
				expect(typeof instance[member] === 'function', `missing ${member}()`);
			expect(isObject(instance.actions), 'missing actions');
			expect(Object.isFrozen(instance.state()), 'state() must return an immutable snapshot');
			return Object.keys(instance.actions).join(', ');
		});
		await check(
			`pack.${element.key}.renderer`,
			`${element.key}: renderer produces an accessible root from tokens`,
			async () => {
				expect(instance !== null, 'headless core unavailable');
				const module = await import(pathToFileURL(path.join(dir, rendererFile)).href);
				const render = module[rendererName];
				expect(typeof render === 'function', `${element.renderer} is not a function`);
				const root = render({
					state: instance.state(),
					actions: instance.actions,
					strings: strings.ok ? strings.value : {},
					theme: {},
					slots: {},
					dom: fakeDom(),
				});
				expect(isObject(root), 'render() must return a DOM node');
				const attributes = /** @type {any} */ (root).attributes ?? {};
				if (element.a11y?.role)
					expect(attributes.role === element.a11y.role, `root role ${String(attributes.role)} ≠ ${element.a11y.role}`);
				if (element.a11y?.labels)
					expect(
						typeof attributes['aria-label'] === 'string' && attributes['aria-label'].length > 0,
						'root needs an aria-label',
					);
				instance.destroy();
				return `role ${String(attributes.role ?? '—')}`;
			},
		);
	}
};

const memoryClient = () => {
	/** @type {any[]} */
	const items = [];
	return {
		list: async () => ({ ok: true, value: { items: [...items] } }),
		create: async (/** @type {any} */ input) => {
			const item = {
				id: `item_${items.length + 1}`,
				createdAt: new Date(0).toISOString(),
				updatedAt: new Date(0).toISOString(),
				pinned: false,
				...input,
			};
			items.push(item);
			return { ok: true, value: item };
		},
		update: async (/** @type {string} */ id, /** @type {any} */ patch) => ({
			ok: true,
			value: { ...items.find((item) => item.id === id), ...patch },
		}),
		remove: async (/** @type {string} */ id) => ({ ok: true, value: { id } }),
		get: async (/** @type {string} */ id) => ({ ok: true, value: items.find((item) => item.id === id) }),
	};
};

const fakeDom = () => {
	/** @param {string} tag */
	const createElement = (tag) => {
		/** @type {{ tag: string, attributes: Record<string, string>, children: unknown[], value: string, setAttribute: (name: string, value: string) => void, append: (...nodes: unknown[]) => void, addEventListener: () => void }} */
		const node = {
			tag,
			attributes: {},
			children: [],
			value: '',
			setAttribute: (name, value) => {
				node.attributes[name] = String(value);
			},
			append: (...nodes) => {
				node.children.push(...nodes);
			},
			addEventListener: () => {},
		};
		return node;
	};
	return { createElement, createTextNode: (/** @type {string} */ text) => ({ text }) };
};
