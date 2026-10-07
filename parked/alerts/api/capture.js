/**
 * Capture (element `capture`) and unsubscribe (element `unsubscribe`): sign-ups from the "Notify me" widget (Mode A/B,
 * `pk_` + optional customer identity), the merchant's server (`sk_`) or an import, double opt-in confirmation, and
 * unsubscribe through signed links.
 *
 * Sign-up order: validation → address (verified identity first, typed entry when allowed, E.164 phones) → keyed contact
 * hash → suppression (an explicit new consent lifts it when allowed) → abuse limits (per IP per hour, per contact per
 * day; atomic counters in the merchant database, IPs only as keyed hashes) → re-subscribe updates the active one →
 * capacity limits → "already available" refusal → waitlist rank (tier claim of the verified login token) → insert
 * (a concurrent double submit lands on the same subscription) → confirmation message (double opt-in) →
 * `alerts.subscribed@1`.
 */
import { contactIdOf, resolveAddress } from '../core/contact.js';
import { claimOf, rankOf } from '../core/priority.js';
import { newSubscription, sanitizeItem, mergeItem } from '../core/subscription.js';
import { DAY_MS, HOUR_MS, dayKey, iso } from '../core/time.js';
import { stateOf } from '../core/triggers.js';
import { enabledTypes, isMoney, targetKeyOf } from '../core/types.js';
import { validateSubscribe } from '../core/validate.js';
import { subscriptionView } from '../core/views.js';

/** @typedef {import('./service.js').Site} Site */
/** @typedef {{ ok: true, status: number, body: any } | { ok: false, code: string, detail?: string, errors?: Array<{ path: string, code: string }> }} Outcome */

/**
 * @param {import('./service.js').Deps & { dispatcher: import('./dispatcher.js').Dispatcher }} deps
 */
export const createCapture = (deps) => {
	const { now, newId, tokens, publish, dispatcher, hashText } = deps;

	/**
	 * Position of a pending subscription in its waitlist (1-based), or null.
	 * @param {Site} site
	 * @param {import('../core/subscription.js').Subscription} sub
	 */
	const positionOf = async (site, sub) =>
		site.settings.waitlist.showPosition && sub.status === 'pending' ? (await site.repos.subscriptions.ahead(sub)) + 1 : null;

	/**
	 * @param {Site} site
	 * @param {import('../core/subscription.js').Subscription} sub
	 * @param {{ reveal?: boolean }} [options]
	 */
	const view = async (site, sub, { reveal = false } = {}) => {
		const position = await positionOf(site, sub);
		return subscriptionView(sub, { reveal, ...(position === null ? {} : { position }) });
	};

	/**
	 * Sign up.
	 * @param {Site} site
	 * @param {{ body: any, keyKind: 'pk' | 'sk', identity: { subject: string, email?: string, phone?: string } | null,
	 *   claims: Record<string, unknown> | null, ip: string | null, source?: 'widget' | 'api' | 'import' }} input
	 * @returns {Promise<Outcome>}
	 */
	const subscribe = async (site, { body, keyKind, identity, claims, ip, source }) => {
		const c = site.settings.capture;
		const serverKey = keyKind === 'sk';
		const types = enabledTypes(site.settings.types);
		const problems = validateSubscribe(body, {
			types,
			channels: c.channels,
			requireConsent: c.requireConsent,
			allowTarget: site.settings.types.allowTarget,
			serverKey,
		});
		if (problems.length > 0) return { ok: false, code: 'validation_failed', errors: problems };
		const resolved = resolveAddress(
			{ channel: body.channel, email: body.email, phone: body.phone },
			serverKey ? null : identity,
			serverKey ? { allowEntry: true, preferIdentity: false } : { allowEntry: c.allowEntry, preferIdentity: c.preferIdentity },
		);
		if (!resolved.ok)
			return {
				ok: false,
				code: resolved.code,
				errors: [{ path: body.channel === 'email' ? '/email' : '/phone', code: resolved.code }],
			};
		const contactKey = tokens.contactKey(site.websiteId, contactIdOf(resolved.address));
		const repos = site.repos;
		if (await repos.suppressions.has(contactKey)) {
			if (!serverKey && body.consent === true && site.settings.unsubscribe.liftOnResubscribe)
				await repos.suppressions.remove(contactKey);
			else return { ok: false, code: 'contact_suppressed', detail: 'This contact unsubscribed from alerts.' };
		}
		const at = now();
		if (!serverKey) {
			const hourEnd = Math.floor(at / HOUR_MS) * HOUR_MS + HOUR_MS;
			if (
				ip &&
				!(await repos.counters.take(
					`ip:${tokens.subjectKey(site.websiteId, ip)}:${hourEnd}`,
					c.maxPerIpPerHour,
					new Date(hourEnd + HOUR_MS),
				))
			)
				return { ok: false, code: 'rate_limited', detail: 'Too many sign-ups from this network; try again later.' };
			const who = identity?.subject ? `cus:${hashText(identity.subject)}` : contactKey;
			if (
				!(await repos.counters.take(
					`signup:${who}:${dayKey(at, site.settings.dispatch.timeZone)}`,
					c.maxPerContactPerDay,
					new Date(at + 2 * DAY_MS),
				))
			)
				return { ok: false, code: 'rate_limited', detail: 'Too many sign-ups for this contact today.' };
		}
		const target =
			body.itemId === '*'
				? { itemId: '*' }
				: body.variantId
					? { itemId: body.itemId, variantId: body.variantId }
					: { itemId: body.itemId };
		const targetKey = targetKeyOf(target);
		const sitePolicy = { domain: site.domain, allowSubdomains: site.allowSubdomains, policy: c.itemUrlPolicy };
		const item = sanitizeItem(body.item, sitePolicy);
		const threshold = body.type === 'price_drop' && body.threshold ? body.threshold : null;
		const lang = typeof body.lang === 'string' ? body.lang : c.defaultLang;
		const existing = await repos.subscriptions.findActive({ contactKey, type: body.type, targetKey });
		if (existing) {
			const refreshed = await repos.subscriptions.refresh(existing.id, {
				threshold: threshold ?? existing.threshold ?? null,
				item: mergeItem(existing.item ?? null, item),
				lang,
			});
			return {
				ok: true,
				status: 200,
				body: { ...(await view(site, refreshed ?? existing, { reveal: serverKey })), created: false },
			};
		}
		if ((await repos.subscriptions.countActive()) >= c.maxActive)
			return { ok: false, code: 'limit_reached', detail: 'This website has reached its number of active alerts.' };
		if ((await repos.subscriptions.countActiveForContact(contactKey)) >= c.maxActivePerContact)
			return { ok: false, code: 'limit_reached', detail: 'This contact has the maximum number of active alerts.' };
		const stored = target.itemId === '*' ? null : await repos.items.get(targetKey);
		const known = stored
			? stateOf(
					{ locations: stored.locations ?? {}, price: stored.price ?? null, priceAt: stored.priceAt ?? 0 },
					{
						threshold: site.settings.triggers.threshold,
						locations: site.settings.triggers.locations,
					},
				)
			: {};
		if (c.refuseWhenAvailable && (body.type === 'back_in_stock' || body.type === 'availability') && known.available === true)
			return { ok: false, code: 'in_stock', detail: 'The item is available now.' };
		const priceAtSubscribe = body.type === 'price_drop' ? (known.price ?? (isMoney(body.price) ? body.price : null)) : null;
		if (threshold?.targetAmount && priceAtSubscribe && threshold.targetAmount >= priceAtSubscribe.amount)
			return {
				ok: false,
				code: 'validation_failed',
				errors: [{ path: '/threshold/targetAmount', code: 'not_below_current_price' }],
			};
		const tier = serverKey
			? typeof body.tier === 'string'
				? body.tier
				: null
			: claimOf(claims, site.settings.waitlist.tierClaim);
		const customerId = serverKey ? (typeof body.customerId === 'string' ? body.customerId : null) : (identity?.subject ?? null);
		const consentText = deps.consentText(lang);
		const confirm = !serverKey && c.doubleOptIn;
		const sub = newSubscription({
			id: newId('als'),
			type: body.type,
			target,
			channel: body.channel,
			address: resolved.address,
			contactKey,
			customerId,
			lang,
			tier,
			rank: rankOf(tier, site.settings.waitlist),
			threshold,
			priceAtSubscribe,
			item,
			consent: {
				given: serverKey ? body.consent === true : true,
				textVersion: body.consent === true ? hashText(consentText) : null,
			},
			source: source ?? (serverKey ? 'api' : 'widget'),
			confirm,
			now: at,
			pendingDays: site.settings.types.pendingDays,
			confirmHours: c.confirmHours,
		});
		if (!(await repos.subscriptions.insert(sub))) {
			const winner = await repos.subscriptions.findActive({ contactKey, type: body.type, targetKey });
			if (winner)
				return { ok: true, status: 200, body: { ...(await view(site, winner, { reveal: serverKey })), created: false } };
			return { ok: false, code: 'conflict', detail: 'The subscription changed concurrently; retry.' };
		}
		if (confirm) await dispatcher.queueConfirm(site, sub);
		await publish({
			websiteId: site.websiteId,
			type: 'alerts.subscribed@1',
			idempotencyKey: `alerts.subscribed:${sub.id}:${sub.status}`,
			data: {
				subscriptionId: sub.id,
				type: sub.type,
				...(sub.target.itemId === '*' ? {} : { itemId: sub.target.itemId }),
				...(sub.target.variantId ? { variantId: sub.target.variantId } : {}),
				channel: sub.channel,
				status: sub.status,
				...(sub.customerId ? { customerId: sub.customerId } : {}),
				source: sub.source,
			},
		});
		if (confirm && site.settings.dispatch.inline) await dispatcher.run(site, { limit: 5 }).catch(() => undefined);
		return { ok: true, status: 201, body: { ...(await view(site, sub, { reveal: serverKey })), created: true } };
	};

	/**
	 * Confirm a double opt-in.
	 * @param {Site} site
	 * @param {{ subscriptionId: string, contactKey: string }} claims verified confirm token
	 * @returns {Promise<Outcome>}
	 */
	const confirm = async (site, { subscriptionId, contactKey }) => {
		const sub = await site.repos.subscriptions.get(subscriptionId);
		if (!sub || sub.contactKey !== contactKey) return { ok: false, code: 'token_invalid' };
		if (sub.status !== 'unconfirmed') return { ok: true, status: 200, body: await view(site, sub) };
		const confirmed = await site.repos.subscriptions.confirm(
			sub.id,
			new Date(now() + site.settings.types.pendingDays * DAY_MS),
		);
		const current = confirmed ?? (await site.repos.subscriptions.get(sub.id));
		if (confirmed)
			await publish({
				websiteId: site.websiteId,
				type: 'alerts.subscribed@1',
				idempotencyKey: `alerts.subscribed:${sub.id}:pending`,
				data: {
					subscriptionId: sub.id,
					type: sub.type,
					...(sub.target.itemId === '*' ? {} : { itemId: sub.target.itemId }),
					...(sub.target.variantId ? { variantId: sub.target.variantId } : {}),
					channel: sub.channel,
					status: 'pending',
					...(sub.customerId ? { customerId: sub.customerId } : {}),
					source: sub.source,
				},
			});
		return { ok: true, status: 200, body: await view(site, current) };
	};

	/**
	 * What an unsubscribe link would stop (no change).
	 * @param {Site} site
	 * @param {{ subscriptionId: string, contactKey: string }} claims
	 */
	const preview = async (site, { subscriptionId, contactKey }) => {
		const sub = await site.repos.subscriptions.get(subscriptionId);
		if (!sub || sub.contactKey !== contactKey) return null;
		return {
			scope: site.settings.unsubscribe.scope,
			subscription: subscriptionView(sub),
			contact: subscriptionView(sub).contactMasked,
		};
	};

	/**
	 * Unsubscribe through a verified link: one subscription, or every alert of the contact (+ suppression and queued
	 * messages cancelled). Idempotent.
	 * @param {Site} site
	 * @param {{ subscriptionId: string, contactKey: string }} claims
	 * @returns {Promise<Outcome>}
	 */
	const unsubscribe = async (site, { subscriptionId, contactKey }) => {
		const sub = await site.repos.subscriptions.get(subscriptionId);
		if (sub && sub.contactKey !== contactKey) return { ok: false, code: 'token_invalid' };
		const expiresAt = new Date(now() + site.settings.types.retentionDays * DAY_MS);
		const scope = site.settings.unsubscribe.scope;
		const ended =
			scope === 'contact'
				? await site.repos.subscriptions.unsubscribe({ contactKey }, expiresAt)
				: await site.repos.subscriptions.unsubscribe({ id: subscriptionId }, expiresAt);
		let cancelled = 0;
		if (scope === 'contact') {
			await site.repos.suppressions.add(contactKey, 'unsubscribe_link');
			cancelled = await site.repos.messages.cancelForContact(contactKey);
		}
		await deps.audit({
			websiteId: site.websiteId,
			actor: { type: 'customer' },
			action: 'alerts.unsubscribed',
			target: { type: 'subscription', id: subscriptionId },
			after: { scope, ended, cancelled },
		});
		return { ok: true, status: 200, body: { unsubscribed: true, scope, ended, cancelledMessages: cancelled, at: iso(now()) } };
	};

	/**
	 * End one subscription of the caller (customer through the widget, or the merchant's server).
	 * @param {Site} site
	 * @param {string} id
	 * @param {{ customerId: string | null, serverKey: boolean }} caller
	 * @returns {Promise<Outcome>}
	 */
	const remove = async (site, id, { customerId, serverKey }) => {
		const sub = await site.repos.subscriptions.get(id);
		if (!sub || (!serverKey && (!customerId || sub.customerId !== customerId))) return { ok: false, code: 'not_found' };
		await site.repos.subscriptions.unsubscribe({ id }, new Date(now() + site.settings.types.retentionDays * DAY_MS));
		return {
			ok: true,
			status: 200,
			body: subscriptionView({ ...sub, ...(await site.repos.subscriptions.get(id)) }, { reveal: serverKey }),
		};
	};

	return Object.freeze({ subscribe, confirm, preview, unsubscribe, remove, view, positionOf });
};

/** @typedef {ReturnType<typeof createCapture>} Capture */
