import { validateManifest, validateProductBlueprint } from '@ss/contracts';
import { describe, expect, it } from 'vitest';
import { HIDDEN, SECRET_MIN_LENGTH, checkAdditions, hideSecrets, summarizeList, withDependencies } from '../src/blueprint.js';
import { createSigner, generateSigningKey, signPortalCall } from '@ss/protocol';
import { createProduct } from '../src/index.js';
import { BASE, DOMAIN, ENCRYPTION_KEY, SECRET, manifest, setup } from './helpers.js';

/** @param {Awaited<ReturnType<typeof setup>>} s @param {string} [site] */
const blueprintOf = async (s, site = s.websiteId) => {
	const response = await s.portal.callAsPortal('notes', 'GET', `/v1/blueprint?websiteId=${site}`);
	const body = await response.json();
	await s.settle();
	return { status: response.status, body };
};

/** A list's save that keeps whatever it is given. @param {string} _websiteId @param {unknown} value */
const save = async (_websiteId, value) => ({ ok: /** @type {const} */ (true), value });

/** A secret connection for the `notes` feature. */
const SECRET_CONNECTIONS = {
	api_key: { label: 'Provider key', kind: /** @type {const} */ ('secret'), neededBy: ['notes'] },
	provider: { label: 'Provider account', kind: /** @type {const} */ ('secret'), neededBy: ['inbox'], secretField: 'apiKey' },
};

describe('GET /v1/blueprint (Portal call)', () => {
	it('answers the product part of the Setup sheet: settings with defaults marked only while on, lists, connections state, widgets, checklist', async () => {
		const s = await setup({
			events: true,
			connections: SECRET_CONNECTIONS,
			lists: {
				labels: {
					feature: ['inbox', 'notes'],
					title: 'Labels',
					get: async () => ['urgent', 'later', 'done'],
					save,
				},
				routing: {
					feature: 'inbox',
					title: 'Routing',
					get: async () => ({ steps: [1, 2], rules: [], note: 'x' }),
					save,
				},
			},
			hooks: {
				blueprint: async (/** @type {{ on: string[] }} */ { on }) => ({
					events: ['notes.note.created', 'other.thing.done'],
					lists: { routing: '2 steps, no rules' },
					summaries: [{ title: 'Notes', text: `Features on: ${on.join(', ')}` }],
				}),
			},
		});
		await s.switchOn(['notes']);
		const cookie = await s.session();
		expect(
			(await s.dash(cookie, 'PUT', `/v1/dashboard/websites/${s.websiteId}/settings/notes.maxNotes`, { value: 12 })).status,
		).toBe(204);
		expect(
			(
				await s.dash(cookie, 'PUT', `/v1/dashboard/websites/${s.websiteId}/connections/api_key`, {
					value: 'sk_live_0123456789abcdef',
				})
			).status,
		).toBe(200);

		const { status, body } = await blueprintOf(s);
		expect(status).toBe(200);
		expect(validateProductBlueprint(body).ok).toBe(true);
		expect(body).toMatchObject({
			productId: 'notes',
			name: 'Notes',
			version: '1.0.0',
			status: 'active',
			docs: { guide: `${BASE}/docs`, openapi: null },
			business: { found: false, fetchedAt: expect.any(String), name: null, country: null, timeZone: null },
			install: { scriptUrl: `${BASE}/widget.js`, installed: false, lastSeenAt: null },
			shared: [],
			events: ['notes.settings.changed', 'notes.note.created'],
			summaries: [{ title: 'Notes', text: 'Features on: notes' }],
		});
		const [notes, inbox] = body.features;
		expect(notes).toEqual({
			key: 'notes',
			title: 'Notes',
			description: 'Visitors leave short notes.',
			on: true,
			dependsOn: [],
			recommendFor: ['chat.people', 'messages.email+signIn.*'],
			settings: [
				{ key: 'maxNotes', title: 'Notes per visitor per day', value: 12, default: false },
				{ key: 'greeting', title: 'Greeting', value: 'Leave us a note', default: true },
			],
			// a list of several features shows under the first of them that is on; one off is left out
			lists: [{ name: 'labels', title: 'Labels', summary: '3 entries', count: 3 }],
		});
		expect(inbox).toMatchObject({ key: 'inbox', on: false, recommendFor: [], settings: [], lists: [] });
		// no texts given: nothing to build is listed
		expect(body.build).toEqual([]);
		expect(body.connections).toEqual([
			{
				key: 'api_key',
				title: 'Provider key',
				kind: 'secret',
				neededBy: ['notes'],
				needed: true,
				set: true,
				state: 'connected',
				testedAt: expect.any(String),
			},
			{
				key: 'provider',
				title: 'Provider account',
				kind: 'secret',
				neededBy: ['inbox'],
				needed: false,
				set: false,
				state: 'not_connected',
				testedAt: null,
			},
			{
				key: 'database',
				title: 'Database (MongoDB)',
				kind: 'database',
				neededBy: ['notes', 'inbox'],
				needed: true,
				set: false,
				state: 'not_connected',
				testedAt: null,
			},
		]);
		// not ready without the merchant database
		expect(body.widgets).toEqual([
			{ key: 'note_form', kind: 'visitor', features: ['notes'], on: true, ready: false },
			{ key: 'inbox', kind: 'admin', features: ['inbox'], on: false, ready: false },
		]);
		expect(body.staffPermissions).toEqual([{ key: 'notes.read', name: 'Read notes', feature: 'inbox', on: false }]);
		expect(body.checklist).toEqual([
			{ key: 'features', done: true, text: 'Switch on the Notes features this website uses.' },
			{ key: 'connection.api_key', done: true, text: 'Connect Provider key in the Notes dashboard (Connections).' },
			{ key: 'connection.database', done: false, text: 'Connect Database (MongoDB) in the Notes dashboard (Connections).' },
			{
				key: 'widget',
				done: false,
				text: 'Add the Notes widget script to every page of your website (Install and tokens in the Portal).',
			},
			{ key: 'business', done: false, text: `Publish your business basics at https://${DOMAIN}/.well-known/business.json.` },
		]);
		expect(JSON.stringify(body)).not.toContain('sk_live_0123456789abcdef');
		expect(JSON.stringify(body)).not.toContain('cdef');
		// the hook's foreign event type is left out, and said so
		expect(s.entries.some((e) => e.msg === 'blueprint additions left out')).toBe(true);

		// with the inbox on too, its lists show there (labels names it first), one in the hook's words; an object list is
		// counted per member
		await s.switchOn(['notes', 'inbox']);
		const again = (await blueprintOf(s)).body;
		expect(again.features[1].lists).toEqual([
			{ name: 'labels', title: 'Labels', summary: '3 entries', count: 3 },
			{ name: 'routing', title: 'Routing', summary: '2 steps, no rules', count: null },
		]);
		expect(again.features[0].lists).toEqual([]);
	});

	it('stays a valid answer when a connection holds a word the answer also uses as a name (a bucket called like the product)', async () => {
		const s = await setup({ connections: SECRET_CONNECTIONS });
		await s.switchOn(['notes', 'inbox']);
		const cookie = await s.session();
		const value = { apiKey: 'sk_live_0123456789abcdef', account: 'maxNotes' };
		const url = `/v1/dashboard/websites/${s.websiteId}`;
		expect((await s.dash(cookie, 'PUT', `${url}/connections/provider`, { value })).status).toBe(200);
		expect((await s.dash(cookie, 'PUT', `${url}/settings/notes.greeting`, { value: 'Ask maxNotes' })).status).toBe(204);
		const { status, body } = await blueprintOf(s);
		expect(status).toBe(200);
		expect(validateProductBlueprint(body).ok).toBe(true);
		expect(body.features[0].settings).toEqual([
			{ key: 'maxNotes', title: 'Notes per visitor per day', value: 5, default: true },
			// a value holding a saved string is still hidden
			{ key: 'greeting', title: 'Greeting', value: HIDDEN, default: false },
		]);
		expect(JSON.stringify(body)).not.toContain('sk_live_0123456789abcdef');
	});

	it('shows the widget ready and installed once the database is connected and a visitor widget was seen; business.json found', async () => {
		const s = await setup();
		await s.switchOn(['notes']);
		await s.connectDatabase();
		s.handlers[`https://${DOMAIN}`] = async () =>
			new Response(JSON.stringify({ name: 'Example Shop', country: 'us', timeZone: 'America/New_York' }), {
				headers: { 'content-type': 'application/json' },
			});
		const cookie = await s.session();
		expect((await s.dash(cookie, 'POST', `/v1/dashboard/websites/${s.websiteId}/business/refresh`)).status).toBe(200);
		expect((await s.call('GET', '/v1/notes', { token: s.browser.token, origin: `https://${DOMAIN}` })).status).toBe(200);
		await s.settle();
		const { body } = await blueprintOf(s);
		expect(body.widgets[0]).toEqual({ key: 'note_form', kind: 'visitor', features: ['notes'], on: true, ready: true });
		expect(body.install).toEqual({ scriptUrl: `${BASE}/widget.js`, installed: true, lastSeenAt: expect.any(String) });
		expect(body.business).toMatchObject({ found: true, name: 'Example Shop', country: 'US', timeZone: 'America/New_York' });
		expect(body.checklist.filter((/** @type {any} */ item) => !item.done)).toEqual([]);
		expect(body.events).toEqual([]);
	});

	it('lists shared settings while one of their features is on, and widgets of a stopped website are not ready', async () => {
		const s = await setup({
			sharedSettings: {
				look: {
					name: 'Look',
					features: ['notes', 'inbox'],
					settings: { type: 'object', properties: { accent: { type: 'string', title: 'Accent', default: 'blue' } } },
				},
			},
		});
		expect((await blueprintOf(s)).body.shared).toEqual([]);
		await s.switchOn(['inbox', 'notes']);
		await s.connectDatabase();
		const on = (await blueprintOf(s)).body;
		expect(on.shared).toEqual([
			{
				key: 'look',
				title: 'Look',
				features: ['notes', 'inbox'],
				settings: [{ key: 'accent', title: 'Accent', value: 'blue', default: true }],
			},
		]);
		expect(on.widgets.map((/** @type {any} */ w) => w.ready)).toEqual([true, true]);
		s.portal.setStatus(s.websiteId, { status: 'stopped' });
		await s.portal.sendNotice('notes', { type: 'status.changed', websiteId: s.websiteId });
		await s.settle();
		const stopped = (await blueprintOf(s)).body;
		expect(stopped.status).toBe('stopped');
		expect(stopped.widgets.map((/** @type {any} */ w) => w.ready)).toEqual([false, false]);
	});

	it('names the OpenAPI document and serves it when the product gives it', async () => {
		const openapi = { openapi: '3.1.0', info: { title: 'Notes', version: '1.0.0' }, paths: {} };
		const s = await setup({ openapi });
		expect((await blueprintOf(s)).body.docs).toEqual({ guide: `${BASE}/docs`, openapi: `${BASE}/openapi.json` });
		const served = await s.call('GET', '/openapi.json');
		expect(served.status).toBe(200);
		expect(served.headers.get('cache-control')).toBe('public, max-age=300');
		expect(await served.json()).toEqual(openapi);
		const without = await setup();
		expect((await without.call('GET', '/openapi.json')).status).toBe(404);
	});

	it('lists what the website builds for each feature that is on, linked to its section of the guide', async () => {
		const build = {
			notes: 'Place the note form widget on the pages where visitors leave notes.',
			inbox: 'Give your admin page the inbox widget with a ticket from your server.',
		};
		const s = await setup({ build });
		await s.switchOn(['notes']);
		expect((await blueprintOf(s)).body.build).toEqual([
			{ feature: 'notes', what: build.notes, docs: `${BASE}/docs#feature-notes` },
		]);
		await s.switchOn(['notes', 'inbox']);
		expect((await blueprintOf(s)).body.build.map((/** @type {any} */ entry) => entry.feature)).toEqual(['notes', 'inbox']);
	});

	it.each([
		['a feature the manifest does not have', { chat: 'Add the chat.' }],
		['an empty text', { notes: '  ' }],
		['a text that is too long', { notes: 'x'.repeat(1001) }],
		['a text that is not a string', { notes: 7 }],
		['a list', []],
	])('refuses build texts with %s', (_name, build) => {
		expect(() =>
			createProduct({
				manifest: manifest(),
				config: { mongodbUri: '', connectSecret: SECRET, encryptionKey: ENCRYPTION_KEY },
				build: /** @type {any} */ (build),
			}),
		).toThrow(/build must map features of the manifest/);
	});

	it('refuses an OpenAPI document that is not an object', () => {
		expect(() =>
			createProduct({
				manifest: manifest(),
				config: { mongodbUri: '', connectSecret: SECRET, encryptionKey: ENCRYPTION_KEY },
				openapi: '{}',
			}),
		).toThrow(/openapi must be the OpenAPI document/);
	});

	it('still answers when a list cannot be read or the hook fails', async () => {
		const s = await setup({
			lists: {
				labels: {
					feature: 'notes',
					title: 'Labels',
					get: async () => {
						throw new Error('down');
					},
					save,
				},
			},
			hooks: {
				blueprint: async () => {
					throw new Error('boom');
				},
			},
		});
		await s.switchOn(['notes']);
		const { status, body } = await blueprintOf(s);
		expect(status).toBe(200);
		expect(body.features[0].lists).toEqual([
			{ name: 'labels', title: 'Labels', summary: 'Not available right now', count: null },
		]);
		expect(body.summaries).toEqual([]);
		expect(s.entries.map((e) => e.msg)).toEqual(
			expect.arrayContaining(['the blueprint hook failed', 'a list could not be read for the blueprint']),
		);
	});

	it('answers only signed Portal calls for this product, each once, naming a website the product serves', async () => {
		const s = await setup();
		const target = `/v1/blueprint?websiteId=${s.websiteId}`;
		// no signature, a server token instead, a call signed for another product, a forged key
		expect((await s.call('GET', target)).status).toBe(401);
		expect((await s.call('GET', target, { token: s.server.token })).status).toBe(401);
		expect((await s.call('GET', target, { headers: await s.portal.signCall('other', 'GET', target) })).status).toBe(401);
		const forged = await signPortalCall({
			signer: createSigner((await generateSigningKey({ kid: 'portal-1' })).privateJwk),
			audience: 'notes',
			method: 'GET',
			target,
			timestamp: Math.floor(s.clock.now() / 1000),
		});
		expect((await s.call('GET', target, { headers: forged })).status).toBe(401);
		// the same signed call twice: the second is a replay
		const headers = await s.portal.signCall('notes', 'GET', target);
		expect((await s.call('GET', target, { headers })).status).toBe(200);
		expect((await s.call('GET', target, { headers })).status).toBe(401);
		// signed for another website than the one asked for
		const elsewhere = await s.portal.signCall('notes', 'GET', '/v1/blueprint?websiteId=web_other0123456789');
		expect((await s.call('GET', target, { headers: elsewhere })).status).toBe(401);
		// no website, a malformed one, an unknown one, a removed one
		expect((await s.portal.callAsPortal('notes', 'GET', '/v1/blueprint')).status).toBe(422);
		expect((await s.portal.callAsPortal('notes', 'GET', '/v1/blueprint?websiteId=bad%20id')).status).toBe(422);
		expect((await s.portal.callAsPortal('notes', 'GET', '/v1/blueprint?websiteId=web_unknown0123456789')).status).toBe(404);
		s.portal.setStatus(s.websiteId, { status: 'removed' });
		await s.portal.sendNotice('notes', { type: 'status.changed', websiteId: s.websiteId });
		await s.settle();
		expect((await blueprintOf(s)).status).toBe(404);
	});

	it('answers 503 when the Portal cannot be reached and the website is not known yet', async () => {
		const s = await setup();
		s.portal.setReachable(false);
		expect((await s.portal.callAsPortal('notes', 'GET', `/v1/blueprint?websiteId=${s.websiteId}`)).status).toBe(503);
	});
});

describe("POST /v1/blueprint/features (the advisor's Switch on, a Portal call)", () => {
	const ADMIN = { id: 'adm_0123456789abcdefghjkmnpq', name: 'Ada Admin', role: /** @type {const} */ ('support') };
	/** @param {Awaited<ReturnType<typeof setup>>} s @param {unknown} body @param {string} [site] */
	const switchOn = async (s, body, site = s.websiteId) => {
		const response = await s.portal.callAsPortal('notes', 'POST', `/v1/blueprint/features?websiteId=${site}`, body);
		const json = await response.json();
		await s.settle();
		return { status: response.status, body: json };
	};

	it('switches a feature on with the features it needs, through the feature report, for the admin the Portal names', async () => {
		const s = await setup();
		s.portal.addAdmin(ADMIN);
		const done = await switchOn(s, { features: ['inbox'], admin: ADMIN });
		expect(done).toEqual({ status: 200, body: { version: 1, on: ['notes', 'inbox'], added: ['notes', 'inbox'] } });
		expect(s.portal.features(s.websiteId, 'notes')).toEqual({ version: 1, on: ['notes', 'inbox'] });
		expect(s.portal.featureReports.at(-1)?.body).toMatchObject({ adminId: ADMIN.id, adminName: 'Ada Admin' });
		// the dashboard's Recent changes names the admin
		const cookie = await s.session();
		const overview = await (await s.dash(cookie, 'GET', `/v1/dashboard/websites/${s.websiteId}/overview`)).json();
		expect(overview.recentChanges[0]).toMatchObject({
			who: { kind: 'admin', id: ADMIN.id, name: 'Ada Admin', role: 'support' },
			what: 'features',
			detail: 'On: Notes, Notes inbox',
		});
		// already on: nothing is reported again
		const reports = s.portal.featureReports.length;
		expect(await switchOn(s, { features: ['notes'], admin: ADMIN })).toEqual({
			status: 200,
			body: { version: 1, on: ['notes', 'inbox'], added: [] },
		});
		expect(s.portal.featureReports.length).toBe(reports);
	});

	it.each([
		['no admin', { features: ['notes'] }, '/admin'],
		['a Finance admin', { features: ['notes'], admin: { ...ADMIN, role: 'finance' } }, '/admin'],
		['an admin without a name', { features: ['notes'], admin: { ...ADMIN, name: ' ' } }, '/admin'],
		['a malformed admin id', { features: ['notes'], admin: { ...ADMIN, id: 'adm 1' } }, '/admin'],
		['no features', { features: [], admin: ADMIN }, '/features'],
		['an unknown feature', { features: ['chat'], admin: ADMIN }, '/features'],
		['features that are not a list', { features: 'notes', admin: ADMIN }, '/features'],
	])('refuses %s', async (_name, body, path) => {
		const s = await setup();
		const answer = await switchOn(s, body);
		expect(answer.status).toBe(422);
		expect(answer.body.errors[0].path).toBe(path);
		expect(s.portal.featureReports).toEqual([]);
	});

	it('answers what the Portal says when it refuses the report, and refuses calls the Portal did not sign', async () => {
		const s = await setup();
		// the Portal does not know this admin (any more)
		const refused = await switchOn(s, { features: ['notes'], admin: ADMIN });
		expect(refused.status).toBe(422);
		expect(refused.body.detail).toMatch(/^The Portal refused the change/);
		expect(s.portal.features(s.websiteId, 'notes')).toEqual({ version: 0, on: [] });
		expect(
			(
				await s.call('POST', `/v1/blueprint/features?websiteId=${s.websiteId}`, {
					token: s.server.token,
					body: { features: ['notes'], admin: ADMIN },
				})
			).status,
		).toBe(401);
		expect((await switchOn(s, { features: ['notes'], admin: ADMIN }, 'web_unknown0123456789')).status).toBe(404);
		expect((await s.portal.callAsPortal('notes', 'POST', '/v1/blueprint/features', { features: ['notes'] })).status).toBe(422);
	});

	it('adds every feature needed, in manifest order', () => {
		const value = manifest();
		value.features.push({
			key: 'tags',
			name: 'Tags',
			description: 'Labels on notes.',
			dependsOn: ['inbox'],
			settings: { type: 'object', properties: {} },
		});
		expect(withDependencies(value, ['tags'])).toEqual({ ok: true, keys: ['notes', 'inbox', 'tags'] });
		expect(withDependencies(value, ['notes', 'notes'])).toEqual({ ok: true, keys: ['notes'] });
		expect(withDependencies(value, [7])).toEqual({ ok: false, message: '`features` must list features of this product.' });
	});
});

describe('no secret can leave (property test)', () => {
	/** A seeded random source (mulberry32). @param {number} seed */
	const random = (seed) => {
		let a = seed;
		return () => {
			a = (a + 0x6d2b79f5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	};
	const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-/:+=.@';

	it.each(Array.from({ length: 24 }, (_, i) => i + 1))(
		'run %i: random settings, connections and hook texts never show a saved secret',
		async (seed) => {
			const next = random(seed);
			const int = (/** @type {number} */ n) => Math.floor(next() * n);
			const word = (/** @type {number} */ min, /** @type {number} */ max) =>
				Array.from({ length: min + int(max - min + 1) }, () => ALPHABET[int(ALPHABET.length)]).join('');
			const secrets = Array.from({ length: 1 + int(4) }, () => word(SECRET_MIN_LENGTH, 48));
			const pick = () => /** @type {string} */ (secrets[int(secrets.length)]);
			/** A string that may be, hold or miss a secret. */
			const someText = () => [pick(), `before ${pick()} after`, word(0, 20)][int(3)];

			// random settings of the two features (string, list, integer, boolean)
			const base = manifest();
			/** @type {Record<string, unknown>} */
			const saved = {};
			for (const feature of base.features) {
				/** @type {Record<string, any>} */
				const properties = {};
				for (let i = 0; i < 1 + int(5); i += 1) {
					const key = `s${i}`;
					const kind = int(4);
					if (kind === 0) properties[key] = { type: 'string', title: `Text ${i}`, default: someText(), maxLength: 200 };
					if (kind === 1)
						properties[key] = { type: 'array', title: `List ${i}`, default: [], items: { type: 'string', maxLength: 200 } };
					if (kind === 2) properties[key] = { type: 'integer', title: `Number ${i}`, default: int(100) };
					if (kind === 3) properties[key] = { type: 'boolean', title: `Switch ${i}`, default: next() < 0.5 };
					if (kind < 2 && next() < 0.7) saved[`${feature.key}.${key}`] = kind === 0 ? someText() : [someText(), someText()];
				}
				feature.settings = { type: 'object', properties };
			}
			expect(validateManifest(base).ok).toBe(true);
			/** @type {Record<string, any>} */
			const connections = {};
			/** @type {Record<string, unknown>} */
			const values = {};
			secrets.forEach((secret, index) => {
				const object = next() < 0.5;
				connections[`c${index}`] = { label: `Key ${index}`, kind: 'secret', neededBy: ['notes'] };
				values[`c${index}`] = object ? { apiKey: secret, region: 'eu', note: word(0, 6) } : secret;
			});
			const s = await setup({
				manifest: base,
				connections,
				lists: {
					words: {
						feature: 'notes',
						title: 'Words',
						get: async () => secrets,
						save,
					},
				},
				hooks: {
					blueprint: async () => ({
						lists: { words: `holds ${pick()}` },
						summaries: [
							{ title: 'Note', text: someText() || 'nothing' },
							{ title: 'Key', text: `${pick()}` },
						],
					}),
				},
			});
			await s.switchOn(['notes', 'inbox']);
			const cookie = await s.session();
			for (const [name, value] of Object.entries(values))
				expect(
					(await s.dash(cookie, 'PUT', `/v1/dashboard/websites/${s.websiteId}/connections/${name}`, { value })).status,
				).toBe(200);
			for (const [key, value] of Object.entries(saved))
				expect((await s.dash(cookie, 'PUT', `/v1/dashboard/websites/${s.websiteId}/settings/${key}`, { value })).status).toBe(
					204,
				);

			const { status, body } = await blueprintOf(s);
			expect(status).toBe(200);
			expect(validateProductBlueprint(body).ok).toBe(true);
			const text = JSON.stringify(body);
			for (const secret of secrets) expect(text.includes(secret), `secret ${secret} leaked`).toBe(false);
			expect(
				body.connections.filter((/** @type {any} */ c) => c.key.startsWith('c')).every((/** @type {any} */ c) => c.set),
			).toBe(true);
		},
	);
});

describe('helpers', () => {
	it('summarizes lists: arrays counted, objects per list member, anything else as set', () => {
		expect(summarizeList([])).toEqual({ summary: '0 entries', count: 0 });
		expect(summarizeList(['a'])).toEqual({ summary: '1 entry', count: 1 });
		expect(summarizeList({ statuses: [1, 2], moves: [1], name: 'x' })).toEqual({
			summary: 'statuses: 2, moves: 1',
			count: null,
		});
		expect(summarizeList({ name: 'x' })).toEqual({ summary: 'Set', count: null });
		expect(summarizeList(null)).toEqual({ summary: 'Set', count: null });
		const wide = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`member_number_${i}`, [1]]));
		expect(summarizeList(wide).summary).toHaveLength(300);
	});

	it('hides every string holding a secret, deep, and leaves the rest alone', () => {
		const value = { a: 'key=abcdefgh1', b: ['abcdefgh1', 'fine', 3, null], c: { d: true, e: 'x' } };
		expect(hideSecrets(value, ['abcdefgh1'])).toEqual({ a: HIDDEN, b: [HIDDEN, 'fine', 3, null], c: { d: true, e: 'x' } });
		expect(hideSecrets(value, [])).toBe(value);
	});

	it('keeps only the additions that fit', () => {
		expect(checkAdditions(undefined, 'notes')).toEqual({ events: [], lists: {}, summaries: [], dropped: [] });
		expect(checkAdditions('nope', 'notes').dropped).toEqual(['answer']);
		const mixed = checkAdditions(
			{
				events: ['notes.a.b', 'notes.Bad', 'chat.a.b', 7],
				lists: { ok: 'Fine', empty: '  ', long: 'x'.repeat(301) },
				summaries: [
					{ title: 'T', text: 'Text' },
					{ title: '', text: 'x' },
					'no',
					...Array.from({ length: 25 }, () => ({ title: 'T', text: 'x' })),
				],
			},
			'notes',
		);
		expect(mixed.events).toEqual(['notes.a.b']);
		expect(mixed.lists).toEqual({ ok: 'Fine' });
		expect(mixed.summaries).toHaveLength(20);
		expect(mixed.dropped).toEqual(['events', 'lists', 'summaries']);
		expect(checkAdditions({ events: 'x', lists: [], summaries: {} }, 'notes').dropped).toEqual([
			'events',
			'lists',
			'summaries',
		]);
	});
});
