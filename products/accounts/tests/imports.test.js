/**
 * The `import` feature (PLAN 0.8.10 K10, Migration step 1): roles, custom fields, users with their old password hashes
 * and two-step (A1, A8), role requests (A5) and activity copies through the kit's import routes; the dry run, re-runs,
 * prune, finish and status; imported users signing in; and the import checks one by one.
 */
import { createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPasswordHash, totpCode } from '../adapters/crypto.js';
import {
	checkImportedCopy,
	checkImportedField,
	checkImportedRequest,
	checkImportedRole,
	checkImportedUser,
	timeOf,
} from '../core/imports.js';
import { setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

/** @param {{ json: any }} res */
const code = (res) =>
	String(res.json?.type ?? '')
		.split('/')
		.pop();

/** A call of the importer (a program): the server token alone, while the import feature is on. @param {string} method @param {string} path @param {unknown} [body] */
const importer = (method, path, body) =>
	env.call(method, path, { token: env.server, bare: true, ...(body === undefined ? {} : { body }) });

/** NDJSON of records (a string line is sent as it is). @param {Array<unknown>} records */
const ndjson = (records) => records.map((record) => (typeof record === 'string' ? record : JSON.stringify(record))).join('\n');

/**
 * `POST /v1/import/:collection` with the server token.
 * @param {string} collection @param {Array<unknown>} records @param {{ dryRun?: boolean }} [options]
 */
const send = (collection, records, { dryRun = false } = {}) =>
	env.call('POST', `/v1/import/${collection}${dryRun ? '?dryRun=1' : ''}`, {
		token: env.server,
		bare: true,
		raw: ndjson(records),
		headers: { 'content-type': 'application/x-ndjson' },
	});

/** The paths of a failed record's errors. @param {any} answer @param {number} line */
const pathsOf = (answer, line) =>
	answer.failed.find((/** @type {any} */ item) => item.line === line)?.errors.map((/** @type {any} */ e) => e.path) ?? [];

/** A user id from a 24-digit hex id of the source system. @param {string} tail */
const usr = (tail) => `usr_65f00000000000000000${tail}`;

/** A peppered PBKDF2 hash as the source system stored it. @param {string} password @param {string} pepper */
const pbkdf2Hash = (password, pepper) => {
	const salt = randomBytes(16);
	return `pbkdf2$1000$${salt.toString('base64')}$${pbkdf2Sync(`${pepper}:${password}`, salt, 1000, 32, 'sha256').toString('base64')}`;
};

/** The source system's recovery-code hash. @param {string} recoveryCode */
const recoveryHash = (recoveryCode) => createHash('sha256').update(`recovery:${recoveryCode}`).digest('hex');

const SECRET = 'JBSWY3DPEHPK3PXP';
const ids = { staff: usr('00a1'), owner: usr('00a2'), member: usr('00a3'), customer: usr('00a4') };

const roles = [{ key: 'member', name: 'Member', description: 'Premium members', permissions: [], rank: 800 }];
const fields = [
	{ key: 'birthday', label: 'Birthday', type: 'date', createdAt: '2023-01-01T00:00:00Z' },
	{ key: 'size', label: 'Size', type: 'choice', options: ['S', 'M', 'L'] },
];
const users = () => [
	{
		id: ids.staff,
		name: 'Sara Staff',
		email: 'sara@example.com',
		emailVerified: true,
		role: 'support_staff',
		passwordHash: bcrypt.hashSync('staff secret 1', 4),
		passwordChangedAt: '2024-04-15T12:00:00Z',
		notes: 'Joined in spring',
		lastSignInAt: '2024-05-01T08:00:00Z',
		createdAt: '2023-03-01T09:00:00Z',
	},
	{
		id: ids.owner,
		name: 'Omar Owner',
		email: 'omar@example.com',
		emailVerified: true,
		role: 'owner',
		passwordHash: pbkdf2Hash('owner secret 1', 'old-pepper'),
		twoStep: { secret: SECRET, recoveryHashes: [recoveryHash('ABCDEFGHJK')] },
		createdAt: '2022-11-01T09:00:00Z',
	},
	{
		id: ids.member,
		name: 'Mina Member',
		phone: '+447700900567',
		phoneVerified: true,
		role: 'member',
		roleSince: '2024-02-01T00:00:00Z',
		passwordHash: `$2y$${bcrypt.hashSync('member secret 1', 4).slice(4)}`,
		addresses: [{ label: 'Home', line1: '1 Garden Road', city: 'Springfield' }],
		custom: { birthday: '1990-04-02', size: 'M' },
		consents: { terms: { version: '1', given: true, at: '2024-01-01T00:00:00Z' } },
		createdAt: '2023-12-01T00:00:00Z',
	},
	{
		id: ids.customer,
		phone: '07700 900321',
		blocked: { at: '2024-06-01T00:00:00Z', reason: 'Fake orders' },
		createdAt: '2024-03-01T00:00:00Z',
	},
];
const requests = [
	{
		id: 'rrq_65f0000000000000000000b1',
		role: 'member',
		name: 'Nora New',
		phone: '+447700900223',
		note: 'Please add me',
		createdAt: '2024-07-01T00:00:00Z',
	},
	{
		id: 'rrq_65f0000000000000000000b2',
		role: 'member',
		name: 'Mina Member',
		phone: '+447700900567',
		status: 'invited',
		userId: ids.member,
		invitedBy: { kind: 'user', id: ids.staff, name: 'Sara Staff' },
		invitedAt: '2024-01-25T00:00:00Z',
		setupExpiresAt: '2024-02-01T00:00:00Z',
		createdAt: '2024-01-20T00:00:00Z',
	},
];
const copy = {
	id: 'act_65f0000000000000000000c1',
	productId: 'ecommerce',
	actor: { kind: 'user', id: ids.staff, name: 'Sara Staff', role: 'support_staff' },
	action: 'order.status_changed',
	target: 'ord_65f0000000000000000000d1',
	label: 'Order 1042',
	detail: 'Status: confirmed → packed',
	at: '2024-05-02T10:00:00Z',
};

beforeAll(async () => {
	env = await setup();
	await env.switchOn([
		'email_password',
		'phone_password',
		'roles',
		'custom_fields',
		'two_step',
		'role_requests',
		'activity_copies',
	]);
	await env.connectDatabase();
	await env.paste('notifications');
	await env.setting('phone', 'defaultCallingCode', '+44');
	await env.setting('phone', 'trunkPrefix', '0');
});
afterAll(async () => {
	await env.product.close();
});

describe('import routes', () => {
	it('answer 403 feature_off while import is off', async () => {
		expect(code(await send('users', [users()[0]]))).toBe('feature_off');
		expect(code(await importer('GET', '/v1/import/status'))).toBe('feature_off');
		await env.switchOn([
			'email_password',
			'phone_password',
			'roles',
			'custom_fields',
			'two_step',
			'role_requests',
			'activity_copies',
			'import',
		]);
		expect(code(await send('sessions', [{ id: usr('0001') }]))).toBe('not_found');
	});

	it('a dry run reports every refusal and writes nothing', async () => {
		const checkedRoles = (await send('roles', [...roles, { key: 'Bad Key', name: 'Bad' }], { dryRun: true })).json;
		expect(checkedRoles).toMatchObject({ inserted: 1, dryRun: true, failed: [{ line: 2, errors: [{ path: '/key' }] }] });
		const [staff] = users();
		const answer = (
			await send(
				'users',
				[
					staff,
					{ id: usr('0b02'), email: 'x@example.com', websiteId: 'web_0000000000other', password: 'plain' },
					{ id: usr('0b03'), email: 'md5@example.com', passwordHash: 'md5$abc' },
					{ id: usr('0b04'), email: 'vip@example.com', role: 'vip' },
					{ id: usr('0b05'), email: 'long@example.com', name: 'x'.repeat(121) },
					{ id: usr('0b06'), email: 'not-an-email' },
					{ id: usr('0b07'), phone: 'call me' },
					{ id: usr('0b08'), email: 'SARA@example.com' },
					{ id: usr('0b09'), email: 'two@example.com', twoStep: { secret: 'short' } },
					'{ not json',
					{ id: usr('0b11'), email: 'zip@example.com', addresses: [{ line1: '1 Road', zip: '123' }] },
					{ id: usr('0b12'), email: 'shoe@example.com', custom: { shoe: 42 } },
					{ id: usr('0b13'), email: 'member@example.com', role: 'member' },
				],
				{ dryRun: true },
			)
		).json;
		expect(answer).toMatchObject({ inserted: 1, updated: 0, dryRun: true });
		expect(answer.failed.map((/** @type {any} */ item) => item.line)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
		expect(pathsOf(answer, 2)).toEqual(['/websiteId', '/password']);
		expect(answer.failed[0].errors[0].message).toBe('websiteId is not a field of a user.');
		expect(pathsOf(answer, 3)).toEqual(['/passwordHash']);
		expect(pathsOf(answer, 4)).toEqual(['/role']);
		expect(pathsOf(answer, 5)).toEqual(['/name']);
		expect(pathsOf(answer, 6)).toEqual(['/email']);
		expect(pathsOf(answer, 7)).toEqual(['/phone']);
		// the same address as line 1, which this call took
		expect(answer.failed[6].errors[0].message).toBe(`This email address is already another user’s (${ids.staff}).`);
		expect(pathsOf(answer, 9)).toEqual(['/twoStep/secret']);
		expect(pathsOf(answer, 11)).toEqual(['/addresses/0/zip']);
		expect(pathsOf(answer, 12)).toEqual(['/custom/shoe']);
		// the role of a dry run is not there yet: roles are imported first
		expect(pathsOf(answer, 13)).toEqual(['/role']);
		const status = (await importer('GET', '/v1/import/status')).json;
		expect(status.collections).toMatchObject({ users: 0, requests: 0, copies: 0, fields: 0 });
		expect(status.imported).toMatchObject({ roles: 0, users: 0 });
		expect(env.messages()).toEqual([]);
	});

	it('imports roles, fields, users, requests and copies as given, sending nothing', async () => {
		expect((await send('roles', roles)).json).toMatchObject({ inserted: 1, updated: 0, failed: [] });
		expect((await send('fields', fields)).json).toMatchObject({ inserted: 2, failed: [] });
		const imported = (await send('users', users())).json;
		expect(imported).toMatchObject({ inserted: 4, updated: 0, failed: [], dryRun: false });
		expect((await send('requests', requests)).json).toMatchObject({ inserted: 2, failed: [] });
		expect((await send('copies', [copy])).json).toMatchObject({ inserted: 1, failed: [] });
		expect(env.messages()).toEqual([]);

		const member = (await env.serverCall('GET', `/v1/users/${ids.member}`)).json;
		expect(member).toMatchObject({
			id: ids.member,
			name: 'Mina Member',
			phone: '+447700900567',
			phoneVerified: true,
			email: null,
			role: 'member',
			roleSince: '2024-02-01T00:00:00.000Z',
			createdAt: '2023-12-01T00:00:00.000Z',
			hasPassword: true,
			custom: { birthday: '1990-04-02', size: 'M' },
			consents: { terms: { version: '1', given: true, at: '2024-01-01T00:00:00.000Z' } },
			status: 'active',
			blocked: null,
		});
		expect(member.addresses).toEqual([
			expect.objectContaining({ id: `adr_${ids.member.slice(4)}00`, label: 'Home', line1: '1 Garden Road', default: true }),
		]);
		const store = await env.store();
		const customer = await store.users.get(ids.customer);
		expect(customer).toMatchObject({
			phone: '+447700900321',
			phoneReversed: '1230090077',
			identity: 'phone',
			role: 'customer',
			roleSince: new Date('2024-03-01T00:00:00Z'),
			blocked: { at: new Date('2024-06-01T00:00:00Z'), reason: 'Fake orders' },
		});
		const staff = await store.users.get(ids.staff);
		expect(staff).toMatchObject({
			identity: 'email',
			notes: 'Joined in spring',
			passwordChangedAt: new Date('2024-04-15T12:00:00Z'),
			lastSignInAt: new Date('2024-05-01T08:00:00Z'),
		});
		// a password moved in without its time has none
		expect((await store.users.get(ids.member))?.passwordChangedAt ?? null).toBeNull();
		// the plain two-step secret is never stored: only its sealed form and the old recovery hashes
		const owner = await store.users.get(ids.owner);
		expect(owner?.twoStep?.sealed).toMatch(/^ss2\./);
		expect(owner?.twoStep?.recovery).toEqual([{ hash: recoveryHash('ABCDEFGHJK'), format: 'sha256_prefixed' }]);
		expect(JSON.stringify(owner)).not.toContain(SECRET);

		const listed = (await env.serverCall('GET', '/v1/role-requests')).json.items;
		expect(listed.map((/** @type {any} */ item) => [item.id, item.status])).toEqual([
			[requests[0]?.id, 'pending'],
			[requests[1]?.id, 'expired'],
		]);
		const copies = (await env.serverCall('GET', '/v1/activity-copies')).json.items;
		expect(copies).toEqual([{ ...copy, values: {}, at: '2024-05-02T10:00:00.000Z' }]);
		// one activity entry per call, in the merchant database only
		const logged = (await env.serverCall('GET', '/v1/activity?action=import.users')).json.items;
		expect(logged[0]).toMatchObject({ action: 'import.users', values: { inserted: 4, updated: 0, failed: 0 } });
		expect(copies).toHaveLength(1);
	});

	it('a re-run replaces each record with the source again and keeps createdAt', async () => {
		const member = { ...users()[2], name: 'Mina M.', custom: undefined, createdAt: undefined };
		expect((await send('users', [member])).json).toMatchObject({ inserted: 0, updated: 1, failed: [] });
		const stored = await (await env.store()).users.get(ids.member);
		expect(stored).toMatchObject({ name: 'Mina M.', custom: {}, createdAt: new Date('2023-12-01T00:00:00Z') });
		// another user's email address or phone number is refused, also when stored
		const taken = (await send('users', [{ id: usr('0c01'), email: 'omar@example.com', phone: '+447700900567' }])).json;
		expect(taken.failed[0].errors.map((/** @type {any} */ e) => e.message)).toEqual([
			`This email address is already another user’s (${ids.owner}).`,
			`This phone number is already another user’s (${ids.member}).`,
		]);
		expect((await send('roles', [{ ...roles[0], name: 'Premium member' }])).json).toMatchObject({ updated: 1 });
		const role = (await env.serverCall('GET', '/v1/roles')).json.items.find((/** @type {any} */ r) => r.key === 'member');
		expect(role).toMatchObject({ name: 'Premium member', rank: 800, system: false, membership: true });
	});

	it('imported users sign in with their old passwords and two-step', async () => {
		const staff = await env.visitor('POST', '/v1/sign-in/password', { email: 'sara@example.com', password: 'staff secret 1' });
		expect(staff.json.status).toBe('signed_in');
		const member = await env.visitor('POST', '/v1/sign-in/phone-password', {
			phone: '+447700900567',
			password: 'member secret 1',
		});
		expect(member.json.status).toBe('signed_in');
		/** @param {string} password */
		const owner = (password) => env.visitor('POST', '/v1/sign-in/password', { email: 'omar@example.com', password });
		// PBKDF2 needs the source system's pepper
		expect(code(await owner('owner secret 1'))).toBe('sign_in_failed');
		await env.connect('imported_password_pepper', 'old-pepper');
		const first = await owner('owner secret 1');
		expect(first.json.status).toBe('two_step');
		const done = await env.visitor('POST', '/v1/sign-in/two-step', {
			challenge: first.json.challenge,
			code: totpCode(SECRET, env.now()),
		});
		expect(done.json.status).toBe('signed_in');
		const second = await owner('owner secret 1');
		const recovered = await env.visitor('POST', '/v1/sign-in/two-step', {
			challenge: second.json.challenge,
			recoveryCode: 'abcde-fghjk',
		});
		expect(recovered.json.status).toBe('signed_in');
	});

	it('prunes what the source no longer has; finish reports what points nowhere; status sums', async () => {
		const keep = [ids.staff, ids.owner, ids.member].sort();
		const dry = (await importer('POST', '/v1/import/users/prune?dryRun=1', { keep })).json;
		expect(dry).toMatchObject({ removed: 1, keys: [ids.customer], dryRun: true });
		expect((await importer('POST', '/v1/import/users/prune', { keep })).json).toMatchObject({ removed: 1 });
		expect(code(await env.serverCall('GET', `/v1/users/${ids.customer}`))).toBe('not_found');

		// a request whose user is gone, and users of a role pruned away
		await send('requests', [
			{
				id: 'rrq_65f0000000000000000000b3',
				role: 'member',
				name: 'Gone Person',
				email: 'gone@example.com',
				status: 'completed',
				userId: usr('0dead'),
				completedAt: '2024-02-02T00:00:00Z',
			},
		]);
		expect((await importer('POST', '/v1/import/roles/prune', { keep: [] })).json).toMatchObject({ removed: 1 });
		expect((await importer('POST', '/v1/import/finish')).json).toEqual({
			finished: true,
			usersWithUnknownRole: 1,
			requestsWithUnknownUser: 1,
		});
		await send('roles', roles);
		expect((await importer('POST', '/v1/import/finish')).json).toMatchObject({ usersWithUnknownRole: 0 });

		const status = (await importer('GET', '/v1/import/status')).json;
		expect(status.imported).toEqual({ roles: 1, fields: 2, users: 3, requests: 3, copies: 1 });
		// (users: the three imported and the staff member the harness's staff calls signed in as)
		expect(status.collections).toMatchObject({ fields: 2, users: 4, requests: 3, copies: 1 });
		expect(status.totals).toEqual({
			'users.staff': 3,
			'users.withPassword': 3,
			'users.twoStep': 1,
			'users.role.member': 1,
			'users.role.owner': 2,
			'users.role.support_staff': 1,
			'requests.pending': 1,
		});
		expect(env.messages()).toEqual([]);
	});

	it('limits the number of roles and custom fields', async () => {
		const many = Array.from({ length: 50 }, (_, i) => ({ key: `extra_${i}`, label: `Extra ${i}`, type: 'text' }));
		const answer = (await send('fields', many, { dryRun: true })).json;
		expect(answer.inserted).toBe(48);
		expect(answer.failed.map((/** @type {any} */ item) => item.errors[0].message)).toEqual([
			'A website has at most 50 custom fields.',
			'A website has at most 50 custom fields.',
		]);
	});

	it('a user or role request without createdAt gets the import time, kept on a re-run; roleSince follows it (A5)', async () => {
		const id = usr('0f01');
		const request = { id: 'rrq_65f0000000000000000000f1', role: 'customer', name: 'Alex Morgan', email: 'alex@example.com' };
		const first = new Date(env.now()).toISOString();
		expect((await send('users', [{ id, name: 'Alex Morgan', email: 'alex@example.com' }])).json).toMatchObject({
			inserted: 1,
			failed: [],
		});
		expect((await send('requests', [request])).json).toMatchObject({ inserted: 1, failed: [] });
		const user = async () => (await env.serverCall('GET', `/v1/users/${id}`)).json;
		const listed = async () =>
			(await env.serverCall('GET', '/v1/role-requests')).json.items.find((/** @type {any} */ item) => item.id === request.id);
		expect(await user()).toMatchObject({ createdAt: first, roleSince: first });
		expect(await listed()).toMatchObject({ createdAt: first });
		const stored = await (await env.store()).users.get(id);
		expect(stored?.roleSince).toEqual(new Date(first));

		// a re-run a day later without the times keeps them; a given createdAt is the role's start too
		env.advance(24 * 3600 * 1000);
		expect((await send('users', [{ id, name: 'Alex M.', email: 'alex@example.com' }])).json).toMatchObject({ updated: 1 });
		expect((await send('requests', [request])).json).toMatchObject({ updated: 1 });
		expect(await user()).toMatchObject({ name: 'Alex M.', createdAt: first, roleSince: first });
		expect(await listed()).toMatchObject({ createdAt: first });
		const given = { id, name: 'Alex M.', email: 'alex@example.com', createdAt: '2023-05-01T00:00:00Z' };
		expect((await send('users', [given])).json).toMatchObject({ updated: 1 });
		expect(await user()).toMatchObject({ createdAt: '2023-05-01T00:00:00.000Z', roleSince: '2023-05-01T00:00:00.000Z' });
	});
});

describe('import checks', () => {
	const rules = {
		roles: new Set(['customer', 'member']),
		signUpRole: 'customer',
		fields: [
			{
				key: 'size',
				label: 'Size',
				type: /** @type {const} */ ('choice'),
				options: ['S'],
				required: true,
				visibility: /** @type {const} */ ('edit'),
				help: '',
			},
		],
		phoneFormat: { defaultCallingCode: '+44', trunkPrefix: '0' },
		isPasswordHash,
	};
	/** @param {{ ok: boolean, errors?: Array<{ path: string }> }} checked */
	const paths = (checked) => (checked.ok ? [] : (checked.errors ?? []).map((e) => e.path));

	it('times carry their zone', () => {
		expect(timeOf('2024-01-01T10:00:00Z')?.toISOString()).toBe('2024-01-01T10:00:00.000Z');
		expect(timeOf('2024-01-01T10:00+05:00')?.toISOString()).toBe('2024-01-01T05:00:00.000Z');
		expect(timeOf('2024-01-01T10:00:00')).toBeNull();
		expect(timeOf('2024-13-45T10:00:00Z')).toBeNull();
		expect(timeOf(1_700_000_000)).toBeNull();
	});

	it('password hashes Accounts reads', () => {
		expect(isPasswordHash(bcrypt.hashSync('x', 4))).toBe(true);
		expect(isPasswordHash(pbkdf2Hash('x', 'p'))).toBe(true);
		expect(isPasswordHash(`scrypt$${'a'.repeat(22)}$${'b'.repeat(43)}`)).toBe(true);
		expect(isPasswordHash('pbkdf2$0$AAAA$AAAA')).toBe(false);
		expect(isPasswordHash('pbkdf2$1000$AAAA$AAAA')).toBe(false);
		expect(isPasswordHash('$argon2id$v=19$m=65536')).toBe(false);
	});

	it('users: strict fields, history and contacts', () => {
		const user = { id: usr('0e01'), email: 'u@example.com', custom: { size: 'S' } };
		expect(checkImportedUser(user, rules)).toMatchObject({
			ok: true,
			value: { role: 'customer', status: 'active', identity: 'email', name: '', twoStep: null, consents: {} },
		});
		const both = checkImportedUser({ ...user, phone: '+447700900000', identity: 'phone' }, rules);
		expect(both).toMatchObject({ ok: true, value: { identity: 'phone' } });
		expect(checkImportedUser({ ...user, phone: '+447700900000' }, rules)).toMatchObject({ ok: true });
		expect('identity' in /** @type {any} */ (checkImportedUser({ ...user, phone: '+447700900000' }, rules)).value).toBe(false);
		expect(
			paths(
				checkImportedUser(
					{
						id: 'cus_65f0000000000000000000e1',
						emailVerified: 'yes',
						phoneVerified: true,
						status: 'blocked',
						notes: 'n'.repeat(5001),
						blocked: { at: 'yesterday', reason: 'r'.repeat(301), by: 'x' },
						addresses: ['nope'],
						providers: { google: '', github: 'x' },
						identity: 'provider',
						passwordHash: 42,
						twoStep: { secret: SECRET, recoveryHashes: ['abc'], issuer: 'x' },
						consents: { terms: { version: '', given: true, at: 'x' } },
						passwordChangedAt: 'x',
						lastSignInAt: 'x',
						createdAt: '2024-01-01',
						roleSince: 5,
					},
					rules,
				),
			),
		).toEqual([
			'/id',
			'/email',
			'/emailVerified',
			'/phoneVerified',
			'/status',
			'/notes',
			'/blocked/by',
			'/blocked/at',
			'/blocked/reason',
			'/addresses/0',
			'/addresses/0/line1',
			'/providers/github',
			'/providers/google',
			'/identity',
			'/passwordHash',
			'/twoStep/issuer',
			'/twoStep/recoveryHashes',
			'/consents/terms/version',
			'/passwordChangedAt',
			'/lastSignInAt',
			'/createdAt',
			'/roleSince',
		]);
		expect(
			paths(
				checkImportedUser(
					{
						...user,
						blocked: 'yes',
						addresses: 'home',
						providers: 'google',
						twoStep: 'on',
						consents: true,
						custom: { size: 'XL' },
					},
					rules,
				),
			),
		).toEqual(['/blocked', '/addresses', '/custom/size', '/providers', '/twoStep', '/consents']);
		expect(
			paths(
				checkImportedUser(
					{ ...user, consents: { terms: { version: '2', given: true, at: 'soon' } }, identity: 'phone' },
					rules,
				),
			),
		).toEqual(['/identity', '/consents/terms/at']);
		expect(
			checkImportedUser(
				{
					...user,
					providers: { google: 'g-123' },
					identity: 'provider',
					blocked: { at: '2024-01-01T00:00:00Z' },
					twoStep: { secret: 'jbsw y3dp ehpk 3pxp' },
					addresses: [{ id: 'adr_kept000001', line1: '2 Road', country: 'gb' }],
				},
				rules,
			),
		).toMatchObject({
			ok: true,
			value: {
				providers: { google: 'g-123' },
				identity: 'provider',
				blocked: { reason: '' },
				twoStep: { secret: SECRET, recoveryHashes: [] },
				addresses: [{ id: 'adr_kept000001', country: 'GB' }],
			},
		});
	});

	it('roles and custom fields: strict types; Owner keeps rank 100 and every permission; the sign-up choice', () => {
		expect(checkImportedRole({ key: 'customer', name: 'Shopper', rank: 900, signUp: true, membership: false })).toMatchObject({
			ok: true,
			value: { key: 'customer', rank: 900, signUp: true, membership: false },
		});
		expect(checkImportedRole({ key: 'owner', name: 'Owner', rank: 5, permissions: ['*'] })).toMatchObject({
			ok: true,
			value: { rank: 100, signUp: false },
		});
		expect(paths(checkImportedRole({ key: 'owner', name: 'Owner', permissions: [] }))).toEqual(['/permissions']);
		expect(paths(checkImportedRole({ key: 'owner', name: 'Owner', permissions: ['*'], signUp: true }))).toEqual(['/signUp']);
		expect(
			paths(
				checkImportedRole({
					key: 'vip',
					name: 3,
					twoStep: 'always',
					sessionRolling: 'yes',
					permissions: 'all',
					ready: true,
					signUp: 'yes',
				}),
			),
		).toEqual(['/ready', '/name', '/permissions', '/sessionRolling', '/signUp', '/twoStep']);
		expect(paths(checkImportedRole({ key: 'vip', name: 'VIP', description: 'd'.repeat(301) }))).toEqual(['/description']);
		expect(checkImportedField({ key: 'note', label: 'Note', type: 'text' })).toMatchObject({
			ok: true,
			value: { required: false },
		});
		expect(paths(checkImportedField({ key: 'note', label: 'Note', type: 'text', options: ['a'], createdAt: 'x' }))).toEqual([
			'/options',
			'/createdAt',
		]);
		expect(paths(checkImportedField({ key: 'Bad Key', label: 'Note', type: 'text' }))).toEqual(['/key']);
	});

	it('role requests and activity copies', () => {
		const request = { id: 'rrq_65f0000000000000000000f1', role: 'member', name: 'Ann', email: 'ann@example.com' };
		expect(checkImportedRequest(request, rules)).toMatchObject({
			ok: true,
			value: { status: 'pending', userId: null, invitedBy: null, note: '', phone: null },
		});
		expect(
			paths(
				checkImportedRequest(
					{
						id: 'usr_65f0000000000000000000f1',
						role: 'vip',
						name: '',
						note: 'n'.repeat(1001),
						status: 'expired',
						userId: 'x',
						invitedBy: { kind: 'User', id: 'u' },
						setupHash: 'abc',
					},
					rules,
				),
			),
		).toEqual(['/setupHash', '/id', '/role', '/name', '/email', '/note', '/status', '/userId', '/invitedBy']);
		expect(paths(checkImportedRequest({ ...request, status: 'invited', invitedBy: 'staff' }, rules))).toEqual([
			'/userId',
			'/invitedBy',
		]);
		expect(
			checkImportedRequest({ ...request, status: 'declined', invitedBy: { kind: 'server', id: 'server' } }, rules),
		).toMatchObject({ ok: true, value: { invitedBy: { kind: 'server', id: 'server' } } });
		expect(paths(checkImportedRequest({ ...request, invitedBy: { kind: 'user', id: 'u', name: 7 } }, rules))).toEqual([
			'/invitedBy/name',
		]);
		const websiteId = 'web_0000000000000001';
		expect(checkImportedCopy({ ...copy, label: '', detail: '' }, websiteId)).toEqual({
			ok: true,
			value: { ...copy, label: undefined, detail: undefined, at: new Date(copy.at) },
		});
		expect(paths(checkImportedCopy({ ...copy, websiteId }, websiteId))).toEqual(['/websiteId']);
		expect(paths(checkImportedCopy({ ...copy, label: 'x'.repeat(201) }, websiteId))).toEqual(['/label']);
	});
});
