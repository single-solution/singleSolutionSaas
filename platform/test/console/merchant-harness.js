/**
 * Shared harness of the Merchant Console browser tests (jsdom): a live in-process Portal, a cookie-jar `fetch` that
 * routes to `portal.handle` (same origin), DOM helpers, and a seeded world (staff, a listed pack, a merchant with a
 * website and credits).
 */
import { vi } from 'vitest';
import { createSigner, generateSigningKey, signBundle } from '@ss/protocol';
import { totpCode } from '../../src/infra/auth.js';
import { createPortal } from '../../src/portal.js';
import { modules as defaultModules } from '../../src/modules/index.js';
import { createIdentityModule } from '../../src/modules/identity/index.js';
import { createConnectorsModule } from '../../src/modules/connectors/index.js';
import { BUNDLE_FORMAT } from '../../src/modules/catalog/core/bundle.js';
import { createConsoleApi } from '../../src/console/api.js';
import { act, byLabel, type } from '@ss/ui/testing';
import { PORTAL_URL, createTestLogger, testConfig } from '../helpers.js';

export const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Let pending fetches and state updates settle (inside act). */
export const settle = async (rounds = 3) => {
	for (let i = 0; i < rounds; i += 1)
		await act(async () => {
			await sleep(15);
		});
};

/**
 * Wait until `check` passes (state updates applied inside act).
 * @param {() => unknown} check
 * @param {number} [timeoutMs]
 */
export const until = async (check, timeoutMs = 30_000) => {
	const end = Date.now() + timeoutMs;
	for (;;) {
		try {
			const value = check();
			if (value !== false && value !== null && value !== undefined) return value;
		} catch (error) {
			if (Date.now() > end) throw error;
		}
		if (Date.now() > end) throw new Error('timed out waiting for the UI');
		await act(async () => {
			await sleep(20);
		});
	}
};

/** The open dialog (the last one), or throws. */
export const dialog = () => {
	const all = [...document.querySelectorAll('[role="dialog"]')];
	const last = all.at(-1);
	if (!last) throw new Error('no open dialog');
	return /** @type {HTMLElement} */ (last);
};

/**
 * Buttons labelled `label` (text, or aria-label) inside `root`.
 * @param {string} label
 * @param {ParentNode} [root]
 */
export const buttons = (label, root = document) =>
	/** @type {HTMLButtonElement[]} */ ([...root.querySelectorAll('button')]).filter(
		(b) => b.textContent?.replace(/\s+/g, ' ').trim() === label || b.getAttribute('aria-label') === label,
	);

/** @param {string} label @param {ParentNode} [root] */
export const button = (label, root = document) => {
	const last = buttons(label, root).at(-1);
	if (!last) throw new Error(`no button “${label}”`);
	return last;
};

/** @param {string} label @param {ParentNode} [root] */
export const press = async (label, root) => {
	// a click on a disabled (busy) button is a no-op: wait until the view re-enables it, which is slow under load
	await until(() => !(/** @type {HTMLButtonElement} */ (button(label, root)).disabled));
	await act(async () => {
		button(label, root).click();
	});
	await settle(1);
};

/** Press a button of the open dialog. @param {string} label */
export const pressDialog = (label) => press(label, dialog());

/** @param {Element} el */
export const clickEl = async (el) => {
	await act(async () => {
		/** @type {HTMLElement} */ (el).click();
	});
	await settle(1);
};

/** @param {string} label @param {string} value */
export const fill = (label, value) => type(byLabel(document, label), value);

/** @param {string} label @param {string} value */
export const fillDialog = (label, value) => type(byLabel(dialog(), label), value);

/** Click the control labelled `label` (checkbox, radio). @param {string} label @param {ParentNode} [root] */
export const check = (label, root = document) => clickEl(byLabel(root, label));

/** @param {string} snippet */
export const shows = (snippet) => document.body.textContent?.replace(/\s+/g, ' ').includes(snippet) ?? false;

/**
 * A browser for one Portal: `fetch` goes to `portal.handle` with this browser's cookies (same origin).
 * @param {import('../../src/portal.js').Portal} portal
 */
export const browserOf = (portal) => {
	/** @type {Map<string, string>} */
	const jar = new Map();
	/** @type {Array<{ method: string, path: string, status: number, body: any }>} */
	const calls = [];
	const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
	/** @param {string[]} list */
	const store = (list) => {
		for (const set of list) {
			const [pair = ''] = set.split(';');
			const i = pair.indexOf('=');
			const value = pair.slice(i + 1);
			if (value) jar.set(pair.slice(0, i), value);
			else jar.delete(pair.slice(0, i));
		}
	};
	/** @type {typeof fetch} */
	const fetchImpl = async (input, init = {}) => {
		const url = new URL(String(input), PORTAL_URL);
		const method = init.method ?? 'GET';
		const headers = new Headers(/** @type {any} */ (init.headers));
		if (jar.size > 0) headers.set('cookie', cookie());
		if (method !== 'GET') {
			headers.set('origin', PORTAL_URL);
			headers.set('sec-fetch-site', 'same-origin');
		}
		const response = await portal.handle(
			new Request(url, { method, headers, ...(init.body === undefined ? {} : { body: /** @type {any} */ (init.body) }) }),
		);
		store(response.headers.getSetCookie());
		const text = await response.text();
		let body = null;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {
			body = text;
		}
		calls.push({ method, path: `${url.pathname}${url.search}`, status: response.status, body });
		const empty = [101, 204, 205, 304].includes(response.status);
		return new Response(empty ? null : text, { status: response.status, headers: response.headers });
	};
	const api = createConsoleApi({
		handle: portal.handle,
		baseUrl: PORTAL_URL,
		cookie: () => cookie() || null,
		onSetCookie: store,
	});
	/**
	 * Wait for a call matching method/path (string = exact path or prefix with `*`, or predicate).
	 * @param {string} method
	 * @param {string | ((path: string) => boolean)} path
	 * @param {(status: number) => boolean} [status]
	 */
	const waitCall = async (method, path, status = () => true) => {
		/** @param {(typeof calls)[number]} c */
		const samePath = (c) => c.method === method && (typeof path === 'function' ? path(c.path) : c.path === path);
		const found = await until(() => calls.find((c) => samePath(c) && status(c.status))).catch((error) => {
			// name what did happen, so a timeout is diagnosable
			const seen = calls.filter(samePath).map((c) => `${c.status} ${JSON.stringify(c.body).slice(0, 160)}`);
			throw new Error(`${/** @type {Error} */ (error).message}: ${method} ${String(path)} answered [${seen.join(', ')}]`);
		});
		// the response is recorded before the view applies it: let the view settle (busy flags, state)
		await settle(3);
		return /** @type {(typeof calls)[number]} */ (found);
	};
	return { jar, calls, fetch: fetchImpl, api, waitCall, use: () => vi.stubGlobal('fetch', fetchImpl) };
};

/** A pack with configurable features (experiments, plan bounds, lockable), two plans and an add-on. */
export const packManifest = () => ({
	ssps: '1',
	product: {
		slug: 'notice-bar',
		name: 'Notice bar',
		kind: 'pack',
		version: '0.1.0',
		category: 'storefront',
		description: 'A bar on top.',
	},
	elements: [
		{
			key: 'bar',
			name: 'Notice bar',
			modes: ['A', 'B'],
			price: { hourly: 1250 },
			budget: { js: 3 },
			placement: true,
			experiments: true,
			headless: 'headless/bar.js#createBar',
			renderer: 'ui/bar.js#render',
			features: {
				type: 'object',
				additionalProperties: false,
				properties: {
					message: {
						type: 'string',
						title: 'Message',
						default: 'Hello',
						maxLength: 140,
						'x-kind': 'config',
						'x-experiment': true,
						'x-ui': { widget: 'textarea', group: 'Content', order: 1, help: 'Shown in the bar' },
					},
					tone: {
						type: 'string',
						title: 'Tone',
						default: 'info',
						enum: ['info', 'warning'],
						'x-ui': { group: 'Content', order: 2 },
					},
					maxPerDay: {
						type: 'integer',
						title: 'Max per day',
						default: 3,
						minimum: 1,
						maximum: 100,
						'x-kind': 'limit',
						'x-plan': { basic: { default: 2, max: 5 } },
						'x-lock': true,
					},
					dismissible: { type: 'boolean', title: 'Dismissible', default: true, 'x-ui': { advanced: true } },
				},
			},
		},
		{
			key: 'badge',
			name: 'Trust badge',
			modes: ['A', 'B'],
			price: { hourly: 500 },
			budget: { js: 2 },
			placement: true,
			headless: 'headless/badge.js#createBadge',
			renderer: 'ui/badge.js#render',
			features: {
				type: 'object',
				additionalProperties: false,
				properties: { label: { type: 'string', title: 'Badge label', default: 'Secure', maxLength: 40 } },
			},
		},
	],
	plans: [
		{ code: 'basic', name: 'Basic', elements: ['bar'], addons: ['badge'] },
		{ code: 'plus', name: 'Plus', elements: ['bar', 'badge'] },
	],
	priceBook: { version: '1', effectiveFrom: '2026-01-01T00:00:00.000Z' },
});

/**
 * A Portal with a recording mailer and controllable connector probes.
 * @param {{ db: import('mongodb').Db }} options
 */
export const createWorld = async ({ db }) => {
	/** @type {Array<{ to: string, template: string, data: Record<string, any> }>} */
	const mail = [];
	const mailer = { available: true, send: async (/** @type {any} */ m) => void mail.push(m) };
	/** Next connector check outcome (true = passes). */
	const probe = { ok: true };
	const probes = /** @type {any} */ ({
		run: async () => ({
			ok: probe.ok,
			checkedAt: new Date().toISOString(),
			durationMs: 3,
			checks: [
				{ name: 'reachability', ok: true },
				{ name: 'auth', ok: probe.ok, ...(probe.ok ? {} : { code: 'auth_failed' }) },
			],
			warnings: probe.ok ? [] : ['tls_unverified'],
		}),
	});
	const modules = defaultModules.map((m) =>
		m.name === 'identity' ? createIdentityModule({ mailer }) : m.name === 'connectors' ? createConnectorsModule({ probes }) : m,
	);
	const portal = createPortal({ config: await testConfig(), db, modules, logger: createTestLogger().logger });
	await portal.ensureIndexes();
	/** @param {string} to @param {string} template */
	const tokenOf = (to, template) => {
		const message = [...mail].reverse().find((m) => m.to === to && m.template === template);
		return decodeURIComponent(String(message?.data.link).split('#token=')[1] ?? '');
	};

	// staff (signed in with MFA) for seeding
	const staff = browserOf(portal);
	const { link } = await /** @type {any} */ (portal.modules.service('identity')).bootstrapSuperadmin({
		email: 'staff@ss.test',
	});
	const staffPassword = 'staff password 123!';
	await staff.api.post('/v1/auth/staff/password-reset/confirm', {
		token: decodeURIComponent(String(link).split('#token=')[1] ?? ''),
		password: staffPassword,
	});
	await staff.api.post('/v1/auth/staff/login', { email: 'staff@ss.test', password: staffPassword });
	const enrol = await staff.api.post('/v1/auth/staff/mfa/enrol');
	await staff.api.post('/v1/auth/staff/mfa/confirm', { code: totpCode(enrol.ok ? enrol.data.secret : '', Date.now()) });

	/** Upload and activate the pack. */
	const seedPack = async () => {
		const dev = await generateSigningKey({ kid: 'dev-1' });
		const descriptor = /** @type {any} */ ({
			format: BUNDLE_FORMAT,
			manifest: packManifest(),
			assets: [
				{ path: 'headless/bar.js', sha256: 'a'.repeat(64), size: 1200, contentType: 'text/javascript' },
				{ path: 'ui/bar.js', sha256: 'b'.repeat(64), size: 2400, contentType: 'text/javascript' },
				{ path: 'headless/badge.js', sha256: 'c'.repeat(64), size: 900, contentType: 'text/javascript' },
				{ path: 'ui/badge.js', sha256: 'd'.repeat(64), size: 1000, contentType: 'text/javascript' },
			],
		});
		const uploaded = await staff.api.post('/v1/admin/packs', {
			descriptor,
			signature: await signBundle({ signer: createSigner(dev.privateJwk), descriptor }),
			publicJwk: dev.publicJwk,
		});
		if (!uploaded.ok) throw new Error(`pack upload: ${JSON.stringify(uploaded.problem)}`);
		const appId = uploaded.data.app.appId;
		const activated = await staff.api.post(`/v1/admin/apps/${appId}/lifecycle`, { action: 'activate' });
		if (!activated.ok) throw new Error('activate');
		return /** @type {string} */ (appId);
	};

	/**
	 * Sign a merchant up and verify it through the API (a signed-in browser).
	 * @param {string} email @param {string} merchantName
	 */
	const signup = async (email, merchantName, password = 'correct horse battery') => {
		const b = browserOf(portal);
		await b.api.post('/v1/auth/merchant/signup', { email, password, merchantName });
		await b.api.post('/v1/auth/merchant/verify-email', { token: tokenOf(email, 'verify_email') });
		const me = await b.api.get('/v1/me');
		if (!me.ok) throw new Error('signup');
		return { b, me: me.data, merchantId: /** @type {string} */ (me.data.merchantId) };
	};

	/** @param {string} merchantId @param {number} millicredits @param {string} reference */
	const credit = async (merchantId, millicredits, reference) => {
		const r = await staff.api.post(`/v1/admin/merchants/${merchantId}/credits`, {
			amountMillicredits: millicredits,
			reference,
			note: 'wire',
		});
		if (!r.ok) throw new Error(`credit: ${JSON.stringify(r.problem)}`);
	};

	return { portal, mail, tokenOf, staff, probe, seedPack, signup, credit };
};

/** Silence React/jsdom noise (navigation is not implemented in jsdom) for the duration of a test. */
export const quiet = () => {
	const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
	const warns = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	return () => {
		errors.mockRestore();
		warns.mockRestore();
	};
};
