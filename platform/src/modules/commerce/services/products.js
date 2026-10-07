/**
 * Products on websites (PLAN 0.5.9) and the product side of the Product ↔ Portal contract (0.4.12 rows 2–5).
 *
 * - **Add** (Owner, Support): only active connected products not yet on the website; the two tokens are created, or
 *   restored on a re-add; the switches start all off. **Remove**: status removed, nothing is charged from the next hour;
 *   it works even when the product cannot be reached. Both tell the product (`status.changed`).
 * - **Price reports** (row 2): refused whole (422) for a bad shape or price, 409 when the version is not higher;
 *   accepted lists apply at once and are written to Activity as reported by the product.
 * - **Feature reports** (row 3): refused whole for an unknown key, a switched-on feature without a price, a dependency
 *   off, a website × product that never existed (404 `website_not_found`), a version not higher (409), or an
 *   `adminId` that is not a current Owner or Support admin (422 / 403). Accepted for stopped, suspended and removed
 *   products; stamped with the Portal clock and written to Activity with the Portal's own name of the admin.
 * - **Status** (row 4): runs the check first, then answers the status response; 404 `website_not_found` for a deleted
 *   website or a website × product that never existed.
 * - **Websites** (row 5): the websites that have the product (removed excluded), with their status.
 * @module
 */
import { validateFeatureReport, validatePriceReport } from '@ss/contracts';
import { problem } from '../../../infra/http.js';
import { dayOf, floorDay, floorMonth, productStatusOf } from '../core/money.js';

/** @typedef {import('../../../infra/modules.js').ModuleContext} ModuleContext */
/** @typedef {import('../repo.js').CommerceRepo} CommerceRepo */
/** @typedef {import('./deps.js').Deps} Deps */
/** @typedef {import('./billing.js').Billing} Billing */
/** @typedef {import('../../../infra/rbac.js').Actor} Actor */
/** @typedef {Record<string, any>} Doc */
/** @typedef {{ actor: Actor, requestId?: string | null, ip?: string | null }} Caller */

/** A status response may be cached this long at most (PLAN 0.4.7). */
export const STATUS_TTL_MS = 5 * 60_000;
/** Websites per page of the websites list (row 5). */
export const WEBSITES_PAGE = 100;
const DAYS_IN_SERIES = 30;

/** @param {string} websiteId @param {string} productId */
export const productKey = (websiteId, productId) => `${websiteId}:${productId}`;

/**
 * @param {string | null | undefined} cursor
 * @returns {string}
 */
const decodeCursor = (cursor) => {
	if (cursor === null || cursor === undefined || cursor === '') return '';
	if (!/^[A-Za-z0-9_-]{1,256}$/.test(cursor)) throw problem('bad_request', 'cursor is invalid');
	return Buffer.from(cursor, 'base64url').toString('utf8');
};

/** @param {string} key */
const encodeCursor = (key) => Buffer.from(key, 'utf8').toString('base64url');

/**
 * @param {readonly { path: string, message: string }[]} problems
 * @param {string} detail
 */
const refused = (problems, detail) =>
	problem('validation_failed', detail, { errors: problems.map((p) => ({ path: p.path, message: p.message })) });

/**
 * @param {{ ctx: ModuleContext, repo: CommerceRepo, deps: Deps, billing: Billing }} input
 */
export const createProducts = ({ ctx, repo, deps, billing }) => {
	/**
	 * @param {Caller['actor'] | { type: 'product', id: string } | { type: 'admin', id: string, name: string }} actor
	 * @param {string} action
	 * @param {{ merchantId?: string | null, websiteId?: string | null, productId: string }} target
	 * @param {{ before?: unknown, after?: Record<string, unknown>, requestId?: string | null, ip?: string | null }} [extra]
	 */
	const audit = (actor, action, { merchantId = null, websiteId = null, productId }, extra = {}) =>
		ctx.audit.record({
			actor: /** @type {any} */ (actor),
			action,
			target: websiteId
				? { type: 'website', id: websiteId, merchantId, websiteId }
				: { type: 'product', id: productId, merchantId },
			...(extra.before === undefined ? {} : { before: extra.before }),
			after: { productId, ...(extra.after ?? {}) },
			requestId: extra.requestId ?? null,
			ip: extra.ip ?? null,
		});

	/**
	 * `status.changed` to every product on the merchant's websites (not removed).
	 * @param {string} merchantId
	 */
	const statusChanged = async (merchantId) => {
		const docs = await repo.productsOf(merchantId).find({ merchantId, status: 'added' }).limit(1000).toArray();
		for (const doc of docs) await deps.statusChanged(String(doc.productId), String(doc.websiteId));
	};

	/**
	 * The product on a website, by its global key (any merchant), or null.
	 * @param {string} websiteId @param {string} productId
	 * @returns {Promise<Doc | null>}
	 */
	const find = (websiteId, productId) => repo.allProducts().findOne({ _id: productKey(websiteId, productId) });

	/**
	 * The website of a request, which must belong to the merchant and be active.
	 * @param {string} merchantId @param {string} websiteId
	 */
	const activeWebsite = async (merchantId, websiteId) => {
		const website = await deps.getWebsite(websiteId).catch(() => null);
		if (!website || website.merchantId !== merchantId || website.status !== 'active')
			throw problem('not_found', 'No such website.');
		return website;
	};

	/**
	 * Add a product to a website (Owner, Support): active connected products not yet on the website. A re-add restores
	 * the same tokens; the switches start all off.
	 * @param {{ merchantId: string, websiteId: string, productId: string } & Caller} input
	 */
	const add = async ({ merchantId, websiteId, productId, actor, requestId = null, ip = null }) => {
		await activeWebsite(merchantId, websiteId);
		if (!(await deps.productActive(productId).catch(() => false)))
			throw problem('conflict', 'This product is not offered: it is not connected or it is inactive.');
		const ops = repo.productsOf(merchantId);
		const existing = await ops.findOne({ merchantId, _id: productKey(websiteId, productId) });
		if (existing?.status === 'added') throw problem('conflict', 'This product is already on the website.');
		const at = new Date(ctx.now());
		if (existing) {
			const changed = await ops.updateOne(
				{ merchantId, _id: existing._id, status: 'removed' },
				{ $set: { status: 'added', on: [], addedAt: at, removedAt: null } },
			);
			if (changed.modifiedCount !== 1) throw problem('conflict', 'This product is already on the website.');
		} else {
			try {
				await ops.insertOne({
					_id: productKey(websiteId, productId),
					websiteId,
					productId,
					status: 'added',
					on: [],
					featuresVersion: 0,
					addedAt: at,
					removedAt: null,
				});
			} catch (error) {
				if (repo.isDuplicateKey(error)) throw problem('conflict', 'This product is already on the website.');
				throw error;
			}
		}
		await deps.ensureTokens({ merchantId, websiteId, productId });
		await billing.recordProductAdded({ merchantId, websiteId, productId });
		await audit(actor, 'product.added', { merchantId, websiteId, productId }, { requestId, ip });
		await deps.statusChanged(productId, websiteId);
		return productOnWebsite(merchantId, websiteId, productId);
	};

	/**
	 * Remove a product from a website (typed confirmation in the screen): status removed; its tokens are refused by
	 * the status and kept for a re-add. Works even when the product cannot be reached.
	 * @param {{ merchantId: string, websiteId: string, productId: string } & Caller} input
	 */
	const remove = async ({ merchantId, websiteId, productId, actor, requestId = null, ip = null }) => {
		await activeWebsite(merchantId, websiteId);
		const changed = await repo
			.productsOf(merchantId)
			.updateOne(
				{ merchantId, _id: productKey(websiteId, productId), status: 'added' },
				{ $set: { status: 'removed', removedAt: new Date(ctx.now()) } },
			);
		if (changed.modifiedCount !== 1) throw problem('not_found', 'This product is not on the website.');
		await billing.recordProductRemoved({ merchantId, websiteId, productId });
		await audit(actor, 'product.removed', { merchantId, websiteId, productId }, { requestId, ip });
		await deps.statusChanged(productId, websiteId);
		return { websiteId, productId, status: /** @type {const} */ ('removed') };
	};

	/**
	 * Products on a website (not removed) with their status (0.5.5), features on and cost, for cards and chips.
	 * @param {string} merchantId @param {string} websiteId
	 */
	const listForWebsite = async (merchantId, websiteId) => {
		const docs = await repo
			.productsOf(merchantId)
			.find({ merchantId, websiteId, status: 'added' })
			.sort({ productId: 1 })
			.limit(100)
			.toArray();
		if (docs.length === 0) return [];
		const summary = await billing.summary(merchantId);
		const out = [];
		for (const doc of docs) {
			const live = summary.products.find((p) => p.websiteId === websiteId && p.productId === doc.productId);
			const hourlyCost = live?.hourlyCost ?? 0;
			out.push({
				productId: String(doc.productId),
				name: await deps.productName(String(doc.productId)),
				status: productStatusOf({ added: true, merchantStatus: summary.status }),
				featuresOn: live?.featuresOn ?? [],
				featuresVersion: Number(doc.featuresVersion ?? 0),
				hourlyCost,
				dailyCost: 24 * hourlyCost,
				addedAt: doc.addedAt instanceof Date ? doc.addedAt.toISOString() : null,
			});
		}
		return out;
	};

	/**
	 * One product on a website as a card.
	 * @param {string} merchantId @param {string} websiteId @param {string} productId
	 */
	const productOnWebsite = async (merchantId, websiteId, productId) => {
		const cards = await listForWebsite(merchantId, websiteId);
		return cards.find((card) => card.productId === productId) ?? null;
	};

	// ------------------------------------------------------------------------------------------------ reports

	/**
	 * Accept a price list (price report, connect or reconnect answer): stored, applied at once, written to Activity as
	 * reported by the product (the first list of a product is its connect answer and is not logged).
	 * @param {{ productId: string, prices: unknown, requestId?: string | null, ip?: string | null }} input
	 */
	const acceptPrices = async ({ productId, prices, requestId = null, ip = null }) => {
		const checked = validatePriceReport(prices);
		if (!checked.ok) throw refused(checked.problems, 'The price report is invalid.');
		const accepted = await billing.recordPriceList({ productId, prices: checked.value });
		if (accepted.previous) {
			/** @type {Map<string, number>} */
			const before = new Map(accepted.previous.features.map((/** @type {Doc} */ f) => [String(f.key), Number(f.price)]));
			const changes = accepted.features
				.filter((f) => before.get(f.key) !== f.price)
				.map((f) => ({ key: f.key, before: before.get(f.key) ?? null, after: f.price }));
			const dropped = [...before.keys()].filter((key) => !accepted.features.some((f) => f.key === key));
			await audit(
				{ type: 'product', id: productId },
				'product.prices_changed',
				{ productId },
				{ after: { version: accepted.version, changes, dropped }, requestId, ip },
			);
		}
		return { version: accepted.version };
	};

	/**
	 * `PUT /v1/product/websites/:websiteId/features` (row 3).
	 * @param {{ productId: string, websiteId: string, body: unknown, requestId?: string | null, ip?: string | null }} input
	 */
	const acceptFeatures = async ({ productId, websiteId, body, requestId = null, ip = null }) => {
		const checked = validateFeatureReport(body);
		if (!checked.ok) throw refused(checked.problems, 'The feature report is invalid.');
		const report = checked.value;
		const doc = await find(websiteId, productId);
		if (!doc) throw problem('website_not_found', 'This website never had this product.');
		const website = await deps.getWebsite(websiteId).catch(() => null);
		if (!website || website.status !== 'active') throw problem('website_not_found', 'This website was removed.');
		if (report.version <= Number(doc.featuresVersion ?? 0))
			throw problem('conflict', `Feature report ${report.version} is not higher than ${doc.featuresVersion}.`);
		const prices = await repo.lastPriceList(productId);
		/** @type {Map<string, Doc>} */
		const priced = new Map((prices?.features ?? []).map((/** @type {Doc} */ f) => [String(f.key), f]));
		const known = new Set(await repo.knownFeatures(productId));
		const on = new Set(report.on);
		/** @type {{ path: string, message: string }[]} */
		const errors = [];
		report.on.forEach((key, index) => {
			if (!known.has(key)) errors.push({ path: `/on/${index}`, message: `${key} is not a feature of ${productId}` });
			else if (!priced.has(key)) errors.push({ path: `/on/${index}`, message: `${key} has no price` });
			else
				for (const dependency of /** @type {Doc} */ (priced.get(key)).dependsOn ?? [])
					if (!on.has(dependency))
						errors.push({ path: `/on/${index}`, message: `${key} needs ${dependency}, which is off` });
		});
		if (errors.length > 0) throw problem('validation_failed', 'The feature report is refused.', { errors });
		const admin = await deps.dashboardAdmin(report.adminId);
		const merchantId = String(doc.merchantId);
		const keys = [...on].sort();
		const changed = await repo.productsOf(merchantId).updateOne(
			{ merchantId, _id: doc._id, featuresVersion: doc.featuresVersion ?? 0 },
			{
				$set: {
					on: keys,
					featuresVersion: report.version,
					reportedAt: new Date(ctx.now()),
					reportedBy: admin.adminId,
				},
			},
		);
		if (changed.modifiedCount !== 1) throw problem('conflict', 'Another feature report was accepted meanwhile.');
		await billing.recordSwitches({ merchantId, websiteId, productId, on: keys });
		await audit(
			{ type: 'admin', id: admin.adminId, name: admin.name },
			'product.features_changed',
			{ merchantId, websiteId, productId },
			{ before: { on: doc.on ?? [] }, after: { version: report.version, on: keys }, requestId, ip },
		);
		return { version: report.version };
	};

	/**
	 * `GET /v1/product/websites/:websiteId/status` (row 4): settles the merchant first.
	 * @param {{ productId: string, websiteId: string }} input
	 */
	const statusFor = async ({ productId, websiteId }) => {
		const doc = await find(websiteId, productId);
		const website = doc ? await deps.getWebsite(websiteId).catch(() => null) : null;
		if (!doc || !website || website.status !== 'active')
			throw problem('website_not_found', 'This website does not have this product.');
		const merchantId = String(doc.merchantId);
		const { checked, status: merchantStatus } = await billing.statusOf(merchantId);
		const status = productStatusOf({ added: doc.status === 'added', merchantStatus });
		const { run, cut, now } = checked;
		const todayMillicredits = run.charges
			.filter((c) => c.hour >= cut && c.websiteId === websiteId && c.productId === productId)
			.reduce((sum, c) => sum + c.amount, 0);
		const graceEnd = status === 'grace' ? run.phase.graceEnd : null;
		const validUntil = Math.min(now + STATUS_TTL_MS, graceEnd ?? Number.POSITIVE_INFINITY);
		const merchant = await deps.getMerchantRecord(merchantId);
		return {
			websiteId,
			merchantId,
			merchantName: merchant.name,
			domain: website.domain,
			status,
			graceEndsAt: graceEnd === null ? null : new Date(graceEnd).toISOString(),
			todayMillicredits,
			featuresVersion: Number(doc.featuresVersion ?? 0),
			validUntil: new Date(validUntil).toISOString(),
		};
	};

	// ------------------------------------------------------------------------------------------------ lists

	/**
	 * A page of a product's websites (removed excluded) after a cursor, with status (one check per merchant).
	 * @param {{ productId: string, cursor: string | null }} input
	 */
	const websitesPage = async ({ productId, cursor }) => {
		const after = decodeCursor(cursor);
		const docs = await repo
			.allProducts()
			.find({ productId, status: 'added', ...(after ? { _id: { $gt: after } } : {}) })
			.sort({ _id: 1 })
			.limit(WEBSITES_PAGE + 1)
			.toArray();
		const page = docs.slice(0, WEBSITES_PAGE);
		const sites = await deps.websitesByIds(page.map((d) => String(d.websiteId)));
		/** @type {Map<string, Awaited<ReturnType<Billing['summary']>>>} */
		const summaries = new Map();
		/** @type {Map<string, string>} */
		const names = new Map();
		const rows = [];
		for (const doc of page) {
			const merchantId = String(doc.merchantId);
			if (!summaries.has(merchantId)) {
				summaries.set(merchantId, await billing.summary(merchantId));
				names.set(merchantId, (await deps.getMerchantRecord(merchantId)).name);
			}
			const summary = /** @type {Awaited<ReturnType<Billing['summary']>>} */ (summaries.get(merchantId));
			const live = summary.products.find((p) => p.websiteId === doc.websiteId && p.productId === productId);
			rows.push({
				websiteId: String(doc.websiteId),
				domain: sites.get(String(doc.websiteId))?.domain ?? String(doc.websiteId),
				merchantId,
				merchantName: /** @type {string} */ (names.get(merchantId)),
				status: productStatusOf({ added: true, merchantStatus: summary.status }),
				featuresOn: live?.featuresOn ?? [],
				dailyCost: 24 * (live?.hourlyCost ?? 0),
			});
		}
		const last = page[page.length - 1];
		return { rows, cursor: docs.length > WEBSITES_PAGE && last ? encodeCursor(String(last._id)) : null };
	};

	/**
	 * Credits a product earned: this UTC month (today included) and the last 30 UTC days; and the websites using it.
	 * Today is live (one check per merchant that had the product today); earlier days are the written day charges.
	 * @param {string | null} only one product, or every product
	 */
	const numbers = async (only) => {
		const now = ctx.now();
		const today = floorDay(now);
		const monthStart = dayOf(floorMonth(now));
		const seriesStart = dayOf(today - (DAYS_IN_SERIES - 1) * 86_400_000);
		const from = monthStart < seriesStart ? monthStart : seriesStart;
		const docs = await repo
			.allProducts()
			.find(only ? { productId: only } : {})
			.project({ merchantId: 1, productId: 1, status: 1, removedAt: 1 })
			.limit(10_000)
			.toArray();
		/** @type {Map<string, { websites: number, earnedThisMonth: number, days: Map<string, number> }>} */
		const out = new Map();
		/** @param {string} productId */
		const entry = (productId) => {
			const existing = out.get(productId);
			if (existing) return existing;
			const created = { websites: 0, earnedThisMonth: 0, days: new Map() };
			out.set(productId, created);
			return created;
		};
		/** @param {string} productId @param {string} day @param {number} amount */
		const add = (productId, day, amount) => {
			const e = entry(productId);
			if (day >= monthStart) e.earnedThisMonth += amount;
			e.days.set(day, (e.days.get(day) ?? 0) + amount);
		};
		if (only) entry(only);
		/** @type {Set<string>} */
		const merchants = new Set();
		for (const doc of docs) {
			const e = entry(String(doc.productId));
			if (doc.status === 'added') e.websites += 1;
			if (doc.status === 'added' || (doc.removedAt instanceof Date && doc.removedAt.getTime() >= today))
				merchants.add(String(doc.merchantId));
		}
		// checks first: they write the day charges of complete days, then today is live
		const todayKey = dayOf(today);
		for (const merchantId of merchants) {
			const { run, cut } = await billing.check(merchantId);
			for (const c of run.charges) if (c.hour >= cut && (!only || c.productId === only)) add(c.productId, todayKey, c.amount);
		}
		const written = await repo
			.allLedgers()
			.aggregate([
				{ $match: { type: 'day_charge', day: { $gte: from }, ...(only ? { productId: only } : {}) } },
				{ $group: { _id: { productId: '$productId', day: '$day' }, amount: { $sum: '$amount' } } },
			])
			.toArray();
		for (const row of written) add(String(row._id.productId), String(row._id.day), -Number(row.amount));
		return [...out.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([productId, e]) => ({
				productId,
				websites: e.websites,
				earnedThisMonth: e.earnedThisMonth,
				days: Array.from({ length: DAYS_IN_SERIES }, (_, i) => {
					const day = dayOf(today - (DAYS_IN_SERIES - 1 - i) * 86_400_000);
					return { day, amount: e.days.get(day) ?? 0 };
				}),
			}));
	};

	return Object.freeze({
		add,
		remove,
		listForWebsite,
		statusChanged,
		acceptPrices,
		acceptFeatures,
		statusFor,
		/**
		 * A product on a website (any status), or null.
		 * @param {string} websiteId @param {string} productId
		 */
		productOnWebsite: async (websiteId, productId) => {
			const doc = await find(websiteId, productId);
			return doc
				? {
						websiteId,
						productId,
						merchantId: String(doc.merchantId),
						status: /** @type {'added' | 'removed'} */ (doc.status),
					}
				: null;
		},
		/**
		 * Products on a website now (not removed).
		 * @param {string} websiteId
		 */
		productsOnWebsite: async (websiteId) =>
			(await repo.allProducts().find({ websiteId, status: 'added' }).sort({ productId: 1 }).limit(100).toArray()).map(
				(doc) => ({ productId: String(doc.productId), merchantId: String(doc.merchantId) }),
			),
		/**
		 * The merchant's websites that have the product (not removed): the switcher of a merchant launch.
		 * @param {string} merchantId @param {string} productId
		 */
		merchantWebsitesWithProduct: async (merchantId, productId) =>
			(
				await repo
					.productsOf(merchantId)
					.find({ merchantId, productId, status: 'added' })
					.sort({ websiteId: 1 })
					.limit(1000)
					.toArray()
			).map((doc) => String(doc.websiteId)),
		/**
		 * `GET /v1/product/websites?cursor=` (row 5).
		 * @param {{ productId: string, cursor: string | null }} input
		 */
		websitesOfProduct: async (input) => {
			const { rows, cursor } = await websitesPage(input);
			return {
				items: rows.map(({ websiteId, domain, merchantId, merchantName, status }) => ({
					websiteId,
					domain,
					merchantId,
					merchantName,
					status,
				})),
				cursor,
			};
		},
		/**
		 * The product page's Websites tab: merchant, domain, features on, daily cost.
		 * @param {{ productId: string, cursor: string | null }} input
		 */
		productWebsitesView: async (input) => {
			const { rows, cursor } = await websitesPage(input);
			return { items: rows, cursor };
		},
		/**
		 * Numbers of one product (product page): websites using it, earned this month, 30-day series.
		 * @param {string} productId
		 */
		productNumbers: async (productId) =>
			/** @type {Awaited<ReturnType<typeof numbers>>[number]} */ ((await numbers(productId))[0]),
		/** Numbers of every product (admin Overview, Products list). */
		allProductNumbers: () => numbers(null),
	});
};
/** @typedef {ReturnType<typeof createProducts>} Products */
