/**
 * The after-sales application service: orchestrates `core/` decisions over the `adapters/` repositories for one website
 * at a time. Handlers (REST, events, dashboard) stay thin and call these functions; every rule lives in `core/`.
 *
 * Exactly-once: a claim's id derives from the request's Idempotency-Key, a purchase's from its order (or the key), a
 * refund's from its key (and the claim refuses a second refund with the same id or on a stale amount), a restock is
 * claimed per line before anything is published, and the usage record (`photo`) and published events carry ids
 * derived from those — so retries converge.
 */
import { buildClaim, canTransition, kindOf, refundCap, restockPlan, transitionSet } from '../core/claims.js';
import { pickTarget, refundEventData, restockEventData, statusEventData, submittedEventData } from '../core/events.js';
import {
	customerKeysOf,
	customerOf,
	lineKeyOf,
	mergeCustomer,
	orderFacts,
	purchaseTotal,
	withRefunded,
} from '../core/purchases.js';
import { serialKey, serialsOfEvent } from '../core/serials.js';
import { fill } from '../core/text.js';
import { DAY_MS, iso } from '../core/time.js';
import { purchaseEligibility } from '../core/windows.js';
import { customerClaimView, ownerClaimView } from '../core/views.js';

/** @typedef {import('../adapters/db.js').Repositories} Repositories */
/** @typedef {import('./settings.js').Settings} Settings */
/** @typedef {{ websiteId: string, settings: Settings, repos: Repositories }} Site */
/** @typedef {{ type: string, id?: string }} Actor */
/** @typedef {{ ok: false, reason: string, detail?: string, errors?: Array<{ path: string, code: string }> }} Failure */
/**
 * Who is asking: the merchant's server (`sk_` or the dashboard), a customer signed in with the website's own login
 * (`SS-Identity` subject), a guest with a claim token (bound to one purchase), or nobody.
 * @typedef {{ via: 'server' } | { via: 'identity', subject: string } | { via: 'token', purchaseId: string } | { via: 'none' }} Who
 */

/**
 * @typedef {object} ServiceDeps
 * @property {(event: { websiteId: string, type: string, data: Record<string, unknown>, idempotencyKey: string }) => Promise<any>} [publish]
 * @property {(usage: { websiteId: string, unit: string, quantity: number, idempotencyKey: string, occurredAt?: string }) => Promise<unknown> | unknown} [recordUsage]
 * @property {(entry: { websiteId: string, actor: Actor, action: string, target?: Record<string, unknown>, after?: unknown }) => Promise<unknown>} [audit]
 * @property {(websiteId: string) => Promise<any>} [storage] the merchant's storage connector
 * @property {(websiteId: string) => Promise<any>} [messaging] the merchant's messaging connector
 * @property {import('../adapters/tokens.js').ClaimTokens} tokens
 * @property {(text: string) => string} hash stable 26-char id material from a key
 * @property {{ photos: number }} retention days
 * @property {Record<string, Record<string, string>>} strings catalogs by language
 * @property {() => number} [now]
 */

/** Published event types. */
export const EVENTS = Object.freeze({
	submitted: 'aftersales.claim_submitted@1',
	statusChanged: 'aftersales.claim_status_changed@1',
	refunded: 'order.refunded@1',
	inventory: 'inventory.changed@1',
});

/** Unit metered per attached photo. */
export const METERED_UNIT = 'photo';

/** Open-kind statuses of a website. @param {Settings} settings */
const openStatuses = (settings) =>
	settings.vocabulary.statuses.filter((status) => status.kind === 'open').map((status) => status.key);

/**
 * @param {ServiceDeps} deps
 */
export const createAftersalesService = ({
	publish = async () => {},
	recordUsage = () => {},
	audit = async () => {},
	storage = async () => {
		throw new Error('no storage connector');
	},
	messaging = async () => {
		throw new Error('no messaging connector');
	},
	tokens,
	hash,
	retention,
	strings,
	now = Date.now,
}) => {
	/** @param {string} websiteId @param {string} prefix @param {string} key */
	const idFor = (websiteId, prefix, key) => `${prefix}_${hash(`${websiteId}|${prefix}|${key}`)}`;
	/** @param {string | null | undefined} lang */
	const catalog = (lang) => ({
		...(strings.en ?? {}),
		...(lang ? (strings[lang] ?? strings[lang.split('-')[0] ?? ''] ?? {}) : {}),
	});

	/**
	 * Publish best effort (the change is stored either way; the kit's outbox retries and the Portal dedupes).
	 * @param {Parameters<NonNullable<ServiceDeps['publish']>>[0]} event
	 * @returns {Promise<string | null>} the event id when accepted for delivery
	 */
	const emit = async (event) => {
		try {
			const envelope = await publish(event);
			return typeof envelope?.id === 'string' ? envelope.id : null;
		} catch {
			return null;
		}
	};

	/** @param {Site} site @param {Actor} actor @param {string} action @param {Record<string, unknown>} target @param {unknown} [after] */
	const record = async (site, actor, action, target, after) => {
		try {
			await audit({ websiteId: site.websiteId, actor, action, target, ...(after === undefined ? {} : { after }) });
		} catch {
			// audit is best effort here: the merchant database already holds the change
		}
	};

	// ── eligibility ─────────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Eligibility of a purchase now (grades of lines without a snapshot come from the Grades tiers this product saw).
	 * @param {Site} site
	 * @param {Record<string, any>} purchase
	 * @param {Array<Record<string, any>>} [claims]
	 */
	const eligibilityOf = async (site, purchase, claims) => {
		const existing = claims ?? (await site.repos.claims.forPurchase(purchase.id));
		const lines = /** @type {Array<Record<string, any>>} */ (purchase.lines ?? []);
		const tiers = new Map(
			await Promise.all(
				lines
					.filter((line) => !line.grade)
					.map(
						async (line) =>
							/** @type {[string, string | null]} */ ([
								line.lineId,
								await site.repos.grades.of(line.itemId, line.variantId ?? null),
							]),
					),
			),
		);
		const { claims: config, vocabulary } = site.settings;
		return purchaseEligibility({
			purchase,
			claims: existing,
			types: vocabulary.types,
			gradeOf: (line) => tiers.get(line.lineId) ?? null,
			defaultItemType: config.default_item_type,
			gradeWindows: config.grade_windows,
			rules: config.window_rules,
			now: now(),
			timeZone: site.settings.timeZone,
		});
	};

	/**
	 * May `who` see / claim against this purchase?
	 * @param {Record<string, any> | null} purchase
	 * @param {Who} who
	 */
	const owns = (purchase, who) => {
		if (!purchase) return false;
		if (who.via === 'server') return true;
		if (who.via === 'identity') return /** @type {string[]} */ (purchase.customerKeys ?? []).includes(who.subject);
		if (who.via === 'token') return purchase.id === who.purchaseId;
		return false;
	};

	// ── purchases ───────────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Register serials of a purchase (when the serial registry is on).
	 * @param {Site} site
	 * @param {Record<string, any>} purchase
	 * @param {Array<{ serial: string, itemId: string, variantId: string | null }>} list
	 * @param {'event' | 'api'} source
	 */
	const registerSerials = async (site, purchase, list, source) => {
		if (!site.settings.enabled('serial_registry') || list.length === 0) return 0;
		let count = 0;
		for (const entry of list) {
			const key = serialKey(entry.serial, /** @type {any} */ (site.settings.serials));
			if (key === null) continue;
			const line = /** @type {Array<Record<string, any>>} */ (purchase.lines).find(
				(candidate) => candidate.itemId === entry.itemId && (candidate.variantId ?? null) === entry.variantId,
			);
			const ref = purchase.orderId ?? purchase.id;
			await site.repos.serials.upsert({
				id: idFor(site.websiteId, 'ser', `${key}|${ref}`),
				registeredAt: iso(now()),
				key,
				ref,
				serial: entry.serial.trim().slice(0, 128),
				orderId: purchase.orderId ?? null,
				purchaseId: purchase.id,
				itemId: entry.itemId,
				variantId: entry.variantId,
				lineId: line?.lineId ?? lineKeyOf(entry.itemId, entry.variantId),
				title: line?.title ?? null,
				soldAt: purchase.placedAt ?? iso(now()),
				source,
			});
			count += 1;
		}
		return count;
	};

	/**
	 * Lines replaced by a newer snapshot keep what was refunded already.
	 * @param {Array<Record<string, any>>} next
	 * @param {Array<Record<string, any>>} previous
	 */
	const keepRefunded = (next, previous) =>
		next.map((line) => {
			const old = previous.find((entry) => entry.lineId === line.lineId);
			return old ? { ...line, refundedQuantity: old.refundedQuantity ?? 0 } : line;
		});

	/**
	 * Create or update the purchase of an order from facts (events or the API).
	 * @param {Site} site
	 * @param {import('../core/purchases.js').OrderFacts} facts
	 * @param {{ at: number, starts: boolean, cancelled?: boolean, source: 'event' | 'api', deliveredAt?: number | null,
	 *   replaceLines?: boolean }} change
	 */
	const upsertOrderPurchase = async (
		site,
		facts,
		{ at, starts, cancelled = false, source, deliveredAt, replaceLines = false },
	) => {
		const existing = await site.repos.purchases.byOrder(facts.orderId);
		const customer = mergeCustomer(existing?.customer, facts.customer);
		/** @type {Record<string, unknown>} */
		const set = {
			customer,
			customerKeys: customerKeysOf(customer),
			customerId: customer.customerId ?? customer.subject,
		};
		if (facts.number) set.number = facts.number;
		if (facts.currency) set.currency = facts.currency;
		if (facts.total !== null) set.total = facts.total;
		if (facts.lines.length > 0 && (replaceLines || !existing || existing.lines.length === 0))
			set.lines = keepRefunded(facts.lines, existing?.lines ?? []);
		else if (!existing) set.lines = [];
		if (cancelled) set.status = 'cancelled';
		else if (existing?.status !== 'cancelled') {
			const delivered = deliveredAt === undefined ? (starts ? at : null) : deliveredAt;
			if (delivered !== null && !existing?.deliveredAt) {
				set.deliveredAt = iso(delivered);
				set.status = 'delivered';
			} else if (!existing) set.status = 'placed';
		}
		return site.repos.purchases.upsertOrder(facts.orderId, {
			insert: {
				id: idFor(site.websiteId, 'pur', `order|${facts.orderId}`),
				source,
				placedAt: iso(at),
				refundedAmount: 0,
				refundEvents: [],
				reference: null,
				...(set.number ? {} : { number: null }),
				...(set.currency ? {} : { currency: null }),
				...(set.total !== undefined ? {} : { total: null }),
				...(set.deliveredAt ? {} : { deliveredAt: null }),
			},
			set,
		});
	};

	/**
	 * Apply an order lifecycle event (`order.*@1` or an Orders product `orders.*@1` event).
	 * @param {Site} site
	 * @param {{ id: string, type: string, occurredAt: string, data: unknown, context?: { product?: string } }} event
	 */
	const orderEvent = async (site, event) => {
		const facts = orderFacts(event.data);
		if (!facts) return { applied: false };
		const at = Date.parse(event.occurredAt);
		const fromSelf = event.context?.product === 'aftersales';
		if (event.type === 'order.refunded@1') {
			if (fromSelf) return { applied: false };
			const purchase = await site.repos.purchases.byOrder(facts.orderId);
			if (!purchase) return { applied: false };
			const data = /** @type {Record<string, unknown>} */ (event.data);
			const applied = await site.repos.purchases.applyRefundEvent(
				purchase.id,
				event.id,
				withRefunded(purchase.lines, data.lines),
			);
			return { applied };
		}
		const starts = /** @type {string[]} */ (site.settings.claims.window_start_events).includes(event.type);
		const cancelled = event.type === 'order.cancelled@1';
		const serials = serialsOfEvent(event.data);
		// an event without lines, serials, a window start or a cancellation only enriches a purchase that exists
		const creates = starts || cancelled || event.type === 'order.placed@1' || facts.lines.length > 0 || serials.length > 0;
		if (!creates && !(await site.repos.purchases.byOrder(facts.orderId))) return { applied: false };
		const purchase = await upsertOrderPurchase(site, facts, {
			at: Number.isNaN(at) ? now() : at,
			starts,
			cancelled,
			source: 'event',
			replaceLines: event.type === 'order.placed@1',
		});
		await registerSerials(site, purchase, serials, 'event');
		return { applied: true, purchaseId: purchase.id };
	};

	/**
	 * `POST /v1/purchases`: register a purchase from the merchant's server.
	 * @param {Site} site
	 * @param {NonNullable<ReturnType<typeof import('../core/validate.js').validatePurchase>['value']>} value
	 * @param {string} key Idempotency-Key
	 */
	const createPurchase = async (site, value, key) => {
		const at = value.placedAt ?? now();
		const deliveredAt = value.deliveredAt === null ? null : (value.deliveredAt ?? at);
		const customer = customerOf(/** @type {Record<string, unknown>} */ (value.raw));
		if (value.orderId) {
			const before = await site.repos.purchases.byOrder(value.orderId);
			const purchase = await upsertOrderPurchase(
				site,
				{
					orderId: value.orderId,
					number: value.number,
					customer,
					currency: value.currency,
					lines: value.lines,
					total: value.total,
				},
				{ at, starts: false, source: 'api', deliveredAt, replaceLines: true },
			);
			if (value.reference) await site.repos.purchases.update(purchase.id, { reference: value.reference });
			await registerSerials(site, purchase, value.serials, 'api');
			return { created: !before, purchase: await site.repos.purchases.get(purchase.id) };
		}
		const id = idFor(site.websiteId, 'pur', `api|${key}`);
		const purchase = {
			id,
			orderId: null,
			reference: value.reference,
			number: value.number,
			customer,
			customerKeys: customerKeysOf(customer),
			customerId: customer.customerId ?? customer.subject,
			currency: value.currency,
			total: value.total,
			lines: value.lines,
			status: deliveredAt === null ? 'placed' : 'delivered',
			placedAt: iso(at),
			deliveredAt: deliveredAt === null ? null : iso(deliveredAt),
			source: 'api',
			refundedAmount: 0,
			refundEvents: [],
		};
		const created = await site.repos.purchases.insert(purchase);
		const stored = await site.repos.purchases.get(id);
		if (created) await registerSerials(site, stored, value.serials, 'api');
		return { created, purchase: stored };
	};

	/**
	 * `POST /v1/claim-access`: a claim token for the guest who knows the order and its contact.
	 * @param {Site} site
	 * @param {{ number: string | null, orderId: string | null, email: string | null, phone: string | null }} value
	 * @returns {Promise<{ ok: true, token: string, expiresAt: string, purchaseId: string } | Failure>}
	 */
	const access = async (site, value) => {
		if (!site.settings.claims.guest_access) return { ok: false, reason: 'access_disabled' };
		const candidates = await site.repos.purchases.forAccess({ number: value.number, orderId: value.orderId });
		const match = candidates.find(
			(/** @type {any} */ purchase) =>
				(value.email !== null && purchase.customer?.email === value.email) ||
				(value.phone !== null && purchase.customer?.phone === value.phone),
		);
		if (!match) return { ok: false, reason: 'not_found', detail: 'No purchase matches this order and contact.' };
		const issued = tokens.issue({
			websiteId: site.websiteId,
			purchaseId: match.id,
			ttlDays: site.settings.claims.guest_token_days,
		});
		return { ok: true, ...issued, purchaseId: match.id };
	};

	// ── photos ──────────────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Presigned view links from the merchant's bucket (null when photos are off or the connector is unavailable).
	 * @param {Site} site
	 * @returns {Promise<import('../core/views.js').PhotoUrl | null>}
	 */
	const photoLinks = async (site) => {
		const config = site.settings.photos;
		if (!config) return null;
		try {
			const bucket = await storage(site.websiteId);
			return (photo) => {
				try {
					return bucket.presignGet({ key: photo.key, expiresIn: config.view_ttl_seconds }).url;
				} catch {
					return null;
				}
			};
		} catch {
			return null;
		}
	};

	/**
	 * A presigned upload slot in the merchant's bucket (`content-length` is signed: the bucket refuses any other size).
	 * @param {Site} site
	 * @param {{ contentType: string, size: number, owner: string, key: string }} input
	 * @returns {Promise<{ ok: true, photo: Record<string, unknown> } | Failure>}
	 */
	const createUpload = async (site, { contentType, size, owner, key }) => {
		const config = /** @type {Record<string, any>} */ (site.settings.photos);
		let bucket;
		try {
			bucket = await storage(site.websiteId);
		} catch {
			return { ok: false, reason: 'storage_unavailable' };
		}
		const id = idFor(site.websiteId, 'cph', key);
		const existing = await site.repos.photos.get(id);
		const declared = { contentType: existing?.contentType ?? contentType, size: existing?.size ?? size };
		const slot = bucket.presignPut({
			key: `claims/${id}`,
			contentType: declared.contentType,
			contentLength: declared.size,
			expiresIn: config.upload_ttl_seconds,
		});
		if (!existing)
			await site.repos.photos.insert({
				id,
				key: slot.key,
				objectKey: bucket.fullKey(slot.key),
				contentType,
				size,
				owner,
				customerId: owner.startsWith('customer:') ? owner.slice('customer:'.length) : null,
				status: 'pending',
				claimId: null,
				purgeAt: new Date(now() + retention.photos * DAY_MS),
			});
		return {
			ok: true,
			photo: {
				id,
				status: existing?.status ?? 'pending',
				upload: { method: slot.method, url: slot.url, headers: slot.headers },
				expiresAt: slot.expiresAt,
				maxBytes: config.max_photo_bytes,
			},
		};
	};

	/**
	 * Check photos before they are attached: pending, owned by the submitter, uploaded, of an allowed type and exactly
	 * the declared size (HEAD on the object — the signed headers already make the bucket enforce type and size; this
	 * also proves the upload happened, and covers stores that do not enforce signed headers).
	 * @param {Site} site
	 * @param {string[]} ids
	 * @param {string} owner
	 * @returns {Promise<{ ok: true, photos: Array<Record<string, unknown>> } | Failure>}
	 */
	const checkPhotos = async (site, ids, owner) => {
		if (ids.length === 0) return { ok: true, photos: [] };
		const config = site.settings.photos;
		if (!config) return { ok: false, reason: 'validation_failed', errors: [{ path: '/photoIds', code: 'photos_off' }] };
		if (ids.length > config.max_photos_per_claim)
			return { ok: false, reason: 'validation_failed', errors: [{ path: '/photoIds', code: 'too_many' }] };
		let bucket;
		try {
			bucket = await storage(site.websiteId);
		} catch {
			return { ok: false, reason: 'storage_unavailable' };
		}
		/** @type {Array<Record<string, unknown>>} */
		const out = [];
		for (const [index, id] of ids.entries()) {
			const photo = await site.repos.photos.get(id);
			const invalid = {
				ok: /** @type {const} */ (false),
				reason: 'photo_invalid',
				errors: [{ path: `/photoIds/${index}`, code: 'photo_invalid' }],
			};
			if (!photo || photo.status !== 'pending' || (owner !== 'server' && photo.owner !== owner)) return invalid;
			/** @type {{ exists: boolean, size?: number, contentType?: string }} */
			let head;
			try {
				head = await bucket.headObject({ key: photo.key });
			} catch {
				return { ok: false, reason: 'storage_unavailable' };
			}
			const type = String(head.contentType ?? '')
				.split(';')[0]
				?.trim();
			if (
				!head.exists ||
				Number(head.size) !== photo.size ||
				!config.allowed_types.includes(type ?? '') ||
				type !== photo.contentType
			)
				return invalid;
			out.push({ id, key: photo.key, contentType: photo.contentType, size: photo.size });
		}
		return { ok: true, photos: out };
	};

	// ── notifications ───────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Send one notification through the merchant's messaging connector (best effort).
	 * @param {Site} site
	 * @param {{ channel: string, to: string }} target
	 * @param {{ kind: string, idempotencyKey: string, params: Record<string, string | number>, data: Record<string, unknown> }} message
	 */
	const send = async (site, target, { kind, idempotencyKey, params, data }) => {
		const config = /** @type {Record<string, any>} */ (site.settings.messages);
		const lang = config.language || site.settings.language || 'en';
		const t = catalog(lang);
		try {
			const adapter = await messaging(site.websiteId);
			await adapter.send({
				channel: target.channel,
				to: target.to,
				locale: lang,
				idempotencyKey,
				subject: fill(t[`notify.${kind}.subject`] ?? '', params),
				text: fill(t[`notify.${kind}.message`] ?? '', params),
				data: { kind, ...data },
			});
			return true;
		} catch {
			return false;
		}
	};

	/**
	 * Tell the customer of a claim (status change or staff message).
	 * @param {Site} site
	 * @param {Record<string, any>} claim
	 * @param {'status' | 'message'} kind
	 * @param {{ idempotencyKey: string, params: Record<string, string | number> }} input
	 */
	const notifyCustomer = async (site, claim, kind, { idempotencyKey, params }) => {
		const config = site.settings.messages;
		if (!config) return false;
		if (kind === 'status' ? !config.notify_status_changes : !config.notify_customer) return false;
		const purchase = await site.repos.purchases.get(claim.purchaseId);
		const target = pickTarget(purchase?.customer, config.channels);
		if (!target) return false;
		const type = site.settings.vocabulary.types.find((entry) => entry.key === claim.type);
		return send(site, target, {
			kind,
			idempotencyKey,
			params: {
				reference: claim.reference,
				type: type?.label ?? claim.type,
				name: purchase?.customer?.name ?? '',
				number: claim.number ?? '',
				...params,
			},
			data: { claimId: claim.id, reference: claim.reference },
		});
	};

	/**
	 * Tell the merchant's staff (new claim, customer message) by e-mail.
	 * @param {Site} site
	 * @param {Record<string, any>} claim
	 * @param {'staff_claim' | 'staff_message'} kind
	 * @param {{ idempotencyKey: string, params?: Record<string, string | number> }} input
	 */
	const notifyStaff = async (site, claim, kind, { idempotencyKey, params = {} }) => {
		const config = site.settings.messages;
		if (!config || config.staff_recipients.length === 0) return 0;
		let sent = 0;
		for (const [index, to] of /** @type {string[]} */ (config.staff_recipients).entries())
			if (
				await send(
					site,
					{ channel: 'email', to },
					{
						kind,
						idempotencyKey: `${idempotencyKey}:${index}`,
						params: {
							reference: claim.reference,
							type: claim.type,
							reason: claim.reason,
							number: claim.number ?? '',
							...params,
						},
						data: { claimId: claim.id, reference: claim.reference },
					},
				)
			)
				sent += 1;
		return sent;
	};

	// ── claims ──────────────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Views of a website (photo links resolved once).
	 * @param {Site} site
	 */
	const viewsFor = async (site) => {
		const links = await photoLinks(site);
		const { vocabulary } = site.settings;
		return {
			customer: (/** @type {Record<string, any>} */ claim) => customerClaimView(claim, vocabulary, links),
			owner: (/** @type {Record<string, any>} */ claim) => ownerClaimView(claim, vocabulary, { photoUrl: links, now: now() }),
		};
	};

	/**
	 * `POST /v1/claims`.
	 * @param {Site} site
	 * @param {{ value: import('../core/claims.js').ClaimInput, who: Who, key: string }} input
	 * @returns {Promise<{ ok: true, claim: Record<string, any>, created: boolean } | Failure>}
	 */
	const submit = async (site, { value, who, key }) => {
		const id = idFor(site.websiteId, 'clm', key);
		const replay = await site.repos.claims.get(id);
		if (replay) return { ok: true, claim: replay, created: false };
		const purchase = await site.repos.purchases.get(value.purchaseId);
		if (!owns(purchase, who)) return { ok: false, reason: 'not_found', detail: 'No such purchase.' };
		const owned = /** @type {Record<string, any>} */ (purchase);
		const keys = /** @type {string[]} */ (owned.customerKeys ?? []);
		if (who.via !== 'server' && keys.length > 0) {
			const open = await site.repos.claims.countFor(/** @type {string} */ (keys[0]), openStatuses(site.settings));
			if (open >= site.settings.claims.max_open_claims_per_customer) return { ok: false, reason: 'claim_limit' };
		}
		const claims = await site.repos.claims.forPurchase(owned.id);
		const eligibility = await eligibilityOf(site, owned, claims);
		/** @type {Map<string, Set<string>>} */
		const knownSerials = new Map();
		for (const serial of await site.repos.serials.forPurchase(owned.id)) {
			const set = knownSerials.get(serial.lineId) ?? new Set();
			set.add(serial.key);
			knownSerials.set(serial.lineId, set);
		}
		const built = buildClaim({
			id,
			input: value,
			purchase: owned,
			eligibility: eligibility.lines,
			types: site.settings.vocabulary.types,
			reasons: site.settings.vocabulary.reasons,
			maxLines: site.settings.claims.max_lines_per_claim,
			serialKeyOf: (raw) => serialKey(raw, /** @type {any} */ (site.settings.serials)),
			knownSerials,
			status: site.settings.initialStatus,
			via: who.via === 'none' ? 'server' : who.via,
			customerKeys: keys,
			slaHours: site.settings.queue.sla_hours,
			now: now(),
		});
		if (!built.ok) return built;
		const owner = who.via === 'server' ? 'server' : photoOwner(owned, who);
		const photos = await checkPhotos(site, value.photoIds, owner);
		if (!photos.ok) return photos;
		/** @type {Record<string, any>} */
		const claim = { ...built.claim, photos: photos.photos, customerId: owned.customerId ?? null };
		if (!(await site.repos.claims.insert(claim))) {
			const raced = await site.repos.claims.get(id);
			return { ok: true, claim: /** @type {Record<string, any>} */ (raced), created: false };
		}
		if (photos.photos.length > 0) {
			await site.repos.photos.attach(
				photos.photos.map((photo) => String(photo.id)),
				id,
			);
			for (const photo of photos.photos)
				await recordUsage({
					websiteId: site.websiteId,
					unit: METERED_UNIT,
					quantity: 1,
					idempotencyKey: `photo:${photo.id}`,
					occurredAt: claim.submittedAt,
				});
		}
		await emit({
			websiteId: site.websiteId,
			type: EVENTS.submitted,
			data: submittedEventData(claim),
			idempotencyKey: `claim:${id}`,
		});
		await notifyStaff(site, claim, 'staff_claim', { idempotencyKey: `claim:${id}` });
		await record(site, { type: who.via === 'server' ? 'api' : 'customer' }, 'claim.submitted', { claimId: id });
		return { ok: true, claim, created: true };
	};

	/**
	 * Photo ownership key of a customer: the purchase's customer, else the purchase (guests).
	 * @param {Record<string, any>} purchase
	 * @param {Who} who
	 */
	const photoOwner = (purchase, who) => (who.via === 'identity' ? `customer:${who.subject}` : `purchase:${purchase.id}`);

	/**
	 * A claim the asker may see (null otherwise).
	 * @param {Site} site
	 * @param {string} id
	 * @param {Who} who
	 */
	const claimFor = async (site, id, who) => {
		const claim = await site.repos.claims.get(id);
		if (!claim) return null;
		if (who.via === 'server') return claim;
		if (who.via === 'identity') return /** @type {string[]} */ (claim.customerKeys ?? []).includes(who.subject) ? claim : null;
		if (who.via === 'token') return claim.purchaseId === who.purchaseId ? claim : null;
		return null;
	};

	// ── queue ───────────────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Move a claim along the merchant's transitions.
	 * @param {Site} site
	 * @param {string} id
	 * @param {{ to: string, note: string }} input
	 * @param {Actor} actor
	 * @returns {Promise<{ ok: true, claim: Record<string, any> } | Failure>}
	 */
	const transition = async (site, id, { to, note }, actor) => {
		const claim = await site.repos.claims.get(id);
		if (!claim) return { ok: false, reason: 'not_found', detail: 'No such claim.' };
		const { statuses, transitions } = site.settings.vocabulary;
		if (claim.status === to) return { ok: true, claim };
		if (!canTransition(transitions, statuses, claim.status, to))
			return { ok: false, reason: 'transition_invalid', detail: `${claim.status} → ${to} is not a transition.` };
		const at = now();
		const moved = await site.repos.claims.transition(id, claim.status, transitionSet({ claim, to, statuses, now: at }), {
			from: claim.status,
			to,
			at: iso(at),
			actor,
			...(note ? { note } : {}),
		});
		if (!moved) return { ok: false, reason: 'status_conflict' };
		const step = moved.history.length;
		await emit({
			websiteId: site.websiteId,
			type: EVENTS.statusChanged,
			data: statusEventData({ claim: moved, from: claim.status, to, statuses }),
			idempotencyKey: `claim:${id}:status:${step}`,
		});
		const status = statuses.find((entry) => entry.key === to);
		await notifyCustomer(site, moved, 'status', {
			idempotencyKey: `claim:${id}:status:${step}`,
			params: { status: status?.label ?? to, description: status?.description ?? '' },
		});
		await record(site, actor, 'claim.transition', { claimId: id }, { from: claim.status, to });
		return { ok: true, claim: moved };
	};

	/**
	 * @param {Site} site
	 * @param {string} id
	 * @param {string} body
	 * @param {Actor} actor
	 * @param {string} key
	 * @returns {Promise<{ ok: true, claim: Record<string, any> } | Failure>}
	 */
	const addNote = async (site, id, body, actor, key) => {
		const claim = await site.repos.claims.get(id);
		if (!claim) return { ok: false, reason: 'not_found', detail: 'No such claim.' };
		const noteId = idFor(site.websiteId, 'nte', key);
		if (claim.notes.some((/** @type {any} */ note) => note.id === noteId)) return { ok: true, claim };
		const updated = await site.repos.claims.addNote(
			id,
			{ id: noteId, body, at: iso(now()), actor },
			site.settings.queue.max_notes_per_claim,
		);
		if (!updated) return { ok: false, reason: 'notes_full' };
		await record(site, actor, 'claim.note', { claimId: id });
		return { ok: true, claim: updated };
	};

	/**
	 * @param {Site} site
	 * @param {string} id
	 * @param {string | null} assignee
	 * @param {Actor} actor
	 * @returns {Promise<{ ok: true, claim: Record<string, any> } | Failure>}
	 */
	const assign = async (site, id, assignee, actor) => {
		const updated = await site.repos.claims.assign(id, assignee, iso(now()));
		if (!updated) return { ok: false, reason: 'not_found', detail: 'No such claim.' };
		await record(site, actor, 'claim.assign', { claimId: id }, { assignee });
		return { ok: true, claim: updated };
	};

	// ── refunds ─────────────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Record a refund on a claim and publish it for the Orders ledger.
	 * @param {Site} site
	 * @param {{ claimId: string, amount: number, method: string, reference: string | null, note: string | null }} input
	 * @param {Actor} actor
	 * @param {string} key
	 * @returns {Promise<{ ok: true, claim: Record<string, any>, refund: Record<string, any> } | Failure>}
	 */
	const refund = async (site, input, actor, key) => {
		const config = /** @type {Record<string, any>} */ (site.settings.refunds);
		const claim = await site.repos.claims.get(input.claimId);
		if (!claim) return { ok: false, reason: 'not_found', detail: 'No such claim.' };
		const refundId = idFor(site.websiteId, 'rfd', key);
		const done = claim.refunds.find((/** @type {any} */ entry) => entry.id === refundId);
		if (done) return { ok: true, claim, refund: done };
		const type = site.settings.vocabulary.types.find((entry) => entry.key === claim.type);
		if (type?.refundable === false || !config.allowed_statuses.includes(claim.status))
			return { ok: false, reason: 'refund_not_allowed' };
		const method = /** @type {Array<Record<string, any>>} */ (config.methods).find((entry) => entry.key === input.method);
		if (!method) return { ok: false, reason: 'validation_failed', errors: [{ path: '/method', code: 'method_invalid' }] };
		if (method.reference_required && !input.reference)
			return { ok: false, reason: 'validation_failed', errors: [{ path: '/reference', code: 'required' }] };
		const purchase = await site.repos.purchases.get(claim.purchaseId);
		const currency = claim.currency ?? purchase?.currency ?? site.settings.currency;
		if (!currency) return { ok: false, reason: 'validation_failed', errors: [{ path: '/amount', code: 'currency_unknown' }] };
		const cap = refundCap({
			claim,
			purchaseTotal: purchase ? purchaseTotal(purchase) : null,
			purchaseRefunded: purchase?.refundedAmount ?? 0,
			cap: config.cap,
		});
		if (cap !== null && input.amount > cap)
			return { ok: false, reason: 'refund_exceeds', detail: `At most ${cap} can be refunded.` };
		if (!config.allow_partial && cap !== null && input.amount !== cap)
			return { ok: false, reason: 'validation_failed', errors: [{ path: '/amount', code: 'partial_not_allowed' }] };
		const at = iso(now());
		const entry = {
			id: refundId,
			amount: input.amount,
			currency,
			method: method.key,
			reference: input.reference,
			note: input.note,
			at,
			actor,
			eventId: null,
		};
		const updated = await site.repos.claims.addRefund(claim.id, entry, claim.refundedAmount);
		if (!updated) return { ok: false, reason: 'status_conflict' };
		if (purchase) await site.repos.purchases.addRefunded(purchase.id, input.amount);
		/** @type {string | null} */
		let eventId = null;
		if (config.publish_event && purchase?.orderId) {
			const typeLabel = type?.label ?? claim.type;
			eventId = await emit({
				websiteId: site.websiteId,
				type: EVENTS.refunded,
				data: refundEventData({
					claim,
					purchase,
					refund: entry,
					reason: [`${typeLabel} ${claim.reference}`, method.label, input.reference, input.note].filter(Boolean).join(' · '),
					includeLines: config.include_lines,
				}),
				idempotencyKey: `refund:${refundId}`,
			});
		}
		await site.repos.refunds.insert({
			...entry,
			eventId,
			claimId: claim.id,
			reference: input.reference,
			claimReference: claim.reference,
			orderId: claim.orderId,
			purchaseId: claim.purchaseId,
		});
		await record(site, actor, 'claim.refund', { claimId: claim.id }, { amount: input.amount, currency, method: method.key });
		let result = updated;
		const remaining = cap === null ? null : cap - input.amount;
		if (
			remaining === 0 &&
			config.status_after &&
			canTransition(
				site.settings.vocabulary.transitions,
				site.settings.vocabulary.statuses,
				updated.status,
				config.status_after,
			)
		) {
			const moved = await transition(site, claim.id, { to: config.status_after, note: '' }, actor);
			if (moved.ok) result = moved.claim;
		}
		return { ok: true, claim: result, refund: { ...entry, eventId } };
	};

	// ── restock ─────────────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Apply per-line restock decisions exactly once and publish restocked units.
	 * @param {Site} site
	 * @param {{ claimId: string, lines: Array<{ lineId: string, restock: boolean }> }} input
	 * @param {Actor} actor
	 * @returns {Promise<{ ok: true, claim: Record<string, any>, results: Array<Record<string, unknown>> } | Failure>}
	 */
	const restock = async (site, input, actor) => {
		const config = /** @type {Record<string, any>} */ (site.settings.restock);
		const claim = await site.repos.claims.get(input.claimId);
		if (!claim) return { ok: false, reason: 'not_found', detail: 'No such claim.' };
		const plan = restockPlan({
			claim,
			decisions: input.lines,
			allowedStatuses: config.allowed_statuses,
			type: site.settings.vocabulary.types.find((entry) => entry.key === claim.type),
		});
		if (!plan.ok) return plan;
		/** @type {Array<Record<string, unknown>>} */
		const results = plan.skipped.map((lineId) => ({ lineId, applied: false, reason: 'already_decided' }));
		for (const { line, restock: back } of plan.apply) {
			const at = iso(now());
			if (!(await site.repos.claims.decideRestock(claim.id, line.lineId, back, at))) {
				results.push({ lineId: line.lineId, applied: false, reason: 'already_decided' });
				continue;
			}
			const recordId = `${claim.id}:${line.lineId}`;
			let stock = back ? 'recorded' : 'not_restocked';
			await site.repos.restocks.insert({
				id: recordId,
				claimId: claim.id,
				claimReference: claim.reference,
				lineId: line.lineId,
				itemId: line.itemId,
				variantId: line.variantId,
				sku: line.sku,
				quantity: line.quantity,
				restock: back,
				at,
				actor,
				stock,
			});
			if (back && config.target === 'inventory_event') {
				const previous = await site.repos.stock.get(line.itemId, line.variantId);
				if (previous) {
					const data = restockEventData({ line, previous, reason: config.reason_code });
					const eventId = await emit({
						websiteId: site.websiteId,
						type: EVENTS.inventory,
						data,
						idempotencyKey: `restock:${recordId}`,
					});
					await site.repos.stock.set(line.itemId, line.variantId, {
						quantity: /** @type {number} */ (data.quantity),
						available: typeof data.available === 'number' ? data.available : null,
						at,
					});
					stock = eventId ? 'published' : 'publish_failed';
				} else stock = 'unknown_level';
				await site.repos.restocks.update(recordId, { stock });
			}
			results.push({ lineId: line.lineId, applied: true, restock: back, stock });
		}
		await record(site, actor, 'claim.restock', { claimId: claim.id }, { results });
		return { ok: true, claim: /** @type {Record<string, any>} */ (await site.repos.claims.get(claim.id)), results };
	};

	/**
	 * `inventory.changed@1` from the stock system: the last known on-hand level (ours are already applied).
	 * @param {Site} site
	 * @param {{ data: any, occurredAt: string, context?: { product?: string } }} event
	 */
	const inventoryEvent = async (site, event) => {
		if (event.context?.product === 'aftersales') return { applied: false };
		const { itemId, variantId = null, quantity, available = null } = event.data ?? {};
		if (typeof itemId !== 'string' || !Number.isInteger(quantity)) return { applied: false };
		await site.repos.stock.set(itemId, variantId, {
			quantity,
			available: Number.isInteger(available) ? available : null,
			at: event.occurredAt,
		});
		return { applied: true };
	};

	/**
	 * `grades.tier_assigned@1`: the tier of an item or variant (unit tiers are not tracked: units are serials here).
	 * @param {Site} site
	 * @param {{ data: any }} event
	 */
	const gradeEvent = async (site, event) => {
		const { itemId, variantId = null, unitId, tier } = event.data ?? {};
		if (typeof itemId !== 'string' || unitId !== undefined || (tier !== null && typeof tier !== 'string'))
			return { applied: false };
		await site.repos.grades.set(itemId, variantId, tier);
		return { applied: true };
	};

	// ── serial registry ─────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * `POST /v1/serials`.
	 * @param {Site} site
	 * @param {NonNullable<ReturnType<typeof import('../core/validate.js').validateSerial>['value']>} value
	 * @returns {Promise<{ ok: true, serial: Record<string, any> } | Failure>}
	 */
	const registerSerial = async (site, value) => {
		const key = serialKey(value.serial, /** @type {any} */ (site.settings.serials));
		if (key === null) return { ok: false, reason: 'validation_failed', errors: [{ path: '/serial', code: 'serial_invalid' }] };
		const purchase = value.purchaseId
			? await site.repos.purchases.get(value.purchaseId)
			: value.orderId
				? await site.repos.purchases.byOrder(value.orderId)
				: null;
		if (value.purchaseId && !purchase) return { ok: false, reason: 'not_found', detail: 'No such purchase.' };
		const line = purchase?.lines.find(
			(/** @type {any} */ entry) => entry.itemId === value.itemId && (entry.variantId ?? null) === value.variantId,
		);
		const ref = value.orderId ?? purchase?.orderId ?? purchase?.id ?? `unit|${value.itemId}`;
		const serial = await site.repos.serials.upsert({
			id: idFor(site.websiteId, 'ser', `${key}|${ref}`),
			registeredAt: iso(now()),
			key,
			ref,
			serial: value.serial.trim(),
			orderId: value.orderId ?? purchase?.orderId ?? null,
			purchaseId: purchase?.id ?? null,
			itemId: value.itemId,
			variantId: value.variantId,
			lineId: line?.lineId ?? lineKeyOf(value.itemId, value.variantId),
			title: value.title ?? line?.title ?? null,
			soldAt: value.soldAt !== null ? iso(value.soldAt) : (purchase?.placedAt ?? iso(now())),
			source: 'api',
		});
		return { ok: true, serial };
	};

	/**
	 * Look a serial up: the most recent sale of it, its purchase line's cover and (owner) its claims.
	 * @param {Site} site
	 * @param {string} raw
	 * @returns {Promise<{ ok: true, serial: Record<string, any>, entry: import('../core/windows.js').LineEligibility | null,
	 *   claims: Array<Record<string, any>> } | Failure>}
	 */
	const lookupSerial = async (site, raw) => {
		const key = serialKey(raw, /** @type {any} */ (site.settings.serials));
		if (key === null) return { ok: false, reason: 'not_found', detail: 'No such serial.' };
		const [serial] = await site.repos.serials.find(key);
		if (!serial) return { ok: false, reason: 'not_found', detail: 'No such serial.' };
		const purchase = serial.purchaseId ? await site.repos.purchases.get(serial.purchaseId) : null;
		const eligibility = purchase ? await eligibilityOf(site, purchase) : null;
		const entry = eligibility?.lines.find((candidate) => candidate.line.lineId === serial.lineId) ?? null;
		return { ok: true, serial, entry, claims: await site.repos.claims.forSerial(key) };
	};

	// ── messages ────────────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Post a message on a claim (the customer or staff) and notify the other side.
	 * @param {Site} site
	 * @param {{ claimId: string, body: string }} input
	 * @param {Who} who
	 * @param {{ actor: Actor, key: string }} meta
	 * @returns {Promise<{ ok: true, message: Record<string, any> } | Failure>}
	 */
	const postMessage = async (site, input, who, { actor, key }) => {
		const config = /** @type {Record<string, any>} */ (site.settings.messages);
		const claim = await claimFor(site, input.claimId, who);
		if (!claim) return { ok: false, reason: 'not_found', detail: 'No such claim.' };
		const staff = who.via === 'server';
		if (!staff && !config.customer_can_message) return { ok: false, reason: 'messages_closed' };
		const id = idFor(site.websiteId, 'msg', key);
		const existing = await site.repos.messages.get(id);
		if (existing) return { ok: true, message: existing };
		if ((await site.repos.messages.count(claim.id)) >= config.max_messages_per_claim)
			return { ok: false, reason: 'messages_full' };
		const message = {
			id,
			claimId: claim.id,
			customerId: claim.customerId ?? null,
			author: staff ? 'staff' : 'customer',
			actor,
			body: input.body,
			at: iso(now()),
			notified: null,
		};
		await site.repos.messages.insert(message);
		const notified = staff
			? await notifyCustomer(site, claim, 'message', { idempotencyKey: `message:${id}`, params: { body: input.body } })
			: (await notifyStaff(site, claim, 'staff_message', { idempotencyKey: `message:${id}`, params: { body: input.body } })) >
				0;
		await site.repos.messages.setNotified(id, notified);
		return { ok: true, message: { ...message, notified } };
	};

	// ── dashboard ───────────────────────────────────────────────────────────────────────────────────────────────

	/** @param {Site} site */
	const overview = async (site) => {
		const [byStatus, overdue, refunded] = await Promise.all([
			site.repos.claims.countByStatus(),
			site.repos.claims.countOverdue(iso(now())),
			site.settings.refunds ? site.repos.refunds.totals() : Promise.resolve({}),
		]);
		const { statuses } = site.settings.vocabulary;
		/** @type {Record<string, number>} */
		const byKind = { open: 0, resolved: 0, rejected: 0, closed: 0 };
		for (const [status, count] of Object.entries(byStatus)) {
			const kind = kindOf(statuses, status);
			byKind[kind] = (byKind[kind] ?? 0) + count;
		}
		return { byStatus, byKind, overdue, refunded };
	};

	return Object.freeze({
		now,
		idFor,
		owns,
		eligibilityOf,
		orderEvent,
		inventoryEvent,
		gradeEvent,
		createPurchase,
		access,
		createUpload,
		photoOwner,
		viewsFor,
		submit,
		claimFor,
		transition,
		addNote,
		assign,
		refund,
		restock,
		registerSerial,
		lookupSerial,
		postMessage,
		overview,
	});
};

/** @typedef {ReturnType<typeof createAftersalesService>} AftersalesService */
