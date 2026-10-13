// @vitest-environment jsdom
/* global document */
/**
 * Rich text in the widgets (PLAN 0.8.10 E3, SF-1): h2 headings and mailto: and tel: links are rebuilt like the server
 * keeps them; other schemes lose their address.
 */
import { describe, expect, it } from 'vitest';
import { richNodes } from '../ui/admin-fields.js';
import { richText } from '../ui/shop-common.js';

const HTML =
	'<h2>Contact</h2><p><a href="mailto:help@shop.example.com">Mail</a> <a href=" tel:+92 300 1234567 ">Call</a> <a href="javascript:alert(1)">x</a> <a href="https://shop.example.com/a">y</a></p>';

describe('rich text in the widgets (SF-1)', () => {
	it('rebuilds headings and contact links in the shop', () => {
		const box = document.createElement('div');
		box.append(richText(document, HTML));
		expect(box.querySelector('h2')?.textContent).toBe('Contact');
		expect([...box.querySelectorAll('a')].map((a) => [a.getAttribute('href'), a.getAttribute('rel')])).toEqual([
			['mailto:help@shop.example.com', null],
			['tel:+92 300 1234567', null],
			[null, null],
			['https://shop.example.com/a', 'noopener'],
		]);
	});

	it('rebuilds headings and contact links in the admin editor', () => {
		const box = document.createElement('div');
		box.append(...richNodes(document, HTML));
		expect(box.querySelector('h2')?.textContent).toBe('Contact');
		expect([...box.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
			'mailto:help@shop.example.com',
			'tel:+92 300 1234567',
			null,
			'https://shop.example.com/a',
		]);
	});
});
