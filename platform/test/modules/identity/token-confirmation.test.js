/**
 * Showing or renewing a server token needs more than a session (SEC): the right to (the Owner, and the merchant for its
 * own website; never Support or Finance) and a fresh confirmation (the person's current password, and a code while
 * two-step is on), and every one is logged. A stolen session cookie shows nothing.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { manifest as notesManifest } from '@ss/contracts/testing';
import { closeMongoClients } from '../../../src/testing.js';
import { startMongo } from '../../helpers.js';
import { PASSWORD, bootPortal, codeOf } from '../catalog/boot.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

/** @type {Awaited<ReturnType<typeof startMongo>>} */
let mongo;
/** @type {Array<() => Promise<unknown>>} */
const cleanups = [];
beforeAll(async () => {
	mongo = await startMongo();
}, 180_000);
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});
afterAll(async () => {
	await closeMongoClients();
	await mongo?.stop();
});

const setUp = async () => {
	const h = await bootPortal({ db: mongo.db('token_confirmation') });
	cleanups.push(h.close);
	const owner = await h.owner();
	await h.connect(notesManifest());
	const m = await h.merchant('m@shop.test', ['shop.example.com']);
	const site = `/v1/merchants/${m.merchantId}/websites/${m.websiteIds[0]}`;
	await owner.post(`${site}/products`, { productId: 'notes' });
	return { h, owner, m, site };
};

describe('a server token is shown or renewed after a fresh confirmation', () => {
	it('refuses a session alone, a wrong password and a body that is not a confirmation; shows it for the right password', async () => {
		const { h, owner, m, site } = await setUp();
		const reveal = `${site}/tokens/notes/reveal`;
		// the session alone (a stolen cookie)
		expect(codeOf(await owner.post(reveal))).toEqual([422, 'validation_failed']);
		expect(codeOf(await owner.post(reveal, {}))).toEqual([422, 'validation_failed']);
		expect(codeOf(await m.client.post(reveal))).toEqual([422, 'validation_failed']);
		// a wrong password shows nothing
		const wrong = await owner.post(reveal, { password: 'not the password' });
		expect(wrong.status).toBeGreaterThanOrEqual(400);
		expect(JSON.stringify(wrong.json)).not.toContain('serverToken');
		expect((await h.activity('token.revealed')).length).toBe(0);
		// the right password shows it, and it is logged
		const shown = await owner.post(reveal, { password: PASSWORD });
		expect(shown.status).toBe(200);
		expect(typeof shown.json.serverToken).toBe('string');
		expect((await h.activity('token.revealed')).length).toBe(1);
		// the merchant, for its own website, the same
		expect(codeOf(await m.client.post(reveal, { password: 'nope' }))[0]).toBeGreaterThanOrEqual(400);
		expect((await m.client.post(reveal, { password: PASSWORD })).json.serverToken).toBe(shown.json.serverToken);
	});

	it('is the same for renewing: no password, no new token and the old one stays', async () => {
		const { h, owner, site } = await setUp();
		const regenerate = `${site}/tokens/notes/regenerate`;
		expect(codeOf(await owner.post(regenerate, { kind: 'server' }))).toEqual([422, 'validation_failed']);
		const wrong = await owner.post(regenerate, { kind: 'server', password: 'not the password' });
		expect(wrong.status).toBeGreaterThanOrEqual(400);
		expect((await h.activity('token.regenerated')).length).toBe(0);
		expect((await owner.post(regenerate, { kind: 'server', password: PASSWORD })).status).toBe(200);
		expect((await h.activity('token.regenerated')).length).toBe(1);
	});

	it('is the Owner’s: Support and Finance are refused before their password is even looked at', async () => {
		const { h, site } = await setUp();
		for (const role of /** @type {const} */ (['support', 'finance'])) {
			const admin = await h.admin(role);
			for (const [path, body] of /** @type {Array<[string, object]>} */ ([
				[`${site}/tokens/notes/reveal`, { password: PASSWORD }],
				[`${site}/tokens/notes/regenerate`, { kind: 'server', password: PASSWORD }],
			]))
				expect([role, codeOf(await admin.client.post(path, body))]).toEqual([role, [403, 'forbidden']]);
		}
	});

	it('cannot be guessed at: repeated wrong passwords lock the person out of confirming', async () => {
		const { owner, site } = await setUp();
		const reveal = `${site}/tokens/notes/reveal`;
		/** @type {number[]} */
		const statuses = [];
		for (let i = 0; i < 8; i += 1) statuses.push((await owner.post(reveal, { password: `guess ${i}` })).status);
		expect(statuses.at(-1)).toBe(429);
		// even the right password waits while locked
		expect((await owner.post(reveal, { password: PASSWORD })).status).toBe(429);
	});
});
