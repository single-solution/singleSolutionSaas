// @vitest-environment jsdom
/**
 * The order flow editor in the browser (jsdom) on a faked dashboard API (PLAN 0.8.10 dynamic model phase 2): it shows
 * the saved flow, changes a move's options, who may make it and what it needs, a status's names for shoppers and the
 * flow's triggers and starts, and saves every field of the flow with one PUT.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { byLabel, byText, cleanup, click, render, type } from '@ss/ui/testing';
import { OrderFlowEditor } from '../app/dashboard/flow-editor.js';
import { DEFAULT_FLOW, checkOrderFlow } from '../core/flow.js';
import { defaultPaymentMethods } from '../core/payment-methods.js';

const WEBSITE = 'web_1';
const PATH = `/v1/dashboard/websites/${WEBSITE}/lists/order_flow`;

/** The flows the editor saved. @type {any[]} */
let saved = [];

/** The dashboard API: the saved flow, and a save that answers what it was sent (checked as the server does). */
const serve = () => {
	saved = [];
	/** @type {any} */
	let flow = structuredClone(DEFAULT_FLOW);
	vi.stubGlobal(
		'fetch',
		vi.fn(async (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) => {
			// the website's payment methods name the shopper lines (today's four)
			if (path === `/v1/dashboard/websites/${WEBSITE}/lists/payment_methods`)
				return new Response(JSON.stringify({ value: defaultPaymentMethods() }), { status: 200 });
			if (path !== PATH) return new Response(JSON.stringify({ status: 404 }), { status: 404 });
			if (init.method === 'PUT') {
				const { value } = JSON.parse(String(init.body));
				saved.push(value);
				const checked = checkOrderFlow(value);
				if (!checked.ok) return new Response(JSON.stringify({ status: 422, errors: checked.errors }), { status: 422 });
				flow = checked.value;
			}
			return new Response(JSON.stringify({ value: flow }), { status: 200 });
		}),
	);
};

/** Let the loads answer. */
const settle = async () => {
	for (let i = 0; i < 6; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('the order flow editor', () => {
	it('changes a move’s options, who makes it and what it needs, a status’s shopper names, triggers and starts', async () => {
		serve();
		const { container } = render(<OrderFlowEditor websiteId={WEBSITE} />);
		await settle();
		// the saved flow: every status with its staff name
		for (const status of DEFAULT_FLOW.statuses) expect(container.textContent).toContain(status.label);
		// a cancel says it also needs the refund permission when it gives money back (review H2)
		expect(container.textContent).toContain('A cancel that gives back money paid also needs Refund orders.');
		// into dispatched the tracking number is optional (attachments are the attachment_kinds list's, E20)
		expect(container.textContent).not.toContain('Dispatch video');
		type(byLabel(container, 'Tracking number'), 'optional');
		// the shopper's name of the packed status and its line for cash on delivery
		const packed = DEFAULT_FLOW.statuses.findIndex((status) => status.key === 'packed');
		const names = /** @type {HTMLInputElement[]} */ ([...container.querySelectorAll('input[maxlength="60"]')]).filter((input) =>
			input.closest('details'),
		);
		type(/** @type {HTMLInputElement} */ (names[packed]), 'Getting ready');
		// a line per payment method of the website's list, by its name
		type(byLabel(container, 'Paid by Cash on delivery'), 'Pay the rider');
		// delivering leaves the money of orders paid on delivery to staff (decision 11)
		type(byLabel(container, 'Orders paid on delivery or at pickup'), 'no');
		// refunds that cover the payments move the order to refunded; cash on delivery starts confirmed
		type(byLabel(container, 'When refunds reach what was paid, move to'), 'refunded');
		type(byLabel(container, 'Orders paid on delivery'), 'confirmed');
		await act(async () => click(byText(container, 'Save', 'button')));
		await settle();
		expect(saved).toHaveLength(1);
		const value = saved[0];
		/** @param {string} from @param {string} to */
		const move = (from, to) => value.moves.find((/** @type {any} */ entry) => entry.from === from && entry.to === to);
		expect(move('confirmed', 'packed').options?.video).toBeUndefined();
		expect(move('packed', 'dispatched').options).toMatchObject({ tracking: 'optional' });
		expect(value.statuses[packed]).toMatchObject({ key: 'packed', shopperLabel: 'Getting ready' });
		expect(value.triggers).toMatchObject({ refundsCover: 'refunded' });
		expect(value.starts).toMatchObject({ on_delivery: 'confirmed' });
		expect(value.statuses.find((/** @type {any} */ status) => status.shopperText?.cod)?.shopperText).toEqual({
			cod: 'Pay the rider',
		});
		expect(value.moves.find((/** @type {any} */ entry) => entry.options?.paidOnDelivery === 'no')).toBeTruthy();
		// the server takes it as it is: nothing was dropped
		expect(checkOrderFlow(value).ok).toBe(true);
	});

	it('adds a status keyed from its name and a move to it', async () => {
		serve();
		const { container } = render(<OrderFlowEditor websiteId={WEBSITE} />);
		await settle();
		await act(async () => click(byText(container, 'Add', 'button')));
		const added = DEFAULT_FLOW.statuses.length;
		const labels = /** @type {HTMLInputElement[]} */ ([...container.querySelectorAll('input')]).filter(
			(input) => input.getAttribute('maxlength') === '60' && !input.closest('details'),
		);
		type(/** @type {HTMLInputElement} */ (labels[added]), 'On hold');
		await act(async () => click(byText(container, 'Save', 'button')));
		await settle();
		expect(saved[0].statuses[added]).toMatchObject({ key: 'on_hold', label: 'On hold', role: 'open' });
	});
});
