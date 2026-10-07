/**
 * Self-service data rights (pure): export now, deletion after a cooling-off period during which the customer can
 * cancel. Executing a deletion anonymises the customer (identifiers, profile, addresses, custom fields, devices and
 * consents removed; the id stays so other records keep a stable, meaningless reference) and revokes every session.
 * @module
 */
import { DAY_MS } from './limits.js';

/** Request types. */
export const REQUEST_TYPES = Object.freeze(/** @type {const} */ (['export', 'delete']));

/**
 * When a deletion requested at `now` takes effect.
 * @param {number} now
 * @param {number} coolingOffDays
 */
export const deletionEffectiveAt = (now, coolingOffDays) => new Date(now + Math.max(0, coolingOffDays) * DAY_MS).toISOString();

/**
 * Whether a pending deletion is due.
 * @param {{ type: string, status: string, effectiveAt?: string | null }} request
 * @param {number} now
 */
export const deletionDue = (request, now) =>
	request.type === 'delete' &&
	request.status === 'pending' &&
	typeof request.effectiveAt === 'string' &&
	Date.parse(request.effectiveAt) <= now;

/**
 * The `$set` that anonymises a customer document.
 * @param {string} at ISO time
 */
export const anonymisedCustomer = (at) => ({
	email: null,
	phone: null,
	emailVerifiedAt: null,
	phoneVerifiedAt: null,
	externalId: null,
	profile: {},
	addresses: [],
	custom: {},
	knownDevices: [],
	consents: {},
	status: 'deleted',
	deletedAt: at,
});
