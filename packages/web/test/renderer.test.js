// @vitest-environment jsdom
/* global document, Node, KeyboardEvent */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	button,
	createH,
	focusFirst,
	focusables,
	h,
	liveRegion,
	prefersReducedMotion,
	reserveSpace,
	safeCssValue,
	safeUrl,
	saveFocus,
	slot,
	tokens,
	trapFocus,
	uniqueId,
} from '../src/renderer.js';

const XSS = '<img src=x onerror="globalThis.__pwned=1"><script>globalThis.__pwned=1</script>';

afterEach(() => {
	document.body.replaceChildren();
	delete (/** @type {any} */ (globalThis).__pwned);
});

describe('h() safety', () => {
	it('renders untrusted text as text nodes only', () => {
		const el = h(
			'div',
			null,
			XSS,
			42,
			null,
			undefined,
			false,
			true,
			[XSS, ['nested']],
			/** @type {any} */ ({ toString: () => 'obj' }),
			/** @type {any} */ (() => 'fn'),
		);
		document.body.append(el);
		expect(el.querySelector('img, script')).toBeNull();
		expect(el.childNodes.length).toBe(4);
		expect([...el.childNodes].every((node) => node.nodeType === Node.TEXT_NODE)).toBe(true);
		expect(el.textContent).toBe(`${XSS}42${XSS}nested`);
		expect(/** @type {any} */ (globalThis).__pwned).toBeUndefined();
	});

	it('refuses dangerous tags', () => {
		for (const tag of [
			'script',
			'iframe',
			'object',
			'embed',
			'style',
			'link',
			'meta',
			'base',
			'template',
			'form',
			'foreignObject',
			'IMG',
		])
			expect(() => h(tag)).toThrow(/not allowed/);
	});

	it('drops event-handler attributes, unknown attributes and HTML sinks', () => {
		const el = h('div', {
			onclick: 'globalThis.__pwned=1',
			onClick: 'globalThis.__pwned=1',
			onmouseover: 'x',
			innerHTML: XSS,
			outerHTML: XSS,
			srcdoc: XSS,
			formaction: 'javascript:alert(1)',
			style: 'background:url(javascript:alert(1))',
			'data-Bad Name': 'x',
			'xlink:href': 'javascript:alert(1)',
			ref: 'not a function',
			hidden: 'no',
			title: { toString: () => 'x' },
		});
		expect(el.getAttributeNames()).toEqual([]);
		expect(el.innerHTML).toBe('');
		el.click();
		expect(/** @type {any} */ (globalThis).__pwned).toBeUndefined();
	});

	it('writes allowlisted, aria-* and data-* attributes as inert text', () => {
		const onClick = vi.fn();
		/** @type {HTMLElement | undefined} */
		let captured;
		const el = h('button', {
			className: 'btn primary',
			id: 'b1',
			type: 'submit',
			'aria-label': '"><script>x</script>',
			'data-sku': '" onmouseover="x',
			tabindex: 0,
			disabled: true,
			hidden: false,
			onClick,
			ref: (/** @type {HTMLElement} */ node) => (captured = node),
		});
		expect(el.getAttribute('class')).toBe('btn primary');
		expect(el.getAttribute('aria-label')).toBe('"><script>x</script>');
		expect(el.getAttribute('data-sku')).toBe('" onmouseover="x');
		expect(el.getAttribute('tabindex')).toBe('0');
		expect(el.hasAttribute('disabled')).toBe(true);
		expect(el.hasAttribute('hidden')).toBe(false);
		expect(el.hasAttribute('onmouseover')).toBe(false);
		expect(captured).toBe(el);
		el.removeAttribute('disabled');
		el.click();
		expect(onClick).toHaveBeenCalledTimes(1);
		const label = h('label', { htmlFor: 'b1' }, 'Code');
		expect(label.getAttribute('for')).toBe('b1');
	});

	it.each([
		['javascript:alert(1)'],
		['JaVaScRiPt:alert(1)'],
		[' javascript:alert(1)'],
		['java\tscript:alert(1)'],
		['java\nscript:alert(1)'],
		['\u0001javascript:alert(1)'],
		['vbscript:msgbox(1)'],
		['data:text/html,<script>alert(1)</script>'],
		['//evil.example.com/x'],
		['/\\evil.example.com'],
		['file:///etc/passwd'],
	])('drops unsafe href %j', (href) => {
		expect(h('a', { href }).hasAttribute('href')).toBe(false);
	});

	it('keeps safe URLs and hardens target=_blank', () => {
		for (const href of [
			'https://shop.example.com/p',
			'http://x.test',
			'/relative',
			'page?x=1',
			'#top',
			'mailto:a@b.co',
			'tel:+923001234567',
		])
			expect(h('a', { href }).getAttribute('href')).toBe(href);
		const blank = h('a', { href: 'https://x.test', target: '_blank', rel: 'opener' });
		expect(blank.getAttribute('rel')).toBe('noopener noreferrer');
		expect(h('img', { src: 'mailto:a@b.co' }).hasAttribute('src')).toBe(false);
		expect(h('img', { src: 'data:image/svg+xml,<svg onload=alert(1)>' }).hasAttribute('src')).toBe(false);
		expect(h('img', { src: 'https://cdn.example.com/a.png', alt: 'A' }).getAttribute('src')).toBe(
			'https://cdn.example.com/a.png',
		);
		expect(safeUrl('href', 'x'.repeat(3000))).toBeUndefined();
		expect(safeUrl('href', 5)).toBeUndefined();
	});

	it('applies style objects through setProperty, refusing unsafe values', () => {
		const el = h('div', {
			style: {
				color: 'var(--ss-color-text)',
				marginTop: 4,
				'--ss-gap': '8px',
				background: 'url(javascript:alert(1))',
				width: '1px; position: fixed',
				behavior: 'expression(alert(1))',
				'Bad Prop': 'red',
				height: '',
			},
		});
		expect(el.style.getPropertyValue('color')).toBe('var(--ss-color-text)');
		expect(el.style.getPropertyValue('--ss-gap')).toBe('8px');
		expect(el.style.getPropertyValue('background')).toBe('');
		expect(el.style.getPropertyValue('width')).toBe('');
		expect(el.getAttribute('style') ?? '').not.toMatch(/javascript|expression|fixed/);
	});

	it('sets form values as properties and supports svg icons', () => {
		const input = /** @type {HTMLInputElement} */ (h('input', { value: 'A&B', checked: true, type: 'checkbox', maxlength: 5 }));
		expect(input.value).toBe('A&B');
		expect(input.checked).toBe(true);
		const icon = h(
			'svg',
			{ viewBox: '0 0 24 24', 'aria-hidden': 'true', onload: 'x' },
			h('path', { d: 'M0 0h24v24H0z', fill: 'currentColor' }),
		);
		expect(icon.namespaceURI).toBe('http://www.w3.org/2000/svg');
		expect(icon.getAttribute('viewBox')).toBe('0 0 24 24');
		expect(icon.hasAttribute('onload')).toBe(false);
		expect(icon.firstElementChild?.getAttribute('d')).toBe('M0 0h24v24H0z');
	});

	it('binds to a given document', () => {
		const other = document.implementation.createHTMLDocument('x');
		expect(createH(other)('p', null, 'hi').ownerDocument).toBe(other);
	});
});

describe('tokens', () => {
	it('maps nested tokens to CSS variables', () => {
		const vars = tokens.toVars({
			color: { primary: '#0a5', onPrimary: '#fff' },
			radius: { md: 8 },
			font: { body: 'Inter, sans-serif' },
		});
		expect(vars).toEqual({
			'--ss-color-primary': '#0a5',
			'--ss-color-on-primary': '#fff',
			'--ss-radius-md': '8',
			'--ss-font-body': 'Inter, sans-serif',
		});
		expect(tokens.toVars({ a: 'b' }, { prefix: '--x' })).toEqual({ '--x-a': 'b' });
	});

	it('refuses injection in values and names', () => {
		const vars = tokens.toVars({
			color: {
				bad: 'red; } body { display: none',
				img: 'url(https://evil.test/x)',
				esc: '\\72 ed',
				tag: '</style><script>',
				imp: '@import x',
			},
			'<script>': 'x',
			'': 'x',
			deep: { a: { b: { c: { d: { e: { f: { g: 'too deep' } } } } } } },
			list: ['red'],
			nil: null,
			fn: () => 'x',
		});
		expect(vars).toEqual({ '--ss-script': 'x' });
		expect(safeCssValue(Number.NaN)).toBeUndefined();
		expect(safeCssValue('   ')).toBeUndefined();
	});

	it('applies to an element', () => {
		const el = document.createElement('div');
		expect(tokens.apply(el, { color: { primary: '#123456' } })).toEqual(['--ss-color-primary']);
		expect(el.style.getPropertyValue('--ss-color-primary')).toBe('#123456');
		expect(tokens.apply(el, null)).toEqual([]);
	});
});

describe('slot', () => {
	it('resolves merchant content with fallbacks', () => {
		document.body.innerHTML = '<template id="promo"><strong>Merchant HTML</strong></template><div id="plain">x</div>';
		const node = h('em', null, 'node');
		expect(slot('a', { a: 'text <b>' }, 'fb')?.textContent).toBe('text <b>');
		const cloned = slot('a', { a: node });
		expect(cloned).not.toBe(node);
		expect(/** @type {Element} */ (cloned).outerHTML).toBe('<em>node</em>');
		const fragment = slot('a', { a: { template: '#promo' } });
		expect(/** @type {DocumentFragment} */ (fragment).firstElementChild?.tagName).toBe('STRONG');
		expect(slot('a', { a: { template: '#plain' } }, 'fb')?.textContent).toBe('fb');
		expect(slot('a', { a: { template: '###' } }, 'fb')?.textContent).toBe('fb');
		expect(slot('a', { a: () => 'from fn' })?.textContent).toBe('from fn');
		expect(slot('a', { a: (/** @type {any} */ ctx) => ctx.name }, undefined, { context: { name: 'ctx' } })?.textContent).toBe(
			'ctx',
		);
		expect(
			slot(
				'a',
				{
					a: () => {
						throw new Error('merchant bug');
					},
				},
				'fb',
			)?.textContent,
		).toBe('fb');
		expect(slot('a', { a: /** @type {any} */ (() => () => 'x') }, 'fb')?.textContent).toBe('fb');
		expect(slot('a', { a: /** @type {any} */ (42) }, 'fb')?.textContent).toBe('fb');
		expect(slot('missing', undefined)).toBeNull();
		expect(slot('missing', {}, () => null)).toBeNull();
	});
});

describe('layout, motion and focus', () => {
	it('reserves and releases space', () => {
		const el = document.createElement('div');
		const release = reserveSpace(el, { minHeight: 120, minWidth: '10rem', aspectRatio: '16 / 9' });
		expect(el.style.getPropertyValue('min-height')).toBe('120px');
		expect(el.style.getPropertyValue('min-width')).toBe('10rem');
		release();
		expect(el.style.getPropertyValue('min-height')).toBe('');
		reserveSpace(el, { minHeight: -5, minWidth: 'url(x)' });
		expect(el.getAttribute('style') ?? '').toBe('');
		reserveSpace(el)();
	});

	it('detects reduced motion safely', () => {
		expect(prefersReducedMotion({ matchMedia: () => ({ matches: true }) })).toBe(true);
		expect(prefersReducedMotion({})).toBe(false);
		expect(
			prefersReducedMotion({
				matchMedia: () => {
					throw new Error('x');
				},
			}),
		).toBe(false);
		expect(prefersReducedMotion(undefined)).toBe(false);
	});

	it('finds focusables, focuses first and restores focus', () => {
		const outside = h('button', null, 'outside');
		const dialog = h(
			'div',
			{ tabindex: -1 },
			h('button', { disabled: true }, 'off'),
			h('a', { href: '#x' }, 'link'),
			h('input', { type: 'hidden' }),
			h('input', { type: 'text' }),
			h('button', { hidden: true }, 'hidden'),
			h('div', { tabindex: 0, 'aria-hidden': 'true' }),
			h('button', null, 'last'),
		);
		document.body.append(outside, dialog);
		expect(focusables(dialog).map((el) => el.tagName)).toEqual(['A', 'INPUT', 'BUTTON']);
		outside.focus();
		const restore = saveFocus();
		expect(focusFirst(dialog)).toBe(true);
		expect(document.activeElement?.tagName).toBe('A');
		restore();
		expect(document.activeElement).toBe(outside);
		const empty = h('div', { tabindex: -1 });
		document.body.append(empty);
		expect(focusFirst(empty)).toBe(true);
		expect(focusFirst(h('div'))).toBe(false);
	});

	it('traps Tab inside a dialog and handles Escape', () => {
		const opener = h('button', null, 'open');
		const first = h('button', null, 'first');
		const last = h('button', null, 'last');
		const dialog = h('div', { role: 'dialog' }, first, last);
		document.body.append(opener, dialog);
		opener.focus();
		const onEscape = vi.fn();
		const release = trapFocus(dialog, { onEscape });
		expect(document.activeElement).toBe(first);
		/** @param {string} key @param {boolean} [shiftKey] */
		const press = (key, shiftKey = false) => {
			const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
			/** @type {HTMLElement} */ (document.activeElement).dispatchEvent(event);
			return event;
		};
		expect(press('Tab', true).defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(last);
		expect(press('Tab').defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(first);
		expect(press('Tab').defaultPrevented).toBe(false);
		expect(press('a').defaultPrevented).toBe(false);
		press('Escape');
		expect(onEscape).toHaveBeenCalledTimes(1);
		release();
		expect(document.activeElement).toBe(opener);

		const bare = h('div', { tabindex: -1 });
		document.body.append(bare);
		const releaseBare = trapFocus(bare, { initialFocus: false });
		const event = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
		bare.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		releaseBare();
	});
});

describe('a11y utilities', () => {
	it('builds labelled buttons', () => {
		const text = button({ label: 'Apply', onClick: vi.fn() });
		expect(text.textContent).toBe('Apply');
		expect(text.type).toBe('button');
		expect(text.hasAttribute('aria-label')).toBe(false);
		const icon = button({ label: 'Close', icon: h('svg', { 'aria-hidden': 'true' }), className: 'x' });
		expect(icon.getAttribute('aria-label')).toBe('Close');
		expect(icon.getAttribute('class')).toBe('x');
		expect(icon.textContent).toBe('');
		expect(() => button({ label: ' ' })).toThrow(/label/);
	});

	it('announces through a live region, including repeats', () => {
		vi.useFakeTimers();
		const region = liveRegion(document.body);
		expect(region.node.getAttribute('role')).toBe('status');
		expect(region.node.getAttribute('aria-live')).toBe('polite');
		region.announce('<b>Saved</b>');
		expect(region.node.textContent).toBe('');
		vi.advanceTimersByTime(50);
		expect(region.node.textContent).toBe('<b>Saved</b>');
		expect(region.node.children.length).toBe(0);
		region.announce('<b>Saved</b>');
		expect(region.node.textContent).toBe('');
		vi.advanceTimersByTime(50);
		expect(region.node.textContent).toBe('<b>Saved</b>');
		region.destroy();
		expect(region.node.isConnected).toBe(false);
		expect(liveRegion(document.body, { politeness: 'assertive' }).node.getAttribute('role')).toBe('alert');
		vi.useRealTimers();
	});

	it('generates unique ids', () => {
		expect(uniqueId()).not.toBe(uniqueId());
		expect(uniqueId('lbl')).toMatch(/^lbl-/);
	});
});
