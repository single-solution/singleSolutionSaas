/**
 * The outbox (element `dispatch`): queueing alerts into messages and sending them exactly once.
 *
 * - **Queue.** A claimed subscription cycle becomes one item of a message: its own message (`key` = subscription +
 *   cycle, unique) or, with a batching window, the contact's open digest (`batchKey`, partial unique on `open`).
 *   Queueing is idempotent, so a crash between claim and queue is repaired by `recover`.
 * - **Claim before send.** `run` takes due messages one at a time with `findOneAndUpdate` (queued → sending, lease
 *   owner + expiry). Only the owner may settle it; a lease that expires (crashed instance) is taken over, and the
 *   provider call carries `Idempotency-Key: <message id>` so a takeover cannot double-deliver at a provider that honours it.
 * - **Before sending:** quiet hours (deferred to their end), suppression (cancelled), still-claimed items only,
 *   frequency caps per contact (atomic reservations, given back when the send does not happen; defer or drop).
 * - **After:** sent → subscriptions notified (or re-armed with `repeat`), one `alert_send` usage record and
 *   `alerts.sent@1` (idempotency key = message id); failures retry with backoff, then fail and re-arm or end the
 *   subscriptions.
 */
import { afterFailure, alertVars, capCounters, catalogText, deferForQuiet, plannedAt, renderMessage } from '../core/dispatch.js';
import { DAY_MS, MINUTE_MS, iso } from '../core/time.js';
import { customKeyOf, dropPercent } from '../core/types.js';

/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./service.js').Deps} Deps */

/**
 * @param {Deps} deps
 */
export const createDispatcher = (deps) => {
	const { now, stableId, tokens, strings, send, publish, recordUsage, log } = deps;

	/**
	 * The unsubscribe link of a contact (hosted confirm page, or the merchant's own page).
	 * @param {Site} site
	 * @param {{ id: string, contactKey: string }} sub
	 */
	const unsubscribeUrl = (site, sub) => {
		const token = tokens.issue('unsubscribe', {
			websiteId: site.websiteId,
			subscriptionId: sub.id,
			contactKey: sub.contactKey,
			ttlSeconds: site.settings.unsubscribe.ttlDays * 86_400,
		});
		const own = site.settings.unsubscribe.pageUrl;
		return own ? own.replace('{token}', encodeURIComponent(token)) : `${deps.baseUrl()}/u/${encodeURIComponent(token)}`;
	};

	/**
	 * The confirm link of a double opt-in.
	 * @param {Site} site
	 * @param {{ id: string, contactKey: string }} sub
	 */
	const confirmUrl = (site, sub) =>
		`${deps.baseUrl()}/c/${encodeURIComponent(
			tokens.issue('confirm', {
				websiteId: site.websiteId,
				subscriptionId: sub.id,
				contactKey: sub.contactKey,
				ttlSeconds: site.settings.capture.confirmHours * 3600,
			}),
		)}`;

	/** @param {Site} site */
	const siteName = (site) => site.settings.dispatch.siteName || site.domain;

	/**
	 * Display values of an alert of a subscription after a change.
	 * @param {Site} site
	 * @param {import('../core/subscription.js').Subscription} sub
	 * @param {{ before?: import('../core/types.js').TargetState, after?: import('../core/types.js').TargetState,
	 *   item?: { name?: string, url?: string } | null, quantity?: number | null }} change
	 */
	const varsOf = (site, sub, change) => {
		const custom = customKeyOf(sub.type);
		const typeName = custom
			? (site.settings.types.customTypes.find((type) => type.key === custom)?.name ?? custom)
			: sub.type.replace(/_/g, ' ');
		const template = site.settings.dispatch.itemUrlTemplate;
		const fallbackUrl = template
			? template
					.replace('{itemId}', encodeURIComponent(sub.target.itemId))
					.replace('{variantId}', encodeURIComponent(sub.target.variantId ?? ''))
			: '';
		const price = change.after?.price ?? null;
		const oldPrice = sub.priceAtSubscribe ?? change.before?.price ?? null;
		return alertVars(
			{
				type: sub.type,
				typeName,
				itemName: change.item?.name ?? sub.item?.name ?? catalogText('page.item.fallback', {}, sourcesFor(site, sub.lang)),
				url: change.item?.url ?? sub.item?.url ?? fallbackUrl,
				price,
				oldPrice: sub.type === 'price_drop' ? oldPrice : null,
				dropPercent: dropPercent(oldPrice, price),
				quantity: change.quantity ?? change.after?.quantity ?? null,
			},
			sourcesFor(site, sub.lang),
		);
	};

	/**
	 * @param {Site} site
	 * @param {string} lang
	 */
	const sourcesFor = (site, lang) => ({ catalogs: strings, lang, defaultLang: site.settings.capture.defaultLang });

	/**
	 * Queue the alert of a claimed subscription cycle.
	 * @param {Site} site
	 * @param {import('../core/subscription.js').Subscription} sub claimed (its `cycle` is the claimed cycle)
	 * @param {Parameters<typeof varsOf>[2]} change
	 * @returns {Promise<boolean>} true when this call queued it
	 */
	const queueAlert = async (site, sub, change) => {
		if (!sub.address) return false;
		const at = now();
		const d = site.settings.dispatch;
		const item = {
			subscriptionId: sub.id,
			cycle: sub.cycle,
			type: sub.type,
			itemId: sub.target.itemId,
			...(sub.target.variantId ? { variantId: sub.target.variantId } : {}),
			...(sub.customerId ? { customerId: sub.customerId } : {}),
			vars: varsOf(site, sub, change),
		};
		const base = {
			kind: 'alert',
			channel: sub.channel,
			to: sub.address,
			contactKey: sub.contactKey,
			lang: sub.lang,
			status: 'queued',
			notBefore: plannedAt(at, d),
			attempts: 0,
			queuedAt: iso(at),
			expiresAt: new Date(at + d.retentionDays * DAY_MS),
		};
		if (d.batchWindowMinutes > 0) {
			const batchKey = `${sub.contactKey}|${sub.channel}|${sub.lang}`;
			return site.repos.messages.addToBatch(batchKey, item, { ...base, id: deps.newId('alm') });
		}
		const key = `alert:${sub.id}:${sub.cycle}`;
		return site.repos.messages.queue({ ...base, key, id: stableId('alm', `${site.websiteId}|${key}`), items: [item] });
	};

	/**
	 * Queue the double opt-in confirmation of a subscription.
	 * @param {Site} site
	 * @param {import('../core/subscription.js').Subscription} sub
	 */
	const queueConfirm = async (site, sub) => {
		if (!sub.address) return false;
		const at = now();
		const key = `confirm:${sub.id}`;
		return site.repos.messages.queue({
			key,
			id: stableId('alm', `${site.websiteId}|${key}`),
			kind: 'confirm',
			channel: sub.channel,
			to: sub.address,
			contactKey: sub.contactKey,
			lang: sub.lang,
			status: 'queued',
			notBefore: at,
			attempts: 0,
			queuedAt: iso(at),
			expiresAt: new Date(at + site.settings.dispatch.retentionDays * DAY_MS),
			items: [
				{
					subscriptionId: sub.id,
					cycle: sub.cycle,
					type: sub.type,
					itemId: sub.target.itemId,
					vars: { ...varsOf(site, sub, {}), confirm_url: confirmUrl(site, sub) },
				},
			],
		});
	};

	/**
	 * Give back cap reservations.
	 * @param {Site} site
	 * @param {string[]} keys
	 */
	const giveBack = async (site, keys) => {
		for (const key of keys) await site.repos.counters.give(key);
	};

	/**
	 * Reserve one message on every frequency cap of a contact.
	 * @param {Site} site
	 * @param {string} contactKey
	 * @returns {Promise<{ ok: true, keys: string[] } | { ok: false, resetsAt: number }>}
	 */
	const reserveCaps = async (site, contactKey) => {
		/** @type {string[]} */
		const taken = [];
		for (const counter of capCounters(contactKey, now(), site.settings.dispatch)) {
			if (await site.repos.counters.take(counter.key, counter.limit, new Date(counter.resetsAt + DAY_MS)))
				taken.push(counter.key);
			else {
				await giveBack(site, taken);
				return { ok: false, resetsAt: counter.resetsAt };
			}
		}
		return { ok: true, keys: taken };
	};

	/**
	 * Subscriptions of the message items that still wait for this message.
	 * @param {Site} site
	 * @param {Record<string, any>} message
	 */
	const liveItems = async (site, message) => {
		const out = [];
		for (const item of message.items ?? []) {
			const sub = await site.repos.subscriptions.get(item.subscriptionId);
			const waiting =
				message.kind === 'confirm' ? sub?.status === 'unconfirmed' : sub?.status === 'claimed' && sub.cycle === item.cycle;
			if (sub && waiting) out.push({ item, sub });
		}
		return out;
	};

	/**
	 * Close the subscription cycles of a message.
	 * @param {Site} site
	 * @param {Array<{ item: any, sub: any }>} live
	 * @param {'notified' | 'release' | 'fail'} outcome
	 */
	const closeItems = async (site, live, outcome) => {
		const repos = site.repos;
		const t = site.settings.types;
		for (const { item } of live) {
			if (item.cycle === undefined || item.cycle === 0) continue; // confirmations close nothing
			if (outcome === 'notified')
				await repos.subscriptions.markNotified(item.subscriptionId, item.cycle, {
					repeat: t.repeat,
					expiresAt: new Date(now() + t.retentionDays * DAY_MS),
				});
			else
				await repos.subscriptions.release(item.subscriptionId, item.cycle, {
					fail: outcome === 'fail',
					expiresAt: new Date(now() + t.retentionDays * DAY_MS),
				});
		}
	};

	/**
	 * Process one claimed message.
	 * @param {Site} site
	 * @param {Record<string, any>} message
	 * @param {string} owner
	 * @returns {Promise<'sent' | 'deferred' | 'cancelled' | 'capped' | 'retry' | 'failed' | 'lost'>}
	 */
	const processMessage = async (site, message, owner) => {
		const repos = site.repos;
		const d = site.settings.dispatch;
		const at = now();
		const settle = (/** @type {Record<string, unknown>} */ set, /** @type {{ refundAttempt?: boolean }} */ options = {}) =>
			repos.messages.settle(message.id, owner, set, options);
		const quietUntil = deferForQuiet(at, d);
		if (quietUntil > at) {
			await settle({ status: 'queued', notBefore: quietUntil }, { refundAttempt: true });
			return 'deferred';
		}
		if (!message.to || (message.kind === 'alert' && (await repos.suppressions.has(message.contactKey)))) {
			await settle({ status: 'cancelled', error: 'suppressed' });
			return 'cancelled';
		}
		const live = await liveItems(site, message);
		if (live.length === 0) {
			await settle({ status: 'cancelled', error: 'no_live_alerts' });
			return 'cancelled';
		}
		/** @type {string[]} */
		let capKeys = [];
		if (message.kind === 'alert') {
			const caps = await reserveCaps(site, message.contactKey);
			if (!caps.ok) {
				if (d.capAction === 'drop') {
					await settle({ status: 'capped', error: 'frequency_cap' });
					await closeItems(site, live, 'release');
					return 'capped';
				}
				await settle(
					{ status: 'queued', notBefore: deferForQuiet(caps.resetsAt, d), error: 'frequency_cap' },
					{ refundAttempt: true },
				);
				return 'deferred';
			}
			capKeys = caps.keys;
		}
		const first = live[0]?.sub;
		const unsubscribe = first ? unsubscribeUrl(site, first) : '';
		const sources = sourcesFor(site, message.lang);
		const common = {
			site: siteName(site),
			unsubscribe_url: unsubscribe,
			unsubscribe_line: catalogText('template.line.unsubscribe', { unsubscribe_url: unsubscribe }, sources),
		};
		const rendered = renderMessage(
			{ kind: message.kind, items: live.map(({ item }) => item), channel: message.channel, lang: message.lang, common },
			{ overrides: d.templates, catalogs: strings, defaultLang: site.settings.capture.defaultLang },
		);
		if (!rendered) {
			await giveBack(site, capKeys);
			await settle({ status: 'failed', error: 'template_missing' });
			await closeItems(site, live, d.releaseOnFailure ? 'release' : 'fail');
			return 'failed';
		}
		const result = await send(
			site.websiteId,
			{
				id: message.id,
				channel: message.channel,
				to: message.to,
				lang: message.lang,
				subject: rendered.subject,
				text: rendered.text,
				...(message.channel === 'email' && message.kind === 'alert' && unsubscribe
					? { headers: { 'List-Unsubscribe': `<${unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } }
					: {}),
				metadata: {
					websiteId: site.websiteId,
					product: 'alerts',
					kind: message.kind,
					types: [...new Set(live.map(({ item }) => item.type))],
					subscriptionIds: live.map(({ item }) => item.subscriptionId),
				},
			},
			{ path: d.sendPath },
		);
		if (result.ok) {
			const settled = await settle({
				status: 'sent',
				sentAt: iso(now()),
				providerMessageId: result.providerMessageId,
				error: null,
			});
			if (!settled) log('warn', 'message lease lost after send', { websiteId: site.websiteId, messageId: message.id });
			if (message.kind === 'alert') await closeItems(site, live, 'notified');
			await recordUsage({
				websiteId: site.websiteId,
				unit: 'alert_send',
				quantity: 1,
				idempotencyKey: `alert_send:${site.websiteId}:${message.id}`,
			});
			await publish({
				websiteId: site.websiteId,
				type: 'alerts.sent@1',
				idempotencyKey: `alerts.sent:${message.id}`,
				data: {
					messageId: message.id,
					channel: message.channel,
					kind: message.kind,
					alerts: live.map(({ item }) => ({
						subscriptionId: item.subscriptionId,
						type: item.type,
						itemId: item.itemId,
						...(item.variantId ? { variantId: item.variantId } : {}),
						...(item.customerId ? { customerId: item.customerId } : {}),
					})),
					...(result.providerMessageId ? { providerMessageId: result.providerMessageId } : {}),
				},
			});
			return 'sent';
		}
		await giveBack(site, capKeys);
		const next = afterFailure({ attempts: message.attempts ?? 1, failure: result, now: now() }, d);
		if (next.action === 'retry') {
			await settle({ status: 'queued', notBefore: next.at, error: result.code, lastStatus: result.status ?? null });
			return 'retry';
		}
		await settle({ status: 'failed', error: result.code, lastStatus: result.status ?? null });
		if (message.kind === 'alert') await closeItems(site, live, d.releaseOnFailure ? 'release' : 'fail');
		return 'failed';
	};

	/**
	 * Send the website's due messages (claim before send).
	 * @param {Site} site
	 * @param {{ limit?: number, owner?: string }} [options]
	 */
	const run = async (site, { limit = 50, owner = deps.instanceId } = {}) => {
		/** @type {Record<string, number>} */
		const counts = { sent: 0, deferred: 0, cancelled: 0, capped: 0, retry: 0, failed: 0 };
		if (!site.settings.enabled('dispatch')) return { ...counts, skipped: 'dispatch_disabled' };
		const repos = site.repos;
		for (let index = 0; index < limit; index += 1) {
			const message = await repos.messages.claimDue({ owner, leaseMs: site.settings.dispatch.leaseMs });
			if (!message) break;
			try {
				const outcome = await processMessage(site, message, owner);
				counts[outcome] = (counts[outcome] ?? 0) + 1;
			} catch (error) {
				// leave it leased: it is taken over when the lease expires
				log('error', 'message processing failed', { websiteId: site.websiteId, messageId: message.id, error });
				counts.failed = (counts.failed ?? 0) + 1;
				break;
			}
		}
		return counts;
	};

	/**
	 * Repair subscription cycles claimed long ago: a crash between claim and queue (re-queue), or between send and
	 * close (mark notified / release from the message's final status).
	 * @param {Site} site
	 * @param {{ limit?: number }} [options]
	 */
	const recover = async (site, { limit = 100 } = {}) => {
		const repos = site.repos;
		const stale = await repos.subscriptions.staleClaims(
			iso(now() - Math.max(site.settings.dispatch.leaseMs * 2, 10 * MINUTE_MS)),
			limit,
		);
		let requeued = 0;
		let closed = 0;
		for (const sub of stale) {
			const message = await repos.messages.ofItem(sub.id, sub.cycle);
			if (!message) {
				if (await queueAlert(site, sub, {})) requeued += 1;
				continue;
			}
			const live = [{ item: { subscriptionId: sub.id, cycle: sub.cycle }, sub }];
			if (message.status === 'sent') await closeItems(site, live, 'notified');
			else if (['failed', 'cancelled', 'capped'].includes(message.status))
				await closeItems(
					site,
					live,
					message.status === 'failed' && !site.settings.dispatch.releaseOnFailure ? 'fail' : 'release',
				);
			else continue;
			closed += 1;
		}
		return { requeued, closed };
	};

	return Object.freeze({ queueAlert, queueConfirm, run, recover, unsubscribeUrl, confirmUrl, varsOf });
};

/** @typedef {ReturnType<typeof createDispatcher>} Dispatcher */
