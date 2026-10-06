import { describe, expect, it, vi } from 'vitest';
import { createLogger, isSensitiveKey, noopLogger, redact } from '../src/infra/logger.js';
import {
	ALL_PERMISSIONS,
	MERCHANT_PERMISSIONS,
	MERCHANT_ROLES,
	STAFF_ROLE_BUNDLES,
	can,
	permissionMatches,
	permissionsFor,
	validRoles,
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
		expect(redact('sk_live_abc')).toBe('[redacted]');
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

describe('rbac', () => {
	const staff = (/** @type {string[]} */ roles) => /** @type {const} */ ({ type: 'staff', id: 'stf_1', roles });
	const member = (/** @type {Partial<import('../src/infra/rbac.js').Actor>} */ extra) => ({
		type: /** @type {const} */ ('merchant_user'),
		id: 'usr_1',
		merchantId: MERCHANT,
		roles: [],
		...extra,
	});

	it('matches permission patterns', () => {
		expect(permissionMatches('*', 'anything.at.all')).toBe(true);
		expect(permissionMatches('websites.*', 'websites.write')).toBe(true);
		expect(permissionMatches('websites.*', 'websitesx.write')).toBe(false);
		expect(permissionMatches('websites.read', 'websites.write')).toBe(false);
	});

	it('platform roles', () => {
		expect(can(staff(['superadmin']), 'platform.staff.manage')).toBe(true);
		expect(can(staff(['admin']), 'platform.staff.manage')).toBe(false);
		expect(can(staff(['admin']), 'platform.credits.adjust')).toBe(true);
		expect(can(staff(['admin']), 'websites.write', { merchantId: MERCHANT })).toBe(true);
		expect(can(staff(['support']), 'websites.read', { merchantId: MERCHANT })).toBe(true);
		expect(can(staff(['support']), 'websites.write', { merchantId: MERCHANT })).toBe(false);
		expect(can(staff(['support']), 'platform.impersonate')).toBe(false);
		expect(can(staff(['finance']), 'platform.credits.adjust')).toBe(true);
		expect(can(staff(['finance']), 'config.write', { merchantId: MERCHANT })).toBe(false);
		expect(can(staff(['nonexistent']), 'merchant.read')).toBe(false);
		expect(can(staff([]), 'merchant.read')).toBe(false);
		expect(can(staff(['admin']), '')).toBe(false);
	});

	it('merchant roles are confined to the own merchant', () => {
		const owner = member({ roles: ['owner'] });
		expect(can(owner, 'merchant.delete', { merchantId: MERCHANT })).toBe(true);
		expect(can(owner, 'merchant.delete')).toBe(true); // unscoped → own merchant
		expect(can(owner, 'websites.read', { merchantId: MERCHANT_2 })).toBe(false);
		expect(can(owner, 'platform.merchants.read')).toBe(false);
		expect(can(member({ roles: ['admin'] }), 'merchant.delete', { merchantId: MERCHANT })).toBe(false);
		expect(can(member({ roles: ['admin'] }), 'merchant.team.manage', { merchantId: MERCHANT })).toBe(true);
		expect(can(member({ roles: ['billing'] }), 'billing.manage', { merchantId: MERCHANT })).toBe(true);
		expect(can(member({ roles: ['billing'] }), 'config.write', { merchantId: MERCHANT })).toBe(false);
		expect(can(member({ roles: ['developer'] }), 'keys.manage', { merchantId: MERCHANT })).toBe(true);
		expect(can(member({ roles: ['developer'] }), 'billing.manage', { merchantId: MERCHANT })).toBe(false);
		expect(can(member({ roles: ['editor'] }), 'config.write', { merchantId: MERCHANT, websiteId: WEBSITE })).toBe(true);
		expect(can(member({ roles: ['editor'] }), 'websites.delete', { merchantId: MERCHANT })).toBe(false);
		expect(can({ type: 'merchant_user', id: 'u', roles: ['owner'] }, 'merchant.read')).toBe(false); // no merchantId
		// explicit platform permissions are never honoured for merchant users
		expect(can(member({ permissions: ['*', 'platform.staff.manage'] }), 'platform.staff.manage')).toBe(false);
	});

	it('website-scoped grants apply to that website only', () => {
		const editor = member({ grants: [{ websiteId: WEBSITE, roles: ['editor'] }] });
		expect(can(editor, 'config.write', { merchantId: MERCHANT, websiteId: WEBSITE })).toBe(true);
		expect(can(editor, 'config.write', { merchantId: MERCHANT, websiteId: 'web_other' })).toBe(false);
		expect(can(editor, 'config.write', { merchantId: MERCHANT })).toBe(false); // merchant-level operation
		expect(can(editor, 'config.write', { merchantId: MERCHANT_2, websiteId: WEBSITE })).toBe(false);
		expect(websitesVisible(editor, 'config.write')).toEqual([WEBSITE]);
		expect(websitesVisible(member({ roles: ['owner'] }), 'config.write')).toBe('all');
		expect(websitesVisible(staff(['admin']), 'websites.read')).toBe('all');
		expect(websitesVisible(staff(['finance']), 'websites.write')).toEqual([]);
		expect(websitesVisible({ type: 'system', id: 'cron' }, 'x')).toBe('all');
		expect(websitesVisible({ type: 'product', id: 'app' }, 'x')).toEqual([]);
		expect(websitesVisible(null, 'x')).toEqual([]);
	});

	it('products, website keys and system actors', () => {
		expect(can({ type: 'product', id: 'app_1' }, 'websites.read')).toBe(false);
		expect(can({ type: 'product', id: 'app_1', permissions: ['websites.read'] }, 'websites.read')).toBe(true);
		expect(can({ type: 'website', id: 'key_1', merchantId: MERCHANT }, 'config.read')).toBe(false);
		expect(can({ type: 'system', id: 'cron' }, 'platform.staff.manage')).toBe(true);
		expect(can(null, 'merchant.read')).toBe(false);
		expect(permissionsFor(undefined)).toEqual([]);
	});

	it('bundles only reference known permissions; validRoles', () => {
		for (const bundle of [...Object.values(STAFF_ROLE_BUNDLES), ...Object.values(MERCHANT_ROLES)]) {
			for (const p of bundle) if (p !== '*') expect(ALL_PERMISSIONS).toContain(p);
		}
		for (const p of MERCHANT_ROLES.owner) expect(MERCHANT_PERMISSIONS).toContain(p);
		expect(validRoles('platform', ['admin'])).toBe(true);
		expect(validRoles('platform', ['owner'])).toBe(false);
		expect(validRoles('merchant', ['owner', 'editor'])).toBe(true);
		expect(validRoles('merchant', [])).toBe(false);
		expect(validRoles('merchant', 'owner')).toBe(false);
	});
});
