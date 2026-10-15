import { describe, expect, it } from 'vitest';
import { decodeEntities, escapeHtml, luhnValid, pathMatches, widgetScriptTag } from '../src/text.js';

describe('escapeHtml', () => {
	it('escapes the five characters HTML gives a meaning, as decimal references', () => {
		expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&#60;a href=&#34;x&#34;&#62;&#39;&#38;&#39;&#60;/a&#62;');
		expect(escapeHtml('plain text, café ✓')).toBe('plain text, café ✓');
		expect(escapeHtml('&amp;')).toBe('&#38;amp;');
	});

	it('writes null and undefined as nothing, other values as their text', () => {
		expect(escapeHtml(null)).toBe('');
		expect(escapeHtml(undefined)).toBe('');
		expect(escapeHtml(0)).toBe('0');
		expect(escapeHtml(false)).toBe('false');
	});
});

describe('decodeEntities', () => {
	it('decodes decimal, hexadecimal and named references', () => {
		expect(decodeEntities('A &amp; B &lt;i&gt; &quot;x&quot; &apos;y&#39;')).toBe(`A & B <i> "x" 'y'`);
		expect(decodeEntities('&#36;5 &#x20B9;9 &#X20b9; &#0000065;')).toBe('$5 ₹9 ₹ A');
		expect(decodeEntities('caf&eacute; &Eacute;t&eacute; &nbsp;&copy;&yuml;')).toBe('café Été  ©ÿ');
		expect(decodeEntities('It&rsquo;s&hellip; &ndash; &mdash; &euro;9 &trade; &AMP; &frac14;')).toBe('It’s… – — €9 ™ & ¼');
	});

	it('keeps unknown names and references without a semicolon as written', () => {
		expect(decodeEntities('&unknown; &amp &Amp; &#; &#x; & ;')).toBe('&unknown; &amp &Amp; &#; &#x; & ;');
		// names are looked up as names only: nothing an object inherits
		expect(decodeEntities('a&constructor;b&toString;&__proto__;')).toBe('a&constructor;b&toString;&__proto__;');
	});

	it('reads numbers as HTML does: invalid code points become U+FFFD, U+0080–U+009F windows-1252', () => {
		expect(decodeEntities('&#0;|&#xD800;|&#xDFFF;|&#x110000;|&#99999999999999999999;')).toBe('�|�|�|�|�');
		expect(decodeEntities('&#150;&#x80;&#x9F;&#x81;')).toBe('–€Ÿ\u0081');
		expect(decodeEntities('&#x10FFFF;&#x1F600;')).toBe('\u{10FFFF}😀');
	});
});

describe('widgetScriptTag', () => {
	it('builds the tag with the token and async, its attributes escaped', () => {
		expect(widgetScriptTag({ src: 'https://chat.example/widget.js', token: 'tok_1' })).toBe(
			'<script src="https://chat.example/widget.js" data-token="tok_1" async></script>',
		);
		expect(widgetScriptTag({ src: 'https://x.example/w.js?a=1&b="2"', token: '"><script>' })).toBe(
			'<script src="https://x.example/w.js?a=1&#38;b=&#34;2&#34;" data-token="&#34;&#62;&#60;script&#62;" async></script>',
		);
	});

	it('leaves out the token and async when asked', () => {
		expect(widgetScriptTag({ src: '/widget.js' })).toBe('<script src="/widget.js" async></script>');
		expect(widgetScriptTag({ src: '/widget.js', token: null, async: false })).toBe('<script src="/widget.js"></script>');
		expect(widgetScriptTag({ src: '/widget.js', token: 'YOUR_BROWSER_TOKEN', async: false })).toBe(
			'<script src="/widget.js" data-token="YOUR_BROWSER_TOKEN"></script>',
		);
	});
});

describe('pathMatches', () => {
	it('matches exact paths, the home page, and ignores queries, fragments and trailing slashes', () => {
		expect(pathMatches('/', '/')).toBe(true);
		expect(pathMatches('/', '/shop')).toBe(false);
		expect(pathMatches('/shop', '/shop/?a=1#top')).toBe(true);
		expect(pathMatches(' /shop/ ', '/shop')).toBe(true);
		expect(pathMatches('/shop', '/Shop')).toBe(false);
		expect(pathMatches('/shop', '/shop/lamps')).toBe(false);
	});

	it('reads * as any characters in one segment and ** as any number of segments', () => {
		expect(pathMatches('/shop/*', '/shop/lamps?x=1')).toBe(true);
		expect(pathMatches('/shop/*', '/shop/lamps/blue')).toBe(false);
		expect(pathMatches('/shop/*', '/shop')).toBe(false);
		expect(pathMatches('/shop/**', '/shop')).toBe(true);
		expect(pathMatches('/**', '/anything/at/all')).toBe(true);
		expect(pathMatches('/a/**/z', '/a/b/c/z')).toBe(true);
		expect(pathMatches('/a/**/z', '/a/b/c')).toBe(false);
		expect(pathMatches('/a/**', '/b')).toBe(false);
		expect(pathMatches('/sale-*', '/sale-summer')).toBe(true);
		expect(pathMatches('/sale-*', '/sale-')).toBe(true);
		expect(pathMatches('/sale-*', '/sales')).toBe(false);
		expect(pathMatches('/*-off', '/half-off')).toBe(true);
		expect(pathMatches('/*-off', '/off')).toBe(false);
		// every * counts, not only the first two pieces
		expect(pathMatches('/a*b*c', '/axb')).toBe(false);
		expect(pathMatches('/a*b*c', '/axbyc')).toBe(true);
		expect(pathMatches('/a*b*c', '/abc')).toBe(true);
		expect(pathMatches('/a*bc*bc', '/abcbc')).toBe(true);
		expect(pathMatches('/a*bb*b', '/abbb')).toBe(true);
		expect(pathMatches('/a*bb*b', '/abb')).toBe(false);
	});

	it('refuses patterns that are not paths', () => {
		expect(pathMatches('shop', '/shop')).toBe(false);
		expect(pathMatches('checkout/**', '/checkout/pay')).toBe(false);
		expect(pathMatches('', '/')).toBe(false);
	});

	it('compares segments decoded', () => {
		expect(pathMatches('/café', '/caf%C3%A9')).toBe(true);
		expect(pathMatches('/caf%C3%A9/*', '/café/x')).toBe(true);
		// a broken escape is compared as written
		expect(pathMatches('/a%E0%A4%A', '/a%E0%A4%A')).toBe(true);
		expect(pathMatches('/a%E0%A4%A', '/a')).toBe(false);
	});

	it('stays fast with many ** against a long path', () => {
		const pattern = `/${Array.from({ length: 40 }, () => '**').join('/')}/x`;
		const path = `/${Array.from({ length: 200 }, () => 'a').join('/')}`;
		expect(pathMatches(pattern, path)).toBe(false);
		expect(pathMatches(pattern, `${path}/x`)).toBe(true);
	});
});

describe('luhnValid', () => {
	it('accepts numbers whose last digit is their Luhn check digit', () => {
		expect(luhnValid('4111111111111111')).toBe(true);
		expect(luhnValid('79927398713')).toBe(true);
		expect(luhnValid('490154203237518')).toBe(true);
		expect(luhnValid('00')).toBe(true);
		expect(luhnValid('18')).toBe(true);
	});

	it('refuses wrong check digits, short values and anything but ASCII digits', () => {
		expect(luhnValid('4111111111111112')).toBe(false);
		expect(luhnValid('79927398710')).toBe(false);
		expect(luhnValid('0')).toBe(false);
		expect(luhnValid('')).toBe(false);
		expect(luhnValid('4111 1111 1111 1111')).toBe(false);
		expect(luhnValid('٤١١١١١١١١١١١١١١١')).toBe(false);
		expect(luhnValid(4111111111111111)).toBe(false);
		expect(luhnValid(null)).toBe(false);
	});
});
