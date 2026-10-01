import { describe, expect, it } from 'vitest';
import { createOutboundPolicy, guardedLookup, isNetError, resolveVetted } from '../src/index.js';

/**
 * Resolver returning the next answer set on each call (the last one repeats).
 * @param {Array<Array<{ address: string, family: number }>>} sequence
 */
const sequenceResolver = (sequence) => {
	const calls = /** @type {Array<{ host: string, options: unknown }>} */ ([]);
	/** @type {import('../src/index.js').Resolver} */
	const resolve = async (host, options) => {
		calls.push({ host, options });
		return sequence[Math.min(calls.length - 1, sequence.length - 1)] ?? [];
	};
	return { resolve, calls };
};

/**
 * Promisified lookup call.
 * @param {import('../src/index.js').LookupFunction} lookup
 * @param {string} host
 * @param {any} [options]
 * @returns {Promise<{ error: any, address?: any, family?: number }>}
 */
const call = (lookup, host, options) =>
	new Promise((resolve) => {
		const cb = (/** @type {any} */ error, /** @type {any} */ address, /** @type {number | undefined} */ family) =>
			resolve({ error, address, family });
		if (options === undefined) lookup(host, cb);
		else lookup(host, options, cb);
	});

const PUBLIC = { address: '93.184.216.34', family: 4 };
const PRIVATE = { address: '10.0.0.7', family: 4 };

describe('guardedLookup', () => {
	it('returns vetted public answers in every callback shape', async () => {
		const { resolve, calls } = sequenceResolver([[PUBLIC, { address: '2606:2800:220:1::1', family: 6 }]]);
		const lookup = guardedLookup(createOutboundPolicy({ resolve }));
		expect(await call(lookup, 'example.com')).toEqual({ error: null, address: PUBLIC.address, family: 4 });
		expect(await call(lookup, 'example.com', 6)).toMatchObject({ error: null, address: PUBLIC.address });
		expect(await call(lookup, 'example.com', null)).toMatchObject({ error: null, address: PUBLIC.address });
		expect(await call(lookup, 'example.com', { all: true, family: 4 })).toEqual({
			error: null,
			address: [PUBLIC, { address: '2606:2800:220:1::1', family: 6 }],
			family: undefined,
		});
		expect(calls.map((c) => c.options)).toEqual([{}, { family: 6 }, {}, { family: 4 }]);
	});

	it('defeats DNS rebinding: each connection is vetted on its own answer', async () => {
		// first resolution is public, the attacker's second answer is private
		const { resolve, calls } = sequenceResolver([[PUBLIC], [{ address: '127.0.0.1', family: 4 }]]);
		const refused = /** @type {any[]} */ ([]);
		const lookup = guardedLookup(createOutboundPolicy({ resolve }), { onRefused: (e) => refused.push(e.reason) });
		expect(await call(lookup, 'rebind.example.com')).toMatchObject({ error: null, address: PUBLIC.address });
		const second = await call(lookup, 'rebind.example.com');
		expect(isNetError(second.error, 'ssrf_blocked')).toBe(true);
		expect(second.error.reason).toBe('loopback_address');
		expect(second.address).toBeUndefined();
		expect(calls).toHaveLength(2);
		expect(refused).toEqual(['loopback_address']);
	});

	it('refuses the whole name when any answer is private', async () => {
		const { resolve } = sequenceResolver([[PUBLIC, PRIVATE]]);
		const result = await call(guardedLookup(createOutboundPolicy({ resolve })), 'mixed.example.com', { all: true });
		expect(result.error).toMatchObject({ code: 'ssrf_blocked', reason: 'private_address' });
	});

	it.each([
		['169.254.169.254', 'metadata_address'],
		['::ffff:127.0.0.1', 'loopback_address'],
		['fd00:ec2::254', 'metadata_address'],
		['100.64.1.1', 'cgnat_address'],
		['0.0.0.0', 'unspecified_address'],
		['not-an-ip', 'invalid_address'],
	])('refuses an answer %s (%s)', async (address, reason) => {
		const { resolve } = sequenceResolver([[{ address, family: address.includes(':') ? 6 : 4 }]]);
		await expect(resolveVetted(createOutboundPolicy({ resolve }), 'x.example.com')).rejects.toMatchObject({
			code: 'ssrf_blocked',
			reason,
		});
	});

	it('checks the name before resolving and never resolves IP literals', async () => {
		const { resolve, calls } = sequenceResolver([[PUBLIC]]);
		const policy = createOutboundPolicy({ resolve });
		await expect(resolveVetted(policy, 'localhost')).rejects.toMatchObject({ code: 'ssrf_blocked', reason: 'internal_name' });
		await expect(resolveVetted(policy, '127.0.0.1')).rejects.toMatchObject({ code: 'ssrf_blocked' });
		await expect(resolveVetted(policy, 'bad..name')).rejects.toMatchObject({ code: 'bad_url' });
		expect(await resolveVetted(policy, '8.8.8.8')).toEqual([{ address: '8.8.8.8', family: 4 }]);
		expect(await resolveVetted(policy, '[2606:4700:4700::1111]')).toEqual([{ address: '2606:4700:4700::1111', family: 6 }]);
		expect(calls).toHaveLength(0);
	});

	it('admits allowlisted hosts and allowlisted addresses', async () => {
		const { resolve } = sequenceResolver([[{ address: '127.0.0.1', family: 4 }]]);
		const hostAllowed = createOutboundPolicy({ resolve, allowHosts: ['dev.example.com'] });
		expect(await resolveVetted(hostAllowed, 'dev.example.com')).toEqual([{ address: '127.0.0.1', family: 4 }]);
		const addressAllowed = createOutboundPolicy({ resolve, allowHosts: ['127.0.0.1'] });
		expect(await resolveVetted(addressAllowed, 'any.example.com')).toEqual([{ address: '127.0.0.1', family: 4 }]);
		const neither = createOutboundPolicy({ resolve, allowHosts: ['10.0.0.1'] });
		await expect(resolveVetted(neither, 'any.example.com')).rejects.toMatchObject({ code: 'ssrf_blocked' });
	});

	it('maps resolution failures to network errors', async () => {
		const failing = createOutboundPolicy({
			resolve: async () => {
				throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
			},
		});
		const result = await call(guardedLookup(failing), 'nx.example.com');
		expect(result.error).toMatchObject({ code: 'network', reason: 'dns_failed', detail: 'ENOTFOUND' });
		const empty = createOutboundPolicy({ resolve: async () => [] });
		await expect(resolveVetted(empty, 'none.example.com')).rejects.toMatchObject({ code: 'network', detail: 'ENOTFOUND' });
		const odd = createOutboundPolicy({ resolve: async () => /** @type {any} */ ('nope') });
		await expect(resolveVetted(odd, 'odd.example.com')).rejects.toMatchObject({ code: 'network' });
		const throwsPlain = createOutboundPolicy({
			resolve: async () => {
				throw 'boom';
			},
		});
		await expect(resolveVetted(throwsPlain, 'p.example.com')).rejects.toMatchObject({ detail: 'ENOTFOUND' });
	});

	it('uses the system resolver by default', async () => {
		const policy = createOutboundPolicy({ allowHosts: ['localhost'] });
		const answers = await resolveVetted(policy, 'localhost', { family: 4 });
		expect(answers[0]?.address).toBe('127.0.0.1');
	});
});
