/**
 * The Sisters Boutique mapping's output through the products' own checks (a dry run without servers): every record
 * read from the SB sample goes through the import check of its collection (Accounts `core/imports.js`, Ecommerce
 * `core/imports-catalog.js` and `core/imports-orders.js`, the pure part of each product's `import` feature), in import
 * order, with what an earlier file would have stored; every setting of the plan through the product's settings schema;
 * every list through the product's list check. The products are read from this repository (read only): a change of
 * their shapes shows here first.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatViolation, validateSettingValue } from '@ss/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { FEATURES, PENDING } from '../src/mappings/sisters-boutique/index.js';
import { readSisters } from './sb-helpers.js';

/** @type {Array<() => Promise<unknown>>} */
const cleanups = [];
afterEach(async () => {
	while (cleanups.length > 0) await /** @type {() => Promise<unknown>} */ (cleanups.pop())();
});

const PRODUCTS = path.resolve(import.meta.dirname, '../../../products');

/**
 * A module of a product, loaded at run time (the products are not this unit's dependencies, and their own checks type
 * them).
 * @param {string} file relative to `products/`
 * @returns {Promise<any>}
 */
const productModule = (file) => import(pathToFileURL(path.join(PRODUCTS, file)).href);
const accounts = await productModule('accounts/core/imports.js');
const { READY_ROLES } = await productModule('accounts/core/roles.js');
const { checkCouriers } = await productModule('ecommerce/core/couriers.js');
const { checkZones } = await productModule('ecommerce/core/delivery.js');
const { checkOrderFlow } = await productModule('ecommerce/core/flow.js');
const catalog = await productModule('ecommerce/core/imports-catalog.js');
const orders = await productModule('ecommerce/core/imports-orders.js');
const { checkRolePrices } = await productModule('ecommerce/core/role-pricing.js');
/** Shared settings groups (`<product>/adapters/product.js` `SHARED_SETTINGS`) of the features SB has on. */
const SHARED = Object.freeze({
	accounts: ['phone', 'profile'],
	ecommerce: [],
	notifications: ['delivery_log'],
	payments: [],
	growth: ['tags', 'pixels'],
});

/**
 * A product's settings sections: each feature's schema and each shared group's.
 * @param {string} product
 * @returns {Promise<Map<string, { properties: Record<string, any> }>>}
 */
const sectionsOf = async (product) => {
	const root = path.join(PRODUCTS, product);
	const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
	/** @type {Map<string, { properties: Record<string, any> }>} */
	const sections = new Map();
	for (const feature of manifest.features)
		sections.set(
			feature.key,
			feature.settings?.$ref ? JSON.parse(await readFile(path.join(root, feature.settings.$ref), 'utf8')) : feature.settings,
		);
	for (const file of (await readdir(path.join(root, 'schemas'))).filter((name) => name.endsWith('.shared.json')))
		sections.set(file.replace('.shared.json', ''), JSON.parse(await readFile(path.join(root, 'schemas', file), 'utf8')));
	return sections;
};

/**
 * Every refusal of a list of checks, by record (empty when all pass).
 * @param {Array<Record<string, any>>} records
 * @param {(record: Record<string, any>) => { ok: boolean, errors?: unknown[], value?: any }} check
 */
const refusals = (records, check) =>
	records.flatMap((record) => {
		const checked = check(record);
		return checked.ok ? [] : [{ id: record.id ?? record.key ?? record.customerId, errors: checked.errors }];
	});

/** @param {string[]} values @returns {string[]} */
const repeated = (values) => [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];

describe('the Sisters Boutique mapping through the products’ checks', () => {
	it('writes only settings the products have, with values they take, and every setting of each feature SB has on', async () => {
		const { settings } = await readSisters({ cleanups });
		for (const [product, part] of Object.entries(settings)) {
			const sections = await sectionsOf(product);
			/** @type {string[]} */
			const problems = [];
			for (const [full, value] of Object.entries(part.settings ?? {})) {
				const [section = '', key = ''] = full.split('.');
				const schema = sections.get(section);
				if (!schema?.properties?.[key]) {
					// written before the product has it: each is a PLAN item of the owner's go
					if (!PENDING[/** @type {keyof typeof PENDING} */ (`${product} ${full}`)])
						problems.push(`${product} ${full}: no such setting`);
					continue;
				}
				const checked = validateSettingValue(/** @type {any} */ (schema), key, value);
				if (!checked.ok) problems.push(`${product} ${full}: ${JSON.stringify(checked.problems)}`);
			}
			for (const section of [
				...FEATURES[/** @type {keyof typeof FEATURES} */ (product)],
				...SHARED[/** @type {keyof typeof SHARED} */ (product)],
			])
				for (const key of Object.keys(sections.get(section)?.properties ?? {}))
					if (!Object.hasOwn(part.settings ?? {}, `${section}.${key}`))
						problems.push(`${product} ${section}.${key}: not written`);
			for (const [field, value] of Object.entries(part.format ?? {})) {
				const why = formatViolation(/** @type {any} */ (field), value);
				if (why) problems.push(`${product} format ${field}: ${why}`);
			}
			expect(problems).toEqual([]);
		}
		const lists = /** @type {Record<string, unknown>} */ (settings.ecommerce?.lists);
		expect(checkOrderFlow(lists.order_flow)).toMatchObject({ ok: true });
		expect(checkRolePrices(lists.role_prices)).toMatchObject({ ok: true });
		expect(checkCouriers(lists.couriers)).toMatchObject({ ok: true });
		expect(checkZones(lists.delivery_zones)).toMatchObject({ ok: true });
	});

	it('gives Accounts roles, users, requests and copies its import checks take', async () => {
		const { records, settings } = await readSisters({ cleanups });
		const roles = await records('accounts.roles');
		expect(refusals(roles, accounts.checkImportedRole)).toEqual([]);
		const phoneFormat = {
			defaultCallingCode: String(settings.accounts?.settings?.['phone.defaultCallingCode']),
			trunkPrefix: String(settings.accounts?.settings?.['phone.trunkPrefix']),
		};
		const roleKeys = new Set([
			...READY_ROLES.map((/** @type {{ key: string }} */ role) => role.key),
			...roles.map((role) => String(role.key)),
		]);
		const users = await records('accounts.users');
		const rules = {
			roles: roleKeys,
			fields: [],
			phoneFormat,
			isPasswordHash: (/** @type {string} */ hash) => /^\$2[aby]\$\d{2}\$/.test(hash),
		};
		expect(refusals(users, (user) => accounts.checkImportedUser(user, rules))).toEqual([]);
		// Accounts keeps one user per email address and per phone
		const checked = users.map((user) => /** @type {any} */ (accounts.checkImportedUser(user, rules)).value);
		expect(repeated(checked.map((user) => user.phone).filter(Boolean))).toEqual([]);
		expect(repeated(checked.map((user) => user.email).filter(Boolean))).toEqual([]);
		const requests = await records('accounts.requests');
		expect(refusals(requests, (request) => accounts.checkImportedRequest(request, { roles: roleKeys, phoneFormat }))).toEqual(
			[],
		);
		const userIds = new Set(users.map((user) => user.id));
		expect(requests.filter((request) => request.userId && !userIds.has(request.userId))).toEqual([]);
		expect(refusals(await records('accounts.copies'), (copy) => accounts.checkImportedCopy(copy, 'web_sample'))).toEqual([]);
	});

	it('gives Ecommerce a catalog its import checks take, in import order', async () => {
		const { records } = await readSisters({ cleanups });
		/** @type {Set<string>} */
		const categoryIds = new Set();
		/** @type {Set<string>} */
		const brandIds = new Set();
		/** @type {Set<string>} */
		const sizeChartIds = new Set();
		/** @type {Map<string, { path: string[] }>} */
		const paths = new Map();
		const context = {
			now: Date.now(),
			features: new Set(FEATURES.ecommerce),
			categoryIds,
			brandIds,
			sizeChartIds,
			gradeKeys: new Set(),
			locationIds: new Set(),
			categories: paths,
		};
		/**
		 * The checks of one file, then what the file stores for the next ones.
		 * @param {string} target @param {(record: Record<string, any>) => any} check
		 * @param {(value: Record<string, any>) => void} [store]
		 */
		const file = async (target, check, store = () => {}) => {
			const list = await records(target);
			expect(refusals(list, check), target).toEqual([]);
			for (const record of list) store(check(record).value);
			return list;
		};
		await file(
			'ecommerce.size_charts',
			(record) => catalog.checkImportedSizeChart(record, context),
			(value) => sizeChartIds.add(value.id),
		);
		const categories = await file(
			'ecommerce.categories',
			(record) => catalog.checkImportedCategory(record, context),
			(value) => {
				categoryIds.add(value.id);
				paths.set(value.id, { path: value.path });
			},
		);
		const brands = await file(
			'ecommerce.brands',
			(record) => catalog.checkImportedBrand(record, context),
			(value) => brandIds.add(value.id),
		);
		/** @type {Map<string, any>} */
		const attributes = new Map();
		const attributeRecords = await file(
			'ecommerce.attributes',
			(record) => catalog.checkImportedAttribute(record, context),
			(value) => attributes.set(value.id, value),
		);
		const landings = await file('ecommerce.landings', (record) => catalog.checkImportedLanding(record, context));
		const rules = {
			variants: true,
			locations: false,
			grades: false,
			digital: false,
			bookings: false,
			gradeKeys: new Set(),
			locationIds: new Set(),
			categoryIds: context.categoryIds,
			categoryPaths: new Map([...paths].map(([id, entry]) => [id, entry.path])),
			brandIds: context.brandIds,
			attributes,
			newId: () => 'var_unused0000',
			sizeCharts: true,
			sizeChartIds: context.sizeChartIds,
			importing: true,
		};
		const products = await file('ecommerce.products', (record) => catalog.checkImportedProduct(record, { ...context, rules }));
		const deals = await file('ecommerce.deals', (record) => catalog.checkImportedDeal(record, context));
		// slugs are unique per website; an attribute's per category (E45)
		expect(repeated(categories.map((record) => record.slug))).toEqual([]);
		expect(repeated(brands.map((record) => record.slug))).toEqual([]);
		expect(repeated(attributeRecords.map((record) => `${record.categoryId ?? ''}|${record.slug}`))).toEqual([]);
		expect(repeated(products.map((record) => record.slug))).toEqual([]);
		expect(repeated(deals.map((record) => record.slug))).toEqual([]);
		expect(repeated(landings.map((record) => `${record.categoryId}|${record.brandId}`))).toEqual([]);
		expect(
			repeated(products.flatMap((record) => record.variants.map((/** @type {{ id: string }} */ variant) => variant.id))),
		).toEqual([]);
		// the products a deal's scope names exist
		const productIds = new Set(products.map((record) => record.id));
		expect(deals.flatMap((deal) => catalog.offerProductIds(deal)).filter((id) => !productIds.has(id))).toEqual([]);
	});

	it('gives Ecommerce customers, orders and loyalty its import checks take, adding up', async () => {
		const { records, settings } = await readSisters({ cleanups });
		const plan = /** @type {Record<string, unknown>} */ (settings.ecommerce?.settings);
		const flow = checkOrderFlow(settings.ecommerce?.lists?.order_flow);
		expect(flow.ok).toBe(true);
		const rules = orders.importRules({
			flow: /** @type {any} */ (flow).value,
			checkout: Object.fromEntries(
				Object.entries(plan)
					.filter(([key]) => key.startsWith('checkout.'))
					.map(([key, value]) => [key.slice('checkout.'.length), value]),
			),
			catalog: { currency: plan['catalog.currency'] },
			country: 'PK',
			now: Date.now(),
		});
		const customers = await records('ecommerce.customers');
		expect(refusals(customers, (record) => orders.checkImportedCustomer(record, rules))).toEqual([]);
		expect(
			repeated(customers.map((record) => /** @type {any} */ (orders.checkImportedCustomer(record, rules)).value.phone)),
		).toEqual([]);
		const list = await records('ecommerce.orders');
		expect(refusals(list, (record) => orders.checkImportedOrder(record, rules))).toEqual([]);
		expect(repeated(list.map((record) => record.number))).toEqual([]);
		const customerIds = new Set(customers.map((record) => record.id));
		expect(list.filter((record) => !customerIds.has(record.customer.customerId))).toEqual([]);
		const accounts = await records('ecommerce.loyalty');
		expect(refusals(accounts, (record) => orders.checkImportedLoyalty(record, rules))).toEqual([]);
		// the balance Ecommerce derives is SB's stored one
		expect(accounts.map((record) => /** @type {any} */ (orders.checkImportedLoyalty(record, rules)).value.balance)).toEqual([
			307, 30,
		]);
	});
});
