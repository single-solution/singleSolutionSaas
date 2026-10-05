/**
 * Public views (pure): what the API returns for customers, sessions, challenges and orders. Internal fields (hashes,
 * device hashes, counters, tenant stamps) never leave the product.
 * @module
 */
import { badges, missingFields } from './profile.js';
import { sessionState } from './sessions.js';

/**
 * @typedef {object} Customer
 * @property {string} id
 * @property {string | null} [email]
 * @property {string | null} [phone]
 * @property {string | null} [emailVerifiedAt]
 * @property {string | null} [phoneVerifiedAt]
 * @property {string | null} [externalId]
 * @property {Record<string, unknown>} [profile]
 * @property {import('./profile.js').Address[]} [addresses]
 * @property {Record<string, unknown>} [custom]
 * @property {'active' | 'blocked' | 'deleted'} status
 * @property {number} [sessionVersion]
 * @property {string[]} [knownDevices]
 * @property {import('./consent.js').Accepted} [consents]
 * @property {string} [source]
 * @property {string | Date} [createdAt]
 * @property {string | null} [lastSignInAt]
 * @property {number} [signInCount]
 */

/** @param {unknown} value */
const iso = (value) => (value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : null);

/**
 * @param {Customer} customer
 * @param {{ fields: readonly import('./profile.js').FieldDef[] }} options
 */
export const customerView = (customer, { fields }) => ({
	id: customer.id,
	email: customer.email ?? null,
	phone: customer.phone ?? null,
	verified: badges(customer),
	externalId: customer.externalId ?? null,
	status: customer.status,
	profile: customer.profile ?? {},
	missingFields: missingFields(customer, fields),
	addresses: customer.addresses ?? [],
	custom: customer.custom ?? {},
	consents: customer.consents ?? {},
	createdAt: iso(customer.createdAt),
	lastSignInAt: customer.lastSignInAt ?? null,
	signInCount: customer.signInCount ?? 0,
});

/**
 * @param {import('./sessions.js').Session} session
 * @param {{ now: number, currentId?: string | null }} options
 */
export const sessionView = (session, { now, currentId = null }) => ({
	id: session.id,
	device: session.device,
	method: session.method,
	createdAt: session.createdAt,
	lastUsedAt: session.lastUsedAt,
	expiresAt: session.idleExpiresAt && session.idleExpiresAt < session.expiresAt ? session.idleExpiresAt : session.expiresAt,
	state: sessionState(session, now),
	current: session.id === currentId,
});

/**
 * The uniform answer to a code or link request — identical whether or not the identifier belongs to a customer.
 * @param {{ id: string, channel: string, masked: string, expiresAt: string, resendAfter: number,
 *   code?: { length: number, alphabet: string } }} input
 */
export const challengeView = ({ id, channel, masked, expiresAt, resendAfter, code }) => ({
	challengeId: id,
	channel,
	destination: masked,
	expiresAt,
	resendAfter,
	...(code ? { codeLength: code.length, codeAlphabet: code.alphabet } : {}),
});

/**
 * Tokens of a signed-in customer.
 * @param {{ accessToken: string, accessExpiresAt: string, refreshToken: string, session: import('./sessions.js').Session }} input
 */
export const tokensView = ({ accessToken, accessExpiresAt, refreshToken, session }) => ({
	tokenType: 'Bearer',
	accessToken,
	expiresAt: accessExpiresAt,
	refreshToken,
	refreshExpiresAt:
		session.idleExpiresAt && session.idleExpiresAt < session.expiresAt ? session.idleExpiresAt : session.expiresAt,
	sessionId: session.id,
});
