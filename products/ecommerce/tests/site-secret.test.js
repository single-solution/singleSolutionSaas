/**
 * The deal-lock secret sealed with `ENCRYPTION_KEY` (PLAN 0.4.8, RT-14): made sealed, opened with
 * `ENCRYPTION_KEY_PREVIOUS` while the key changes, moved by the Owner's Re-seal, replaced when no key opens it; and the
 * dashboard's Re-seal reaches it.
 */
import { createMemoryStore } from '@ss/app-kit';
import { describe, expect, it } from 'vitest';
import { createSealer, createSiteSecrets } from '../adapters/site-secret.js';
import { setup } from './helpers.js';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const ID = 'web_1|ecommerce|secret.locks';

describe('deal-lock secret (RT-14)', () => {
	it('is kept sealed, opens with the previous key while the key changes, and Re-seal moves it', async () => {
		const store = createMemoryStore({ now: () => 0 });
		const secret = await createSiteSecrets({ store, sealer: createSealer(A), now: () => 0 }).get('web_1');
		expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const stored = String((await store.get('settings', ID))?.value);
		expect(stored.startsWith('ss2.')).toBe(true);
		expect(stored).not.toContain(secret);

		const changing = createSiteSecrets({ store, sealer: createSealer(B, A), now: () => 0 });
		expect(await changing.get('web_1')).toBe(secret);
		expect(await changing.reseal()).toEqual({ resealed: 1, current: 0, unreadable: 0 });
		expect(await changing.reseal()).toEqual({ resealed: 0, current: 1, unreadable: 0 });
		expect(await createSiteSecrets({ store, sealer: createSealer(B), now: () => 0 }).get('web_1')).toBe(secret);
		expect(await createSiteSecrets({ store, sealer: createSealer('c'.repeat(32)), now: () => 0 }).reseal()).toEqual({
			resealed: 0,
			current: 0,
			unreadable: 1,
		});
	});

	it('replaces a secret no key opens (ENCRYPTION_KEY lost), and keeps the new one', async () => {
		const store = createMemoryStore({ now: () => 0 });
		const first = await createSiteSecrets({ store, sealer: createSealer(A), now: () => 0 }).get('web_1');
		const lost = createSiteSecrets({ store, sealer: createSealer(B), now: () => 0 });
		const fresh = await lost.get('web_1');
		expect(fresh).not.toBe(first);
		expect(await lost.get('web_1')).toBe(fresh);
		expect(await createSiteSecrets({ store, sealer: createSealer(B), now: () => 0 }).get('web_1')).toBe(fresh);
	});

	it('is re-sealed by the Owner from the dashboard', async () => {
		const shop = await setup();
		await shop.product.secrets.get(shop.websiteId);
		const answer = await shop.dashboard(await shop.adminSession(), 'POST', '/v1/dashboard/reseal');
		expect(answer.status).toBe(200);
		expect(answer.json).toMatchObject({ resealed: 0, unreadable: 0, failedWebsites: [] });
		expect(answer.json.current).toBeGreaterThanOrEqual(1);
	});
});
