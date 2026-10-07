/**
 * Public service of the `connectors` module: client-owned resources (PLAN §1a) — the merchant's own database,
 * storage, AI, messaging and payments credentials.
 *
 * Custody rules (binding):
 * - credentials are validated server-side (`core/schemas.js`), sealed with `ctx.envelope` under
 *   `aad = { connector: merchantId + ':' + connectorId }` (a sealed value cannot be replayed into another merchant's
 *   or another connector's record), and **never returned**: responses carry masked previews only;
 * - they are opened only to run a connection check and at `resolve` time, for a product with an active subscription
 *   on the website whose accepted manifest requires the kind; every resolve (granted or denied) is audited without
 *   secrets;
 * - editing replaces the sealed credentials in place (re-sealed, re-checked); deleting removes the record and its
 *   sealed material and stops resolution at once;
 * - every outbound call of a check goes through the `@ss/net` SSRF guard (URL policy + guarded DNS lookup).
 * @module
 */
import { createId, isId } from '@ss/contracts';
import { problem } from '../../infra/http.js';
import { afterResponse } from '../../infra/request-scope.js';
import { decideResolve } from './core/access.js';
import { DESCRIPTOR_TTL_MS, descriptorOf } from './core/descriptor.js';
import { previewOf } from './core/mask.js';
import { buildReport, statusFromReport } from './core/report.js';
import { KINDS, validateCredentials, validateLabel, validateWebsiteIds } from './core/schemas.js';
import { createConnectorsRepo } from './repo.js';
import { ASSIGNMENTS, CONNECTORS } from './schema.js';

/** @typedef {import('../../infra/modules.js').ModuleContext} ModuleContext */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */
/** @typedef {import('@ss/net').OutboundPolicy} OutboundPolicy */
/** @typedef {import('./core/report.js').CheckReport} CheckReport */
/** @typedef {import('./adapters/probes.js').Probes} Probes */
/** @typedef {import('mongodb').Document} Document */
/** @typedef {{ actor: Actor | { type: 'system', id: string }, requestId?: string | null, ip?: string | null }} Caller */

export const HEALTH_INTERVAL_MS = 50 * 60_000;
const SYSTEM = Object.freeze({ type: /** @type {const} */ ('system'), id: 'connectors.health_check' });

/** @param {Date | null | undefined} value */
const iso = (value) => (value instanceof Date ? value.toISOString() : null);

/**
 * @param {ModuleContext} ctx
 * @param {{ policy: OutboundPolicy, probes: Probes }} options outbound policy (`@ss/net`) and connection checks
 */
export const createConnectorsService = (ctx, { policy, probes }) => {
	const repo = createConnectorsRepo({ connectors: ctx.collection(CONNECTORS), assignments: ctx.collection(ASSIGNMENTS) });
	const log = ctx.logger;

	/**
	 * @param {string} merchantId
	 * @param {string} connectorId
	 */
	const aadOf = (merchantId, connectorId) => ({ connector: `${merchantId}:${connectorId}` });
	/**
	 * @param {string} merchantId
	 * @param {string} connectorId
	 * @param {Record<string, unknown>} credentials
	 */
	const seal = (merchantId, connectorId, credentials) =>
		ctx.envelope.seal(JSON.stringify(credentials), { aad: aadOf(merchantId, connectorId) });
	/**
	 * @param {Document} doc
	 * @returns {Record<string, any>}
	 */
	const open = (doc) => JSON.parse(ctx.envelope.openText(String(doc.sealed), { aad: aadOf(doc.merchantId, String(doc._id)) }));

	/** @param {string} name */
	const optional = (name) => (ctx.moduleNames().includes(name) ? ctx.service(name) : null);

	/**
	 * Merchant-facing presentation (masked preview, never sealed material).
	 * @param {Document} doc
	 */
	const present = (doc) => ({
		...presentStatus(doc),
		preview: doc.preview ?? null,
	});
	/**
	 * Staff presentation: status only (no preview).
	 * @param {Document} doc
	 */
	const presentStatus = (doc) => ({
		connectorId: String(doc._id),
		merchantId: doc.merchantId,
		kind: doc.kind,
		provider: doc.provider,
		label: doc.label,
		websiteIds: [...(doc.websiteIds ?? [])],
		status: doc.status,
		lastCheckAt: iso(doc.lastCheckAt),
		lastCheckReport: doc.lastCheckReport ?? null,
		createdAt: iso(doc.createdAt),
		updatedAt: iso(doc.updatedAt),
	});
	/** @param {Document} doc */
	const summary = (doc) => ({
		kind: doc.kind,
		provider: doc.provider,
		label: doc.label,
		websiteIds: [...(doc.websiteIds ?? [])],
		status: doc.status,
	});

	/**
	 * @param {Caller} caller
	 * @param {string} action
	 * @param {Document} doc
	 * @param {{ before?: unknown, after?: unknown, reason?: string | null }} [extra]
	 */
	const audit = (caller, action, doc, extra = {}) =>
		ctx.audit.record({
			actor: /** @type {any} */ (caller.actor),
			action,
			target: { type: 'connector', id: String(doc._id), merchantId: doc.merchantId },
			...(extra.before === undefined ? {} : { before: extra.before }),
			...(extra.after === undefined ? {} : { after: extra.after }),
			requestId: caller.requestId ?? null,
			ip: caller.ip ?? null,
			reason: extra.reason ?? null,
		});

	/**
	 * Publish `resource.changed@1` for each change (when the integration module is present) and let commerce refresh
	 * the affected entitlement documents. Failures are logged, never thrown.
	 * @param {Array<{ websiteId: string, kind: string, status: string, ref: string }>} changes
	 */
	const notify = async (changes) => {
		const integration = optional('integration');
		const commerce = optional('commerce');
		for (const change of changes) {
			try {
				if (integration) await integration.emitControl('resource.changed@1', change, { websiteId: change.websiteId });
			} catch (error) {
				log.warn('resource.changed emit failed', { websiteId: change.websiteId, kind: change.kind, error });
			}
			try {
				if (commerce && typeof commerce.invalidate === 'function') {
					for (const s of (await commerce.subscriptionsForWebsite(change.websiteId)) ?? [])
						await commerce.invalidate(s.subscriptionId);
				}
			} catch (error) {
				log.warn('entitlement invalidation failed', { websiteId: change.websiteId, error });
			}
		}
	};
	/**
	 * @param {Document} doc
	 * @param {string[]} websiteIds
	 * @param {string} [status]
	 */
	const changesFor = (doc, websiteIds, status = doc.status) =>
		websiteIds.map((websiteId) => ({ websiteId, kind: String(doc.kind), status: String(status), ref: String(doc._id) }));

	/**
	 * @param {string} detail
	 * @param {Array<{ path: string, message: string }>} errors
	 */
	const invalid = (detail, errors) => problem('validation_failed', detail, { errors });

	/**
	 * Every website must exist and belong to the merchant (another merchant's website is reported as unknown).
	 * @param {string} merchantId
	 * @param {string[]} websiteIds
	 */
	const checkWebsites = async (merchantId, websiteIds) => {
		const identity = ctx.service('identity');
		const errors = [];
		for (const [i, websiteId] of websiteIds.entries()) {
			const website = await Promise.resolve(identity.getWebsite(websiteId)).catch(() => null);
			if (!website || website.merchantId !== merchantId)
				errors.push({ path: `/websiteIds/${i}`, message: 'is not a website of this merchant' });
		}
		if (errors.length > 0) throw invalid('Unknown websites.', errors);
	};

	/**
	 * @param {string} merchantId
	 * @param {unknown} connectorId
	 */
	const load = async (merchantId, connectorId) => {
		const doc = typeof connectorId === 'string' && isId(connectorId, 'con') ? await repo.get(merchantId, connectorId) : null;
		if (!doc) throw problem('not_found', 'No such connector.');
		return doc;
	};

	/**
	 * Claim (website, kind) for a connector; on any refusal release what was claimed and throw 409.
	 * @param {Document} doc
	 * @param {string[]} websiteIds
	 */
	const claimAll = async (doc, websiteIds) => {
		/** @type {string[]} */
		const claimed = [];
		for (const websiteId of websiteIds) {
			if (await repo.claim(doc.merchantId, { websiteId, kind: String(doc.kind), connectorId: String(doc._id) }))
				claimed.push(websiteId);
			else {
				await releaseAll(doc, claimed);
				throw problem('conflict', `A website already has a ${doc.kind} connector; unassign it first.`);
			}
		}
	};
	/**
	 * @param {Document} doc
	 * @param {string[]} websiteIds
	 */
	const releaseAll = async (doc, websiteIds) => {
		for (const websiteId of websiteIds)
			await repo.release(doc.merchantId, { websiteId, kind: String(doc.kind), connectorId: String(doc._id) });
	};

	/**
	 * Open, re-validate and check a connector; store the report and status (dropped when the credentials changed
	 * meanwhile). Returns the report and whether the status changed.
	 * @param {Document} doc
	 * @param {{ silent?: boolean }} [options] silent = do not notify (the caller notifies)
	 * @returns {Promise<{ report: CheckReport, doc: Document, changed: boolean }>}
	 */
	const check = async (doc, { silent = false } = {}) => {
		const startedAt = ctx.now();
		/** @type {CheckReport} */
		let report;
		try {
			const credentials = open(doc);
			const validated = validateCredentials({ kind: doc.kind, provider: doc.provider, credentials }, policy);
			report = validated.ok
				? await probes.run(String(doc.kind), String(doc.provider), credentials)
				: buildReport({
						steps: [{ name: 'credentials', ok: false, code: 'invalid_credentials' }],
						startedAt,
						now: ctx.now(),
					});
		} catch (error) {
			log.error('connector check failed', { connectorId: String(doc._id), error: { code: /** @type {any} */ (error)?.code } });
			report = buildReport({ steps: [{ name: 'credentials', ok: false, code: 'check_failed' }], startedAt, now: ctx.now() });
		}
		const status = statusFromReport(report);
		const updated = await repo.update(
			doc.merchantId,
			String(doc._id),
			doc.version,
			{ status, lastCheckAt: new Date(ctx.now()), lastCheckReport: report },
			{ bump: false },
		);
		if (!updated) return { report, doc: (await repo.get(doc.merchantId, String(doc._id))) ?? doc, changed: false };
		const changed = updated.status !== doc.status;
		if (changed && !silent) await notify(changesFor(updated, updated.websiteIds ?? []));
		return { report, doc: updated, changed };
	};

	/**
	 * @param {unknown} input
	 * @returns {{ merchantId: string, connectorId: string } | null}
	 */
	const refOf = (input) => {
		if (typeof input === 'object' && input !== null) {
			const { merchantId, connectorId } = /** @type {any} */ (input);
			return typeof merchantId === 'string' && typeof connectorId === 'string' ? { merchantId, connectorId } : null;
		}
		return null;
	};

	/**
	 * Create a connector, assign it to websites and run its first check.
	 * @param {{ merchantId: string, kind: unknown, provider: unknown, label?: unknown, credentials: unknown, websiteIds?: unknown } & Caller} input
	 */
	const create = async ({ merchantId, kind, provider, label, credentials, websiteIds, ...caller }) => {
		const checked = validateCredentials({ kind, provider, credentials }, policy);
		if (!checked.ok) throw invalid('The connector is invalid.', checked.errors);
		const websites = validateWebsiteIds(websiteIds);
		if (!websites.ok) throw invalid('The connector is invalid.', websites.errors);
		const name = validateLabel(label ?? `${checked.kind} (${checked.provider})`);
		if (!name.ok) throw invalid('The connector is invalid.', name.errors);
		await checkWebsites(merchantId, websites.value);
		const connectorId = createId('con', { randomBytes: ctx.randomBytes });
		const doc = {
			_id: connectorId,
			merchantId,
			kind: checked.kind,
			provider: checked.provider,
			label: name.value,
			websiteIds: [],
			status: 'failing',
			lastCheckAt: null,
			lastCheckReport: null,
			sealed: seal(merchantId, connectorId, checked.credentials),
			preview: previewOf(checked.kind, checked.provider, checked.credentials),
			version: 1,
			updatedAt: null,
			createdBy: caller.actor.id,
		};
		await repo.insert(merchantId, doc);
		try {
			await claimAll(doc, websites.value);
		} catch (error) {
			await repo.remove(merchantId, connectorId);
			throw error;
		}
		const assigned = /** @type {Document} */ (
			await repo.update(merchantId, connectorId, 1, { websiteIds: websites.value }, { bump: false })
		);
		await audit(caller, 'connectors.created', assigned, { after: summary(assigned) });
		const result = await check(assigned, { silent: true });
		await notify(changesFor(result.doc, result.doc.websiteIds ?? []));
		return { connector: present(result.doc), report: result.report };
	};

	/**
	 * Run a connection check now. Accepts `{ merchantId, connectorId }` (console) or a bare connector id (internal).
	 * @param {string | ({ merchantId: string, connectorId: string } & Partial<Caller>)} input
	 */
	const test = async (input) => {
		const ref = refOf(input);
		const doc =
			ref !== null
				? await load(ref.merchantId, ref.connectorId)
				: typeof input === 'string' && isId(input, 'con')
					? await repo.findAcross(input)
					: null;
		if (!doc) throw problem('not_found', 'No such connector.');
		const result = await check(doc);
		const caller = /** @type {Partial<Caller>} */ (typeof input === 'object' ? input : {});
		if (caller.actor)
			await audit(/** @type {Caller} */ (caller), 'connectors.tested', result.doc, {
				after: { status: result.doc.status, ok: result.report.ok },
			});
		return { connector: present(result.doc), report: result.report };
	};

	/**
	 * Delete a connector: release its websites and drop the record with its sealed credentials.
	 * @param {{ merchantId: string, connectorId: string } & Caller} input
	 */
	const remove = async ({ merchantId, connectorId, ...caller }) => {
		const doc = await load(merchantId, connectorId);
		await repo.releaseAll(merchantId, String(doc._id));
		await repo.remove(merchantId, String(doc._id));
		await audit(caller, 'connectors.deleted', doc, { before: summary(doc) });
		await notify(changesFor(doc, doc.websiteIds ?? [], 'missing'));
	};

	/**
	 * Replace the websites a connector serves (one connector per website and kind).
	 * @param {{ merchantId: string, connectorId: string, websiteIds: unknown } & Caller} input
	 */
	const assign = async ({ merchantId, connectorId, websiteIds, ...caller }) => {
		const doc = await load(merchantId, connectorId);
		const websites = validateWebsiteIds(websiteIds);
		if (!websites.ok) throw invalid('The websites are invalid.', websites.errors);
		await checkWebsites(merchantId, websites.value);
		const before = new Set(doc.websiteIds ?? []);
		const after = new Set(websites.value);
		const added = websites.value.filter((id) => !before.has(id));
		const removed = [...before].filter((id) => !after.has(id));
		await claimAll(doc, added);
		const updated = await repo.update(merchantId, connectorId, doc.version, { websiteIds: websites.value });
		if (!updated) {
			await releaseAll(doc, added);
			throw problem('conflict', 'The connector changed meanwhile; retry.');
		}
		await releaseAll(doc, removed);
		await audit(caller, 'connectors.assigned', updated, {
			before: { websiteIds: [...before] },
			after: { websiteIds: websites.value },
		});
		await notify([...changesFor(updated, added), ...changesFor(updated, removed, 'missing')]);
		return { connector: present(updated) };
	};

	/**
	 * Edit a connector: rename it and/or replace its credentials (same kind and provider; re-sealed and re-checked).
	 * @param {{ merchantId: string, connectorId: string, label?: unknown, credentials?: unknown } & Caller} input
	 */
	const update = async ({ merchantId, connectorId, label, credentials, ...caller }) => {
		const doc = await load(merchantId, connectorId);
		if (label === undefined && credentials === undefined)
			throw invalid('Nothing to change.', [{ path: '', message: 'send a label and/or credentials' }]);
		/** @type {Document} */
		const set = { updatedAt: new Date(ctx.now()) };
		if (label !== undefined) {
			const name = validateLabel(label);
			if (!name.ok) throw invalid('The connector is invalid.', name.errors);
			set.label = name.value;
		}
		if (credentials !== undefined) {
			const checked = validateCredentials({ kind: doc.kind, provider: doc.provider, credentials }, policy);
			if (!checked.ok) throw invalid('The credentials are invalid.', checked.errors);
			set.sealed = seal(merchantId, String(doc._id), checked.credentials);
			set.preview = previewOf(checked.kind, checked.provider, checked.credentials);
		}
		const updated = await repo.update(merchantId, String(doc._id), doc.version, set);
		if (!updated) throw problem('conflict', 'The connector changed meanwhile; retry.');
		await audit(caller, 'connectors.updated', updated, {
			before: { label: doc.label },
			after: { label: updated.label, ...(credentials === undefined ? {} : { accessReplaced: true }) },
		});
		if (credentials === undefined) return { connector: present(updated) };
		const result = await check(updated);
		return { connector: present(result.doc), report: result.report };
	};

	/**
	 * @param {{ merchantId: string, connectorId: string }} input
	 */
	const get = async ({ merchantId, connectorId }) => present(await load(merchantId, connectorId));

	/**
	 * @param {{ merchantId: string, kind?: string, status?: string, websiteId?: string, after?: unknown, limit: number }} input
	 */
	const list = async ({ merchantId, kind, status, websiteId, after, limit }) =>
		(
			await repo.list(merchantId, {
				...(kind ? { kind } : {}),
				...(status ? { status } : {}),
				...(websiteId ? { websiteId } : {}),
				after: keyOf(after),
				limit,
			})
		).map(present);

	/**
	 * Staff listing (status only, never previews or secrets).
	 * @param {{ merchantId?: string, kind?: string, status?: string, after?: unknown, limit: number }} input
	 */
	const adminList = async ({ merchantId, kind, status, after, limit }) =>
		(
			await repo.listAcross({
				...(merchantId ? { merchantId } : {}),
				...(kind ? { kind } : {}),
				...(status ? { status } : {}),
				after: keyOf(after),
				limit,
			})
		).map(presentStatus);

	/** @param {string} connectorId */
	const adminGet = async (connectorId) => {
		const doc = isId(connectorId, 'con') ? await repo.findAcross(connectorId) : null;
		if (!doc) throw problem('not_found', 'No such connector.');
		return presentStatus(doc);
	};

	/**
	 * Resource status of a website (what exists; commerce computes `missing` for required kinds without one).
	 * @param {string} websiteId
	 * @returns {Promise<Array<{ kind: string, ref: string, status: string }>>}
	 */
	const statusFor = async (websiteId) => {
		if (!isId(websiteId, 'web')) return [];
		const website = await Promise.resolve(ctx.service('identity').getWebsite(websiteId)).catch(() => null);
		if (!website?.merchantId) return [];
		return statusOf(String(website.merchantId), websiteId);
	};

	/**
	 * @param {string} merchantId
	 * @param {string} websiteId
	 */
	const statusOf = async (merchantId, websiteId) => {
		const docs = await repo.forWebsite(merchantId, websiteId);
		/** @type {Map<string, Document>} */
		const byKind = new Map();
		for (const doc of docs) if (!byKind.has(doc.kind)) byKind.set(doc.kind, doc);
		return [...byKind.values()]
			.map((doc) => ({ kind: String(doc.kind), ref: String(doc._id), status: String(doc.status) }))
			.sort((a, b) => KINDS.indexOf(/** @type {any} */ (a.kind)) - KINDS.indexOf(/** @type {any} */ (b.kind)));
	};

	/**
	 * Resource status of one of the merchant's websites (console); another merchant's website is not found.
	 * @param {{ merchantId: string, websiteId: string }} input
	 */
	const websiteResources = async ({ merchantId, websiteId }) => {
		const website = isId(websiteId, 'web')
			? await Promise.resolve(ctx.service('identity').getWebsite(websiteId)).catch(() => null)
			: null;
		if (!website || website.merchantId !== merchantId) throw problem('not_found', 'No such website.');
		const commerce = ctx.moduleNames().includes('commerce') ? ctx.service('commerce') : null;
		/** @type {unknown[] | null} */
		let needs = null;
		if (typeof commerce?.resourceNeeds === 'function')
			needs = await Promise.resolve(commerce.resourceNeeds(websiteId)).catch(() => null);
		return {
			websiteId,
			resources: await statusOf(merchantId, websiteId),
			// F.16: per product and kind — `neededNow` (product-level, or a requiring element is on) vs needed if enabled
			...(Array.isArray(needs) ? { needs } : {}),
		};
	};

	/**
	 * Hand a product the short-lived descriptor of a website's resource (F.9). Audited every time, granted or not.
	 * @param {{ appId: string, websiteId: unknown, kind: unknown, requestId?: string | null, ip?: string | null }} input
	 * @returns {Promise<{ kind: string, descriptor: Record<string, unknown>, expiresAt: string }>}
	 */
	const resolve = async ({ appId, websiteId, kind, requestId = null, ip = null }) => {
		/** @type {import('../../infra/http.js').FieldError[]} */
		const errors = [];
		if (typeof websiteId !== 'string' || !isId(websiteId, 'web'))
			errors.push({ path: '/websiteId', message: 'must be a website id' });
		if (typeof kind !== 'string' || !KINDS.includes(/** @type {any} */ (kind)))
			errors.push({ path: '/kind', message: `must be one of: ${KINDS.join(', ')}` });
		if (errors.length > 0) throw invalid('The request is invalid.', errors);
		const w = /** @type {string} */ (websiteId);
		const k = /** @type {string} */ (kind);
		const actor = { type: /** @type {const} */ ('product'), id: appId };
		/**
		 * @param {string} reason
		 * @param {string | null} merchantId
		 * @param {import('../../infra/http.js').ProblemResult} refusal
		 */
		const deny = async (reason, merchantId, refusal) => {
			await ctx.audit.record({
				actor,
				action: 'connectors.resolve_denied',
				target: { type: 'website', id: w, merchantId, websiteId: w },
				after: { appId, websiteId: w, kind: k },
				requestId,
				ip,
				reason,
			});
			return refusal;
		};
		const forbidden = problem('forbidden', 'This product may not resolve that resource for this website.');
		const website = await Promise.resolve(ctx.service('identity').getWebsite(w)).catch(() => null);
		if (!website?.merchantId) throw await deny('unknown_website', null, forbidden);
		const merchantId = String(website.merchantId);
		const commerce = ctx.service('commerce');
		const [subscriptions, manifest, needs] = await Promise.all([
			Promise.resolve(commerce.subscriptionsForWebsite(w)).catch(() => []),
			Promise.resolve(ctx.service('catalog').getManifest(appId)).catch(() => null),
			typeof commerce.resourceNeeds === 'function'
				? Promise.resolve(commerce.resourceNeeds(w)).catch(() => null)
				: Promise.resolve(null),
		]);
		const decision = decideResolve({ appId, websiteId: w, kind: k, subscriptions, manifest, needs });
		if (!decision.ok) throw await deny(decision.reason, merchantId, forbidden);
		const doc = await repo.assigned(merchantId, w, k);
		if (!doc || !doc.sealed || !(doc.websiteIds ?? []).includes(w))
			throw await deny(
				'resource_missing',
				merchantId,
				problem('resource_missing', `No ${k} connector is connected for this website.`),
			);
		/** @type {Record<string, any>} */
		let credentials;
		try {
			credentials = open(doc);
		} catch {
			log.error('connector credentials could not be opened', { connectorId: String(doc._id) });
			throw await deny('unsealable', merchantId, problem('unavailable', 'The resource is temporarily unavailable.'));
		}
		const descriptor = descriptorOf(String(doc.kind), String(doc.provider), credentials);
		const expiresAt = new Date(ctx.now() + DESCRIPTOR_TTL_MS).toISOString();
		// a resolve is a natural moment to re-check a connector whose last check is old (after the response; no timer)
		const lastCheck = doc.lastCheckAt ? new Date(doc.lastCheckAt).getTime() : 0;
		if (ctx.now() - lastCheck >= HEALTH_INTERVAL_MS)
			afterResponse(async () => {
				const result = await check(doc);
				if (result.changed)
					await audit({ actor: SYSTEM }, 'connectors.status_changed', result.doc, {
						before: { status: doc.status },
						after: { status: result.doc.status },
					});
			});
		await ctx.audit.record({
			actor,
			action: 'connectors.resolved',
			target: { type: 'connector', id: String(doc._id), merchantId, websiteId: w },
			after: { appId, websiteId: w, connectorId: String(doc._id), kind: k, subscriptionId: decision.subscriptionId },
			requestId,
			ip,
		});
		return { kind: k, descriptor, expiresAt };
	};

	return {
		create,
		test,
		remove,
		assign,
		update,
		get,
		list,
		adminList,
		adminGet,
		statusFor,
		websiteResources,
		resolve,
	};
};

/**
 * Pagination key `[createdAtMs, connectorId]` from a decoded cursor.
 * @param {unknown} after
 * @returns {[number, string] | null}
 */
const keyOf = (after) =>
	Array.isArray(after) && after.length === 2 && typeof after[0] === 'number' && typeof after[1] === 'string'
		? [after[0], after[1]]
		: null;

/** @typedef {ReturnType<typeof createConnectorsService>} ConnectorsService */
