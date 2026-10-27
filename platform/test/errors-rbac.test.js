import { describe, expect, it } from 'vitest';
import { ADMIN_ROLES } from '@ss/contracts';
import { ALL_PERMISSIONS, MERCHANT_PERMISSIONS, PERMISSIONS, ROLE_PERMISSIONS, can, permissionsFor } from '../src/infra/rbac.js';
import { MERCHANT, MERCHANT_2, WEBSITE } from './helpers.js';
import { isPlatformError, platformError } from '../src/infra/errors.js';

// the logger is @ss/net's (tested there)
describe('platform errors', () => {
	it('platform errors carry codes', () => {
		const error = platformError('x_code', 'message', { a: 1 });
		expect(isPlatformError(error)).toBe(true);
		expect(isPlatformError(error, 'x_code')).toBe(true);
		expect(isPlatformError(error, 'other')).toBe(false);
		expect(isPlatformError(new Error('x'))).toBe(false);
		expect(error.details).toEqual({ a: 1 });
	});
});

/**
 * The rights table of PLAN 0.2 as data: for each permission, who may (`own` = a merchant on its own records).
 * @type {Record<string, { owner: boolean, support: boolean, finance: boolean, merchant: boolean }>}
 */
const TABLE = {
	'overview.read': { owner: true, support: true, finance: true, merchant: true },
	'activity.read': { owner: true, support: true, finance: true, merchant: true },
	'merchants.read': { owner: true, support: true, finance: true, merchant: true },
	'merchants.write': { owner: true, support: true, finance: false, merchant: false },
	'merchants.suspend': { owner: true, support: true, finance: false, merchant: false },
	'merchants.setup_link': { owner: true, support: true, finance: false, merchant: false },
	'two_step.turn_off': { owner: true, support: false, finance: false, merchant: false },
	'merchants.delete': { owner: true, support: false, finance: false, merchant: false },
	'websites.read': { owner: true, support: true, finance: true, merchant: true },
	'websites.write': { owner: true, support: true, finance: false, merchant: false },
	'products_on_websites.read': { owner: true, support: true, finance: true, merchant: true },
	'products_on_websites.write': { owner: true, support: true, finance: false, merchant: true },
	'tokens.manage': { owner: true, support: true, finance: false, merchant: true },
	'tokens.reveal': { owner: true, support: false, finance: false, merchant: true },
	'dashboards.open': { owner: true, support: true, finance: false, merchant: true },
	'products.manage': { owner: true, support: false, finance: false, merchant: false },
	'products.read': { owner: true, support: true, finance: false, merchant: true },
	'credits.add': { owner: true, support: false, finance: true, merchant: false },
	'billing.read': { owner: true, support: true, finance: true, merchant: true },
	'admins.manage': { owner: true, support: false, finance: false, merchant: false },
	'portal_settings.write': { owner: true, support: false, finance: false, merchant: false },
	'website_settings.read': { owner: true, support: true, finance: false, merchant: true },
	'website_settings.write': { owner: true, support: true, finance: false, merchant: true },
	'connections.read': { owner: true, support: true, finance: false, merchant: true },
	'connections.write': { owner: true, support: true, finance: false, merchant: true },
};

describe('rbac (PLAN 0.2 rights table)', () => {
	it('names every permission once and covers the whole table', () => {
		expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
		expect([...ALL_PERMISSIONS].sort()).toEqual(Object.keys(TABLE).sort());
		expect(Object.keys(PERMISSIONS)).toHaveLength(ALL_PERMISSIONS.length);
		expect(ADMIN_ROLES).toEqual(['owner', 'support', 'finance']);
		for (const role of ADMIN_ROLES) for (const p of ROLE_PERMISSIONS[role]) expect(ALL_PERMISSIONS).toContain(p);
		for (const p of MERCHANT_PERMISSIONS) expect(ALL_PERMISSIONS).toContain(p);
	});

	it('grants each admin role exactly its column', () => {
		for (const role of ADMIN_ROLES) {
			const actor = /** @type {const} */ ({ type: 'admin', id: `adm_${role}`, role });
			for (const [permission, row] of Object.entries(TABLE)) {
				expect([role, permission, can(actor, permission, { merchantId: MERCHANT })]).toEqual([role, permission, row[role]]);
				expect(can(actor, permission)).toBe(row[role]);
			}
		}
	});

	it('grants a merchant its column on its own records only', () => {
		const merchant = /** @type {const} */ ({ type: 'merchant', id: MERCHANT, merchantId: MERCHANT });
		for (const [permission, row] of Object.entries(TABLE)) {
			expect([permission, can(merchant, permission, { merchantId: MERCHANT, websiteId: WEBSITE })]).toEqual([
				permission,
				row.merchant,
			]);
			// an unscoped check is the merchant's own
			expect(can(merchant, permission)).toBe(row.merchant);
			// another merchant's records: never
			expect(can(merchant, permission, { merchantId: MERCHANT_2 })).toBe(false);
		}
		expect(can({ type: 'merchant', id: MERCHANT }, 'websites.read')).toBe(false);
	});

	it('an admin without a known role, products and nobody get nothing; the system gets everything', () => {
		expect(can({ type: 'admin', id: 'adm_x' }, 'websites.read')).toBe(false);
		expect(can({ type: 'admin', id: 'adm_x', role: /** @type {any} */ ('auditor') }, 'websites.read')).toBe(false);
		expect(can({ type: 'product', id: 'notes' }, 'websites.read')).toBe(false);
		expect(can(null, 'websites.read')).toBe(false);
		expect(can({ type: 'system', id: 'job' }, 'admins.manage')).toBe(true);
		expect(can({ type: 'admin', id: 'adm_o', role: 'owner' }, '')).toBe(false);
		expect(permissionsFor(null)).toEqual([]);
	});
});
