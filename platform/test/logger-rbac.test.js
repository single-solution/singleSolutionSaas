import { describe, expect, it, vi } from 'vitest';
import { createLogger, isSensitiveKey, noopLogger, redact } from '../src/infra/logger.js';
import {
	ADMIN_ROLES,
	ALL_PERMISSIONS,
	MERCHANT_PERMISSIONS,
	PRODUCT_ENFORCED_ROWS,
	PERMISSIONS,
	ROLE_PERMISSIONS,
	can,
	permissionsFor,
	validRole,
	websitesVisible,
} from '../src/infra/rbac.js';
import { MERCHANT, MERCHANT_2, WEBSITE } from './helpers.js';
import { isPlatformError, platformError } from '../src/infra/errors.js';

describe('logger', () => {
	it('writes JSON lines with level threshold, child fields and redaction', () => {
		/** @type {string[]} */
		const lines = [];
		const log = createLogger({ level: 'info', write: (line) => lines.push(line), now: () => 0, fields: { service: 'portal' } });
		log.debug('hidden');
		log.info('hello', { password: 'p', nested: { apiKey: 'k', ok: 1 }, MONGODB_URI: 'mongodb://u:p@h/db' });
		log.child({ requestId: 'r1' }).warn('child', { authorization: 'Bearer x' });
		log.error('boom', { error: Object.assign(new Error('bad'), { code: 'E1' }) });
		expect(lines).toHaveLength(3);
		const [first, second, third] = lines.map((line) => JSON.parse(line));
		expect(first).toMatchObject({
			level: 'info',
			msg: 'hello',
			service: 'portal',
			password: '[redacted]',
			nested: { apiKey: '[redacted]', ok: 1 },
			MONGODB_URI: '[redacted]',
		});
		expect(first.time).toBe('1970-01-01T00:00:00.000Z');
		expect(second).toMatchObject({ requestId: 'r1', authorization: '[redacted]' });
		expect(third.error).toEqual({ name: 'Error', message: 'bad', code: 'E1' });
	});

	it('redacts secret-looking values and credentials in URLs', () => {
		expect(redact('eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2ln')).toBe('[redacted]');
		expect(redact('sk_live_abc')).toBe('sk_live_abc');
		expect(redact('mongodb+srv://user:pass@cluster/db')).toBe('mongodb+srv://[redacted]@cluster/db');
		expect(redact('https://example.com/path')).toBe('https://example.com/path');
		expect(redact([{ token: 'x' }, new Date(0)])).toEqual([{ token: '[redacted]' }, '1970-01-01T00:00:00.000Z']);
		/** @type {any} */
		let deep = { v: 1 };
		for (let i = 0; i < 12; i += 1) deep = { deep };
		expect(JSON.stringify(redact(deep))).toContain('[depth]');
		expect(redact(new Error('plain'))).toEqual({ name: 'Error', message: 'plain' });
	});

	it('classifies sensitive keys', () => {
		for (const key of [
			'secret',
			'clientSecret',
			'session_token',
			'Password',
			'cookie',
			'api-key',
			'privateJwk',
			'd',
			'jwksUri',
			'kek',
			'sealed',
			'credentials',
		]) {
			expect(isSensitiveKey(key)).toBe(true);
		}
		for (const key of ['idempotencyKey', 'websiteId', 'portalUrl', 'security', 'count'])
			expect(isSensitiveKey(key)).toBe(false);
	});

	it('defaults to stdout and ignores unknown levels; noop logger is inert', () => {
		const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		createLogger({ level: 'nope' }).info('x');
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
		noopLogger.info('x');
		noopLogger.debug('x');
		noopLogger.warn('x');
		noopLogger.error('x');
		expect(noopLogger.child({})).toBe(noopLogger);
	});

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
	'products_on_websites.write': { owner: true, support: true, finance: false, merchant: false },
	'tokens.manage': { owner: true, support: true, finance: false, merchant: true },
	'dashboards.open': { owner: true, support: true, finance: false, merchant: true },
	'products.manage': { owner: true, support: false, finance: false, merchant: false },
	'products.read': { owner: true, support: true, finance: false, merchant: false },
	'credits.add': { owner: true, support: false, finance: true, merchant: false },
	'billing.read': { owner: true, support: true, finance: true, merchant: true },
	'admins.manage': { owner: true, support: false, finance: false, merchant: false },
	'portal_settings.write': { owner: true, support: false, finance: false, merchant: false },
};

describe('rbac (PLAN 0.2 rights table)', () => {
	it('names every permission once and covers the whole table', () => {
		expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
		expect([...ALL_PERMISSIONS].sort()).toEqual(Object.keys(TABLE).sort());
		expect(Object.keys(PERMISSIONS)).toHaveLength(ALL_PERMISSIONS.length);
		expect(ADMIN_ROLES).toEqual(['owner', 'support', 'finance']);
		expect(PRODUCT_ENFORCED_ROWS).toHaveLength(3);
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
		expect(can({ type: 'product', id: 'notes', permissions: ['websites.read'] }, 'websites.read')).toBe(true);
		expect(can(null, 'websites.read')).toBe(false);
		expect(can({ type: 'system', id: 'job' }, 'admins.manage')).toBe(true);
		expect(can({ type: 'admin', id: 'adm_o', role: 'owner' }, '')).toBe(false);
		expect(permissionsFor(null)).toEqual([]);
	});

	it('lists visible websites: all for admins with the right, own for merchants, none otherwise', () => {
		expect(websitesVisible({ type: 'admin', id: 'a', role: 'finance' }, 'websites.read')).toBe('all');
		expect(websitesVisible({ type: 'admin', id: 'a', role: 'finance' }, 'tokens.manage')).toBe('none');
		expect(websitesVisible({ type: 'merchant', id: MERCHANT, merchantId: MERCHANT }, 'websites.read')).toBe('own');
		expect(websitesVisible({ type: 'merchant', id: MERCHANT, merchantId: MERCHANT }, 'websites.write')).toBe('none');
		expect(websitesVisible({ type: 'system', id: 's' }, 'x')).toBe('all');
		expect(websitesVisible({ type: 'product', id: 'p' }, 'websites.read')).toBe('none');
		expect(websitesVisible(null, 'websites.read')).toBe('none');
		expect(validRole('owner')).toBe(true);
		expect(validRole('admin')).toBe(false);
	});
});
