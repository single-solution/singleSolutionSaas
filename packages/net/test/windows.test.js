import { describe, expect, it } from 'vitest';
import { createLocalWindows } from '../src/index.js';

describe('createLocalWindows', () => {
	it('counts hits per key in fixed windows, as the shared stores do', () => {
		const windows = createLocalWindows();
		expect(windows.hit('a', 1000, 10_100)).toEqual({ count: 1, resetAt: 11_000 });
		expect(windows.hit('a', 1000, 10_900)).toEqual({ count: 2, resetAt: 11_000 });
		expect(windows.hit('b', 1000, 10_900)).toEqual({ count: 1, resetAt: 11_000 });
		// the next window counts afresh
		expect(windows.hit('a', 1000, 11_000)).toEqual({ count: 1, resetAt: 12_000 });
	});

	it('holds a bounded number of counters: expired ones go first, then the least recently hit', () => {
		const windows = createLocalWindows({ maxEntries: 2 });
		windows.hit('old', 1000, 1000);
		windows.hit('a', 1000, 5000);
		windows.hit('b', 1000, 5000); // 'old' expired, so it is the one dropped
		expect(windows.hit('a', 1000, 5000).count).toBe(2);
		windows.hit('c', 1000, 5000); // over the bound with nothing expired: 'b' (hit least recently) is dropped
		expect(windows.hit('a', 1000, 5000).count).toBe(3);
		expect(windows.hit('b', 1000, 5000).count).toBe(1);
	});
});
