import { describe, expect, it } from 'vitest';

describe('next.config.js', () => {
	it('the dashboard page refuses every frame (PLAN 0.4.3)', async () => {
		// loaded at run time, as Next.js loads it (its types come with `next`, which the checks do not need)
		const { default: config } = await import(new URL('../next.config.js', import.meta.url).href);
		/** @type {Array<{ source: string, headers: Array<{ key: string, value: string }> }>} */
		const rules = await config.headers();
		const dashboard = rules.find((rule) => rule.source === '/dashboard/:path*');
		const headers = Object.fromEntries((dashboard?.headers ?? []).map(({ key, value }) => [key.toLowerCase(), value]));
		expect(headers['x-frame-options']).toBe('DENY');
		expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
		expect(headers['x-content-type-options']).toBe('nosniff');
	});
});
