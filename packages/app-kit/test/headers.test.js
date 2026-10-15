import { describe, expect, it } from 'vitest';
import { dashboardHeaders } from '../src/http/headers.js';

describe('dashboardHeaders (next.config.js)', () => {
	it('the dashboard page refuses every frame and gets the static security headers', () => {
		const rules = dashboardHeaders();
		expect(rules.map((rule) => rule.source)).toEqual(['/dashboard/:path*']);
		const headers = Object.fromEntries((rules[0]?.headers ?? []).map(({ key, value }) => [key.toLowerCase(), value]));
		expect(headers['x-frame-options']).toBe('DENY');
		expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
		// no source list: the page's own scripts, styles and the Portal's logo still load
		expect(headers['content-security-policy']).not.toMatch(/default-src|script-src|style-src|img-src/);
		expect(headers).toMatchObject({
			'strict-transport-security': expect.stringContaining('max-age='),
			'x-content-type-options': 'nosniff',
			'referrer-policy': 'strict-origin-when-cross-origin',
			'permissions-policy': expect.stringContaining('camera=()'),
			'cross-origin-opener-policy': 'same-origin',
		});
		// each call answers its own copy
		rules[0]?.headers.splice(0);
		expect(dashboardHeaders()[0]?.headers.length).toBe(Object.keys(headers).length);
	});
});
