/**
 * The coupons application service: orchestrates `core/` decisions over the `adapters/` repositories for one website at
 * a time. Handlers (REST, events, dashboard, jobs) stay thin and call these functions; every rule lives in `core/`.
 *
 * Reservation lifecycle (one reservation = one checkout, one or more codes):
 *
 *   pending ──claims──▶ reserved ──redeem / order.completed@1──▶ redeemed
 *      │                   │  └──release / order.cancelled@1 / refund──▶ released
 *      └──claim refused──▶ failed      └──TTL passed (job or lazily)──▶ expired ──late completion──▶ redeemed
 *
 * Exactly once: reservation ids derive from the request (`reference`, else the Idempotency-Key); every transition is a
 * compare-and-set on `status`; claims are taken with atomic conditional counters and recorded on the reservation, and
 * given back only by the caller that removes them from that list; redemption counters are counted once per code
 * (`counted`); usage records and published events carry deterministic idempotency keys.
 */
import { normaliseCart, cartSummary } from '../core/cart.js';
import { byteReader, drawCode, entropyBits, isValidCode, normaliseCode, parsePattern } from '../core/codes.js';
import { toCsv } from '../core/csv.js';
import { evaluateCoupon } from '../core/evaluate.js';
import { claimRefusal, claimsFor, isBlocked, parseClaimKey, velocitySubject, windowStart } from '../core/limits.js';
import { shareLink } from '../core/links.js';
import { encodeQr, qrToSvg } from '../core/qr.js';
import { reportWindow, summarise } from '../core/report.js';
import { applyStack } from '../core/stacking.js';
import { iso, MINUTE_MS, toMs } from '../core/time.js';
import { codeView, couponView, editableOf, mergePatch, quoteView, reservationView } from '../core/views.js';

/** @typedef {import('../adapters/repositories.js').Repositories} Repositories */
/** @typedef {import('./settings.js').Settings} Settings */
/** @typedef {{ websiteId: string, domain: string, settings: Settings, repos: Repositories }} Site */
/** @typedef {{ customerId?: string | null, identified?: boolean, address?: string | null }} Requester */
/** @typedef {{ ok: false, reason: string, path?: string }} Failure */
/** @typedef {ReturnType<typeof quoteView>} QuoteView */
/**
 * @typedef {object} ServiceDeps
 * @property {(event: { websiteId: string, type: string, data: Record<string, unknown>, idempotencyKey: string }) => Promise<unknown>} [publish]
 * @property {(usage: { websiteId: string, unit: string, quantity: number, idempotencyKey: string, occurredAt?: string }) => Promise<unknown> | unknown} [recordUsage]
 * @property {(entry: { websiteId: string, actor: { type: string, id?: string }, action: string, target?: Record<string, unknown>, after?: unknown }) => Promise<unknown>} [audit]
 * @property {(text: string) => string} hash stable id material
 * @property {(n: number) => Uint8Array} randomBytes cryptographically secure
 * @property {(prefix: string) => string} randomId
 * @property {() => number} [now]
 */

/** Published event types. */
export const EVENTS = Object.freeze({
	redeemed: 'coupons.redeemed@1',
	released: 'coupons.released@1',
	exhausted: 'coupons.exhausted@1',
});

/** Unit metered per confirmed code. */
export const METERED_UNIT = 'redemption';

/** Refusals that count as failed attempts for velocity limits (guessing codes). */
const FAILURES = new Set(['code_not_found', 'code_disabled', 'coupon_inactive', 'blocked']);
/** Expired reservations swept per lazy sweep / job page. */
const SWEEP_PAGE = 100;
/** Attempts at a fresh code when generated codes collide. */
const GENERATION_ROUNDS = 5;
/** Codes inserted per database round trip. */
const INSERT_CHUNK = 1000;
/** Listed coupons shown by the apply box view. */
const LISTED_LIMIT = 10;

/**
 * @param {ServiceDeps} deps
 */
export const createCouponsService = ({
	publish = async () => {},
	recordUsage = () => {},
	audit = async () => {},
	hash,
	randomBytes,
	randomId,
	now = Date.now,
}) => {
	/**
	 * Publish best effort (state is stored either way; the Portal dedupes on the idempotency key).
	 * @param {Parameters<NonNullable<ServiceDeps['publish']>>[0]} event
	 */
	const emit = async (event) => {
		try {
			await publish(event);
		} catch {
			// an unreachable Event Hub never fails a checkout
		}
	};

	/** @param {Site} site @param {unknown} raw */
	const normalise = (site, raw) => normaliseCode(raw, { caseSensitive: site.settings.codes.case_sensitive === true });

	/** @param {Site} site */
	const limitsOn = (site) => site.settings.enabled('limits');

	// ── coupons and codes ──────────────────────────────────────────────────────────────────────────────────

	/**
	 * Generate unique codes for a coupon (cryptographically random, collisions regenerated).
	 * @param {Site} site
	 * @param {{ couponId: string, pattern: string, count: number, maxUses: number | null, batchId: string | null }} input
	 * @returns {Promise<{ ok: true, codes: string[] } | { ok: false, reason: string }>}
	 */
	const generate = async (site, { couponId, pattern, count, maxUses, batchId }) => {
		const { codes } = site.settings;
		const parsed = parsePattern(pattern, { maxLength: codes.max_code_length, minRandom: codes.min_random_chars });
		if (!parsed.ok) return { ok: false, reason: parsed.error };
		if (count > 1 && 2 ** entropyBits(parsed, String(codes.alphabet).length) < count * 1000)
			return { ok: false, reason: 'pattern_too_weak' };
		const next = byteReader(randomBytes);
		/** @type {string[]} */
		const created = [];
		let missing = count;
		for (let round = 0; round < GENERATION_ROUNDS && missing > 0; round += 1) {
			/** @type {Set<string>} */
			const batch = new Set();
			while (batch.size < missing) batch.add(normalise(site, drawCode(parsed, codes.alphabet, next)));
			const fresh = [...batch];
			for (let i = 0; i < fresh.length; i += INSERT_CHUNK) {
				const chunk = fresh.slice(i, i + INSERT_CHUNK);
				const result = await site.repos.codes.insertMany(chunk.map((code) => ({ code, couponId, maxUses, batchId })));
				const duplicates = new Set(result.duplicates);
				created.push(...chunk.filter((code) => !duplicates.has(code)));
			}
			missing = count - created.length;
		}
		await site.repos.coupons.addCodes(couponId, created.length);
		return missing > 0 ? { ok: false, reason: 'code_taken' } : { ok: true, codes: created };
	};

	/**
	 * @param {Site} site
	 * @param {Record<string, any>} body validated create body
	 * @param {{ type: string, id?: string }} actor
	 * @returns {Promise<{ ok: true, coupon: Record<string, any>, codes: string[] } | { ok: false, reason: string, path?: string }>}
	 */
	const createCoupon = async (site, body, actor) => {
		const refusal = elementRefusal(site, body);
		if (refusal) return { ok: false, ...refusal };
		if ((await site.repos.coupons.countActive()) >= site.settings.codes.max_active_coupons)
			return { ok: false, reason: 'limit_reached' };
		const id = randomId('cpn');
		const unique = body.count !== undefined;
		const perCode = body.limits?.per_code ?? (unique ? 1 : null);
		const coupon = {
			id,
			name: body.name,
			description: body.description ?? '',
			status: body.status ?? 'active',
			mode: unique ? 'unique' : 'shared',
			currency: body.currency ?? null,
			action: body.action,
			eligibility: { when: body.eligibility?.when ?? '', conditions: body.eligibility?.conditions ?? [] },
			limits: {
				total: body.limits?.total ?? null,
				per_customer: body.limits?.per_customer ?? null,
				per_device: body.limits?.per_device ?? null,
				per_code: perCode,
			},
			stacking: body.stacking ?? {},
			validity: body.validity ?? {},
			listed: body.listed === true,
			custom: body.custom ?? {},
		};
		if (body.code !== undefined) {
			const code = normalise(site, body.code);
			if (
				!isValidCode(code, { minLength: site.settings.codes.min_code_length, maxLength: site.settings.codes.max_code_length })
			)
				return { ok: false, reason: 'validation_failed', path: '/code' };
			if (await site.repos.codes.get(code)) return { ok: false, reason: 'code_taken', path: '/code' };
			await site.repos.coupons.insert(coupon);
			const inserted = await site.repos.codes.insertMany([{ code, couponId: id, maxUses: perCode, batchId: null }]);
			if (inserted.duplicates.length > 0) {
				await site.repos.coupons.save(id, 1, { status: 'archived', archivedAt: iso(now()) });
				return { ok: false, reason: 'code_taken', path: '/code' };
			}
			await site.repos.coupons.addCodes(id, 1);
			await auditCreate(site, actor, id);
			return { ok: true, coupon: /** @type {Record<string, any>} */ (await site.repos.coupons.get(id)), codes: [code] };
		}
		const pattern = body.pattern ?? site.settings.codes.default_pattern;
		const parsed = parsePattern(pattern, {
			maxLength: site.settings.codes.max_code_length,
			minRandom: site.settings.codes.min_random_chars,
		});
		if (!parsed.ok)
			return {
				ok: false,
				reason: parsed.error === 'pattern_too_weak' ? 'pattern_too_weak' : 'validation_failed',
				path: '/pattern',
			};
		await site.repos.coupons.insert(coupon);
		const generated = await generate(site, {
			couponId: id,
			pattern,
			count: unique ? body.count : 1,
			maxUses: perCode,
			batchId: unique ? randomId('bat') : null,
		});
		if (!generated.ok) {
			await site.repos.coupons.save(id, 1, { status: 'archived', archivedAt: iso(now()) });
			return { ok: false, reason: generated.reason, path: '/pattern' };
		}
		await auditCreate(site, actor, id);
		return { ok: true, coupon: /** @type {Record<string, any>} */ (await site.repos.coupons.get(id)), codes: generated.codes };
	};

	/** @param {Site} site @param {{ type: string, id?: string }} actor @param {string} couponId */
	const auditCreate = (site, actor, couponId) =>
		audit({ websiteId: site.websiteId, actor, action: 'coupons.coupon_created', target: { couponId } });

	/**
	 * Settings that need an element the website has off.
	 * @param {Site} site
	 * @param {Record<string, any>} body
	 * @returns {{ reason: string, path: string } | null}
	 */
	const elementRefusal = (site, body) => {
		const { enabled } = site.settings;
		const eligibility = body.eligibility ?? {};
		if (
			!enabled('eligibility') &&
			((typeof eligibility.when === 'string' && eligibility.when.trim() !== '') ||
				(Array.isArray(eligibility.conditions) && eligibility.conditions.length > 0))
		)
			return { reason: 'element_off', path: '/eligibility' };
		const limits = body.limits ?? {};
		if (!enabled('limits') && (typeof limits.per_customer === 'number' || typeof limits.per_device === 'number'))
			return { reason: 'element_off', path: '/limits' };
		if (!enabled('stacking') && body.stacking && Object.keys(body.stacking).length > 0)
			return { reason: 'element_off', path: '/stacking' };
		return null;
	};

	/**
	 * JSON Merge Patch of a coupon's editable fields (optimistic).
	 * @param {Site} site
	 * @param {string} id
	 * @param {Record<string, any>} patch
	 * @param {(merged: Record<string, any>) => Array<{ path: string, code: string }>} validate
	 * @returns {Promise<{ ok: true, coupon: Record<string, any> } | { ok: false, reason: string, problems?: Array<{ path: string, code: string }>, path?: string }>}
	 */
	const updateCoupon = async (site, id, patch, validate) => {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const current = await site.repos.coupons.get(id);
			if (!current) return { ok: false, reason: 'not_found' };
			const merged = /** @type {Record<string, any>} */ (mergePatch(editableOf(current), patch));
			const problems = validate(merged);
			if (problems.length > 0) return { ok: false, reason: 'validation_failed', problems };
			const refusal = elementRefusal(site, merged);
			if (refusal) return { ok: false, ...refusal };
			const set = {
				name: merged.name,
				description: merged.description ?? '',
				status: merged.status ?? current.status,
				currency: merged.currency ?? null,
				action: merged.action,
				eligibility: { when: merged.eligibility?.when ?? '', conditions: merged.eligibility?.conditions ?? [] },
				limits: {
					total: merged.limits?.total ?? null,
					per_customer: merged.limits?.per_customer ?? null,
					per_device: merged.limits?.per_device ?? null,
					per_code: merged.limits?.per_code ?? current.limits?.per_code ?? null,
				},
				stacking: merged.stacking ?? {},
				validity: merged.validity ?? {},
				listed: merged.listed === true,
				custom: merged.custom ?? {},
				...(merged.status === 'archived' && current.status !== 'archived' ? { archivedAt: iso(now()) } : {}),
			};
			if (await site.repos.coupons.save(id, current.version, set))
				return { ok: true, coupon: /** @type {Record<string, any>} */ (await site.repos.coupons.get(id)) };
		}
		return { ok: false, reason: 'conflict' };
	};

	// ── evaluation ─────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Velocity: count this request, refuse when the subject went over a limit.
	 * @param {Site} site
	 * @param {string | null} subject
	 * @param {'attempt' | 'reservation'} kind
	 * @returns {Promise<boolean>} true when allowed
	 */
	const velocityAllows = async (site, subject, kind) => {
		if (!limitsOn(site) || !subject) return true;
		const limits = site.settings.limits;
		const at = now();
		const window = windowStart(at, limits.velocity_window_minutes);
		const expireAt = window + limits.velocity_window_minutes * MINUTE_MS * 2;
		const key = hash(subject);
		const failures = await site.repos.velocity.count(`failure:${key}`, window);
		if (failures >= limits.velocity_max_failures) return false;
		const count = await site.repos.velocity.hit(`${kind}:${key}`, window, expireAt);
		return count <= (kind === 'attempt' ? limits.velocity_max_attempts : limits.velocity_max_reservations);
	};

	/**
	 * Count failed codes of a request toward the subject's failure limit.
	 * @param {Site} site
	 * @param {string | null} subject
	 * @param {number} failures
	 */
	const recordFailures = async (site, subject, failures) => {
		if (!limitsOn(site) || !subject || failures === 0) return;
		const limits = site.settings.limits;
		const at = now();
		const window = windowStart(at, limits.velocity_window_minutes);
		const expireAt = window + limits.velocity_window_minutes * MINUTE_MS * 2;
		for (let i = 0; i < failures; i += 1) await site.repos.velocity.hit(`failure:${hash(subject)}`, window, expireAt);
	};

	/**
	 * Evaluate codes against a cart: resolve, check each coupon, stack the eligible ones.
	 * @param {Site} site
	 * @param {{ codes: readonly string[], cart: import('../core/cart.js').Cart }} input
	 */
	const evaluate = async (site, { codes, cart }) => {
		const at = now();
		/** @type {Array<{ index: number, code: string, reason: string }>} */
		const refused = [];
		/** @type {import('../core/evaluate.js').Candidate[]} */
		const candidates = [];
		/** @type {Map<string, Record<string, any>>} */
		const coupons = new Map();
		/** @type {Map<string, Record<string, any>>} */
		const codeDocs = new Map();
		const seen = new Set();
		const blocked =
			limitsOn(site) &&
			(await site.repos.blocks.matching(
				/** @type {Array<{ kind: string, value: string }>} */ (
					[
						cart.customer.id ? { kind: 'customer', value: cart.customer.id } : null,
						cart.customer.email ? { kind: 'email', value: cart.customer.email } : null,
						cart.context.deviceId ? { kind: 'device', value: cart.context.deviceId } : null,
						...codes.map((raw) => ({ kind: 'code', value: normalise(site, raw) })),
					].filter(Boolean)
				),
			));
		const blocks = Array.isArray(blocked) ? blocked : [];
		const subjectBlocked = isBlocked(
			blocks.filter((block) => block.kind !== 'code'),
			{ customerId: cart.customer.id, email: cart.customer.email, deviceId: cart.context.deviceId, code: null },
		);
		for (const [index, raw] of codes.entries()) {
			const code = normalise(site, raw);
			if (seen.has(code)) {
				refused.push({ index, code, reason: 'duplicate_coupon' });
				continue;
			}
			seen.add(code);
			if (subjectBlocked || isBlocked(blocks, { customerId: null, email: null, deviceId: null, code })) {
				refused.push({ index, code, reason: 'blocked' });
				continue;
			}
			let codeDoc = isValidCode(code, { minLength: 1, maxLength: 64 }) ? await site.repos.codes.get(code) : null;
			let coupon = codeDoc ? (coupons.get(codeDoc.couponId) ?? (await site.repos.coupons.get(codeDoc.couponId))) : null;
			if (!codeDoc || !coupon) {
				refused.push({ index, code, reason: 'code_not_found' });
				continue;
			}
			let verdict = evaluateCoupon({ coupon, code: codeDoc, cart, now: at, index, settings: site.settings.evaluation });
			// a full code may be held by abandoned checkouts: expire those first, then look again
			if (!verdict.ok && verdict.reason === 'exhausted' && (await sweep(site, { code })) > 0) {
				codeDoc = (await site.repos.codes.get(code)) ?? codeDoc;
				coupon = (await site.repos.coupons.get(codeDoc.couponId)) ?? coupon;
				verdict = evaluateCoupon({ coupon, code: codeDoc, cart, now: at, index, settings: site.settings.evaluation });
			}
			coupons.set(coupon.id, coupon);
			codeDocs.set(code, codeDoc);
			if (!verdict.ok) {
				refused.push({ index, code, reason: verdict.reason });
				continue;
			}
			// preview of per-customer / per-device limits (the reservation claims them atomically)
			if (limitsOn(site)) {
				const claims = claimsFor({
					coupon,
					code: codeDoc,
					customerId: cart.customer.identified ? cart.customer.id : null,
					deviceId: cart.context.deviceId,
					defaultPerCustomer: site.settings.limits.default_per_customer,
					hash,
				}).filter((claim) => claim.kind === 'customer' || claim.kind === 'device');
				/** @param {typeof claims} list */
				const limitOf = async (list) => {
					let refusal = null;
					for (const claim of list) {
						const used = await site.repos.usage.get({
							couponId: coupon.id,
							kind: claim.kind,
							key: /** @type {string} */ (parseClaimKey(claim.key).hashed),
						});
						if (claim.max !== null && (used?.taken ?? 0) >= claim.max) refusal = claimRefusal(claim.kind);
					}
					return refusal;
				};
				let limited = await limitOf(claims);
				// the customer's (or device's) own abandoned checkout may hold the use: expire it, then look again
				if (
					limited &&
					(await sweep(site, {
						customerId: cart.customer.identified ? cart.customer.id : null,
						deviceId: cart.context.deviceId,
					})) > 0
				)
					limited = await limitOf(claims);
				if (limited) {
					refused.push({ index, code, reason: limited });
					continue;
				}
			}
			candidates.push(verdict.candidate);
		}
		const stack = applyStack({ cart, candidates, policy: site.settings.policy, bounds: site.settings.bounds });
		const indexOf = new Map(candidates.map((candidate) => [candidate.code, candidate.index]));
		const rejected = [
			...refused,
			...stack.rejected.map((entry) => ({ index: indexOf.get(entry.code) ?? 0, code: entry.code, reason: entry.reason })),
		].sort((a, b) => a.index - b.index);
		return { stack: { ...stack, rejected }, coupons, codeDocs, at };
	};

	/**
	 * @param {Site} site
	 * @param {Record<string, any>} cartInput validated cart
	 * @param {Requester} requester
	 */
	const cartFor = (site, cartInput, requester) =>
		normaliseCart(cartInput, {
			...(requester.customerId !== undefined ? { customerId: requester.customerId } : {}),
			identified: requester.identified ?? true,
		});

	/** @param {import('../core/cart.js').Cart} cart @param {Requester} requester */
	const subjectOf = (cart, requester) =>
		velocitySubject({
			customerId: cart.customer.identified ? cart.customer.id : null,
			deviceId: cart.context.deviceId,
			address: requester.address ?? null,
		});

	// ── reservations ───────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Take one claim (with a lazy sweep of expired reservations holding the code when it is full).
	 * @param {Site} site
	 * @param {import('../core/limits.js').Claim} claim
	 */
	const take = async (site, claim) => {
		const attempt = () => {
			if (claim.kind === 'code') return site.repos.codes.claim(claim.code, claim.max);
			if (claim.kind === 'coupon') return site.repos.coupons.claim(claim.couponId, claim.max);
			return site.repos.usage.claim({
				couponId: claim.couponId,
				kind: claim.kind,
				key: /** @type {string} */ (parseClaimKey(claim.key).hashed),
				customerId: claim.subject ?? null,
				max: /** @type {number} */ (claim.max),
			});
		};
		if (await attempt()) return true;
		const swept = await sweep(site, { code: claim.kind === 'code' ? claim.code : undefined, couponId: claim.couponId });
		return swept > 0 ? attempt() : false;
	};

	/**
	 * Give one recorded claim back (only when this caller removed it from the reservation).
	 * @param {Site} site
	 * @param {string} reservationId
	 * @param {string} key
	 */
	const giveBack = async (site, reservationId, key) => {
		if (!(await site.repos.reservations.dropClaim(reservationId, key))) return;
		const parsed = parseClaimKey(key);
		if (parsed.kind === 'code' && parsed.code) await site.repos.codes.unclaim(parsed.code);
		else if (parsed.kind === 'coupon' && parsed.couponId) await site.repos.coupons.unclaim(parsed.couponId);
		else if (parsed.couponId && parsed.hashed)
			await site.repos.usage.unclaim({ couponId: parsed.couponId, kind: parsed.kind, key: parsed.hashed });
	};

	/**
	 * Claims of a reservation's coupons.
	 * @param {Site} site
	 * @param {Record<string, any>} reservation
	 * @param {Map<string, Record<string, any>>} coupons
	 * @param {Map<string, Record<string, any>>} codeDocs
	 */
	const claimsOf = (site, reservation, coupons, codeDocs) =>
		(reservation.coupons ?? []).flatMap((/** @type {Record<string, any>} */ entry) => {
			const coupon = coupons.get(entry.couponId);
			const code = codeDocs.get(entry.code);
			if (!coupon || !code) return [];
			return claimsFor({
				coupon,
				code,
				customerId: reservation.identified ? reservation.customerId : null,
				deviceId: reservation.deviceId ?? null,
				defaultPerCustomer: limitsOn(site) ? site.settings.limits.default_per_customer : 0,
				hash,
			}).filter((claim) => limitsOn(site) || claim.kind === 'code' || claim.kind === 'coupon');
		});

	/**
	 * Take every claim of a reservation; on the first refusal give back what was taken.
	 * @param {Site} site
	 * @param {string} id
	 * @param {import('../core/limits.js').Claim[]} claims
	 * @returns {Promise<{ ok: true } | { ok: false, reason: string, code: string }>}
	 */
	const takeAll = async (site, id, claims) => {
		for (const claim of claims) {
			if (!(await take(site, claim))) {
				const current = await site.repos.reservations.get(id);
				for (const key of current?.claims ?? []) await giveBack(site, id, key);
				return { ok: false, reason: claimRefusal(claim.kind), code: claim.code };
			}
			await site.repos.reservations.addClaim(id, claim.key);
		}
		return { ok: true };
	};

	/**
	 * Expire one open reservation (compare-and-set on its status): the claims go back, then `coupons.released@1`
	 * (reason `expired`).
	 * @param {Site} site
	 * @param {Record<string, any>} reservation
	 * @returns {Promise<boolean>} true for the caller that expired it
	 */
	const expireOne = async (site, reservation) => {
		const at = iso(now());
		if (
			!(await site.repos.reservations.transition(reservation.id, ['pending', 'reserved'], {
				status: 'expired',
				expiredAt: at,
			}))
		)
			return false;
		const fresh = (await site.repos.reservations.get(reservation.id)) ?? reservation;
		for (const key of fresh.claims ?? []) await giveBack(site, reservation.id, key);
		await releasedEvents(site, reservation, 'expired', false);
		return true;
	};

	/**
	 * Expire-on-read: an open reservation past its TTL is expired (and its uses released) when it is touched, before any
	 * sweep. Returns the current reservation.
	 * @param {Site} site
	 * @param {Record<string, any> | null} reservation
	 * @returns {Promise<Record<string, any> | null>}
	 */
	const settle = async (site, reservation) => {
		if (!reservation || !['pending', 'reserved'].includes(reservation.status)) return reservation;
		if (!(typeof reservation.expiresAt === 'string' && reservation.expiresAt < iso(now()))) return reservation;
		await expireOne(site, reservation);
		return site.repos.reservations.get(reservation.id);
	};

	/**
	 * A reservation as it is now (lapsed ones are expired first).
	 * @param {Site} site
	 * @param {string} id
	 */
	const reservationOf = async (site, id) => settle(site, await site.repos.reservations.get(id));

	/**
	 * Expire reservations past their TTL (all of a website, those holding a code, or those of a customer / device).
	 * @param {Site} site
	 * @param {{ code?: string, couponId?: string, customerId?: string | null, deviceId?: string | null, limit?: number }} [filter]
	 * @returns {Promise<number>} reservations expired by this call
	 */
	const sweep = async (site, { code, customerId, deviceId, limit = SWEEP_PAGE } = {}) => {
		const at = iso(now());
		let expired = 0;
		const holders = {
			...(code ? { code } : {}),
			...(customerId ? { customerId } : {}),
			...(deviceId ? { deviceId } : {}),
		};
		for (const reservation of await site.repos.reservations.expired(at, { ...holders, limit }))
			if (await expireOne(site, reservation)) expired += 1;
		return expired;
	};

	/**
	 * @param {Site} site
	 * @param {Record<string, any>} reservation
	 * @param {string} reason
	 * @param {boolean} wasRedeemed
	 */
	const releasedEvents = async (site, reservation, reason, wasRedeemed) => {
		for (const entry of reservation.coupons ?? [])
			await emit({
				websiteId: site.websiteId,
				type: EVENTS.released,
				idempotencyKey: `released:${reservation.id}:${entry.code}:${reason}`,
				data: {
					reservationId: reservation.id,
					couponId: entry.couponId,
					code: entry.code,
					...(reservation.orderId ? { orderId: reservation.orderId } : {}),
					reason,
					wasRedeemed,
				},
			});
	};

	/**
	 * Effects of a redemption, each exactly once per code: redemption counters (+ `coupons.exhausted@1` when the last
	 * use is consumed), the metered `redemption` usage and `coupons.redeemed@1`.
	 * @param {Site} site
	 * @param {Record<string, any>} reservation redeemed reservation
	 */
	const redeemEffects = async (site, reservation) => {
		for (const entry of reservation.coupons ?? []) {
			if (await site.repos.reservations.count(reservation.id, entry.code)) {
				const code = await site.repos.codes.redeemed(entry.code, 1);
				const coupon = await site.repos.coupons.redeemed(entry.couponId, 1);
				if (code && typeof code.maxUses === 'number' && code.redeemed >= code.maxUses)
					await emit({
						websiteId: site.websiteId,
						type: EVENTS.exhausted,
						idempotencyKey: `exhausted:code:${entry.code}`,
						data: {
							couponId: entry.couponId,
							code: entry.code,
							scope: 'code',
							limit: code.maxUses,
							redeemed: code.redeemed,
						},
					});
				const total = coupon?.limits?.total;
				if (coupon && typeof total === 'number' && (coupon.counters?.redeemed ?? 0) >= total)
					await emit({
						websiteId: site.websiteId,
						type: EVENTS.exhausted,
						idempotencyKey: `exhausted:coupon:${entry.couponId}`,
						data: { couponId: entry.couponId, scope: 'coupon', limit: total, redeemed: coupon.counters.redeemed },
					});
			}
			await recordUsage({
				websiteId: site.websiteId,
				unit: METERED_UNIT,
				quantity: 1,
				idempotencyKey: `redemption:${reservation.id}:${entry.code}`,
				occurredAt: reservation.redeemedAt ?? iso(now()),
			});
			await emit({
				websiteId: site.websiteId,
				type: EVENTS.redeemed,
				idempotencyKey: `redeemed:${reservation.id}:${entry.code}`,
				data: {
					reservationId: reservation.id,
					couponId: entry.couponId,
					code: entry.code,
					...(reservation.orderId ? { orderId: reservation.orderId } : {}),
					...(reservation.customerId ? { customerId: reservation.customerId } : {}),
					currency: reservation.cart?.currency,
					discountAmount: entry.discount,
					shippingDiscountAmount: entry.shippingDiscount,
					freeShipping: entry.freeShipping === true,
					loyaltyAllowed: reservation.loyaltyAllowed !== false,
				},
			});
		}
	};

	/**
	 * Reload the coupons and codes of a stored reservation (for re-claiming a late completion).
	 * @param {Site} site
	 * @param {Record<string, any>} reservation
	 */
	const docsOf = async (site, reservation) => {
		/** @type {Map<string, Record<string, any>>} */
		const coupons = new Map();
		/** @type {Map<string, Record<string, any>>} */
		const codeDocs = new Map();
		for (const entry of reservation.coupons ?? []) {
			const coupon = await site.repos.coupons.get(entry.couponId);
			const code = await site.repos.codes.get(entry.code);
			if (coupon) coupons.set(coupon.id, coupon);
			if (code) codeDocs.set(code.code, code);
		}
		return { coupons, codeDocs };
	};

	/**
	 * Reserve codes for a checkout (idempotent on `reference`, else on the Idempotency-Key).
	 * @param {Site} site
	 * @param {{ codes: string[], cart: Record<string, any>, orderId?: string, reference?: string, key: string }} input
	 * @param {Requester} requester
	 * @returns {Promise<{ ok: true, reservation: Record<string, any>, duplicate: boolean } | { ok: false, reason: string, rejected?: Array<{ code: string, reason: string }>, quote?: unknown }>}
	 */
	const reserve = async (site, input, requester) => {
		const id = `rsv_${hash(`${site.websiteId}|${input.reference ? `ref:${input.reference}` : `key:${input.key}`}`)}`;
		const existing = await reservationOf(site, id);
		if (existing) return { ok: true, reservation: existing, duplicate: true };
		const cart = cartFor(site, input.cart, requester);
		const subject = subjectOf(cart, requester);
		if (!(await velocityAllows(site, subject, 'reservation'))) return { ok: false, reason: 'velocity_limited' };
		const { stack, coupons, codeDocs, at } = await evaluate(site, { codes: input.codes, cart });
		if (stack.rejected.length > 0) {
			await recordFailures(site, subject, stack.rejected.filter((entry) => FAILURES.has(entry.reason)).length);
			return {
				ok: false,
				reason: /** @type {{ reason: string }} */ (stack.rejected[0]).reason,
				rejected: stack.rejected.map(({ code, reason }) => ({ code, reason })),
				quote: quoteView(stack, cart.currency),
			};
		}
		const reservation = {
			id,
			status: 'pending',
			reference: input.reference ?? null,
			orderId: input.orderId ?? null,
			customerId: cart.customer.id,
			identified: cart.customer.identified,
			email: cart.customer.email,
			deviceId: cart.context.deviceId,
			cart: cartSummary(cart),
			codes: stack.applied.map((coupon) => coupon.code),
			coupons: stack.applied.map((coupon) => ({
				couponId: coupon.couponId,
				code: coupon.code,
				discount: coupon.discount,
				shippingDiscount: coupon.shippingDiscount,
				freeShipping: coupon.freeShipping,
				gifts: coupon.gifts,
				lines: coupon.lines,
			})),
			totals: {
				subtotal: stack.subtotal,
				discount: stack.discount,
				shipping: stack.shipping,
				shippingDiscount: stack.shippingDiscount,
				total: stack.total,
			},
			loyaltyAllowed: stack.loyaltyAllowed,
			dealsAllowed: stack.dealsAllowed,
			claims: [],
			counted: [],
			refunds: [],
			expiresAt: iso(at + site.settings.api.reservation_ttl_minutes * MINUTE_MS),
			redeemedAt: null,
			releasedAt: null,
			releaseReason: null,
		};
		if (!(await site.repos.reservations.insert(reservation))) {
			const raced = await site.repos.reservations.get(id);
			if (raced) return { ok: true, reservation: raced, duplicate: true };
		}
		const taken = await takeAll(site, id, claimsOf(site, reservation, coupons, codeDocs));
		if (!taken.ok) {
			await site.repos.reservations.transition(id, ['pending'], { status: 'failed', failReason: taken.reason });
			return { ok: false, reason: taken.reason, rejected: [{ code: taken.code, reason: taken.reason }] };
		}
		if (!(await site.repos.reservations.transition(id, ['pending'], { status: 'reserved' }))) {
			// expired by a concurrent sweep while claiming (TTL shorter than the claim): give everything back
			const current = await site.repos.reservations.get(id);
			for (const key of current?.claims ?? []) await giveBack(site, id, key);
			return { ok: false, reason: 'reservation_expired' };
		}
		return {
			ok: true,
			reservation: /** @type {Record<string, any>} */ (await site.repos.reservations.get(id)),
			duplicate: false,
		};
	};

	/**
	 * Confirm a reservation (the order went through). Idempotent; a late completion of an expired reservation is
	 * re-claimed when `api.confirm_expired` allows it and the uses are still there.
	 * @param {Site} site
	 * @param {string} id
	 * @param {{ orderId?: string | null }} [options]
	 * @returns {Promise<{ ok: true, reservation: Record<string, any> } | { ok: false, reason: string }>}
	 */
	const redeem = async (site, id, { orderId = null } = {}) => {
		const current = await reservationOf(site, id);
		if (!current) return { ok: false, reason: 'not_found' };
		if (orderId && current.orderId && current.orderId !== orderId) return { ok: false, reason: 'order_mismatch' };
		const set = { status: 'redeemed', redeemedAt: iso(now()), ...(orderId && !current.orderId ? { orderId } : {}) };
		if (current.status === 'redeemed') {
			// repairs effects lost to a crash between the transition and the effects (each is idempotent)
			const counted = new Set(current.counted ?? []);
			if ((current.coupons ?? []).some((/** @type {{ code: string }} */ entry) => !counted.has(entry.code)))
				await redeemEffects(site, current);
			return { ok: true, reservation: current };
		}
		if (current.status === 'expired') {
			if (site.settings.api.confirm_expired !== true) return { ok: false, reason: 'reservation_expired' };
			if (!(await site.repos.reservations.transition(id, ['expired'], { status: 'pending' })))
				return redeem(site, id, { orderId });
			const { coupons, codeDocs } = await docsOf(site, current);
			const taken = await takeAll(site, id, claimsOf(site, current, coupons, codeDocs));
			if (!taken.ok) {
				await site.repos.reservations.transition(id, ['pending'], { status: 'expired' });
				return { ok: false, reason: 'reservation_expired' };
			}
			if (!(await site.repos.reservations.transition(id, ['pending'], set))) return { ok: false, reason: 'not_redeemable' };
		} else if (current.status === 'reserved') {
			if (!(await site.repos.reservations.transition(id, ['reserved'], set))) return redeem(site, id, { orderId });
		} else return { ok: false, reason: 'not_redeemable' };
		const redeemed = /** @type {Record<string, any>} */ (await site.repos.reservations.get(id));
		await redeemEffects(site, redeemed);
		return { ok: true, reservation: redeemed };
	};

	/**
	 * Release a reservation or undo a redemption: the uses go back (`coupons.released@1`).
	 * @param {Site} site
	 * @param {string} id
	 * @param {'released' | 'order_cancelled' | 'order_refunded'} reason
	 * @returns {Promise<{ ok: true, reservation: Record<string, any> } | { ok: false, reason: string }>}
	 */
	const release = async (site, id, reason) => {
		const current = await reservationOf(site, id);
		if (!current) return { ok: false, reason: 'not_found' };
		if (['released', 'expired', 'failed'].includes(current.status)) return { ok: true, reservation: current };
		const wasRedeemed = current.status === 'redeemed';
		const moved = await site.repos.reservations.transition(id, ['pending', 'reserved', 'redeemed'], {
			status: 'released',
			releasedAt: iso(now()),
			releaseReason: reason,
		});
		if (!moved) return release(site, id, reason);
		for (const key of current.claims ?? []) await giveBack(site, id, key);
		const after = /** @type {Record<string, any>} */ (await site.repos.reservations.get(id));
		for (const key of after.claims ?? []) await giveBack(site, id, key);
		if (wasRedeemed)
			for (const entry of after.coupons ?? []) {
				if (!(await site.repos.reservations.uncount(id, entry.code))) continue;
				await site.repos.codes.redeemed(entry.code, -1);
				await site.repos.coupons.redeemed(entry.couponId, -1);
			}
		await releasedEvents(site, after, reason, wasRedeemed);
		return { ok: true, reservation: /** @type {Record<string, any>} */ (await site.repos.reservations.get(id)) };
	};

	/**
	 * Bind an order to a reservation (made before the order existed) so `order.*` events find it.
	 * @param {Site} site
	 * @param {string} id
	 * @param {string} orderId
	 * @returns {Promise<{ ok: true, reservation: Record<string, any> } | Failure>}
	 */
	const attach = async (site, id, orderId) => {
		const current = await reservationOf(site, id);
		if (!current) return { ok: false, reason: 'not_found' };
		if (current.orderId && current.orderId !== orderId) return { ok: false, reason: 'order_mismatch' };
		if (!['pending', 'reserved', 'redeemed', 'expired'].includes(current.status))
			return { ok: false, reason: 'not_redeemable' };
		if (!current.orderId) await site.repos.reservations.transition(id, [current.status], { orderId });
		return { ok: true, reservation: /** @type {Record<string, any>} */ (await site.repos.reservations.get(id)) };
	};

	return Object.freeze({
		evaluate,
		createCoupon,
		updateCoupon,
		generate,
		reserve,
		redeem,
		release,
		attach,
		sweep,
		reservation: reservationOf,
		velocityAllows,
		recordFailures,
		cartFor,
		subjectOf,

		/** @param {Site} site @param {string} id */
		coupon: async (site, id) => {
			const coupon = await site.repos.coupons.get(id);
			return coupon ? couponView(coupon) : null;
		},

		/**
		 * Archive (soft delete): the codes stop working, history stays.
		 * @param {Site} site
		 * @param {string} id
		 */
		archive: async (site, id) => {
			for (let attempt = 0; attempt < 3; attempt += 1) {
				const current = await site.repos.coupons.get(id);
				if (!current) return null;
				if (current.status === 'archived') return couponView(current);
				if (await site.repos.coupons.save(id, current.version, { status: 'archived', archivedAt: iso(now()) }))
					return couponView(/** @type {Record<string, any>} */ (await site.repos.coupons.get(id)));
			}
			return null;
		},

		/**
		 * Bulk generation for an existing coupon (unique, single-use by default).
		 * @param {Site} site
		 * @param {string} couponId
		 * @param {{ count: number, pattern?: string }} input
		 * @returns {Promise<{ ok: true, batchId: string, codes: string[] } | Failure>}
		 */
		generateFor: async (site, couponId, { count, pattern }) => {
			const coupon = await site.repos.coupons.get(couponId);
			if (!coupon) return { ok: false, reason: 'not_found' };
			if (coupon.status === 'archived') return { ok: false, reason: 'coupon_inactive' };
			const batchId = randomId('bat');
			const result = await generate(site, {
				couponId,
				pattern: pattern ?? site.settings.codes.default_pattern,
				count,
				maxUses: coupon.limits?.per_code ?? 1,
				batchId,
			});
			return result.ok ? { ok: true, batchId, codes: result.codes } : result;
		},

		/**
		 * One code of a request: is it valid for this cart, and what would it take off?
		 * @param {Site} site
		 * @param {{ code: string, cart: Record<string, any> }} input
		 * @param {Requester} requester
		 * @returns {Promise<{ ok: true, result: { code: string, valid: boolean, reason: string | null, quote: QuoteView } } | Failure>}
		 */
		validate: async (site, { code, cart: cartInput }, requester) => {
			const cart = cartFor(site, cartInput, requester);
			const subject = subjectOf(cart, requester);
			if (!(await velocityAllows(site, subject, 'attempt'))) return { ok: false, reason: 'velocity_limited' };
			const { stack } = await evaluate(site, { codes: [code], cart });
			const refusal = stack.rejected[0];
			if (refusal) await recordFailures(site, subject, FAILURES.has(refusal.reason) ? 1 : 0);
			return {
				ok: true,
				result: {
					code: normalise(site, code),
					valid: !refusal,
					reason: refusal?.reason ?? null,
					quote: quoteView(stack, cart.currency),
				},
			};
		},

		/**
		 * Several codes with the stacking policy applied.
		 * @param {Site} site
		 * @param {{ codes: string[], cart: Record<string, any> }} input
		 * @param {Requester} requester
		 * @returns {Promise<{ ok: true, quote: QuoteView } | Failure>}
		 */
		quote: async (site, { codes, cart: cartInput }, requester) => {
			const cart = cartFor(site, cartInput, requester);
			const subject = subjectOf(cart, requester);
			if (!(await velocityAllows(site, subject, 'attempt'))) return { ok: false, reason: 'velocity_limited' };
			const { stack } = await evaluate(site, { codes, cart });
			await recordFailures(site, subject, stack.rejected.filter((entry) => FAILURES.has(entry.reason)).length);
			return { ok: true, quote: quoteView(stack, cart.currency) };
		},

		/**
		 * Reserve and redeem at once (servers that only learn about the order at the end).
		 * @param {Site} site
		 * @param {{ codes: string[], cart: Record<string, any>, orderId?: string, reference?: string, key: string }} input
		 * @param {Requester} requester
		 */
		redeemNow: async (site, input, requester) => {
			const reserved = await reserve(site, input, requester);
			if (!reserved.ok) return reserved;
			return redeem(site, reserved.reservation.id, { orderId: input.orderId ?? null });
		},

		/**
		 * `order.completed@1`: confirm the order's reservations.
		 * @param {Site} site
		 * @param {{ data: { orderId: string } }} event
		 */
		orderCompleted: async (site, event) => {
			let redeemed = 0;
			for (const reservation of await site.repos.reservations.byOrder(event.data.orderId)) {
				if (!['reserved', 'expired', 'redeemed'].includes(reservation.status)) continue;
				const result = await redeem(site, reservation.id, { orderId: event.data.orderId });
				if (result.ok) redeemed += 1;
			}
			return { redeemed };
		},

		/**
		 * `order.cancelled@1`: give the uses back (`api.release_on_cancel`).
		 * @param {Site} site
		 * @param {{ data: { orderId: string } }} event
		 */
		orderCancelled: async (site, event) => {
			if (site.settings.api.release_on_cancel !== true) return { released: 0 };
			let released = 0;
			for (const reservation of await site.repos.reservations.byOrder(event.data.orderId)) {
				if (!['pending', 'reserved', 'redeemed'].includes(reservation.status)) continue;
				if ((await release(site, reservation.id, 'order_cancelled')).ok) released += 1;
			}
			return { released };
		},

		/**
		 * `order.refunded@1`: give the uses back per `api.release_on_refund` (never / full refund / any refund).
		 * Refunds are summed per reservation (once per event id) in the reservation's currency.
		 * @param {Site} site
		 * @param {{ id: string, data: { orderId: string, amount: { amount: number, currency: string } } }} event
		 */
		orderRefunded: async (site, event) => {
			const policy = site.settings.api.release_on_refund;
			if (policy === 'never') return { released: 0 };
			let released = 0;
			for (const reservation of await site.repos.reservations.byOrder(event.data.orderId)) {
				if (!['reserved', 'redeemed'].includes(reservation.status)) continue;
				let due = policy === 'any';
				if (policy === 'full') {
					const amount = event.data.amount?.currency === reservation.cart?.currency ? event.data.amount.amount : 0;
					const stored = await site.repos.reservations.addRefund(reservation.id, { eventId: event.id, amount });
					const refunded = (stored?.refunds ?? []).reduce(
						(/** @type {number} */ sum, /** @type {{ amount: number }} */ refund) => sum + refund.amount,
						0,
					);
					due = refunded >= (reservation.totals?.total ?? 0);
				}
				if (due && (await release(site, reservation.id, 'order_refunded')).ok) released += 1;
			}
			return { released };
		},

		/**
		 * Report of a window (`from`/`to`, else the default window).
		 * @param {Site} site
		 * @param {{ from?: unknown, to?: unknown }} query
		 * @returns {Promise<{ ok: true, report: ReturnType<typeof summarise> } | Failure>}
		 */
		report: async (site, query) => {
			const { reporting } = site.settings;
			const window = reportWindow({ from: query.from, to: query.to, now: now(), days: reporting.default_window_days });
			if (!window) return { ok: false, reason: 'validation_failed' };
			if (toMs(window.to) - toMs(window.from) > reporting.max_window_days * 24 * 60 * MINUTE_MS)
				return { ok: false, reason: 'window_too_long' };
			const [orders, codes, released] = await Promise.all([
				site.repos.reservations.ordersBetween(window.from, window.to),
				site.repos.reservations.codesBetween(window.from, window.to),
				site.repos.reservations.releasedBetween(window.from, window.to),
			]);
			return { ok: true, report: summarise({ ...window, orders, codes, released, top: reporting.top_codes }) };
		},

		/**
		 * A share link (and its QR code) for a code.
		 * @param {Site} site
		 * @param {{ code: string, path?: string, campaign?: string }} input
		 * @returns {Promise<{ ok: true, link: { code: string, couponId: string, url: string, qr: string } } | Failure>}
		 */
		shareLink: async (site, { code: raw, path, campaign }) => {
			const code = normalise(site, raw);
			const doc = await site.repos.codes.get(code);
			if (!doc) return { ok: false, reason: 'code_not_found' };
			const { distribution, codes } = site.settings;
			const url = shareLink({
				domain: site.domain,
				path: path ?? distribution.share_path,
				param: codes.auto_apply_param,
				code,
				utm: { source: distribution.utm_source, medium: distribution.utm_medium, campaign: campaign ?? '' },
			});
			if (!url) return { ok: false, reason: 'validation_failed' };
			return { ok: true, link: { code, couponId: doc.couponId, url, qr: `/v1/share-links/${encodeURIComponent(code)}/qr` } };
		},

		/**
		 * The QR code (SVG) of a code's share link.
		 * @param {Site} site
		 * @param {string} raw
		 * @param {{ path?: string }} [options]
		 * @returns {Promise<{ ok: true, svg: string } | Failure>}
		 */
		qr: async (site, raw, { path } = {}) => {
			const code = normalise(site, raw);
			const doc = await site.repos.codes.get(code);
			if (!doc) return { ok: false, reason: 'code_not_found' };
			const { distribution, codes } = site.settings;
			const url = shareLink({
				domain: site.domain,
				path: path ?? distribution.share_path,
				param: codes.auto_apply_param,
				code,
				utm: { source: distribution.utm_source, medium: distribution.utm_medium },
			});
			if (!url) return { ok: false, reason: 'validation_failed' };
			const encoded = encodeQr(url, { ecc: distribution.qr_ecc });
			if (!encoded.ok) return { ok: false, reason: 'validation_failed' };
			return {
				ok: true,
				svg: qrToSvg(encoded.qr, {
					margin: distribution.qr_margin,
					moduleSize: distribution.qr_module_px,
					dark: distribution.qr_dark,
					light: distribution.qr_light,
					title: code,
				}),
			};
		},

		/**
		 * CSV of a coupon's codes (code, status, uses, share link).
		 * @param {Site} site
		 * @param {string} couponId
		 * @returns {Promise<{ ok: true, csv: string, filename: string } | Failure>}
		 */
		exportCodes: async (site, couponId) => {
			const coupon = await site.repos.coupons.get(couponId);
			if (!coupon) return { ok: false, reason: 'not_found' };
			const { distribution, codes } = site.settings;
			/** @type {Array<Record<string, unknown>>} */
			const rows = [];
			let after = /** @type {string | null} */ (null);
			const page = 1000;
			while (rows.length < distribution.max_export_rows) {
				const docs = await site.repos.codes.byCoupon(couponId, {
					after,
					fetchLimit: Math.min(page, distribution.max_export_rows - rows.length),
				});
				for (const doc of docs) {
					const view = codeView(/** @type {Record<string, any>} */ (doc));
					rows.push({
						code: view.code,
						status: view.status,
						max_uses: view.maxUses,
						taken: view.taken,
						redeemed: view.redeemed,
						link: shareLink({
							domain: site.domain,
							path: distribution.share_path,
							param: codes.auto_apply_param,
							code: view.code,
						}),
					});
				}
				if (docs.length < page) break;
				after = /** @type {Record<string, any>} */ (docs.at(-1)).code;
			}
			return {
				ok: true,
				csv: toCsv(['code', 'status', 'max_uses', 'taken', 'redeemed', 'link'], rows),
				filename: `coupon-${couponId}.csv`,
			};
		},

		/**
		 * Listed coupons (apply box suggestions) with their share links.
		 * @param {Site} site
		 */
		listed: async (site) => {
			/** @type {Array<{ name: string, code: string, url: string | null }>} */
			const out = [];
			for (const coupon of await site.repos.coupons.listed(LISTED_LIMIT)) {
				if (coupon?.mode !== 'shared') continue;
				const [code] = await site.repos.codes.byCoupon(coupon.id, { fetchLimit: 1 });
				if (!code || code.status !== 'active') continue;
				out.push({
					name: coupon.name,
					code: code.code,
					url: shareLink({
						domain: site.domain,
						path: site.settings.distribution.share_path,
						param: site.settings.codes.auto_apply_param,
						code: code.code,
					}),
				});
			}
			return out;
		},

		/**
		 * Dashboard KPIs.
		 * @param {Site} site
		 */
		overview: async (site) => {
			const to = iso(now());
			const from = iso(now() - site.settings.reporting.default_window_days * 24 * 60 * MINUTE_MS);
			const [coupons, open, orders, codes] = await Promise.all([
				site.repos.coupons.countActive(),
				site.repos.reservations.countOpen(to),
				site.repos.reservations.ordersBetween(from, to),
				site.repos.reservations.codesBetween(from, to),
			]);
			return {
				...summarise({ from, to, orders, codes, released: 0, top: site.settings.reporting.top_codes }),
				activeCoupons: coupons,
				openReservations: open,
				windowDays: site.settings.reporting.default_window_days,
			};
		},

		views: { couponView, codeView, reservationView, quoteView },
	});
};

/** @typedef {ReturnType<typeof createCouponsService>} CouponsService */
