/**
 * Guarded DNS lookup: the connect-time half of the SSRF guard. Pass it as the socket `lookup` to `node:http` /
 * `node:https` / `node:net` / `node:tls` or as the MongoDB driver's `lookup` option. Every connection resolves the
 * host once through the policy resolver, refuses the whole name when **any** answer is not a public address (unless
 * the host or that address is allowlisted), and hands the socket exactly the vetted answers — there is no second
 * resolution between check and connect, so DNS rebinding cannot swap the target.
 *
 * Node skips `lookup` for IP literals, so callers must check URLs / hosts first (`checkUrl`, `checkHost`) —
 * `safeFetch` and `isSafeMongoUri` do.
 * @module
 */
import { classifyAddress } from './address.js';
import { netError } from './errors.js';
import { checkHost, isAllowlisted, normaliseHost } from './policy.js';

/** @typedef {import('./policy.js').OutboundPolicy} OutboundPolicy */
/** @typedef {import('./policy.js').ResolvedAddress} ResolvedAddress */
/**
 * Node's `lookup` signature (`dns.lookup` compatible).
 * @typedef {(hostname: string, options: any, callback?: (error: NodeJS.ErrnoException | null, address?: any, family?: number) => void) => void} LookupFunction
 */

/**
 * Resolve and vet a host name under the policy.
 * @param {OutboundPolicy} policy
 * @param {string} hostname
 * @param {{ family?: number }} [options]
 * @returns {Promise<ResolvedAddress[]>} vetted answers (never empty)
 */
export const resolveVetted = async (policy, hostname, { family } = {}) => {
	const checked = checkHost(hostname, policy);
	if (!checked.ok) throw netError(checked.code, checked.reason, `destination ${checked.reason.replace(/_/g, ' ')}`);
	if (checked.ip) {
		const ip = classifyAddress(checked.host);
		return [{ address: checked.host, family: /** @type {number} */ (ip.family) }];
	}
	/** @type {ReadonlyArray<ResolvedAddress>} */
	let answers;
	try {
		answers = await policy.resolve(checked.host, family === 4 || family === 6 ? { family } : {});
	} catch (error) {
		const code = String(/** @type {{ code?: unknown }} */ (error)?.code ?? 'ENOTFOUND');
		throw netError('network', 'dns_failed', 'could not resolve the destination', code);
	}
	if (!Array.isArray(answers) || answers.length === 0)
		throw netError('network', 'dns_failed', 'the destination has no address', 'ENOTFOUND');
	/** @type {ResolvedAddress[]} */
	const vetted = [];
	for (const answer of answers) {
		const ip = classifyAddress(String(answer?.address ?? ''));
		if (ip.address === null || ip.family === null)
			throw netError('ssrf_blocked', 'invalid_address', 'the destination resolved to an invalid address');
		if (ip.blocked && !checked.allowlisted && !isAllowlisted(policy, ip.address))
			throw netError('ssrf_blocked', `${ip.category}_address`, 'the destination resolved to a refused address');
		vetted.push({ address: ip.address, family: ip.family });
	}
	return vetted;
};

/**
 * A Node `lookup` function enforcing the policy at connect time. Refusals call back with a `NetError`
 * (`code: 'ssrf_blocked'`); resolution failures with a `NetError` (`code: 'network'`, `detail` = DNS code).
 * @param {OutboundPolicy} policy
 * @param {{ onRefused?: (error: import('./errors.js').NetError) => void }} [hooks]
 * @returns {LookupFunction}
 */
export const guardedLookup =
	(policy, { onRefused } = {}) =>
	(hostname, options, callback) => {
		const cb = /** @type {(error: NodeJS.ErrnoException | null, address?: any, family?: number) => void} */ (
			typeof options === 'function' ? options : callback
		);
		const opts =
			typeof options === 'function' || options === undefined || options === null
				? {}
				: typeof options === 'number'
					? { family: options }
					: options;
		const family = opts.family === 4 || opts.family === 6 ? opts.family : undefined;
		resolveVetted(policy, normaliseHost(String(hostname)), family ? { family } : {}).then(
			(vetted) => {
				const first = /** @type {ResolvedAddress} */ (vetted[0]);
				if (opts.all) cb(null, vetted);
				else cb(null, first.address, first.family);
			},
			(error) => {
				if (error.code === 'ssrf_blocked') onRefused?.(error);
				cb(error);
			},
		);
	};
