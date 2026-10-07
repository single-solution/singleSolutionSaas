/**
 * Entitlement document helpers (pure): validity window, cache freshness, version bumps and the facts quota checks
 * read from a resolution.
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
 * Content hash of a document: the resolver's hash, extended with the website's identity section and its `website`
 * settings section (F.16) when present (a changed issuer, rotated issuer key or changed website setting bumps the
 * version; documents without either keep the resolver's hash, and identity-only documents keep their former hash).
 * @param {string} resolvedHash `resolveEntitlement(...).contentHash`
 * @param {unknown} identity the document's `identity` section, or null
 * @param {Record<string, unknown> | null} [website] the document's `website` section, or null
 * @returns {string}
 */
export const documentHash = (resolvedHash, identity, website = null) => {
	if (!identity && !website) return resolvedHash;
	const parts = [resolvedHash];
	if (identity) parts.push(`identity:${stableStringify(identity)}`);
	if (website) parts.push(`website:${stableStringify(website)}`);
	return sha256Hex(parts.join('\n'));
};

/**
 * The `website` section of a website's documents: its set settings only, or null when none is set.
 * @param {{ timeZone?: string | null, language?: string | null, currency?: string | null } | null | undefined} website
 * @returns {{ timeZone?: string, language?: string, currency?: string } | null}
 */
export const websiteSection = (website) => {
	/** @type {{ timeZone?: string, language?: string, currency?: string }} */
	const out = {};
	if (typeof website?.timeZone === 'string') out.timeZone = website.timeZone;
	if (typeof website?.language === 'string') out.language = website.language;
	if (typeof website?.currency === 'string') out.currency = website.currency;
	return Object.keys(out).length > 0 ? out : null;
};

/**
 * Which resource kinds a subscription needs (F.16): product-level `requires.resources` always; an element's kinds
 * only while that element is on (enabled, or configured on but blocked because a resource is missing). Optional kinds
 * (`requires.optionalResources`, F.18) are listed with `optional: true` — needed while a using element is on, but a
 * missing one disables nothing.
 * @param {{ requires?: { resources?: readonly string[] }, elements: ReadonlyArray<{ key: string, requires?: { resources?: readonly string[], optionalResources?: readonly string[] } }> }} manifest
 * @param {Record<string, { enabled: boolean, reason?: string | null }>} elements resolved element states
 * @returns {Array<{ kind: string, scope: 'product' | 'element', elements: string[], neededNow: boolean, optional?: boolean }>}
 */
export const resourceNeeds = (manifest, elements) => {
	/** @type {Map<string, { kind: string, scope: 'product' | 'element', elements: string[], neededNow: boolean, optional?: boolean }>} */
	const out = new Map();
	for (const kind of manifest.requires?.resources ?? [])
		out.set(kind, { kind, scope: 'product', elements: [], neededNow: true });
	for (const element of manifest.elements) {
		const state = elements[element.key];
		const on = state?.enabled === true || state?.reason === 'resource_missing';
		for (const kind of element.requires?.resources ?? []) {
			const entry = out.get(kind) ?? { kind, scope: /** @type {const} */ ('element'), elements: [], neededNow: false };
			entry.elements.push(element.key);
			if (on) entry.neededNow = true;
			delete entry.optional;
			out.set(kind, entry);
		}
	}
	for (const element of manifest.elements) {
		const state = elements[element.key];
		const on = state?.enabled === true || state?.reason === 'resource_missing';
		for (const kind of element.requires?.optionalResources ?? []) {
			const known = out.get(kind);
			const entry = known ?? { kind, scope: /** @type {const} */ ('element'), elements: [], neededNow: false, optional: true };
			if (!entry.elements.includes(element.key)) entry.elements.push(element.key);
			if (on) entry.neededNow = true;
			out.set(kind, entry);
		}
	}
	return [...out.values()].sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
};
