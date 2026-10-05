/** Mode B and Mode A: the claims and serial lookup headless cores and their default renderers on a scripted client. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createClaims } from '../headless/claims.js';
import { createSerialLookup } from '../headless/serials.js';
import { render as renderClaims, styles as claimStyles } from '../ui/claims.js';
import { render as renderSerials, styles as serialStyles } from '../ui/serials.js';
import { createClient, createFakeDom, findAll } from './helpers.js';

const strings = JSON.parse(readFileSync(new URL('../strings/en.json', import.meta.url), 'utf8'));

/** @param {Record<string, any>} [overrides] */
const form = (overrides = {}) => ({
	types: [
		{ key: 'return', label: 'Return', refundable: true, minPhotos: 0, requireSerial: false, detailsMinLength: 0 },
		{ key: 'warranty', label: 'Warranty', refundable: true, minPhotos: 1, requireSerial: true, detailsMinLength: 5 },
	],
	reasons: [
		{ key: 'defective', label: 'Faulty', types: [], detailsRequired: false },
		{ key: 'changed_mind', label: 'Changed mind', types: ['return'], detailsRequired: false },
	],
	details: { maxLength: 50 },
	maxLines: 20,
	guestAccess: true,
	photos: { enabled: true, max: 2, maxBytes: 1000, types: ['image/jpeg'] },
	messages: { enabled: true, customerCanWrite: true, maxLength: 200 },
	...overrides,
});
const purchase = {
	id: 'pur_1',
	number: 'N-1',
	deliveredAt: '2026-10-01T00:00:00.000Z',
	canClaim: true,
	lines: [
		{
			lineId: 'l1',
			itemId: 'itm_1',
			title: 'Case',
			quantity: 2,
			claimable: 2,
			windows: {
				return: { eligible: true, closesAt: '2026-10-15T00:00:00.000Z' },
				warranty: { eligible: true, closesAt: '2027-10-01T00:00:00.000Z' },
			},
		},
		{
			lineId: 'l2',
			itemId: 'itm_2',
			title: null,
			quantity: 1,
			claimable: 0,
			windows: { return: { eligible: false, reason: 'window_closed' } },
		},
	],
};
const claim = {
	id: 'clm_1',
	reference: 'CL-1',
	type: 'return',
	typeLabel: 'Return',
	status: 'requested',
	statusLabel: 'Requested',
	statusDescription: 'We will look at it.',
	submittedAt: '2026-10-02T00:00:00.000Z',
	history: [{ status: 'requested', label: 'Requested', at: '2026-10-02T00:00:00.000Z' }],
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** @param {Record<string, any>} [overrides] */
const identityRoutes = (overrides = {}) => ({
	'GET /v1/claim-form': () => form(),
	'GET /v1/purchases': () => ({ items: [purchase] }),
	'GET /v1/claims': () => ({ items: [claim] }),
	'GET /v1/claims/clm_1': () => claim,
	'GET /v1/messages': () => ({ items: [{ id: 'm1', author: 'staff', body: 'Hello' }] }),
	'POST /v1/messages': (/** @type {any} */ _q, /** @type {any} */ body) => ({ id: 'm2', author: 'customer', body: body.body }),
	'POST /v1/claim-photos': () => ({
		id: 'cph_1',
		upload: { method: 'PUT', url: 'https://bucket/x', headers: { 'content-type': 'image/jpeg', 'content-length': '10' } },
	}),
	'POST /v1/claims': (/** @type {any} */ _q, /** @type {any} */ body) => ({ ...claim, type: body.type, reference: 'CL-2' }),
	...overrides,
});

describe('headless claims (signed in)', () => {
	it('loads, validates, uploads photos, submits, opens claims and sends messages', async () => {
		const client = createClient(identityRoutes());
		/** @type {string[]} */
		const events = [];
		/** @type {any[]} */
		const uploads = [];
		const element = createClaims({
			strings,
			client,
			identity: 'token',
			emit: (name) => events.push(name),
			upload: async (target, file) => {
				uploads.push({ target, file });
				return true;
			},
		});
		/** @type {any[]} */
		const seen = [];
		const off = element.subscribe((state) => seen.push(state.status));
		await element.actions.load();
		expect(element.state()).toMatchObject({ status: 'ready', mode: 'identity' });
		expect(element.state().claims).toHaveLength(1);
		expect(seen).toContain('loading');
		off();
		expect(element.validate().map((p) => p.path)).toEqual(['/purchaseId', '/type', '/reason', '/lines']);
		element.actions.selectPurchase('pur_1');
		expect(element.selectedPurchase()?.id).toBe('pur_1');
		element.actions.setDraft({ type: 'warranty', reason: 'changed_mind', details: 'abc', lineId: 'l1', quantity: 3 });
		const problems = element.validate().map((p) => p.code);
		expect(problems).toEqual(expect.arrayContaining(['required', 'too_short', 'not_eligible', 'photos_required']));
		expect(element.validate()[0]?.message).toBe('This is required.');
		const failed = await element.actions.submit();
		expect(failed.ok).toBe(false);
		expect(element.state().submit).toBe('error');
		element.actions.setDraft({ type: 'warranty', reason: 'defective', details: 'Broken screen', lineId: 'l1', quantity: 1 });
		element.actions.setDraft({ lineId: 'l1', serial: 'SN1' });
		await element.actions.addPhoto({ type: 'image/jpeg', size: 10, body: 'bytes' });
		expect(uploads[0].target.url).toBe('https://bucket/x');
		element.actions.removePhoto('cph_1');
		expect(element.state().draft.photoIds).toEqual([]);
		await element.actions.addPhoto({ type: 'image/jpeg', size: 10, body: 'bytes' });
		expect(element.validate()).toEqual([]);
		const submitted = await element.actions.submit();
		expect(submitted.ok).toBe(true);
		expect(element.state()).toMatchObject({ submit: 'submitted', message: 'Thank you — your claim CL-2 was sent.' });
		const sent = client.calls.find((c) => c.method === 'POST' && c.path === '/v1/claims');
		expect(sent?.body).toMatchObject({
			purchaseId: 'pur_1',
			type: 'warranty',
			lines: [{ lineId: 'l1', quantity: 1, serial: 'SN1' }],
			photoIds: ['cph_1'],
		});
		await element.actions.openClaim('clm_1');
		expect(element.state().active?.messages).toHaveLength(1);
		expect((await element.actions.sendMessage('  ')).ok).toBe(false);
		await element.actions.sendMessage('Thanks');
		expect(element.state().active?.messages).toHaveLength(2);
		element.actions.closeClaim();
		expect(element.state().active).toBeNull();
		expect(events).toEqual(['claims.submitted', 'claims.message']);
		element.destroy();
		element.actions.closeClaim();
	});

	it('reports failures with the right messages', async () => {
		const element = createClaims({
			strings,
			client: createClient(
				identityRoutes({
					'GET /v1/claims': () => ({ error: { code: 'rate_limited' } }),
					'POST /v1/claim-photos': () => ({ error: { code: 'weird' } }),
					'POST /v1/claims': () => ({
						error: { code: 'not_eligible', errors: [{ path: '/lines/0', code: 'window_closed' }] },
					}),
					'GET /v1/claims/clm_x': () => ({ error: { code: 'not_found' } }),
					'POST /v1/messages': () => ({ error: { code: 'messages_closed' } }),
				}),
			),
			upload: async () => false,
		});
		await element.actions.load();
		expect(element.state().error).toBe('Too many attempts. Please try again in a minute.');
		await element.actions.addPhoto({ type: 'image/jpeg', size: 1, body: 'x' });
		expect(element.state()).toMatchObject({ upload: 'error', error: 'Something went wrong. Please try again.' });
		element.actions.selectPurchase('pur_1');
		element.actions.setDraft({ type: 'return', reason: 'defective', lineId: 'l1', quantity: 1 });
		await element.actions.submit();
		expect(element.state().errors[0]).toMatchObject({ code: 'window_closed', message: 'Please check this.' });
		await element.actions.openClaim('clm_x');
		expect(element.state().error).toContain('could not find');
		await element.actions.openClaim('clm_1');
		await element.actions.sendMessage('hi');
		expect(element.state().error).toBe('Messages are not available.');
		const broken = createClaims({ strings, client: createClient({}) });
		await broken.actions.load();
		expect(broken.state().status).toBe('error');
		const noPurchases = createClaims({
			strings,
			client: createClient({
				'GET /v1/claim-form': () => form(),
				'GET /v1/purchases': () => ({ error: { code: 'internal_error', status: 500 } }),
			}),
		});
		await noPurchases.actions.load();
		expect(noPurchases.state().status).toBe('error');
		const failedUpload = createClaims({
			strings,
			client: createClient(identityRoutes()),
			upload: async () => false,
		});
		await failedUpload.actions.addPhoto({ type: 'image/jpeg', size: 1, body: 'x' });
		expect(failedUpload.state().error).toBe('The photo could not be uploaded. Please try again.');
		expect(createClaims({ client: createClient({}) }).validate()).toEqual([]);
	});

	it('uploads through fetch by default', async () => {
		const original = globalThis.fetch;
		/** @type {any[]} */
		const calls = [];
		globalThis.fetch = /** @type {any} */ (
			async (/** @type {string} */ url, /** @type {any} */ init) => {
				calls.push({ url, init });
				if (url.includes('fail')) throw new Error('down');
				return { ok: true };
			}
		);
		try {
			const element = createClaims({ strings, client: createClient(identityRoutes()) });
			await element.actions.addPhoto({ type: 'image/jpeg', size: 10, body: 'x' });
			expect(calls[0].init.headers).toEqual({ 'content-type': 'image/jpeg' });
			const failing = createClaims({
				strings,
				client: createClient(
					identityRoutes({
						'POST /v1/claim-photos': () => ({ id: 'c', upload: { method: 'PUT', url: 'https://fail', headers: {} } }),
					}),
				),
			});
			await failing.actions.addPhoto({ type: 'image/jpeg', size: 10, body: 'x' });
			expect(failing.state().upload).toBe('error');
			globalThis.fetch = /** @type {any} */ (undefined);
			const none = createClaims({ strings, client: createClient(identityRoutes()) });
			await none.actions.addPhoto({ type: 'image/jpeg', size: 10, body: 'x' });
			expect(none.state().upload).toBe('error');
		} finally {
			globalThis.fetch = original;
		}
	});
});

describe('headless claims (guests)', () => {
	it('falls back to sign-in, takes a claim token, claims and talks through it', async () => {
		const routes = {
			'GET /v1/claim-form': () => form(),
			'GET /v1/purchases': () => ({ error: { code: 'identity_required', status: 401 } }),
			'POST /v1/claim-access': (/** @type {any} */ _q, /** @type {any} */ body) =>
				body.number === 'N-1' ? { token: 'ct1.tok', purchaseId: 'pur_1' } : { error: { code: 'not_found' } },
			'POST /v1/claims:view': (/** @type {any} */ _q, /** @type {any} */ body) =>
				body.token === 'ct1.tok'
					? { purchase, claims: [claim], ...(body.claimId ? { messages: [] } : {}) }
					: { error: { code: 'invalid_token' } },
			'POST /v1/claims': (/** @type {any} */ _q, /** @type {any} */ body) => ({
				...claim,
				reference: body.token ? 'CL-G' : 'CL-X',
			}),
			'POST /v1/messages': (/** @type {any} */ _q, /** @type {any} */ body) => ({
				id: 'm',
				author: 'customer',
				body: body.body,
				token: body.token,
			}),
			'POST /v1/claim-photos': (/** @type {any} */ _q, /** @type {any} */ body) => ({
				id: `ph_${body.token}`,
				upload: { method: 'PUT', url: 'u', headers: {} },
			}),
		};
		const client = createClient(routes);
		const element = createClaims({ strings, client, upload: async () => true });
		await element.actions.load();
		expect(element.state()).toMatchObject({ mode: 'signin', status: 'ready', error: null });
		await element.actions.access({ number: 'N-2', email: 'x@example.com' });
		expect(element.state().error).toContain('could not find');
		await element.actions.access({ number: 'N-1', email: 'a@example.com', phone: ' ' });
		expect(element.state()).toMatchObject({ mode: 'guest', token: 'ct1.tok' });
		expect(client.calls.find((c) => c.path === '/v1/claim-access' && c.body.number === 'N-1')?.body).toEqual({
			number: 'N-1',
			email: 'a@example.com',
		});
		await element.actions.addPhoto({ type: 'image/jpeg', size: 1, body: 'x' });
		expect(element.state().draft.photoIds).toEqual(['ph_ct1.tok']);
		element.actions.setDraft({ type: 'return', reason: 'defective', lineId: 'l1', quantity: 1 });
		await element.actions.submit();
		expect(element.state().message).toContain('CL-G');
		await element.actions.openClaim('clm_1');
		expect(element.state().active?.claim.id).toBe('clm_1');
		await element.actions.sendMessage('hi');
		expect(element.state().active?.messages).toHaveLength(1);
		await element.actions.openClaim('clm_missing');
		const expired = createClaims({ strings, client, config: { token: 'ct1.old' } });
		await expired.actions.load();
		expect(expired.state()).toMatchObject({
			mode: 'signin',
			token: null,
			error: 'This link has expired. Find your order again.',
		});
		const viewFail = createClaims({
			strings,
			client: createClient({ ...routes, 'POST /v1/claims:view': () => ({ error: { code: 'x' } }) }),
			config: { token: 'ct1.tok' },
		});
		await viewFail.actions.openClaim('clm_1');
		expect(viewFail.state().error).toBe('Something went wrong. Please try again.');
	});
});

describe('ui/claims renderer', () => {
	it('renders the guest access form and submits it', async () => {
		/** @type {any[]} */
		const accessed = [];
		const actions = /** @type {any} */ ({ access: (/** @type {any} */ v) => accessed.push(v) });
		const state = /** @type {any} */ ({
			status: 'ready',
			mode: 'signin',
			form: form(),
			purchases: [],
			claims: [],
			draft: {},
			errors: [],
			active: null,
			message: null,
			error: 'Oops',
		});
		const root = renderClaims({ state, actions, strings, dom: createFakeDom() });
		expect(root.attributes).toMatchObject({ role: 'region', 'aria-label': 'Returns and warranty' });
		const inputs = findAll(root, (n) => n.tag === 'input');
		expect(inputs.map((n) => n.attributes.name)).toEqual(['number', 'email', 'phone']);
		inputs[0].dispatch('input', { target: { value: 'N-1' } });
		inputs[1].dispatch('input', { target: { value: 'a@example.com' } });
		inputs[2].dispatch('input', {});
		const [formNode] = findAll(root, (n) => n.tag === 'form');
		formNode.dispatch('submit', { preventDefault: () => {} });
		expect(accessed).toEqual([{ number: 'N-1', email: 'a@example.com', phone: '' }]);
		expect(root.textContent).toContain('Oops');
		const signIn = renderClaims({
			state: { ...state, form: form({ guestAccess: false }), error: null, message: 'Hi' },
			actions,
			strings,
			dom: createFakeDom(),
		});
		expect(signIn.textContent).toContain('Sign in to see your orders');
		expect(signIn.textContent).toContain('Hi');
		const loading = renderClaims({
			state: { ...state, status: 'loading' },
			actions,
			strings,
			dom: createFakeDom(),
			slots: { before: createFakeDom().createTextNode('B') },
		});
		expect(loading.attributes['aria-busy']).toBe('true');
		expect(loading.textContent).toContain('Loading');
		expect(claimStyles).toContain('var(--ss-color-primary)');
		expect(claimStyles).not.toMatch(/#[0-9a-f]{3,6}\b/i);
	});

	it('renders the form and the claims with their conversation, wired to the actions', async () => {
		const client = createClient(identityRoutes());
		const element = createClaims({ strings, client, identity: 'yes', upload: async () => true });
		await element.actions.load();
		element.actions.selectPurchase('pur_1');
		element.actions.setDraft({ type: 'warranty' });
		await element.actions.openClaim('clm_1');
		const dom = createFakeDom();
		const root = renderClaims({ state: element.state(), actions: element.actions, strings, dom });
		const selects = findAll(root, (n) => n.tag === 'select');
		expect(selects).toHaveLength(3);
		selects[1].dispatch('change', { target: { value: 'return' } });
		selects[2].dispatch('change', { target: { value: 'defective' } });
		expect(element.state().draft).toMatchObject({ type: 'return', reason: 'defective' });
		const qty = findAll(root, (n) => n.attributes?.id === 'ss-claims-qty-l1')[0];
		qty.dispatch('change', { target: { value: '1' } });
		const serial = findAll(root, (n) => n.attributes?.id === 'ss-claims-serial-l1')[0];
		serial.dispatch('change', { target: { value: 'SN9' } });
		findAll(root, (n) => n.attributes?.id === 'ss-claims-details')[0].dispatch('change', { target: { value: 'Broken it is' } });
		findAll(root, (n) => n.attributes?.id === 'ss-claims-photo')[0].dispatch('change', {
			target: { files: [{ type: 'image/jpeg', size: 5 }] },
		});
		findAll(root, (n) => n.attributes?.id === 'ss-claims-photo')[0].dispatch('change', { target: { files: [] } });
		await tick();
		expect(element.state().draft).toMatchObject({
			quantities: { l1: 1 },
			serials: { l1: 'SN9' },
			details: 'Broken it is',
			photoIds: ['cph_1'],
		});
		expect(root.textContent).toContain('until 2027-10-01');
		expect(root.textContent).toContain('Store: Hello');
		findAll(root, (n) => n.attributes?.id === 'ss-claims-reply')[0].dispatch('input', { target: { value: 'Thanks!' } });
		const forms = findAll(root, (n) => n.tag === 'form');
		forms[1].dispatch('submit', { preventDefault: () => {} });
		await tick();
		expect(element.state().active?.messages).toHaveLength(2);
		selects[0].dispatch('change', { target: { value: 'pur_1' } });
		forms[0].dispatch('submit', { preventDefault: () => {} });
		await tick();
		const buttons = findAll(root, (n) => n.tag === 'button' && n.attributes.type === 'button');
		buttons[0].dispatch('click');
		const closed = renderClaims({ state: element.state(), actions: element.actions, strings, dom, theme: { variant: 'list' } });
		const open = findAll(closed, (n) => n.tag === 'button' && n.attributes.type === 'button')[0];
		open.dispatch('click');
		await tick();
		expect(element.state().active?.claim.id).toBe('clm_1');
		const formOnly = renderClaims({
			state: element.state(),
			actions: element.actions,
			strings,
			dom,
			theme: { variant: 'form' },
		});
		expect(formOnly.attributes.class).toContain('ss-claims--form');
		const empty = renderClaims({
			state: {
				...element.state(),
				claims: [],
				purchases: [],
				form: form({ photos: { enabled: false }, messages: { enabled: false } }),
			},
			actions: element.actions,
			strings,
			dom,
			slots: { empty: dom.createTextNode('Nothing') },
		});
		expect(empty.textContent).toContain('Nothing');
		const noLines = renderClaims({
			state: {
				...element.state(),
				purchases: [{ ...purchase, lines: [purchase.lines[1]] }],
				errors: [{ path: '/type', code: 'required', message: 'Pick one' }],
				submit: 'submitting',
				upload: 'uploading',
				active: { claim: { ...claim, history: undefined }, messages: [] },
				form: form({ messages: { enabled: true, customerCanWrite: false, maxLength: 1 } }),
			},
			actions: element.actions,
			strings,
			dom,
		});
		expect(noLines.textContent).toContain('Nothing in this order can be claimed for this.');
		expect(noLines.textContent).toContain('Pick one');
	});
});

describe('serial lookup', () => {
	it('validates, looks up and renders the cover', async () => {
		const client = createClient({
			'GET /v1/serials/SN-1': () => ({
				serial: 'SN-1',
				title: 'Phone',
				soldAt: '2026-01-02T00:00:00Z',
				cover: [
					{ type: 'warranty', label: 'Warranty', active: true, endsAt: '2027-01-02T00:00:00Z' },
					{ type: 'return', label: 'Return', active: false, endsAt: null },
				],
			}),
			'GET /v1/serials/BAD': () => ({ error: { code: 'internal_error', status: 500 } }),
		});
		/** @type {string[]} */
		const events = [];
		const element = createSerialLookup({
			strings,
			client,
			config: { min_length: 2, max_length: 8 },
			emit: (name) => events.push(name),
		});
		const unsubscribe = element.subscribe(() => {});
		element.actions.setSerial('x');
		await element.actions.lookup();
		expect(element.state().error).toBe('This serial number is too short.');
		expect(element.validate('123456789')[0]?.code).toBe('too_long');
		element.actions.setSerial('SN-1');
		await element.actions.lookup();
		expect(element.state().status).toBe('found');
		expect(element.state().cover.map((c) => c.text)).toEqual(['Warranty: covered until 2027-01-02', 'Return: not covered']);
		expect(events).toEqual(['serial_registry.looked_up']);
		const dom = createFakeDom();
		const root = renderSerials({ state: element.state(), actions: element.actions, strings, dom });
		expect(root.attributes.role).toBe('search');
		expect(root.textContent).toContain('Sold on 2026-01-02');
		findAll(root, (n) => n.tag === 'input')[0].dispatch('input', { target: { value: 'NOPE' } });
		findAll(root, (n) => n.tag === 'form')[0].dispatch('submit', { preventDefault: () => {} });
		await tick();
		expect(element.state()).toMatchObject({ status: 'not_found', error: 'We could not find this serial number.' });
		expect(renderSerials({ state: element.state(), actions: element.actions, strings, dom }).textContent).toContain(
			'could not find',
		);
		element.actions.setSerial('BAD');
		await element.actions.lookup();
		expect(element.state().error).toBe('The check failed. Please try again.');
		element.actions.reset();
		expect(
			renderSerials({ state: { ...element.state(), status: 'loading' }, actions: element.actions, strings, dom }).textContent,
		).toBe('Serial numberCheck');
		const found = {
			...element.state(),
			status: /** @type {const} */ ('found'),
			result: { serial: 'S', title: null, soldAt: null },
			cover: [],
		};
		expect(renderSerials({ state: found, actions: element.actions, strings, dom }).textContent).toContain('S');
		unsubscribe();
		element.destroy();
		element.actions.reset();
		expect(createSerialLookup({ client }).validate('')[0]?.code).toBe('too_short');
		expect(serialStyles).toContain('var(--ss-color-success)');
	});
});
