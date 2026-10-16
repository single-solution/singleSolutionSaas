import { describe, expect, it, vi } from 'vitest';
import { REFRESH_BEFORE_MS, adminCall, createTicketSource, requestJson } from '../src/widget.js';

const BASE = 'https://product.example.dev';
const NOW = Date.parse('2026-10-15T10:00:00.000Z');

/** @param {number} minutes */
const expiresIn = (minutes) => new Date(NOW + minutes * 60_000).toISOString();

/** A scheduler the test runs by hand. */
const manualClock = () => {
	/** @type {Map<number, { task: () => void, ms: number }>} */
	const tasks = new Map();
	let ids = 0;
	return {
		tasks,
		/** @param {() => void} task @param {number} ms */
		schedule: (task, ms) => {
			ids += 1;
			tasks.set(ids, { task, ms });
			return ids;
		},
		/** @param {number} id */
		cancel: (id) => void tasks.delete(id),
		/** Runs the tasks due now and waits for what they started. */
		run: async () => {
			const due = [...tasks.entries()];
			tasks.clear();
			for (const [, { task }] of due) task();
			await new Promise((resolve) => setTimeout(resolve, 0));
		},
	};
};

/** @param {number} status @param {unknown} [body] */
const reply = (status, body) =>
	new Response(body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body), { status });

describe('requestJson', () => {
	it('sends a body as JSON with the given headers and answers the parsed body', async () => {
		const fetch = vi.fn().mockResolvedValue(reply(201, { id: 'a1' }));
		expect(
			await requestJson(fetch, `${BASE}/x`, { method: 'POST', headers: { authorization: 'Bearer t' }, body: { a: 1 } }),
		).toEqual({ ok: true, status: 201, data: { id: 'a1' } });
		expect(fetch).toHaveBeenCalledWith(`${BASE}/x`, {
			method: 'POST',
			headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
			body: '{"a":1}',
		});
	});

	it('is a GET without a body by default, and answers null data for a 204 or a body that is not JSON', async () => {
		const fetch = vi.fn().mockResolvedValueOnce(reply(204)).mockResolvedValueOnce(reply(502, 'Bad gateway'));
		expect(await requestJson(fetch, `${BASE}/x`)).toEqual({ ok: true, status: 204, data: null });
		expect(fetch).toHaveBeenCalledWith(`${BASE}/x`, { method: 'GET', headers: {} });
		expect(await requestJson(fetch, `${BASE}/x`)).toEqual({ ok: false, status: 502, data: null });
	});

	it('answers status 0 when the server cannot be reached', async () => {
		const fetch = vi.fn().mockRejectedValue(new TypeError('offline'));
		expect(await requestJson(fetch, `${BASE}/x`)).toEqual({ ok: false, status: 0, data: null });
	});
});

describe('createTicketSource', () => {
	it('renews the ticket 1 minute before it expires and is signed out when the page cannot give one', async () => {
		const clock = manualClock();
		const getTicket = vi
			.fn()
			.mockResolvedValueOnce({ ticket: 't2', expiresAt: expiresIn(30) })
			.mockRejectedValueOnce(new Error('signed out'));
		const tickets = createTicketSource({
			first: { ticket: 't1', expiresAt: expiresIn(15) },
			getTicket,
			...clock,
			now: () => NOW,
		});
		/** @type {boolean[]} */
		const seen = [];
		const off = tickets.onChange((signedIn) => seen.push(signedIn));
		expect(tickets.current()).toBe('t1');
		expect([...clock.tasks.values()].map(({ ms }) => ms)).toEqual([15 * 60_000 - REFRESH_BEFORE_MS]);
		await clock.run();
		expect(tickets.current()).toBe('t2');
		expect([...clock.tasks.values()].map(({ ms }) => ms)).toEqual([30 * 60_000 - REFRESH_BEFORE_MS]);
		await clock.run();
		expect(tickets.current()).toBeNull();
		expect(seen).toEqual([true, false]);
		expect(clock.tasks.size).toBe(0);
		off();
		tickets.stop();
	});

	it('treats an answer without a ticket as signed out and renews at once a ticket that is almost expired', async () => {
		const clock = manualClock();
		const getTicket = vi.fn().mockResolvedValue({ expiresAt: expiresIn(15) });
		const tickets = createTicketSource({
			first: { ticket: 't1', expiresAt: expiresIn(0.5) },
			getTicket,
			...clock,
			now: () => NOW,
		});
		expect([...clock.tasks.values()].map(({ ms }) => ms)).toEqual([0]);
		await clock.run();
		expect(tickets.current()).toBeNull();
	});

	it('stops renewing: the timer is canceled', () => {
		const clock = manualClock();
		const tickets = createTicketSource({
			first: { ticket: 't1', expiresAt: expiresIn(15) },
			getTicket: vi.fn(),
			...clock,
			now: () => NOW,
		});
		tickets.stop();
		expect(clock.tasks.size).toBe(0);
	});

	it('does not renew again after stop() when a renewal was on its way', async () => {
		const clock = manualClock();
		/** @type {(ticket: { ticket: string, expiresAt: string }) => void} */
		let answer = () => {};
		const getTicket = vi.fn(() => new Promise((resolve) => (answer = resolve)));
		const tickets = createTicketSource({
			first: { ticket: 't1', expiresAt: expiresIn(15) },
			getTicket: /** @type {any} */ (getTicket),
			...clock,
			now: () => NOW,
		});
		await clock.run();
		expect(getTicket).toHaveBeenCalledTimes(1);
		tickets.stop();
		answer({ ticket: 't2', expiresAt: expiresIn(30) });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(clock.tasks.size).toBe(0);
	});

	it('is signed out, without asking again and again, for a ticket whose expiry is not a time', async () => {
		const clock = manualClock();
		const getTicket = vi.fn().mockResolvedValue({ ticket: 't2', expiresAt: '' });
		const tickets = createTicketSource({
			first: { ticket: 't1', expiresAt: expiresIn(15) },
			getTicket,
			...clock,
			now: () => NOW,
		});
		/** @type {boolean[]} */
		const seen = [];
		tickets.onChange((signedIn) => seen.push(signedIn));
		await clock.run();
		expect(tickets.current()).toBeNull();
		expect(seen).toEqual([false]);
		expect(clock.tasks.size).toBe(0);
		const unknown = createTicketSource({ first: { ticket: 't1', expiresAt: 'soon' }, getTicket, ...clock, now: () => NOW });
		expect(unknown.current()).toBeNull();
		expect(clock.tasks.size).toBe(0);
	});
});

describe('adminCall', () => {
	it('calls an admin route with the current ticket', async () => {
		const fetch = vi.fn().mockResolvedValue(reply(200, { items: [] }));
		const tickets = createTicketSource({
			first: { ticket: 't1', expiresAt: expiresIn(15) },
			getTicket: vi.fn(),
			...manualClock(),
			now: () => NOW,
		});
		expect(await adminCall({ base: BASE, tickets, fetch }, 'PATCH', '/v1/admin/items/a1', { name: 'A' })).toEqual({
			ok: true,
			status: 200,
			data: { items: [] },
		});
		expect(fetch).toHaveBeenCalledWith(`${BASE}/v1/admin/items/a1`, {
			method: 'PATCH',
			headers: { authorization: 'Bearer t1', 'content-type': 'application/json' },
			body: '{"name":"A"}',
		});
	});

	it('answers status 0 without calling when signed out', async () => {
		const fetch = vi.fn();
		const tickets = /** @type {import('../src/widget.js').TicketSource} */ ({
			current: () => null,
			onChange: () => () => true,
			stop: () => {},
		});
		expect(await adminCall({ base: BASE, tickets, fetch }, 'GET', '/v1/admin/items')).toEqual({
			ok: false,
			status: 0,
			data: null,
		});
		expect(fetch).not.toHaveBeenCalled();
	});
});
