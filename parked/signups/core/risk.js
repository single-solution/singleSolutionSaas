/**
 * Sign-in risk (pure): disposable e-mail domains, new-device detection and velocity limits per IP. Device and IP
 * values reach this module only as keyed hashes (adapters), never in the clear.
 * @module
 */
import { isBlockedDomain } from './email.js';
import { HOUR_MS } from './limits.js';

/**
 * Whether an e-mail address must be refused.
 * @param {string} email canonical address
 * @param {{ blockDisposable: boolean, disposableDomains: readonly string[], blockedDomains: readonly string[] }} rules
 */
export const emailBlocked = (email, { blockDisposable, disposableDomains, blockedDomains }) =>
	isBlockedDomain(email, blockedDomains) || (blockDisposable && isBlockedDomain(email, disposableDomains));

/**
 * Whether a device is new for a customer (no device id = unknown, never "new": nothing to compare).
 * @param {readonly string[] | undefined} known device hashes
 * @param {string | null} deviceHash
 */
export const isNewDevice = (known, deviceHash) => deviceHash !== null && !(known ?? []).includes(deviceHash);

/**
 * Remember a device (most recent last, at most `max`).
 * @param {readonly string[] | undefined} known
 * @param {string | null} deviceHash
 * @param {number} max
 * @returns {string[]}
 */
export const rememberDevice = (known, deviceHash, max) => {
	const list = (known ?? []).filter((hash) => hash !== deviceHash);
	if (deviceHash !== null) list.push(deviceHash);
	return list.slice(-Math.max(1, max));
};

/**
 * Velocity limits per IP (risk element): distinct identities asking for codes and failed verifications per hour.
 * @param {{ ipKey: string | null, identityKey?: string, maxIdentities: number, maxFailures: number }} input
 */
export const velocityLimits = ({ ipKey, identityKey, maxIdentities, maxFailures }) =>
	ipKey
		? {
				identities: identityKey
					? { key: `risk:ipid:${ipKey}`, member: identityKey, max: maxIdentities, windowMs: HOUR_MS, code: 'velocity_limit' }
					: null,
				failures: { key: `risk:fail:${ipKey}`, max: maxFailures, windowMs: HOUR_MS, code: 'velocity_limit' },
			}
		: { identities: null, failures: null };
