// @vitest-environment jsdom
/* global document, window */
import { describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_FORMAT,
	formatDate,
	formatMoney,
	formatText,
	fromDecimal,
	isCurrency,
	mountWidget,
	themeCss,
	toCsv,
	toDecimal,
	viewerOf,
} from '../src/widget.js';

describe('widget texts', () => {
	it('fills placeholders as plain text', () => {
		expect(formatText('Hi {name}, {count} new {missing}', { name: '<b>Sam</b>', count: 3 })).toBe(
			'Hi <b>Sam</b>, 3 new {missing}',
		);
		expect(formatText('Plain')).toBe('Plain');
	});
});

describe('money and CSV for inputs and downloads', () => {
	it('turns minor units into the decimal text of an input and back, in the currency’s own digits', () => {
		expect(toDecimal(1050, 'USD')).toBe('10.50');
		expect(toDecimal(1050, 'JPY')).toBe('1050');
		expect(fromDecimal('10.5', 'USD')).toBe(1050);
		expect(fromDecimal('10.555', 'USD')).toBeNull();
		expect(isCurrency('USD')).toBe(true);
		expect(isCurrency('usd')).toBe(false);
	});

	it('writes a CSV file whose text never runs as a formula in a spreadsheet', () => {
		expect(toCsv(['name', 'note'], [['=SUM(A1)', 'a, "b"']])).toBe('﻿name,note\r\n\'=SUM(A1),"a, ""b"""\r\n');
	});
});

describe('mountWidget', () => {
	it('renders into an open shadow root with the theme, product CSS and custom CSS only there', () => {
		const host = document.createElement('div');
		document.body.append(host);
		const cleanup = vi.fn();
		const widget = mountWidget({
			host,
			theme: {
				colors: { accent: '#ff0000', bad: 'red', 'Bad-Name': '#000000' },
				fontFamily: 'Inter',
				radius: 6,
				mode: 'dark',
			},
			css: '.note { color: var(--ss-color-accent); }',
			customCss: '.note { font-weight: bold; }',
			render: (root) => {
				const note = root.ownerDocument.createElement('p');
				note.className = 'note';
				note.textContent = formatText('Hello {name}', { name: 'Sam' });
				root.append(note);
				return cleanup;
			},
		});
		expect(host.shadowRoot).toBe(widget.shadow);
		expect(widget.shadow.mode).toBe('open');
		const styles = [...widget.shadow.querySelectorAll('style')].map((style) => style.textContent);
		expect(styles[0]).toBe(':host { --ss-color-accent: #ff0000; --ss-font-family: "Inter", inherit; --ss-radius: 6px; }');
		expect(styles[1]).toContain('var(--ss-color-accent)');
		expect(styles[2]).toBe('.note { font-weight: bold; }');
		expect(document.head.querySelectorAll('style')).toHaveLength(0);
		expect(widget.root.querySelector('.note')?.textContent).toBe('Hello Sam');
		expect(host.getAttribute('data-ss-mode')).toBe('dark');
		widget.update({ theme: { mode: 'light', fontFamily: 'inherit' }, customCss: '' });
		expect(host.getAttribute('data-ss-mode')).toBe('light');
		expect(widget.shadow.querySelectorAll('style')[2]?.textContent).toBe('');
		widget.update({});
		widget.unmount();
		expect(cleanup).toHaveBeenCalledOnce();
		expect(widget.shadow.childNodes).toHaveLength(0);
		expect(host.hasAttribute('data-ss-mode')).toBe(false);
	});

	it('follows the device in auto mode and reuses an existing shadow root', () => {
		/** @type {Array<() => void>} */
		const listeners = [];
		const media = {
			matches: true,
			addEventListener: (/** @type {string} */ _type, /** @type {() => void} */ fn) => listeners.push(fn),
			removeEventListener: vi.fn(),
		};
		const original = window.matchMedia;
		window.matchMedia = /** @type {any} */ (() => media);
		const host = document.createElement('div');
		host.attachShadow({ mode: 'open' }).append(document.createElement('span'));
		const widget = mountWidget({ host, render: () => {} });
		expect(widget.shadow.querySelector('span')).toBeNull();
		expect(host.getAttribute('data-ss-mode')).toBe('dark');
		media.matches = false;
		for (const listener of listeners) listener();
		expect(host.getAttribute('data-ss-mode')).toBe('light');
		widget.unmount();
		expect(media.removeEventListener).toHaveBeenCalled();
		window.matchMedia = original;
	});

	it('leaves out theme values that do not fit', () => {
		expect(themeCss({ fontFamily: 'x;} body{', radius: 99 })).toBe(':host {  }');
		expect(themeCss()).toBe(':host { --ss-font-family: inherit; }');
	});
});

describe('formatting in widgets (K7)', () => {
	it('uses the viewer’s language and time zone unless the Format says otherwise', () => {
		const viewer = viewerOf(/** @type {any} */ ({ navigator: { language: 'en-GB' } }));
		expect(viewer.locale).toBe('en-GB');
		expect(typeof viewer.timeZone).toBe('string');
		expect(viewerOf(undefined)).not.toHaveProperty('locale');
		expect(viewerOf(/** @type {any} */ ({ navigator: { language: '' } }))).not.toHaveProperty('locale');
		expect(formatMoney(1_250_000, 'GBP', DEFAULT_FORMAT, viewer)).toBe('GBP 12,500.00');
		expect(formatDate('2026-03-12T19:30:00Z', { times: 'business' }, { timeZone: 'Asia/Tokyo', viewer, style: 'date' })).toBe(
			'13 Mar 2026',
		);
		const zone = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(() => {
			throw new Error('no zones');
		});
		expect(viewerOf(window)).not.toHaveProperty('timeZone');
		zone.mockRestore();
	});
});
