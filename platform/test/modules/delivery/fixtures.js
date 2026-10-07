/**
 * Delivery test fixtures: a pack (notice bar) with real module files, a service product (chat launcher), fake
 * identity / catalog / config / connectors / integration modules over a mutable world, and a Portal harness with the
 * **real** commerce module (signed entitlement documents) and the delivery module on MongoMemoryReplSet.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createPortal } from '../../../src/portal.js';
import { problem } from '../../../src/infra/http.js';
import { defineModule } from '../../../src/infra/modules.js';
import { commerceModule } from '../../../src/modules/commerce/index.js';
import { createDeliveryModule } from '../../../src/modules/delivery/index.js';
import { createMemoryStorage } from '../../../src/modules/delivery/storage.js';
import { PORTAL_URL, T0, createClock, createTestLogger, testConfig } from '../../helpers.js';

export const M1 = 'mer_0123456789abcdefghjkmnpq';
export const M2 = 'mer_1123456789abcdefghjkmnpq';
export const W1 = 'web_0123456789abcdefghjkmnpq';
export const W2 = 'web_1123456789abcdefghjkmnpq';
export const PACK = 'app_0123456789abcdefghjkmnpq';
export const SERVICE = 'app_1123456789abcdefghjkmnpq';
export const BIG = 'app_2123456789abcdefghjkmnpq';
export const DOMAIN = 'shop.example.com';
export const MERCHANT_ACTOR = Object.freeze({ type: 'merchant_user', id: 'usr_owner', merchantId: M1, roles: ['owner'] });
export const STAFF_ACTOR = Object.freeze({ type: 'staff', id: 'stf_alice', roles: ['admin'] });

/** Pack module files (ESM without imports, so tests can load them from data: URLs). */
export const PACK_FILES = Object.freeze({
	'headless/bar.js': [
		'export const createBar = ({ config, strings, emit }) => {',
		"\tlet state = { message: String(config.message ?? ''), label: strings['bar.label'] ?? '', dismissed: false };",
		'\tconst listeners = new Set();',
		'\treturn {',
		'\t\tstate: () => state,',
		'\t\tsubscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },',
		'\t\tactions: { dismiss: async () => { state = { ...state, dismissed: true }; for (const fn of listeners) fn(state); emit("dismissed", {}); return { ok: true, value: null }; } },',
		'\t\tdestroy: () => listeners.clear(),',
		'\t};',
		'};',
		'',
	].join('\n'),
	'ui/bar.js': [
		"export const styles = '.ss-bar { color: var(--ss-color-text); }';",
		'export const render = ({ state, dom }) => {',
		"\tconst el = dom.createElement('div');",
		"\tel.className = 'ss-bar';",
		"\tel.setAttribute('aria-label', state.label);",
		'\tel.textContent = state.message;',
		'\treturn el;',
		'};',
		'',
	].join('\n'),
	'strings/en.json': JSON.stringify({ 'bar.label': 'Notice' }),
	'img/logo.png': Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('latin1'),
});

/** @param {string} path */
export const fileBytes = (path) =>
	path.endsWith('.png')
		? Buffer.from(/** @type {Record<string, string>} */ (PACK_FILES)[path] ?? '', 'latin1')
		: Buffer.from(/** @type {Record<string, string>} */ (PACK_FILES)[path] ?? '', 'utf8');

const TYPES = /** @type {Record<string, string>} */ ({
	js: 'text/javascript',
	json: 'application/json',
	png: 'image/png',
});

/** Descriptor entries of the pack files. */
export const packAssets = () =>
	Object.keys(PACK_FILES).map((path) => {
		const bytes = fileBytes(path);
		return {
			path,
			sha256: createHash('sha256').update(bytes).digest('hex'),
			size: bytes.byteLength,
			contentType: TYPES[path.slice(path.lastIndexOf('.') + 1)],
		};
	});

/**
 * Notice-bar pack: `bar` (mode A, placement via the `placement` feature) and `tip` (mode B only, never delivered).
 * @param {{ placement?: Record<string, unknown> }} [options]
 */
export const packManifest = ({ placement = { paths: { include: ['/**'] } } } = {}) => ({
	ssps: '1',
	product: { slug: 'notice-bar', name: 'Notice bar', kind: 'pack', version: '1.0.0', category: 'content' },
	elements: [
		{
			key: 'bar',
			name: 'Bar',
			modes: ['A', 'B'],
			price: { hourly: 0 },
			placement: true,
			strings: 'strings/en.json',
			headless: 'headless/bar.js#createBar',
			renderer: 'ui/bar.js#render',
			features: {
				type: 'object',
				properties: {
					message: { type: 'string', title: 'Message', default: 'Free shipping today' },
					placement: { type: 'object', title: 'Placement', default: placement },
				},
			},
		},
		{ key: 'tip', name: 'Tip', modes: ['B'], price: { hourly: 0 }, headless: 'headless/bar.js#createBar' },
	],
	plans: [{ code: 'free', name: 'Free', elements: ['bar', 'tip'] }],
	priceBook: { version: 'v1', effectiveFrom: '2026-01-01T00:00:00Z' },
});

/** Chat service product: `launcher` (mode A, delivered once its widgets are uploaded) and `inbox` (mode C only). */
export const serviceManifest = () => ({
	ssps: '1',
	product: { slug: 'chat-box', name: 'Chat', kind: 'service', version: '1.0.0', category: 'engagement' },
	endpoints: { base: 'https://chat.example.net', events: '/.well-known/ss-events' },
	elements: [
		{
			key: 'launcher',
			name: 'Launcher',
			modes: ['A', 'B', 'C'],
			price: { hourly: 0 },
			placement: true,
			headless: 'headless/launcher.js#createLauncher',
			renderer: 'ui/launcher.js#render',
			api: { resources: ['conversations'] },
		},
		{ key: 'inbox', name: 'Inbox', modes: ['C'], price: { hourly: 0 }, api: { resources: ['messages'] } },
	],
	plans: [{ code: 'free', name: 'Free', elements: ['launcher', 'inbox'] }],
	priceBook: { version: 'v1', effectiveFrom: '2026-01-01T00:00:00Z' },
});

/** A second pack (`gallery`, same modules). */
export const bigManifest = () => ({
	...packManifest(),
	product: { slug: 'big-gallery', name: 'Gallery', kind: 'pack', version: '1.0.0', category: 'content' },
	elements: [{ ...packManifest().elements[0], key: 'gallery' }],
	plans: [{ code: 'free', name: 'Free', elements: ['gallery'] }],
});

/**
 * @typedef {object} World
 * @property {Map<string, Record<string, any>>} merchants
 * @property {Map<string, Record<string, any>>} websites
 * @property {Map<string, { app: Record<string, any>, versions: Map<number, { manifest: Record<string, any>, status: string, assets: any[] | null }> }>} apps
 * @property {Map<string, Record<string, any>>} layers by subscriptionId
 * @property {Map<string, { keyId: string, websiteId: string, merchantId: string, kind: string, key: string, status: string, scopes: string[] }>} keys
 * @property {any[]} events
 * @property {Array<{ appId: string, version: number }>} ready `catalog.versionReady` calls
 */

/** @returns {World} */
export const createWorld = () => {
	const created = new Date(T0 - 30 * 86_400_000).toISOString();
	/** @type {World} */
	const world = {
		merchants: new Map([
			[M1, { merchantId: M1, name: 'One', status: 'active', createdAt: created }],
			[M2, { merchantId: M2, name: 'Two', status: 'active', createdAt: created }],
		]),
		websites: new Map([
			[W1, { websiteId: W1, merchantId: M1, domain: DOMAIN, env: 'live', twinId: null, status: 'active', createdAt: created }],
			[
				W2,
				{
					websiteId: W2,
					merchantId: M2,
					domain: 'two.example.org',
					env: 'test',
					twinId: null,
					status: 'active',
					createdAt: created,
				},
			],
		]),
		apps: new Map([
			[
				PACK,
				{
					app: { appId: PACK, slug: 'notice-bar', kind: 'pack', status: 'active', baseUrl: null, currentVersion: 1 },
					versions: new Map([[1, { manifest: packManifest(), status: 'accepted', assets: packAssets() }]]),
				},
			],
			[
				SERVICE,
				{
					app: {
						appId: SERVICE,
						slug: 'chat-box',
						kind: 'service',
						status: 'active',
						baseUrl: 'https://chat.example.net',
						currentVersion: 1,
					},
					versions: new Map([[1, { manifest: serviceManifest(), status: 'accepted', assets: null }]]),
				},
			],
			[
				BIG,
				{
					app: { appId: BIG, slug: 'big-gallery', kind: 'pack', status: 'active', baseUrl: null, currentVersion: 1 },
					versions: new Map([[1, { manifest: bigManifest(), status: 'accepted', assets: packAssets() }]]),
				},
			],
		]),
		layers: new Map(),
		keys: new Map(),
		events: [],
		ready: [],
	};
	return world;
};

/** @param {World} world */
export const fakeModules = (world) => [
	defineModule({
		name: 'identity',
		service: () => ({
			getMerchant: async (/** @type {string} */ id) =>
				world.merchants.get(id) ?? Promise.reject(problem('not_found', 'No such merchant.')),
			getWebsite: async (/** @type {string} */ id) =>
				structuredClone(world.websites.get(id)) ?? Promise.reject(problem('not_found', 'No such website.')),
			issueKey: async (/** @type {any} */ { websiteId, merchantId, kind, scopes }) => {
				const keyId = `key_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
				const website = /** @type {any} */ (world.websites.get(websiteId));
				const key = `${kind}_${website.env}_${randomUUID().replace(/-/g, '')}`;
				world.keys.set(keyId, { keyId, websiteId, merchantId, kind, key, status: 'active', scopes });
				return { keyId, websiteId, kind, scopes, key };
			},
			listKeys: async (/** @type {any} */ { websiteId }) =>
				[...world.keys.values()]
					.filter((k) => k.websiteId === websiteId)
					.map((k) => Object.fromEntries(Object.entries(k).filter(([name]) => name !== 'key'))),
			revokeKey: async (/** @type {any} */ { keyId }) => {
				const key = world.keys.get(keyId);
				if (key) key.status = 'revoked';
				return {};
			},
		}),
	}),
	defineModule({
		name: 'catalog',
		service: () => ({
			getApp: async (/** @type {string} */ appId) => {
				const entry = world.apps.get(appId);
				if (!entry) throw problem('not_found', 'No such app.');
				return { ...entry.app };
			},
			getManifest: async (/** @type {string} */ appId, /** @type {number | undefined} */ version) => {
				const entry = world.apps.get(appId);
				const v = entry?.versions.get(version ?? entry.app.currentVersion);
				if (!v) throw problem('not_found', 'No such version.');
				return structuredClone(v.manifest);
			},
			versionDetail: async (/** @type {string} */ appId, /** @type {number} */ version) => {
				const v = world.apps.get(appId)?.versions.get(version);
				if (!v) throw problem('not_found', 'No such version.');
				return { appId, version, status: v.status, assets: structuredClone(v.assets), manifest: structuredClone(v.manifest) };
			},
			// the real catalog makes the uploaded version current (`manifest.accepted@1`, `commerce.invalidateApp`)
			versionReady: async (/** @type {{ appId: string, version: number }} */ { appId, version }) => {
				const entry = /** @type {any} */ (world.apps.get(appId));
				entry.versions.get(version).status = 'accepted';
				entry.app.currentVersion = version;
				world.ready.push({ appId, version });
			},
		}),
	}),
	defineModule({
		name: 'config',
		service: () => ({ layersFor: async (/** @type {string} */ id) => structuredClone(world.layers.get(id) ?? {}) }),
	}),
	defineModule({ name: 'connectors', service: () => ({ statusFor: async () => [] }) }),
	defineModule({
		name: 'integration',
		service: () => ({
			emitControl: async (/** @type {string} */ type, /** @type {any} */ data, /** @type {any} */ target) => {
				world.events.push({ type, data, target });
			},
		}),
	}),
];

/**
 * Boot a Portal with real commerce + delivery and the fakes.
 * @param {{ db: import('mongodb').Db, clock?: ReturnType<typeof createClock>, env?: Record<string, string>,
 *   system?: Partial<import('../../../src/infra/config.js').SystemState>, delivery?: import('../../../src/modules/delivery/service.js').DeliveryOptions }} input
 */
export const bootDelivery = async ({ db, clock = createClock(T0), env = {}, system = {}, delivery = {} }) => {
	const world = createWorld();
	const config = await testConfig(env, system);
	const { logger, entries } = createTestLogger();
	const storage = delivery.storage === undefined ? createMemoryStorage() : delivery.storage;
	const portal = createPortal({
		config,
		db,
		modules: [commerceModule, createDeliveryModule({ ...delivery, storage }), ...fakeModules(world)],
		logger,
		now: clock.now,
	});
	await portal.ensureIndexes();
	/** @type {import('../../../src/modules/commerce/service.js').CommerceService} */
	const commerce = /** @type {any} */ (portal.modules.service('commerce'));
	/** @type {import('../../../src/modules/delivery/service.js').DeliveryService} */
	const service = /** @type {any} */ (portal.modules.service('delivery'));

	/** @param {{ kind?: 'staff' | 'merchant', merchantId?: string, roles?: string[] }} [who] */
	const cookie = async ({ kind = 'merchant', merchantId = M1, roles = ['owner'] } = {}) => {
		const { token } = await portal.shared.sessions.create({
			kind,
			subject: kind === 'staff' ? 'stf_alice' : 'usr_owner',
			roles,
			mfa: true,
			...(kind === 'merchant' ? { merchantId } : {}),
		});
		return `${portal.shared.cookies.name(kind)}=${token}`;
	};

	/**
	 * @param {string} method
	 * @param {string} path
	 * @param {{ body?: unknown, raw?: Uint8Array | string, cookie?: string, headers?: Record<string, string> }} [init]
	 */
	const request = async (method, path, { body, raw, cookie: c, headers = {} } = {}) => {
		const response = await portal.handle(
			new Request(`${PORTAL_URL}${path}`, {
				method,
				headers: {
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
					...(c ? { cookie: c, origin: PORTAL_URL, 'sec-fetch-site': 'same-origin' } : {}),
					...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}),
					...headers,
				},
				...(raw !== undefined
					? { body: /** @type {any} */ (raw) }
					: body === undefined
						? {}
						: { body: JSON.stringify(body) }),
			}),
		);
		const bytes = new Uint8Array(await response.arrayBuffer());
		const text = Buffer.from(bytes).toString('utf8');
		const type = response.headers.get('content-type') ?? '';
		return {
			status: response.status,
			headers: response.headers,
			bytes,
			text,
			json: type.includes('json') && text ? JSON.parse(text) : null,
		};
	};

	/**
	 * Upload files of an app version as staff (default: every pack file).
	 * @param {string} appId @param {number} [version] @param {ReadonlyArray<string>} [paths]
	 */
	const uploadAll = async (appId, version = 1, paths = Object.keys(PACK_FILES)) => {
		const staff = await cookie({ kind: 'staff', roles: ['admin'] });
		for (const asset of packAssets().filter((a) => paths.includes(a.path))) {
			const res = await request('PUT', `/v1/admin/packs/${appId}/versions/${version}/assets/${asset.path}`, {
				raw: fileBytes(asset.path),
				cookie: staff,
				headers: { 'content-type': /** @type {string} */ (asset.contentType) },
			});
			if (res.status !== 200) throw new Error(`upload ${asset.path}: ${res.status} ${res.text}`);
		}
	};

	/** Subscribe (credits first) and return the subscription. @param {string} websiteId @param {string} appId */
	const subscribe = async (websiteId, appId) => {
		const website = /** @type {any} */ (world.websites.get(websiteId));
		await commerce.addCredits({
			merchantId: website.merchantId,
			amountMillicredits: 100_000,
			reference: `ref-${randomUUID()}`,
			note: 'test',
			actor: /** @type {any} */ ({ type: 'staff', id: 'stf_finance', roles: ['finance'] }),
		});
		return commerce.subscribe({ websiteId, appId, planCode: 'free', actor: /** @type {any} */ (MERCHANT_ACTOR) });
	};

	return { portal, world, commerce, service, storage, clock, logs: entries, cookie, request, uploadAll, subscribe, db };
};

/** Widget files of the chat service (the pack's module files, reused) and its `ss pack build` descriptor. */
export const WIDGET_FILES = Object.freeze(['headless/bar.js', 'ui/bar.js']);
export const widgetDescriptor = () => ({
	format: 'ss-pack-bundle@1',
	manifest: {
		...serviceManifest(),
		elements: [
			{ ...serviceManifest().elements[0], headless: 'headless/bar.js#createBar', renderer: 'ui/bar.js#render' },
			serviceManifest().elements[1],
		],
	},
	assets: packAssets().filter((a) => WIDGET_FILES.includes(a.path)),
});
