/**
 * Public service of the `config` module: layered overrides (platform, merchant, website, admin) with immutable
 * versions, rollback, locks, templates, scheduled changes, experiments and dry-run previews.
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
import { createId, validateFeatureConfig } from '@ss/contracts';
import { isProblem, problem } from '../../infra/http.js';
import { diffStates, lockedTouches, touchedKeys } from './core/diff.js';
import { toRuntimeExperiment, validateExperiment } from './core/experiments.js';
import { parseName, parseReason, parseScheduleAt } from './core/schedule.js';
import { applyOps, decodeState, emptyState, encodeState, isRecord, opsOf, withoutLocks } from './core/state.js';
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

/** Scheduled changes applied per read of a merchant's configuration, at most (F.19: applied on read, no job). */
export const DUE_SCHEDULES_PER_READ = 20;
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
 * Compact, client-safe description of a failure (per-website template results, failed schedules).
 * @param {unknown} error
 * @returns {{ code: string, detail?: string, errors?: unknown[] } | null} null for unexpected (non-problem) errors
 */
const problemSummary = (error) => {
	if (isProblem(error)) {
		return {
			code: error.code,
			...(error.detail === undefined ? {} : { detail: error.detail }),
			...(error.errors === undefined ? {} : { errors: error.errors }),
		};
	}
	if (isRecord(error) && typeof (/** @type {any} */ (error).status) === 'number' && /** @type {any} */ (error).status < 500) {
		const doc = /** @type {any} */ (error);
		const code =
			typeof doc.code === 'string'
				? doc.code
				: String(doc.type ?? 'error')
						.split('/')
						.pop();
		return { code, ...(typeof doc.detail === 'string' ? { detail: doc.detail } : {}) };
	}
	return null;
};

/**
 * Snapshot of an actor kept on version records and schedules (no roles or grants).
 * @param {Actor} actor
 */
const actorRef = (actor) => ({
	type: actor.type,
	id: actor.id,
	...(actor.merchantId ? { merchantId: actor.merchantId } : {}),
	...(actor.via ? { via: { type: actor.via.type, id: actor.via.id } } : {}),
});

/**
 * @param {Resolved} r
 * @returns {TargetRef & { merchantId?: string, appId?: string, websiteId?: string }}
 */
const publicTarget = (r) =>
	r.level === 'platform'
		? { level: 'platform', appId: r.appId }
		: r.level === 'merchant'
			? { level: 'merchant', merchantId: /** @type {string} */ (r.merchantId), appId: r.appId }
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
		} else if (ref.level === 'merchant') {
			resolved = {
				level: 'merchant',
				key: targetKey(ref),
				merchantId: ref.merchantId,
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
			if (r.level === 'merchant') {
				for (const subscriptionId of await merchantAppSubscriptions(/** @type {string} */ (r.merchantId), r.appId)) {
					if (typeof commerce.invalidate === 'function') await commerce.invalidate(subscriptionId);
				}
				return;
			}
			if (typeof commerce.invalidateApp === 'function') await commerce.invalidateApp(r.appId);
			else ctx.logger.warn('platform policy changed but commerce exposes no invalidateApp', { appId: r.appId });
		} catch (error) {
			ctx.logger.warn('commerce invalidation failed', { error, target: r.key });
		}
	};

	/**
	 * Subscriptions of one merchant for one app (identity websites × commerce subscriptions).
	 * @param {string} merchantId
	 * @param {string} appId
	 * @returns {Promise<string[]>}
	 */
	const merchantAppSubscriptions = async (merchantId, appId) => {
		const identity = optional('identity');
		const commerce = optional('commerce');
		if (!identity?.listWebsites || !commerce?.subscriptionsForWebsite) return [];
		const listed = await identity.listWebsites(merchantId);
		const websites = Array.isArray(listed) ? listed : Array.isArray(listed?.items) ? listed.items : [];
		/** @type {string[]} */
		const out = [];
		for (const website of websites) {
			const subs = await commerce.subscriptionsForWebsite(website.websiteId);
			for (const sub of Array.isArray(subs) ? subs : (subs?.items ?? [])) {
				if (sub.appId === appId) out.push(sub.subscriptionId ?? sub.id);
			}
		}
		return out;
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
	 * Commit a change as a new immutable version (idempotent per `changeKey`), audit it and invalidate commerce.
	 * @param {object} input
	 * @param {Resolved} input.r
	 * @param {(state: LayerState) => ({ ok: true, next: LayerState } | { ok: false, errors: FieldError[] })} input.build
	 * @param {Actor} input.actor
	 * @param {string | null} input.reason
	 * @param {'change' | 'rollback' | 'template' | 'scheduled' | 'experiment'} input.kind
	 * @param {string} [input.changeKey]
	 * @param {Record<string, unknown>} [input.extra] stored on the version record
	 * @param {string | null} [input.requestId]
	 * @param {string | null} [input.ip]
	 */
	const commit = async ({ r, build, actor, reason, kind, changeKey, extra = {}, requestId = null, ip = null }) => {
		const at = location(r);
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
			if (changeKey) {
				const done = await repo.findByChangeKey(at, changeKey);
				if (done)
					return { target: publicTarget(r), version: done.version, diff: done.diff ?? [], unchanged: false, replayed: true };
			}
			const current = await loadCurrent(r);
			const { next, diff, manifestVersion } = await planChange({ r, actor, current: current.state, build });
			if (diff.length === 0)
				return { target: publicTarget(r), version: current.version, diff, unchanged: true, replayed: false };
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
				...(changeKey ? { changeKey } : {}),
				...extra,
			};
			if (!(await repo.insertVersion(at, record))) continue; // a concurrent writer took this version (or change key)
			await repo.writeLayer(at, layerDoc(r, version, stored, record.actor));
			await ctx.audit.record({
				actor,
				action: `config.${kind === 'change' ? 'changed' : kind === 'rollback' ? 'rolled_back' : `${kind}_applied`}`,
				target: { type: 'config_layer', id: r.key, merchantId: r.merchantId, websiteId: r.websiteId },
				before: { version: current.version },
				after: { version, diff },
				requestId,
				ip,
				reason,
			});
			await invalidate(r);
			return { target: publicTarget(r), version, diff, unchanged: false, replayed: false };
		}
		throw fail('conflict', 'The configuration changed concurrently; retry.');
	};

	/**
	 * @param {Level} level
	 * @param {Actor} actor
	 * @param {unknown} reason
	 */
	const reasonFor = (level, actor, reason) => {
		const parsed = parseReason(reason, STAFF_LEVELS.has(level) && actor?.type === 'staff');
		if (!parsed.ok)
			throw fail('validation_failed', parsed.message, [{ path: '/reason', message: parsed.message, code: 'invalid_reason' }]);
		return parsed.value;
	};

	/**
	 * Apply a change (elements / features / config / locks) to one layer.
	 * @param {RequestMeta & { target: unknown, level?: Level, change: unknown, reason?: unknown, scope?: Scope, changeKey?: string,
	 *   kind?: 'change' | 'template' | 'scheduled' | 'experiment', extra?: Record<string, unknown> }} input
	 */
	const applyChange = async ({
		target,
		level,
		change,
		reason,
		scope,
		actor,
		requestId,
		ip,
		changeKey,
		kind = 'change',
		extra,
	}) => {
		const r = await resolveTarget(target, level, scope);
		return commit({
			r,
			build: (state) => applyOps(state, change),
			actor,
			reason: reasonFor(r.level, actor, reason),
			kind,
			...(changeKey ? { changeKey } : {}),
			...(extra ? { extra } : {}),
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
	 * Layers of a subscription in the `@ss/entitlements` shape, plus running experiments (`runtime.experiments`).
	 * @param {string} subscriptionId
	 * @param {{ merchantId?: string, appId?: string }} [hint] commerce may pass what it already knows (saves a round trip)
	 */
	const layersFor = async (subscriptionId, hint = {}) => {
		const info =
			typeof hint.merchantId === 'string' && typeof hint.appId === 'string'
				? { merchantId: hint.merchantId, appId: hint.appId }
				: await subscriptionInfo(subscriptionId);
		await applyDue(info.merchantId);
		const keys = {
			platform: targetKey({ level: 'platform', appId: info.appId }),
			merchant: targetKey({ level: 'merchant', merchantId: info.merchantId, appId: info.appId }),
			website: targetKey({ level: 'website', subscriptionId }),
			admin: targetKey({ level: 'admin', subscriptionId }),
		};
		const [platformDocs, tenantDocs, running] = await Promise.all([
			repo.getLayers(null, [keys.platform]),
			repo.getLayers(info.merchantId, [keys.merchant, keys.website, keys.admin]),
			repo.listExperiments(info.merchantId, subscriptionId, 'running'),
		]);
		const byKey = new Map([...platformDocs, ...tenantDocs].map((doc) => [doc._id, doc]));
		/** @param {string} key */
		const stateOf = (key) => decodeState(byKey.get(key)?.state);
		return {
			platform: stateOf(keys.platform),
			merchant: stateOf(keys.merchant),
			website: stateOf(keys.website),
			admin: stateOf(keys.admin),
			experiments: running
				.map((doc) => toRuntimeExperiment({ experimentId: String(doc._id), element: doc.element, variants: doc.variants }))
				.sort((a, b) => (a.id < b.id ? -1 : 1)),
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
			...(doc.templateId === undefined ? {} : { templateId: doc.templateId, templateVersion: doc.templateVersion }),
			...(doc.scheduleId === undefined ? {} : { scheduleId: doc.scheduleId }),
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

	// ------------------------------------------------------------------------------------------------- templates

	/**
	 * Template settings: website-level elements/features/config only (no locks).
	 * @param {string} appId
	 * @param {unknown} settings
	 */
	const templateState = async (appId, settings) => {
		if (isRecord(settings) && /** @type {Record<string, unknown>} */ (settings).locks !== undefined)
			throw fail('validation_failed', 'Templates cannot carry locks.', [
				{ path: '/settings/locks', message: 'locks are staff-only', code: 'lock_forbidden' },
			]);
		const built = applyOps(emptyState(), settings);
		if (!built.ok)
			throw fail(
				'validation_failed',
				'The template settings are invalid.',
				built.errors.map((e) => ({ ...e, path: `/settings${e.path}` })),
			);
		const locked = diffStates(emptyState(), built.next).filter((d) => /** @type {any} */ (d.after)?.locked === true);
		/** @type {FieldError[]} */
		const errors = locked.map((d) => ({
			path: `/settings/${d.kind}/${d.key}/locked`,
			message: 'locks are staff-only',
			code: 'lock_forbidden',
		}));
		const { index } = await manifestFor(appId, null);
		const state = withoutLocks(built.next);
		errors.push(
			...validateEntries({
				index,
				state,
				keys: { elements: Object.keys(state.elements), features: Object.keys(state.features) },
				validateFeatureConfig,
			}).map((e) => ({ ...e, path: `/settings${e.path}` })),
		);
		if (errors.length > 0) throw fail('validation_failed', 'The template settings are invalid.', errors);
		return state;
	};

	/** @param {any} doc */
	const templateView = (doc) => ({
		templateId: String(doc._id),
		merchantId: doc.merchantId,
		appId: doc.appId,
		name: doc.name,
		version: doc.version,
		settings: decodeState(doc.settings),
		applications: Object.entries(doc.applications ?? {}).map(([websiteId, a]) => ({ websiteId, .../** @type {object} */ (a) })),
		createdAt: doc.createdAt,
		updatedAt: doc.updatedAt,
	});

	/**
	 * @param {RequestMeta & { merchantId: string, appId: string, name: unknown, settings: unknown }} input
	 */
	const saveTemplate = async ({ merchantId, appId, name, settings, actor, requestId, ip }) => {
		if (!actorMayWrite(actor?.type, 'website')) throw fail('forbidden', 'Not allowed to save templates.');
		const target = parseTarget({ merchantId, appId }, 'merchant');
		if (!target.ok) throw fail('validation_failed', 'merchantId and appId are required.', target.errors);
		const parsedName = parseName(name);
		if (!parsedName.ok)
			throw fail('validation_failed', parsedName.message, [
				{ path: '/name', message: parsedName.message, code: 'invalid_name' },
			]);
		const state = await templateState(appId, settings);
		const templateId = createId('cft', { randomBytes: ctx.randomBytes });
		const doc = {
			_id: templateId,
			appId,
			name: parsedName.value,
			version: 1,
			settings: encodeState(state),
			applications: {},
			createdBy: actorRef(actor),
		};
		await repo.insertTemplate(merchantId, doc);
		await ctx.audit.record({
			actor,
			action: 'config.template_saved',
			target: { type: 'config_template', id: templateId, merchantId },
			after: { name: doc.name, appId, version: 1, settings: state },
			requestId: requestId ?? null,
			ip: ip ?? null,
		});
		return templateView({ ...doc, merchantId });
	};

	/**
	 * New template version (re-push it with {@link pushTemplate}).
	 * @param {RequestMeta & { merchantId: string, templateId: string, name?: unknown, settings?: unknown, version?: number }} input
	 */
	const updateTemplate = async ({ merchantId, templateId, name, settings, version, actor, requestId, ip }) => {
		if (!actorMayWrite(actor?.type, 'website')) throw fail('forbidden', 'Not allowed to change templates.');
		const existing = await repo.getTemplate(merchantId, templateId);
		if (!existing) throw fail('not_found', 'No such template.');
		if (version !== undefined && version !== existing.version) throw fail('conflict', 'The template was changed meanwhile.');
		/** @type {Record<string, unknown>} */
		const set = { version: existing.version + 1, updatedBy: actorRef(actor) };
		if (name !== undefined) {
			const parsedName = parseName(name);
			if (!parsedName.ok)
				throw fail('validation_failed', parsedName.message, [
					{ path: '/name', message: parsedName.message, code: 'invalid_name' },
				]);
			set.name = parsedName.value;
		}
		if (settings !== undefined) set.settings = encodeState(await templateState(existing.appId, settings));
		const updated = await repo.updateTemplate(merchantId, templateId, existing.version, set);
		if (!updated) throw fail('conflict', 'The template was changed meanwhile.');
		await ctx.audit.record({
			actor,
			action: 'config.template_updated',
			target: { type: 'config_template', id: templateId, merchantId },
			before: { version: existing.version },
			after: {
				version: set.version,
				...(set.name ? { name: set.name } : {}),
				...(settings === undefined ? {} : { settings: decodeState(set.settings) }),
			},
			requestId: requestId ?? null,
			ip: ip ?? null,
		});
		return templateView(updated);
	};

	/** @param {{ merchantId: string, templateId: string }} input */
	const getTemplate = async ({ merchantId, templateId }) => {
		const doc = await repo.getTemplate(merchantId, templateId);
		if (!doc) throw fail('not_found', 'No such template.');
		return templateView(doc);
	};

	/** @param {{ merchantId: string, appId?: string | null }} input */
	const listTemplates = async ({ merchantId, appId = null }) => ({
		items: (await repo.listTemplates(merchantId, appId)).map(templateView),
	});

	/**
	 * Apply a template to websites as a normal versioned website-level change each; per-website results.
	 * @param {RequestMeta & { templateId: string, websiteIds: unknown, merchantId?: string, canWrite?: (websiteId: string) => boolean }} input
	 */
	const applyTemplate = async ({ templateId, websiteIds, merchantId, canWrite, actor, requestId, ip }) => {
		const doc = merchantId ? await repo.getTemplate(merchantId, templateId) : await repo.findTemplateAnyMerchant(templateId);
		if (!doc) throw fail('not_found', 'No such template.');
		const ids = Array.isArray(websiteIds) ? [...new Set(websiteIds)] : null;
		if (
			!ids ||
			ids.length === 0 ||
			ids.length > 100 ||
			ids.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 80)
		)
			throw fail('validation_failed', 'websiteIds must be 1..100 website ids.', [
				{ path: '/websiteIds', message: 'invalid websiteIds', code: 'invalid_websites' },
			]);
		const owner = /** @type {string} */ (doc.merchantId);
		const state = decodeState(doc.settings);
		const identity = optional('identity');
		const commerce = optional('commerce');
		/** @type {Array<Record<string, unknown>>} */
		const results = [];
		for (const websiteId of /** @type {string[]} */ (ids)) {
			try {
				if (canWrite && !canWrite(websiteId)) throw fail('forbidden', 'Missing permission config.write on this website.');
				if (identity?.getWebsite) {
					/** @type {any} */
					let website = null;
					try {
						website = await identity.getWebsite(websiteId);
					} catch (error) {
						if (!isNotFound(error)) throw error;
					}
					if (!website || website.merchantId !== owner) throw fail('not_found', 'No such website.');
				}
				if (!commerce?.subscriptionsForWebsite) throw fail('unavailable', 'Subscriptions are not available.');
				const listed = await commerce.subscriptionsForWebsite(websiteId);
				const subs = Array.isArray(listed) ? listed : (listed?.items ?? []);
				const sub = subs.find((/** @type {any} */ s) => s.appId === doc.appId && s.status !== 'cancelled');
				if (!sub) throw fail('not_found', 'The website has no subscription to this app.');
				const subscriptionId = String(sub.subscriptionId ?? sub.id);
				const result = await applyChange({
					target: { subscriptionId },
					level: 'website',
					change: opsOf(state),
					reason: `template ${doc.name} v${doc.version}`,
					scope: { merchantId: owner, websiteId },
					actor,
					requestId,
					ip,
					kind: 'template',
					extra: { templateId, templateVersion: doc.version },
				});
				await repo.recordApplication(owner, templateId, websiteId, {
					subscriptionId,
					templateVersion: doc.version,
					version: result.version,
					at: new Date(ctx.now()),
				});
				results.push({
					websiteId,
					subscriptionId,
					status: result.unchanged ? 'unchanged' : 'applied',
					version: result.version,
				});
			} catch (error) {
				const summary = problemSummary(error);
				if (summary === null) {
					ctx.logger.error('template application failed', { error, templateId, websiteId });
					results.push({ websiteId, status: 'failed', error: { code: 'internal_error' } });
				} else results.push({ websiteId, status: 'failed', error: summary });
			}
		}
		const failed = results.filter((r) => r.status === 'failed').length;
		return { templateId, templateVersion: doc.version, applied: results.length - failed, failed, results };
	};

	/**
	 * Re-push the current template version to every website it was applied to with an older version (`all` = every one).
	 * @param {RequestMeta & { merchantId: string, templateId: string, all?: boolean, canWrite?: (websiteId: string) => boolean }} input
	 */
	const pushTemplate = async ({ merchantId, templateId, all = false, canWrite, actor, requestId, ip }) => {
		const doc = await repo.getTemplate(merchantId, templateId);
		if (!doc) throw fail('not_found', 'No such template.');
		const websiteIds = Object.entries(doc.applications ?? {})
			.filter(([, a]) => all || /** @type {any} */ (a).templateVersion < doc.version)
			.map(([websiteId]) => websiteId);
		if (websiteIds.length === 0) return { templateId, templateVersion: doc.version, applied: 0, failed: 0, results: [] };
		return applyTemplate({ templateId, websiteIds, merchantId, ...(canWrite ? { canWrite } : {}), actor, requestId, ip });
	};

	// ------------------------------------------------------------------------------------------------- schedules

	/** @param {any} doc */
	const scheduleView = (doc) => ({
		scheduleId: String(doc._id),
		target: doc.target,
		at: doc.at,
		status: doc.status,
		change: JSON.parse(doc.change),
		reason: doc.reason ?? null,
		createdBy: doc.createdBy,
		...(doc.version === undefined ? {} : { version: doc.version }),
		...(doc.error === undefined ? {} : { error: doc.error }),
		...(doc.appliedAt === undefined ? {} : { appliedAt: doc.appliedAt }),
	});

	/**
	 * Store a change to apply later (validated now and again when applied). It is applied on read (F.19: no job): the
	 * first read of the merchant's configuration at or after `at` (a document refresh, a console read) applies it.
	 * @param {RequestMeta & { change: unknown, at: unknown, scope?: Scope }} input
	 */
	const schedule = async ({ change, at, scope, actor, requestId, ip }) => {
		if (!isRecord(change))
			throw fail('validation_failed', 'change must be an object.', [
				{ path: '/change', message: 'change must be an object', code: 'invalid_change' },
			]);
		const { target, level, reason, ...ops } = /** @type {Record<string, any>} */ (change);
		const r = await resolveTarget(target, level, scope);
		if (r.merchantId === null)
			throw fail('validation_failed', 'Platform policies cannot be scheduled.', [
				{ path: '/change/target', message: 'platform level', code: 'invalid_target' },
			]);
		const when = parseScheduleAt(at, ctx.now());
		if (!when.ok) throw fail('validation_failed', when.message, [{ path: '/at', message: when.message, code: 'invalid_at' }]);
		const why = reasonFor(r.level, actor, reason);
		await planChange({ r, actor, current: (await loadCurrent(r)).state, build: (state) => applyOps(state, ops) });
		const scheduleId = createId('cfs', { randomBytes: ctx.randomBytes });
		const doc = {
			_id: scheduleId,
			targetKey: r.key,
			target: publicTarget(r),
			change: JSON.stringify(ops),
			at: new Date(when.value),
			status: 'pending',
			reason: why,
			createdBy: actorRef(actor),
		};
		const merchantId = /** @type {string} */ (r.merchantId);
		await repo.insertSchedule(merchantId, doc);
		await ctx.audit.record({
			actor,
			action: 'config.scheduled',
			target: { type: 'config_layer', id: r.key, merchantId, websiteId: r.websiteId },
			after: { scheduleId, at: doc.at, change: ops },
			requestId: requestId ?? null,
			ip: ip ?? null,
			reason: why,
		});
		return scheduleView({ ...doc, merchantId });
	};

	/**
	 * Apply a scheduled change exactly once (version change key `schedule:<id>`).
	 * @param {{ scheduleId: string, merchantId: string }} payload
	 */
	const applyScheduled = async ({ scheduleId, merchantId }) => {
		const doc = await repo.getSchedule(merchantId, scheduleId);
		if (!doc) return { status: 'missing' };
		if (doc.status !== 'pending' && doc.status !== 'applying') return { status: doc.status };
		const claimed = await repo.transitionSchedule(merchantId, scheduleId, ['pending', 'applying'], { status: 'applying' });
		if (!claimed) return { status: 'skipped' };
		const actor = /** @type {Actor} */ (doc.createdBy);
		try {
			const result = await applyChange({
				target: doc.target,
				level: doc.target.level,
				change: JSON.parse(doc.change),
				reason: doc.reason ?? `scheduled change ${scheduleId}`,
				actor,
				changeKey: `schedule:${scheduleId}`,
				kind: 'scheduled',
				extra: { scheduleId },
			});
			await repo.transitionSchedule(merchantId, scheduleId, ['applying'], {
				status: 'applied',
				version: result.version,
				appliedAt: new Date(ctx.now()),
			});
			return { status: 'applied', version: result.version };
		} catch (error) {
			const summary = problemSummary(error);
			if (summary === null || summary.code === 'unavailable' || summary.code === 'conflict') throw error; // retried
			await repo.transitionSchedule(merchantId, scheduleId, ['applying'], { status: 'failed', error: summary });
			return { status: 'failed', error: summary };
		}
	};

	/** @type {Set<string>} merchants whose due changes this instance is applying (an apply re-reads the layers) */
	const applying = new Set();

	/**
	 * Apply the merchant's scheduled changes whose time has come, oldest first (bounded). Runs when the merchant's
	 * configuration is read; failures are logged and the change is tried again on the next read.
	 * @param {string} merchantId
	 */
	const applyDue = async (merchantId) => {
		if (applying.has(merchantId)) return;
		applying.add(merchantId);
		try {
			for (const doc of await repo.dueSchedules(merchantId, new Date(ctx.now()), DUE_SCHEDULES_PER_READ)) {
				try {
					await applyScheduled({ scheduleId: String(doc._id), merchantId });
				} catch (error) {
					ctx.logger.warn('scheduled change not applied yet', { scheduleId: String(doc._id), error });
				}
			}
		} finally {
			applying.delete(merchantId);
		}
	};

	/**
	 * @param {RequestMeta & { merchantId: string, scheduleId: string, scope?: Scope }} input
	 */
	const cancelSchedule = async ({ merchantId, scheduleId, scope, actor, requestId, ip }) => {
		const doc = await repo.getSchedule(merchantId, scheduleId);
		if (!doc || (scope?.websiteId !== undefined && doc.target.websiteId !== scope.websiteId))
			throw fail('not_found', 'No such scheduled change.');
		if (!actorMayWrite(actor?.type, doc.target.level)) throw fail('forbidden', 'Not allowed to cancel this change.');
		const updated = await repo.transitionSchedule(merchantId, scheduleId, ['pending'], {
			status: 'cancelled',
			cancelledBy: actorRef(actor),
		});
		if (!updated) throw fail('conflict', `The scheduled change is already ${doc.status}.`);
		await ctx.audit.record({
			actor,
			action: 'config.schedule_cancelled',
			target: { type: 'config_layer', id: doc.targetKey, merchantId, websiteId: doc.target.websiteId ?? null },
			before: { scheduleId, status: doc.status },
			after: { scheduleId, status: 'cancelled' },
			requestId: requestId ?? null,
			ip: ip ?? null,
		});
		return scheduleView(updated);
	};

	/** @param {{ target: unknown, level?: Level, scope?: Scope }} input */
	const listSchedules = async ({ target, level, scope }) => {
		const r = await resolveTarget(target, level, scope);
		if (r.merchantId === null) return { items: [] };
		await applyDue(r.merchantId);
		return { items: (await repo.listSchedules(r.merchantId, r.key)).map(scheduleView) };
	};

	// ----------------------------------------------------------------------------------------------- experiments

	/** @param {any} doc */
	const experimentView = (doc) => ({
		experimentId: String(doc._id),
		subscriptionId: doc.subscriptionId,
		websiteId: doc.websiteId,
		appId: doc.appId,
		element: doc.element,
		...(doc.name === undefined ? {} : { name: doc.name }),
		variants: doc.variants,
		metric: doc.metric,
		status: doc.status,
		...(doc.startedAt ? { startedAt: doc.startedAt } : {}),
		...(doc.stoppedAt ? { stoppedAt: doc.stoppedAt } : {}),
		...(doc.winner ? { winner: doc.winner } : {}),
	});

	/**
	 * @param {RequestMeta & { subscriptionId: string, experiment: unknown, scope?: Scope }} input
	 */
	const createExperiment = async ({ subscriptionId, experiment, scope, actor, requestId, ip }) => {
		const r = await resolveTarget({ subscriptionId }, 'website', scope);
		if (!actorMayWrite(actor?.type, 'website')) throw fail('forbidden', 'Not allowed to create experiments.');
		const { index } = await manifestFor(r.appId, r.manifestVersion);
		const checked = validateExperiment({ index, input: experiment, validateFeatureConfig });
		if (!checked.ok) throw fail('validation_failed', 'The experiment is invalid.', checked.errors);
		const merchantId = /** @type {string} */ (r.merchantId);
		const doc = {
			_id: createId('exp', { randomBytes: ctx.randomBytes }),
			subscriptionId,
			websiteId: r.websiteId,
			appId: r.appId,
			...checked.value,
			status: 'draft',
			createdBy: actorRef(actor),
		};
		await repo.insertExperiment(merchantId, doc);
		await ctx.audit.record({
			actor,
			action: 'config.experiment_created',
			target: { type: 'config_experiment', id: doc._id, merchantId, websiteId: r.websiteId },
			after: checked.value,
			requestId: requestId ?? null,
			ip: ip ?? null,
		});
		return experimentView(doc);
	};

	/**
	 * @param {RequestMeta & { subscriptionId: string, experimentId: string, to: 'running' | 'stopped', applyVariant?: unknown, scope?: Scope }} input
	 */
	const transitionExperiment = async ({ subscriptionId, experimentId, to, applyVariant, scope, actor, requestId, ip }) => {
		const r = await resolveTarget({ subscriptionId }, 'website', scope);
		if (!actorMayWrite(actor?.type, 'website')) throw fail('forbidden', 'Not allowed to change experiments.');
		const merchantId = /** @type {string} */ (r.merchantId);
		const doc = await repo.getExperiment(merchantId, experimentId);
		if (!doc || doc.subscriptionId !== subscriptionId) throw fail('not_found', 'No such experiment.');
		/** @type {any} */
		let variant = null;
		if (to === 'stopped' && applyVariant !== undefined && applyVariant !== null) {
			variant = doc.variants.find((/** @type {any} */ v) => v.key === applyVariant);
			if (!variant)
				throw fail('validation_failed', 'Unknown variant.', [
					{ path: '/applyVariant', message: 'unknown variant', code: 'invalid_variant' },
				]);
		}
		const t = new Date(ctx.now());
		const from = to === 'running' ? ['draft'] : ['draft', 'running'];
		const set =
			to === 'running'
				? { status: 'running', startedAt: t }
				: { status: 'stopped', stoppedAt: t, ...(variant ? { winner: variant.key } : {}) };
		const updated = await repo.transitionExperiment(merchantId, experimentId, from, set);
		if (updated === 'conflict') throw fail('conflict', `Another experiment is already running on ${doc.element}.`);
		if (!updated) throw fail('conflict', `The experiment is already ${doc.status}.`);
		await ctx.audit.record({
			actor,
			action: to === 'running' ? 'config.experiment_started' : 'config.experiment_stopped',
			target: { type: 'config_experiment', id: experimentId, merchantId, websiteId: r.websiteId },
			before: { status: doc.status },
			after: { status: to, ...(variant ? { winner: variant.key } : {}) },
			requestId: requestId ?? null,
			ip: ip ?? null,
		});
		/** @type {unknown} */
		let applied = null;
		if (variant) {
			applied = await applyChange({
				target: { subscriptionId },
				level: 'website',
				change: { config: { [doc.element]: variant.config } },
				reason: `experiment ${experimentId} winner ${variant.key}`,
				scope,
				actor,
				requestId,
				ip,
				kind: 'experiment',
				extra: { experimentId },
			});
		} else await invalidate(r);
		return { ...experimentView(updated), ...(applied ? { applied } : {}) };
	};

	/** @param {{ subscriptionId: string, scope?: Scope }} input */
	const listExperiments = async ({ subscriptionId, scope }) => {
		const r = await resolveTarget({ subscriptionId }, 'website', scope);
		return { items: (await repo.listExperiments(/** @type {string} */ (r.merchantId), subscriptionId)).map(experimentView) };
	};

	// --------------------------------------------------------------------------------------------------- preview

	/**
	 * Dry run: the proposed layers of a subscription with `change` applied at `level`, and — when commerce exposes
	 * `previewDocument({ subscriptionId, layers })` — the effective document it would resolve. Nothing is written.
	 * @param {{ subscriptionId: string, change: unknown, level?: Level, actor: Actor, scope?: Scope }} input
	 */
	const preview = async ({ subscriptionId, change, level = 'website', actor, scope }) => {
		const sub = await resolveTarget({ subscriptionId }, 'website', scope);
		const target =
			level === 'platform'
				? { appId: sub.appId }
				: level === 'merchant'
					? { merchantId: sub.merchantId, appId: sub.appId }
					: { subscriptionId };
		const r = level === 'website' ? sub : await resolveTarget(target, level);
		if (r.level === 'platform') r.manifestVersion = sub.manifestVersion;
		if (r.level === 'merchant') r.manifestVersion = sub.manifestVersion;
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
		saveTemplate,
		updateTemplate,
		getTemplate,
		listTemplates,
		applyTemplate,
		pushTemplate,
		schedule,
		applyScheduled,
		applyDue,
		cancelSchedule,
		listSchedules,
		createExperiment,
		/** @param {Parameters<typeof transitionExperiment>[0] extends infer T ? Omit<T, 'to'> : never} input */
		startExperiment: (input) => transitionExperiment({ ...input, to: 'running' }),
		/** @param {Parameters<typeof transitionExperiment>[0] extends infer T ? Omit<T, 'to'> : never} input */
		stopExperiment: (input) => transitionExperiment({ ...input, to: 'stopped' }),
		listExperiments,
		preview,
	};
};

/** @typedef {ReturnType<typeof createConfigService>} ConfigService */
