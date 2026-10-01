/**
 * Subscriptions, element switches, holds and signed entitlement documents.
 *
 * Every state change re-resolves the subscription (`refresh`): the resolution is signed into a document whose
 * `version` is bumped only when `contentHash` changes (then `entitlement.changed@1` is emitted with the document), and
 * the billable element set (the resolution with the subscription forced active — pauses are billed through pause
 * intervals, not through elements) is appended to the timeline when it differs from the last snapshot.
 * @module
 */
import { createId } from '@ss/contracts';
import { splitLayers } from './deps.js';
import { ceilHour, currentPriceBook, floorHour, periodBounds, resolveEntitlement, toDocument } from '@ss/entitlements';
import { signEntitlementDocument } from '@ss/protocol';
import { problem } from '../../../infra/http.js';
import { dataScopePrefix, firstHourCharge, quotaFeatures } from '../core/catalog.js';
import { documentHash, enabledElements, isFresh, nextVersion, quotaWatch, validityWindow } from '../core/documents.js';
import { overlaySwitches, resolverState, sameElements, statusOf, withHold } from '../core/subscription.js';

/** @typedef {import('../../../infra/modules.js').ModuleContext} ModuleContext */
/** @typedef {import('../repo.js').CommerceRepo} CommerceRepo */
/** @typedef {import('./deps.js').Deps} Deps */
/** @typedef {import('./ledger.js').Ledger} Ledger */
/** @typedef {import('../core/catalog.js').Product} Product */
/** @typedef {import('../core/subscription.js').Hold} Hold */
/** @typedef {Record<string, any>} Doc */
/**
 * @typedef {object} Actor
 * @property {string} type
 * @property {string} id
 * @property {string} [merchantId]
 * @property {string[]} [roles]
 * @property {{ type: 'staff', id: string }} [via]
 */
/** @typedef {{ actor: Actor, requestId?: string | null, ip?: string | null }} Caller */

export const SYSTEM_ACTOR = Object.freeze({ type: 'system', id: 'commerce' });
const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * Public view of a subscription.
 * @param {Doc} sub
 */
export const subscriptionView = (sub) => ({
	subscriptionId: sub._id,
	merchantId: sub.merchantId,
	websiteId: sub.websiteId,
	appId: sub.appId,
	productSlug: sub.productSlug,
	planCode: sub.planCode,
	manifestVersion: sub.manifestVersion,
	productVersion: sub.productVersion,
	priceBookVersion: sub.priceBookVersion,
	status: sub.status,
	holds: sub.holds,
	switches: sub.switches,
	pins: sub.pins.map((/** @type {Doc} */ p) => ({ ...p, at: new Date(p.at).toISOString() })),
	startedAt: new Date(sub.startedAt).toISOString(),
	cancelledAt: sub.cancelledAt ? new Date(sub.cancelledAt).toISOString() : null,
	settledThrough: new Date(sub.settledThrough).toISOString(),
});

/**
 * @param {{ ctx: ModuleContext, repo: CommerceRepo, deps: Deps, ledger: Ledger }} input
 */
export const createSubscriptions = ({ ctx, repo, deps, ledger }) => {
	/**
	 * @param {Caller} caller
	 * @param {string} action
	 * @param {Doc} sub
	 * @param {{ before?: unknown, after?: unknown, reason?: string | null }} [details]
	 */
	const audit = (caller, action, sub, details = {}) =>
		ctx.audit.record({
			actor: /** @type {any} */ (caller.actor.type === 'website' ? SYSTEM_ACTOR : caller.actor),
			action,
			target: { type: 'subscription', id: sub._id, merchantId: sub.merchantId, websiteId: sub.websiteId },
			...(details.before === undefined ? {} : { before: details.before }),
			...(details.after === undefined ? {} : { after: details.after }),
			requestId: caller.requestId ?? null,
			ip: caller.ip ?? null,
			reason: details.reason ?? null,
		});

	/**
	 * Load a subscription, scoped to a merchant when one is given (tenant isolation for console calls).
	 * @param {string} subscriptionId
	 * @param {string | null} [merchantId]
	 * @returns {Promise<Doc>}
	 */
	const load = async (subscriptionId, merchantId = null) => {
		const sub =
			typeof subscriptionId === 'string'
				? merchantId
					? await repo.subscriptionOf(merchantId, subscriptionId)
					: await repo.subscriptionById(subscriptionId)
				: null;
		if (!sub) throw problem('not_found', 'No such subscription.');
		return sub;
	};

	/**
	 * Period-to-date usage of each quota feature (website time zone).
	 * @param {Doc} sub @param {Product} product @param {string} timeZone @param {number} now
	 * @returns {Promise<Record<string, number>>}
	 */
	const quotaUsage = async (sub, product, timeZone, now) => {
		/** @type {Record<string, number>} */
		const usage = {};
		for (const quota of quotaFeatures(product)) {
			const period = periodBounds({ unit: quota.period, timeZone, at: now });
			const sums = await repo.countersBetween(
				sub.merchantId,
				sub._id,
				[quota.unit],
				new Date(period.start),
				new Date(period.end),
			);
			usage[quota.key] = sums[quota.unit] ?? 0;
		}
		return usage;
	};

	/**
	 * Resolve a subscription now (with `override` layers instead of `config.layersFor` for previews).
	 * @param {Doc} sub
	 * @param {Doc} website
	 * @param {number} now
	 * @param {Record<string, any> | null} [override]
	 */
	const resolve = async (sub, website, now, override = null) => {
		const { product } = await deps.manifestOf(sub.appId, sub.manifestVersion);
		const [config, resources, identity] = await Promise.all([
			override ? Promise.resolve(splitLayers(override)) : deps.layersFor(sub),
			deps.statusFor(sub.websiteId),
			deps.identityFor(sub.websiteId),
		]);
		const usage = await quotaUsage(sub, product, website.timeZone ?? 'UTC', now);
		const state = resolverState(sub);
		const input = {
			product,
			subscription: {
				id: sub._id,
				plan: sub.planCode,
				priceBookVersion: sub.priceBookVersion,
				status: state.status,
				websiteId: sub.websiteId,
				merchantId: sub.merchantId,
			},
			layers: overlaySwitches(config.layers, sub.switches),
			runtime: { resources, usage, spendCap: state.spendCap, experiments: config.experiments },
			now,
		};
		const resolved = resolveEntitlement(input);
		const billable =
			state.status === 'active' && !state.spendCap
				? resolved
				: resolveEntitlement({
						...input,
						subscription: { ...input.subscription, status: 'active' },
						runtime: { ...input.runtime, spendCap: false },
					});
		return {
			resolved,
			billing: enabledElements(billable),
			product,
			resources,
			identity,
			contentHash: documentHash(resolved.contentHash, identity),
		};
	};

	/**
	 * Configuration conflicts of a (candidate) subscription: merchant switches on elements the plan does not offer, and
	 * elements configured on whose dependencies are configured off. Resources count as connected here.
	 * @param {Product} product @param {Doc} candidate @param {Record<string, any>} layers
	 */
	const configurationConflicts = (product, candidate, layers) => {
		const resources = Object.fromEntries(
			Object.values(product.elements).flatMap((el) => el.requires.map((kind) => [kind, 'connected'])),
		);
		const resolved = resolveEntitlement({
			product,
			subscription: { id: candidate._id, plan: candidate.planCode, status: 'active' },
			layers: overlaySwitches(layers, candidate.switches),
			runtime: { resources },
			now: ctx.now(),
		});
		const notInPlan = [
			...new Set(
				resolved.report
					.filter((r) => r.target === 'element' && r.reason === 'not_in_plan' && r.attempted === true)
					.map((r) => r.key),
			),
		].sort();
		const unmet = Object.entries(resolved.elements)
			.filter(([, el]) => el.reason === 'dependency')
			.map(([key, el]) => ({ element: key, blockedBy: el.blockedBy ?? [] }));
		return { notInPlan, unmet };
	};

	/** @param {Doc} sub @param {string[]} elements @param {number} now */
	const recordTimeline = async (sub, elements, now) => {
		const last = await repo.lastTimeline(sub.merchantId, sub._id);
		if (!last || !sameElements(last.elements, elements)) await repo.appendTimeline(sub, new Date(now), elements);
	};

	/**
	 * Map a resolution onto the canonical document (validated by `toDocument`).
	 * @param {{ sub: Doc, website: Doc, resolved: ReturnType<typeof resolveEntitlement>, product: Product,
	 *   resources: { kind: string, ref?: string, status: string }[], version: number,
	 *   window: { issuedAt: string, validFrom: string, validUntil: string },
	 *   identity?: import('@ss/contracts').IdentitySection | null }} input
	 * @returns {Record<string, unknown>}
	 */
	const buildDocument = ({ sub, website, resolved, product, resources, version, window, identity = null }) => {
		const mapped = toDocument(resolved, {
			websiteId: sub.websiteId,
			merchantId: sub.merchantId,
			domain: website.domain,
			allowSubdomains: website.allowSubdomains === true,
			env: website.env,
			version,
			...window,
			resources: resources
				.filter((r) => typeof r.ref === 'string' && OPAQUE_REF.test(r.ref))
				.map((r) => ({ kind: r.kind, ref: /** @type {string} */ (r.ref), status: r.status })),
			dataScope: { prefix: dataScopePrefix(product.slug) },
			identity,
		});
		if (!mapped.ok) {
			ctx.logger.error('entitlement document invalid', { subscriptionId: sub._id, result: mapped });
			throw problem('internal_error', 'The entitlement document could not be built.');
		}
		return /** @type {Record<string, unknown>} */ (mapped.document);
	};

	/**
	 * Re-resolve, record the billable timeline, sign and cache the document. Returns null for cancelled subscriptions.
	 * @param {Doc} sub
	 * @returns {Promise<{ jws: string, version: number, document: Record<string, unknown> } | null>}
	 */
	const refresh = async (sub) => {
		if (sub.cancelledAt) {
			await repo.deleteDocument(sub.merchantId, sub._id);
			return null;
		}
		const website = await deps.getWebsite(sub.websiteId);
		const now = ctx.now();
		const { resolved, billing, product, resources, identity, contentHash } = await resolve(sub, website, now);
		await recordTimeline(sub, billing, now);
		for (let attempt = 0; attempt < 4; attempt += 1) {
			const stored = await repo.documentOf(sub.merchantId, sub._id);
			const { version, bumped } = nextVersion(
				stored ? { version: stored.version, contentHash: stored.contentHash } : null,
				contentHash,
			);
			const window = validityWindow(now);
			const document = buildDocument({ sub, website, resolved, product, resources, version, window, identity });
			const jws = await signEntitlementDocument({ signer: ctx.keys.signer, payload: /** @type {any} */ (document) });
			const written = await repo.writeDocument(sub.merchantId, sub._id, stored ? stored.version : null, {
				version,
				contentHash,
				jws,
				issuedAt: new Date(window.issuedAt),
				validUntil: new Date(window.validUntil),
				stale: false,
				websiteId: sub.websiteId,
				appId: sub.appId,
				state: resolved.state,
				quotas: quotaWatch(quotaFeatures(product), resolved),
			});
			if (!written) continue;
			if (bumped)
				await deps.emit(
					'entitlement.changed@1',
					{ subscriptionId: sub._id, websiteId: sub.websiteId, version, document: jws },
					{ appIds: [sub.appId], websiteId: sub.websiteId },
				);
			if (bumped) await deps.requestCompile(sub.websiteId);
			return { jws, version, document };
		}
		throw problem('conflict', 'The entitlement document changed concurrently; retry.');
	};

	/** @param {Doc} sub */
	const refreshQuietly = async (sub) => {
		try {
			return await refresh(sub);
		} catch (error) {
			ctx.logger.warn('entitlement refresh failed', { subscriptionId: sub._id, error });
			return null;
		}
	};

	/**
	 * @param {Doc} before
	 * @param {Doc} after
	 * @param {string} reason
	 */
	const lifecycleEvent = async (before, after, reason) => {
		/** @type {string | null} */
		let type = null;
		if (after.status === 'cancelled') type = 'subscription.cancelled@1';
		else if (before.status === 'active' && after.status !== 'active') type = 'subscription.paused@1';
		else if (before.status !== 'active' && after.status === 'active') type = 'subscription.resumed@1';
		else if (before.status === 'paused' && after.status === 'suspended') type = 'subscription.paused@1';
		if (!type) return;
		await deps.emit(
			type,
			{ subscriptionId: after._id, websiteId: after.websiteId, reason },
			{ appIds: [after.appId], websiteId: after.websiteId },
		);
	};

	/**
	 * Add or release a hold (pause reason). No-op when unchanged or cancelled.
	 * @param {Doc} initial
	 * @param {Hold} hold
	 * @param {boolean} on
	 * @param {Caller & { reason: string, resumeAt?: string | null }} caller
	 * @returns {Promise<Doc>}
	 */
	const setHold = async (initial, hold, on, caller) => {
		let sub = initial;
		for (let attempt = 0; attempt < 5; attempt += 1) {
			if (sub.cancelledAt || sub.holds.includes(hold) === on) return sub;
			const at = new Date(ctx.now());
			if (on) await repo.openPause(sub, hold, at);
			const holds = withHold(sub.holds, hold, on);
			const updated = await repo.updateSubscription(sub, {
				$set: {
					holds,
					status: statusOf({ cancelledAt: sub.cancelledAt, holds }),
					...(hold === 'spend_cap' ? { spendCapResumeAt: on ? (caller.resumeAt ?? null) : null } : {}),
				},
			});
			if (!updated) {
				sub = await load(sub._id, sub.merchantId);
				continue;
			}
			if (!on) await repo.closePauses(updated, hold, at);
			await audit(caller, on ? 'subscription.hold_added' : 'subscription.hold_released', updated, {
				before: { status: sub.status, holds: sub.holds },
				after: { status: updated.status, holds: updated.holds },
				reason: caller.reason,
			});
			await lifecycleEvent(sub, updated, on ? caller.reason : `${hold}_released`);
			await refreshQuietly(updated);
			return updated;
		}
		throw problem('conflict', 'The subscription changed concurrently; retry.');
	};

	/**
	 * Apply a hold to every live subscription of a merchant (optionally filtered).
	 * @param {string} merchantId @param {Hold} hold @param {boolean} on @param {string} reason
	 * @param {(sub: Doc) => boolean} [filter]
	 * @returns {Promise<number>} changed subscriptions
	 */
	const setHoldForMerchant = async (merchantId, hold, on, reason, filter = () => true) => {
		let changed = 0;
		for (const sub of await repo.subscriptionsOfMerchant(merchantId, { live: true })) {
			if (!filter(sub) || sub.holds.includes(hold) === on) continue;
			await setHold(sub, hold, on, { actor: SYSTEM_ACTOR, reason });
			changed += 1;
		}
		return changed;
	};

	/**
	 * Subscribe a website to an app (requires a positive balance covering one hour of the would-be charge).
	 * @param {{ websiteId: string, appId: string, planCode?: string | null, merchantId?: string | null } & Caller} input
	 */
	const subscribe = async ({ websiteId, appId, planCode = null, merchantId = null, ...caller }) => {
		const website = await deps.getWebsite(websiteId);
		if (merchantId && website.merchantId !== merchantId) throw problem('not_found', 'No such website.');
		const merchant = await deps.getMerchant(website.merchantId);
		if (merchant.status !== 'active') throw problem('forbidden', 'The merchant account is suspended.');
		const app = await deps.getApp(appId);
		if (app.status !== 'active') throw problem('conflict', 'The product is not available for new subscriptions.');
		const { manifest, product } = await deps.manifestOf(appId, app.currentVersion);
		if (planCode !== null && !product.plans[planCode])
			throw problem('validation_failed', 'Unknown plan.', { errors: [{ path: '/planCode', message: `no plan ${planCode}` }] });
		const now = ctx.now();
		const first = firstHourCharge(product, planCode, now);
		if (!first) throw problem('conflict', 'The product has no effective price book.');
		// manifest trialHours: granted once per website × app (unique entryKey) as an adjustment at the first subscribe,
		// worth trialHours × the first hour's charge; it counts towards the one-hour minimum
		const trialHours = Number.isInteger(manifest.trialHours) ? /** @type {number} */ (manifest.trialHours) : 0;
		const trialKey = `trial:${websiteId}:${appId}`;
		const trialAmount =
			trialHours > 0 && first.amount > 0 && !(await ledger.byKey(website.merchantId, trialKey))
				? trialHours * first.amount
				: 0;
		const balance = (await ledger.balance(website.merchantId)) + trialAmount;
		if (balance <= 0 || balance < first.amount)
			throw problem('credits_exhausted', `At least one hour of credits (${first.amount} millicredits) is required.`);
		const at = new Date(now);
		/** @type {Doc} */
		const sub = {
			_id: createId('sub', { randomBytes: ctx.randomBytes }),
			merchantId: website.merchantId,
			websiteId,
			appId,
			productSlug: product.slug,
			planCode,
			manifestVersion: app.currentVersion,
			productVersion: manifest.product.version,
			priceBookVersion: first.priceBook.version,
			pins: [{ version: first.priceBook.version, manifestVersion: app.currentVersion, planCode, at }],
			status: 'active',
			holds: [],
			switches: { website: {}, admin: {} },
			live: true,
			rev: 0,
			startedAt: at,
			cancelledAt: null,
			endedAt: null,
			settledThrough: new Date(floorHour(now)),
			settlementDone: false,
			spendCapResumeAt: null,
		};
		const { billing } = await resolve(sub, website, now);
		try {
			await repo.insertSubscription(sub);
		} catch (error) {
			if (repo.isDuplicateKey(error)) throw problem('conflict', 'This website already subscribes to this product.');
			throw error;
		}
		await repo.appendTimeline(sub, at, billing);
		await audit(caller, 'subscription.created', sub, { after: subscriptionView(sub) });
		if (trialAmount > 0) await grantTrial(sub, { entryKey: trialKey, amount: trialAmount, hours: trialHours }, caller);
		await deps.emit(
			'subscription.activated@1',
			{ subscriptionId: sub._id, websiteId, reason: 'subscribed' },
			{ appIds: [appId], websiteId },
		);
		await refreshQuietly(sub);
		return subscriptionView(sub);
	};

	/**
	 * Append the trial adjustment of a first subscription (idempotent through its unique `entryKey`) and audit it.
	 * @param {Doc} sub
	 * @param {{ entryKey: string, amount: number, hours: number }} trial
	 * @param {Caller} caller
	 */
	const grantTrial = async (sub, { entryKey, amount, hours }, caller) => {
		const { appended } = await ledger.append(sub.merchantId, [
			{
				type: 'adjustment',
				amount,
				entryKey,
				reference: entryKey,
				note: `trial: ${hours} h of ${sub.productSlug}`,
				subscriptionId: sub._id,
				websiteId: sub.websiteId,
				appId: sub.appId,
				actor: SYSTEM_ACTOR,
			},
		]);
		if (appended.length === 0) return;
		await ctx.audit.record({
			actor: /** @type {any} */ (SYSTEM_ACTOR),
			action: 'credits.trial_granted',
			target: { type: 'merchant', id: sub.merchantId, merchantId: sub.merchantId, websiteId: sub.websiteId },
			after: { amountMillicredits: amount, hours, entryKey, subscriptionId: sub._id },
			requestId: caller.requestId ?? null,
			ip: caller.ip ?? null,
			reason: 'trial',
		});
	};

	/**
	 * Switch an element on or off. Merchants stay within the plan (included + add-ons) and need enabled dependencies;
	 * staff switch anything (admin layer).
	 * @param {{ subscriptionId: string, elementKey: string, enabled: boolean, merchantId?: string | null } & Caller} input
	 */
	const setElement = async ({ subscriptionId, elementKey, enabled, merchantId = null, ...caller }) => {
		let sub = await load(subscriptionId, merchantId);
		if (sub.cancelledAt) throw problem('gone', 'The subscription is cancelled.');
		const { product } = await deps.manifestOf(sub.appId, sub.manifestVersion);
		if (!product.elements[elementKey]) throw problem('not_found', `No element ${elementKey} in this product.`);
		const staff = caller.actor.type === 'staff' || caller.actor.type === 'system';
		const layer = staff ? 'admin' : 'website';
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const switches = { website: { ...(sub.switches?.website ?? {}) }, admin: { ...(sub.switches?.admin ?? {}) } };
			switches[layer][elementKey] = enabled;
			if (!staff && enabled) {
				const conflicts = configurationConflicts(product, { ...sub, switches }, (await deps.layersFor(sub)).layers);
				if (conflicts.notInPlan.includes(elementKey)) throw problem('forbidden', `${elementKey} is not part of the plan.`);
				const unmet = conflicts.unmet.find((u) => u.element === elementKey);
				if (unmet)
					throw problem('conflict', `${elementKey} needs ${unmet.blockedBy.join(', ')} switched on first.`, {
						errors: unmet.blockedBy.map((dep) => ({ path: `/elements/${dep}`, message: 'dependency is off' })),
					});
			}
			const updated = await repo.updateSubscription(sub, { $set: { switches } });
			if (!updated) {
				sub = await load(subscriptionId, merchantId);
				continue;
			}
			await audit(caller, 'subscription.element_switched', updated, {
				before: { layer, elementKey, enabled: sub.switches?.[layer]?.[elementKey] ?? null },
				after: { layer, elementKey, enabled },
			});
			await refresh(updated);
			return subscriptionView(updated);
		}
		throw problem('conflict', 'The subscription changed concurrently; retry.');
	};

	/**
	 * Change plan: pins the product's current manifest and price book. For merchants the new configuration must be
	 * consistent (no switched-on element outside the plan, no configured element with a switched-off dependency); staff
	 * may change plans regardless (the resolver reports the effect).
	 * @param {{ subscriptionId: string, planCode: string | null, merchantId?: string | null } & Caller} input
	 */
	const changePlan = async ({ subscriptionId, planCode, merchantId = null, ...caller }) => {
		const sub = await load(subscriptionId, merchantId);
		if (sub.cancelledAt) throw problem('gone', 'The subscription is cancelled.');
		const app = await deps.getApp(sub.appId);
		const { manifest, product } = await deps.manifestOf(sub.appId, app.currentVersion);
		if (planCode !== null && !product.plans[planCode])
			throw problem('validation_failed', 'Unknown plan.', { errors: [{ path: '/planCode', message: `no plan ${planCode}` }] });
		const now = ctx.now();
		const book = currentPriceBook(product, now);
		if (!book) throw problem('conflict', 'The product has no effective price book.');
		const candidate = { ...sub, planCode };
		const staff = caller.actor.type === 'staff' || caller.actor.type === 'system';
		const conflicts = staff
			? { notInPlan: [], unmet: [] }
			: configurationConflicts(product, candidate, (await deps.layersFor(sub)).layers);
		if (conflicts.notInPlan.length > 0 || conflicts.unmet.length > 0)
			throw problem('conflict', 'The new plan conflicts with the current element switches.', {
				errors: [
					...conflicts.notInPlan.map((key) => ({
						path: `/elements/${key}`,
						message: 'switched on but not offered by the plan',
					})),
					...conflicts.unmet.map((u) => ({ path: `/elements/${u.element}`, message: `needs ${u.blockedBy.join(', ')}` })),
				],
			});
		const pin = { version: book.version, manifestVersion: app.currentVersion, planCode, at: new Date(now) };
		const updated = await repo.updateSubscription(sub, {
			$set: {
				planCode,
				manifestVersion: app.currentVersion,
				productVersion: manifest.product.version,
				priceBookVersion: book.version,
			},
			$push: { pins: pin },
		});
		if (!updated) throw problem('conflict', 'The subscription changed concurrently; retry.');
		await audit(caller, 'subscription.plan_changed', updated, {
			before: { planCode: sub.planCode, priceBookVersion: sub.priceBookVersion, manifestVersion: sub.manifestVersion },
			after: { planCode, priceBookVersion: book.version, manifestVersion: app.currentVersion },
		});
		await refresh(updated);
		return subscriptionView(updated);
	};

	/**
	 * @param {{ subscriptionId: string, reason?: string, merchantId?: string | null } & Caller} input
	 */
	const pause = async ({ subscriptionId, reason = 'merchant_request', merchantId = null, ...caller }) => {
		const sub = await load(subscriptionId, merchantId);
		if (sub.cancelledAt) throw problem('gone', 'The subscription is cancelled.');
		return subscriptionView(await setHold(sub, 'paused', true, { ...caller, reason }));
	};

	/**
	 * Releases a manual pause (other holds — credits, caps, suspension — stay until their cause is gone).
	 * @param {{ subscriptionId: string, reason?: string, merchantId?: string | null } & Caller} input
	 */
	const resume = async ({ subscriptionId, reason = 'merchant_request', merchantId = null, ...caller }) => {
		const sub = await load(subscriptionId, merchantId);
		if (sub.cancelledAt) throw problem('gone', 'The subscription is cancelled.');
		return subscriptionView(await setHold(sub, 'paused', false, { ...caller, reason }));
	};

	/**
	 * @param {{ subscriptionId: string, reason?: string, merchantId?: string | null } & Caller} input
	 */
	const cancel = async ({ subscriptionId, reason = 'merchant_request', merchantId = null, ...caller }) => {
		const sub = await load(subscriptionId, merchantId);
		if (sub.cancelledAt) return subscriptionView(sub);
		const now = ctx.now();
		const at = new Date(now);
		const updated = await repo.updateSubscription(sub, {
			$set: { cancelledAt: at, endedAt: at, status: 'cancelled', settleUntil: new Date(ceilHour(now)) },
			$unset: { live: '' },
		});
		if (!updated) throw problem('conflict', 'The subscription changed concurrently; retry.');
		await repo.closePauses(updated, null, at);
		await repo.deleteDocument(updated.merchantId, updated._id);
		await deps.requestCompile(updated.websiteId);
		await audit(caller, 'subscription.cancelled', updated, {
			before: { status: sub.status },
			after: { status: 'cancelled' },
			reason,
		});
		await lifecycleEvent(sub, updated, reason);
		return subscriptionView(updated);
	};

	/**
	 * Signed document of the live subscription of `appId` on `websiteId` (cached until its content changes or it nears
	 * `validUntil`).
	 * @param {{ websiteId: string, appId: string }} input
	 * @returns {Promise<string>}
	 */
	const documentFor = async ({ websiteId, appId }) => {
		const sub =
			typeof websiteId === 'string' && typeof appId === 'string' ? await repo.liveSubscription(websiteId, appId) : null;
		if (!sub) {
			const any = typeof websiteId === 'string' ? await repo.subscriptionsForWebsite(websiteId) : [];
			if (any.some((s) => s.appId === appId)) throw problem('gone', 'The subscription is cancelled.');
			throw problem('not_found', 'No subscription of this product on this website.');
		}
		const cached = await repo.documentOf(sub.merchantId, sub._id);
		if (isFresh(cached, ctx.now())) return /** @type {string} */ (cached?.jws);
		const fresh = await refresh(sub);
		return /** @type {{ jws: string }} */ (fresh).jws;
	};

	/**
	 * Dry run for configuration changes: the canonical (unsigned, not stored) document the subscription would get with
	 * `layers` (the `config.layersFor` shape) instead of its current configuration. Nothing is recorded or emitted;
	 * `version` is the version it would carry.
	 * @param {{ subscriptionId: string, layers: Record<string, any> }} input
	 * @returns {Promise<Record<string, unknown>>}
	 */
	const previewDocument = async ({ subscriptionId, layers }) => {
		const sub = await load(subscriptionId);
		if (sub.cancelledAt) throw problem('gone', 'The subscription is cancelled.');
		const website = await deps.getWebsite(sub.websiteId);
		const now = ctx.now();
		const { resolved, product, resources, identity, contentHash } = await resolve(sub, website, now, layers ?? {});
		const stored = await repo.documentOf(sub.merchantId, sub._id);
		const { version } = nextVersion(stored ? { version: stored.version, contentHash: stored.contentHash } : null, contentHash);
		return buildDocument({
			sub,
			website,
			resolved,
			product,
			resources,
			version,
			window: validityWindow(now),
			identity,
		});
	};

	/**
	 * Re-resolve now (config changes, quota exhaustion, resource changes). Unknown ids are ignored.
	 * @param {string} subscriptionId
	 * @returns {Promise<{ invalidated: boolean, version: number | null }>}
	 */
	const invalidate = async (subscriptionId) => {
		const sub = typeof subscriptionId === 'string' ? await repo.subscriptionById(subscriptionId) : null;
		if (!sub) return { invalidated: false, version: null };
		const out = await refresh(sub);
		return { invalidated: true, version: out?.version ?? null };
	};

	/**
	 * Identity hook: a suspended merchant suspends every subscription; reactivation releases the hold.
	 * @param {{ merchantId: string, status: 'active' | 'suspended' }} input
	 */
	const onMerchantStatus = async ({ merchantId, status }) => ({
		changed: await setHoldForMerchant(
			merchantId,
			'suspended',
			status === 'suspended',
			status === 'suspended' ? 'merchant_suspended' : 'merchant_active',
		),
	});

	return Object.freeze({
		load,
		refresh,
		refreshQuietly,
		setHold,
		setHoldForMerchant,
		subscribe,
		setElement,
		changePlan,
		pause,
		resume,
		cancel,
		documentFor,
		previewDocument,
		invalidate,
		onMerchantStatus,
		/** @param {string} subscriptionId @param {string | null} [merchantId] */
		getSubscription: async (subscriptionId, merchantId = null) => subscriptionView(await load(subscriptionId, merchantId)),
		/** @param {string} websiteId */
		subscriptionsForWebsite: async (websiteId) => (await repo.subscriptionsForWebsite(websiteId)).map(subscriptionView),
		/** @param {string} merchantId @param {{ websiteId?: string | null }} [filter] */
		subscriptionsOfMerchant: async (merchantId, { websiteId = null } = {}) =>
			(await repo.subscriptionsOfMerchant(merchantId, { websiteId })).map(subscriptionView),
	});
};
/** @typedef {ReturnType<typeof createSubscriptions>} Subscriptions */
