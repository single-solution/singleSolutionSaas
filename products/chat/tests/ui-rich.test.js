// @vitest-environment jsdom
/* global document */
/**
 * Rich answers in the widgets (PLAN 0.8.10 C2): the DOM built from a markdown message. `innerHTML` is only read here, to
 * compare what was built.
 */
import { describe, expect, it } from 'vitest';
import { messageBody } from '../ui/rich.js';

/** @param {string} text @param {string} [author] */
const rich = (text, author = 'ai') => messageBody(document, { author, text, format: 'markdown' });

/** The tags and attributes the renderer may build; anything else came from the message. */
const TAGS = new Set(['DIV', 'P', 'BR', 'STRONG', 'EM', 'CODE', 'PRE', 'A', 'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY']);
['TR', 'TH', 'TD'].forEach((tag) => TAGS.add(tag));
const ATTRIBUTES = new Set(['class', 'href', 'target', 'rel']);

/** Every element and attribute in `node` is one the renderer builds. @param {Element} node */
const onlyOwnMarkup = (node) => {
	for (const each of [node, ...node.querySelectorAll('*')]) {
		expect(TAGS.has(each.tagName), each.tagName).toBe(true);
		for (const name of each.getAttributeNames()) expect(ATTRIBUTES.has(name), name).toBe(true);
	}
};

describe('rich answers', () => {
	it('shows bold, italic and code; line breaks stay inside a paragraph', () => {
		const body = rich('**Big** *deal* _here_ __too__ and `a*b*` code\nnext line\n\n# Title');
		expect(body.className).toBe('rich');
		expect(body.innerHTML).toBe(
			'<p><strong>Big</strong> <em>deal</em> <em>here</em> <strong>too</strong> and <code>a*b*</code> code<br>next line</p>' +
				'<p><strong>Title</strong></p>',
		);
	});

	it('shows bullet and numbered lists and code blocks', () => {
		expect(rich('Choose:\n- **Red**\n- Blue\n\n1. one\n2. two').innerHTML).toBe(
			'<p>Choose:</p><ul><li><strong>Red</strong></li><li>Blue</li></ul><ol><li>one</li><li>two</li></ol>',
		);
		expect(rich('```\n<b>x</b>\n  y\n```').innerHTML).toBe('<pre><code>&lt;b&gt;x&lt;/b&gt;\n  y</code></pre>');
	});

	it('shows a table with a head inside a box that scrolls', () => {
		const body = rich('| Item | **Price** |\n| --- | ---: |\n| Phone | 10 |\n| Case | `5` |');
		expect(body.innerHTML).toBe(
			'<div class="table"><table><thead><tr><th>Item</th><th><strong>Price</strong></th></tr></thead>' +
				'<tbody><tr><td>Phone</td><td>10</td></tr><tr><td>Case</td><td><code>5</code></td></tr></tbody></table></div>',
		);
	});

	it('opens safe links in a new tab without opener, referrer or endorsement', () => {
		const body = rich('[Shop](https://shop.example.com/p?a=1) [here](/products/x) [mail](mailto:a@b.co) [call](tel:+441234)');
		const links = [...body.querySelectorAll('a')];
		expect(links.map((link) => link.getAttribute('href'))).toEqual([
			'https://shop.example.com/p?a=1',
			'/products/x',
			'mailto:a@b.co',
			'tel:+441234',
		]);
		for (const link of links) {
			expect(link.getAttribute('target')).toBe('_blank');
			expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow');
		}
		expect(rich('[**Sale**](https://shop.example.com)').querySelector('a strong')?.textContent).toBe('Sale');
	});

	it('keeps other links as their label text: javascript, data, protocol-relative, with a password', () => {
		const body = rich(
			'[click](javascript:alert%281%29) [a](JavaScript:void0) [b](data:text/html;base64,PHNjcmlwdD4=) ' +
				'[c](//evil.example) [d](vbscript:x) [e](https://u:p@evil.example) [f](file:///etc/passwd) [g]( javascript:x)',
		);
		expect(body.querySelector('a')).toBeNull();
		expect(body.textContent).toBe('click a b c d e f [g]( javascript:x)');
		onlyOwnMarkup(body);
	});

	it('shows HTML in a message as text, with no element, attribute or style of its own', () => {
		const text =
			'<img src=x onerror=alert(1)> <script>alert(1)</script> **<b style="color:red">hi</b>**\n' +
			'- <a href="javascript:alert(1)">x</a>\n\n| <iframe> | <style>p{}</style> |\n|---|---|\n| <svg onload=x> | &lt; |';
		const body = rich(text);
		onlyOwnMarkup(body);
		expect(body.querySelectorAll('img, script, b, iframe, style, svg, [style], [onerror], [onload]')).toHaveLength(0);
		expect(body.textContent).toContain('<img src=x onerror=alert(1)> <script>alert(1)</script> <b style="color:red">hi</b>');
		expect(body.querySelector('li')?.textContent).toBe('<a href="javascript:alert(1)">x</a>');
		expect(body.querySelector('td:last-child')?.textContent).toBe('&lt;');
	});

	it('keeps the visitor’s own text, bot messages and plain-text messages as they are', () => {
		for (const message of [
			{ author: 'visitor', text: '**hi** [x](https://shop.example.com)', format: 'markdown' },
			{ author: 'system', text: '**hi**', format: 'markdown' },
			{ author: 'staff', text: '**hi**', format: 'text' },
			{ author: 'ai', text: '**hi**' },
			{ author: 'ai', text: '---', format: 'markdown' },
		]) {
			const body = messageBody(document, message);
			expect(body.tagName).toBe('P');
			expect(body.textContent).toBe(message.text);
			expect(body.children).toHaveLength(0);
		}
	});

	it('stays linear on very long input', () => {
		const SIZE = 60_000;
		const inputs = [
			'*a'.repeat(SIZE / 2),
			'**a'.repeat(SIZE / 3),
			'_a'.repeat(SIZE / 2),
			'['.repeat(SIZE),
			'[a]('.repeat(SIZE / 4),
			'`a'.repeat(SIZE / 2),
			`| a |\n${'|---'.repeat(SIZE / 4)}x`,
			`| a |\n|---|\n${'| b | `c` |\n'.repeat(SIZE / 12)}`,
			'- **a**\n'.repeat(SIZE / 8),
			'```\n'.repeat(SIZE / 4),
			`${' '.repeat(SIZE)}-x`,
		];
		const started = performance.now();
		for (const text of inputs) {
			const body = rich(text);
			expect(body.textContent?.length).toBeLessThanOrEqual(text.length);
		}
		// linear work is a few hundred ms here; quadratic work on 60 000 characters would take minutes
		expect(performance.now() - started).toBeLessThan(5_000);
	});
});
