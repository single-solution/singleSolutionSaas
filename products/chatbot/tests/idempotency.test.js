/** Idempotency-Keys are scoped to the caller: one visitor reusing another's key never sees or changes their records. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, WEBSITE } from './harness.js';

const DAY_AND_HOUR = 25 * 3_600_000; // past app-kit's 24 h duplicate refusal

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
beforeAll(async () => {
	h = await createHarness();
});
afterAll(async () => {
	await h?.close();
});

/** Move past the kit's duplicate window and refresh the (short-lived) entitlement. */
const later = async () => {
	h.clock.advance(DAY_AND_HOUR);
	await h.entitle();
};

describe('caller-scoped Idempotency-Keys', () => {
	it('gives an anonymous visitor reusing another visitor’s key a fresh conversation and guest marker', async () => {
		const first = await h.browser('POST', '/v1/conversations', { body: {}, idempotencyKey: 'shared-start' });
		expect(first.status).toBe(201);
		await later();
		const second = await h.browser('POST', '/v1/conversations', { body: {}, idempotencyKey: 'shared-start' });
		expect(second.status).toBe(201);
		expect(second.json.conversation.id).not.toBe(first.json.conversation.id);
		expect(second.json.marker.token).not.toBe(first.json.marker.token);
		// the second visitor cannot read the first conversation with its marker
		const peek = await h.browser('GET', `/v1/conversations/${first.json.conversation.id}`, {
			identity: second.json.marker.token,
		});
		expect(peek.status).toBe(404);
		const stored = await h.collection('conversations').findOne({ websiteId: WEBSITE, id: first.json.conversation.id });
		const visitorOf = /** @type {any} */ (stored)?.visitorId;
		expect(visitorOf).toBeTruthy();
		const other = await h.collection('conversations').findOne({ websiteId: WEBSITE, id: second.json.conversation.id });
		expect(/** @type {any} */ (other)?.visitorId).not.toBe(visitorOf);
	});

	it('keeps two guests with markers apart under the same key, and converges a guest’s own retry', async () => {
		const a = (await h.browser('POST', '/v1/conversations', { body: {} })).json.marker.token;
		const b = (await h.browser('POST', '/v1/conversations', { body: {} })).json.marker.token;
		const mine = await h.browser('POST', '/v1/conversations', { identity: a, body: {}, idempotencyKey: 'guest-key' });
		expect(mine.status).toBe(201);
		await later();
		const theirs = await h.browser('POST', '/v1/conversations', { identity: b, body: {}, idempotencyKey: 'guest-key' });
		expect(theirs.status).toBe(201);
		expect(theirs.json.conversation.id).not.toBe(mine.json.conversation.id);
		await later();
		const retry = await h.browser('POST', '/v1/conversations', { identity: a, body: {}, idempotencyKey: 'guest-key' });
		expect(retry.json.conversation.id).toBe(mine.json.conversation.id);
	});
});
