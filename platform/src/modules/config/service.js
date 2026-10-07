/**
 * Public service of the `config` module: layered overrides (platform, website, admin) with immutable versions,
 * rollback, locks and dry-run previews.
 *
 * The module stores and returns layers in exactly the `@ss/entitlements` `resolveEntitlement` `layers` shape; it never
 * resolves precedence or clamps to plan maxima (commerce does). Every value is validated against the pinned manifest's
 * feature schema (absolute bounds) with `@ss/contracts` `validateFeatureConfig`.
 *
 * Writes: each change appends a version record `<targetKey>#<n>` (the unique `_id` serialises concurrent writers),
 * then moves the materialised layer document forward with a monotonic compare-and-set. A crash between the two is
 * repaired by the next read-for-write of that target (the latest version record is authoritative).
 * @module
 */
import { validateFeatureConfig } from '@ss/contracts';
import { problem } from '../../infra/http.js';
import { diffStates, lockedTouches, touchedKeys } from './core/diff.js';
import { applyOps, decodeState, emptyState, encodeState, isRecord } from './core/state.js';
import { STAFF_LEVELS, actorMayLock, actorMayWrite, parseTarget, targetKey } from './core/targets.js';
import { indexManifest, validateEntries } from './core/validate.js';
import { createConfigRepo } from './repo.js';

/** @typedef {import('../../infra/modules.js').ModuleContext} ModuleContext */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */
/** @typedef {import('./core/targets.js').Level} Level */
/** @typedef {import('./core/targets.js').TargetRef} TargetRef */
/** @typedef {import('./core/targets.js').FieldError} FieldError */
/** @typedef {import('./core/state.js').LayerState} LayerState */
/** @typedef {import('./core/diff.js').DiffEntry} DiffEntry */
/** @typedef {import('./core/validate.js').ManifestIndex} ManifestIndex */

/**
 * A target with everything needed to store it.
 * @typedef {object} Resolved
 * @property {Level} level
 * @property {string} key
 * @property {string | null} merchantId null = platform policy
 * @property {string} appId
 * @property {string | null} subscriptionId
 * @property {string | null} websiteId
 * @property {string | null} manifestVersion pinned manifest version (null = current)
 */

/**
 * Where a console request is allowed to reach (route parameters); omitted for internal callers.
 * @typedef {{ merchantId?: string, websiteId?: string }} Scope
 */

/**
 * @typedef {object} RequestMeta
 * @property {Actor} actor
 * @property {string | null} [requestId]
 * @property {string | null} [ip]
 */

const MAX_ATTEMPTS = 5;
const MANIFEST_CACHE = 100;

/**
 * @param {string} code
 * @param {string} detail
 * @param {FieldError[]} [errors]
 */
const fail = (code, detail, errors) => problem(code, detail, errors ? { errors } : {});

/**
 * Whether an error thrown by another module means "not found" (http problem results or `ctx.problems` documents).
 * @param {unknown} error
 */
const isNotFound = (error) => {
	if (!isRecord(error)) return false;
	const e = /** @type {{ code?: unknown, status?: unknown }} */ (error);
	return e.code === 'not_found' || e.status === 404;
};

/**
 * Optional free-text reason (required for staff levels): trimmed, 1..500 characters.
 * @param {unknown} reason
 * @param {boolean} required
 * @returns {{ ok: true, value: string | null } | { ok: false, message: string }}
 */
export const parseReason = (reason, required) => {
	if (reason === undefined || reason === null || reason === '') {
		return required
			? { ok: false, message: 'a reason is required for staff overrides and policies' }
			: { ok: true, value: null };
	}
	if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 500)
		return { ok: false, message: 'reason must be 1..500 characters' };
	return { ok: true, value: reason.trim() };
};

/**
 * Snapshot of an actor kept on version records (no roles or grants).
 * @param {Actor} actor
 */
const actorRef = (actor) => ({
	type: actor.type,
	id: actor.id,
	...(actor.merchantId ? { merchantId: actor.merchantId } : {}),
});

/**
 * @param {Resolved} r
 * @returns {TargetRef & { merchantId?: string, appId?: string, websiteId?: string }}
 */
const publicTarget = (r) =>
	r.level === 'platform'
		? { level: 'platform', appId: r.appId }
		: {
				level: r.level,
				subscriptionId: /** @type {string} */ (r.subscriptionId),
				merchantId: /** @type {string} */ (r.merchantId),
				appId: r.appId,
				websiteId: /** @type {string} */ (r.websiteId),
			};

/**
 * @param {ModuleContext} ctx
 */
export const createConfigService = (ctx) => {
	const repo = createConfigRepo(ctx);
	/** @type {Map<string, { manifest: import('@ss/contracts').Manifest, index: ManifestIndex }>} */
	const manifests = new Map();

	/**
	 * Another module's service, or null when it is not registered (modules are built concurrently).
	 * @param {string} name
	 * @returns {any}
	 */
	const optional = (name) => (ctx.moduleNames().includes(name) ? ctx.service(name) : null);

	/** @param {Resolved} r */
	const location = (r) => ({ key: r.key, merchantId: r.merchantId });

	/**
	 * Subscription facts from commerce (merchant from identity when commerce does not carry it).
	 * @param {string} subscriptionId
	 */
	const subscriptionInfo = async (subscriptionId) => {
		const commerce = optional('commerce');
		if (!commerce?.getSubscription) throw fail('unavailable', 'Subscriptions are not available.');
		/** @type {any} */
		let sub;
		try {
			sub = await commerce.getSubscription(subscriptionId);
		} catch (error) {
			if (isNotFound(error)) throw fail('not_found', 'No such subscription.');
			throw error;
		}
		if (!sub) throw fail('not_found', 'No such subscription.');
		let merchantId = typeof sub.merchantId === 'string' ? sub.merchantId : null;
		if (!merchantId && typeof sub.websiteId === 'string') {
			const website = await optional('identity')?.getWebsite?.(sub.websiteId);
			merchantId = typeof website?.merchantId === 'string' ? website.merchantId : null;
		}
		if (!merchantId || typeof sub.websiteId !== 'string' || typeof sub.appId !== 'string')
			throw fail('unavailable', 'The subscription could not be resolved.');
		const pinned = sub.manifestVersion ?? sub.pinnedVersion ?? sub.appVersion ?? null;
		return {
			subscriptionId,
			merchantId,
			websiteId: /** @type {string} */ (sub.websiteId),
			appId: /** @type {string} */ (sub.appId),
			manifestVersion: typeof pinned === 'string' || typeof pinned === 'number' ? String(pinned) : null,
			status: typeof sub.status === 'string' ? sub.status : null,
		};
	};

	/**
	 * Validate a target reference and resolve it; enforce the console scope (a mismatch is a 404, never a leak).
	 * @param {unknown} target
	 * @param {unknown} [level]
	 * @param {Scope} [scope]
	 * @returns {Promise<Resolved>}
	 */
	const resolveTarget = async (target, level, scope) => {
		const parsed = parseTarget(target, level);
		if (!parsed.ok) throw fail('validation_failed', 'The configuration target is invalid.', parsed.errors);
		const ref = parsed.value;
		/** @type {Resolved} */
		let resolved;
		if (ref.level === 'platform') {
			resolved = {
				level: 'platform',
				key: targetKey(ref),
				merchantId: null,
				appId: ref.appId,
				subscriptionId: null,
				websiteId: null,
				manifestVersion: null,
			};
		} else {
			const info = await subscriptionInfo(ref.subscriptionId);
			resolved = {
				level: ref.level,
				key: targetKey(ref),
				merchantId: info.merchantId,
				appId: info.appId,
				subscriptionId: info.subscriptionId,
				websiteId: info.websiteId,
				manifestVersion: info.manifestVersion,
			};
		}
		if (scope?.merchantId !== undefined && resolved.merchantId !== scope.merchantId)
			throw fail('not_found', 'No such configuration.');
		if (scope?.websiteId !== undefined && resolved.websiteId !== scope.websiteId)
			throw fail('not_found', 'No such configuration.');
		return resolved;
	};

	/**
	 * The validated manifest (pinned version when known), cached per `appId@version` so compiled feature validators are
	 * reused (manifest versions are immutable).
	 * @param {string} appId
	 * @param {string | null} version
	 */
	const manifestFor = async (appId, version) => {
		if (version !== null) {
			const hit = manifests.get(`${appId}@${version}`);
			if (hit) return hit;
		}
		const catalog = optional('catalog');
		if (!catalog?.getManifest) throw fail('unavailable', 'The product catalog is not available.');
		/** @type {any} */
		let manifest;
		try {
			manifest = await catalog.getManifest(appId, version ?? undefined);
		} catch (error) {
			if (isNotFound(error)) throw fail('not_found', 'No such product manifest.');
			throw error;
		}
		if (!manifest || !Array.isArray(manifest.elements)) throw fail('not_found', 'No such product manifest.');
		const cacheKey = `${appId}@${manifest.product?.version}`;
		const cached = manifests.get(cacheKey);
		if (cached) return cached;
		const entry = { manifest, index: indexManifest(manifest) };
		if (manifests.size >= MANIFEST_CACHE) manifests.delete(/** @type {string} */ (manifests.keys().next().value));
		manifests.set(cacheKey, entry);
		return entry;
	};

	/**
	 * Current state of a target; repairs the materialised document when the latest version record is ahead of it.
	 * @param {Resolved} r
	 * @returns {Promise<{ version: number, state: LayerState, updatedAt: Date | null }>}
	 */
	const loadCurrent = async (r) => {
		const at = location(r);
		const [doc, latest] = await Promise.all([repo.getLayer(at), repo.latestVersion(at)]);
		if (latest && (!doc || doc.version < latest.version)) {
			await repo.writeLayer(at, layerDoc(r, latest.version, latest.state, latest.actor));
			return { version: latest.version, state: decodeState(latest.state), updatedAt: latest.at ?? null };
		}
		return { version: doc?.version ?? 0, state: decodeState(doc?.state), updatedAt: doc?.updatedAt ?? null };
	};

	/**
	 * @param {Resolved} r
	 * @param {number} version
	 * @param {unknown} storedState
	 * @param {unknown} actor
	 */
	const layerDoc = (r, version, storedState, actor) => ({
		level: r.level,
		appId: r.appId,
		subscriptionId: r.subscriptionId,
		websiteId: r.websiteId,
		version,
		state: storedState,
		updatedBy: actor ?? null,
	});

	/**
	 * Tell commerce the effective document may have changed. Never fails the (already committed) change.
	 * @param {Resolved} r
	 */
	const invalidate = async (r) => {
		const commerce = optional('commerce');
		if (!commerce) return;
		try {
			if (r.subscriptionId) {
				if (typeof commerce.invalidate === 'function') await commerce.invalidate(r.subscriptionId);
				return;
			}
			if (typeof commerce.invalidateApp === 'function') await commerce.invalidateApp(r.appId);
			else ctx.logger.warn('platform policy changed but commerce exposes no invalidateApp', { appId: r.appId });
		} catch (error) {
			ctx.logger.warn('commerce invalidation failed', { error, target: r.key });
		}
	};

	/**
	 * Validate a proposed state for a target (without writing).
	 * @param {object} input
	 * @param {Resolved} input.r
	 * @param {Actor} input.actor
	 * @param {LayerState} input.current
	 * @param {(state: LayerState) => ({ ok: true, next: LayerState } | { ok: false, errors: FieldError[] })} input.build
	 * @returns {Promise<{ next: LayerState, diff: DiffEntry[], manifestVersion: string }>}
	 */
	const planChange = async ({ r, actor, current, build }) => {
		if (!actorMayWrite(actor?.type, r.level)) throw fail('forbidden', `Only staff may change ${r.level} configuration.`);
		const { index } = await manifestFor(r.appId, r.manifestVersion);
		const built = build(current);
		if (!built.ok) throw fail('validation_failed', 'The configuration change is invalid.', built.errors);
		const diff = diffStates(current, built.next);
		/** @type {FieldError[]} */
		const errors = [];
		if (!actorMayLock(actor.type)) {
			for (const d of lockedTouches(diff)) {
				errors.push({
					path: `/${d.kind}/${d.key}`,
					message: 'locked by staff: only staff may change or lock it',
					code: 'locked',
				});
			}
		}
		errors.push(...validateEntries({ index, state: built.next, keys: touchedKeys(diff), validateFeatureConfig }));
		if (errors.length > 0) throw fail('validation_failed', 'The configuration change is invalid.', errors);
		return { next: built.next, diff, manifestVersion: index.version };
	};

	/**
	 * Commit a change as a new immutable version, audit it and invalidate commerce.
	 * @param {object} input
	 * @param {Resolved} input.r
	 * @param {(state: LayerState) => ({ ok: true, next: LayerState } | { ok: false, errors: FieldError[] })} input.build
	 * @param {Actor} input.actor
	 * @param {string | null} input.reason
	 * @param {'change' | 'rollback'} input.kind
	 * @param {Record<string, unknown>} [input.extra] stored on the version record
	 * @param {string | null} [input.requestId]
	 * @param {string | null} [input.ip]
	 */
	const commit = async ({ r, build, actor, reason, kind, extra = {}, requestId = null, ip = null }) => {
		const at = location(r);
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
			const current = await loadCurrent(r);
			const { next, diff, manifestVersion } = await planChange({ r, actor, current: current.state, build });
			if (diff.length === 0) return { target: publicTarget(r), version: current.version, diff, unchanged: true };
			const version = current.version + 1;
			const stored = encodeState(next);
			const record = {
				_id: `${r.key}#${version}`,
				level: r.level,
				appId: r.appId,
				subscriptionId: r.subscriptionId,
				websiteId: r.websiteId,
				version,
				state: stored,
				diff,
				kind,
				actor: actorRef(actor),
				reason,
				manifestVersion,
				at: new Date(ctx.now()),
				...extra,
			};
			if (!(await repo.insertVersion(at, record))) continue; // a concurrent writer took this version
			await repo.writeLayer(at, layerDoc(r, version, stored, record.actor));
			await ctx.audit.record({
				actor,
				action: kind === 'change' ? 'config.changed' : 'config.rolled_back',
				target: { type: 'config_layer', id: r.key, merchantId: r.merchantId, websiteId: r.websiteId },
				before: { version: current.version },
				after: { version, diff },
				requestId,
				ip,
				reason,
			});
			await invalidate(r);
			return { target: publicTarget(r), version, diff, unchanged: false };
		}
		throw fail('conflict', 'The configuration changed concurrently; retry.');
	};

	/**
	 * @param {Level} level
	 * @param {Actor} actor
	 * @param {unknown} reason
	 */
	const reasonFor = (level, actor, reason) => {
		const parsed = parseReason(reason, STAFF_LEVELS.has(level) && actor?.type === 'admin');
		if (!parsed.ok)
			throw fail('validation_failed', parsed.message, [{ path: '/reason', message: parsed.message, code: 'invalid_reason' }]);
		return parsed.value;
	};

	/**
	 * Apply a change (elements / features / config / locks) to one layer.
	 * @param {RequestMeta & { target: unknown, level?: Level, change: unknown, reason?: unknown, scope?: Scope }} input
	 */
	const applyChange = async ({ target, level, change, reason, scope, actor, requestId, ip }) => {
		const r = await resolveTarget(target, level, scope);
		return commit({
			r,
			build: (state) => applyOps(state, change),
			actor,
			reason: reasonFor(r.level, actor, reason),
			kind: 'change',
			requestId: requestId ?? null,
			ip: ip ?? null,
		});
	};

	/**
	 * INTERFACES `setOverride`: one element switch, feature value, element config object, lock, or removal.
	 * @param {RequestMeta & { level: Level, target: unknown, elementKey?: string, featureKey?: string, value?: unknown,
	 *   lock?: boolean, clear?: boolean, reason?: unknown, scope?: Scope }} input
	 */
	const setOverride = async ({
		level,
		target,
		elementKey,
		featureKey,
		value,
		lock,
		clear,
		reason,
		scope,
		actor,
		requestId,
		ip,
	}) => {
		/** @type {Record<string, any>} */
		const change = {};
		if (typeof featureKey === 'string') {
			const key = featureKey.includes('.') || !elementKey ? featureKey : `${elementKey}.${featureKey}`;
			if (clear) change.features = { [key]: null };
			else if (value === undefined && typeof lock === 'boolean') change.locks = { features: { [key]: lock } };
			else change.features = { [key]: { value, ...(typeof lock === 'boolean' ? { locked: lock } : {}) } };
		} else if (typeof elementKey === 'string') {
			if (clear) change.elements = { [elementKey]: null };
			else if (value === undefined && typeof lock === 'boolean') change.locks = { elements: { [elementKey]: lock } };
			else if (isRecord(value)) {
				change.config = { [elementKey]: value };
				if (typeof lock === 'boolean')
					change.locks = {
						features: Object.fromEntries(
							Object.keys(/** @type {object} */ (value)).map((name) => [`${elementKey}.${name}`, lock]),
						),
					};
			} else change.elements = { [elementKey]: typeof lock === 'boolean' ? { enabled: value, locked: lock } : value };
		} else {
			throw fail('validation_failed', 'elementKey or featureKey is required.', [
				{ path: '/elementKey', message: 'elementKey or featureKey is required', code: 'invalid_change' },
			]);
		}
		return applyChange({ target, level, change, reason, scope, actor, requestId, ip });
	};

	/**
	 * Current state of one layer.
	 * @param {{ target: unknown, level?: Level, scope?: Scope }} input
	 */
	const getLayer = async ({ target, level, scope }) => {
		const r = await resolveTarget(target, level, scope);
		const current = await loadCurrent(r);
		return { target: publicTarget(r), version: current.version, state: current.state, updatedAt: current.updatedAt };
	};

	/**
	 * Layers of a subscription in the `@ss/entitlements` shape.
	 * @param {string} subscriptionId
	 * @param {{ merchantId?: string, appId?: string }} [hint] commerce may pass what it already knows (saves a round trip)
	 */
	const layersFor = async (subscriptionId, hint = {}) => {
		const info =
			typeof hint.merchantId === 'string' && typeof hint.appId === 'string'
				? { merchantId: hint.merchantId, appId: hint.appId }
				: await subscriptionInfo(subscriptionId);
		const keys = {
			platform: targetKey({ level: 'platform', appId: info.appId }),
			website: targetKey({ level: 'website', subscriptionId }),
			admin: targetKey({ level: 'admin', subscriptionId }),
		};
		const [platformDocs, tenantDocs] = await Promise.all([
			repo.getLayers(null, [keys.platform]),
			repo.getLayers(info.merchantId, [keys.website, keys.admin]),
		]);
		const byKey = new Map([...platformDocs, ...tenantDocs].map((doc) => [doc._id, doc]));
		/** @param {string} key */
		const stateOf = (key) => decodeState(byKey.get(key)?.state);
		return {
			platform: stateOf(keys.platform),
			website: stateOf(keys.website),
			admin: stateOf(keys.admin),
		};
	};

	/**
	 * Everything the merchant console shows for one subscription.
	 * @param {{ subscriptionId: string, scope?: Scope }} input
	 */
	const overview = async ({ subscriptionId, scope }) => {
		const r = await resolveTarget({ subscriptionId }, 'website', scope);
		const layers = await layersFor(subscriptionId, { merchantId: /** @type {string} */ (r.merchantId), appId: r.appId });
		const website = await loadCurrent(r);
		return {
			subscriptionId,
			merchantId: r.merchantId,
			websiteId: r.websiteId,
			appId: r.appId,
			version: website.version,
			layers,
		};
	};

	/**
	 * Newest-first version records of a target (`cursor` = version number to continue below).
	 * @param {unknown} target
	 * @param {{ level?: Level, cursor?: number | string | null, limit?: number, scope?: Scope }} [options]
	 */
	const history = async (target, { level, cursor = null, limit = 20, scope } = {}) => {
		const r = await resolveTarget(target, level, scope);
		const before = cursor === null || cursor === undefined || cursor === '' ? null : Number(cursor);
		if (before !== null && (!Number.isInteger(before) || before < 1)) throw fail('bad_request', 'cursor is invalid');
		const n = Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : 20;
		const docs = await repo.listVersions(location(r), { before, limit: n + 1 });
		const items = docs.slice(0, n).map((doc) => ({
			version: doc.version,
			at: doc.at,
			kind: doc.kind,
			actor: doc.actor,
			reason: doc.reason ?? null,
			diff: doc.diff ?? [],
			manifestVersion: doc.manifestVersion ?? null,
			...(doc.rollbackOf === undefined ? {} : { rollbackOf: doc.rollbackOf }),
		}));
		const last = items.at(-1);
		return { target: publicTarget(r), items, nextCursor: docs.length > n && last ? String(last.version) : null };
	};

	/**
	 * Roll a target back: a NEW version whose state equals version `version` (0 = no overrides).
	 * @param {RequestMeta & { target: unknown, level?: Level, version: unknown, reason?: unknown, scope?: Scope }} input
	 */
	const rollback = async ({ target, level, version, reason, scope, actor, requestId, ip }) => {
		const r = await resolveTarget(target, level, scope);
		if (!Number.isInteger(version) || /** @type {number} */ (version) < 0)
			throw fail('validation_failed', 'version must be a non-negative integer.', [
				{ path: '/version', message: 'invalid version', code: 'invalid_version' },
			]);
		const v = /** @type {number} */ (version);
		/** @type {LayerState} */
		let state = emptyState();
		if (v > 0) {
			const record = await repo.getVersion(location(r), v);
			if (!record) throw fail('not_found', `Version ${v} does not exist.`);
			state = decodeState(record.state);
		}
		return commit({
			r,
			build: () => ({ ok: true, next: state }),
			actor,
			reason: reasonFor(r.level, actor, reason),
			kind: 'rollback',
			extra: { rollbackOf: v },
			requestId: requestId ?? null,
			ip: ip ?? null,
		});
	};

	// --------------------------------------------------------------------------------------------------- preview

	/**
	 * Dry run: the proposed layers of a subscription with `change` applied at `level`, and — when commerce exposes
	 * `previewDocument({ subscriptionId, layers })` — the effective document it would resolve. Nothing is written.
	 * @param {{ subscriptionId: string, change: unknown, level?: Level, actor: Actor, scope?: Scope }} input
	 */
	const preview = async ({ subscriptionId, change, level = 'website', actor, scope }) => {
		const sub = await resolveTarget({ subscriptionId }, 'website', scope);
		const r =
			level === 'website' ? sub : await resolveTarget(level === 'platform' ? { appId: sub.appId } : { subscriptionId }, level);
		if (r.level === 'platform') r.manifestVersion = sub.manifestVersion;
		const current = await loadCurrent(r);
		const { next, diff } = await planChange({ r, actor, current: current.state, build: (state) => applyOps(state, change) });
		const layers = {
			...(await layersFor(subscriptionId, { merchantId: /** @type {string} */ (sub.merchantId), appId: sub.appId })),
			[r.level]: next,
		};
		const commerce = optional('commerce');
		const document =
			typeof commerce?.previewDocument === 'function' ? await commerce.previewDocument({ subscriptionId, layers }) : null;
		return { subscriptionId, level: r.level, diff, layers, preview: document };
	};

	return {
		layersFor,
		describeSubscription: subscriptionInfo,
		setOverride,
		applyChange,
		getLayer,
		overview,
		history,
		rollback,
		preview,
	};
};

/** @typedef {ReturnType<typeof createConfigService>} ConfigService */
