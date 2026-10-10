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
import { datesOf, errorText, moneyText, problemCode, textsOf, webAddress } from '../ui/common.js';
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
 * @param {{ features?: string[], settings?: Settings, hash?: string }} [options]
 */
const start = async (routes, { features = ['email_password'], settings = {}, hash = '' } = {}) => {
	window.history.replaceState(null, '', `${PAGE}${hash ? `#${hash}` : ''}`);
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

describe('e-mail and password', () => {
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
			problem(422, 'weak_password', { detail: 'Use at least 10 characters.' }),
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
		expect(statusIn(root)).toBe('Use at least 10 characters.');
		await submit(send);
		expect(statusIn(root)).toBe('Size is required.');
		await submit(send);
		expect(statusIn(root)).toBe(strings['error.generic']);
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

	it('e-mail code: sends the code with the page to return to; Back and the tabs switch the form', async () => {
		const host = place('sign_in');
		const { server } = await start(
			{
				'POST /v1/sign-in/email/code': ({ body }) =>
					body.email === 'bad'
						? problem(422, 'validation_failed', { errors: [{ path: '/email', message: 'Enter a valid e-mail address.' }] })
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
		expect(statusIn(root)).toBe('Enter a valid e-mail address.');
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
			'E-mail: ana@example.com',
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
		expect(statusIn(profile)).toBe('Too long.');

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
		const passwords = [problem(422, 'weak_password', { detail: 'Too short.' }), answer(204)];
		const { host, server } = await open({
			'POST /v1/me/terms': () => answer(200, { ...ME, terms: { version: 'v2', acceptedAt: at(0) } }),
			'PUT /v1/me/password': () => /** @type {Response} */ (passwords.shift()),
			'POST /v1/me/two-step/setup': () => answer(200, { challenge: 'su1', secret: 'SECRET', otpauthUrl: 'otpauth://totp/x' }),
			'POST /v1/me/two-step/enable': ({ body }) =>
				body.code === '000000' ? problem(400, 'code_invalid') : answer(200, { recoveryCodes: ['r-1', 'r-2'] }),
			'POST /v1/me/two-step/disable': () => answer(204),
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
		expect(statusIn(password)).toBe('Too short.');
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
							totalText: 'PKR 1,250.00',
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
		expect(rows[1]?.querySelector('.meta')?.textContent).toBe('Being packed · PKR 1,250.00');
		expect(rows[2]?.querySelector('.meta')?.textContent).toBe('');
	});

	it('shows dates and order totals in the Format and business time zone of the widget config', async () => {
		looks = {
			format: { locale: 'en-GB', currencyDisplay: 'custom', currencySymbol: 'Rs', wholeUnits: true, times: 'business' },
			timeZone: 'Asia/Karachi',
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
							totalText: 'PKR 12,500.00',
							currency: 'PKR',
							createdAt: '2026-10-01T22:30:00Z',
						},
					],
				}),
		});
		// 10:01 UTC is 15:01 in Karachi; 22:30 UTC is already the next day there
		const devices = part(host, strings['account.devices']);
		expect(devices.querySelector('.meta')?.textContent).toBe('Signed in with Password · Last used 1 Oct 2026, 15:01');
		const orders = part(host, strings['account.orders']);
		expect(orders.querySelector('.meta')?.textContent).toBe('paid · Rs 12,500 · 2 Oct 2026, 03:30');
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
		expect(statusIn(again)).toBe(strings['error.generic']);
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

	it('Users admin lists, searches, pages, blocks, approves, invites and signs out', async () => {
		const host = place('users_admin');
		const ana = {
			...USER,
			role: 'customer',
			notes: '',
			blocked: null,
			status: 'pending',
			lastSignInAt: at(0),
			deletion: { requestedAt: at(0), dueAt: null },
		};
		const bo = {
			...USER,
			id: 'usr_2',
			name: '',
			email: null,
			phone: '+15550002222',
			role: 'helper',
			notes: 'VIP',
			blocked: { at: at(0), reason: 'spam' },
			status: 'active',
			lastSignInAt: null,
		};
		/** @type {URL[]} */
		const asked = [];
		const { server } = await startAdmin({
			'GET /v1/admin/roles': () => answer(200, { items: ROLES }),
			'GET /v1/admin/users': ({ url }) => {
				asked.push(url);
				if (url.searchParams.get('q') === 'none') return answer(200, { items: [], nextCursor: null, hasMore: false });
				if (url.searchParams.get('q') === 'boom') return problem(500, 'internal');
				return url.searchParams.get('cursor')
					? answer(200, { items: [bo], nextCursor: null, hasMore: false })
					: answer(200, { items: [ana], nextCursor: 'c1', hasMore: true });
			},
			'PATCH /v1/admin/users/usr_1': ({ body }) => answer(200, { ...ana, ...body }),
			'POST /v1/admin/users/usr_1/approve': () => answer(200, { ...ana, status: 'active' }),
			'POST /v1/admin/users/usr_1/decline': () => problem(409, 'conflict'),
			'POST /v1/admin/users/usr_1/sign-out': () => answer(204),
			'POST /v1/admin/users/usr_1/deletion/approve': () => answer(200, {}),
			'POST /v1/admin/users/invite': ({ body }) =>
				body.email === 'taken@example.com' ? problem(409, 'already_exists') : answer(201, {}),
		});
		const root = shadow(host);
		expect(server.calls.find((c) => c.path === '/v1/admin/users')?.headers.authorization).toBe('Bearer ticket-1');
		const first = /** @type {HTMLElement} */ (root.querySelector('li'));
		expect(first.firstChild?.textContent).toBe('Ana');
		expect(first.querySelector('.meta')?.textContent).toBe(
			`ana@example.com · Customer · ${strings['status.pending']} · ${strings['users.deletionAsked']} · Last sign-in ${when(at(0))}`,
		);
		await click(buttonIn(root, strings['users.more']));
		expect(asked.at(-1)?.searchParams.get('cursor')).toBe('c1');
		const second = root.querySelectorAll('ul > li')[1];
		expect(second?.firstChild?.textContent).toBe('+15550002222');
		expect(second?.querySelector('.meta')?.textContent).toBe(`Helper · ${strings['status.blocked']}`);

		// filters
		fieldIn(root, strings['users.search']).value = 'none';
		fieldIn(root, strings['users.role']).value = 'helper';
		fieldIn(root, strings['users.status']).value = 'pending';
		checkIn(root, strings['users.deletionOnly']).checked = true;
		await submit(buttonIn(root, strings['users.searchButton']));
		expect(Object.fromEntries(asked.at(-1)?.searchParams ?? [])).toEqual({
			limit: '25',
			q: 'none',
			role: 'helper',
			status: 'pending',
			deletion: '1',
		});
		expect(statusIn(root)).toBe(strings['users.empty']);
		fieldIn(root, strings['users.search']).value = 'boom';
		await submit(buttonIn(root, strings['users.searchButton']));
		expect(statusIn(root)).toBe(strings['error.generic']);
		fieldIn(root, strings['users.search']).value = '';
		fieldIn(root, strings['users.role']).value = '';
		fieldIn(root, strings['users.status']).value = '';
		checkIn(root, strings['users.deletionOnly']).checked = false;
		await submit(buttonIn(root, strings['users.searchButton']));

		// one user
		await click(buttonIn(root, strings['users.open']));
		const panel = /** @type {HTMLElement} */ (root.querySelector('section.part'));
		expect(fieldIn(panel, strings['users.role']).value).toBe('customer');
		expect(panel.textContent).toContain(formatDeletion(at(0)));
		fieldIn(panel, strings['users.role']).value = 'helper';
		fieldIn(panel, strings['users.notes']).value = 'Called';
		checkIn(panel, strings['users.blocked']).checked = true;
		fieldIn(panel, strings['users.blockedReason']).value = ' abuse ';
		await submit(buttonIn(panel, strings['users.save']));
		expect(server.last('PATCH /v1/admin/users/usr_1')?.body).toEqual({
			name: 'Ana',
			role: 'helper',
			notes: 'Called',
			blocked: true,
			blockedReason: 'abuse',
		});
		expect(statusIn(panel)).toBe(strings['users.saved']);
		await click(buttonIn(panel, strings['users.approve']));
		expect(statusIn(panel)).toBe(strings['users.approved']);
		await click(buttonIn(panel, strings['users.decline']));
		expect(statusIn(panel)).toBe(strings['error.generic']);
		await click(buttonIn(panel, strings['users.signOut']));
		expect(statusIn(panel)).toBe(strings['users.signedOutUser']);
		await click(buttonIn(panel, strings['users.deletionApprove']));
		expect(statusIn(panel)).toBe(strings['users.deletionApproved']);
		await click(buttonIn(panel, strings['users.close']));
		expect(root.querySelector('section.part:not(form)')).toBeNull();

		// invites
		const invite = /** @type {HTMLElement} */ (root.querySelector('form.part'));
		fieldIn(invite, strings['users.inviteContact']).value = 'taken@example.com';
		await submit(buttonIn(invite, strings['users.inviteSend']));
		expect(statusIn(invite)).toBe(strings['error.already_exists']);
		fieldIn(invite, strings['users.inviteContact']).value = '+15550003333';
		fieldIn(invite, strings['fields.name']).value = 'Cy';
		fieldIn(invite, strings['users.role']).value = 'helper';
		await submit(buttonIn(invite, strings['users.inviteSend']));
		expect(server.last('POST /v1/admin/users/invite')?.body).toEqual({ phone: '+15550003333', name: 'Cy', role: 'helper' });
		expect(statusIn(invite)).toBe('An invite was sent to +15550003333.');
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
			`customer · 0 permissions · ${strings['roles.readyMade']}`,
			`owner · ${strings['roles.allPermissions']} · ${strings['roles.readyMade']}`,
			'helper · 2 permissions',
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

		// edit a role: tick boxes per group; a permission of a product no longer listed stays visible
		await click(buttonIn(/** @type {HTMLElement} */ (rows[2]), strings['roles.edit']));
		expect(form.querySelector('h3')?.textContent).toBe('Editing Helper');
		const legends = [...form.querySelectorAll('legend')].map((l) => l.textContent);
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
		expect(statusIn(form)).toBe('Session length is 1 to 720 hours.');
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
		expect(() => checkIn(shadow(users), strings['users.deletionOnly'])).toThrow();
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
			timeZone: 'Asia/Karachi',
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
		expect(root.querySelector('li .meta')?.textContent).toContain('Last sign-in 2 Oct 2026, 03:30');
		await click(buttonIn(root, strings['users.open']));
		expect(root.querySelector('section.part')?.textContent).toContain('Asked to be deleted on 1 Oct 2026, 15:00.');
	});

	it('Roles admin says when the roles cannot be loaded', async () => {
		const host = place('roles_admin');
		await startAdmin({
			'GET /v1/admin/roles': () => problem(403, 'forbidden'),
			'GET /v1/admin/roles/permissions': () => answer(200, {}),
		});
		expect(statusIn(shadow(host))).toBe(strings['error.generic']);
	});
});

describe('helpers', () => {
	it('read problem codes, addresses and dates defensively', () => {
		const t = textsOf({ texts: TEXTS });
		expect(problemCode(null)).toBe('');
		expect(problemCode({ type: 'https://x/problems/locked' })).toBe('locked');
		expect(errorText(t, { ok: false, status: 0, data: null }, when)).toBe(strings['error.generic']);
		expect(errorText(t, { ok: false, status: 400, data: { type: '/problems/weak_password' } }, when)).toBe(
			strings['error.generic'],
		);
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
		expect(moneyText(PLAIN_LOOKS, window, 125000, 'PKR')).toBe('PKR 1,250.00');
		expect(moneyText(PLAIN_LOOKS, window, '125000', 'PKR')).toBeNull();
		expect(moneyText(PLAIN_LOOKS, window, 125000, 'rupees')).toBeNull();
		expect(moneyText(PLAIN_LOOKS, window, 125000, undefined)).toBeNull();
	});

	it('show dates and money in the Format and business time zone of the widget config', () => {
		/** @type {import('../ui/common.js').Looks} */
		const karachi = {
			format: { locale: 'en-GB', currencyDisplay: 'custom', currencySymbol: 'Rs', wholeUnits: true, times: 'business' },
			timeZone: 'Asia/Karachi',
		};
		const dates = datesOf(karachi, window);
		expect(dates('2026-10-01T22:30:00Z')).toBe('2 Oct 2026, 03:30');
		expect(dates(Date.parse('2026-10-01T22:30:00Z'), 'date')).toBe('2 Oct 2026');
		expect(moneyText(karachi, window, 1250000, 'PKR')).toBe('Rs 12,500');
		// no time zone in the config: UTC
		expect(datesOf({ format: karachi.format }, null)('2026-10-01T22:30:00Z')).toBe('1 Oct 2026, 22:30');
	});
});

/** @param {string} time */
const formatDeletion = (time) => `Asked to be deleted on ${when(time)}.`;
