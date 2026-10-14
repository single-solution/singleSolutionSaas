// @vitest-environment jsdom
/* global document, window */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import strings from '../strings/en.json' with { type: 'json' };
import {
	DEVICE_STORAGE_KEY,
	REFRESH_STORAGE_KEY,
	SIGNED_IN_EVENT,
	SIGNED_OUT_EVENT,
	SIGN_IN_HEADER,
	WIDGET_ATTRIBUTE,
	WIDGET_GLOBAL,
} from '../core/widgets.js';
import { ADDRESS_LIMITS } from '../core/widgets.js';
import { ROLE_METHODS } from '../core/roles.js';
import {
	FIELD_TEXT,
	OWN_TEXT,
	PASSWORD_RULES,
	datesOf,
	errorText,
	moneyText,
	problemCode,
	textsOf,
	webAddress,
} from '../ui/common.js';
import { PRIVATE_OUTCOME, REQUEST_OUTCOMES } from '../ui/role-request.js';
import { RENEW_BEFORE_MS, RETRY_MS, createSession } from '../ui/session.js';
import { ADMIN_CONFIG_PATH, CONFIG_PATH, startWidget } from '../ui/widget.js';

const BASE = 'https://accounts.example.dev';
const START = Date.parse('2026-10-01T10:00:00Z');
const PAGE = '/shop/page?x=1';
/** @type {Record<string, string>} */
const TEXTS = strings;

/** @param {number} ms after START */
const at = (ms) => new Date(START + ms).toISOString();

/**
 * @typedef {object} Settings
 * @property {{ mode: 'open' | 'invite' | 'approval', requiredFields: Array<'name' | 'email' | 'phone'> }} [signUp]
 * @property {any[]} [customFields]
 * @property {number} [passwordMinLength]
 * @property {{ version: string, url: string } | null} [terms]
 * @property {any} [phonePassword]
 * @property {string} [remember]
 * @property {boolean} [signInPaused]
 * @property {any} [profile]
 * @property {any} [roleRequests]
 */

/** The Format and time zone of the widget config before anyone changes them (PLAN 0.8.10 K7, K8). */
const PLAIN_LOOKS = Object.freeze({
	format: Object.freeze({
		locale: '',
		currencyDisplay: /** @type {const} */ ('code'),
		currencySymbol: '',
		wholeUnits: false,
		times: /** @type {const} */ ('viewer'),
	}),
	timeZone: 'UTC',
});
/** The widget config's Format and time zone in the next widgets a test starts. */
let looks = /** @type {{ format: Record<string, unknown>, timeZone: string }} */ (PLAIN_LOOKS);
/** Dates as the widgets show them with the default Format (this browser's language and time zone). */
const when = datesOf(PLAIN_LOOKS, window);

/** @param {string[]} features @param {Settings} [settings] */
const configOf = (features, settings = {}) => ({
	texts: { ...strings },
	theme: { mode: /** @type {const} */ ('light') },
	customCss: '',
	...looks,
	features,
	settings: {
		signUp: { mode: 'open', requiredFields: [] },
		customFields: [],
		passwordMinLength: 8,
		terms: null,
		...settings,
	},
});

const USER = Object.freeze({
	id: 'usr_1',
	email: 'ana@example.com',
	emailVerified: true,
	phone: null,
	phoneVerified: false,
	name: 'Ana',
	addresses: [],
	custom: {},
	role: 'customer',
	providers: [],
	hasPassword: true,
	twoStep: false,
	terms: null,
	deletion: null,
	createdAt: at(0),
});

/** @param {Record<string, unknown>} [overrides] */
const signedIn = (overrides = {}) => ({
	status: 'signed_in',
	signIn: 'sig-1',
	expiresAt: at(15 * 60_000),
	refreshToken: 'ref-1',
	sessionExpiresAt: at(24 * 3_600_000),
	remember: false,
	user: USER,
	...overrides,
});

/** @param {string} key */
const place = (key) => {
	const host = document.createElement('div');
	host.setAttribute(WIDGET_ATTRIBUTE, key);
	document.body.append(host);
	return host;
};

/** @param {string | null} token */
const script = (token) => {
	const node = document.createElement('script');
	node.src = `${BASE}/widget.js`;
	if (token) node.dataset.token = token;
	return node;
};

/** Let pending promises settle. */
const flush = async () => {
	for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** @param {number} status @param {unknown} [body] */
const answer = (status, body = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status });
/** @param {number} status @param {string} code @param {Record<string, unknown>} [extra] */
const problem = (status, code, extra = {}) =>
	answer(status, { type: `${BASE}/problems/${code}`, title: code, status, detail: `Detail of ${code}.`, ...extra });

/** @typedef {{ method: string, path: string, url: URL, body: any, headers: Record<string, string> }} Call */
/** @typedef {(call: Call) => Response | Promise<Response>} Route */

/**
 * `window.fetch` answering by method and path; every call is recorded.
 * @param {Record<string, Route>} routes keys `METHOD /path`
 */
const serve = (routes) => {
	/** @type {Call[]} */
	const calls = [];
	const spy = vi.spyOn(window, 'fetch').mockImplementation(async (input, init) => {
		const url = new URL(String(input));
		const call = {
			method: init?.method ?? 'GET',
			path: url.pathname,
			url,
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
			headers: /** @type {Record<string, string>} */ (init?.headers ?? {}),
		};
		calls.push(call);
		const route = routes[`${call.method} ${call.path}`];
		return route ? route(call) : answer(404);
	});
	/** The last call of a route. @param {string} key `METHOD /path` */
	const last = (key) => calls.filter((c) => `${c.method} ${c.path}` === key).at(-1);
	return { calls, spy, last };
};

/** Timers the tests fire by hand. */
const clock = () => {
	let id = 0;
	/** @type {Map<number, { task: () => void, ms: number }>} */
	const timers = new Map();
	const self = {
		now: START,
		timers,
		/** @param {() => void} task @param {number} ms */
		schedule: (task, ms) => {
			id += 1;
			timers.set(id, { task, ms });
			return id;
		},
		/** @param {number} timer */
		cancel: (timer) => {
			timers.delete(timer);
		},
		last: () => [...timers.values()].at(-1),
		/** Fire the newest timer. */
		fire: async () => {
			const entry = [...timers].at(-1);
			if (!entry) throw new Error('no timer');
			timers.delete(entry[0]);
			entry[1].task();
			await flush();
		},
	};
	return self;
};

/** @param {HTMLElement} host */
const shadow = (host) => /** @type {ShadowRoot} */ (host.shadowRoot);
/** @param {ParentNode} scope @param {string} text */
const buttonIn = (scope, text) => {
	const found = [...scope.querySelectorAll('button')].find((b) => b.textContent === text);
	if (!found) throw new Error(`no button ${text}`);
	return /** @type {HTMLButtonElement} */ (found);
};
/** @param {ParentNode} scope @param {string} text */
const hasButton = (scope, text) => [...scope.querySelectorAll('button')].some((b) => b.textContent === text);
/** @param {ParentNode} scope @param {string} label @returns {any} */
const fieldIn = (scope, label) => {
	const found = /** @type {HTMLLabelElement | undefined} */ (
		[...scope.querySelectorAll('label')].find((l) => l.textContent === label && !l.classList.contains('check'))
	);
	if (!found) throw new Error(`no field ${label}`);
	return /** @type {ShadowRoot} */ (found.getRootNode()).getElementById(found.htmlFor);
};
/** @param {ParentNode} scope @param {string} text @returns {HTMLInputElement} */
const checkIn = (scope, text) => {
	const found = [...scope.querySelectorAll('label.check')].find((l) => (l.textContent ?? '').startsWith(text));
	if (!found) throw new Error(`no check ${text}`);
	return /** @type {HTMLInputElement} */ (found.querySelector('input'));
};
/** @param {ParentNode} scope */
const statusIn = (scope) => /** @type {HTMLElement} */ (scope.querySelector('[role="status"]')).textContent;
/** @param {Element} node */
const submit = async (node) => {
	/** @type {HTMLFormElement} */ (node.closest('form')).dispatchEvent(new window.Event('submit', { cancelable: true }));
	await flush();
};
/** @param {HTMLButtonElement} node */
const click = async (node) => {
	node.click();
	await flush();
};
/** @param {HTMLElement} host @param {string} title */
const part = (host, title) => {
	const found = [...shadow(host).querySelectorAll('section.part')].find((s) => s.querySelector('h3')?.textContent === title);
	if (!found) throw new Error(`no part ${title}`);
	return /** @type {HTMLElement} */ (found);
};
/** @param {HTMLElement} host */
const heading = (host) => shadow(host).querySelector('h2')?.textContent;

/**
 * Start the widget on a page with the browser token.
 * @param {Record<string, Route>} routes
 * @param {{ features?: string[], settings?: Settings, hash?: string, page?: string }} [options]
 */
const start = async (routes, { features = ['email_password'], settings = {}, hash = '', page = PAGE } = {}) => {
	window.history.replaceState(null, '', `${page}${hash ? `#${hash}` : ''}`);
	const server = serve({ [`GET ${CONFIG_PATH}`]: () => answer(200, configOf(features, settings)), ...routes });
	const time = clock();
	const widget = startWidget({
		window,
		script: script('browser-token'),
		schedule: time.schedule,
		cancel: time.cancel,
		now: () => time.now,
	});
	await widget.ready;
	await flush();
	return { widget, server, time };
};

/** @type {{ in: any[], out: number }} */
let events = { in: [], out: 0 };
/** @param {Event} event */
const onIn = (event) => events.in.push(/** @type {CustomEvent} */ (event).detail);
const onOut = () => {
	events.out += 1;
};

beforeEach(() => {
	events = { in: [], out: 0 };
	window.addEventListener(SIGNED_IN_EVENT, onIn);
	window.addEventListener(SIGNED_OUT_EVENT, onOut);
});

afterEach(() => {
	window.removeEventListener(SIGNED_IN_EVENT, onIn);
	window.removeEventListener(SIGNED_OUT_EVENT, onOut);
	document.body.replaceChildren();
	vi.restoreAllMocks();
	window.localStorage.clear();
	window.sessionStorage.clear();
	window.history.replaceState(null, '', '/');
	looks = PLAIN_LOOKS;
});

describe('starting the widget', () => {
	it('without data-token only admin works', async () => {
		const host = place('sign_in');
		const { spy } = serve({});
		const widget = startWidget({ window, script: script(null) });
		await widget.ready;
		const global = /** @type {any} */ (window)[WIDGET_GLOBAL];
		expect(Object.isFrozen(global)).toBe(true);
		expect(global.admin).toBe(widget.admin);
		expect(await global.getSignIn()).toBeNull();
		expect(global.user()).toBeNull();
		await global.signOut();
		expect(spy).not.toHaveBeenCalled();
		expect(host.shadowRoot).toBeNull();
	});

	it('renders nothing while the sign-in methods are off or the config cannot be loaded', async () => {
		const signIn = place('sign_in');
		const account = place('my_account');
		await start({}, { features: ['roles', 'terms'] });
		expect(signIn.shadowRoot).toBeNull();
		expect(account.shadowRoot).toBeNull();
		vi.restoreAllMocks();
		serve({ [`GET ${CONFIG_PATH}`]: () => answer(503) });
		await startWidget({ window, script: script('browser-token') }).ready;
		expect(signIn.shadowRoot).toBeNull();
		vi.restoreAllMocks();
		vi.spyOn(window, 'fetch').mockRejectedValue(new Error('offline'));
		const widget = startWidget({ window, script: script('browser-token') });
		await widget.ready;
		expect(signIn.shadowRoot).toBeNull();
		expect(await widget.getSignIn()).toBeNull();
	});

	it('loads the config with the browser token and mounts the visitor widgets', async () => {
		const signIn = place('sign_in');
		const account = place('my_account');
		const { server } = await start({});
		expect(server.calls[0]?.headers.authorization).toBe('Bearer browser-token');
		expect(heading(signIn)).toBe(strings['signIn.title']);
		expect(statusIn(shadow(account))).toBe(strings['account.signedOut']);
		expect(shadow(signIn).querySelector('.tabs')).toBeNull();
	});
});

describe('email and password', () => {
	it('signs in, keeps the refresh token where Remember me says, renews and signs out', async () => {
		const host = place('sign_in');
		const { server, time, widget } = await start({
			'POST /v1/sign-in/password': () => answer(200, signedIn({ remember: true })),
			'POST /v1/session/refresh': ({ body }) =>
				answer(
					200,
					body.refreshToken === 'ref-1'
						? signedIn({
								signIn: 'sig-2',
								refreshToken: 'ref-2',
								expiresAt: at(30 * 60_000),
								user: { ...USER, name: 'Ana B' },
							})
						: signedIn({ signIn: 'sig-3', refreshToken: 'ref-3', expiresAt: at(45 * 60_000) }),
				),
			'POST /v1/session/sign-out': () => answer(204),
		});
		const root = shadow(host);
		fieldIn(root, strings['fields.email']).value = ' ana@example.com ';
		fieldIn(root, strings['fields.password']).value = 'secret-pass';
		checkIn(root, strings['signIn.remember']).checked = true;
		await submit(buttonIn(root, strings['signIn.submit']));
		const body = server.last('POST /v1/sign-in/password')?.body;
		expect(body).toMatchObject({ email: 'ana@example.com', password: 'secret-pass', remember: true, acceptTerms: false });
		expect(body.deviceId).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
		expect(window.localStorage.getItem(DEVICE_STORAGE_KEY)).toBe(body.deviceId);
		expect(events.in).toEqual([{ user: USER }]);
		expect(window.localStorage.getItem(REFRESH_STORAGE_KEY)).toBe('ref-1');
		expect(window.sessionStorage.getItem(REFRESH_STORAGE_KEY)).toBeNull();
		expect(root.querySelector('p')?.textContent).toBe('Signed in as Ana');
		expect(await widget.getSignIn()).toBe('sig-1');
		expect(widget.user()).toEqual(USER);

		// renewed a minute before it expires; without Remember me the refresh token moves to sessionStorage
		expect(time.last()?.ms).toBe(15 * 60_000 - RENEW_BEFORE_MS);
		await time.fire();
		expect(server.last('POST /v1/session/refresh')?.body).toEqual({ refreshToken: 'ref-1' });
		expect(await widget.getSignIn()).toBe('sig-2');
		expect(window.sessionStorage.getItem(REFRESH_STORAGE_KEY)).toBe('ref-2');
		expect(window.localStorage.getItem(REFRESH_STORAGE_KEY)).toBeNull();
		expect(root.querySelector('p')?.textContent).toBe('Signed in as Ana B');
		expect(events.in).toHaveLength(1);

		// within a minute of expiry getSignIn() renews first
		time.now = START + 30 * 60_000 - 30_000;
		expect(await widget.getSignIn()).toBe('sig-3');

		await click(buttonIn(root, strings['signIn.signOut']));
		expect(server.last('POST /v1/session/sign-out')?.body).toEqual({ refreshToken: 'ref-3' });
		expect(events.out).toBe(1);
		expect(window.sessionStorage.getItem(REFRESH_STORAGE_KEY)).toBeNull();
		expect(widget.user()).toBeNull();
		expect(await widget.getSignIn()).toBeNull();
		expect(heading(host)).toBe(strings['signIn.title']);
	});

	it('shows why a sign-in failed and asks for the terms when needed', async () => {
		const host = place('sign_in');
		const outcomes = [
			problem(401, 'sign_in_failed'),
			problem(423, 'locked', { lockedUntil: at(10 * 60_000) }),
			problem(423, 'locked'),
			problem(403, 'terms_required', { version: 'v3', url: 'https://example.com/terms-v3' }),
			answer(200, signedIn()),
		];
		const { server } = await start(
			{ 'POST /v1/sign-in/password': () => /** @type {Response} */ (outcomes.shift()) },
			{ settings: { terms: { version: 'v3', url: 'https://example.com/terms' } } },
		);
		const root = shadow(host);
		const terms = /** @type {HTMLElement} */ (root.querySelector('label.check:has(a)'));
		expect(terms.hidden).toBe(true);
		const send = buttonIn(root, strings['signIn.submit']);
		await submit(send);
		expect(statusIn(root)).toBe(strings['error.sign_in_failed']);
		await submit(send);
		expect(statusIn(root)).toBe(`Too many tries. Try again after ${when(at(10 * 60_000))}.`);
		await submit(send);
		expect(statusIn(root)).toBe(strings['error.rate_limited']);
		await submit(send);
		expect(statusIn(root)).toBe(strings['error.terms_required']);
		expect(terms.hidden).toBe(false);
		expect(terms.querySelector('a')?.getAttribute('href')).toBe('https://example.com/terms-v3');
		checkIn(root, strings['terms.accept']).checked = true;
		await submit(send);
		expect(server.last('POST /v1/sign-in/password')?.body.acceptTerms).toBe(true);
		expect(events.in).toHaveLength(1);
	});

	it('signs up with the required fields, custom fields and the terms; an approval sign-up waits', async () => {
		const host = place('sign_in');
		const outcomes = [
			problem(422, 'weak_password', { rule: 'too_short', minLength: 10 }),
			problem(422, 'validation_failed', { errors: [{ path: '/custom/size', message: 'Size is required.' }] }),
			problem(422, 'validation_failed', { detail: '' }),
			problem(409, 'something_new'),
			answer(201, { status: 'pending' }),
			answer(201, { status: 'mystery' }),
		];
		const { server } = await start(
			{ 'POST /v1/sign-up/password': () => /** @type {Response} */ (outcomes.shift()) },
			{
				settings: {
					signUp: { mode: 'approval', requiredFields: ['name', 'phone'] },
					passwordMinLength: 10,
					terms: { version: 'v1', url: 'javascript:alert(1)' },
					customFields: [
						{ key: 'size', label: 'Size', type: 'choice', options: ['S', 'M'], required: true },
						{ key: 'age', label: 'Age', type: 'number', options: [], required: false },
						{ key: 'birthday', label: 'Birthday', type: 'date', options: [], required: false },
						{ key: 'nickname', label: 'Nickname', type: 'text', options: [], required: false },
					],
				},
			},
		);
		const root = shadow(host);
		await click(buttonIn(root, strings['signIn.toSignUp']));
		expect(heading(host)).toBe(strings['signUp.title']);
		const terms = /** @type {HTMLElement} */ (root.querySelector('label.check:has(a)'));
		expect(terms.hidden).toBe(false);
		expect(terms.querySelector('a')?.hidden).toBe(true);
		expect(fieldIn(root, strings['fields.name']).required).toBe(true);
		expect(fieldIn(root, strings['fields.password']).getAttribute('minlength')).toBe('10');
		const size = fieldIn(root, 'Size');
		expect([...size.options].map((o) => o.textContent)).toEqual([strings['fields.choose'], 'S', 'M']);
		expect(size.required).toBe(true);
		expect(fieldIn(root, 'Birthday').type).toBe('date');
		fieldIn(root, strings['fields.name']).value = 'Ana';
		fieldIn(root, strings['fields.email']).value = 'ana@example.com';
		fieldIn(root, strings['fields.phone']).value = '+15550001111';
		fieldIn(root, strings['fields.password']).value = 'long-enough-1';
		size.value = 'M';
		fieldIn(root, 'Age').value = '30';
		fieldIn(root, 'Birthday').value = '1990-05-01';
		checkIn(root, strings['terms.accept']).checked = true;
		const send = buttonIn(root, strings['signUp.submit']);
		await submit(send);
		expect(server.last('POST /v1/sign-up/password')?.body).toMatchObject({
			email: 'ana@example.com',
			password: 'long-enough-1',
			name: 'Ana',
			phone: '+15550001111',
			custom: { size: 'M', age: 30, birthday: '1990-05-01' },
			acceptTerms: true,
			remember: false,
		});
		// the website's words, never the server's English detail
		expect(statusIn(root)).toBe('Use at least 10 characters.');
		await submit(send);
		expect(statusIn(root)).toBe(strings['error.field.custom']);
		await submit(send);
		expect(statusIn(root)).toBe(strings['error.validation_failed']);
		await submit(send);
		expect(statusIn(root)).toBe(strings['error.generic']);
		await submit(send);
		expect(heading(host)).toBe(strings['pending.title']);
		expect(root.querySelector('p')?.textContent).toBe(strings['pending.text']);
		await click(buttonIn(root, strings['signIn.back']));
		expect(heading(host)).toBe(strings['signUp.title']);
		await submit(buttonIn(root, strings['signUp.submit']));
		expect(statusIn(root)).toBe(strings['error.generic']);
		await click(buttonIn(root, strings['signUp.toSignIn']));
		expect(heading(host)).toBe(strings['signIn.title']);
	});

	it('offers no sign-up when sign-up is by invitation only', async () => {
		const host = place('sign_in');
		await start({}, { settings: { signUp: { mode: 'invite', requiredFields: [] } } });
		expect(hasButton(shadow(host), strings['signIn.toSignUp'])).toBe(false);
	});

	it('Forgot password sends a reset link', async () => {
		const host = place('sign_in');
		const outcomes = [answer(202, {}), problem(429, 'rate_limited')];
		const { server } = await start({ 'POST /v1/password/forgot': () => /** @type {Response} */ (outcomes.shift()) });
		const root = shadow(host);
		fieldIn(root, strings['fields.email']).value = 'ana@example.com';
		await click(buttonIn(root, strings['signIn.forgot']));
		expect(heading(host)).toBe(strings['forgot.title']);
		expect(fieldIn(root, strings['fields.email']).value).toBe('ana@example.com');
		await submit(buttonIn(root, strings['forgot.submit']));
		expect(server.last('POST /v1/password/forgot')?.body).toEqual({
			email: 'ana@example.com',
			returnTo: `${window.location.origin}${PAGE}`,
		});
		expect(statusIn(root)).toBe(strings['forgot.sent']);
		await submit(buttonIn(root, strings['forgot.submit']));
		expect(statusIn(root)).toBe(strings['error.rate_limited']);
		await click(buttonIn(root, strings['signIn.back']));
		expect(heading(host)).toBe(strings['signIn.title']);
	});
});

describe('codes', () => {
	it('phone code: asks for a code, then signs in (a new user gives their details at once)', async () => {
		const host = place('sign_in');
		const codes = [answer(202, { expiresAt: at(300_000) }), problem(429, 'too_soon'), answer(202, {})];
		const { server } = await start(
			{
				'POST /v1/sign-in/phone/code': () => /** @type {Response} */ (codes.shift()),
				'POST /v1/sign-in/phone': () => answer(201, signedIn()),
			},
			{
				features: ['phone_code', 'email_code'],
				settings: {
					signUp: { mode: 'open', requiredFields: ['email'] },
					customFields: [{ key: 'size', label: 'Size', type: 'choice', options: ['S'], required: true }],
				},
			},
		);
		const root = shadow(host);
		const tabs = [...root.querySelectorAll('.tabs button')];
		expect(tabs.map((tab) => [tab.textContent, tab.getAttribute('aria-pressed')])).toEqual([
			[strings['method.phone_code'], 'true'],
			[strings['method.email_code'], 'false'],
		]);
		fieldIn(root, strings['fields.phone']).value = ' +15550001111 ';
		await submit(buttonIn(root, strings['code.send']));
		expect(server.last('POST /v1/sign-in/phone/code')?.body).toEqual({ phone: '+15550001111' });
		expect(statusIn(root)).toBe('We sent a code to +15550001111.');
		await click(buttonIn(root, strings['code.again']));
		expect(statusIn(root)).toBe(strings['error.too_soon']);
		await click(buttonIn(root, strings['code.again']));
		expect(statusIn(root)).toBe('We sent a code to +15550001111.');
		fieldIn(root, strings['code.code']).value = '123456';
		fieldIn(root, strings['fields.name']).value = 'Ana';
		fieldIn(root, strings['fields.email']).value = 'ana@example.com';
		fieldIn(root, 'Size').value = 'S';
		await submit(buttonIn(root, strings['code.submit']));
		const body = server.last('POST /v1/sign-in/phone')?.body;
		expect(body).toMatchObject({
			phone: '+15550001111',
			code: '123456',
			name: 'Ana',
			email: 'ana@example.com',
			custom: { size: 'S' },
			acceptTerms: false,
			remember: false,
		});
		expect(events.in).toHaveLength(1);
	});

	it('email code: sends the code with the page to return to; Back and the tabs switch the form', async () => {
		const host = place('sign_in');
		const { server } = await start(
			{
				'POST /v1/sign-in/email/code': ({ body }) =>
					body.email === 'bad'
						? problem(422, 'validation_failed', { errors: [{ path: '/email', message: 'Enter a valid email address.' }] })
						: answer(202, {}),
				'POST /v1/sign-in/email': () => problem(400, 'code_invalid'),
			},
			{
				features: ['phone_code', 'email_code', 'email_password'],
				settings: { signUp: { mode: 'invite', requiredFields: [] } },
			},
		);
		const root = shadow(host);
		await click(buttonIn(root, strings['method.email_code']));
		fieldIn(root, strings['fields.email']).value = 'bad';
		await submit(buttonIn(root, strings['code.send']));
		expect(statusIn(root)).toBe('Enter a valid email address.');
		fieldIn(root, strings['fields.email']).value = 'ana@example.com';
		await submit(buttonIn(root, strings['code.send']));
		expect(server.last('POST /v1/sign-in/email/code')?.body).toEqual({
			email: 'ana@example.com',
			returnTo: `${window.location.origin}${PAGE}`,
		});
		expect(root.querySelector('.details')).toBeNull();
		fieldIn(root, strings['code.code']).value = '000000';
		await submit(buttonIn(root, strings['code.submit']));
		expect(server.last('POST /v1/sign-in/email')?.body).toMatchObject({ email: 'ana@example.com', code: '000000' });
		expect(statusIn(root)).toBe(strings['error.code_invalid']);
		await click(buttonIn(root, strings['code.back']));
		expect(fieldIn(root, strings['fields.email']).value).toBe('');
		await click(buttonIn(root, strings['method.email_password']));
		expect(hasButton(root, strings['signIn.forgot'])).toBe(true);
	});
});

describe('two-step sign-in', () => {
	it('asks the code after the first step, or a recovery code', async () => {
		const host = place('sign_in');
		const steps = [problem(400, 'code_invalid'), answer(200, signedIn())];
		const { server } = await start({
			'POST /v1/sign-in/password': () => answer(200, { status: 'two_step', challenge: 'ch1', expiresAt: at(300_000) }),
			'POST /v1/sign-in/two-step': () => /** @type {Response} */ (steps.shift()),
		});
		const root = shadow(host);
		await submit(buttonIn(root, strings['signIn.submit']));
		expect(heading(host)).toBe(strings['twoStep.title']);
		fieldIn(root, strings['twoStep.code']).value = '111111';
		await submit(buttonIn(root, strings['twoStep.submit']));
		expect(server.last('POST /v1/sign-in/two-step')?.body).toEqual({ challenge: 'ch1', code: '111111' });
		expect(statusIn(root)).toBe(strings['error.code_invalid']);
		await click(buttonIn(root, strings['twoStep.useRecovery']));
		fieldIn(root, strings['twoStep.recoveryCode']).value = 'abcd-efgh';
		await submit(buttonIn(root, strings['twoStep.submit']));
		expect(server.last('POST /v1/sign-in/two-step')?.body).toEqual({ challenge: 'ch1', recoveryCode: 'abcd-efgh' });
		expect(events.in).toHaveLength(1);
		expect(heading(host)).toBe(strings['signedIn.title']);
	});

	it('sets two-step up when the role requires it and shows the recovery codes once', async () => {
		const host = place('sign_in');
		await start({
			'POST /v1/sign-in/password': () =>
				answer(200, {
					status: 'two_step_setup',
					challenge: 'ch2',
					expiresAt: at(300_000),
					secret: 'JBSWY3DPEHPK3PXP',
					otpauthUrl: 'otpauth://totp/Shop:ana?secret=JBSWY3DPEHPK3PXP',
				}),
			'POST /v1/sign-in/two-step': () => answer(200, signedIn({ recoveryCodes: ['code-1', 'code-2'] })),
		});
		const root = shadow(host);
		await submit(buttonIn(root, strings['signIn.submit']));
		const texts = [...root.querySelectorAll('.code')].map((node) => node.textContent);
		expect(texts).toEqual(['Key: JBSWY3DPEHPK3PXP', 'otpauth://totp/Shop:ana?secret=JBSWY3DPEHPK3PXP']);
		expect(hasButton(root, strings['twoStep.useRecovery'])).toBe(false);
		fieldIn(root, strings['twoStep.code']).value = '222222';
		await submit(buttonIn(root, strings['twoStep.submit']));
		expect(heading(host)).toBe(strings['recovery.title']);
		expect([...root.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['code-1', 'code-2']);
		await click(buttonIn(root, strings['recovery.done']));
		expect(heading(host)).toBe(strings['signedIn.title']);
		await click(buttonIn(root, strings['signIn.signOut']));
		await submit(buttonIn(root, strings['signIn.submit']));
		expect(heading(host)).toBe(strings['twoStep.title']);
		await click(buttonIn(root, strings['signIn.back']));
		expect(heading(host)).toBe(strings['signIn.title']);
	});
});

describe('social sign-in and links', () => {
	it('a social button goes to the address Accounts gives', async () => {
		const host = place('sign_in');
		const outcomes = [
			problem(500, 'provider_failed'),
			answer(200, { url: `${window.location.origin}/shop/page?x=1#at-provider` }),
		];
		const { server } = await start(
			{ 'POST /v1/sign-in/google/start': () => /** @type {Response} */ (outcomes.shift()) },
			{ features: ['google', 'apple'] },
		);
		const root = shadow(host);
		expect(root.querySelector('.tabs')).toBeNull();
		expect([...root.querySelectorAll('button.social')].map((b) => b.textContent)).toEqual([
			strings['social.google'],
			strings['social.apple'],
		]);
		expect(root.querySelector('.socials .meta')).toBeNull();
		checkIn(root, strings['signIn.remember']).checked = true;
		await click(buttonIn(root, strings['social.google']));
		expect(statusIn(root)).toBe(strings['error.provider_failed']);
		await click(buttonIn(root, strings['social.google']));
		expect(server.last('POST /v1/sign-in/google/start')?.body).toMatchObject({
			returnTo: `${window.location.origin}${PAGE}`,
			remember: true,
		});
		expect(window.location.hash).toBe('#at-provider');
	});

	it('exchanges a hand-over code from the address, removes it, and asks for the terms first when needed', async () => {
		const host = place('sign_in');
		const outcomes = [
			problem(403, 'terms_required', { version: 'v1', url: 'https://example.com/terms' }),
			answer(200, signedIn()),
		];
		const { server } = await start(
			{ 'POST /v1/sign-in/exchange': () => /** @type {Response} */ (outcomes.shift()) },
			{ features: ['google'], hash: 'ss_accounts_code=hand.over' },
		);
		expect(window.location.hash).toBe('');
		expect(`${window.location.pathname}${window.location.search}`).toBe(PAGE);
		expect(server.last('POST /v1/sign-in/exchange')?.body).toEqual({ code: 'hand.over' });
		const root = shadow(host);
		expect(heading(host)).toBe(strings['terms.title']);
		expect(root.querySelector('a')?.getAttribute('href')).toBe('https://example.com/terms');
		await click(buttonIn(root, strings['terms.continue']));
		expect(statusIn(root)).toBe(strings['terms.tick']);
		checkIn(root, strings['terms.accept']).checked = true;
		await click(buttonIn(root, strings['terms.continue']));
		expect(server.last('POST /v1/sign-in/exchange')?.body).toEqual({ code: 'hand.over', acceptTerms: true });
		expect(events.in).toHaveLength(1);
		expect(heading(host)).toBe(strings['signedIn.title']);
	});

	it('shows why a social sign-in did not work, and a failed or pending link', async () => {
		const host = place('sign_in');
		await start({}, { features: ['google'], hash: 'ss_accounts_error=cancelled' });
		expect(statusIn(shadow(host))).toBe(strings['error.cancelled']);
		vi.restoreAllMocks();
		document.body.replaceChildren();
		const again = place('sign_in');
		await start(
			{ 'POST /v1/sign-in/email': () => problem(400, 'code_invalid') },
			{ features: ['email_code'], hash: 'ss_accounts_link=magic.link' },
		);
		expect(statusIn(shadow(again))).toBe(strings['error.code_invalid']);
		vi.restoreAllMocks();
		document.body.replaceChildren();
		const third = place('sign_in');
		await start(
			{ 'POST /v1/sign-in/exchange': () => answer(200, { status: 'pending' }) },
			{ features: ['google'], hash: 'ss_accounts_code=x' },
		);
		expect(heading(third)).toBe(strings['pending.title']);
	});

	it('a magic link signs in even without a sign-in widget on the page', async () => {
		const { server, widget } = await start(
			{ 'POST /v1/sign-in/email': () => answer(200, signedIn()) },
			{ features: ['email_code'], hash: 'ss_accounts_link=magic.link' },
		);
		expect(server.last('POST /v1/sign-in/email')?.body).toMatchObject({ link: 'magic.link' });
		expect(widget.user()).toEqual(USER);
		vi.restoreAllMocks();
		const next = await start(
			{ 'POST /v1/sign-in/exchange': () => answer(200, signedIn({ signIn: 'sig-x' })) },
			{ features: ['google'], hash: 'ss_accounts_code=c' },
		);
		expect(await next.widget.getSignIn()).toBe('sig-x');
	});

	it('a magic link through the widget signs in', async () => {
		const host = place('sign_in');
		const { server } = await start(
			{ 'POST /v1/sign-in/email': () => answer(200, signedIn()) },
			{ features: ['email_code'], hash: 'ss_accounts_link=magic.link' },
		);
		expect(server.last('POST /v1/sign-in/email')?.body).toMatchObject({ link: 'magic.link', remember: false });
		expect(heading(host)).toBe(strings['signedIn.title']);
	});

	it('a reset link asks for the new password', async () => {
		const host = place('sign_in');
		const outcomes = [problem(400, 'code_invalid'), answer(204)];
		const { server } = await start(
			{ 'POST /v1/password/reset': () => /** @type {Response} */ (outcomes.shift()) },
			{ features: ['phone_code', 'email_password'], hash: 'ss_accounts_reset=reset.token' },
		);
		const root = shadow(host);
		expect(heading(host)).toBe(strings['reset.title']);
		fieldIn(root, strings['reset.password']).value = 'new-password-1';
		await submit(buttonIn(root, strings['reset.submit']));
		expect(statusIn(root)).toBe(strings['error.code_invalid']);
		await submit(buttonIn(root, strings['reset.submit']));
		expect(server.last('POST /v1/password/reset')?.body).toEqual({ token: 'reset.token', password: 'new-password-1' });
		expect(statusIn(root)).toBe(strings['reset.done']);
		expect(hasButton(root, strings['signIn.forgot'])).toBe(true);
	});

	it('an invite link sets up the account', async () => {
		const host = place('sign_in');
		const { server } = await start(
			{ 'POST /v1/invites/accept': () => answer(200, signedIn({ remember: true })) },
			{
				features: ['email_password'],
				hash: 'ss_accounts_invite=invite.token',
				settings: { terms: { version: 'v1', url: 'https://example.com/terms' } },
			},
		);
		const root = shadow(host);
		expect(heading(host)).toBe(strings['invite.title']);
		fieldIn(root, strings['fields.name']).value = 'Bo';
		fieldIn(root, strings['invite.password']).value = 'pass-word-1';
		checkIn(root, strings['terms.accept']).checked = true;
		checkIn(root, strings['signIn.remember']).checked = true;
		await submit(buttonIn(root, strings['invite.submit']));
		expect(server.last('POST /v1/invites/accept')?.body).toMatchObject({
			token: 'invite.token',
			name: 'Bo',
			password: 'pass-word-1',
			acceptTerms: true,
			remember: true,
		});
		expect(window.localStorage.getItem(REFRESH_STORAGE_KEY)).toBe('ref-1');
	});
});

describe('the session kept in the browser', () => {
	it('is renewed on start', async () => {
		window.sessionStorage.setItem(REFRESH_STORAGE_KEY, 'ref-0');
		const host = place('sign_in');
		const { server, widget } = await start({ 'POST /v1/session/refresh': () => answer(200, signedIn()) });
		expect(server.last('POST /v1/session/refresh')?.body).toEqual({ refreshToken: 'ref-0' });
		expect(events.in).toEqual([{ user: USER }]);
		expect(heading(host)).toBe(strings['signedIn.title']);
		expect(await widget.getSignIn()).toBe('sig-1');
	});

	it('ends when Accounts says signed out; is kept while Accounts cannot be reached', async () => {
		window.localStorage.setItem(REFRESH_STORAGE_KEY, 'ref-0');
		await start({ 'POST /v1/session/refresh': () => problem(401, 'signed_out') });
		expect(window.localStorage.getItem(REFRESH_STORAGE_KEY)).toBeNull();
		expect(events.out).toBe(1);
		vi.restoreAllMocks();
		window.localStorage.setItem(REFRESH_STORAGE_KEY, 'ref-0');
		let reachable = false;
		const { time, widget } = await start({
			'POST /v1/session/refresh': () => {
				if (!reachable) throw new Error('offline');
				return answer(200, signedIn());
			},
		});
		expect(window.localStorage.getItem(REFRESH_STORAGE_KEY)).toBe('ref-0');
		expect(time.last()?.ms).toBe(RETRY_MS);
		expect(widget.user()).toBeNull();
		reachable = true;
		await time.fire();
		expect(widget.user()).toEqual(USER);
	});

	it('works when the browser refuses storage', async () => {
		vi.spyOn(window.Storage.prototype, 'setItem').mockImplementation(() => {
			throw new Error('quota');
		});
		vi.spyOn(window.Storage.prototype, 'getItem').mockImplementation(() => {
			throw new Error('denied');
		});
		const time = clock();
		const fetch = vi.spyOn(window, 'fetch').mockImplementation(async () => answer(200, signedIn()));
		const session = createSession({
			win: window,
			base: BASE,
			token: 'tok',
			schedule: time.schedule,
			cancel: time.cancel,
			now: () => time.now,
		});
		const id = session.deviceId();
		expect(id).toMatch(/^[A-Za-z0-9_-]{32}$/);
		expect(session.deviceId()).toBe(id);
		await session.restore();
		expect(fetch).not.toHaveBeenCalled();
		session.accept(signedIn());
		expect(await session.getSignIn()).toBe('sig-1');
		session.setUser({ ...USER, name: 'Changed' });
		expect(session.user()?.name).toBe('Changed');
		// an expired sign-in that cannot be renewed
		fetch.mockRejectedValue(new Error('offline'));
		time.now = START + 20 * 60_000;
		expect(await session.getSignIn()).toBeNull();
		expect((await session.me('GET', '/v1/me')).status).toBe(0);
		session.forget();
		session.setUser(USER);
		expect(session.user()).toBeNull();
	});

	it('reuses the stored device id and signs a 401 out', async () => {
		window.localStorage.setItem(DEVICE_STORAGE_KEY, 'stored-device-id-0001');
		const time = clock();
		vi.spyOn(window, 'fetch').mockImplementation(async () => problem(401, 'signed_out'));
		const session = createSession({
			win: window,
			base: BASE,
			token: 'tok',
			schedule: time.schedule,
			cancel: time.cancel,
			now: () => time.now,
		});
		expect(session.deviceId()).toBe('stored-device-id-0001');
		session.accept(signedIn());
		const answered = await session.me('GET', '/v1/me');
		expect(answered.status).toBe(401);
		expect(session.user()).toBeNull();
		expect(events.out).toBe(1);
	});
});

describe('My account', () => {
	const ACCOUNT_FEATURES = ['email_password', 'two_step', 'data_rights', 'orders_tab', 'terms', 'custom_fields'];
	const SETTINGS = {
		terms: { version: 'v2', url: 'https://example.com/terms' },
		customFields: [{ key: 'size', label: 'Size', type: 'choice', options: ['S', 'M'], required: false }],
	};
	const ME = {
		...USER,
		phone: '+15550001111',
		custom: { size: 'S' },
		addresses: [
			{
				id: 'adr_000001',
				label: 'Home',
				name: 'Ana',
				line1: '1 Main St',
				line2: '',
				city: 'Springfield',
				region: 'North',
				postalCode: '12345',
				country: 'US',
				phone: '',
			},
		],
	};

	/** @param {Record<string, Route>} routes @param {Record<string, unknown>} [me] @param {string[]} [features] */
	const open = async (routes, me = ME, features = ACCOUNT_FEATURES) => {
		window.sessionStorage.setItem(REFRESH_STORAGE_KEY, 'ref-0');
		const host = place('my_account');
		const started = await start(
			{
				'POST /v1/session/refresh': () => answer(200, signedIn({ user: me })),
				'GET /v1/me': () => answer(200, me),
				'GET /v1/me/sessions': () => answer(200, { items: [] }),
				'GET /v1/me/orders': () => answer(200, { items: [] }),
				...routes,
			},
			{ features, settings: SETTINGS },
		);
		return { host, ...started };
	};

	it('saves the profile and the addresses with the sign-in header', async () => {
		/** @type {any[]} */
		const patches = [];
		const { host, server, widget } = await open({
			'PATCH /v1/me': ({ body }) => {
				patches.push(body);
				if (body.name === 'x')
					return problem(422, 'validation_failed', { errors: [{ path: '/name', message: 'Too long.' }] });
				return answer(200, {
					...ME,
					...body,
					addresses: (body.addresses ?? ME.addresses).map((/** @type {any} */ a, /** @type {number} */ i) => ({
						id: a.id ?? `adr_new00${i}`,
						...a,
					})),
				});
			},
		});
		expect(server.last('GET /v1/me')?.headers[SIGN_IN_HEADER]).toBe('sig-1');
		expect(heading(host)).toBe(strings['account.title']);
		const profile = part(host, strings['account.profile']);
		expect([...profile.querySelectorAll('.meta')].map((p) => p.textContent)).toEqual([
			'Email: ana@example.com',
			'Phone: +15550001111',
		]);
		expect(fieldIn(profile, 'Size').value).toBe('S');
		fieldIn(profile, strings['fields.name']).value = ' Ana Lee ';
		fieldIn(profile, 'Size').value = '';
		await submit(buttonIn(profile, strings['account.save']));
		expect(patches[0]).toEqual({ name: 'Ana Lee', custom: { size: '' } });
		expect(statusIn(profile)).toBe(strings['account.saved']);
		expect(widget.user()?.name).toBe('Ana Lee');
		fieldIn(profile, strings['fields.name']).value = 'x';
		await submit(buttonIn(profile, strings['account.save']));
		expect(statusIn(profile)).toBe(strings['error.field.name']);

		const addresses = part(host, strings['account.addresses']);
		expect(addresses.querySelector('li')?.firstChild?.textContent).toBe('Home, Ana, 1 Main St, Springfield, North 12345, US');
		await click(buttonIn(addresses, strings['account.addressAdd']));
		fieldIn(addresses, strings['address.line1']).value = '2 Side St';
		fieldIn(addresses, strings['address.city']).value = 'Shelbyville';
		await submit(buttonIn(addresses, strings['account.addressSave']));
		expect(patches.at(-1).addresses).toHaveLength(2);
		expect(patches.at(-1).addresses[1]).toMatchObject({ line1: '2 Side St', city: 'Shelbyville', label: '' });
		expect(addresses.querySelectorAll('li')).toHaveLength(2);
		await click(/** @type {HTMLButtonElement} */ (addresses.querySelectorAll('li')[0]?.querySelector('button')));
		expect(fieldIn(addresses, strings['address.line1']).value).toBe('1 Main St');
		fieldIn(addresses, strings['address.city']).value = 'Capital City';
		await submit(buttonIn(addresses, strings['account.addressSave']));
		expect(patches.at(-1).addresses[0]).toMatchObject({ id: 'adr_000001', city: 'Capital City' });
		await click(buttonIn(addresses, strings['account.addressAdd']));
		await click(buttonIn(addresses, strings['account.cancel']));
		expect(addresses.querySelector('form')).toBeNull();
		const removes = /** @type {HTMLButtonElement[]} */ (
			[...addresses.querySelectorAll('li button')].filter((b) => b.textContent === strings['account.remove'])
		);
		await click(/** @type {HTMLButtonElement} */ (removes[0]));
		await click(/** @type {HTMLButtonElement} */ (addresses.querySelector('li button:last-child')));
		expect(patches.at(-1).addresses).toEqual([]);
		expect(addresses.querySelector('li')?.textContent).toBe(strings['account.noAddresses']);
	});

	it('accepts new terms, changes the password, turns two-step on and off', async () => {
		const passwords = [problem(422, 'weak_password', { rule: 'personal' }), answer(204)];
		const { host, server } = await open({
			'POST /v1/me/terms': () => answer(200, { ...ME, terms: { version: 'v2', acceptedAt: at(0) } }),
			'PUT /v1/me/password': () => /** @type {Response} */ (passwords.shift()),
			'POST /v1/me/two-step/setup': () => answer(200, { challenge: 'su1', secret: 'SECRET', otpauthUrl: 'otpauth://totp/x' }),
			'POST /v1/me/two-step/enable': ({ body }) =>
				body.code === '000000' ? problem(400, 'code_invalid') : answer(200, { recoveryCodes: ['r-1', 'r-2'] }),
			'POST /v1/me/two-step/disable': () => answer(204),
			'POST /v1/me/two-step/recovery-codes': ({ body }) =>
				body.code === '000000' ? problem(400, 'code_invalid') : answer(200, { recoveryCodes: ['n-1', 'n-2'] }),
		});
		const terms = part(host, strings['account.termsTitle']);
		await click(buttonIn(terms, strings['account.termsAccept']));
		expect(statusIn(terms)).toBe(strings['terms.tick']);
		checkIn(terms, strings['terms.accept']).checked = true;
		await click(buttonIn(terms, strings['account.termsAccept']));
		expect(server.last('POST /v1/me/terms')?.body).toEqual({ accept: true });
		expect(statusIn(terms)).toBe(strings['account.termsDone']);

		const password = part(host, strings['account.password']);
		fieldIn(password, strings['account.currentPassword']).value = 'old-pass';
		fieldIn(password, strings['account.newPassword']).value = 'new';
		await submit(buttonIn(password, strings['account.passwordChange']));
		expect(statusIn(password)).toBe(strings['error.weak_password.personal']);
		fieldIn(password, strings['account.newPassword']).value = 'new-password-2';
		await submit(buttonIn(password, strings['account.passwordChange']));
		expect(server.last('PUT /v1/me/password')?.body).toEqual({ current: 'old-pass', password: 'new-password-2' });
		expect(statusIn(password)).toBe(strings['account.passwordSaved']);

		const twoStep = part(host, strings['account.twoStep']);
		await click(buttonIn(twoStep, strings['account.twoStepTurnOn']));
		expect([...twoStep.querySelectorAll('.code')].map((p) => p.textContent)).toEqual(['Key: SECRET', 'otpauth://totp/x']);
		await click(buttonIn(twoStep, strings['account.cancel']));
		await click(buttonIn(twoStep, strings['account.twoStepTurnOn']));
		fieldIn(twoStep, strings['twoStep.code']).value = '000000';
		await click(buttonIn(twoStep, strings['account.twoStepConfirm']));
		expect(statusIn(twoStep)).toBe(strings['error.code_invalid']);
		fieldIn(twoStep, strings['twoStep.code']).value = '123456';
		await click(buttonIn(twoStep, strings['account.twoStepConfirm']));
		expect(server.last('POST /v1/me/two-step/enable')?.body).toEqual({ challenge: 'su1', code: '123456' });
		expect([...twoStep.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['r-1', 'r-2']);
		await click(buttonIn(twoStep, strings['recovery.done']));
		// new recovery codes, with a code from the app or a recovery code
		fieldIn(twoStep, strings['twoStep.code']).value = '000000';
		await click(buttonIn(twoStep, strings['account.recoveryRenew']));
		expect(statusIn(twoStep)).toBe(strings['error.code_invalid']);
		fieldIn(twoStep, strings['twoStep.code']).value = ' abcde-fghjk ';
		await click(buttonIn(twoStep, strings['account.recoveryRenew']));
		expect(server.last('POST /v1/me/two-step/recovery-codes')?.body).toEqual({ recoveryCode: 'abcde-fghjk' });
		expect(statusIn(twoStep)).toBe(strings['account.recoveryRenewed']);
		expect([...twoStep.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['n-1', 'n-2']);
		await click(buttonIn(twoStep, strings['recovery.done']));
		fieldIn(twoStep, strings['twoStep.code']).value = '654321';
		await click(buttonIn(twoStep, strings['account.twoStepTurnOff']));
		expect(server.last('POST /v1/me/two-step/disable')?.body).toEqual({ code: '654321' });
		expect(statusIn(twoStep)).toBe(strings['account.twoStepTurnedOff']);
		expect(hasButton(twoStep, strings['account.twoStepTurnOn'])).toBe(true);
	});

	it('lists the devices, signs one out and signs out everywhere', async () => {
		let items = [
			{
				id: 'ses_1',
				device: 'Firefox on Linux',
				method: 'email_password',
				signedInAt: at(0),
				lastUsedAt: at(60_000),
				current: true,
			},
			{ id: 'ses_2', device: '', method: 'google', signedInAt: at(0), lastUsedAt: null, current: false },
		];
		const { host, server, widget } = await open({
			'GET /v1/me/sessions': () => answer(200, { items }),
			'DELETE /v1/me/sessions/ses_2': () => {
				items = items.slice(0, 1);
				return answer(204);
			},
			'POST /v1/me/sign-out-everywhere': () => answer(204),
		});
		const devices = part(host, strings['account.devices']);
		const rows = [...devices.querySelectorAll('li')];
		expect(rows[0]?.firstChild?.textContent).toBe('Firefox on Linux');
		expect(rows[0]?.querySelector('.meta')?.textContent).toBe(`Signed in with Password · Last used ${when(at(60_000))}`);
		expect(rows[0]?.querySelector('.tag')?.textContent).toBe(strings['account.thisDevice']);
		expect(rows[1]?.firstChild?.textContent).toBe(strings['account.unknownDevice']);
		await click(buttonIn(devices, strings['account.signOutDevice']));
		expect(server.calls.some((c) => c.method === 'DELETE' && c.path === '/v1/me/sessions/ses_2')).toBe(true);
		expect(statusIn(devices)).toBe(strings['account.deviceSignedOut']);
		expect(devices.querySelectorAll('li')).toHaveLength(1);
		await click(buttonIn(devices, strings['account.signOutEverywhere']));
		expect(widget.user()).toBeNull();
		expect(events.out).toBe(1);
		expect(statusIn(shadow(host))).toBe(strings['account.signedOut']);
	});

	it('downloads the data, asks to delete the account and lists the orders', async () => {
		const { host, server } = await open({
			'POST /v1/me/export': () =>
				answer(200, { url: 'https://accounts.example.dev/v1/exports/web_1/tok', expiresAt: at(3_600_000) }),
			'POST /v1/me/delete': () => answer(202, { requestedAt: at(0), dueAt: at(30 * 86_400_000) }),
			'GET /v1/me/orders': () =>
				answer(200, {
					items: [
						{ id: 'ord_1', number: 'A-100', status: 'paid', total: '$10.00', createdAt: at(0) },
						{
							id: 'ord_3',
							number: 'A-101',
							status: 'packed',
							statusLabel: 'Being packed',
							totalText: 'EUR 1,250.00',
							total: 125000,
						},
						{ id: 'ord_2', status: 7, total: { amount: 5 } },
						'junk',
					],
				}),
		});
		const privacy = part(host, strings['account.privacy']);
		await click(buttonIn(privacy, strings['account.export']));
		const link = /** @type {HTMLAnchorElement} */ (privacy.querySelector('a'));
		expect(link.getAttribute('href')).toBe('https://accounts.example.dev/v1/exports/web_1/tok');
		expect(link.textContent).toBe(strings['account.exportLink']);
		await click(buttonIn(privacy, strings['account.delete']));
		expect(privacy.textContent).toContain(strings['account.deleteConfirm']);
		await click(buttonIn(privacy, strings['account.deleteNo']));
		await click(buttonIn(privacy, strings['account.delete']));
		await click(buttonIn(privacy, strings['account.deleteYes']));
		expect(server.last('POST /v1/me/delete')).toBeTruthy();
		expect(privacy.textContent).toContain(`Your account will be deleted on ${when(at(30 * 86_400_000), 'date')}.`);
		const orders = part(host, strings['account.orders']);
		const rows = [...orders.querySelectorAll('li')];
		expect(rows.map((li) => li.firstChild?.textContent)).toEqual(['Order A-100', 'Order A-101', 'Order ord_2', 'Order ']);
		expect(rows[0]?.querySelector('.meta')?.textContent).toBe(`paid · $10.00 · ${when(at(0))}`);
		expect(rows[1]?.querySelector('.meta')?.textContent).toBe('Being packed · EUR 1,250.00');
		expect(rows[2]?.querySelector('.meta')?.textContent).toBe('');
	});

	it('shows dates and order totals in the Format and business time zone of the widget config', async () => {
		looks = {
			format: { locale: 'en-GB', currencyDisplay: 'custom', currencySymbol: 'US$', wholeUnits: true, times: 'business' },
			timeZone: 'Asia/Tokyo',
		};
		const { host } = await open({
			'GET /v1/me/sessions': () =>
				answer(200, {
					items: [
						{
							id: 'ses_1',
							device: 'Firefox on Linux',
							method: 'email_password',
							signedInAt: at(0),
							lastUsedAt: at(60_000),
							current: true,
						},
					],
				}),
			'POST /v1/me/delete': () => answer(202, { requestedAt: at(0), dueAt: '2026-10-31T20:00:00Z' }),
			'GET /v1/me/orders': () =>
				answer(200, {
					items: [
						{
							id: 'ord_1',
							number: 'A-100',
							status: 'paid',
							total: 1250000,
							totalText: 'USD 12,500.00',
							currency: 'USD',
							createdAt: '2026-10-01T22:30:00Z',
						},
					],
				}),
		});
		// 10:01 UTC is 19:01 in Tokyo; 22:30 UTC is already the next day there
		const devices = part(host, strings['account.devices']);
		expect(devices.querySelector('.meta')?.textContent).toBe('Signed in with Password · Last used 1 Oct 2026, 19:01');
		const orders = part(host, strings['account.orders']);
		expect(orders.querySelector('.meta')?.textContent).toBe('paid · US$ 12,500 · 2 Oct 2026, 07:30');
		const privacy = part(host, strings['account.privacy']);
		await click(buttonIn(privacy, strings['account.delete']));
		await click(buttonIn(privacy, strings['account.deleteYes']));
		expect(privacy.textContent).toContain('Your account will be deleted on 1 Nov 2026.');
	});

	it('shows a pending deletion, failures and the parts of switched-on features only', async () => {
		const { host } = await open(
			{
				'POST /v1/me/export': () => problem(429, 'rate_limited'),
				'POST /v1/me/delete': () => problem(500, 'internal'),
				'GET /v1/me/orders': () => answer(500, {}),
				'GET /v1/me/sessions': () => answer(500, {}),
			},
			{
				...ME,
				deletion: { requestedAt: at(0), dueAt: null },
				terms: { version: 'v2', acceptedAt: at(0) },
				email: null,
				hasPassword: false,
			},
		);
		expect(() => part(host, strings['account.termsTitle'])).toThrow();
		expect(() => part(host, strings['account.password'])).toThrow();
		const privacy = part(host, strings['account.privacy']);
		expect(privacy.textContent).toContain(strings['account.deletionWaiting']);
		await click(buttonIn(privacy, strings['account.export']));
		expect(statusIn(privacy)).toBe(strings['error.rate_limited']);
		expect(statusIn(part(host, strings['account.orders']))).toBe(strings['account.ordersFailed']);
		expect(statusIn(part(host, strings['account.devices']))).toBe(strings['error.generic']);
		vi.restoreAllMocks();
		document.body.replaceChildren();
		const plain = await open({ 'GET /v1/me': () => answer(500, {}) }, ME, ['phone_code']);
		expect(statusIn(shadow(plain.host))).toBe(strings['account.failed']);
	});

	it('sets a first password and handles failing two-step and deletion calls', async () => {
		const { host, server } = await open(
			{
				'PUT /v1/me/password': () => answer(204),
				'POST /v1/me/two-step/setup': () => problem(409, 'conflict'),
				'POST /v1/me/two-step/disable': () => problem(400, 'code_invalid'),
				'POST /v1/me/two-step/recovery-codes': () => answer(200, {}),
				'POST /v1/me/delete': () => problem(500, 'internal'),
				'POST /v1/me/sign-out-everywhere': () => answer(500, {}),
				'POST /v1/me/terms': () => answer(204),
				'GET /v1/me/orders': () => answer(200, { items: [] }),
			},
			{ ...ME, hasPassword: false, twoStep: true },
		);
		const password = part(host, strings['account.password']);
		expect(() => fieldIn(password, strings['account.currentPassword'])).toThrow();
		fieldIn(password, strings['account.newPassword']).value = 'first-password';
		await submit(buttonIn(password, strings['account.passwordSet']));
		expect(server.last('PUT /v1/me/password')?.body).toEqual({ password: 'first-password' });
		const twoStep = part(host, strings['account.twoStep']);
		await click(buttonIn(twoStep, strings['account.twoStepTurnOff']));
		expect(statusIn(twoStep)).toBe(strings['error.code_invalid']);
		// an answer without codes shows an empty list
		await click(buttonIn(twoStep, strings['account.recoveryRenew']));
		expect(twoStep.querySelectorAll('li')).toHaveLength(0);
		const privacy = part(host, strings['account.privacy']);
		await click(buttonIn(privacy, strings['account.delete']));
		await click(buttonIn(privacy, strings['account.deleteYes']));
		expect(statusIn(privacy)).toBe(strings['error.generic']);
		const devices = part(host, strings['account.devices']);
		await click(buttonIn(devices, strings['account.signOutEverywhere']));
		expect(statusIn(devices)).toBe(strings['error.generic']);
		expect(statusIn(part(host, strings['account.orders']))).toBe(strings['account.ordersEmpty']);
		const terms = part(host, strings['account.termsTitle']);
		checkIn(terms, strings['terms.accept']).checked = true;
		await click(buttonIn(terms, strings['account.termsAccept']));
		expect(statusIn(terms)).toBe(strings['account.termsDone']);
		vi.restoreAllMocks();
		document.body.replaceChildren();
		const off = await open({ 'POST /v1/me/two-step/setup': () => problem(409, 'conflict') }, { ...ME, twoStep: false });
		const again = part(off.host, strings['account.twoStep']);
		await click(buttonIn(again, strings['account.twoStepTurnOn']));
		expect(statusIn(again)).toBe(strings['error.conflict']);
	});
});

describe('admin widgets', () => {
	const TICKET = { ticket: 'ticket-1', expiresAt: at(15 * 60_000) };
	const ROLES = [
		{
			key: 'customer',
			name: 'Customer',
			description: 'Shoppers.',
			permissions: [],
			twoStep: 'optional',
			sessionHours: 24,
			rememberDays: 30,
			rank: 900,
			ready: true,
		},
		{
			key: 'owner',
			name: 'Owner',
			description: 'All.',
			permissions: ['*'],
			twoStep: 'required',
			sessionHours: 12,
			rememberDays: 0,
			rank: 100,
			ready: true,
		},
		{
			key: 'helper',
			name: 'Helper',
			description: 'Own role.',
			permissions: ['accounts:users.read', 'gone:thing'],
			twoStep: 'optional',
			sessionHours: 8,
			rememberDays: 7,
			rank: 600,
			ready: false,
		},
	];

	/**
	 * @param {Record<string, Route>} routes
	 * @param {string[]} [features]
	 * @param {() => Promise<any>} [getTicket]
	 */
	const startAdmin = async (
		routes,
		features = ['roles', 'approval', 'data_rights', 'two_step'],
		getTicket = async () => TICKET,
	) => {
		const server = serve({ [`GET ${ADMIN_CONFIG_PATH}`]: () => answer(200, configOf(features)), ...routes });
		const time = clock();
		const widget = startWidget({
			window,
			script: script(null),
			schedule: time.schedule,
			cancel: time.cancel,
			now: () => time.now,
		});
		await widget.admin({ getTicket });
		await flush();
		return { server, time };
	};

	it('mount nothing without a ticket, a config or Roles', async () => {
		const users = place('users_admin');
		const roles = place('roles_admin');
		const { spy } = serve({ [`GET ${ADMIN_CONFIG_PATH}`]: () => answer(403) });
		const widget = startWidget({ window, script: script(null) });
		await widget.admin({
			getTicket: async () => {
				throw new Error('no');
			},
		});
		await widget.admin({ getTicket: async () => /** @type {any} */ ({}) });
		expect(spy).not.toHaveBeenCalled();
		await widget.admin({ getTicket: async () => TICKET });
		expect(users.shadowRoot).toBeNull();
		vi.restoreAllMocks();
		await startAdmin({}, ['email_password']);
		expect(users.shadowRoot).toBeNull();
		expect(roles.shadowRoot).toBeNull();
	});

	it('Users admin: counts on the chips, filters, the first user’s detail and the More menu', async () => {
		const host = place('users_admin');
		const ana = {
			...USER,
			role: 'customer',
			notes: 'Calls on Fridays',
			blocked: null,
			status: 'pending',
			lastSignInAt: at(0),
			roleSince: at(0),
			recoveryCodesLeft: 3,
			twoStep: true,
			lockedUntil: at(60_000),
			providers: ['google'],
			terms: { version: '2', acceptedAt: at(0) },
			custom: { size: 'M' },
			addresses: [{ id: 'adr_1', label: 'Home', line1: '1 Main St', area: 'Camden', city: 'London', default: true }],
			deletion: { requestedAt: at(0), dueAt: at(86_400_000) },
		};
		const bo = {
			...USER,
			id: 'usr_2',
			name: '',
			email: null,
			phone: '+15550002222',
			role: 'helper',
			notes: '',
			blocked: { at: at(0), reason: 'spam' },
			status: 'active',
			lastSignInAt: null,
		};
		/** @type {URL[]} */
		const asked = [];
		const { server } = await startAdmin(
			{
				'GET /v1/admin/roles': () => answer(200, { items: ROLES }),
				'GET /v1/admin/users/counts': () => answer(200, { total: 7, groups: { active: 4, pending: 2, invited: 1 } }),
				'GET /v1/admin/users/count': ({ url }) =>
					answer(200, { count: url.searchParams.get('deletion') ? 1 : 2, capped: false }),
				'GET /v1/admin/users': ({ url }) => {
					asked.push(url);
					if (url.searchParams.get('q') === 'none') return answer(200, { items: [], nextCursor: null, hasMore: false });
					if (url.searchParams.get('q') === 'boom') return problem(500, 'internal');
					return url.searchParams.get('cursor')
						? answer(200, { items: [bo], nextCursor: null, hasMore: false })
						: answer(200, { items: [ana], nextCursor: 'c1', hasMore: true });
				},
				'PATCH /v1/admin/users/usr_1': ({ body }) => answer(200, { ...ana, ...body }),
				'PATCH /v1/admin/users/usr_2': () => answer(200, { ...bo, blocked: null }),
				'POST /v1/admin/users/usr_1/approve': () => answer(200, { ...ana, status: 'active' }),
				'POST /v1/admin/users/usr_1/decline': () => problem(409, 'conflict'),
				'POST /v1/admin/users/usr_1/sign-out': () => answer(204),
				'POST /v1/admin/users/usr_1/sign-in-code': () => answer(200, { code: '123456', expiresAt: at(900_000) }),
				'POST /v1/admin/users/usr_1/setup-link': () => problem(403, 'forbidden'),
				'POST /v1/admin/users/usr_2/setup-link': () =>
					answer(200, { url: 'https://shop.example.com/?ss_setup=x', expiresAt: at(0) }),
				'POST /v1/admin/users/usr_1/deletion/approve': () => answer(200, {}),
				'POST /v1/admin/users/usr_1/deletion/reject': () => answer(200, ana),
				'DELETE /v1/admin/users/usr_1': () => answer(200, { deleted: true, pending: [] }),
			},
			['roles', 'approval', 'data_rights', 'two_step', 'staff_links'],
		);
		const root = shadow(host);
		expect(server.calls.find((c) => c.path === '/v1/admin/users')?.headers.authorization).toBe('Bearer ticket-1');
		// the chips carry the counts
		const chipText = [...root.querySelectorAll('.chip')].map((chip) => chip.textContent);
		expect(chipText).toEqual(['All7', 'Active4', 'Waiting for approval2', 'Invited1', 'Blocked2', 'Asked to delete1']);
		// the list and, beside it, the first user
		const first = /** @type {HTMLElement} */ (root.querySelector('li.row-item'));
		expect(first.textContent).toContain('Ana');
		expect(first.querySelector('.meta')?.textContent).toBe(`ana@example.com · Customer · ${strings['users.deletionAsked']}`);
		expect(first.getAttribute('aria-current')).toBe('true');
		const detail = /** @type {HTMLElement} */ (root.querySelector('.detail-pane'));
		expect(detail.querySelector('h3')?.textContent).toBe('Ana');
		const cards = [...detail.querySelectorAll('.card h4')].map((h) => h.textContent);
		expect(cards).toEqual([
			strings['users.contact'],
			strings['users.account'],
			strings['users.addresses'],
			strings['users.notesCard'],
			strings['users.deletionCard'],
		]);
		expect(detail.textContent).toContain('ana@example.com (verified)');
		expect(detail.textContent).toContain('On, 3 recovery codes left');
		expect(detail.textContent).toContain('1 Main St, Camden, London');
		expect(detail.textContent).toContain(formatDeletion(at(0)));
		await click(buttonIn(root, strings['users.more']));
		expect(asked.at(-1)?.searchParams.get('cursor')).toBe('c1');
		const second = /** @type {HTMLElement} */ (root.querySelectorAll('li.row-item')[1]);
		expect(second.textContent).toContain('+15550002222');
		expect(second.textContent).toContain(strings['users.never']);

		// a chip and the filters
		await click(/** @type {HTMLButtonElement} */ (root.querySelectorAll('.chip')[5]));
		expect(asked.at(-1)?.searchParams.get('deletion')).toBe('1');
		await click(/** @type {HTMLButtonElement} */ (root.querySelectorAll('.chip')[2]));
		fieldIn(root, strings['users.search']).value = 'none';
		fieldIn(root, strings['users.phoneDigits']).value = '07700 900567';
		const roleSelect = fieldIn(root, strings['users.roles']);
		roleSelect.options[0].selected = true;
		roleSelect.options[2].selected = true;
		fieldIn(root, strings['users.permission']).value = 'accounts:users.read';
		fieldIn(root, strings['users.joinedAfter']).value = '2026-09-01';
		checkIn(root, strings['users.hideBlocked']).checked = true;
		await submit(buttonIn(root, strings['users.searchButton']));
		expect(Object.fromEntries(asked.at(-1)?.searchParams ?? [])).toEqual({
			q: 'none',
			phoneDigits: '07700 900567',
			roles: 'customer,helper',
			permission: 'accounts:users.read',
			createdAfter: '2026-09-01T00:00:00Z',
			blocked: 'false',
			status: 'pending',
			limit: '25',
		});
		expect(statusIn(root)).toBe(strings['users.empty']);
		expect(detail.textContent).toBe(strings['users.emptyDetail']);
		fieldIn(root, strings['users.search']).value = 'boom';
		await submit(buttonIn(root, strings['users.searchButton']));
		expect(statusIn(root)).toBe(strings['error.generic']);
		for (const label of [
			strings['users.search'],
			strings['users.phoneDigits'],
			strings['users.permission'],
			strings['users.joinedAfter'],
		])
			fieldIn(root, label).value = '';
		roleSelect.options[0].selected = false;
		roleSelect.options[2].selected = false;
		checkIn(root, strings['users.hideBlocked']).checked = false;
		await click(/** @type {HTMLButtonElement} */ (root.querySelectorAll('.chip')[0]));

		// the More menu: a sign-in code in a dialog, a refused setup link, approve, decline, keep the account
		const menuOf = () => /** @type {HTMLElement} */ (detail.querySelector('.more'));
		const pick = async (/** @type {string} */ label) => {
			await click(/** @type {HTMLButtonElement} */ (menuOf().querySelector('button')));
			expect(/** @type {HTMLElement} */ (menuOf().querySelector('.menu')).hidden).toBe(false);
			await click(buttonIn(menuOf(), label));
		};
		const items = [...menuOf().querySelectorAll('.menu button')].map((b) => b.textContent);
		expect(items).toEqual([
			strings['users.signInCode'],
			strings['users.setupLink'],
			strings['users.signOut'],
			strings['users.approve'],
			strings['users.decline'],
			strings['users.deletionReject'],
			strings['users.block'],
			strings['users.deletionApprove'],
			strings['users.delete'],
		]);
		expect(menuOf().querySelector('.menu button:last-child')?.className).toContain('danger-text');
		await pick(strings['users.signInCode']);
		const dialog = () => /** @type {HTMLElement} */ (root.querySelector('.dialog'));
		expect(dialog().querySelector('.code')?.textContent).toBe('123456');
		expect(dialog().textContent).toContain('Read this code to Ana.');
		await click(buttonIn(dialog(), strings['users.copy']));
		await click(buttonIn(dialog(), '×'));
		expect(root.querySelector('.overlay')).toBeNull();
		await pick(strings['users.setupLink']);
		expect(statusIn(detail)).toBe(strings['error.forbidden']);
		await pick(strings['users.approve']);
		expect(statusIn(detail)).toBe(strings['users.approved']);
		await pick(strings['users.decline']);
		expect(statusIn(detail)).toBe(strings['error.conflict']);
		await pick(strings['users.signOut']);
		expect(statusIn(detail)).toBe(strings['users.signedOutUser']);
		await pick(strings['users.deletionReject']);
		expect(statusIn(detail)).toBe(strings['users.deletionRejected']);
		await pick(strings['users.deletionApprove']);
		expect(statusIn(detail)).toBe(strings['users.deletionApproved']);

		// edit: contacts, role, notes, a new password, custom fields and addresses
		await click(buttonIn(detail, strings['users.edit']));
		expect(dialog().querySelector('h3')?.textContent).toBe('Edit Ana');
		fieldIn(dialog(), strings['fields.phone']).value = '+15550009999';
		fieldIn(dialog(), strings['users.role']).value = 'helper';
		fieldIn(dialog(), strings['users.notes']).value = 'Called';
		fieldIn(dialog(), strings['users.newPassword']).value = 'a new password';
		await click(buttonIn(dialog(), strings['account.addressAdd']));
		const fieldsets = dialog().querySelectorAll('fieldset');
		// each part takes at most what the API takes (it used to allow 200 everywhere, so a long postal code was refused)
		expect(fieldIn(/** @type {HTMLElement} */ (fieldsets[1]), strings['address.postalCode']).maxLength).toBe(20);
		expect(fieldIn(/** @type {HTMLElement} */ (fieldsets[1]), strings['address.country']).maxLength).toBe(2);
		expect(fieldIn(/** @type {HTMLElement} */ (fieldsets[1]), strings['address.label']).maxLength).toBe(40);
		fieldIn(/** @type {HTMLElement} */ (fieldsets[1]), strings['address.line1']).value = '2 Park Rd';
		fieldIn(/** @type {HTMLElement} */ (fieldsets[1]), strings['address.city']).value = 'London';
		await submit(buttonIn(dialog(), strings['users.save']));
		expect(server.last('PATCH /v1/admin/users/usr_1')?.body).toEqual({
			name: 'Ana',
			role: 'helper',
			notes: 'Called',
			phone: '+15550009999',
			password: 'a new password',
			addresses: [
				{
					id: 'adr_1',
					label: 'Home',
					name: '',
					line1: '1 Main St',
					line2: '',
					area: 'Camden',
					city: 'London',
					region: '',
					postalCode: '',
					country: '',
					phone: '',
					default: true,
				},
				{
					label: '',
					name: '',
					line1: '2 Park Rd',
					line2: '',
					area: '',
					city: 'London',
					region: '',
					postalCode: '',
					country: '',
					phone: '',
					default: false,
				},
			],
		});
		expect(root.querySelector('.overlay')).toBeNull();
		expect(statusIn(detail)).toBe(strings['users.saved']);

		// block with a reason; delete behind the typed name
		await pick(strings['users.block']);
		fieldIn(dialog(), strings['users.blockedReason']).value = ' abuse ';
		await submit(buttonIn(dialog(), strings['users.blockSubmit']));
		expect(server.last('PATCH /v1/admin/users/usr_1')?.body).toEqual({ blocked: true, blockedReason: 'abuse' });
		await pick(strings['users.delete']);
		fieldIn(dialog(), strings['users.deleteReason']).value = 'Asked by phone';
		fieldIn(dialog(), strings['users.typeToConfirm']).value = 'Anna';
		await submit(buttonIn(dialog(), strings['users.deleteSubmit']));
		expect(server.last('DELETE /v1/admin/users/usr_1')).toBeUndefined();
		fieldIn(dialog(), strings['users.typeToConfirm']).value = 'Ana';
		// removed from Accounts only: the other products keep the person's data
		checkIn(dialog(), strings['users.deleteKeep']).checked = true;
		await submit(buttonIn(dialog(), strings['users.deleteSubmit']));
		expect(server.last('DELETE /v1/admin/users/usr_1')?.body).toEqual({ reason: 'Asked by phone' });
		expect(server.last('DELETE /v1/admin/users/usr_1')?.url.searchParams.get('scope')).toBe('accounts');

		// another user: unblock and a setup link to hand over; Back on narrow widgets
		await click(/** @type {HTMLButtonElement} */ (/** @type {unknown} */ (root.querySelectorAll('li.row-item')[0])));
		expect(root.querySelector('.layout')?.classList.contains('picked')).toBe(true);
		await click(buttonIn(detail, strings['users.back']));
		expect(root.querySelector('.layout')?.classList.contains('picked')).toBe(false);
	});

	it('Users admin: Add user, Invite with the link handed to staff, and role requests', async () => {
		const host = place('users_admin');
		const bo = {
			...USER,
			id: 'usr_2',
			name: 'Bo',
			status: 'active',
			blocked: { at: at(0), reason: '' },
			notes: '',
			lastSignInAt: null,
		};
		let created = false;
		let unproven = 0;
		/** @type {Array<Record<string, any>>} */
		let requests = [
			{
				id: 'rrq_1',
				role: 'helper',
				name: 'Nia',
				phone: '+447700900222',
				email: null,
				note: 'Member please',
				status: 'pending',
				createdAt: at(0),
			},
			{
				id: 'rrq_2',
				role: 'helper',
				name: 'Dee',
				phone: null,
				email: 'dee@example.com',
				note: '',
				status: 'expired',
				createdAt: at(0),
			},
			{
				id: 'rrq_3',
				role: 'helper',
				name: 'Cy',
				phone: '+447700900333',
				email: null,
				note: '',
				status: 'pending',
				createdAt: at(0),
			},
		];
		const { server } = await startAdmin(
			{
				'GET /v1/admin/roles': () => answer(200, { items: ROLES }),
				'GET /v1/admin/users/counts': () => problem(500, 'internal'),
				'GET /v1/admin/users': () =>
					answer(200, {
						items: created ? [{ ...bo, id: 'usr_9', name: 'Zed' }, bo] : [bo],
						nextCursor: null,
						hasMore: false,
					}),
				'PATCH /v1/admin/users/usr_2': () => answer(200, { ...bo, blocked: null }),
				'POST /v1/admin/users/usr_2/setup-link': () =>
					answer(200, { url: 'https://shop.example.com/?ss_setup=abc', expiresAt: at(0) }),
				'POST /v1/admin/users': ({ body }) => {
					if (body.email === 'taken@example.com') return problem(409, 'already_exists');
					created = true;
					return answer(201, { ...bo, id: 'usr_9', name: body.name });
				},
				'POST /v1/admin/users/invite': ({ body }) =>
					answer(
						201,
						body.deliver === 'return' ? { invite: { url: 'https://shop.example.com/join#x', expiresAt: at(0) } } : {},
					),
				'GET /v1/admin/role-requests/counts': () => answer(200, { total: 3, groups: { pending: 2, invited: 1 } }),
				'GET /v1/admin/role-requests/count': () => answer(200, { count: 1, capped: false }),
				'GET /v1/admin/role-requests': ({ url }) => {
					const status = url.searchParams.get('status');
					return answer(200, {
						items: requests.filter((r) => !status || r.status === status),
						nextCursor: null,
						hasMore: false,
					});
				},
				'POST /v1/admin/role-requests/rrq_1/invite': () => {
					requests = requests.map((r) => (r.id === 'rrq_1' ? { ...r, status: 'invited' } : r));
					return answer(200, {
						request: {},
						user: {},
						setupLink: { url: 'https://shop.example.com/?ss_setup=nia', expiresAt: at(0) },
					});
				},
				'POST /v1/admin/role-requests/rrq_3/invite': () => {
					unproven += 1;
					// someone signed up first with Cy's number and never proved it (SA-2)
					return unproven === 1
						? problem(409, 'contact_unverified')
						: answer(200, { request: {}, user: {}, setupLink: null });
				},
				'POST /v1/admin/role-requests/rrq_3/decline': () => problem(409, 'conflict'),
				'POST /v1/admin/role-requests/rrq_2/reopen': () => answer(200, {}),
			},
			['roles', 'approval', 'staff_links', 'role_requests'],
		);
		const root = shadow(host);
		const dialog = () => /** @type {HTMLElement} */ (root.querySelector('.dialog'));
		// chips stay without counts when the counts cannot be read
		expect([...root.querySelectorAll('.box > .chips .badge')].every((badge) => badge.textContent === '')).toBe(true);

		// Add user
		await click(buttonIn(root, strings['users.add']));
		fieldIn(dialog(), strings['fields.name']).value = 'Zed';
		fieldIn(dialog(), strings['fields.email']).value = 'taken@example.com';
		fieldIn(dialog(), strings['fields.password']).value = 'first password';
		await submit(buttonIn(dialog(), strings['users.add']));
		expect(statusIn(dialog())).toBe(strings['error.already_exists']);
		fieldIn(dialog(), strings['fields.email']).value = 'zed@example.com';
		await submit(buttonIn(dialog(), strings['users.add']));
		expect(server.last('POST /v1/admin/users')?.body).toEqual({
			name: 'Zed',
			role: 'customer',
			notes: '',
			email: 'zed@example.com',
			password: 'first password',
		});
		expect(root.querySelector('.detail-pane h3')?.textContent).toBe('Zed');

		// Invite, sent or handed to staff
		await click(buttonIn(root, strings['users.invite']));
		fieldIn(dialog(), strings['users.inviteContact']).value = 'ivy@example.com';
		await submit(buttonIn(dialog(), strings['users.inviteSend']));
		expect(server.last('POST /v1/admin/users/invite')?.body).toEqual({ email: 'ivy@example.com', role: 'customer' });
		await click(buttonIn(root, strings['users.invite']));
		fieldIn(dialog(), strings['users.inviteContact']).value = '+15550003333';
		fieldIn(dialog(), strings['fields.name']).value = 'Cy';
		checkIn(dialog(), strings['users.inviteReturn']).checked = true;
		await submit(buttonIn(dialog(), strings['users.inviteSend']));
		expect(server.last('POST /v1/admin/users/invite')?.body).toEqual({
			phone: '+15550003333',
			name: 'Cy',
			role: 'customer',
			deliver: 'return',
		});
		expect(dialog().querySelector('.code')?.textContent).toBe('https://shop.example.com/join#x');
		dialog()
			.closest('.overlay')
			?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
		expect(root.querySelector('.overlay')).toBeNull();

		// a blocked user: unblock, and a setup link
		await click(/** @type {HTMLButtonElement} */ (/** @type {unknown} */ (root.querySelectorAll('li.row-item')[1])));
		const detail = /** @type {HTMLElement} */ (root.querySelector('.detail-pane'));
		const menuButton = () => /** @type {HTMLButtonElement} */ (detail.querySelector('.more > button'));
		await click(menuButton());
		expect(hasButton(detail, strings['users.signInCode'])).toBe(false);
		await click(buttonIn(detail, strings['users.unblock']));
		expect(server.last('PATCH /v1/admin/users/usr_2')?.body).toEqual({ blocked: false });

		// role requests: chips with counts, invite (the setup link), the role given at once, a refusal, open again
		const part = /** @type {HTMLElement} */ (root.querySelector('section.part'));
		expect([...part.querySelectorAll('.chip')].map((c) => c.textContent)).toEqual([
			'All3',
			'Waiting2',
			'Invited0',
			'Link expired1',
			'Done0',
			'Declined0',
		]);
		expect(part.querySelectorAll('li')).toHaveLength(2);
		expect(part.textContent).toContain('Member please');
		const rowMenu = async (/** @type {number} */ index, /** @type {string} */ label) => {
			const row = /** @type {HTMLElement} */ (part.querySelectorAll('li')[index]);
			await click(/** @type {HTMLButtonElement} */ (row.querySelector('.more > button')));
			await click(buttonIn(row, label));
		};
		await rowMenu(0, strings['requests.invite']);
		expect(dialog().querySelector('.code')?.textContent).toBe('https://shop.example.com/?ss_setup=nia');
		await click(buttonIn(dialog(), '×'));
		await rowMenu(0, strings['requests.decline']);
		expect(statusIn(part)).toBe(strings['error.conflict']);
		await rowMenu(0, strings['requests.invite']);
		expect(statusIn(part)).toBe(strings['error.contact_unverified']);
		await rowMenu(0, strings['requests.invite']);
		expect(statusIn(part)).toBe('Cy already has a password: the role is given.');
		await click(/** @type {HTMLButtonElement} */ (part.querySelectorAll('.chip')[3]));
		await rowMenu(0, strings['requests.reopen']);
		expect(statusIn(part)).toBe(strings['requests.reopened']);
		await click(/** @type {HTMLButtonElement} */ (part.querySelectorAll('.chip')[5]));
		expect(statusIn(part)).toBe(strings['requests.empty']);
	});

	it('Users admin: an invited or expired request gets a new link to hand over, or is declined (P4)', async () => {
		const host = place('users_admin');
		const request = (/** @type {string} */ id, /** @type {string} */ status) => ({
			id,
			role: 'helper',
			name: id === 'rrq_5' ? 'Ivo' : 'Eve',
			phone: '+447700900255',
			email: null,
			note: '',
			status,
			createdAt: at(0),
		});
		const { server } = await startAdmin(
			{
				'GET /v1/admin/roles': () => answer(200, { items: ROLES }),
				'GET /v1/admin/users': () => answer(200, { items: [], nextCursor: null, hasMore: false }),
				'GET /v1/admin/role-requests/counts': () => answer(200, { total: 2, groups: { invited: 2 } }),
				'GET /v1/admin/role-requests/count': () => answer(200, { count: 1, capped: false }),
				'GET /v1/admin/role-requests': () =>
					answer(200, {
						items: [request('rrq_5', 'invited'), request('rrq_6', 'expired')],
						nextCursor: null,
						hasMore: false,
					}),
				'POST /v1/admin/role-requests/rrq_5/setup-link': () =>
					answer(200, {
						request: {},
						user: {},
						setupLink: { url: 'https://shop.example.com/?ss_setup=fresh', expiresAt: at(0) },
					}),
				'POST /v1/admin/role-requests/rrq_6/setup-link': () => answer(200, { request: {}, user: {}, setupLink: null }),
				'POST /v1/admin/role-requests/rrq_6/decline': () => answer(200, {}),
			},
			['roles', 'staff_links', 'role_requests'],
		);
		const root = shadow(host);
		const part = /** @type {HTMLElement} */ (root.querySelector('section.part'));
		await click(/** @type {HTMLButtonElement} */ (part.querySelectorAll('.chip')[0]));
		const menuOf = async (/** @type {number} */ index) => {
			const row = /** @type {HTMLElement} */ (part.querySelectorAll('li')[index]);
			await click(/** @type {HTMLButtonElement} */ (row.querySelector('.more > button')));
			return row;
		};
		const labels = (/** @type {HTMLElement} */ row) => [...row.querySelectorAll('.menu button')].map((b) => b.textContent);
		const invited = await menuOf(0);
		expect(labels(invited)).toEqual([strings['requests.newLink'], strings['requests.decline']]);
		await click(buttonIn(invited, strings['requests.newLink']));
		const dialog = /** @type {HTMLElement} */ (root.querySelector('.dialog'));
		expect(dialog.textContent).toContain('New link for Ivo');
		expect(dialog.querySelector('.code')?.textContent).toBe('https://shop.example.com/?ss_setup=fresh');
		await click(buttonIn(dialog, '×'));
		const expired = await menuOf(1);
		expect(labels(expired)).toEqual([strings['requests.newLink'], strings['requests.reopen'], strings['requests.decline']]);
		await click(buttonIn(expired, strings['requests.newLink']));
		expect(statusIn(part)).toBe('Eve already has a password: the role is given.');
		await click(buttonIn(await menuOf(1), strings['requests.decline']));
		expect(statusIn(part)).toBe(strings['requests.declinedDone']);
		expect(server.calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
			'/v1/admin/role-requests/rrq_5/setup-link',
			'/v1/admin/role-requests/rrq_6/setup-link',
			'/v1/admin/role-requests/rrq_6/decline',
		]);
	});

	it('Roles admin edits, copies, deletes roles and names the merchant’s own permissions', async () => {
		const host = place('roles_admin');
		let roles = [...ROLES];
		let own = [{ key: 'site:reports.view', name: 'See reports' }];
		/** @type {any[]} */
		const saved = [];
		const { server } = await startAdmin({
			'GET /v1/admin/roles': () => answer(200, { items: roles }),
			'GET /v1/admin/roles/permissions': () =>
				answer(200, {
					groups: [
						{
							source: 'accounts',
							permissions: [
								{ key: 'accounts:users.read', name: 'See users' },
								{ key: 'accounts:users.manage', name: 'Manage users' },
							],
						},
						{ source: 'empty', permissions: [] },
						{ source: 'site', permissions: own },
					],
					unavailable: ['chat'],
				}),
			'PUT /v1/admin/roles/helper': ({ body }) => {
				saved.push(body);
				roles = roles.map((role) => (role.key === 'helper' ? { ...role, ...body } : role));
				return answer(200, { key: 'helper', ...body, ready: false });
			},
			'PUT /v1/admin/roles/helper_copy': ({ body }) => {
				saved.push(body);
				if (body.sessionHours > 720)
					return problem(422, 'validation_failed', {
						errors: [{ path: '/sessionHours', message: 'Session length is 1 to 720 hours.' }],
					});
				roles = [...roles, { key: 'helper_copy', ...body, ready: false }];
				return answer(200, { key: 'helper_copy', ...body, ready: false });
			},
			'DELETE /v1/admin/roles/helper': () => {
				roles = roles.filter((role) => role.key !== 'helper');
				return answer(204);
			},
			'PUT /v1/admin/roles/permissions': ({ body }) => {
				own = body.permissions.map((/** @type {any} */ p) => ({ key: `site:${p.key}`, name: p.name }));
				return answer(200, body);
			},
		});
		const root = shadow(host);
		const rows = [...root.querySelectorAll('ul > li')];
		expect(rows.map((li) => li.querySelector('.meta')?.textContent)).toEqual([
			`customer · 0 permissions · Rank 900 · ${strings['roles.readyMade']}`,
			`owner · ${strings['roles.allPermissions']} · Rank 100 · ${strings['roles.readyMade']}`,
			'helper · 2 permissions · Rank 600',
		]);
		expect(rows[0]?.textContent).not.toContain(strings['roles.delete']);
		const form = /** @type {HTMLElement} */ (root.querySelector('form'));
		expect(form.querySelector('h3')?.textContent).toBe(strings['roles.newRole']);

		// Owner: every permission
		await click(buttonIn(/** @type {HTMLElement} */ (rows[1]), strings['roles.edit']));
		expect(checkIn(form, strings['roles.allPermissions']).checked).toBe(true);
		expect(/** @type {HTMLElement} */ (form.querySelector('.permissions')).hidden).toBe(true);
		expect(fieldIn(form, strings['roles.key']).readOnly).toBe(true);
		expect(fieldIn(form, strings['roles.twoStep']).value).toBe('required');

		// edit a role: check boxes per group; a permission of a product no longer listed stays visible
		await click(buttonIn(/** @type {HTMLElement} */ (rows[2]), strings['roles.edit']));
		expect(form.querySelector('h3')?.textContent).toBe('Editing Helper');
		const legends = [...form.querySelectorAll('.permissions legend')].map((l) => l.textContent);
		expect(legends).toEqual(['accounts', strings['roles.ownGroup'], strings['roles.otherGroup']]);
		expect(form.textContent).toContain('Not available right now: chat');
		expect(checkIn(form, 'See users').checked).toBe(true);
		expect(checkIn(form, 'gone:thing').checked).toBe(true);
		checkIn(form, 'Manage users').checked = true;
		checkIn(form, 'See reports').checked = true;
		checkIn(form, 'gone:thing').checked = false;
		const twoStep = fieldIn(form, strings['roles.twoStep']);
		twoStep.value = 'required';
		twoStep.dispatchEvent(new window.Event('change'));
		fieldIn(form, strings['roles.sessionHours']).value = '48';
		await submit(buttonIn(form, strings['roles.save']));
		expect(saved[0]).toEqual({
			name: 'Helper',
			description: 'Own role.',
			permissions: ['accounts:users.read', 'accounts:users.manage', 'site:reports.view'],
			twoStep: 'required',
			sessionHours: 48,
			rememberDays: 7,
			sessionRolling: false,
			rank: 600,
			remember: 'ask',
			signIn: 'on',
			logSignIns: false,
			methods: [],
		});
		expect(statusIn(form)).toBe(strings['roles.saved']);

		// copy into a new key; All permissions
		await click(buttonIn(/** @type {HTMLElement} */ (root.querySelectorAll('ul > li')[2]), strings['roles.copy']));
		expect(fieldIn(form, strings['roles.key']).value).toBe('helper_copy');
		expect(fieldIn(form, strings['roles.key']).readOnly).toBe(false);
		expect(fieldIn(form, strings['roles.name']).value).toBe('Copy of Helper');
		const everything = checkIn(form, strings['roles.allPermissions']);
		everything.checked = true;
		everything.dispatchEvent(new window.Event('change'));
		fieldIn(form, strings['roles.sessionHours']).value = '999';
		await submit(buttonIn(form, strings['roles.save']));
		expect(statusIn(form)).toBe(strings['error.field.sessionHours']);
		fieldIn(form, strings['roles.sessionHours']).value = '24';
		await submit(buttonIn(form, strings['roles.save']));
		expect(saved.at(-1).permissions).toEqual(['*']);
		expect(root.querySelectorAll('ul > li')).toHaveLength(4);

		// delete an own role
		await click(buttonIn(/** @type {HTMLElement} */ (root.querySelectorAll('ul > li')[2]), strings['roles.edit']));
		await click(buttonIn(/** @type {HTMLElement} */ (root.querySelectorAll('ul > li')[2]), strings['roles.delete']));
		expect(server.calls.some((c) => c.method === 'DELETE' && c.path === '/v1/admin/roles/helper')).toBe(true);
		expect(statusIn(root)).toBe('Helper was deleted.');
		expect(form.querySelector('h3')?.textContent).toBe(strings['roles.newRole']);
		await click(buttonIn(form, strings['roles.new']));

		// own permissions
		const ownPart = /** @type {HTMLElement} */ (root.querySelector('section.part'));
		expect(fieldIn(ownPart, strings['roles.ownKey']).value).toBe('reports.view');
		await click(buttonIn(ownPart, strings['roles.ownAdd']));
		const keys = [...ownPart.querySelectorAll('.own')];
		const [newKey, newName] = /** @type {HTMLInputElement[]} */ ([...(keys[1]?.querySelectorAll('input') ?? [])]);
		/** @type {HTMLInputElement} */ (newKey).value = 'orders.refund';
		/** @type {HTMLInputElement} */ (newName).value = 'Refund orders';
		await click(buttonIn(ownPart, strings['roles.ownAdd']));
		await click(buttonIn(/** @type {HTMLElement} */ (ownPart.querySelectorAll('.own')[0]), strings['roles.ownRemove']));
		await click(buttonIn(ownPart, strings['roles.ownSave']));
		expect(server.last('PUT /v1/admin/roles/permissions')?.body).toEqual({
			permissions: [{ key: 'orders.refund', name: 'Refund orders' }],
		});
		expect(statusIn(ownPart)).toBe(strings['roles.ownSaved']);
		expect(checkIn(form, 'Refund orders').checked).toBe(false);
	});

	it('show Signed out when the page cannot give a new ticket', async () => {
		const users = place('users_admin');
		const roles = place('roles_admin');
		let calls = 0;
		const { time } = await startAdmin(
			{
				'GET /v1/admin/roles': () => answer(200, { items: ROLES }),
				'GET /v1/admin/roles/permissions': () => answer(200, { groups: [], unavailable: [] }),
				'GET /v1/admin/users': () => answer(200, { items: [], nextCursor: null, hasMore: false }),
			},
			['roles'],
			async () => {
				calls += 1;
				if (calls > 1) throw new Error('signed out');
				return { ticket: 't', expiresAt: at(2 * 60_000) };
			},
		);
		expect(statusIn(shadow(users))).toBe(strings['users.empty']);
		expect(shadow(users).querySelector('form.part')).toBeNull();
		expect(() => fieldIn(shadow(roles), strings['roles.twoStep'])).toThrow();
		await time.fire();
		expect(statusIn(shadow(users))).toBe(strings['users.signedOut']);
		expect(statusIn(shadow(roles))).toBe(strings['roles.signedOut']);
		await submit(buttonIn(shadow(users), strings['users.searchButton']));
		expect(statusIn(shadow(users))).toBe(strings['users.signedOut']);
		const form = /** @type {HTMLElement} */ (shadow(roles).querySelector('form'));
		await submit(buttonIn(form, strings['roles.save']));
		expect(statusIn(form)).toBe(strings['roles.signedOut']);
	});

	it('Users admin shows sign-in and deletion times in the Format and business time zone', async () => {
		looks = {
			format: { locale: 'en-GB', currencyDisplay: 'code', currencySymbol: '', wholeUnits: false, times: 'business' },
			timeZone: 'Asia/Tokyo',
		};
		const host = place('users_admin');
		const ana = {
			...USER,
			notes: '',
			blocked: null,
			status: 'active',
			lastSignInAt: '2026-10-01T22:30:00Z',
			deletion: { requestedAt: at(0), dueAt: null },
		};
		await startAdmin({
			'GET /v1/admin/roles': () => answer(200, { items: ROLES }),
			'GET /v1/admin/users': () => answer(200, { items: [ana], nextCursor: null, hasMore: false }),
		});
		const root = shadow(host);
		expect(root.querySelector('li .figure')?.textContent).toBe('2 Oct 2026');
		expect(root.querySelector('.detail-pane')?.textContent).toContain('2 Oct 2026, 07:30');
		expect(root.querySelector('.detail-pane')?.textContent).toContain('Asked to be deleted on 1 Oct 2026, 19:00.');
	});

	it('Roles admin sets the rank, remember me, the methods, a paused sign-in and the sign-in log', async () => {
		const host = place('roles_admin');
		/** @type {any[]} */
		const saved = [];
		await startAdmin(
			{
				'GET /v1/admin/roles': () =>
					answer(200, { items: ROLES.map((role) => (role.key === 'customer' ? { ...role, signIn: 'paused' } : role)) }),
				'GET /v1/admin/roles/permissions': () => answer(200, { groups: [], unavailable: [] }),
				'PUT /v1/admin/roles/helper': ({ body }) => {
					saved.push(body);
					return answer(200, { key: 'helper', ...body });
				},
			},
			['roles', 'email_password', 'phone_code'],
		);
		const root = shadow(host);
		expect(root.querySelector('ul > li .meta')?.textContent).toContain(strings['roles.paused']);
		await click(buttonIn(/** @type {HTMLElement} */ (root.querySelectorAll('ul > li')[0]), strings['roles.edit']));
		const form = /** @type {HTMLElement} */ (root.querySelector('form'));
		expect(fieldIn(form, strings['roles.rank']).disabled).toBe(true);
		expect(fieldIn(form, strings['roles.signIn']).value).toBe('paused');
		await click(buttonIn(/** @type {HTMLElement} */ (root.querySelectorAll('ul > li')[2]), strings['roles.edit']));
		expect(fieldIn(form, strings['roles.rank']).disabled).toBe(false);
		fieldIn(form, strings['roles.rank']).value = '450';
		const rememberChoices = [...fieldIn(form, strings['roles.remember']).querySelectorAll('option')].map((o) => o.value);
		expect(rememberChoices).toEqual(['ask', 'ask_ticked', 'always', 'never']);
		fieldIn(form, strings['roles.remember']).value = 'never';
		checkIn(form, strings['method.email_password']).checked = true;
		checkIn(form, strings['roles.logSignIns']).checked = true;
		expect(checkIn(form, strings['roles.sessionRolling']).checked).toBe(false);
		checkIn(form, strings['roles.sessionRolling']).checked = true;
		await submit(buttonIn(form, strings['roles.save']));
		expect(saved[0]).toMatchObject({
			rank: 450,
			remember: 'never',
			methods: ['email_password'],
			logSignIns: true,
			sessionRolling: true,
			signIn: 'on',
		});
	});

	it('Activity admin lists the copies with counts per product, filters and paging', async () => {
		const host = place('activity_admin');
		const entry = {
			id: 'act_1',
			productId: 'ecommerce',
			actor: { kind: 'user', id: 'usr_1', name: 'Ana', role: 'Owner' },
			action: 'order.status_changed',
			target: 'ord_1',
			label: 'SH-2026-0043',
			detail: 'Confirmed → Shipped',
			at: at(0),
		};
		/** @type {URL[]} */
		const asked = [];
		await startAdmin(
			{
				'GET /v1/admin/activity-copies/counts': () => answer(200, { total: 5, groups: { ecommerce: 4, chat: 1 } }),
				'GET /v1/admin/activity-copies': ({ url }) => {
					asked.push(url);
					if (url.searchParams.get('q') === 'boom')
						return problem(422, 'validation_failed', { errors: [{ path: '/from', message: 'from is a day.' }] });
					if (url.searchParams.get('productId') === 'chat')
						return answer(200, { items: [], nextCursor: null, hasMore: false });
					return url.searchParams.get('cursor')
						? answer(200, {
								items: [{ ...entry, id: 'act_2', label: null, detail: null }],
								nextCursor: null,
								hasMore: false,
							})
						: answer(200, { items: [entry], nextCursor: 'c1', hasMore: true });
				},
			},
			['activity_copies'],
		);
		const root = shadow(host);
		expect([...root.querySelectorAll('.chip')].map((c) => c.textContent).slice(0, 4)).toEqual([
			`${strings['activity.all']}5`,
			'accounts',
			'chat1',
			'ecommerce4',
		]);
		const first = /** @type {HTMLElement} */ (root.querySelector('li'));
		expect(first.textContent).toContain('SH-2026-0043 · order.status_changed');
		expect(first.textContent).toContain('Confirmed → Shipped');
		expect(first.textContent).toContain(`ecommerce · Ana, Owner · ${when(at(0))}`);
		await click(buttonIn(root, strings['activity.more']));
		expect(asked.at(-1)?.searchParams.get('cursor')).toBe('c1');
		expect(root.querySelectorAll('li')[1]?.textContent).toContain('ord_1 · order.status_changed');
		await click(/** @type {HTMLButtonElement} */ (root.querySelectorAll('.chip')[2]));
		expect(asked.at(-1)?.searchParams.get('productId')).toBe('chat');
		expect(statusIn(root)).toBe(strings['activity.empty']);
		fieldIn(root, strings['activity.search']).value = 'boom';
		fieldIn(root, strings['activity.from']).value = '2026-10-01';
		await submit(buttonIn(root, strings['activity.searchButton']));
		expect(Object.fromEntries(asked.at(-1)?.searchParams ?? [])).toMatchObject({ q: 'boom', from: '2026-10-01', limit: '50' });
		expect(statusIn(root)).toBe(strings['error.field.from']);
	});

	it('Roles admin says when the roles cannot be loaded', async () => {
		const host = place('roles_admin');
		await startAdmin({
			'GET /v1/admin/roles': () => problem(403, 'forbidden'),
			'GET /v1/admin/roles/permissions': () => answer(200, {}),
		});
		expect(statusIn(shadow(host))).toBe(strings['error.forbidden']);
	});
});

describe('Phase 2 options in the widgets (PLAN 0.8.10)', () => {
	const PHONE_RULES = { minLength: 6, letterAndDigit: false, selfReset: 'code', forgotUrl: '' };

	it('phone + password: signs in, signs up, and Forgot password sends a code', async () => {
		const host = place('sign_in');
		const { server } = await start(
			{
				'POST /v1/sign-in/phone-password': ({ body }) =>
					body.password === 'wrong' ? problem(401, 'sign_in_failed') : answer(200, signedIn()),
				'POST /v1/sign-up/phone-password': () => answer(200, { status: 'pending' }),
				'POST /v1/password/phone/forgot': ({ body }) => (body.phone === 'x' ? problem(429, 'code_cooldown') : answer(202)),
				'POST /v1/password/phone/reset': ({ body }) => (body.code === '1' ? problem(422, 'code_invalid') : answer(204)),
			},
			{ features: ['phone_password'], settings: { phonePassword: PHONE_RULES, remember: 'ask_ticked' } },
		);
		const root = shadow(host);
		expect(checkIn(root, strings['signIn.remember']).checked).toBe(true);
		fieldIn(root, strings['fields.phone']).value = ' 07700 900567 ';
		fieldIn(root, strings['fields.password']).value = 'wrong';
		await submit(buttonIn(root, strings['signIn.submit']));
		expect(statusIn(root)).toBe(strings['error.sign_in_failed']);
		fieldIn(root, strings['fields.password']).value = '123456';
		await submit(buttonIn(root, strings['signIn.submit']));
		expect(server.last('POST /v1/sign-in/phone-password')?.body).toMatchObject({
			phone: '07700 900567',
			password: '123456',
			remember: true,
		});
		expect(heading(host)).toBe(strings['signedIn.title']);
		await click(buttonIn(root, strings['signIn.signOut']));

		// sign up
		await click(buttonIn(root, strings['signIn.toSignUp']));
		fieldIn(root, strings['fields.name']).value = 'Robin';
		fieldIn(root, strings['fields.phone']).value = '+447700900567';
		fieldIn(root, strings['fields.password']).value = 'abc123';
		await submit(buttonIn(root, strings['signUp.submit']));
		expect(server.last('POST /v1/sign-up/phone-password')?.body).toMatchObject({ name: 'Robin', phone: '+447700900567' });
		expect(heading(host)).toBe(strings['pending.title']);
		await click(buttonIn(root, strings['signIn.back']));
		await click(buttonIn(root, strings['signUp.toSignIn']));

		// forgot: a code, then the new password
		fieldIn(root, strings['fields.phone']).value = 'x';
		await click(buttonIn(root, strings['signIn.forgot']));
		expect(fieldIn(root, strings['fields.phone']).value).toBe('x');
		await click(buttonIn(root, strings['phoneForgot.send']));
		expect(statusIn(root)).toBe(strings['error.code_cooldown']);
		fieldIn(root, strings['fields.phone']).value = '+447700900567';
		await click(buttonIn(root, strings['phoneForgot.send']));
		expect(statusIn(root)).toBe(strings['phoneForgot.sent']);
		fieldIn(root, strings['phoneForgot.code']).value = '1';
		fieldIn(root, strings['phoneForgot.password']).value = 'new123';
		await submit(buttonIn(root, strings['phoneForgot.submit']));
		expect(statusIn(root)).toBe(strings['error.code_invalid']);
		fieldIn(root, strings['phoneForgot.code']).value = '123456';
		await submit(buttonIn(root, strings['phoneForgot.submit']));
		expect(server.last('POST /v1/password/phone/reset')?.body).toEqual({
			phone: '+447700900567',
			code: '123456',
			password: 'new123',
		});
		expect(statusIn(root)).toBe(strings['reset.done']);
		await click(buttonIn(root, strings['signIn.forgot']));
		await click(buttonIn(root, strings['signIn.back']));
		expect(heading(host)).toBe(strings['signIn.title']);
	});

	it('Forgot password opens the shop’s page when self-reset is off; no sign-up while it is off; Remember me hidden when roles always remember', async () => {
		const host = place('sign_in');
		await start(
			{},
			{
				features: ['phone_password'],
				settings: {
					phonePassword: { ...PHONE_RULES, signUp: false, selfReset: 'off', forgotUrl: 'https://wa.me/447700900567' },
					remember: 'always',
				},
			},
		);
		const root = shadow(host);
		expect(root.querySelector('a.link')?.getAttribute('href')).toBe('https://wa.me/447700900567');
		expect(hasButton(root, strings['signIn.forgot'])).toBe(false);
		expect(hasButton(root, strings['signIn.toSignUp'])).toBe(false);
		expect(checkIn(root, strings['signIn.remember']).closest('label')?.hidden).toBe(true);
	});

	it('Remember me is hidden and unchecked when the role never remembers (A14): the sign-in sends remember: false', async () => {
		const host = place('sign_in');
		const { server } = await start(
			{ 'POST /v1/sign-in/password': () => answer(200, signedIn({ remember: false })) },
			{ features: ['email_password'], settings: { remember: 'never' } },
		);
		const root = shadow(host);
		const box = checkIn(root, strings['signIn.remember']);
		expect(box.closest('label')?.hidden).toBe(true);
		expect(box.checked).toBe(false);
		fieldIn(root, strings['fields.email']).value = 'ana@example.com';
		fieldIn(root, strings['fields.password']).value = 'secret-pass';
		await submit(buttonIn(root, strings['signIn.submit']));
		expect(server.last('POST /v1/sign-in/password')?.body).toMatchObject({ remember: false });
		// kept only until the browser closes
		expect(window.sessionStorage.getItem(REFRESH_STORAGE_KEY)).toBe('ref-1');
		expect(window.localStorage.getItem(REFRESH_STORAGE_KEY)).toBeNull();
	});

	it('a paused sign-in shows its text instead of the forms', async () => {
		const host = place('sign_in');
		await start({}, { features: ['email_password', 'phone_code'], settings: { signInPaused: true } });
		const root = shadow(host);
		expect(root.textContent).toContain(strings['signIn.paused']);
		expect(root.querySelector('form')).toBeNull();
	});

	it('a code from staff is typed without asking for a new one', async () => {
		const host = place('sign_in');
		const { server } = await start({ 'POST /v1/sign-in/phone': () => answer(200, signedIn()) }, { features: ['phone_code'] });
		const root = shadow(host);
		await click(buttonIn(root, strings['code.have']));
		expect(root.querySelector('form')?.textContent).not.toContain(strings['code.code']);
		fieldIn(root, strings['fields.phone']).value = '+447700900567';
		await click(buttonIn(root, strings['code.have']));
		fieldIn(root, strings['code.code']).value = '654321';
		await submit(buttonIn(root, strings['code.submit']));
		expect(server.calls.some((c) => c.path === '/v1/sign-in/phone/code')).toBe(false);
		expect(server.last('POST /v1/sign-in/phone')?.body).toMatchObject({ phone: '+447700900567', code: '654321' });
	});

	it('a setup link (?ss_setup=) sets the password and signs in; the code leaves the address bar', async () => {
		const host = place('sign_in');
		const { server } = await start(
			{
				'POST /v1/setup-links/accept': ({ body }) =>
					body.password === 'short'
						? problem(422, 'weak_password', { rule: 'too_short', minLength: 8 })
						: answer(200, signedIn()),
			},
			{ features: ['phone_password'], settings: { phonePassword: PHONE_RULES }, page: '/account?ss_setup=cod_1.secret&x=1' },
		);
		expect(window.location.search).toBe('?x=1');
		const root = shadow(host);
		expect(heading(host)).toBe(strings['setup.title']);
		fieldIn(root, strings['fields.password']).value = 'short';
		await submit(buttonIn(root, strings['setup.submit']));
		expect(statusIn(root)).toBe('Use at least 8 characters.');
		fieldIn(root, strings['fields.password']).value = 'long enough';
		await submit(buttonIn(root, strings['setup.submit']));
		expect(server.last('POST /v1/setup-links/accept')?.body).toMatchObject({ code: 'cod_1.secret', password: 'long enough' });
		expect(heading(host)).toBe(strings['signedIn.title']);
		// the lookup could not be read (404 here): the form worked as it is
		expect(server.last('POST /v1/setup-links/lookup')?.body).toEqual({ code: 'cod_1.secret' });
	});

	it('a setup link greets the person by name, or says at once why it no longer works (P4)', async () => {
		const host = place('sign_in');
		await start(
			{
				'POST /v1/setup-links/lookup': () =>
					answer(200, { status: 'valid', name: 'Nia Lane', phoneLast4: '0222', expiresAt: at(86_400_000) }),
			},
			{ features: ['phone_password'], settings: { phonePassword: PHONE_RULES }, page: '/account?ss_setup=cod_1.secret' },
		);
		expect(shadow(host).textContent).toContain('Hi Nia Lane! Finish setting up your account: choose a password.');
		expect(shadow(host).textContent).toContain('For the phone number ending in 0222.');
		host.remove();
		vi.restoreAllMocks();

		for (const status of /** @type {const} */ (['expired', 'used', 'canceled', 'invalid'])) {
			const ended = place('sign_in');
			await start(
				{ 'POST /v1/setup-links/lookup': () => answer(200, { status }) },
				{ features: ['phone_password'], settings: { phonePassword: PHONE_RULES }, page: '/account?ss_setup=cod_2.secret' },
			);
			expect(heading(ended)).toBe(strings['setup.endedTitle']);
			expect(shadow(ended).textContent).toContain(strings[`setup.${status}`]);
			expect(shadow(ended).querySelector('form')).toBeNull();
			await click(buttonIn(shadow(ended), strings['setup.toSignIn']));
			expect(heading(ended)).toBe(strings['signIn.title']);
			ended.remove();
			vi.restoreAllMocks();
		}

		// a valid link of a person without a name or a phone keeps the plain words
		const plain = place('sign_in');
		await start(
			{ 'POST /v1/setup-links/lookup': () => answer(200, { status: 'valid', name: '', phoneLast4: null, expiresAt: at(0) }) },
			{ features: ['phone_password'], settings: { phonePassword: PHONE_RULES }, page: '/account?ss_setup=cod_3.secret' },
		);
		expect(shadow(plain).textContent).toContain(strings['setup.help']);
		expect(shadow(plain).textContent).not.toContain('ending in');
		plain.remove();
		vi.restoreAllMocks();

		// the lookup answers after the person already sent the password: the form is left alone
		/** @type {(value: Response) => void} */
		let release = () => {};
		const late = place('sign_in');
		const { server } = await start(
			{
				'POST /v1/setup-links/lookup': () => new Promise((resolve) => (release = resolve)),
				'POST /v1/setup-links/accept': () => problem(422, 'code_invalid'),
			},
			{ features: ['phone_password'], settings: { phonePassword: PHONE_RULES }, page: '/account?ss_setup=cod_4.secret' },
		);
		fieldIn(shadow(late), strings['fields.password']).value = 'long enough';
		await submit(buttonIn(shadow(late), strings['setup.submit']));
		release(answer(200, { status: 'used' }));
		await flush();
		expect(heading(late)).toBe(strings['setup.title']);
		expect(statusIn(shadow(late))).toBe(strings['error.code_invalid']);
		expect(server.last('POST /v1/setup-links/accept')?.body).toMatchObject({ code: 'cod_4.secret' });
	});

	it('the role request widget sends a visitor’s request, even with no sign-in method on', async () => {
		const host = place('role_request');
		const { server } = await start(
			{
				'POST /v1/role-requests': ({ body }) =>
					body.name === ''
						? problem(422, 'validation_failed', { errors: [{ path: '/name', message: 'Write your name.' }] })
						: answer(201, { outcome: 'requested' }),
			},
			{
				features: ['role_requests'],
				settings: {
					roleRequests: {
						roles: [
							{ key: 'member', name: 'Member' },
							{ key: 'wholesale', name: 'Wholesale' },
						],
						requireNote: true,
					},
				},
			},
		);
		const root = shadow(host);
		expect(heading(host)).toBe(strings['request.title']);
		fieldIn(root, strings['request.role']).value = 'wholesale';
		await submit(buttonIn(root, strings['request.submit']));
		expect(statusIn(root)).toBe(strings['error.field.name']);
		fieldIn(root, strings['fields.name']).value = 'Nia';
		fieldIn(root, strings['fields.phone']).value = '07700 900222';
		fieldIn(root, strings['request.note']).value = 'Shop owner';
		await submit(buttonIn(root, strings['request.submit']));
		expect(server.last('POST /v1/role-requests')?.body).toEqual({
			role: 'wholesale',
			name: 'Nia',
			phone: '07700 900222',
			note: 'Shop owner',
		});
		// private by default: the one text that fits a new request, a repeat and a member alike
		expect(root.textContent).toContain(strings[PRIVATE_OUTCOME]);
	});

	it('the role request widget shows one text for every ask while revealStatus is off', async () => {
		for (const outcome of Object.keys(REQUEST_OUTCOMES)) {
			const host = place('role_request');
			await start(
				{ 'POST /v1/role-requests': () => answer(201, { outcome }) },
				{
					features: ['role_requests'],
					settings: {
						roleRequests: { roles: [{ key: 'member', name: 'Member' }], requireNote: false, revealStatus: false },
					},
				},
			);
			const root = shadow(host);
			fieldIn(root, strings['fields.name']).value = 'Nia';
			fieldIn(root, strings['fields.phone']).value = '07700 900222';
			await submit(buttonIn(root, strings['request.submit']));
			expect(root.textContent).toContain(strings[PRIVATE_OUTCOME]);
			// never the words of what a repeat found
			for (const key of Object.values(REQUEST_OUTCOMES).filter((each) => each !== 'request.sent'))
				expect(root.textContent).not.toContain(strings[key]);
			host.remove();
			vi.restoreAllMocks();
		}
		expect(PRIVATE_OUTCOME).toBe('request.received');
	});

	it('the role request widget words what a repeat ask found with revealStatus on (P4)', async () => {
		for (const [outcome, key] of Object.entries(REQUEST_OUTCOMES)) {
			const host = place('role_request');
			await start(
				{ 'POST /v1/role-requests': () => answer(201, { outcome }) },
				{
					features: ['role_requests'],
					settings: { roleRequests: { roles: [{ key: 'member', name: 'Member' }], requireNote: false, revealStatus: true } },
				},
			);
			const root = shadow(host);
			fieldIn(root, strings['fields.name']).value = 'Nia';
			fieldIn(root, strings['fields.phone']).value = '07700 900222';
			await submit(buttonIn(root, strings['request.submit']));
			expect(root.textContent).toContain(strings[key]);
			host.remove();
			vi.restoreAllMocks();
		}
		expect(Object.keys(REQUEST_OUTCOMES)).toEqual([
			'requested',
			'already_requested',
			'already_invited',
			'invite_expired',
			'already_member',
		]);
		// an answer the widget does not know reads as a new request
		const host = place('role_request');
		await start(
			{ 'POST /v1/role-requests': () => answer(201, { outcome: 'constructor' }) },
			{
				features: ['role_requests'],
				settings: { roleRequests: { roles: [{ key: 'member', name: 'Member' }], requireNote: false, revealStatus: true } },
			},
		);
		fieldIn(shadow(host), strings['fields.name']).value = 'Nia';
		fieldIn(shadow(host), strings['fields.phone']).value = '07700 900222';
		await submit(buttonIn(shadow(host), strings['request.submit']));
		expect(shadow(host).textContent).toContain(strings['request.sent']);
	});

	it('My account: area, the default address, the Profile limits, Member since and a phone user’s password', async () => {
		window.sessionStorage.setItem(REFRESH_STORAGE_KEY, 'ref-0');
		const host = place('my_account');
		const me = {
			...USER,
			email: null,
			phone: '+447700900567',
			hasPassword: false,
			role: 'member',
			roleName: 'Member',
			roleSince: at(0),
			addresses: [
				{ id: 'adr_000001', label: 'Home', line1: '1 Main St', area: 'Camden', city: 'London', default: true },
				{ id: 'adr_000002', label: 'Work', line1: '9 High St', area: '', city: 'London', default: false },
			],
		};
		/** @type {any[]} */
		const patches = [];
		const { server } = await start(
			{
				'POST /v1/session/refresh': () => answer(200, signedIn({ user: me })),
				'GET /v1/me': () => answer(200, me),
				'GET /v1/me/sessions': () => answer(200, { items: [] }),
				'PATCH /v1/me': ({ body }) => {
					patches.push(body);
					return answer(200, { ...me, ...body });
				},
				'PUT /v1/me/password': () => answer(204),
			},
			{
				features: ['phone_password'],
				settings: { profile: { maxAddresses: 2, keepOneAddress: true, addressRequired: ['line1', 'area'] } },
			},
		);
		const profile = part(host, strings['account.profile']);
		expect(profile.textContent).toContain(`Member since ${when(at(0), 'date')}`);
		const addresses = part(host, strings['account.addresses']);
		expect(addresses.querySelector('li')?.textContent).toContain('Camden');
		expect(addresses.querySelector('li .tag')?.textContent).toBe(strings['account.defaultAddress']);
		expect(hasButton(addresses, strings['account.addressAdd'])).toBe(true);
		expect(
			/** @type {HTMLElement} */ (
				[...addresses.querySelectorAll('button')].find((b) => b.textContent === strings['account.addressAdd'])
			).hidden,
		).toBe(true);
		await click(buttonIn(/** @type {HTMLElement} */ (addresses.querySelectorAll('li')[1]), strings['account.makeDefault']));
		expect(patches.at(-1).addresses.map((/** @type {any} */ a) => a.default)).toEqual([false, true]);
		await click(buttonIn(/** @type {HTMLElement} */ (addresses.querySelectorAll('li')[0]), strings['account.edit']));
		expect(fieldIn(addresses, strings['address.area']).required).toBe(true);
		expect(fieldIn(addresses, strings['address.city']).required).toBe(false);
		checkIn(addresses, strings['address.default']).checked = true;
		await submit(buttonIn(addresses, strings['account.addressSave']));
		expect(patches.at(-1).addresses.map((/** @type {any} */ a) => a.default)).toEqual([true, false]);
		// one address left: it stays
		await click(buttonIn(/** @type {HTMLElement} */ (addresses.querySelectorAll('li')[1]), strings['account.remove']));
		expect(hasButton(/** @type {HTMLElement} */ (addresses.querySelector('li')), strings['account.remove'])).toBe(false);
		const password = part(host, strings['account.password']);
		fieldIn(password, strings['account.newPassword']).value = 'phone pass 1';
		await submit(buttonIn(password, strings['account.passwordSet']));
		expect(server.last('PUT /v1/me/password')?.body).toEqual({ password: 'phone pass 1' });
	});
});

describe('helpers', () => {
	it('every text a widget names after a code exists, so no text key ever shows (PLAN 0.4.10)', () => {
		const keys = [
			// sessions are signed in by a method, a setup link or an invite (My account's devices)
			...[...ROLE_METHODS, 'setup_link', 'invite'].map((method) => `method.${method}`),
			...['google', 'apple', 'facebook'].map((provider) => `social.${provider}`),
			...['active', 'pending', 'invited', 'blocked'].map((status) => `status.${status}`),
			...['pending', 'invited', 'completed', 'declined', 'expired'].map((status) => `requests.${status}`),
			...['expired', 'used', 'canceled', 'invalid'].map((status) => `setup.${status}`),
			...Object.values(REQUEST_OUTCOMES),
			...Object.keys(ADDRESS_LIMITS).map((field) => `address.${field}`),
			...[...OWN_TEXT, 'generic', 'locked', 'validation_failed', 'weak_password'].map((code) => `error.${code}`),
			...[...FIELD_TEXT].map((field) => `error.field.${field}`),
			...[...PASSWORD_RULES].map((rule) => `error.weak_password.${rule}`),
		];
		expect(keys.filter((key) => !Object.hasOwn(strings, key))).toEqual([]);
	});

	it('read problem codes, addresses and dates defensively', () => {
		const t = textsOf({ texts: TEXTS });
		expect(problemCode(null)).toBe('');
		expect(problemCode({ type: 'https://x/problems/locked' })).toBe('locked');
		expect(errorText(t, { ok: false, status: 0, data: null }, when)).toBe(strings['error.generic']);
		// a password refusal without a known rule, and a refused form naming no field with a text of its own
		expect(errorText(t, { ok: false, status: 422, data: { type: '/problems/weak_password', rule: 'odd' } }, when)).toBe(
			strings['error.weak_password'],
		);
		expect(
			errorText(t, { ok: false, status: 422, data: { type: '/problems/validation_failed', errors: [{ path: '' }] } }, when),
		).toBe(strings['error.validation_failed']);
		expect(
			errorText(
				t,
				{ ok: false, status: 422, data: { type: '/problems/weak_password', rule: 'too_long', maxLength: 128 } },
				when,
			),
		).toBe('Use at most 128 characters.');
		// a lock without a real end time says to try again later
		expect(errorText(t, { ok: false, status: 423, data: { type: '/problems/locked', lockedUntil: 'soon' } }, when)).toBe(
			strings['error.rate_limited'],
		);
		expect(textsOf({ texts: {} })('missing.key')).toBe('missing.key');
		expect(webAddress('not a url')).toBeNull();
		expect(webAddress('ftp://example.com/x')).toBeNull();
		expect(webAddress('https://example.com/x')).toBe('https://example.com/x');
		expect(when('never')).toBe('');
		expect(when({})).toBe('');
		expect(moneyText(PLAIN_LOOKS, window, 125000, 'EUR')).toBe('EUR 1,250.00');
		expect(moneyText(PLAIN_LOOKS, window, '125000', 'EUR')).toBeNull();
		expect(moneyText(PLAIN_LOOKS, window, 125000, 'euros')).toBeNull();
		expect(moneyText(PLAIN_LOOKS, window, 125000, undefined)).toBeNull();
	});

	it('show dates and money in the Format and business time zone of the widget config', () => {
		/** @type {import('../ui/common.js').Looks} */
		const tokyo = {
			format: { locale: 'en-GB', currencyDisplay: 'custom', currencySymbol: 'US$', wholeUnits: true, times: 'business' },
			timeZone: 'Asia/Tokyo',
		};
		const dates = datesOf(tokyo, window);
		expect(dates('2026-10-01T22:30:00Z')).toBe('2 Oct 2026, 07:30');
		expect(dates(Date.parse('2026-10-01T22:30:00Z'), 'date')).toBe('2 Oct 2026');
		expect(moneyText(tokyo, window, 1250000, 'USD')).toBe('US$ 12,500');
		// no time zone in the config: UTC
		expect(datesOf({ format: tokyo.format }, null)('2026-10-01T22:30:00Z')).toBe('1 Oct 2026, 22:30');
	});
});

/** @param {string} time */
const formatDeletion = (time) => `Asked to be deleted on ${when(time)}.`;
