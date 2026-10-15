/**
 * Page types (C6): the merchant's own kinds of pages { key, name, path, nudge }, seeded with the four shop ones; a page
 * gets its type from setPage's kind when known, else from the first matching path pattern, else other.
 */
import { describe, expect, it } from 'vitest';
import { pageContext } from '../core/conversation.js';
import { PAGE_TYPE_SEED, checkPageTypes, pageTypeOf } from '../core/pages.js';
import { buildSystemPrompt } from '../core/prompt.js';

const TYPES = [
	...PAGE_TYPE_SEED,
	{ key: 'menu', name: 'Menu', path: '/menu/**', nudge: 'Hungry? Ask about {product}.' },
	{ key: 'room', name: 'Room page', path: '/rooms/*', nudge: '' },
];

describe('page types (C6)', () => {
	it('seeds the four shop page types, without paths or own nudges', () => {
		expect(PAGE_TYPE_SEED.map((type) => type.key)).toEqual(['product', 'category', 'deals', 'cart']);
		expect(PAGE_TYPE_SEED.every((type) => type.path === '' && type.nudge === '')).toBe(true);
		expect(checkPageTypes([...PAGE_TYPE_SEED])).toEqual({ ok: true, value: PAGE_TYPE_SEED });
	});

	it('checks keys, names, path patterns and nudges', () => {
		expect(checkPageTypes([{ key: 'menu', name: ' Menu ', path: ' /menu/** ', nudge: ' Hi ' }])).toEqual({
			ok: true,
			value: [{ key: 'menu', name: 'Menu', path: '/menu/**', nudge: 'Hi' }],
		});
		expect(checkPageTypes([{ key: 'menu', name: 'Menu' }])).toEqual({
			ok: true,
			value: [{ key: 'menu', name: 'Menu', path: '', nudge: '' }],
		});
		expect(checkPageTypes([{ key: 'other', name: 'Other' }]).ok).toBe(false);
		expect(checkPageTypes([{ key: 'Menu', name: 'Menu' }]).ok).toBe(false);
		expect(checkPageTypes([{ key: 'menu', name: '' }]).ok).toBe(false);
		expect(checkPageTypes([{ key: 'menu', name: 'Menu', path: 'menu' }]).ok).toBe(false);
		expect(checkPageTypes([{ key: 'menu', name: 'Menu', nudge: 'x'.repeat(301) }]).ok).toBe(false);
		expect(
			checkPageTypes([
				{ key: 'menu', name: 'A' },
				{ key: 'menu', name: 'B' },
			]),
		).toEqual({ ok: false, errors: ['Page type 2: a unique key (lower-case letters, digits, - or _; not other).'] });
		expect(checkPageTypes(Array.from({ length: 31 }, (_, i) => ({ key: `t${i}`, name: 'T' }))).ok).toBe(false);
	});

	it('types a page by its named kind, else by its path, else other', () => {
		expect(pageTypeOf(TYPES, 'product', '/anything')).toBe('product');
		expect(pageTypeOf(TYPES, 'menu', '/')).toBe('menu');
		expect(pageTypeOf(TYPES, undefined, '/menu/drinks/tea')).toBe('menu');
		expect(pageTypeOf(TYPES, 'unknown', '/rooms/12')).toBe('room');
		expect(pageTypeOf(TYPES, 'unknown', '/rooms/12/photos')).toBe('other');
		expect(pageTypeOf(TYPES, 'other', '/menu/x')).toBe('menu');
		expect(pageTypeOf([], 'product', '/p')).toBe('other');
	});

	it('the server keeps a page type the website has, or finds it by the address', () => {
		/** @param {string | undefined} kind @param {string} [url] */
		const page = (kind, url = 'https://shop.example.com/x') => pageContext({ url, title: 'T', kind }, TYPES);
		expect(page('menu')?.kind).toBe('menu');
		expect(page('nope')?.kind).toBe('other');
		expect(page(undefined, 'https://shop.example.com/rooms/5?x=1')?.kind).toBe('room');
		expect(pageContext({ kind: 'menu' }, [])?.kind).toBe('other');
	});

	it('the AI is told the page type by its name', () => {
		/** @param {{ url: string, title: string, kind: string, productName: string | null }} page */
		const prompt = (page) =>
			buildSystemPrompt({
				botName: 'Bo',
				business: { name: 'Shop' },
				instructions: null,
				dontKnow: 'Say so.',
				language: null,
				passages: [],
				visitor: { signedIn: false, name: null },
				page,
				handoff: false,
			});
		expect(prompt({ url: '', title: 'Teas', kind: 'Menu', productName: 'Green tea' })).toContain(
			'The visitor is viewing the page of Green tea titled “Teas” (page type: Menu).',
		);
		expect(prompt({ url: '', title: '', kind: 'other', productName: null })).toContain('The visitor is viewing a page.');
	});
});
