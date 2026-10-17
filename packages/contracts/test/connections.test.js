import { describe, expect, it } from 'vitest';
import { WEBSITE_CONNECTIONS, databaseNameFor, isDatabaseName, isLinkScope, storageFolderFor } from '../src/index.js';

describe('the names of connections and links', () => {
	it('holds two connections per website', () => {
		expect(WEBSITE_CONNECTIONS).toEqual(['database', 'storage']);
	});
	it('gives each product its own database and folder', () => {
		expect(databaseNameFor('ecommerce')).toBe('ss_ecommerce');
		expect(databaseNameFor('my-product')).toBe('ss_my_product');
		expect(isDatabaseName(databaseNameFor('my-product'))).toBe(true);
		expect(storageFolderFor({ productId: 'chat', websiteId: 'web_1' })).toBe('chat/web_1/');
		expect(storageFolderFor({ prefix: 'shop/', productId: 'chat', websiteId: 'web_1' })).toBe('shop/chat/web_1/');
	});
	it('accepts dotted scopes only', () => {
		for (const scope of ['messages.send', 'orders.read.customer', 'keys.read', 'x'])
			expect(isLinkScope(scope), scope).toBe(true);
		for (const scope of ['', 'Messages.send', 'a..b', '.a', 'a.', 'a b', 'a/b', 'a.b.c.d.e', 5, null])
			expect(isLinkScope(scope), String(scope)).toBe(false);
	});
	it('refuses database names that MongoDB or the Portal would not take', () => {
		for (const name of ['', 'ss.chat', 'ss chat', '1abc', 'a$b', 'a'.repeat(64), 'ss/chat', null])
			expect(isDatabaseName(name), String(name)).toBe(false);
	});
});
