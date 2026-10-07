/**
 * Collections owned by the infra layer (module `platform`). Modules declare theirs in `modules/<name>/schema.js`.
 * None of these hold client data: ids, hashes, counters, sealed values and control-plane facts only (PLAN §1a).
 * @module
 */
import { defineCollection } from './db.js';

export const COLLECTIONS = Object.freeze({
	sessions: 'platform_sessions',
	loginThrottle: 'platform_login_throttle',
	idempotency: 'platform_idempotency',
	rateLimits: 'platform_rate_limits',
	replay: 'platform_replay',
	audit: 'platform_audit',
	locks: 'platform_locks',
	migrations: 'platform_migrations',
	system: 'platform_system',
});

export const INFRA_COLLECTIONS = Object.freeze([
	defineCollection({
		module: 'platform',
		name: COLLECTIONS.sessions,
		description: 'Console sessions (admins and merchants); `_id` = HMAC of the opaque token.',
		timestamps: false,
		ttl: { field: 'expireAt', afterSeconds: 0 },
		indexes: [{ keys: { kind: 1, subject: 1, lastSeenAt: -1 } }],
	}),
	defineCollection({
		module: 'platform',
		name: COLLECTIONS.loginThrottle,
		description: 'Failed-login counters per account (HMAC) and per IP window; progressive lockouts.',
		timestamps: false,
		ttl: { field: 'expireAt', afterSeconds: 0 },
	}),
	defineCollection({
		module: 'platform',
		name: COLLECTIONS.idempotency,
		description:
			'Idempotency-Key records: HMAC fingerprint and the stored response, or only the status for no-store routes (24 h).',
		timestamps: false,
		ttl: { field: 'expireAt', afterSeconds: 0 },
	}),
	defineCollection({
		module: 'platform',
		name: COLLECTIONS.rateLimits,
		description: 'Fixed-window rate-limit counters.',
		timestamps: false,
		ttl: { field: 'expireAt', afterSeconds: 0 },
	}),
	defineCollection({
		module: 'platform',
		name: COLLECTIONS.replay,
		description: 'Replay store for client assertions and launch consumption (`@ss/protocol` ReplayStore).',
		timestamps: false,
		ttl: { field: 'expireAt', afterSeconds: 0 },
	}),
	defineCollection({
		module: 'platform',
		name: COLLECTIONS.audit,
		description: 'Append-only audit log.',
		appendOnly: true,
		timestamps: false,
		indexes: [
			{ keys: { merchantId: 1, at: -1, _id: -1 } },
			{ keys: { 'target.id': 1, at: -1 } },
			{ keys: { 'actor.id': 1, at: -1 } },
			{ keys: { action: 1, at: -1 } },
			{ keys: { at: -1, _id: -1 } },
		],
	}),
	defineCollection({
		module: 'platform',
		name: COLLECTIONS.locks,
		description: 'Lease locks (migrations, ledger appends).',
		timestamps: false,
		ttl: { field: 'expireAt', afterSeconds: 3600 },
	}),
	defineCollection({
		module: 'platform',
		name: COLLECTIONS.migrations,
		description: 'Applied migrations (append-only).',
		appendOnly: true,
		timestamps: false,
	}),
	defineCollection({
		module: 'platform',
		name: COLLECTIONS.system,
		description:
			"The Portal's own state (infra/system.js): generated secrets, the settings recorded by admins (mail password sealed), the applied schema fingerprint.",
		timestamps: false,
	}),
]);
