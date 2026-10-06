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
	jobs: 'platform_jobs',
	operationRuns: 'platform_operation_runs',
	locks: 'platform_locks',
	migrations: 'platform_migrations',
	system: 'platform_system',
});

const DAY = 24 * 60 * 60;

export const INFRA_COLLECTIONS = Object.freeze([
	defineCollection({
		module: 'platform',
		name: COLLECTIONS.sessions,
		description: 'Console sessions (staff and merchant users); `_id` = HMAC of the opaque token.',
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
		description: 'Replay store for client assertions, launches, nonces (`@ss/protocol` ReplayStore).',
		timestamps: false,
		ttl: { field: 'expireAt', afterSeconds: 0 },
	}),
	defineCollection({
		module: 'platform',
		name: COLLECTIONS.audit,
		description: 'Append-only, hash-chained audit log (one chain per scope: global and per merchant).',
		appendOnly: true,
		timestamps: false,
		indexes: [
			{ keys: { scope: 1, seq: 1 }, name: 'chain', unique: true, partialFilterExpression: { scope: { $type: 'string' } } },
			{ keys: { merchantId: 1, at: -1, _id: -1 } },
			{ keys: { 'target.id': 1, at: -1 } },
			{ keys: { 'actor.id': 1, at: -1 } },
			{ keys: { action: 1, at: -1 } },
			{ keys: { scope: 1, at: -1, _id: -1 } },
			{ keys: { at: -1, _id: -1 } },
		],
	}),
	defineCollection({
		module: 'platform',
		name: COLLECTIONS.jobs,
		description: 'Job queue with leases, retries and dead letters.',
		timestamps: false,
		ttl: { field: 'expireAt', afterSeconds: 0 },
		indexes: [
			{ keys: { status: 1, runAt: 1 } },
			{ keys: { status: 1, leaseUntil: 1 } },
			{ keys: { name: 1, status: 1 } },
			{ keys: { group: 1, status: 1, runAt: 1 }, partialFilterExpression: { group: { $type: 'string' } } },
			{ keys: { key: 1 }, unique: true, partialFilterExpression: { key: { $type: 'string' } } },
		],
	}),
	defineCollection({
		module: 'platform',
		name: COLLECTIONS.operationRuns,
		description: 'One append-only record per on-demand admin operation run (30 days).',
		appendOnly: true,
		timestamps: false,
		ttl: { field: 'startedAt', afterSeconds: 30 * DAY },
		indexes: [{ keys: { name: 1, startedAt: -1 } }],
	}),
	defineCollection({
		module: 'platform',
		name: COLLECTIONS.locks,
		description: 'Lease locks (migrations, operation runs, ledger appends).',
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
			"The Portal's own state (infra/system.js): generated secrets, the settings recorded at /setup or by admins (mail password sealed), the applied schema fingerprint.",
		timestamps: false,
	}),
]);
