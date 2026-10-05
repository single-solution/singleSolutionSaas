import { describe, expect, it } from 'vitest';
import { NET_ERROR_CODES, isNetError, netError } from '../src/index.js';

describe('errors', () => {
	it('creates and recognises typed errors', () => {
		const error = netError('network', 'request_failed', 'the request failed', 'ECONNRESET');
		expect(error).toBeInstanceOf(Error);
		expect(error).toMatchObject({ name: 'NetError', code: 'network', reason: 'request_failed', detail: 'ECONNRESET' });
		expect(isNetError(error)).toBe(true);
		expect(isNetError(error, 'network')).toBe(true);
		expect(isNetError(error, 'timeout')).toBe(false);
		expect(isNetError(new Error('x'))).toBe(false);
		expect(isNetError({ name: 'NetError', code: 'timeout' })).toBe(false);
		expect(netError('timeout', 'deadline', 'slow')).not.toHaveProperty('detail');
		expect(NET_ERROR_CODES).toContain('ssrf_blocked');
	});
});
