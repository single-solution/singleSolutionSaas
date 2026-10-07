// @vitest-environment jsdom
/**
 * Admin Console apps pages in the browser (jsdom) against a mocked `fetch`: the pack folder upload (descriptor POST,
 * then a raw `PUT` per missing asset, with progress and errors), the Active / Inactive switch, the upload button per
 * app kind, "Retry deliveries now", the admin launch and the price-change note of a reconnect.
 */
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@ss/ui';
import { act, cleanup, render, type, byLabel } from '@ss/ui/testing';
import { adminUpload } from '../../src/console/admin/client.js';
import { AddProductDialog, AppView, PackDialog, hasWidgets, packFolder } from '../../src/console/admin/views/apps.js';

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const STAFF = { staffId: 'stf_1', roles: ['superadmin'] };
const APP_ID = 'app_0000000000notice';
const UPLOAD_PATH = `/v1/admin/packs/${APP_ID}/versions/2/assets/`;

/**
 * A picked file: a Node Blob (it has `text()` and is a valid fetch body) carrying the folder-relative path.
 * @param {string} path
 * @param {string} content
 * @param {string} [contentType]
 */
const file = (path, content, contentType = 'text/javascript') =>
	/** @type {File} */ (
		/** @type {unknown} */ (
			Object.assign(new NodeBlob([content], { type: contentType }), { name: path.split('/').at(-1), webkitRelativePath: path })
		)
	);

const descriptor = {
	format: 'ss-pack-bundle@1',
	manifest: { product: { slug: 'notice-bar', kind: 'pack' } },
	assets: [
		{ path: 'headless/bar.js', sha256: 'a'.repeat(64), size: 10, contentType: 'text/javascript' },
		{ path: 'ui/bar.css', sha256: 'b'.repeat(64), size: 10, contentType: 'text/css' },
	],
};

/**
 * `fetch` mock: answers by `METHOD path` (a function or a `[status, body]`), records every call.
 * @param {Record<string, [number, any] | ((init: any) => [number, any])>} routes
 */
const mockFetch = (routes) => {
	/** @type {Array<{ method: string, path: string, headers: Record<string, string>, body: any }>} */
	const calls = [];
	vi.stubGlobal('fetch', async (/** @type {string} */ path, /** @type {any} */ init = {}) => {
		const method = init.method ?? 'GET';
		calls.push({ method, path, headers: init.headers ?? {}, body: init.body });
		const route = routes[`${method} ${path}`] ?? [404, { title: 'Not found' }];
		const [status, body] = typeof route === 'function' ? route(init) : route;
		return new Response(body === null ? null : JSON.stringify(body), { status });
	});
	return calls;
};

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = async (rounds = 4) => {
	for (let i = 0; i < rounds; i += 1)
		await act(async () => {
			await sleep(5);
		});
};
/** @param {string} snippet */
const shows = (snippet) => document.body.textContent?.replace(/\s+/g, ' ').includes(snippet) ?? false;
/** @param {string} label */
const press = async (label) => {
	const found = [...document.querySelectorAll('button')].filter((b) => b.textContent?.trim() === label).at(-1);
	if (!found) throw new Error(`no button “${label}”`);
	await act(async () => {
		found.click();
	});
	await settle();
};
/** @param {File[]} files */
const pick = async (files) => {
	const input = /** @type {HTMLInputElement} */ (document.querySelector('input[type="file"]'));
	expect(input.hasAttribute('webkitdirectory')).toBe(true);
	Object.defineProperty(input, 'files', { value: files, configurable: true });
	await act(async () => {
		input.dispatchEvent(new Event('change', { bubbles: true }));
	});
};

const folder = () => [
	file('dist/pack/descriptor.json', JSON.stringify(descriptor), 'application/json'),
	file('dist/pack/headless/bar.js', 'export {};'),
	file('dist/pack/ui/bar.css', '.bar{x:1}', ''),
	file('dist/pack/nested/descriptor.json', '{}', 'application/json'),
];

describe('pack folder', () => {
	it('finds the top descriptor and maps the files by folder-relative path', () => {
		const found = packFolder(folder());
		expect(found.descriptor?.webkitRelativePath).toBe('dist/pack/descriptor.json');
		expect([...found.files.keys()].sort()).toEqual([
			'descriptor.json',
			'headless/bar.js',
			'nested/descriptor.json',
			'ui/bar.css',
		]);
		expect(packFolder([file('a.js', 'x')])).toEqual({ descriptor: null, files: new Map() });
		expect(packFolder([file('', '{}')]).descriptor).toBeNull();
		const flat = /** @type {File} */ (/** @type {unknown} */ ({ name: 'descriptor.json', webkitRelativePath: '' }));
		expect(packFolder([flat]).descriptor).toBe(flat);
	});

	it('tells which manifests take widgets', () => {
		expect(hasWidgets(null)).toBe(false);
		expect(hasWidgets({ elements: [{ modes: ['B'] }, {}] })).toBe(false);
		expect(hasWidgets({ elements: [{ modes: ['A', 'B'] }] })).toBe(true);
	});
});

describe('PackDialog', () => {
	it('posts the descriptor, then puts every missing asset with its bytes and type', async () => {
		const calls = mockFetch({
			'POST /v1/admin/packs': [
				201,
				{
					appId: APP_ID,
					slug: 'notice-bar',
					kind: 'pack',
					version: 2,
					status: 'uploading',
					missing: ['headless/bar.js', 'ui/bar.css'],
					uploadPath: UPLOAD_PATH,
					changed: true,
				},
			],
			[`PUT ${UPLOAD_PATH}headless/bar.js`]: [200, { path: 'headless/bar.js' }],
			[`PUT ${UPLOAD_PATH}ui/bar.css`]: [200, { status: 'ready' }],
		});
		const onDone = vi.fn();
		const onClose = vi.fn();
		render(<PackDialog open onClose={onClose} title="Upload pack version" onDone={onDone} />);
		expect(shows('Upload pack version')).toBe(true);
		await press('Upload');
		expect(shows('Choose the folder `ss pack build` wrote')).toBe(true);
		await pick(folder());
		expect(shows('4 files, descriptor.json found.')).toBe(true);
		await press('Upload');
		expect(shows('Uploaded')).toBe(true);
		expect(shows('Version v2 of notice-bar is uploaded (2 files sent).')).toBe(true);
		expect(onDone).toHaveBeenCalled();
		const post = calls.find((c) => c.method === 'POST');
		expect(JSON.parse(post?.body)).toEqual({ descriptor });
		const puts = calls.filter((c) => c.method === 'PUT');
		expect(puts.map((c) => c.path)).toEqual([`${UPLOAD_PATH}headless/bar.js`, `${UPLOAD_PATH}ui/bar.css`]);
		expect(puts.map((c) => c.headers['content-type'])).toEqual(['text/javascript', 'text/css']);
		expect(await puts[1]?.body.text()).toBe('.bar{x:1}');
		expect(document.querySelector('a[href]')?.getAttribute('href')).toBe(`/admin/apps/${APP_ID}`);
		await press('Close').catch(() => undefined);
	});

	it('reports nothing new, a bad descriptor, a refused upload, a missing file and a failed asset', async () => {
		/** @type {any} */
		let answer = [200, { appId: APP_ID, slug: 'notice-bar', version: 1, missing: [], uploadPath: UPLOAD_PATH, changed: false }];
		const calls = mockFetch({
			'POST /v1/admin/packs': () => answer,
			[`PUT ${UPLOAD_PATH}headless/bar.js`]: [409, { title: 'Conflict', detail: 'Checksum mismatch.' }],
		});
		render(<PackDialog open onClose={() => undefined} />);
		expect(shows('Upload a pack')).toBe(true);
		await pick(folder());
		await press('Upload');
		expect(shows('Nothing new')).toBe(true);
		expect(shows('This build matches version v1 of notice-bar; nothing was stored.')).toBe(true);
		cleanup();

		render(<PackDialog open onClose={() => undefined} />);
		await pick([file('x/a.js', '1')]);
		expect(shows('No descriptor.json in this folder.')).toBe(true);
		await pick([file('x/descriptor.json', '{nope')]);
		await press('Upload');
		expect(shows('descriptor.json is not valid JSON')).toBe(true);

		answer = [
			422,
			{ title: 'Invalid manifest', errors: [{ path: '/descriptor/manifest/elements/0/modes', message: 'bad mode' }] },
		];
		await pick(folder());
		await press('Upload');
		expect(shows('descriptor.manifest.elements.0.modes: Bad mode.')).toBe(true);

		answer = [
			201,
			{ appId: APP_ID, slug: 'notice-bar', version: 2, missing: ['gone.js'], uploadPath: UPLOAD_PATH, changed: true },
		];
		await press('Upload');
		expect(shows('gone.js is missing from the folder')).toBe(true);

		answer = [201, { appId: APP_ID, slug: 'notice-bar', version: 2, missing: ['headless/bar.js'], uploadPath: UPLOAD_PATH }];
		await press('Upload');
		expect(shows('headless/bar.js: Checksum mismatch.')).toBe(true);
		expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
	});
});

describe('adminUpload', () => {
	it('maps network errors, non-JSON failures and expired sessions', async () => {
		const blob = /** @type {Blob} */ (/** @type {unknown} */ (new NodeBlob(['x'])));
		vi.stubGlobal('fetch', async () => {
			throw new TypeError('offline');
		});
		expect(await adminUpload('/v1/x', blob)).toMatchObject({ ok: false, status: 0 });
		vi.stubGlobal('fetch', async (/** @type {string} */ _p, /** @type {any} */ init) => {
			expect(init.headers['content-type']).toBe('application/octet-stream');
			return new Response('boom', { status: 500, statusText: 'Server Error' });
		});
		expect(await adminUpload('/v1/x', blob)).toMatchObject({ ok: false, status: 500, problem: { title: 'Server Error' } });
		const assign = vi.fn();
		vi.stubGlobal('location', { ...window.location, assign, pathname: '/admin/apps', search: '' });
		vi.stubGlobal('fetch', async () => new Response(null, { status: 401 }));
		expect(await adminUpload('/v1/x', blob, 'text/plain')).toMatchObject({ ok: false, status: 401 });
	});
});

/** @param {any} app @param {any} [manifest] */
const appPage = (app, manifest = null) =>
	render(
		<ToastProvider>
			<AppView ok app={app} manifest={manifest} staff={STAFF} />
		</ToastProvider>,
	);

const baseApp = {
	appId: APP_ID,
	slug: 'notice-bar',
	name: 'Notice bar',
	createdAt: '2026-01-01T00:00:00.000Z',
	endpoints: { base: 'https://svc.example.com' },
};

describe('AppView', () => {
	it('switches the app active and inactive', async () => {
		const pack = { ...baseApp, kind: 'pack', status: 'inactive', currentVersion: 1, baseUrl: null };
		let status = 'inactive';
		const calls = mockFetch({
			[`POST /v1/admin/apps/${APP_ID}/status`]: (init) => {
				status = JSON.parse(init.body).status;
				return status === 'active' ? [200, { ...pack, status }] : [409, { title: 'Conflict', detail: 'Not now.' }];
			},
			[`GET /v1/admin/apps/${APP_ID}`]: () => [200, { ...pack, status }],
		});
		appPage(pack);
		expect(shows('Upload pack version')).toBe(true);
		expect(shows('Retry deliveries now')).toBe(false);
		expect(shows('Launch as admin')).toBe(false);
		const toggle = /** @type {HTMLElement} */ (document.querySelector('[role="switch"]'));
		expect(toggle.getAttribute('aria-checked')).toBe('false');
		await act(async () => {
			toggle.click();
		});
		await settle();
		expect(calls.find((c) => c.method === 'POST')?.body).toBe(JSON.stringify({ status: 'active' }));
		expect(document.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
		expect(shows('Notice bar: active')).toBe(true);
		await act(async () => {
			/** @type {HTMLElement} */ (document.querySelector('[role="switch"]')).click();
		});
		await settle();
		expect(shows('Not now.')).toBe(true);
		await press('Upload pack version');
		expect(shows('Pick the folder')).toBe(true);
	});

	it('offers widgets upload, delivery retry and the admin launch for service apps', async () => {
		const service = {
			...baseApp,
			kind: 'service',
			status: 'active',
			currentVersion: 3,
			productVersion: '1.2.0',
			baseUrl: 'https://svc.example.com',
		};
		const open = vi.fn();
		vi.stubGlobal('open', open);
		let retry = /** @type {[number, any]} */ ([200, { succeeded: 2, retried: 0, failed: 0 }]);
		const calls = mockFetch({
			[`POST /v1/admin/apps/${APP_ID}/deliveries/retry`]: () => retry,
			[`POST /v1/admin/apps/${APP_ID}/launch`]: [200, { url: 'https://svc.example.com/launch?t=1' }],
		});
		appPage(service, { elements: [{ key: 'bar', modes: ['A'] }] });
		expect(shows('Upload widgets')).toBe(true);
		expect(shows('v3 (1.2.0)')).toBe(true);
		await press('Retry deliveries now');
		expect(shows('2 delivered, 0 still failing')).toBe(true);
		retry = [200, { succeeded: 0, retried: 1, failed: 1 }];
		await press('Retry deliveries now');
		expect(shows('0 delivered, 2 still failing')).toBe(true);
		retry = [403, { title: 'Forbidden', detail: 'Needs platform.jobs.manage.' }];
		await press('Retry deliveries now');
		expect(shows('Needs platform.jobs.manage.')).toBe(true);

		await press('Open Notice bar');
		expect(shows('Enter a merchant id (mer_…).')).toBe(true);
		type(byLabel(document, 'Merchant id'), 'mer_0000000000000000000000000a');
		type(byLabel(document, 'Website id (optional)'), 'bad');
		await press('Open Notice bar');
		expect(shows('Enter a website id')).toBe(true);
		type(byLabel(document, 'Website id (optional)'), 'web_0000000000000000000000000a');
		await press('Open Notice bar');
		const launch = calls.find((c) => c.path.endsWith('/launch'));
		expect(JSON.parse(launch?.body)).toEqual({
			kind: 'admin',
			merchantId: 'mer_0000000000000000000000000a',
			websiteId: 'web_0000000000000000000000000a',
		});
		expect(open).toHaveBeenCalledWith('https://svc.example.com/launch?t=1', '_blank', 'noopener,noreferrer');
		await act(async () => {
			/** @type {HTMLInputElement} */ (document.querySelector('input[type="radio"][value="all"]')).click();
		});
		await press('Open Notice bar');
		expect(JSON.parse(calls.filter((c) => c.path.endsWith('/launch')).at(-1)?.body)).toEqual({ kind: 'admin', all: true });
		cleanup();

		// a service product without mode-A elements takes no widgets; a failed launch shows its problem
		mockFetch({ [`POST /v1/admin/apps/${APP_ID}/launch`]: [409, { title: 'Conflict', detail: 'App inactive.' }] });
		appPage({ ...service, currentVersion: null }, { elements: [{ key: 'api', modes: ['C'] }] });
		expect(shows('Upload widgets')).toBe(false);
		expect(shows('None yet')).toBe(true);
		await act(async () => {
			/** @type {HTMLInputElement} */ (document.querySelector('input[type="radio"][value="all"]')).click();
		});
		await press('Open Notice bar');
		expect(shows('App inactive.')).toBe(true);
	});
});

describe('AddProductDialog', () => {
	it('shows the price changes of a reconnect', async () => {
		mockFetch({
			'POST /v1/admin/apps/connect': [
				201,
				{
					appId: APP_ID,
					slug: 'notice-bar',
					baseUrl: 'https://svc.example.com',
					kid: 'k1',
					reconnected: true,
					priceChanges: [{ element: 'bar', before: { hourly: 1000 }, after: { hourly: 1500 } }],
				},
			],
		});
		render(<AddProductDialog open onClose={() => undefined} />);
		type(byLabel(document, 'Product URL'), 'https://svc.example.com');
		type(byLabel(document, 'Connect secret'), 's'.repeat(40));
		await press('Connect');
		expect(shows('Product reconnected')).toBe(true);
		expect(shows('Prices changed')).toBe(true);
		expect(shows('bar: {"hourly":1000} → {"hourly":1500}')).toBe(true);
	});
});
