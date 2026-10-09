/**
 * The App Router stand-in of the console tests: views navigate with `useRouter()` (searches, filters, a new or removed
 * item); here the navigations are recorded, not performed. Test files mock `next/navigation.js` with it:
 *
 *   vi.mock('next/navigation.js', async (importOriginal) => ({
 *     ...(await importOriginal()),
 *     useRouter: () => testRouter,
 *   }));
 * @module
 */
import { vi } from 'vitest';

export const testRouter = {
	push: vi.fn(),
	replace: vi.fn(),
	refresh: vi.fn(),
	prefetch: vi.fn(),
	back: vi.fn(),
	forward: vi.fn(),
};
