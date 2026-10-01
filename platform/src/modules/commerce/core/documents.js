/**
 * Entitlement document helpers (pure): validity window, cache freshness, version bumps and the facts settlement and
 * quota checks read from a resolution.
 * @module
 */

import { sha256Hex, stableStringify } from '@ss/entitlements';

/** Documents are valid for 10 minutes (F.8 emulator parity; entitlement freshness SLO ≤ 5 min with refresh). */
export const DOCUMENT_TTL_MS = 10 * 60_000;
/** A cached document is re-issued once it is within 2 minutes of `validUntil`. */
export const REFRESH_BEFORE_MS = 2 * 60_000;

/**
 * @param {number} now epoch ms
 * @returns {{ issuedAt: string, validFrom: string, validUntil: string }}
 */
export const validityWindow = (now) => {
	const issuedAt = new Date(now).toISOString();
	return { issuedAt, validFrom: issuedAt, validUntil: new Date(now + DOCUMENT_TTL_MS).toISOString() };
};

/**
 * Whether a cached document can be served as is.
 * @param {{ jws?: string | null, validUntil?: Date | string | null, stale?: boolean } | null | undefined} cached
 * @param {number} now
 */
export const isFresh = (cached, now) =>
	Boolean(cached?.jws) &&
	cached?.stale !== true &&
	cached?.validUntil !== null &&
	cached?.validUntil !== undefined &&
	now < new Date(cached.validUntil).getTime() - REFRESH_BEFORE_MS;

/**
 * The document version for a new resolution: unchanged when the content hash is unchanged, else bumped.
 * @param {{ version: number, contentHash: string } | null | undefined} stored
 * @param {string} contentHash
 * @returns {{ version: number, bumped: boolean }}
 */
export const nextVersion = (stored, contentHash) =>
	stored && stored.contentHash === contentHash
		? { version: stored.version, bumped: false }
		: { version: (stored?.version ?? 0) + 1, bumped: true };

/**
 * Elements enabled in a resolution (sorted) — the billable state settlement samples.
 * @param {{ elements: Record<string, { enabled: boolean }> }} resolved
 * @returns {string[]}
 */
export const enabledElements = (resolved) =>
	Object.entries(resolved.elements)
		.filter(([, el]) => el.enabled)
		.map(([key]) => key)
		.sort();

/**
 * Hard-stop quotas of a resolution, with their effective limits (to detect exhaustion on usage ingest).
 * @param {readonly { key: string, unit: string, period: string, hardStop: boolean }[]} quotas
 * @param {{ features: Record<string, { value: unknown, blocked?: boolean }> }} resolved
 * @returns {{ key: string, unit: string, period: string, limit: number, blocked: boolean }[]}
 */
export const quotaWatch = (quotas, resolved) =>
	quotas
		.filter((q) => q.hardStop)
		.flatMap((q) => {
			const feature = resolved.features[q.key];
			if (!feature || typeof feature.value !== 'number') return [];
			return [{ key: q.key, unit: q.unit, period: q.period, limit: feature.value, blocked: feature.blocked === true }];
		});

/**
 * Whether new usage crosses a not-yet-blocked hard-stop quota.
 * @param {readonly { key: string, unit: string, limit: number, blocked: boolean }[]} watch
 * @param {Readonly<Record<string, number>>} usedByKey period-to-date usage per quota key
 */
export const quotaCrossed = (watch, usedByKey) => watch.some((q) => !q.blocked && (usedByKey[q.key] ?? 0) >= q.limit);

/**
 * Content hash of a document: the resolver's hash, extended with the website's identity section when there is one (a
 * changed issuer or rotated issuer key bumps the version; documents without identity keep the resolver's hash).
 * @param {string} resolvedHash `resolveEntitlement(...).contentHash`
 * @param {unknown} identity the document's `identity` section, or null
 * @returns {string}
 */
export const documentHash = (resolvedHash, identity) =>
	identity ? sha256Hex(`${resolvedHash}\nidentity:${stableStringify(identity)}`) : resolvedHash;
