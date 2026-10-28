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
	it('refuses a session alone, password alone, and wrong code; shows it for the right otp code', async () => {
		const { h, owner, m, site } = await setUp();
		const reveal = `${site}/tokens/notes/reveal`;
		// the session alone (a stolen cookie)
		expect(codeOf(await owner.post(reveal))).toEqual([422, 'validation_failed']);
		expect(codeOf(await owner.post(reveal, {}))).toEqual([422, 'validation_failed']);
		expect(codeOf(await m.client.post(reveal))).toEqual([422, 'validation_failed']);
		// password alone fails (A5: otpOnly on reveal/regenerate)
		expect(codeOf(await owner.post(reveal, { password: PASSWORD }))).toEqual([422, 'validation_failed']);
		// a wrong code shows nothing
		const wrong = await owner.post(reveal, { code: '000000' });
		expect(wrong.status).toBeGreaterThanOrEqual(400);
		expect(JSON.stringify(wrong.json)).not.toContain('serverToken');
		expect((await h.activity('token.revealed')).length).toBe(0);
		// the right code shows it, and it is logged
		const ownerCode = await h.confirmOtp(owner, 'owner@portal.test');
		const shown = await owner.post(reveal, ownerCode);
		expect(shown.status).toBe(200);
		expect(typeof shown.json.serverToken).toBe('string');
		expect((await h.activity('token.revealed')).length).toBe(1);
		// the merchant, for its own website, the same
		expect(codeOf(await m.client.post(reveal, { code: '000000' }))[0]).toBeGreaterThanOrEqual(400);
		const merchantCode = await h.confirmOtp(m.client, m.email);
		expect((await m.client.post(reveal, merchantCode)).json.serverToken).toBe(shown.json.serverToken);
	});

	it('is the same for renewing: no code, no new token and the old one stays', async () => {
		const { h, owner, site } = await setUp();
		const regenerate = `${site}/tokens/notes/regenerate`;
		expect(codeOf(await owner.post(regenerate, { kind: 'server' }))).toEqual([422, 'validation_failed']);
		expect(codeOf(await owner.post(regenerate, { kind: 'server', password: PASSWORD }))).toEqual([422, 'validation_failed']);
		const wrong = await owner.post(regenerate, { kind: 'server', code: '000000' });
		expect(wrong.status).toBeGreaterThanOrEqual(400);
		expect((await h.activity('token.regenerated')).length).toBe(0);
		const ownerCode = await h.confirmOtp(owner, 'owner@portal.test');
		expect((await owner.post(regenerate, { kind: 'server', ...ownerCode })).status).toBe(200);
		expect((await h.activity('token.regenerated')).length).toBe(1);
	});

	it('is the Owner’s: Support and Finance are refused before their code is even looked at', async () => {
		const { h, site } = await setUp();
		for (const role of /** @type {const} */ (['support', 'finance'])) {
			const admin = await h.admin(role);
			const adminCode = await h.confirmOtp(admin.client, admin.email);
			for (const [path, body] of /** @type {Array<[string, object]>} */ ([
				[`${site}/tokens/notes/reveal`, adminCode],
				[`${site}/tokens/notes/regenerate`, { kind: 'server', ...adminCode }],
			]))
				expect([role, codeOf(await admin.client.post(path, body))]).toEqual([role, [403, 'forbidden']]);
		}
	});

	it('cannot be guessed at: repeated wrong codes lock the person out of confirming', async () => {
		const { h, owner, site } = await setUp();
		const reveal = `${site}/tokens/notes/reveal`;
		await owner.post('/v1/me/step-up-otp', {});
		/** @type {number[]} */
		const statuses = [];
		for (let i = 0; i < 8; i += 1) statuses.push((await owner.post(reveal, { code: `12345${i}` })).status);
		expect(statuses.at(-1)).toBe(429);
		// even the right code waits while locked
		const ownerCode = await h.confirmOtp(owner, 'owner@portal.test');
		expect((await owner.post(reveal, ownerCode)).status).toBe(429);
	});
});
