import { describe, expect, it } from 'vitest';
import { staticSecurityHeaders } from '../src/index.js';

describe('staticSecurityHeaders', () => {
	it('is the static set, as next.config.js takes it, a fresh copy each call', () => {
		const headers = staticSecurityHeaders();
		expect(headers.map(({ key }) => key)).toEqual([
			'Strict-Transport-Security',
			'X-Content-Type-Options',
			'X-Frame-Options',
			'Referrer-Policy',
			'Permissions-Policy',
			'Cross-Origin-Opener-Policy',
			'X-DNS-Prefetch-Control',
			'X-Permitted-Cross-Domain-Policies',
		]);
		expect(headers).toContainEqual({ key: 'X-Frame-Options', value: 'DENY' });
		expect(headers).toContainEqual({ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' });
		expect(headers.find(({ key }) => key === 'Permissions-Policy')?.value).toMatch(
			/^accelerometer=\(\), .*browsing-topics=\(\)$/,
		);
		headers[0] = { key: 'X', value: 'y' };
		expect(staticSecurityHeaders()[0]?.key).toBe('Strict-Transport-Security');
	});
});
