/**
 * The Redirects feature through the API (SEO audit G9): rules made, changed and deleted with the server token or the
 * redirects widget's ticket, checked against the whole set (no loops, no chains, one rule per path, at most 5,000),
 * read by the website's server one address at a time or as a whole list with an ETag, imported and exported as CSV,
 * suggested from the 404 log, and written to the activity log.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_RULES } from '../core/redirects.js';
import { keepList } from '../server/redirects.js';
import { ADMIN_ORIGIN, ALL, setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

beforeAll(async () => {
	env = await setup();
	await env.switchOn(ALL);
	await env.connectDatabase();
});
afterAll(async () => {
	await env.close();
});

/**
 * A server-token call; its answer's JSON (null without one).
 * @param {string} method @param {string} path @param {{ body?: unknown, headers?: Record<string, string> }} [init]
 */
const server = async (method, path, init = {}) => {
	const response = await env.call(method, path, { token: env.server, ...init });
	const text = await response.text();
	return {
		status: response.status,
		headers: response.headers,
		text,
		json: /json/.test(response.headers.get('content-type') ?? '') ? JSON.parse(text) : null,
	};
};

/** @param {Record<string, unknown>} body */
const create = (body) => server('POST', '/v1/redirects', { body });

/** The version of the rules (the list's ETag without quotes). */
const version = async () =>
	(await (await env.merchantDb()).collection('ss_growth_redirect_versions').findOne({}))?.version ?? null;

/** @param {string} action */
const logged = async (action) =>
	(await env.merchantDb()).collection('ss_growth_activity').find({ action }).sort({ _id: 1 }).toArray();

/** @param {string} from */
const idOf = async (from) => String((await (await env.merchantDb()).collection('ss_growth_redirects').findOne({ from }))?.id);

describe('rules', () => {
	it('creates a rule from what staff type, normalized, and logs it', async () => {
		const made = await create({ from: 'https://www.shop.example.com/Old-Page/', to: '/new-page?ref=old', note: ' first ' });
		expect(made.status).toBe(201);
		expect(made.json).toMatchObject({
			from: '/Old-Page',
			match: 'exact',
			to: '/new-page?ref=old',
			code: 301,
			note: 'first',
			createdAt: '2026-10-01T10:00:00.000Z',
		});
		expect(made.json.id).toMatch(/^rdr_/);
		const [entry] = await logged('redirect.created');
		expect(entry).toMatchObject({
			target: made.json.id,
			label: '/Old-Page',
			detail: 'To /new-page?ref=old, 301, exact.',
			actor: { kind: 'server' },
		});
		expect(await version()).toMatch(/^rdv_/);
	});

	it('names every wrong field, refuses unknown members and a path that has a rule', async () => {
		const wrong = await create({ from: '/x?id=1', to: 'http://new.example.com', code: 302 });
		expect(wrong.status).toBe(422);
		expect(wrong.json.errors.map((/** @type {{ path: string }} */ error) => error.path)).toEqual(['/from', '/code', '/to']);
		expect((await create({ from: '/x', to: '/y', target: '/z' })).json.errors).toMatchObject([
			{ path: '/target', code: 'unknown' },
		]);
		expect((await server('POST', '/v1/redirects', { body: ['/x'] })).status).toBe(422);
		const taken = await create({ from: '/Old-Page/', to: '/other' });
		expect(taken.status).toBe(409);
		expect(taken.json).toMatchObject({ type: expect.stringMatching(/redirect_taken$/), from: '/Old-Page' });
		// one path in one Unicode form (NFC): /café typed composed or decomposed is one rule
		const composed = await create({ from: '/caf\u00e9', to: '/coffee' });
		expect(composed.json).toMatchObject({ from: '/caf%C3%A9' });
		const decomposed = await create({ from: '/cafe\u0301', to: '/tea' });
		expect(decomposed.status).toBe(409);
		expect(decomposed.json).toMatchObject({ type: expect.stringMatching(/redirect_taken$/), from: '/caf%C3%A9' });
		const asked = await server('GET', `/v1/redirects/match?path=${encodeURIComponent('/cafe\u0301?x=1')}`);
		expect(asked.json).toMatchObject({ from: '/caf%C3%A9', location: '/coffee?x=1' });
		expect((await server('DELETE', `/v1/redirects/${composed.json.id}`)).status).toBe(204);
	});

	it('refuses loops and chains, naming the addresses one request would pass', async () => {
		expect((await create({ from: '/a', to: '/b' })).status).toBe(201);
		const self = await create({ from: '/self', to: '/self/' });
		expect(self.json).toMatchObject({ type: expect.stringMatching(/redirect_loop$/), steps: ['/self', '/self'], gone: false });
		const loop = await create({ from: '/b', to: '/a' });
		expect(loop.status).toBe(409);
		expect(loop.json).toMatchObject({ type: expect.stringMatching(/redirect_loop$/), steps: ['/a', '/b', '/a'] });
		const chain = await create({ from: '/b', to: '/c' });
		expect(chain.json).toMatchObject({
			type: expect.stringMatching(/redirect_chain$/),
			steps: ['/a', '/b', '/c'],
			gone: false,
		});
		expect(chain.json.detail).toBe('This makes a redirect chain: /a → /b → /c. Point the first rule at the final page.');
		const gone = await create({ from: '/b', code: 410 });
		expect(gone.json).toMatchObject({ type: expect.stringMatching(/redirect_chain$/), steps: ['/a', '/b'], gone: true });
		const prefix = await create({ from: '/', match: 'prefix', to: '/home' });
		expect(prefix.json.type).toMatch(/redirect_loop$/);
	});

	it('changes a rule by merging what is sent; a change that changes nothing writes nothing', async () => {
		const id = await idOf('/a');
		const before = await version();
		const changed = await server('PATCH', `/v1/redirects/${id}`, { body: { to: '/c', note: 'moved' } });
		expect(changed.status).toBe(200);
		expect(changed.json).toMatchObject({ id, from: '/a', to: '/c', note: 'moved', code: 301 });
		expect(await version()).not.toBe(before);
		const [entry] = await logged('redirect.updated');
		expect(entry).toMatchObject({ target: id, label: '/a', detail: 'to /b → /c; note changed.' });

		const kept = await version();
		expect((await server('PATCH', `/v1/redirects/${id}`, { body: { to: '/c/' } })).json.to).toBe('/c');
		expect(await version()).toBe(kept);
		expect(await logged('redirect.updated')).toHaveLength(1);

		expect((await server('PATCH', `/v1/redirects/${id}`, { body: { code: 410 } })).json).toMatchObject({ to: null, code: 410 });
		expect((await server('PATCH', `/v1/redirects/${id}`, { body: { code: 308 } })).status).toBe(422);
		expect((await server('PATCH', `/v1/redirects/${id}`, { body: { from: '/Old-Page' } })).json.type).toMatch(
			/redirect_taken$/,
		);
		expect((await server('PATCH', `/v1/redirects/${id}`, { body: { to: '/x', from: '/a', code: 301 } })).status).toBe(200);
		expect((await server('PATCH', `/v1/redirects/${id}`, { body: { to: '/a' } })).json.type).toMatch(/redirect_loop$/);
		expect((await server('PATCH', '/v1/redirects/rdr_nothing', { body: { to: '/x' } })).status).toBe(404);
	});

	it('deletes a rule, unless the rules left would send a request through two rules', async () => {
		await create({ from: '/p', match: 'prefix', to: '/q' });
		await create({ from: '/p/x', to: '/r' });
		await create({ from: '/q/x', to: '/s' });
		const refused = await server('DELETE', `/v1/redirects/${await idOf('/p/x')}`);
		expect(refused.status).toBe(409);
		expect(refused.json).toMatchObject({ type: expect.stringMatching(/redirect_chain$/), steps: ['/p/x', '/q/x', '/s'] });
		expect((await server('DELETE', `/v1/redirects/${await idOf('/q/x')}`)).status).toBe(204);
		const id = await idOf('/p/x');
		expect((await server('DELETE', `/v1/redirects/${id}`)).status).toBe(204);
		expect((await server('DELETE', `/v1/redirects/${id}`)).status).toBe(404);
		expect((await logged('redirect.deleted')).map((entry) => entry.label)).toEqual(['/caf%C3%A9', '/q/x', '/p/x']);
	});

	it('lists the rules newest first, with counts, a search and a filter by answer', async () => {
		env.advance(1000);
		await create({ from: '/gone-page', code: 410, note: 'Discontinued' });
		env.advance(1000);
		await create({ from: '/form', to: '/contact', code: 308 });
		const first = await server('GET', '/v1/redirects?limit=2');
		expect(first.json.items.map((/** @type {{ from: string }} */ rule) => rule.from)).toEqual(['/form', '/gone-page']);
		expect(first.json.hasMore).toBe(true);
		const rest = await server('GET', `/v1/redirects?limit=50&cursor=${first.json.nextCursor}`);
		const all = [...first.json.items, ...rest.json.items].map((/** @type {{ from: string }} */ rule) => rule.from);
		expect(all.slice(2).sort()).toEqual(['/Old-Page', '/a', '/p']);
		expect((await server('GET', '/v1/redirects/count')).json).toEqual({ count: 5, capped: false });
		expect((await server('GET', '/v1/redirects/counts?by=code')).json).toEqual({
			total: 5,
			groups: { 301: 3, 308: 1, 410: 1 },
		});
		expect((await server('GET', '/v1/redirects/counts?by=match')).json.groups).toEqual({ exact: 4, prefix: 1 });
		const found = await server('GET', '/v1/redirects?q=DISCONT');
		expect(found.json.items.map((/** @type {{ from: string }} */ rule) => rule.from)).toEqual(['/gone-page']);
		expect((await server('GET', '/v1/redirects?q=contact')).json.items).toHaveLength(1);
		expect((await server('GET', '/v1/redirects/count?code=308')).json.count).toBe(1);
		expect((await server('GET', '/v1/redirects?code=302')).json.items).toHaveLength(5);
		expect((await server('GET', '/v1/redirects?limit=0')).status).toBe(400);
	});
});

describe('the website reads the rules', () => {
	beforeAll(async () => {
		await create({ from: '/blog', match: 'prefix', to: '/news?ref=old' });
		await create({ from: '/blog/2019', match: 'prefix', to: 'https://archive.example.com/2019' });
		await create({ from: '/blog/2019/best', to: '/best' });
		await create({ from: '/retired', match: 'prefix', code: 410 });
	});

	it('answers the rule of one address with where to send the visitor, or 204; one read', async () => {
		/** @param {string} path */
		const match = (path) => server('GET', `/v1/redirects/match?path=${encodeURIComponent(path)}`);
		expect((await match('/blog/a/b?utm_source=x')).json).toEqual({
			from: '/blog',
			match: 'prefix',
			to: '/news?ref=old',
			code: 301,
			location: '/news/a/b?ref=old&utm_source=x',
		});
		expect((await match('/blog/2019/x')).json.location).toBe('https://archive.example.com/2019/x');
		expect((await match('//blog/2019/best/')).json).toMatchObject({ from: '/blog/2019/best', location: '/best' });
		expect((await match('/retired/old-lamp')).json).toEqual({
			from: '/retired',
			match: 'prefix',
			to: null,
			code: 410,
			location: null,
		});
		for (const path of ['/blogger', '/', '/Blog', `/${'x'.repeat(1100)}`]) {
			const none = await match(path);
			expect(none.status).toBe(204);
			expect(none.text).toBe('');
		}
		expect((await server('GET', '/v1/redirects/match')).json).toMatchObject({ errors: [{ path: '/path' }] });
		expect((await match('blog')).status).toBe(422);
		const ops = await env.operationsDuring(() => match('/blog/2019/best/more'));
		expect(ops.names).toEqual(['find ss_growth_redirects']);
	});

	it('answers the whole list with an ETag, and 304 for one small read while it did not change', async () => {
		const first = await server('GET', '/v1/redirects/all');
		expect(first.status).toBe(200);
		const etag = /** @type {string} */ (first.headers.get('etag'));
		expect(etag).toBe(`"${await version()}"`);
		expect(first.headers.get('cache-control')).toBe('private, max-age=300');
		expect(first.json.version).toBe(etag.slice(1, -1));
		expect(first.json.count).toBe(first.json.rules.length);
		expect(first.json.rules.map((/** @type {{ from: string }} */ rule) => rule.from)).toEqual(
			[...first.json.rules.map((/** @type {{ from: string }} */ rule) => rule.from)].sort(),
		);
		expect(first.json.rules).toContainEqual({ from: '/retired', match: 'prefix', to: null, code: 410 });

		const unchanged = await env.operationsDuring(async () => {
			const again = await server('GET', '/v1/redirects/all', { headers: { 'if-none-match': etag } });
			expect(again.status).toBe(304);
			expect(again.text).toBe('');
			expect(again.headers.get('etag')).toBe(etag);
		});
		expect(unchanged.names).toEqual(['find ss_growth_redirect_versions']);
		expect((await server('GET', '/v1/redirects/all', { headers: { 'if-none-match': `"other", W/${etag}` } })).status).toBe(304);
		expect((await server('GET', '/v1/redirects/all', { headers: { 'if-none-match': '*' } })).status).toBe(304);
		// the instance keeps the list of this version: one read again
		const kept = await env.operationsDuring(() => server('GET', '/v1/redirects/all'));
		expect(kept.total).toBe(1);

		await create({ from: '/newest', to: '/n' });
		const changed = await env.operationsDuring(async () => {
			const fresh = await server('GET', '/v1/redirects/all', { headers: { 'if-none-match': etag } });
			expect(fresh.status).toBe(200);
			expect(fresh.headers.get('etag')).not.toBe(etag);
			expect(fresh.json.count).toBe(first.json.count + 1);
		});
		expect(changed.names).toEqual(['find ss_growth_redirect_versions', 'find ss_growth_redirects']);
	});
});

describe('CSV', () => {
	it('exports the rules A to Z', async () => {
		const file = await env.call('GET', '/v1/redirects/csv', { token: env.server });
		expect(file.headers.get('content-type')).toBe('text/csv; charset=utf-8');
		expect(file.headers.get('content-disposition')).toBe('attachment; filename="redirects.csv"');
		// the byte order mark Excel needs to read UTF-8 arrives byte for byte
		const bytes = new Uint8Array(await file.arrayBuffer());
		expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
		const lines = new TextDecoder('utf-8', { ignoreBOM: false }).decode(bytes).split('\r\n');
		expect(lines[0]).toBe('from,match,to,code,note');
		expect(lines).toContain('/retired,prefix,,410,');
		expect(lines).toContain('/blog,prefix,/news?ref=old,301,');
	});

	it('checks a file with a dry run, then imports it', async () => {
		const csv = 'from;to;code;note\n/import/one;/one;;\n/import/two;/two;308;\n/form;/contact;308;\n/blog/2019/best;/better;;';
		const before = await version();
		const check = await server('POST', '/v1/redirects/csv', { body: { csv } });
		expect(check.json).toMatchObject({ dryRun: true, rows: 4, created: 2, updated: 1, unchanged: 1, errors: [] });
		expect(check.json.changes).toEqual([
			{ line: 2, action: 'create', from: '/import/one', match: 'exact', to: '/one', code: 301, note: '', before: null },
			{ line: 3, action: 'create', from: '/import/two', match: 'exact', to: '/two', code: 308, note: '', before: null },
			{
				line: 5,
				action: 'update',
				from: '/blog/2019/best',
				match: 'exact',
				to: '/better',
				code: 301,
				note: '',
				before: { match: 'exact', to: '/best', code: 301, note: '' },
			},
		]);
		expect(await version()).toBe(before);
		const id = await idOf('/blog/2019/best');

		const done = await server('POST', '/v1/redirects/csv', { body: { csv, dryRun: false } });
		expect(done.json).toMatchObject({ dryRun: false, created: 2, updated: 1, unchanged: 1 });
		expect(await version()).not.toBe(before);
		const db = await env.merchantDb();
		expect(await db.collection('ss_growth_redirects').findOne({ from: '/blog/2019/best' })).toMatchObject({
			id,
			to: '/better',
		});
		expect(await db.collection('ss_growth_redirects').countDocuments({ from: /^\/import\// })).toBe(2);
		const [entry] = await logged('redirects.imported');
		expect(entry).toMatchObject({ target: 'redirects', label: 'redirects.csv', detail: '2 new, 1 changed, 1 unchanged.' });

		// the same file again changes nothing and writes nothing
		const kept = await version();
		expect((await server('POST', '/v1/redirects/csv', { body: { csv, dryRun: false } })).json).toMatchObject({
			created: 0,
			updated: 0,
			unchanged: 4,
		});
		expect(await version()).toBe(kept);
		expect(await logged('redirects.imported')).toHaveLength(1);
	});

	it('imports nothing from a file with problems', async () => {
		const csv = 'from,to\n/fine,/f\n/bad?x,/y\n/import/one,/import/two';
		const check = await server('POST', '/v1/redirects/csv', { body: { csv } });
		expect(check.json.errors).toMatchObject([
			{ line: 3, path: '/from', code: 'query' },
			{ line: 4, path: '/to', code: 'chain', steps: ['/import/one', '/import/two', '/two'] },
		]);
		const refused = await server('POST', '/v1/redirects/csv', { body: { csv, dryRun: false } });
		expect(refused.status).toBe(422);
		expect(refused.json.errors.map((/** @type {{ path: string }} */ error) => error.path)).toEqual([
			'/csv/3/from',
			'/csv/4/to',
		]);
		expect(await (await env.merchantDb()).collection('ss_growth_redirects').countDocuments({ from: '/fine' })).toBe(0);
		for (const body of [{ csv: ' ' }, { csv: 'from', dryRun: 'no' }, { csv: 'from', mode: 'replace' }, ['from']])
			expect((await server('POST', '/v1/redirects/csv', { body })).status).toBe(422);
	});
});

describe('suggestions from the 404 log', () => {
	it('lists the most-hit missing pages without a rule, with a page of the same last segment', async () => {
		await env.collect([
			{ type: 'page_view', path: '/lamps/blue-lamp', visit: true },
			...Array.from({ length: 3 }, () => ({ type: 'not_found', path: '/old/blue-lamp' })),
			{ type: 'not_found', path: '/missing' },
			{ type: 'not_found', path: '/blog/old-post' },
		]);
		const found = await server('GET', '/v1/redirects/suggestions');
		expect(found.json).toEqual({
			from: '2026-07-04',
			to: '2026-10-01',
			recording: true,
			items: [
				{ path: '/old/blue-lamp', hits: 3, to: '/lamps/blue-lamp' },
				{ path: '/missing', hits: 1, to: null },
			],
		});
		expect((await server('GET', '/v1/redirects/suggestions?days=1&limit=1')).json).toMatchObject({
			from: '2026-10-01',
			items: [{ path: '/old/blue-lamp' }],
		});
		for (const query of ['days=0', 'days=366', 'days=x', 'limit=0', 'limit=101'])
			expect((await server('GET', `/v1/redirects/suggestions?${query}`)).status).toBe(422);
		const ops = await env.operationsDuring(() => server('GET', '/v1/redirects/suggestions'));
		expect(ops.names).toEqual(['aggregate ss_growth_totals', 'find ss_growth_redirects']);
	});
});

describe('the redirects widget’s routes (ticket)', () => {
	it('lets staff with redirects.edit do everything, logged as them', async () => {
		const ticket = await env.ticket(['redirects.edit']);
		/** @param {string} method @param {string} path @param {unknown} [body] */
		const staff = async (method, path, body) => {
			const response = await env.call(method, path, { token: ticket, origin: ADMIN_ORIGIN, body });
			const text = await response.text();
			return {
				status: response.status,
				json: /json/.test(response.headers.get('content-type') ?? '') ? JSON.parse(text) : text,
			};
		};
		const made = await staff('POST', '/v1/admin/redirects', { from: '/by-staff', to: '/s' });
		expect(made.status).toBe(201);
		const [entry] = (await logged('redirect.created')).filter((found) => found.label === '/by-staff');
		expect(entry?.actor).toMatchObject({ kind: 'staff', id: 'u_1', name: 'Sam Staff' });
		expect((await staff('PATCH', `/v1/admin/redirects/${made.json.id}`, { to: '/t' })).json.to).toBe('/t');
		expect((await staff('GET', '/v1/admin/redirects?q=by-staff')).json.items).toHaveLength(1);
		expect((await staff('GET', '/v1/admin/redirects/count?q=by-staff')).json.count).toBe(1);
		expect((await staff('GET', '/v1/admin/redirects/counts?by=code&q=by-staff')).json.groups).toEqual({ 301: 1 });
		expect((await staff('GET', '/v1/admin/redirects/suggestions')).json.items[0]).toMatchObject({ path: '/old/blue-lamp' });
		expect(String((await staff('GET', '/v1/admin/redirects/csv')).json)).toContain('/by-staff,exact,/t,301,');
		expect((await staff('POST', '/v1/admin/redirects/csv', { csv: 'from,to\n/by-staff-2,/u' })).json.created).toBe(1);
		expect((await staff('DELETE', `/v1/admin/redirects/${made.json.id}`)).status).toBe(204);
	});

	it('refuses a ticket without the permission', async () => {
		const ticket = await env.ticket(['seo.check']);
		const response = await env.call('GET', '/v1/admin/redirects', { token: ticket, origin: ADMIN_ORIGIN });
		expect(response.status).toBe(403);
		expect((await response.json()).type).toMatch(/forbidden$/);
	});
});

describe('two changes at once', () => {
	it('are checked against each other: a loop cannot be made by two staff at once', async () => {
		const answers = await Promise.all([create({ from: '/ping', to: '/pong' }), create({ from: '/pong', to: '/ping' })]);
		expect(answers.map((answer) => answer.status).sort()).toEqual([201, 409]);
		const twice = await Promise.all([create({ from: '/same', to: '/one' }), create({ from: '/same', to: '/two' })]);
		expect(twice.map((answer) => answer.status).sort()).toEqual([201, 409]);
	});
});

describe('a website of its own', () => {
	/** @type {Awaited<ReturnType<typeof setup>>} */
	let own;
	beforeAll(async () => {
		own = await setup();
	});
	afterAll(async () => {
		await own.close();
	});
	/** @param {string} method @param {string} path @param {unknown} [body] */
	const call = async (method, path, body) => {
		const response = await own.call(method, path, { token: own.server, body });
		return { status: response.status, json: response.status === 204 ? null : await response.json() };
	};

	it('refuses while the feature is off or the database is not connected', async () => {
		await own.switchOn(['visitor_analytics', 'searches_404s']);
		expect((await call('GET', '/v1/redirects/match?path=/a')).json.type).toMatch(/feature_off$/);
		await own.switchOn(['redirects']);
		expect((await call('GET', '/v1/redirects/match?path=/a')).json.type).toMatch(/database_not_connected$/);
	});

	it('answers an empty list before any change, and says when 404s are not recorded', async () => {
		await own.connectDatabase();
		const empty = await own.call('GET', '/v1/redirects/all', { token: own.server });
		expect(empty.headers.get('etag')).toBe('"none"');
		expect(await empty.json()).toEqual({ version: 'none', count: 0, rules: [] });
		expect((await call('GET', '/v1/redirects/suggestions')).json).toMatchObject({ recording: false, items: [] });
	});

	it(`keeps at most ${MAX_RULES} rules`, async () => {
		const lines = Array.from({ length: MAX_RULES }, (_, i) => `/old-${i},/new-${i}`);
		const imported = await call('POST', '/v1/redirects/csv', { csv: `from,to\n${lines.join('\n')}`, dryRun: false });
		expect(imported.json).toMatchObject({ created: MAX_RULES, errors: [] });
		const full = await call('POST', '/v1/redirects', { from: '/one-more', to: '/x' });
		expect(full.status).toBe(409);
		expect(full.json).toMatchObject({ type: expect.stringMatching(/redirects_full$/), max: MAX_RULES });
		expect((await call('POST', '/v1/redirects/csv', { csv: 'from,to\n/one-more,/x' })).json.errors).toMatchObject([
			{ line: 1, code: 'too_many' },
		]);
		// the whole list is one read of the rules
		const ops = await own.operationsDuring(() => call('GET', '/v1/redirects/all'));
		expect(ops.names).toEqual(['find ss_growth_redirect_versions', 'find ss_growth_redirects']);
	});
});

describe('the lists an instance keeps in memory', () => {
	it('keeps the newest, and lets the oldest go past the websites or rules allowed', () => {
		/** @param {number} count */
		const list = (count) => ({ version: `v${count}`, body: { version: `v${count}`, count, rules: [] } });
		/** @type {Map<string, ReturnType<typeof list>>} */
		const lists = new Map();
		const limits = { websites: 3, rules: 10 };
		keepList(lists, 'a', list(4), limits);
		keepList(lists, 'b', list(4), limits);
		keepList(lists, 'a', list(5), limits);
		expect([...lists.keys()]).toEqual(['b', 'a']);
		keepList(lists, 'c', list(1), limits);
		expect([...lists.keys()]).toEqual(['b', 'a', 'c']);
		keepList(lists, 'd', list(0), limits);
		expect([...lists.keys()]).toEqual(['a', 'c', 'd']);
		keepList(lists, 'e', list(9), limits);
		expect([...lists.keys()]).toEqual(['c', 'd', 'e']);
		// a list larger than the rules allowed is still kept, alone
		keepList(lists, 'f', list(12), limits);
		expect([...lists.keys()]).toEqual(['f']);
	});
});
