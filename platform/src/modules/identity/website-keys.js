/**
 * Website keys (`pk_` browser, `sk_` server): signed `@ss/protocol` tokens issued with the dedicated website-key
 * signer, shown once. Stored: metadata, and for `sk_` only `hashSecretKey` (HMAC with `WEBSITE_KEY_PEPPER`).
 * Rotation issues a replacement and schedules the old key's revocation after a grace period; revocation is
 * immediate. Revocations feed `GET /v1/product/revocations` (cursor, F.9), the `websiteKeyRevoked` port and the
 * `key.revoked@1` control event (via the integration module when it is registered).
 * @module
 */
import { issueWebsiteKey } from '@ss/protocol';
import { problem } from '../../infra/http.js';
import { DEFAULT_GRACE_SECONDS } from './core/inputs.js';
import { claimsMatch, expirySeconds, keyHint, keyStatus, presentKey, rotationRevokeAt } from './core/keys.js';
import { decodeRevocationCursor, REVOCATION_PAGE, revocationFilter, revocationPage } from './core/revocations.js';
import { checkScopes, scopeCatalogue } from './core/scopes.js';

/** @typedef {import('./repo.js').Deps} Deps */
/** @typedef {import('./repo.js').Meta} Meta */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */
/** @typedef {import('./repo.js').AuditActor} AuditActor */
/** @typedef {import('@ss/protocol').Signer} Signer */
/** @typedef {import('@ss/protocol').WebsiteKeyClaims} WebsiteKeyClaims */

export const REVOKE_JOB = 'identity.key_revoked';

/**
 * @param {Deps} deps
 * @param {{
 *   signer: () => Signer,
 *   loadWebsite: (websiteId: string, merchantId?: string) => Promise<Record<string, any>>,
 *   activeMerchant: (merchantId: string) => Promise<Record<string, any>>,
 *   products?: () => Promise<ReadonlyArray<{ slug: string, name?: string }>>,
 * }} hooks `products`: listed service products (their `<slug>.read|write` scopes)
 */
export const createWebsiteKeys = (deps, hooks) => {
	const { ctx, repo, audit } = deps;

	/** The scope catalogue (F.16): platform scopes + one read/write pair per listed service product. */
	const catalogue = async () => {
		/** @type {ReadonlyArray<{ slug: string, name?: string }>} */
		let products = [];
		try {
			products = (await hooks.products?.()) ?? [];
		} catch (error) {
			ctx.logger.warn('product list unavailable for the scope catalogue', { error });
		}
		return scopeCatalogue(products);
	};

	/**
	 * Tell products (best effort; products also poll the revocation list).
	 * @param {string[]} keyIds
	 * @param {Date} revokedAt
	 * @param {string | undefined} websiteId
	 */
	const emitRevoked = async (keyIds, revokedAt, websiteId) => {
		if (keyIds.length === 0 || !ctx.moduleNames().includes('integration')) return;
		for (let i = 0; i < keyIds.length; i += 1000) {
			try {
				await ctx.service('integration').emitControl(
					'key.revoked@1',
					{ keyIds: keyIds.slice(i, i + 1000), revokedAt: revokedAt.toISOString() },
					{
						...(websiteId ? { websiteId } : {}),
					},
				);
			} catch (error) {
				ctx.logger.warn('key.revoked@1 could not be emitted', { error, count: keyIds.length });
			}
		}
	};

	/**
	 * @param {string} keyId
	 * @param {string} [merchantId]
	 * @param {string} [websiteId]
	 */
	const loadKey = async (keyId, merchantId, websiteId) => {
		const doc = merchantId
			? await repo.keys.of(merchantId).findOne({ merchantId, _id: keyId })
			: await repo.keys.all().findOne({ _id: keyId });
		if (!doc || (websiteId && doc.websiteId !== websiteId)) throw problem('not_found', 'No such key.');
		return doc;
	};

	/**
	 * @param {{ website: Record<string, any>, keyId: string, kind: 'pk' | 'sk', scopes: string[], allowSubdomains: boolean,
	 *   expiresAtMs?: number, rotatedFrom?: string | null, actor: Actor | AuditActor }} input
	 */
	const mint = async ({ website, keyId, kind, scopes, allowSubdomains, expiresAtMs, rotatedFrom = null, actor }) => {
		const expiry = expirySeconds(expiresAtMs, ctx.now());
		if (!expiry.ok)
			throw problem('validation_failed', expiry.message, { errors: [{ path: '/expiresAt', message: expiry.message }] });
		const signer = hooks.signer();
		const { key } = await issueWebsiteKey({
			signer,
			kind,
			websiteId: String(website._id),
			merchantId: String(website.merchantId),
			domain: website.domain,
			allowSubdomains,
			env: website.env,
			scopes,
			keyId,
			now: ctx.now,
			...(expiry.value === undefined ? {} : { expiresAt: expiry.value }),
		});
		const record = {
			_id: keyId,
			websiteId: String(website._id),
			kind,
			env: website.env,
			scopes,
			allowSubdomains,
			kid: signer.kid,
			hint: keyHint(key),
			secretHash: kind === 'sk' ? ctx.secretHasher.hash(key) : null,
			expiresAt: expiry.value === undefined ? null : new Date(expiry.value * 1000),
			revokeAt: null,
			revokeReason: null,
			replacedBy: null,
			rotatedFrom,
			createdBy: actor.id,
		};
		await repo.keys.of(String(website.merchantId)).insertOne(record);
		return { key, record: { ...record, merchantId: String(website.merchantId), createdAt: new Date(ctx.now()) } };
	};

	/**
	 * Revoke now (idempotent): returns the record and whether this call revoked it.
	 * @param {Record<string, any>} doc
	 * @param {string} reason
	 */
	const revokeNow = async (doc, reason) => {
		const now = new Date(ctx.now());
		if (doc.revokeAt && doc.revokeAt.getTime() <= now.getTime()) return { doc, changed: false };
		const result = await repo.keys
			.of(doc.merchantId)
			.updateOne(
				{ merchantId: doc.merchantId, _id: doc._id, $or: [{ revokeAt: null }, { revokeAt: { $gt: now } }] },
				{ $set: { revokeAt: now, revokeReason: reason } },
			);
		return { doc: { ...doc, revokeAt: now, revokeReason: reason }, changed: result.modifiedCount === 1 };
	};

	return Object.freeze({
		/**
		 * Issue a key for a website (key shown once).
		 * @param {{ websiteId: string, merchantId?: string, kind: 'pk' | 'sk', scopes?: string[], expiresAt?: number | string,
		 *   allowSubdomains?: boolean, actor?: Actor | AuditActor, meta?: Meta }} input `expiresAt`: epoch ms or ISO string
		 */
		issueKey: async ({ websiteId, merchantId, kind, scopes = [], expiresAt, allowSubdomains = false, actor, meta = {} }) => {
			const who = actor ?? { type: /** @type {'system'} */ ('system'), id: 'identity' };
			const checked = checkScopes(scopes, await catalogue());
			if (!checked.ok) throw problem('validation_failed', 'The key scopes are invalid.', { errors: checked.errors });
			const website = await hooks.loadWebsite(websiteId, merchantId);
			if (website.status !== 'active') throw problem('not_found', 'No such website.');
			await hooks.activeMerchant(String(website.merchantId));
			const expiresAtMs = typeof expiresAt === 'string' ? Date.parse(expiresAt) : expiresAt;
			if (expiresAtMs !== undefined && !Number.isFinite(expiresAtMs))
				throw problem('validation_failed', 'expiresAt is invalid.', {
					errors: [{ path: '/expiresAt', message: 'is invalid' }],
				});
			const keyId = repo.id('key');
			const { key, record } = await mint({
				website,
				keyId,
				kind,
				scopes: checked.value,
				allowSubdomains,
				actor: who,
				...(expiresAtMs === undefined ? {} : { expiresAtMs }),
			});
			const metadata = presentKey(/** @type {any} */ (record), ctx.now());
			await audit(
				who,
				'key.issued',
				{ type: 'website_key', id: keyId, merchantId: record.merchantId, websiteId },
				{
					after: metadata,
					meta,
				},
			);
			return { ...metadata, key };
		},

		/** The scope catalogue keys are checked against (console key form). */
		scopeCatalogue: catalogue,

		/**
		 * Key metadata of a website, newest first.
		 * @param {{ merchantId: string, websiteId: string }} input
		 */
		listKeys: async ({ merchantId, websiteId }) =>
			(await repo.keys.of(merchantId).find({ merchantId, websiteId }).sort({ createdAt: -1 }).limit(500).toArray()).map(
				(doc) => presentKey(/** @type {any} */ (doc), ctx.now()),
			),

		/**
		 * Rotate: issue a replacement now, revoke the old key after `graceSeconds` (default 24 h; 0 = now).
		 * @param {{ merchantId: string, websiteId: string, keyId: string, graceSeconds?: number, actor: Actor, meta?: Meta }} input
		 */
		rotateKey: async ({ merchantId, websiteId, keyId, graceSeconds = DEFAULT_GRACE_SECONDS, actor, meta = {} }) => {
			const old = await loadKey(keyId, merchantId, websiteId);
			if (keyStatus(/** @type {any} */ (old), ctx.now()) !== 'active')
				throw problem('conflict', 'Only active keys can be rotated.');
			const website = await hooks.loadWebsite(websiteId, merchantId);
			if (website.status !== 'active') throw problem('not_found', 'No such website.');
			await hooks.activeMerchant(merchantId);
			const newId = repo.id('key');
			const revokeAt = rotationRevokeAt(ctx.now(), graceSeconds);
			const marked = await repo.keys
				.of(merchantId)
				.updateOne(
					{ merchantId, _id: keyId, revokeAt: null },
					{ $set: { revokeAt, revokeReason: 'rotated', replacedBy: newId } },
				);
			if (marked.modifiedCount !== 1) throw problem('conflict', 'This key is already being rotated or revoked.');
			const keepExpiry = old.expiresAt && old.expiresAt.getTime() > ctx.now() + 60_000 ? old.expiresAt.getTime() : undefined;
			const { key, record } = await mint({
				website,
				keyId: newId,
				kind: old.kind,
				scopes: old.scopes,
				allowSubdomains: old.allowSubdomains,
				rotatedFrom: keyId,
				actor,
				...(keepExpiry === undefined ? {} : { expiresAtMs: keepExpiry }),
			});
			if (graceSeconds === 0) await emitRevoked([keyId], revokeAt, websiteId);
			else
				await ctx.jobs.enqueue({
					name: REVOKE_JOB,
					key: `${REVOKE_JOB}:${keyId}`,
					payload: { keyId, merchantId },
					runAt: revokeAt.getTime(),
				});
			const fresh = presentKey(/** @type {any} */ (record), ctx.now());
			await audit(
				actor,
				'key.rotated',
				{ type: 'website_key', id: keyId, merchantId, websiteId },
				{
					after: { replacedBy: newId, revokeAt: revokeAt.toISOString() },
					meta,
				},
			);
			return {
				...fresh,
				key,
				previous: presentKey(
					/** @type {any} */ ({ ...old, revokeAt, revokeReason: 'rotated', replacedBy: newId }),
					ctx.now(),
				),
			};
		},

		/**
		 * Revoke a key immediately (idempotent).
		 * @param {{ keyId: string, reason?: string, merchantId?: string, websiteId?: string, actor?: Actor | AuditActor, meta?: Meta }} input
		 */
		revokeKey: async ({ keyId, reason = 'revoked', merchantId, websiteId, actor, meta = {} }) => {
			const who = actor ?? { type: /** @type {'system'} */ ('system'), id: 'identity' };
			const doc = await loadKey(keyId, merchantId, websiteId);
			const { doc: revoked, changed } = await revokeNow(doc, reason);
			if (changed) {
				await emitRevoked([keyId], revoked.revokeAt, doc.websiteId);
				await audit(
					who,
					'key.revoked',
					{ type: 'website_key', id: keyId, merchantId: doc.merchantId, websiteId: doc.websiteId },
					{
						reason,
						meta,
					},
				);
			}
			return presentKey(/** @type {any} */ (revoked), ctx.now());
		},

		/**
		 * Revoke every unrevoked key of some websites (website deletion/transfer). Returns the revoked keyIds.
		 * @param {{ merchantId: string, websiteIds: string[], reason: string, actor: Actor | AuditActor, meta?: Meta }} input
		 */
		revokeWebsiteKeys: async ({ merchantId, websiteIds, reason, actor, meta = {} }) => {
			const now = new Date(ctx.now());
			const keys = repo.keys.of(merchantId);
			const open = await keys
				.find({ merchantId, websiteId: { $in: websiteIds }, $or: [{ revokeAt: null }, { revokeAt: { $gt: now } }] })
				.project({ _id: 1 })
				.toArray();
			const ids = open.map((doc) => String(doc._id));
			if (ids.length === 0) return [];
			await keys.updateMany(
				{ merchantId, _id: { $in: ids }, $or: [{ revokeAt: null }, { revokeAt: { $gt: now } }] },
				{ $set: { revokeAt: now, revokeReason: reason } },
			);
			await emitRevoked(ids, now, websiteIds[0]);
			await audit(
				actor,
				'key.revoked_bulk',
				{ type: 'website', id: String(websiteIds[0]), merchantId, websiteId: websiteIds[0] ?? null },
				{
					after: { keyIds: ids },
					reason,
					meta,
				},
			);
			return ids;
		},

		/**
		 * Revocations effective after the cursor (F.9 `{ keyIds, cursor }`).
		 * @param {string | null | undefined} cursor
		 */
		revocationsSince: async (cursor) => {
			const since = decodeRevocationCursor(cursor);
			if (!since.ok) throw problem('bad_request', 'since is not a valid cursor.');
			const now = ctx.now();
			const rows = await repo.keys
				.all()
				.find(revocationFilter(since.value, now))
				.sort({ revokeAt: 1, _id: 1 })
				.limit(REVOCATION_PAGE + 1)
				.project({ _id: 1, revokeAt: 1 })
				.toArray();
			return revocationPage(/** @type {any} */ (rows), since.value, now);
		},

		/**
		 * `websiteKeyRevoked` port: true (refuse) unless the key is known, bound as signed, and not revoked; when the
		 * raw key is passed (`sk_`), its HMAC must also match.
		 * @param {WebsiteKeyClaims} claims
		 * @param {string} [key]
		 */
		isRevoked: async (claims, key) => {
			const doc = await repo.keys.all().findOne({ _id: claims.keyId });
			if (!doc || !claimsMatch(/** @type {any} */ (doc), claims)) return true;
			if (doc.revokeAt && doc.revokeAt.getTime() <= ctx.now()) return true;
			if (typeof key === 'string' && claims.kind === 'sk')
				return !(doc.secretHash && ctx.secretHasher.verify(key, doc.secretHash));
			return false;
		},

		/**
		 * Job: a scheduled (rotation) revocation became effective → emit `key.revoked@1`.
		 * @param {{ keyId: string, merchantId: string }} payload
		 */
		onScheduledRevocation: async ({ keyId, merchantId }) => {
			const doc = await repo.keys.of(merchantId).findOne({ merchantId, _id: keyId });
			if (!doc || !doc.revokeAt) return { skipped: true };
			if (doc.revokeAt.getTime() > ctx.now()) throw new Error('revocation not yet effective');
			await emitRevoked([keyId], doc.revokeAt, doc.websiteId);
			return { emitted: true };
		},
	});
};
/** @typedef {ReturnType<typeof createWebsiteKeys>} WebsiteKeys */
