// @vitest-environment jsdom
/* global document, window */
/**
 * The redirects admin widget (SEO audit G9) with the real page script: the rules with counts, search, filter and Load
 * more; the rule dialog (add, change, delete); suggestions from the 404 log; the CSV import's check and import; the
 * export; refusals in the widget's own words.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import strings from '../strings/en.json' with { type: 'json' };
import { widgetSettings } from '../core/config.js';
import { CODES, MATCHES } from '../core/redirects.js';
import { WIDGET_ATTRIBUTE, WIDGET_GLOBAL } from '../core/widgets.js';
import { REDIRECT_PROBLEMS, mountRedirects } from '../ui/redirects.js';
import { ADMIN_CONFIG_PATH, startWidget } from '../ui/widget.js';

const BASE = 'https://growth.example.dev';
const T = /** @type {Record<string, string>} */ (strings);

/** @param {string[]} features */
const configOf = (features) => ({
	texts: { ...strings },
	theme: { mode: /** @type {const} */ ('light') },
	customCss: '',
	format: {
		locale: 'en-US',
		currencyDisplay: /** @type {const} */ ('code'),
		currencySymbol: '',
		wholeUnits: false,
		times: /** @type {const} */ ('business'),
	},
	timeZone: 'UTC',
	features,
	settings: widgetSettings({ on: features, values: {}, now: Date.parse('2026-10-08T12:00:00Z') }),
});

/** @param {number} status @param {unknown} [body] */
const answer = (status, body = {}) =>
	new Response(status === 204 ? null : JSON.stringify(body), {
		status,
		headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
	});

/** @param {string} code @param {number} status @param {Record<string, unknown>} [more] */
const refusal = (code, status, more = {}) => answer(status, { type: `https://errors.example.dev/${code}`, ...more });

/** @type {Array<{ method: string, path: string, body: any }>} */
let requests = [];

/**
 * `window.fetch` answering by method and path; every request is kept (with its query string and JSON body).
 * @param {Record<string, (init: any, url: URL) => Response | Promise<Response>>} routes
 */
const serve = (routes) =>
	vi.spyOn(window, 'fetch').mockImplementation(async (input, init) => {
		const url = new URL(String(input));
		const method = init?.method ?? 'GET';
		requests.push({ method, path: `${url.pathname}${url.search}`, body: init?.body ? JSON.parse(String(init.body)) : null });
		const route = routes[`${method} ${url.pathname}`];
		return route ? route(init, url) : answer(404);
	});

const flush = async () => {
	for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const RULES = [
	{
		id: 'rdr_2',
		from: '/b',
		match: 'prefix',
		to: '/new-b',
		code: 308,
		note: 'Section moved',
		createdAt: '2026-10-02T09:00:00.000Z',
		updatedAt: '2026-10-03T09:30:00.000Z',
	},
	{
		id: 'rdr_1',
		from: '/a',
		match: 'exact',
		to: '/new-a',
		code: 301,
		note: '',
		createdAt: '2026-10-01T09:00:00.000Z',
		updatedAt: '2026-10-01T09:00:00.000Z',
	},
];
const GONE = { ...RULES[1], id: 'rdr_3', from: '/gone', to: null, code: 410 };

/** The routes of a website with three rules and two suggestions. */
const ROUTES = {
	'GET /v1/admin/redirects': (/** @type {any} */ _init, /** @type {URL} */ url) => {
		if (url.searchParams.get('q') === 'nothing') return answer(200, { items: [], nextCursor: null, hasMore: false });
		if (url.searchParams.get('code') === '410') return answer(200, { items: [GONE], nextCursor: null, hasMore: false });
		if (url.searchParams.get('cursor')) return answer(200, { items: [GONE], nextCursor: null, hasMore: false });
		return answer(200, { items: RULES, nextCursor: 'next', hasMore: true });
	},
	'GET /v1/admin/redirects/counts': (/** @type {any} */ _init, /** @type {URL} */ url) =>
		answer(200, url.searchParams.get('q') ? { total: 0, groups: {} } : { total: 3, groups: { 301: 1, 308: 1, 410: 1 } }),
	'GET /v1/admin/redirects/suggestions': () =>
		answer(200, {
			from: '2026-07-11',
			to: '2026-10-08',
			recording: true,
			items: [
				{ path: '/old/blue-lamp', hits: 3, to: '/lamps/blue-lamp' },
				{ path: '/missing', hits: 1, to: null },
			],
		}),
};

/** @param {HTMLElement} host @param {string} selector */
const inside = (host, selector) => /** @type {any} */ (host.shadowRoot?.querySelector(selector));
/** @param {HTMLElement} host @param {string} selector */
const all = (host, selector) => /** @type {any[]} */ ([...(host.shadowRoot?.querySelectorAll(selector) ?? [])]);
/** @param {HTMLElement} host @param {string} text */
const button = (host, text) => /** @type {HTMLButtonElement} */ (all(host, 'button').find((b) => b.textContent === text));
/** @param {HTMLElement} host */
const dialog = (host) => /** @type {HTMLFormElement} */ (all(host, '.dialog').at(-1));
/** @param {HTMLElement} host */
const status = (host) => /** @type {HTMLElement} */ (inside(host, '.box p.status')).textContent;
/** @param {HTMLElement} host */
const submit = async (host) => {
	dialog(host).requestSubmit();
	await flush();
};
/** @param {HTMLElement} host @param {string} item */
const menu = async (host, item) => {
	inside(host, '.head .more > button').click();
	button(host, item).click();
	await flush();
};

/**
 * The widget mounted with the real page script's `admin()`.
 * @param {Record<string, (init: any, url: URL) => Response | Promise<Response>>} [routes]
 * @param {string[]} [features]
 * @param {{ download?: (name: string, text: string) => void, getTicket?: () => Promise<any> }} [options]
 */
const start = async (routes = {}, features = ['redirects', 'searches_404s'], options = {}) => {
	serve({ [`GET ${ADMIN_CONFIG_PATH}`]: () => answer(200, configOf(features)), ...ROUTES, ...routes });
	const host = document.createElement('div');
	host.setAttribute(WIDGET_ATTRIBUTE, 'redirects');
	document.body.append(host);
	const getTicket =
		options.getTicket ?? (async () => ({ ticket: 'ticket-1', expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() }));
	if (options.download) {
		const config = configOf(features);
		const api = {
			base: BASE,
			fetch: /** @type {typeof fetch} */ ((input, init) => window.fetch(input, init)),
			tickets: { current: () => 'ticket-1', onChange: () => () => true, stop: () => {} },
		};
		mountRedirects({ host, api, config, viewer: { locale: 'en-US', timeZone: 'UTC' }, download: options.download });
	} else {
		const script = document.createElement('script');
		script.src = `${BASE}/widget.js`;
		await startWidget({ window, script }).admin({ getTicket });
	}
	await flush();
	return host;
};

beforeEach(() => {
	requests = [];
});
afterEach(() => {
	document.body.replaceChildren();
	delete (/** @type {any} */ (window)[WIDGET_GLOBAL]);
	vi.restoreAllMocks();
});

describe('the redirects widget', () => {
	it('shows the rules newest first with counts, a search, a filter by answer and Load more', async () => {
		const host = await start();
		expect(inside(host, 'h2').textContent).toBe(T['redirects.title']);
		expect(inside(host, '.box .sub').textContent).toBe(T['redirects.sub']?.replace('{count}', '3'));
		const rows = all(host, 'section.box:first-child ul.rows li');
		expect(rows.map((row) => row.firstChild.textContent)).toEqual(['/b → /new-b', '/a → /new-a']);
		expect(rows[0].querySelector('.figure').textContent).toBe('308');
		expect(rows[0].querySelector('.meta').textContent).toBe(`${T['redirects.match.prefix']} · Section moved`);
		expect(all(host, '.chip').map((chip) => chip.textContent)).toEqual([
			`${T['redirects.all']}3`,
			`${T['redirects.code.301']}1`,
			`${T['redirects.code.308']}1`,
			`${T['redirects.code.410']}1`,
		]);
		button(host, T['redirects.loadMore'] ?? '').click();
		await flush();
		expect(all(host, 'section.box:first-child ul.rows li').map((row) => row.firstChild.textContent)).toEqual([
			'/b → /new-b',
			'/a → /new-a',
			`/gone · ${T['redirects.gone']}`,
		]);
		expect(requests.at(-1)?.path).toBe('/v1/admin/redirects?limit=50&cursor=next');
		expect(button(host, T['redirects.loadMore'] ?? '').hidden).toBe(true);

		all(host, '.chip').at(-1).click();
		await flush();
		expect(requests.some((r) => r.path === '/v1/admin/redirects?limit=50&code=410')).toBe(true);
		expect(all(host, 'section.box:first-child ul.rows li')).toHaveLength(1);

		const search = inside(host, 'input[type="search"]');
		search.value = ' nothing ';
		search.dispatchEvent(new window.Event('change'));
		await flush();
		expect(requests.some((r) => r.path === '/v1/admin/redirects/counts?by=code&q=nothing')).toBe(true);
		expect(inside(host, '.box .sub').textContent).toBe(T['redirects.found']?.replace('{count}', '0'));
		expect(inside(host, '.box ul.rows li.empty').textContent).toBe(T['redirects.noneFound']);
	});

	it('adds a rule from a suggestion and says why the server refused it, in the widget’s words', async () => {
		let posts = 0;
		const host = await start({
			'POST /v1/admin/redirects': (init) => {
				posts += 1;
				if (posts === 1)
					return refusal('redirect_chain', 409, { steps: ['/old/blue-lamp', '/lamps/blue-lamp', '/x'], gone: true });
				if (posts === 2) return refusal('redirect_taken', 409, { from: '/old/blue-lamp' });
				return answer(201, { ...RULES[1], ...JSON.parse(init.body) });
			},
		});
		const ideas = all(host, 'section.box:last-child ul.rows li');
		expect(ideas.map((idea) => idea.textContent)).toEqual([
			`/old/blue-lamp${T['redirects.suggestions.hits']?.replace('{count}', '3')}${T['redirects.suggestions.to']?.replace('{to}', '/lamps/blue-lamp')}`,
			`/missing${T['redirects.suggestions.hits']?.replace('{count}', '1')}`,
		]);
		ideas[0].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
		await flush();
		const form = dialog(host);
		expect(form.querySelector('h3')?.textContent).toBe(T['redirects.add']);
		const [from, to] = /** @type {HTMLInputElement[]} */ ([...form.querySelectorAll('input')]);
		expect([from?.value, to?.value]).toEqual(['/old/blue-lamp', '/lamps/blue-lamp']);
		await submit(host);
		expect(requests.find((r) => r.method === 'POST')?.body).toEqual({
			from: '/old/blue-lamp',
			match: 'exact',
			code: 301,
			to: '/lamps/blue-lamp',
			note: '',
		});
		expect(dialog(host).querySelector('.status')?.textContent).toBe(
			T['redirects.problem.gone']?.replace('{steps}', '/old/blue-lamp → /lamps/blue-lamp → /x'),
		);
		await submit(host);
		expect(dialog(host).querySelector('.status')?.textContent).toBe(
			T['redirects.problem.taken']?.replace('{from}', '/old/blue-lamp'),
		);
		const before = requests.length;
		await submit(host);
		expect(all(host, '.dialog')).toHaveLength(0);
		expect(status(host)).toBe(T['redirects.added']?.replace('{from}', '/old/blue-lamp'));
		// the list and the suggestions are read again
		expect(requests.slice(before).map((r) => r.path.split('?')[0])).toEqual(
			expect.arrayContaining(['/v1/admin/redirects', '/v1/admin/redirects/suggestions']),
		);
	});

	it('opens a new rule empty, and a suggestion without a target', async () => {
		const host = await start();
		button(host, T['redirects.add'] ?? '').click();
		await flush();
		expect([...dialog(host).querySelectorAll('input')].map((input) => input.value)).toEqual(['', '', '']);
		button(host, T['redirects.cancel'] ?? '').click();
		all(host, 'section.box:last-child ul.rows li')[1].click();
		await flush();
		expect([...dialog(host).querySelectorAll('input')].map((input) => input.value)).toEqual(['/missing', '', '']);
	});

	it('changes a rule, hiding the new page for 410, and deletes one after a confirmation', async () => {
		let deletes = 0;
		const host = await start({
			'PATCH /v1/admin/redirects/rdr_1': (init) => answer(200, { ...RULES[1], ...JSON.parse(init.body) }),
			'DELETE /v1/admin/redirects/rdr_2': () => {
				deletes += 1;
				return deletes === 1 ? refusal('redirect_chain', 409, { steps: ['/b/x', '/new-b/x', '/c'] }) : answer(204);
			},
		});
		const [first, second] = all(host, 'section.box:first-child ul.rows li');
		second.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a' }));
		expect(all(host, '.dialog')).toHaveLength(0);
		second.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ' }));
		await flush();
		const form = dialog(host);
		expect(form.querySelector('h3')?.textContent).toBe(T['redirects.edit']);
		expect(form.querySelector('.meta')?.textContent).toBe(
			T['redirects.times']?.replace('{created}', 'Oct 1, 2026, 9:00 AM').replace('{updated}', 'Oct 1, 2026, 9:00 AM'),
		);
		const code = /** @type {HTMLSelectElement} */ (form.querySelectorAll('select')[1]);
		code.value = '410';
		code.dispatchEvent(new window.Event('change'));
		const target = /** @type {HTMLElement} */ (
			[...form.querySelectorAll('label')].find((l) => l.textContent?.startsWith(T['redirects.field.to'] ?? ''))
		);
		expect(target.hidden).toBe(true);
		await submit(host);
		expect(requests.find((r) => r.method === 'PATCH')).toMatchObject({
			path: '/v1/admin/redirects/rdr_1',
			body: { from: '/a', match: 'exact', code: 410, to: null, note: '' },
		});
		expect(status(host)).toBe(T['redirects.saved']?.replace('{from}', '/a'));

		first.click();
		await flush();
		button(host, T['redirects.deleteRule'] ?? '').click();
		await flush();
		const confirm = dialog(host);
		expect(confirm.querySelector('h3')?.textContent).toBe(T['redirects.deleteTitle']);
		expect(confirm.querySelector('button[type="submit"]')?.classList.contains('danger')).toBe(true);
		await submit(host);
		expect(dialog(host).querySelector('.status')?.textContent).toBe(
			T['redirects.problem.chain']?.replace('{steps}', '/b/x → /new-b/x → /c'),
		);
		await submit(host);
		expect(all(host, '.dialog')).toHaveLength(0);
		expect(status(host)).toBe(T['redirects.deleted']?.replace('{from}', '/b'));
	});

	it('imports a CSV file: a check first, then the import of what it listed', async () => {
		const plan = {
			rows: 3,
			created: 1,
			updated: 1,
			unchanged: 1,
			changes: [
				{ line: 2, action: 'create', from: '/x', match: 'exact', to: '/y', code: 301, note: '', before: null },
				{
					line: 3,
					action: 'update',
					from: '/a',
					match: 'exact',
					to: null,
					code: 410,
					note: '',
					before: { match: 'exact', to: '/new-a', code: 301, note: '' },
				},
			],
			errors: [],
		};
		let real = 0;
		const host = await start({
			'POST /v1/admin/redirects/csv': (init) => {
				const body = JSON.parse(init.body);
				if (body.csv.includes('bad'))
					return answer(200, {
						...plan,
						dryRun: true,
						changes: [],
						errors: [
							{ line: 1, path: '', code: 'columns', message: 'x' },
							{ line: 2, path: '/to', code: 'chain', message: 'x', steps: ['/p', '/q', '/r'] },
							{ line: 3, path: '/from', code: 'something_new', message: 'x' },
						],
					});
				if (body.dryRun) return answer(200, { ...plan, dryRun: true });
				real += 1;
				return real === 1
					? refusal('validation_failed', 422, { errors: [{ path: '/csv/2/from' }] })
					: answer(200, { ...plan, dryRun: false });
			},
		});
		await menu(host, T['redirects.import.open'] ?? '');
		const form = dialog(host);
		const text = /** @type {HTMLTextAreaElement} */ (form.querySelector('textarea'));
		const run = /** @type {HTMLButtonElement} */ (form.querySelector('button[type="submit"]'));
		text.value = 'bad file';
		await submit(host);
		const problems = [...form.querySelectorAll('ul.checks li')].map((li) => li.textContent);
		expect(problems).toEqual([
			T['redirects.row.file.columns'],
			T['redirects.row.to.chain']?.replace('{line}', '2').replace('{steps}', '/p → /q → /r'),
			T['redirects.row.other']?.replace('{line}', '3'),
		]);
		expect(form.querySelector('.lead')?.textContent).toBe(T['redirects.import.nothing']);
		expect(run.textContent).toBe(T['redirects.import.check']);

		text.value = 'from,to\n/x,/y';
		text.dispatchEvent(new window.Event('input'));
		await submit(host);
		expect(form.querySelector('.status')?.textContent).toBe(T['redirects.import.checked']);
		expect([...form.querySelectorAll('ul.list li')].map((li) => li.textContent)).toEqual([
			`/x → /y${T['redirects.import.create']}`,
			`/a · ${T['redirects.gone']}${T['redirects.import.update']}`,
		]);
		expect(run.textContent).toBe(T['redirects.import.run']?.replace('{count}', '2'));
		// the rules changed since the check: check again
		await submit(host);
		expect(form.querySelector('.status')?.textContent).toBe(T['redirects.import.stale']);
		expect(run.textContent).toBe(T['redirects.import.check']);
		await submit(host);
		await submit(host);
		expect(requests.filter((r) => r.path === '/v1/admin/redirects/csv').map((r) => r.body.dryRun)).toEqual([
			true,
			true,
			false,
			true,
			false,
		]);
		expect(all(host, '.dialog')).toHaveLength(0);
		expect(status(host)).toBe(T['redirects.import.done']?.replace('{created}', '1').replace('{updated}', '1'));
	});

	it('reads a chosen file into the import, and lists at most 100 changes', async () => {
		const changes = Array.from({ length: 101 }, (_, i) => ({
			line: i + 2,
			action: 'create',
			from: `/p${i}`,
			match: 'exact',
			to: '/q',
			code: 301,
			note: '',
			before: null,
		}));
		const host = await start({
			'POST /v1/admin/redirects/csv': () =>
				answer(200, { dryRun: true, rows: 101, created: 101, updated: 0, unchanged: 0, changes, errors: [] }),
		});
		await menu(host, T['redirects.import.open'] ?? '');
		const form = dialog(host);
		const file = /** @type {HTMLInputElement} */ (form.querySelector('input[type="file"]'));
		file.dispatchEvent(new window.Event('change'));
		Object.defineProperty(file, 'files', { value: [new window.File(['from,to\n/p0,/q'], 'redirects.csv')] });
		file.dispatchEvent(new window.Event('change'));
		await flush();
		expect(/** @type {HTMLTextAreaElement} */ (form.querySelector('textarea')).value).toBe('from,to\n/p0,/q');
		await submit(host);
		expect(form.querySelectorAll('ul.list li')).toHaveLength(100);
		expect(form.querySelector('p.meta')?.textContent).toBe(T['redirects.import.more']?.replace('{count}', '1'));
	});

	it('exports the rules as a file', async () => {
		const download = vi.fn();
		let exports = 0;
		const host = await start(
			{
				'GET /v1/admin/redirects/csv': () => {
					exports += 1;
					if (exports === 1) return new Response('﻿from,match,to,code,note\r\n', { status: 200 });
					if (exports === 2) return refusal('forbidden', 403);
					throw new Error('offline');
				},
			},
			['redirects'],
			{ download },
		);
		await menu(host, T['redirects.export'] ?? '');
		expect(download).toHaveBeenCalledWith('redirects.csv', 'from,match,to,code,note\r\n');
		expect(status(host)).toBe(T['redirects.exported']);
		await menu(host, T['redirects.export'] ?? '');
		expect(status(host)).toBe(T['problem.forbidden']);
		await menu(host, T['redirects.export'] ?? '');
		expect(status(host)).toBe(T['redirects.failed']);
	});

	it('saves the export through a download link with the page script', async () => {
		const created = vi.fn(() => 'blob:redirects');
		const revoked = vi.fn();
		Object.assign(window.URL, { createObjectURL: created, revokeObjectURL: revoked });
		const clicked = vi.spyOn(window.HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
		const host = await start({ 'GET /v1/admin/redirects/csv': () => new Response('from\r\n', { status: 200 }) });
		await menu(host, T['redirects.export'] ?? '');
		expect(created).toHaveBeenCalledTimes(1);
		expect(clicked).toHaveBeenCalledTimes(1);
		expect(revoked).toHaveBeenCalledWith('blob:redirects');
		expect(document.querySelector('a[download]')).toBeNull();
	});

	it('says when 404s are not recorded, when nothing is missing, and when a call fails', async () => {
		const host = await start({
			'GET /v1/admin/redirects/suggestions': () =>
				answer(200, { from: '2026-07-11', to: '2026-10-08', recording: false, items: [] }),
			'GET /v1/admin/redirects': () => refusal('database_not_connected', 403),
		});
		expect(inside(host, 'section.box:last-child li.empty').textContent).toBe(T['redirects.suggestions.none']);
		expect(inside(host, 'section.box:last-child .status').textContent).toBe(T['redirects.suggestions.off']);
		expect(status(host)).toBe(T['problem.database_not_connected']);
		document.body.replaceChildren();
		const other = await start({ 'GET /v1/admin/redirects/suggestions': () => refusal('rate_limited', 429) });
		expect(inside(other, 'section.box:last-child .status').textContent).toBe(T['problem.rate_limited']);
		expect(all(other, 'section.box:first-child ul.rows li')).toHaveLength(2);
	});

	it('shows Signed out once the ticket cannot be renewed', async () => {
		let tickets = 0;
		const host = await start({}, ['redirects'], {
			getTicket: async () => {
				tickets += 1;
				if (tickets > 1) throw new Error('signed out');
				// renewed at once (a minute before it expires)
				return { ticket: 'ticket-1', expiresAt: new Date(Date.now() + 60_000).toISOString() };
			},
		});
		await flush();
		expect(status(host)).toBe(T['redirects.signedOut']);
		button(host, T['redirects.add'] ?? '').click();
		await flush();
		/** @type {HTMLInputElement} */ (dialog(host).querySelector('input')).value = '/a';
		await submit(host);
		expect(dialog(host).querySelector('.status')?.textContent).toBe(T['redirects.signedOut']);
		await menu(host, T['redirects.export'] ?? '');
		expect(status(host)).toBe(T['redirects.signedOut']);
	});

	it('mounts only while the feature is on', async () => {
		const host = await start({}, ['seo_checklist']);
		expect(host.shadowRoot).toBeNull();
	});
});

describe('widget texts (OT-3)', () => {
	it('has every text the widget names from a code value', () => {
		const keys = [
			...Object.values(REDIRECT_PROBLEMS),
			'redirects.problem.gone',
			...CODES.map((code) => `redirects.code.${code}`),
			...MATCHES.map((match) => `redirects.match.${match}`),
			...['create', 'update'].map((action) => `redirects.import.${action}`),
			...[
				'from.required',
				'from.not_path',
				'from.other_host',
				'from.query',
				'from.too_long',
				'from.twice',
				'match.not_match',
				'code.not_code',
				'to.required',
				'to.not_target',
				'to.not_https',
				'to.too_long',
				'to.gone',
				'to.loop',
				'to.chain',
				'to.removed',
				'note.too_long',
				'file.empty',
				'file.unterminated_quote',
				'file.too_many_rows',
				'file.columns',
				'file.too_many',
				'other',
			].map((row) => `redirects.row.${row}`),
		];
		expect(keys.filter((key) => !Object.hasOwn(strings, key))).toEqual([]);
	});
});
