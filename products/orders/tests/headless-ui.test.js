/** Mode B headless cores (state machines on a scripted client) and Mode A renderers (structure, a11y, variants, slots). */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createOrderTracker } from '../headless/orderTracker.js';
import { createReceipt } from '../headless/receipt.js';
import { createTracking } from '../headless/tracking.js';
import { createStore } from '../headless/store.js';
import * as trackerUi from '../ui/orderTracker.js';
import * as receiptUi from '../ui/receipt.js';
import * as trackingUi from '../ui/tracking.js';
import { createFakeDom, findAll } from './helpers.js';

const strings = JSON.parse(readFileSync(new URL('../strings/en.json', import.meta.url), 'utf8'));
const dom = createFakeDom();

/**
 * A scripted client: `routes['GET /v1/x']` → value, `{ error }` for a failure.
 * @param {Record<string, (input: any) => any>} routes
 * @returns {any}
 */
const createClient = (routes) => {
	/** @type {Array<{ method: string, path: string, input: any }>} */
	const calls = [];
	/** @param {string} method @param {string} path @param {any} input */
	const run = async (method, path, input) => {
		calls.push({ method, path, input });
		const route = routes[`${method} ${path}`];
		if (!route) return { ok: false, error: { code: 'not_found' } };
		const value = route(input);
		return value && value.error ? { ok: false, error: value.error } : { ok: true, value };
	};
	return {
		calls,
		/** @param {string} path @param {any} [options] */
		get: (path, options = {}) => run('GET', path, options.query ?? {}),
		/** @param {string} path @param {any} [body] */
		post: (path, body) => run('POST', path, body),
	};
};

/** @param {string} id @param {Record<string, any>} [extra] */
const summary = (id, extra = {}) => ({
	id,
	number: `N-${id}`,
	status: 'pending_payment',
	statusLabel: 'Awaiting payment',
	placedAt: '2026-10-01T10:00:00.000Z',
	canCancel: true,
	...extra,
});
/** @param {string} id @param {Record<string, any>} [extra] */
const detail = (id, extra = {}) => ({
	...summary(id),
	lines: [{ id: 'l1', title: 'Lamp', quantity: 2 }],
	timeline: [{ status: 'pending_payment', statusLabel: 'Awaiting payment', at: '2026-10-01T10:00:00.000Z' }],
	tracking: { carrier: 'Parcel Co', trackingNumber: 'PC1', trackingUrl: 'https://track.example.com/PC1' },
	...extra,
});

describe('store', () => {
	it('freezes snapshots, notifies and stops after destroy', () => {
		const store = createStore({ n: 1 });
		const seen = vi.fn();
		const off = store.subscribe(seen);
		store.set({ n: 2 });
		off();
		store.set({ n: 3 });
		expect(seen).toHaveBeenCalledTimes(1);
		store.destroy();
		store.set({ n: 4 });
		expect(store.get().n).toBe(3);
		expect(store.isDestroyed()).toBe(true);
	});
});

describe('order tracker (lifecycle)', () => {
	it('loads pages, opens an order, cancels it, and renders both views', async () => {
		const client = createClient({
			'GET /v1/my-orders': (q) =>
				q.cursor ? { items: [summary('o2')], nextCursor: null } : { items: [summary('o1')], nextCursor: 'c1' },
			'GET /v1/my-orders/o1': () => detail('o1'),
			'POST /v1/my-orders/o1/cancel': () => detail('o1', { status: 'cancelled', statusLabel: 'Cancelled', canCancel: false }),
		});
		const emit = vi.fn();
		const tracker = createOrderTracker({ config: { customer_page_size: 5 }, strings, client, emit });
		expect(tracker.validate()).toEqual([]);
		expect((await tracker.actions.cancel()).ok).toBe(false);
		await tracker.actions.load();
		expect(client.calls[0].input).toEqual({ limit: 5 });
		const list = trackerUi.render({
			state: tracker.state(),
			actions: tracker.actions,
			strings,
			dom,
			slots: { before: dom.createTextNode('B') },
		});
		expect(list.attributes['aria-label']).toBe('Your orders');
		const more = findAll(list, (n) => n.tag === 'button' && n.textContent === 'More orders')[0];
		more.dispatch('click');
		await new Promise((r) => setTimeout(r, 0));
		expect(tracker.state().orders).toHaveLength(2);
		expect((await tracker.actions.loadMore()).ok).toBe(false);
		expect((await tracker.actions.select('nope')).ok).toBe(false);
		await tracker.actions.select('o1');
		const open = trackerUi.render({
			state: tracker.state(),
			actions: tracker.actions,
			strings,
			dom,
			theme: { variant: 'compact' },
		});
		expect(open.attributes.class).toContain('ss-orders--compact');
		expect(findAll(open, (n) => n.tag === 'a')[0].attributes.href).toBe('https://track.example.com/PC1');
		await tracker.actions.cancel();
		expect(tracker.state()).toMatchObject({ notice: 'The order is cancelled.', selected: { status: 'cancelled' } });
		expect(tracker.state().orders[0]?.canCancel).toBe(false);
		expect((await tracker.actions.cancel()).ok).toBe(false);
		expect(emit).toHaveBeenCalledWith('cancelled', { orderId: 'o1' });
		const closed = trackerUi.render({ state: tracker.state(), actions: tracker.actions, strings, dom });
		expect(closed).toBeTruthy();
		tracker.actions.close();
		expect(tracker.state().selected).toBeNull();
		tracker.destroy();
	});

	it('handles a signed-out customer, errors and an empty list', async () => {
		const signedOut = createOrderTracker({
			strings,
			client: createClient({ 'GET /v1/my-orders': () => ({ error: { code: 'identity_required' } }) }),
		});
		await signedOut.actions.load();
		expect(signedOut.state()).toMatchObject({ status: 'signed_out', error: 'Sign in to see your orders.' });
		const broken = createOrderTracker({ strings, client: createClient({}) });
		await broken.actions.load();
		expect(broken.state().status).toBe('error');
		const empty = createOrderTracker({
			strings,
			client: createClient({ 'GET /v1/my-orders': () => ({ items: [], nextCursor: null }) }),
		});
		await empty.actions.load();
		const view = trackerUi.render({ state: empty.state(), actions: empty.actions, strings, dom });
		expect(view.textContent).toContain('You have no orders yet.');
		const failing = createClient({
			'GET /v1/my-orders': (q) =>
				q.cursor ? { error: { code: 'internal_error' } } : { items: [summary('o1', { canCancel: false })], nextCursor: 'c' },
			'GET /v1/my-orders/o1': () =>
				detail('o1', { canCancel: false, tracking: { carrier: null, trackingNumber: 'X', trackingUrl: null } }),
		});
		const tracker = createOrderTracker({ strings, client: failing });
		await tracker.actions.load();
		await tracker.actions.loadMore();
		expect(tracker.state()).toMatchObject({ status: 'ready', error: 'Your orders could not be loaded.' });
		await tracker.actions.select('o1');
		expect((await tracker.actions.cancel()).ok).toBe(false);
		const rendered = trackerUi.render({ state: tracker.state(), actions: tracker.actions, strings, dom });
		expect(findAll(rendered, (n) => n.tag === 'a')).toHaveLength(0);
		const selectFails = createOrderTracker({
			strings,
			client: createClient({
				'GET /v1/my-orders': () => ({ items: [summary('o9')], nextCursor: null }),
				'GET /v1/my-orders/o9': () => ({ error: { code: 'not_found' } }),
			}),
		});
		await selectFails.actions.load();
		await selectFails.actions.select('o9');
		expect(selectFails.state().error).toBeTruthy();
		const cancelFails = createOrderTracker({
			strings,
			client: createClient({
				'GET /v1/my-orders': () => ({ items: [summary('o3')], nextCursor: null }),
				'GET /v1/my-orders/o3': () => detail('o3'),
			}),
		});
		await cancelFails.actions.load();
		await cancelFails.actions.select('o3');
		await cancelFails.actions.cancel();
		expect(cancelFails.state().error).toBe('The order could not be cancelled.');
	});
});

describe('tracking (fulfilment)', () => {
	it('validates, looks up and renders the result', async () => {
		const client = createClient({
			'POST /v1/tracking-lookups': (body) =>
				body.number === 'N1'
					? {
							status: 'dispatched',
							statusLabel: 'Dispatched',
							tracking: { carrier: 'Parcel Co', trackingNumber: 'PC1', trackingUrl: 'https://t.example.com/PC1' },
							timeline: [{ statusLabel: 'Dispatched', at: '2026-10-01' }],
						}
					: body.number === 'N2'
						? {
								status: 'confirmed',
								statusLabel: 'Confirmed',
								tracking: { carrier: null, trackingNumber: 'X1', trackingUrl: null },
							}
						: { error: { code: body.number === 'BAD' ? 'internal_error' : 'not_found' } },
		});
		const tracking = createTracking({ strings, client });
		expect(tracking.validate()).toHaveLength(2);
		expect((await tracking.actions.lookup()).ok).toBe(false);
		expect(tracking.state().error).toBe('Enter the order number.');
		const form = trackingUi.render({ state: tracking.state(), actions: tracking.actions, strings, dom });
		const inputs = findAll(form, (n) => n.tag === 'input');
		inputs[0].dispatch('input', { target: { value: 'N1' } });
		inputs[1].dispatch('input', { target: { value: 'ada@example.com' } });
		findAll(form, (n) => n.tag === 'form')[0].dispatch('submit', { preventDefault: () => {} });
		await new Promise((r) => setTimeout(r, 0));
		expect(tracking.state().status).toBe('ready');
		const result = trackingUi.render({
			state: tracking.state(),
			actions: tracking.actions,
			strings,
			dom,
			theme: { variant: 'inline' },
		});
		expect(findAll(result, (n) => n.tag === 'a')[0].attributes.href).toBe('https://t.example.com/PC1');
		tracking.actions.setNumber('N2');
		await tracking.actions.lookup();
		expect(trackingUi.render({ state: tracking.state(), actions: tracking.actions, strings, dom }).textContent).toContain('X1');
		tracking.actions.setNumber('N3');
		await tracking.actions.lookup();
		expect(tracking.state()).toMatchObject({ status: 'not_found', error: 'No order matches this number and contact.' });
		tracking.actions.setNumber('BAD');
		await tracking.actions.lookup();
		expect(tracking.state().status).toBe('error');
		tracking.actions.reset();
		expect(tracking.state().status).toBe('idle');
	});
});

describe('receipt (invoices)', () => {
	it('loads the receipt and renders it in a sandboxed frame', async () => {
		const client = createClient({
			'GET /v1/my-orders/o1/receipt': () => ({ title: 'Invoice INV-1', html: '<p>x</p>' }),
			'GET /v1/my-orders/o2/receipt': () => ({ error: { code: 'identity_required' } }),
		});
		const receipt = createReceipt({ strings, client });
		expect(receipt.validate()).toEqual([]);
		expect((await receipt.actions.load('')).ok).toBe(false);
		const idle = receiptUi.render({ state: receipt.state(), actions: receipt.actions, strings, dom, theme: { orderId: 'o1' } });
		findAll(idle, (n) => n.tag === 'button')[0].dispatch('click');
		await new Promise((r) => setTimeout(r, 0));
		expect(client.calls[0].input).toEqual({ format: 'json' });
		const shown = receiptUi.render({
			state: receipt.state(),
			actions: receipt.actions,
			strings,
			dom,
			theme: { variant: 'inline' },
		});
		const frame = findAll(shown, (n) => n.tag === 'iframe')[0];
		expect(frame.attributes).toMatchObject({ sandbox: 'allow-modals', srcdoc: '<p>x</p>', title: 'Invoice INV-1' });
		frame.contentWindow = {
			print: () => {
				throw new Error('blocked');
			},
		};
		findAll(shown, (n) => n.tag === 'button')[0].dispatch('click');
		await receipt.actions.load('o2');
		expect(receipt.state().error).toBe('Sign in to see your receipt.');
		await receipt.actions.load('o3');
		expect(receipt.state().error).toBe('The receipt could not be loaded.');
		receipt.actions.clear();
		expect(receipt.state().status).toBe('idle');
	});
});
