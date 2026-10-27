/**
 * Shared harness of the console tests (jsdom and server render): a live in-process Portal, a cookie-jar `fetch` that
 * routes to `portal.handle` (same origin), DOM helpers, and a seeded world (the first Owner, admins of every role,
 * merchants, websites, connected fake products, products on websites, credits).
 */
import { vi } from 'vitest';
import { manifest } from '@ss/contracts/testing';
import { createPortal } from '../../src/portal.js';
import { systemModule } from '../../src/modules/system/index.js';
import { createCatalogModule } from '../../src/modules/catalog/index.js';
import { createIdentityModule } from '../../src/modules/identity/index.js';
import { commerceModule } from '../../src/modules/commerce/index.js';
import { websiteModule } from '../../src/modules/website/index.js';
import { createConsoleApi } from '../../src/console/api.js';
import { act, byLabel, type } from '@ss/ui/testing';
import { totpCode } from '../../src/infra/auth.js';
import { createSystemStore } from '../../src/infra/system.js';
import { ENCRYPTION_KEY, PORTAL_URL, createTestLogger, testConfig } from '../helpers.js';
import { startFakeProduct } from '../modules/catalog/fakes/product.js';

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
 * Buttons labeled `label` (text, or aria-label) inside `root`.
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

/**
 * Open the More menu (⋯) labeled `label` and press its item `item` (a website card's Setup, Install and tokens, Usage …).
 * @param {string} label
 * @param {string} item
 */
export const pressMenu = async (label, item) => {
	await press(label);
	await press(item, /** @type {ParentNode} */ (document.querySelector('[role="menu"]')));
};

/** The items of the open menu, in order. */
export const menuItems = () =>
	[...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].map((b) => b.textContent?.replace(/\s+/g, ' ').trim());

/** Press a button of the open dialog. @param {string} label */
export const pressDialog = (label) => press(label, dialog());

/** Forget the chosen section or tab (the address hash), as a fresh page load does. */
export const resetHash = () => {
	if (typeof window !== 'undefined') window.history.replaceState(null, '', window.location.pathname + window.location.search);
};

/**
 * Open a section of the inner sidebar (only the opened section is on the page) or a sub-item.
 * @param {string} label the link's text (a badge after it is fine)
 */
export const openSection = async (label) => {
	const links = /** @type {HTMLAnchorElement[]} */ ([...document.querySelectorAll('nav a[href^="#"]')]);
	const text = (/** @type {Element} */ el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '';
	const link = links.find((a) => text(a) === label) ?? links.find((a) => text(a).startsWith(label));
	if (!link) throw new Error(`no section “${label}” (have: ${links.map(text).join(', ')})`);
	await act(async () => {
		link.click();
	});
	await settle(1);
};

/**
 * Open a tab of a detail (the parts of a merchant, a product, an admin).
 * @param {string} label the tab's text (a count after it is fine)
 */
export const openTab = async (label) => {
	const tabs = /** @type {HTMLElement[]} */ ([...document.querySelectorAll('[role="tab"]')]);
	const text = (/** @type {Element} */ el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '';
	const tab = tabs.find((t) => text(t) === label) ?? tabs.find((t) => text(t).startsWith(label));
	if (!tab) throw new Error(`no tab “${label}” (have: ${tabs.map(text).join(', ')})`);
	await act(async () => {
		tab.click();
	});
	await settle(1);
};

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

/** @param {string} snippet */
export const shows = (snippet) => document.body.textContent?.replace(/\s+/g, ' ').includes(snippet) ?? false;

/**
 * A browser for one Portal: `fetch` goes to `portal.handle` with this browser's cookies (same origin).
 * @param {import('../../src/portal.js').Portal} portal
 * @param {string} [password] the password of the person (a test types it into the confirmation of a server token)
 */
export const browserOf = (portal, password = 'correct horse battery') => {
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
	/**
	 * A change made outside the page, sent as this browser would send it (not recorded in `calls`).
	 * @param {string} method @param {string} path @param {unknown} [body]
	 * @returns {Promise<import('../../src/console/api.js').ApiResult>}
	 */
	const write = async (method, path, body) => {
		const headers = new Headers({ origin: PORTAL_URL, 'sec-fetch-site': 'same-origin' });
		if (jar.size > 0) headers.set('cookie', cookie());
		if (body !== undefined) headers.set('content-type', 'application/json');
		if (method === 'POST') headers.set('idempotency-key', globalThis.crypto.randomUUID());
		const response = await portal.handle(
			new Request(new URL(path, PORTAL_URL), {
				method,
				headers,
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
		store(response.headers.getSetCookie());
		const text = await response.text();
		const data = text ? JSON.parse(text) : null;
		return response.ok
			? { ok: true, status: response.status, data }
			: { ok: false, status: response.status, problem: { status: response.status, ...data } };
	};
	/** This browser's own API calls: reads as a server-rendered page makes them, and changes. */
	const api = {
		/** @param {string} path */
		get: (path) => createConsoleApi({ handle: portal.handle, baseUrl: PORTAL_URL, cookie: cookie() || null }).get(path),
		/** @param {string} path @param {unknown} [body] */
		post: (path, body) => write('POST', path, body),
		request: write,
	};
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
	return {
		jar,
		calls,
		password,
		fetch: fetchImpl,
		api,
		waitCall,
		use: () => vi.stubGlobal('fetch', fetchImpl),
		world: /** @type {any} */ (null),
		totpSecret: /** @type {string | null} */ (null),
	};
};

/** The Portal modules with outbound calls allowed to loopback hosts (fake products run on 127.0.0.1). */
const testModules = (/** @type {{ mailer: any }} */ { mailer }) => [
	systemModule,
	createCatalogModule({ allowHosts: ['127.0.0.1'] }),
	createIdentityModule({ mailer }),
	commerceModule,
	websiteModule,
];

/**
 * A product manifest for a fake product (the shared test manifest under another id and name).
 * @param {{ id?: string, name?: string, widgets?: boolean, requires?: string[], links?: Record<string, unknown>,
 *   needs?: Record<string, unknown> }} [options] `widgets: false` drops the widget script; `requires` is the manifest's
 *   `websiteSettings.requires`; `links` and `needs` its links to other products and what it needs of the connections
 */
export const productManifest = ({ id = 'notes', name = 'Notes', widgets = true, requires, links, needs } = {}) => {
	const base = /** @type {Record<string, any>} */ (manifest());
	const { widgetScriptUrl, widgets: list, ...rest } = base;
	return {
		...rest,
		id,
		name,
		widgetScriptUrl: widgets ? widgetScriptUrl : null,
		widgets: widgets ? list : [],
		...(requires ? { websiteSettings: { requires } } : {}),
		...(links ? { links } : {}),
		...(needs ? { needs } : {}),
	};
};

/**
 * A Portal with a recording mailer, its first admin (an Owner, the `ownerBrowser` browser) and helpers that seed merchants,
 * websites, connected products (fake products on local HTTP servers), products on websites and credits.
 * @param {{ db: import('mongodb').Db }} options
 */
export const createWorld = async ({ db }) => {
	/** @type {Array<{ to: string, template: string, data: Record<string, any> }>} */
	const mail = [];
	const mailer = { available: true, send: async (/** @type {any} */ m) => void mail.push(m) };
	// work right after responses runs at once (emails and notices follow the request that caused them)
	const portal = createPortal({
		config: await testConfig(),
		db,
		modules: testModules({ mailer }),
		system: createSystemStore(db, { encryptionKey: ENCRYPTION_KEY }),
		logger: createTestLogger().logger,
		background: { mode: 'on', fallback: (task) => void task() },
	});
	await portal.ensureIndexes();
	/** @param {string} to @param {string} template */
	const tokenOf = (to, template) => {
		const message = [...mail].reverse().find((m) => m.to === to && m.template === template);
		return decodeURIComponent(String(message?.data.link).split('#token=')[1] ?? '');
	};
	/** @type {Array<Awaited<ReturnType<typeof startFakeProduct>>>} */
	const products = [];
	/** @type {any} */
	const world = {};

	// the first admin (an Owner, created from the sign-in page) seeds the world
	const ownerBrowser = browserOf(portal, 'owner password 123!');
	const first = await ownerBrowser.api.post('/v1/auth/first-admin', {
		name: 'Olivia Owner',
		email: 'olivia@ss.test',
		password: 'owner password 123!',
	});
	if (!first.ok) throw new Error(`first admin: ${JSON.stringify(first.problem)}`);
	const owner = /** @type {any} */ (await ownerBrowser.api.get('/v1/me')).data.admin;

	/**
	 * A merchant created by the Owner whose login set its password from the setup link (a signed-in browser).
	 * @param {string} email @param {string} merchantName
	 */
	const signup = async (email, merchantName, password = 'correct horse battery') => {
		const created = await ownerBrowser.api.post('/v1/admin/merchants', { name: merchantName, ownerName: 'Sam Seller', email });
		if (!created.ok) throw new Error(`merchant: ${JSON.stringify(created.problem)}`);
		const b = browserOf(portal, password);
		b.world = world;
		const set = await b.api.post('/v1/auth/set-password', { token: tokenOf(email, 'merchant_setup'), password });
		if (!set.ok) throw new Error(`setup: ${JSON.stringify(set.problem)}`);
		const me = await b.api.get('/v1/me');
		if (!me.ok) throw new Error('signup');
		return { b, me: me.data, merchantId: /** @type {string} */ (me.data.merchant.merchantId) };
	};

	let invited = 0;
	/**
	 * An admin of a role, invited by the Owner, who accepted the invite (a signed-in browser).
	 * @param {'owner' | 'support' | 'finance'} role
	 */
	const adminOf = async (role) => {
		invited += 1;
		const email = `${role}-${invited}@ss.test`;
		const r = await ownerBrowser.api.post('/v1/admin/admins', { email, role, password: 'owner password 123!' });
		if (!r.ok) throw new Error(`invite: ${JSON.stringify(r.problem)}`);
		const b = browserOf(portal, 'admin password 123!');
		b.world = world;
		const set = await b.api.post('/v1/auth/set-password', {
			token: tokenOf(email, 'admin_invite'),
			password: 'admin password 123!',
			name: `${role} admin`,
		});
		if (!set.ok) throw new Error(`accept: ${JSON.stringify(set.problem)}`);
		return { b, admin: /** @type {any} */ (await b.api.get('/v1/me')).data.admin };
	};

	/**
	 * Add a website to a merchant (Owner and Support only).
	 * @param {string} merchantId @param {string} domain
	 */
	const addWebsite = async (merchantId, domain) => {
		const r = await ownerBrowser.api.post(`/v1/merchants/${merchantId}/websites`, { domain });
		if (!r.ok) throw new Error(`website: ${JSON.stringify(r.problem)}`);
		return /** @type {any} */ (r.data.website);
	};

	/**
	 * Start a fake product and connect it as the Owner (Add product); active unless told otherwise.
	 * @param {Parameters<typeof productManifest>[0]} [options]
	 * @param {{ active?: boolean }} [state]
	 */
	const connect = async (options = {}, { active = true } = {}) => {
		const product = await startFakeProduct({ manifest: productManifest(options), portalUrl: PORTAL_URL });
		products.push(product);
		const r = await ownerBrowser.api.post('/v1/admin/products', { url: product.url, secret: product.secret });
		if (!r.ok) throw new Error(`connect: ${JSON.stringify(r.problem)}`);
		if (active) await ownerBrowser.api.post(`/v1/admin/products/${product.productId}/status`, { status: 'active' });
		return product;
	};

	/**
	 * Add a product to a website (Owner and Support only).
	 * @param {string} merchantId @param {string} websiteId @param {string} productId
	 */
	const addProduct = async (merchantId, websiteId, productId) => {
		const r = await ownerBrowser.api.post(`/v1/merchants/${merchantId}/websites/${websiteId}/products`, { productId });
		if (!r.ok) throw new Error(`add product: ${JSON.stringify(r.problem)}`);
		return /** @type {any} */ (r.data.product);
	};

	let reports = 0;
	/**
	 * The product reports the features switched on for a website (by the Owner, inside its dashboard).
	 * @param {Awaited<ReturnType<typeof startFakeProduct>>} product @param {string} websiteId @param {string[]} on
	 */
	const switchFeatures = async (product, websiteId, on) => {
		reports += 1;
		const response = await portal.handle(
			new Request(`${PORTAL_URL}/v1/product/websites/${websiteId}/features`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${await product.assertion()}` },
				body: JSON.stringify({ version: reports, on, adminId: owner.adminId, adminName: owner.name }),
			}),
		);
		if (!response.ok) throw new Error(`features: ${response.status} ${await response.text()}`);
	};

	/** @param {string} merchantId @param {number} millicredits @param {string} reference */
	const credit = async (merchantId, millicredits, reference) => {
		const r = await ownerBrowser.api.post(`/v1/admin/merchants/${merchantId}/receipts`, {
			credits: Math.round(millicredits / 1000),
			amountPaid: 'USD 10',
			method: 'Bank transfer',
			reference,
		});
		if (!r.ok) throw new Error(`credit: ${JSON.stringify(r.problem)}`);
	};

	/** @param {any} b */
	const enable2fa = async (b) => {
		const started = await b.api.post('/v1/me/two-step/start', {});
		if (!started.ok) throw new Error(`start 2fa: ${JSON.stringify(started.problem)}`);
		const secret = started.data.secret;
		const code = totpCode(secret, Date.now());
		const confirmed = await b.api.post('/v1/me/two-step/confirm', { code });
		if (!confirmed.ok) throw new Error(`confirm 2fa: ${JSON.stringify(confirmed.problem)}`);
		b.totpSecret = secret;
		return secret;
	};

	Object.assign(world, {
		portal,
		mail,
		tokenOf,
		lastOtp: (/** @type {string} */ [to]) => {
			const m = [...mail].reverse().find((item) => (!to || item.to === to) && item.template === 'step_up_otp');
			return m ? String(m.data?.otp ?? '') : null;
		},
		ownerBrowser,
		owner,
		signup,
		adminOf,
		enable2fa,
		addWebsite,
		connect,
		addProduct,
		switchFeatures,
		credit,
		close: async () => {
			for (const product of products.splice(0)) await product.close();
		},
	});
	ownerBrowser.world = world;
	return world;
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
